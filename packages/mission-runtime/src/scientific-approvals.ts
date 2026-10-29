/** Internal domain repository; callers use the public store facade. */
import {
  ApprovalRequestSchema,
  ApprovalResponseSchema,
  ExternalOperationSchema,
  ScientificMissionSchema,
  ScientificPlanSchema,
  assertBiomolecularDecisionDigest,
  canonicalJson,
  digestCanonical,
  type ApprovalRequest,
  type ApprovalResponse,
} from "@eigengrid/scientific-schema";
import {
  ScientificApprovalExpiredError,
  ScientificApprovalIncompatibleStateError,
  ScientificApprovalMissingDecisionError,
  ScientificApprovalModifiedError,
  ScientificApprovalPolicyMismatchError,
  ScientificApprovalStaleError,
  ScientificApprovalUnauthorizedError,
  ScientificEntityConflictError,
  ScientificEntityNotFoundError,
  ScientificIntegrityError,
} from "./errors";
import { resolveMdSubjectSnapshot, transitionReviewedMdSubject } from "./md-projection-store";
import { ScientificStoreContext } from "./scientific-store-context";
import {
  APPROVAL_VALIDATION_COMPATIBLE_MISSION_STATES,
  JsonRow,
  assertEmbeddedDigest,
  computePlanDigest,
  computeSkillGraphDigest,
  exactPlanApprovalRole,
  parsePayload,
  unique,
} from "./scientific-store-validation";
import type {
  ExactApprovalContext,
  ExactApprovalDecisionContext,
  ScientificTransaction,
  SubjectDecisionRequirement,
  SubjectSnapshot,
} from "./types";
export class ScientificApprovals {
  constructor(private readonly context: ScientificStoreContext) {}

  // ── Exact-revision approvals ─────────────────────────────

  async createApprovalRequest(requestInput: ApprovalRequest): Promise<ApprovalRequest> {
    const request = ApprovalRequestSchema.parse(requestInput);
    if (request.state !== "pending" || request.response) {
      throw new ScientificIntegrityError(
        "A new approval request must be pending without a response",
      );
    }
    return this.context.inTransaction("create approval request", async (tx) => {
      const missionRow = await this.context.requiredRow<JsonRow>(
        tx,
        "mission",
        request.missionId,
        "scientific_missions",
      );
      const mission = parsePayload(
        ScientificMissionSchema,
        missionRow,
        `mission ${request.missionId}`,
      );
      if (mission.state !== "awaiting_approval") {
        throw new ScientificApprovalIncompatibleStateError(
          request.id,
          mission.state,
          request.state,
        );
      }
      const subject = await this.subjectSnapshot(tx, request.subjectType, request.subjectId);
      this.assertRequestMatchesSubject(request, subject);
      await this.assertPlanApprovalContract(tx, request);
      await this.context.insertIdempotent(tx, {
        entity: "approval request",
        table: "scientific_approval_requests",
        id: request.id,
        payload: canonicalJson(request),
        columns: [
          "id",
          "mission_id",
          "subject_type",
          "subject_id",
          "subject_version",
          "subject_revision",
          "state",
          "requested_from_role",
          "payload_digest",
          "policy_digest",
          "payload_json",
          "requested_at",
          "expires_at",
        ],
        values: [
          request.id,
          request.missionId,
          request.subjectType,
          request.subjectId,
          request.subjectVersion,
          request.subjectRevision,
          request.state,
          request.requestedFromRole,
          request.payloadDigest,
          request.policyDigest,
          canonicalJson(request),
          request.requestedAt,
          request.expiresAt ?? null,
        ],
      });
      return request;
    });
  }

  async respondToApproval(
    requestId: string,
    responseInput: ApprovalResponse,
    context: ExactApprovalDecisionContext,
  ): Promise<ApprovalRequest> {
    const response = ApprovalResponseSchema.parse(responseInput);
    if (response.approvalRequestId !== requestId) {
      throw new ScientificIntegrityError("Approval response targets a different request");
    }

    const outcome = await this.context.inTransaction("respond to approval", async (tx) => {
      const preliminaryRow = await this.context.requiredRow<JsonRow>(
        tx,
        "approval request",
        requestId,
        "scientific_approval_requests",
      );
      const preliminary = parsePayload(
        ApprovalRequestSchema,
        preliminaryRow,
        `approval request ${requestId}`,
      );
      // PostgreSQL lock order is mission -> plan/subject -> approval. Effect start
      // uses operation -> work unit -> mission -> plan -> approval, so every
      // transaction that overlaps the approval authority acquires common rows
      // in the same order and cannot form an approval/mission deadlock cycle.
      const missionRow = await this.context.requiredRow<JsonRow>(
        tx,
        "mission",
        preliminary.missionId,
        "scientific_missions",
        true,
      );
      const mission = parsePayload(
        ScientificMissionSchema,
        missionRow,
        `mission ${preliminary.missionId}`,
      );
      const subject = await this.subjectSnapshot(
        tx,
        preliminary.subjectType,
        preliminary.subjectId,
        true,
      );
      const requestRow = await this.context.requiredRow<JsonRow>(
        tx,
        "approval request",
        requestId,
        "scientific_approval_requests",
        true,
      );
      const request = parsePayload(
        ApprovalRequestSchema,
        requestRow,
        `approval request ${requestId}`,
      );
      if (
        request.missionId !== preliminary.missionId ||
        request.subjectType !== preliminary.subjectType ||
        request.subjectId !== preliminary.subjectId ||
        request.subjectVersion !== preliminary.subjectVersion ||
        request.subjectRevision !== preliminary.subjectRevision ||
        request.payloadDigest !== preliminary.payloadDigest ||
        request.policyDigest !== preliminary.policyDigest ||
        request.requestedFromRole !== preliminary.requestedFromRole
      ) {
        throw new ScientificEntityConflictError(
          "approval request",
          request.id,
          "authority changed while acquiring transaction locks",
        );
      }
      if (request.response) {
        if (canonicalJson(request.response) === canonicalJson(response)) {
          return { request, expiredAt: null as string | null };
        }
        throw new ScientificEntityConflictError(
          "approval response",
          response.id,
          "request already decided",
        );
      }
      if (request.state !== "pending") {
        throw new ScientificApprovalIncompatibleStateError(
          request.id,
          "awaiting_approval",
          request.state,
        );
      }
      if (request.expiresAt && Date.parse(request.expiresAt) <= Date.parse(context.now)) {
        const expired = ApprovalRequestSchema.parse({ ...request, state: "expired" });
        await tx.query(
          `UPDATE scientific_approval_requests SET state = 'expired', payload_json = $1
           WHERE id = $2 AND state = 'pending'`,
          [canonicalJson(expired), request.id],
        );
        return { request: expired, expiredAt: request.expiresAt };
      }

      if (mission.state !== "awaiting_approval") {
        throw new ScientificApprovalIncompatibleStateError(
          request.id,
          mission.state,
          request.state,
        );
      }
      if (
        canonicalJson(response.actor) !== canonicalJson(context.authenticatedActor) ||
        !context.authorizedRoles.includes(request.requestedFromRole) ||
        response.actor.kind !== "human" ||
        response.role !== request.requestedFromRole ||
        response.actor.role !== request.requestedFromRole
      ) {
        throw new ScientificApprovalUnauthorizedError(
          request.id,
          request.requestedFromRole,
          response.role,
          response.actor.kind,
        );
      }
      if (context.currentPolicyDigest !== request.policyDigest) {
        throw new ScientificApprovalPolicyMismatchError(
          request.id,
          request.policyDigest,
          context.currentPolicyDigest,
        );
      }
      if (response.policyDigest !== request.policyDigest) {
        throw new ScientificApprovalPolicyMismatchError(
          request.id,
          request.policyDigest,
          response.policyDigest,
        );
      }
      if (response.subjectVersion !== request.subjectVersion) {
        throw new ScientificApprovalStaleError(
          request.id,
          request.subjectVersion,
          response.subjectVersion,
          "version",
        );
      }
      if (response.subjectRevision !== request.subjectRevision) {
        throw new ScientificApprovalStaleError(
          request.id,
          request.subjectRevision,
          response.subjectRevision,
        );
      }
      if (response.payloadDigest !== request.payloadDigest) {
        throw new ScientificApprovalModifiedError(
          request.id,
          request.payloadDigest,
          response.payloadDigest,
        );
      }
      this.assertRequestMatchesSubject(request, subject);
      await this.assertPlanApprovalContract(tx, request);
      await this.assertRequiredDecisions(tx, request, subject);

      await tx.query(
        `INSERT INTO scientific_approval_responses
           (id, approval_request_id, decision, actor_id, role, subject_version, subject_revision,
            payload_digest, policy_digest, payload_json, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          response.id,
          response.approvalRequestId,
          response.decision,
          response.actor.id,
          response.role,
          response.subjectVersion,
          response.subjectRevision,
          response.payloadDigest,
          response.policyDigest,
          canonicalJson(response),
          response.decidedAt,
        ],
      );
      const state = response.decision === "approved" ? "approved" : "rejected";
      const decided = ApprovalRequestSchema.parse({ ...request, state, response });
      const changed = await tx.queryRows<{ id: string }>(
        `UPDATE scientific_approval_requests SET state = $1, payload_json = $2
         WHERE id = $3 AND state = 'pending' RETURNING id`,
        [state, canonicalJson(decided), request.id],
      );
      if (changed.length === 0) {
        throw new ScientificEntityConflictError(
          "approval request",
          request.id,
          "decided concurrently",
        );
      }

      await transitionReviewedMdSubject(tx, this.context.database._provider, request, response);

      if (request.subjectType === "plan") {
        const targetStatus = response.decision === "approved" ? "approved" : "rejected";
        const planRow = await this.context.requiredRow<JsonRow>(
          tx,
          "plan",
          request.subjectId,
          "scientific_plans",
          true,
        );
        const plan = parsePayload(ScientificPlanSchema, planRow, `plan ${request.subjectId}`);
        if (plan.status !== "under_review") {
          throw new ScientificApprovalIncompatibleStateError(
            request.id,
            mission.state,
            plan.status,
          );
        }
        const transitioned = ScientificPlanSchema.parse({
          ...plan,
          status: targetStatus,
          updatedAt: response.decidedAt,
        });
        const changedPlan = await tx.queryRows<{ id: string }>(
          `UPDATE scientific_plans SET status = $1, payload_json = $2, updated_at = $3
           WHERE id = $4 AND revision = $5 AND status = 'under_review' RETURNING id`,
          [
            targetStatus,
            canonicalJson(transitioned),
            transitioned.updatedAt,
            plan.id,
            plan.revision,
          ],
        );
        if (changedPlan.length === 0) {
          throw new ScientificEntityConflictError(
            "scientific plan",
            plan.id,
            "approval lost a concurrent plan transition",
          );
        }
      }
      return { request: decided, expiredAt: null as string | null };
    });
    if (outcome.expiredAt) {
      throw new ScientificApprovalExpiredError(requestId, outcome.expiredAt);
    }
    return outcome.request;
  }

  async assertApprovalValid(
    requestId: string,
    context: ExactApprovalContext,
  ): Promise<ApprovalRequest> {
    return this.context.inTransaction("validate exact approval", async (tx) => {
      const requestRow = await this.context.requiredRow<JsonRow>(
        tx,
        "approval request",
        requestId,
        "scientific_approval_requests",
      );
      const request = parsePayload(
        ApprovalRequestSchema,
        requestRow,
        `approval request ${requestId}`,
      );
      if (
        request.state !== "approved" ||
        !request.response ||
        request.response.decision !== "approved"
      ) {
        throw new ScientificApprovalIncompatibleStateError(request.id, "execution", request.state);
      }
      if (request.expiresAt && Date.parse(request.expiresAt) <= Date.parse(context.now)) {
        throw new ScientificApprovalExpiredError(request.id, request.expiresAt);
      }
      if (context.currentPolicyDigest !== request.policyDigest) {
        throw new ScientificApprovalPolicyMismatchError(
          request.id,
          request.policyDigest,
          context.currentPolicyDigest,
        );
      }
      if (
        request.response.actor.kind !== "human" ||
        request.response.actor.role !== request.requestedFromRole ||
        request.response.role !== request.requestedFromRole
      ) {
        throw new ScientificApprovalUnauthorizedError(
          request.id,
          request.requestedFromRole,
          request.response.role,
          request.response.actor.kind,
        );
      }
      const missionRow = await this.context.requiredRow<JsonRow>(
        tx,
        "mission",
        request.missionId,
        "scientific_missions",
      );
      const mission = parsePayload(
        ScientificMissionSchema,
        missionRow,
        `mission ${request.missionId}`,
      );
      if (!APPROVAL_VALIDATION_COMPATIBLE_MISSION_STATES.has(mission.state)) {
        throw new ScientificApprovalIncompatibleStateError(
          request.id,
          mission.state,
          request.state,
        );
      }
      const subject = await this.subjectSnapshot(tx, request.subjectType, request.subjectId);
      this.assertRequestMatchesSubject(request, subject);
      await this.assertPlanApprovalContract(tx, request);
      await this.assertRequiredDecisions(tx, request, subject);
      return request;
    });
  }

  private assertRequestMatchesSubject(request: ApprovalRequest, subject: SubjectSnapshot): void {
    if (request.missionId !== subject.missionId) {
      throw new ScientificIntegrityError("Approval subject belongs to another mission", {
        requestId: request.id,
      });
    }
    if (request.subjectVersion !== subject.version) {
      throw new ScientificApprovalStaleError(
        request.id,
        request.subjectVersion,
        subject.version,
        "version",
      );
    }
    if (request.subjectRevision !== subject.revision) {
      throw new ScientificApprovalStaleError(request.id, request.subjectRevision, subject.revision);
    }
    if (request.payloadDigest !== subject.digest) {
      throw new ScientificApprovalModifiedError(request.id, request.payloadDigest, subject.digest);
    }
  }

  private async assertRequiredDecisions(
    tx: ScientificTransaction,
    request: ApprovalRequest,
    subject: SubjectSnapshot,
  ): Promise<void> {
    if (subject.requiredDecisionIds.length === 0) return;
    if (request.subjectType === "decision") {
      const legacy = await this.context.one<{ id: string }>(
        tx,
        "SELECT id FROM scientific_decisions WHERE id = $1 AND mission_id = $2",
        [request.subjectId, request.missionId],
      );
      const biomolecular = await this.context.one<{ id: string }>(
        tx,
        "SELECT id FROM scientific_biomolecular_decisions WHERE id = $1 AND mission_id = $2",
        [request.subjectId, request.missionId],
      );
      if (!legacy && !biomolecular) {
        throw new ScientificApprovalMissingDecisionError(request.id, [request.subjectId]);
      }
      return;
    }
    const requirements: SubjectDecisionRequirement[] =
      subject.requiredDecisions ?? subject.requiredDecisionIds.map((id) => ({ id }));
    const missing: string[] = [];
    for (const requirement of requirements) {
      if (requirement.revision !== undefined) {
        const row = await this.context.one<{
          decision_digest: string;
          approval_ref: string | null;
          review_status: string;
        }>(
          tx,
          `SELECT decision_digest, approval_ref, review_status
           FROM scientific_biomolecular_decisions
           WHERE id = $1 AND revision = $2 AND mission_id = $3`,
          [requirement.id, requirement.revision, request.missionId],
        );
        if (
          !row ||
          String(row.review_status) !== "approved" ||
          String(row.decision_digest) !== requirement.digest ||
          String(row.approval_ref) !== requirement.approvalRef
        ) {
          missing.push(requirement.id);
        }
        continue;
      }
      const legacy = await this.context.one<{ id: string }>(
        tx,
        subject.decisionPlanId
          ? `SELECT id FROM scientific_decisions
             WHERE id = $1 AND mission_id = $2 AND plan_id = $3`
          : "SELECT id FROM scientific_decisions WHERE id = $1 AND mission_id = $2",
        subject.decisionPlanId
          ? [requirement.id, request.missionId, subject.decisionPlanId]
          : [requirement.id, request.missionId],
      );
      const biomolecular = await this.context.one<{ id: string }>(
        tx,
        `SELECT id FROM scientific_biomolecular_decisions
         WHERE id = $1 AND mission_id = $2 AND review_status = 'approved'`,
        [requirement.id, request.missionId],
      );
      if (!legacy && !biomolecular) missing.push(requirement.id);
    }
    if (missing.length > 0) throw new ScientificApprovalMissingDecisionError(request.id, missing);
  }

  private async assertPlanApprovalContract(
    tx: ScientificTransaction,
    request: ApprovalRequest,
  ): Promise<void> {
    if (request.subjectType !== "plan") return;
    const row = await this.context.requiredRow<JsonRow>(
      tx,
      "approval subject plan",
      request.subjectId,
      "scientific_plans",
    );
    const plan = parsePayload(ScientificPlanSchema, row, `plan ${request.subjectId}`);
    const requiredRole = exactPlanApprovalRole(plan);
    if (request.requestedFromRole !== requiredRole) {
      throw new ScientificIntegrityError(
        "Plan approval must target the plan's single required role",
        {
          planId: plan.id,
          requiredRole,
          requestedFromRole: request.requestedFromRole,
        },
      );
    }
  }

  private async subjectSnapshot(
    tx: ScientificTransaction,
    subjectType: ApprovalRequest["subjectType"],
    subjectId: string,
    lock = false,
  ): Promise<SubjectSnapshot> {
    if (subjectType === "plan") {
      const row = await this.context.requiredRow<
        JsonRow & {
          mission_id: string;
          version: number;
          revision: number;
          plan_digest: string;
        }
      >(tx, "approval subject plan", subjectId, "scientific_plans", lock);
      const plan = parsePayload(ScientificPlanSchema, row, `plan ${subjectId}`);
      const actualGraphDigest = computeSkillGraphDigest(plan.skillResolution);
      if (plan.skillResolution.graphDigest !== actualGraphDigest) {
        throw new ScientificIntegrityError("Resolved skill graph digest is corrupt", {
          planId: plan.id,
        });
      }
      assertEmbeddedDigest("scientific protocol", plan.protocol, "protocolDigest");
      const actualDigest = computePlanDigest(plan);
      if (String(row.plan_digest) !== plan.planDigest) {
        throw new ScientificIntegrityError("Plan digest column and authoritative payload diverge", {
          planId: plan.id,
        });
      }
      return {
        missionId: String(row.mission_id),
        version: Number(row.version),
        revision: Number(row.revision),
        digest: actualDigest,
        requiredDecisionIds: unique(plan.protocol.decisions),
        requiredDecisions: unique(plan.protocol.decisions).map((id) => ({ id })),
        decisionPlanId: plan.id,
      };
    }
    if (subjectType === "decision") {
      const legacy = await this.context.one<{ mission_id: string; payload_digest: string }>(
        tx,
        "SELECT mission_id, payload_digest FROM scientific_decisions WHERE id = $1",
        [subjectId],
      );
      const biomolecularRows = await tx.queryRows<{
        mission_id: string;
        revision: number;
        decision_digest: string;
        material_digest: string;
        review_status: string;
        payload_json: string;
      }>(
        `SELECT mission_id, revision, decision_digest, material_digest, review_status, payload_json
         FROM scientific_biomolecular_decisions
         WHERE id = $1 ORDER BY revision DESC LIMIT 1${
           lock && this.context.database._provider === "postgres" ? " FOR UPDATE" : ""
         }`,
        [subjectId],
      );
      const biomolecular = biomolecularRows[0] ?? null;
      if (legacy && biomolecular) {
        throw new ScientificIntegrityError("Approval decision identity is ambiguous", {
          subjectId,
        });
      }
      if (!legacy && !biomolecular) {
        throw new ScientificEntityNotFoundError("approval subject decision", subjectId);
      }
      if (biomolecular) {
        const decision = assertBiomolecularDecisionDigest(
          JSON.parse(String(biomolecular.payload_json)),
        );
        if (
          decision.id !== subjectId ||
          decision.missionId !== String(biomolecular.mission_id) ||
          decision.revision !== Number(biomolecular.revision) ||
          decision.status !== String(biomolecular.review_status) ||
          decision.decisionDigest !== String(biomolecular.decision_digest) ||
          decision.decisionDigest !== String(biomolecular.material_digest)
        ) {
          throw new ScientificIntegrityError("Biomolecular decision projection is corrupt", {
            subjectId,
          });
        }
        return {
          missionId: String(biomolecular.mission_id),
          version: Number(biomolecular.revision),
          revision: Number(biomolecular.revision),
          digest: decision.decisionDigest,
          requiredDecisionIds: [subjectId],
          requiredDecisions: [{ id: subjectId, revision: Number(biomolecular.revision) }],
        };
      }
      return {
        missionId: String(legacy!.mission_id),
        version: 1,
        revision: 1,
        digest: String(legacy!.payload_digest),
        requiredDecisionIds: [subjectId],
        requiredDecisions: [{ id: subjectId }],
      };
    }
    if (subjectType === "operation") {
      const row = await this.context.requiredRow<
        JsonRow & { mission_id: string; request_digest: string }
      >(tx, "approval subject operation", subjectId, "scientific_external_operations");
      const operation = parsePayload(
        ExternalOperationSchema,
        row,
        `approval subject operation ${subjectId}`,
      );
      if (
        operation.id !== subjectId ||
        operation.missionId !== String(row.mission_id) ||
        operation.requestDigest !== String(row.request_digest) ||
        operation.requestDigest !== digestCanonical(operation.request)
      ) {
        throw new ScientificIntegrityError("Approval operation request projection is corrupt", {
          subjectId,
        });
      }
      // Operation revision changes as the external effect moves through its
      // lifecycle. Human approval binds the immutable request, whose approval
      // identity remains revision 1 for the operation's entire lifetime.
      return {
        missionId: String(row.mission_id),
        version: 1,
        revision: 1,
        digest: String(row.request_digest),
        requiredDecisionIds: [],
      };
    }
    if (
      subjectType === "biomolecular_system_manifest" ||
      subjectType === "md_protocol" ||
      subjectType === "md_stage" ||
      subjectType === "replica_set" ||
      subjectType === "md_assessment"
    ) {
      return resolveMdSubjectSnapshot(
        tx,
        this.context.database._provider,
        subjectType,
        subjectId,
        lock,
      );
    }
    const row = await this.context.requiredRow<{
      mission_id: string;
      revision: number;
      payload_digest: string;
    }>(tx, "approval subject result", subjectId, "scientific_assessments");
    return {
      missionId: String(row.mission_id),
      version: Number(row.revision),
      revision: Number(row.revision),
      digest: String(row.payload_digest),
      requiredDecisionIds: [],
    };
  }
}
