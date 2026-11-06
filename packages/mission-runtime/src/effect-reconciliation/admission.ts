import {
  ApprovalRequestSchema,
  ApprovalResponseSchema,
  BiomolecularSystemBuildRequestSchema,
  EvidenceReferenceSchema,
  ExternalOperationSchema,
  MdExecutionBindingParametersSchema,
  ScientificMissionSchema,
  ScientificPlanSchema,
  WorkUnitSchema,
  assertScientificTransition,
  canonicalJson,
  digestCanonical,
} from "@eigengrid/scientific-schema";
import {
  ScientificEntityConflictError,
  ScientificEntityNotFoundError,
  ScientificIntegrityError,
  ScientificRevisionConflictError,
} from "../errors";
import { assertMdEffectAdmissionAuthority } from "../md-effect-authority";
import { workUnitUsesMdExecutionBinding } from "../md-projection-store";
import {
  assertMissionProjectCreationAuthority,
  readScientificMissionProjectAssociation,
} from "../mission-project";
import { insertScientificEffectAdmission, readOperationIntentOutbox } from "../operation-outbox";
import { EffectReconciliationContext } from "./context";
import { type BeginWorkUnitEffectInput, type BeginWorkUnitEffectResult } from "./contracts";
import { requestedEffectIdentity } from "./identity";
import { type PayloadRow, parsePayload } from "./payload";
import {
  assertApprovedSystemBuildDecisionReferences,
  assertExactSystemBuildSourceEvidence,
} from "./system-build-evidence";
import {
  EFFECT_COMPATIBLE_MISSION_STATES,
  assertApprovedSystemPreparationOperation,
  assertTypedSystemPreparationIntent,
  computeExactPlanDigest,
  exactPlanApprovalRole,
} from "./system-preparation";

export async function beginWorkUnitEffect(
  store: EffectReconciliationContext,
  input: BeginWorkUnitEffectInput,
): Promise<BeginWorkUnitEffectResult> {
  return store.inTransaction("begin work-unit effect", async (transaction) => {
    const operationRow = await store.requiredRow(
      transaction,
      "scientific_external_operations",
      input.operationId,
      "external operation",
      true,
    );
    const operation = parsePayload(
      ExternalOperationSchema,
      operationRow,
      `External operation ${input.operationId}`,
    );
    const workRow = await store.requiredRow(
      transaction,
      "scientific_work_units",
      input.workUnitId,
      "work unit",
      true,
    );
    const workUnit = parsePayload(WorkUnitSchema, workRow, `Work unit ${input.workUnitId}`);
    const mdStage = workUnitUsesMdExecutionBinding(workUnit);
    if (mdStage !== (operation.kind === "md_stage_execution")) {
      throw new ScientificIntegrityError(
        "MD WorkUnit and operation kind must use the same effect boundary",
      );
    }
    const mdBinding = mdStage
      ? MdExecutionBindingParametersSchema.parse(workUnit.protocolFragment.parameters)
      : undefined;

    if (operation.revision !== input.expectedOperationRevision) {
      throw new ScientificRevisionConflictError(
        "external operation",
        operation.id,
        input.expectedOperationRevision,
        operation.revision,
      );
    }
    if (workUnit.revision !== input.expectedWorkUnitRevision) {
      throw new ScientificRevisionConflictError(
        "work unit",
        workUnit.id,
        input.expectedWorkUnitRevision,
        workUnit.revision,
      );
    }
    if (operation.state !== "intent" || workUnit.state !== "claimed") {
      throw new ScientificIntegrityError(
        "The atomic effect boundary requires an intent operation and claimed work unit",
        {
          operationId: operation.id,
          operationState: operation.state,
          workUnitId: workUnit.id,
          workUnitState: workUnit.state,
        },
      );
    }
    if (
      operation.workUnitId !== workUnit.id ||
      operation.missionId !== workUnit.missionId ||
      workUnit.claimOwner !== input.claimOwner
    ) {
      throw new ScientificIntegrityError("Effect boundary authority does not match durable state", {
        operationId: operation.id,
        workUnitId: workUnit.id,
        expectedClaimOwner: workUnit.claimOwner,
        actualClaimOwner: input.claimOwner,
      });
    }
    if (!workUnit.claimExpiresAt || Date.parse(workUnit.claimExpiresAt) <= Date.parse(input.at)) {
      throw new ScientificEntityConflictError(
        "work-unit claim",
        workUnit.id,
        "lease expired before the effect boundary",
      );
    }
    const missionRow = await store.requiredRow(
      transaction,
      "scientific_missions",
      workUnit.missionId,
      "scientific mission",
      true,
    );
    const mission = parsePayload(
      ScientificMissionSchema,
      missionRow,
      `Scientific mission ${workUnit.missionId}`,
    );
    if (
      mission.activePlanId !== workUnit.planId ||
      !EFFECT_COMPATIBLE_MISSION_STATES.has(mission.state)
    ) {
      throw new ScientificIntegrityError(
        "Effect boundary no longer matches the active executable mission plan",
        {
          missionId: mission.id,
          missionState: mission.state,
          activePlanId: mission.activePlanId,
          workUnitPlanId: workUnit.planId,
        },
      );
    }

    // The immutable association is historical ownership, not a perpetual
    // effect grant. Revalidate its current human/project/membership authority
    // inside the same transaction and before an MD WorkUnit becomes
    // `executing` or an admission is written. Site UID/epoch authority is
    // still independently resolved at the protected Head boundary.
    if (mdStage) {
      const association = await readScientificMissionProjectAssociation(
        transaction,
        mission.id,
        store.database._provider,
        true,
      );
      if (
        !association ||
        mission.requestedBy.kind !== "human" ||
        association.ownerUserId !== mission.requestedBy.id
      ) {
        throw new ScientificIntegrityError(
          "MD effect requires its exact immutable human mission-project association",
        );
      }
      await assertMissionProjectCreationAuthority(
        transaction,
        {
          mission,
          projectId: association.projectId,
          ownerUserId: association.ownerUserId,
        },
        store.database._provider,
      );
    }

    const planRows = await transaction.queryRows<PayloadRow & { plan_digest: string }>(
      `SELECT payload_json, plan_digest FROM scientific_plans WHERE id = $1${store.lockClause()}`,
      [workUnit.planId],
    );
    const planRow = planRows[0];
    if (!planRow) throw new ScientificEntityNotFoundError("scientific plan", workUnit.planId);
    const plan = parsePayload(ScientificPlanSchema, planRow, `Scientific plan ${workUnit.planId}`);
    const actualPlanDigest = computeExactPlanDigest(plan);
    if (
      plan.missionId !== mission.id ||
      plan.version !== workUnit.planVersion ||
      plan.status !== "approved" ||
      plan.planDigest !== actualPlanDigest ||
      String(planRow.plan_digest) !== actualPlanDigest
    ) {
      throw new ScientificIntegrityError(
        "Effect boundary plan is not the exact approved persisted plan",
        {
          planId: plan.id,
          planStatus: plan.status,
          planVersion: plan.version,
          workUnitPlanVersion: workUnit.planVersion,
        },
      );
    }
    const requiredApprovalRole = exactPlanApprovalRole(plan);
    if (
      workUnit.approvalPolicy.required &&
      workUnit.approvalPolicy.minimumRole !== requiredApprovalRole
    ) {
      throw new ScientificIntegrityError(
        "Approval-required work unit does not use the plan's single approval role",
        {
          workUnitId: workUnit.id,
          planId: plan.id,
          requiredApprovalRole,
          minimumRole: workUnit.approvalPolicy.minimumRole ?? null,
        },
      );
    }
    if (
      !mdStage &&
      ![...plan.protocol.engineAgnosticSteps, ...(plan.protocol.capabilitySteps ?? [])].some(
        (fragment) => canonicalJson(fragment) === canonicalJson(workUnit.protocolFragment),
      )
    ) {
      throw new ScientificIntegrityError(
        "Work unit protocol fragment is outside the exact approved plan",
        { workUnitId: workUnit.id, planId: plan.id },
      );
    }

    const approvalRows = await transaction.queryRows<PayloadRow>(
      `SELECT payload_json FROM scientific_approval_requests
         WHERE mission_id = $1 AND subject_type = 'plan' AND subject_id = $2
           AND subject_version = $3 AND subject_revision = $4
           AND payload_digest = $5 AND policy_digest = $6 AND requested_from_role = $7
           AND state = 'approved'
           ${mdBinding ? "AND id = $8" : ""}
         ORDER BY requested_at DESC, id DESC LIMIT 1${store.lockClause()}`,
      [
        mission.id,
        plan.id,
        plan.version,
        plan.revision,
        actualPlanDigest,
        input.currentPolicyDigest,
        requiredApprovalRole,
        ...(mdBinding ? [mdBinding.plan.approvalRef] : []),
      ],
    );
    const approvalRow = approvalRows[0];
    if (!approvalRow) {
      throw new ScientificIntegrityError(
        "No current exact-revision approval authorizes this effect",
        { workUnitId: workUnit.id, policyDigest: input.currentPolicyDigest },
      );
    }
    const approval = parsePayload(ApprovalRequestSchema, approvalRow, "Exact effect approval");
    if (
      approval.state !== "approved" ||
      approval.policyDigest !== input.currentPolicyDigest ||
      approval.subjectId !== plan.id ||
      approval.subjectVersion !== plan.version ||
      approval.subjectRevision !== plan.revision ||
      approval.payloadDigest !== actualPlanDigest ||
      !approval.response ||
      approval.response.decision !== "approved" ||
      approval.response.actor.kind !== "human" ||
      approval.response.actor.role !== approval.requestedFromRole ||
      approval.response.role !== approval.requestedFromRole ||
      approval.response.subjectVersion !== plan.version ||
      approval.response.subjectRevision !== plan.revision ||
      approval.response.payloadDigest !== actualPlanDigest ||
      approval.response.policyDigest !== input.currentPolicyDigest
    ) {
      throw new ScientificIntegrityError(
        "Exact effect approval is stale, modified, or unauthorized",
        { approvalId: approval.id, workUnitId: workUnit.id },
      );
    }
    if (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.parse(input.at)) {
      throw new ScientificIntegrityError("Exact effect approval expired before effect start", {
        approvalId: approval.id,
        expiresAt: approval.expiresAt,
        effectAt: input.at,
      });
    }
    const responseRow = await store.requiredRow(
      transaction,
      "scientific_approval_responses",
      approval.response.id,
      "approval response",
      true,
    );
    const response = parsePayload(ApprovalResponseSchema, responseRow, "Effect approval response");
    if (canonicalJson(response) !== canonicalJson(approval.response)) {
      throw new ScientificIntegrityError(
        "Effect approval response differs from its durable human decision",
      );
    }
    const requiredDecisionIds = [...new Set(plan.protocol.decisions)];
    if (requiredDecisionIds.length > 0) {
      const decisionRows = await transaction.queryRows<{ id: string }>(
        "SELECT id FROM scientific_decisions WHERE mission_id = $1 AND plan_id = $2",
        [mission.id, plan.id],
      );
      const persistedDecisionIds = new Set(decisionRows.map((row) => String(row.id)));
      const missingDecisionIds = requiredDecisionIds.filter(
        (decisionId) => !persistedDecisionIds.has(decisionId),
      );
      if (missingDecisionIds.length > 0) {
        throw new ScientificIntegrityError(
          "Exact effect approval is missing required scientific decisions",
          { approvalId: approval.id, decisionIds: missingDecisionIds },
        );
      }
    }
    const requested = requestedEffectIdentity(operation);
    if (requested.jobId !== input.jobId || requested.attemptId !== input.attemptId) {
      throw new ScientificIntegrityError(
        "Persisted operation intent does not carry the exact coordinator identity",
        {
          operationId: operation.id,
          expectedJobId: input.jobId,
          expectedAttemptId: input.attemptId,
          requestJobId: requested.jobId,
          requestAttemptId: requested.attemptId,
        },
      );
    }
    if (operation.requestDigest !== digestCanonical(operation.request)) {
      throw new ScientificIntegrityError(
        "Persisted operation request no longer matches its durable digest",
        { operationId: operation.id },
      );
    }
    if (mdStage) {
      await assertMdEffectAdmissionAuthority(transaction, {
        operation,
        workUnit,
        currentPolicyDigest: input.currentPolicyDigest,
        at: input.at,
        provider: store.database._provider,
      });
    } else {
      const request =
        operation.request &&
        typeof operation.request === "object" &&
        !Array.isArray(operation.request)
          ? (operation.request as Record<string, unknown>)
          : {};
      const capabilityMatches =
        operation.kind === "system_preparation" &&
        workUnit.protocolFragment.kind === "scientific_capability"
          ? canonicalJson(request.capability) ===
            canonicalJson(workUnit.protocolFragment.capability)
          : request.capability === workUnit.executionPolicy.capability;
      if (
        !capabilityMatches ||
        request.missionId !== mission.id ||
        request.planId !== plan.id ||
        request.planVersion !== plan.version ||
        request.workUnitId !== workUnit.id
      ) {
        throw new ScientificIntegrityError(
          "Persisted operation request is not bound to the exact approved work unit",
          { operationId: operation.id, workUnitId: workUnit.id },
        );
      }
      assertTypedSystemPreparationIntent(operation, workUnit);
      if (
        operation.kind === "system_preparation" &&
        workUnit.protocolFragment.kind === "scientific_capability" &&
        workUnit.protocolFragment.capability.id === "biomolecular.build-system"
      ) {
        const buildRequest = BiomolecularSystemBuildRequestSchema.parse(operation.request);
        await assertApprovedSystemBuildDecisionReferences(
          transaction,
          mission.id,
          buildRequest.decisionRefs,
          input.at,
        );
      }
      if (operation.kind === "system_preparation") {
        const operationApprovalRows = await transaction.queryRows<
          PayloadRow & {
            id: string;
            mission_id: string;
            subject_type: string;
            subject_id: string;
            subject_version: number;
            subject_revision: number;
            state: string;
            requested_from_role: string;
            payload_digest: string;
            policy_digest: string;
            requested_at: string;
            expires_at: string | null;
          }
        >(
          `SELECT id, mission_id, subject_type, subject_id, subject_version, subject_revision,
                    state, requested_from_role, payload_digest, policy_digest, requested_at,
                    expires_at, payload_json
             FROM scientific_approval_requests
             WHERE mission_id = $1 AND subject_type = 'operation' AND subject_id = $2
               AND subject_version = 1 AND subject_revision = 1 AND payload_digest = $3
               AND policy_digest = $4 AND requested_from_role = $5 AND state = 'approved'
             ORDER BY requested_at DESC, id DESC LIMIT 1${store.lockClause()}`,
          [
            mission.id,
            operation.id,
            operation.requestDigest,
            input.currentPolicyDigest,
            requiredApprovalRole,
          ],
        );
        const operationApprovalRow = operationApprovalRows[0];
        if (!operationApprovalRow) {
          throw new ScientificIntegrityError(
            "System-preparation effect has no prior approval for its exact operation request",
            { operationId: operation.id },
          );
        }
        const operationApproval = parsePayload(
          ApprovalRequestSchema,
          operationApprovalRow,
          "Exact system-preparation operation approval",
        );
        if (
          operationApprovalRow.id !== operationApproval.id ||
          operationApprovalRow.mission_id !== operationApproval.missionId ||
          operationApprovalRow.subject_type !== operationApproval.subjectType ||
          operationApprovalRow.subject_id !== operationApproval.subjectId ||
          Number(operationApprovalRow.subject_version) !== operationApproval.subjectVersion ||
          Number(operationApprovalRow.subject_revision) !== operationApproval.subjectRevision ||
          operationApprovalRow.state !== operationApproval.state ||
          operationApprovalRow.requested_from_role !== operationApproval.requestedFromRole ||
          operationApprovalRow.payload_digest !== operationApproval.payloadDigest ||
          operationApprovalRow.policy_digest !== operationApproval.policyDigest ||
          operationApprovalRow.requested_at !== operationApproval.requestedAt ||
          operationApprovalRow.expires_at !== (operationApproval.expiresAt ?? null)
        ) {
          throw new ScientificIntegrityError(
            "System-preparation approval columns differ from their durable request",
            { operationId: operation.id, approvalId: operationApproval.id },
          );
        }
        if (!operationApproval.response) {
          throw new ScientificIntegrityError(
            "System-preparation operation approval has no durable human response",
            { operationId: operation.id, approvalId: operationApproval.id },
          );
        }
        const operationResponseRow = (await store.requiredRow(
          transaction,
          "scientific_approval_responses",
          operationApproval.response.id,
          "system-preparation approval response",
          true,
        )) as PayloadRow & {
          id: string;
          approval_request_id: string;
          decision: string;
          actor_id: string;
          role: string;
          subject_version: number;
          subject_revision: number;
          payload_digest: string;
          policy_digest: string;
          decided_at: string;
        };
        const operationResponse = parsePayload(
          ApprovalResponseSchema,
          operationResponseRow,
          "System-preparation operation response",
        );
        if (
          operationResponseRow.id !== operationResponse.id ||
          operationResponseRow.approval_request_id !== operationResponse.approvalRequestId ||
          operationResponseRow.decision !== operationResponse.decision ||
          operationResponseRow.actor_id !== operationResponse.actor.id ||
          operationResponseRow.role !== operationResponse.role ||
          Number(operationResponseRow.subject_version) !== operationResponse.subjectVersion ||
          Number(operationResponseRow.subject_revision) !== operationResponse.subjectRevision ||
          operationResponseRow.payload_digest !== operationResponse.payloadDigest ||
          operationResponseRow.policy_digest !== operationResponse.policyDigest ||
          operationResponseRow.decided_at !== operationResponse.decidedAt
        ) {
          throw new ScientificIntegrityError(
            "System-preparation approval response columns differ from their durable decision",
            { operationId: operation.id, approvalId: operationApproval.id },
          );
        }
        assertApprovedSystemPreparationOperation({
          operation,
          approvalValue: operationApproval,
          responseValue: operationResponse,
          currentPolicyDigest: input.currentPolicyDigest,
          requiredRole: requiredApprovalRole,
          at: input.at,
        });
      }
      const inputEvidenceId = request.inputEvidenceId;
      const inputContentDigest = request.inputContentDigest;
      if (
        typeof inputEvidenceId !== "string" ||
        typeof inputContentDigest !== "string" ||
        !workUnit.inputRefs.includes(inputEvidenceId)
      ) {
        throw new ScientificIntegrityError(
          "Persisted operation request lacks exact approved input evidence",
          { operationId: operation.id, workUnitId: workUnit.id },
        );
      }
      const evidenceRows = await transaction.queryRows<PayloadRow>(
        `SELECT payload_json FROM scientific_evidence WHERE id = $1${store.lockClause()}`,
        [inputEvidenceId],
      );
      const evidenceRow = evidenceRows[0];
      if (!evidenceRow) {
        throw new ScientificEntityNotFoundError("scientific evidence", inputEvidenceId);
      }
      const evidence = parsePayload(
        EvidenceReferenceSchema,
        evidenceRow,
        `Scientific evidence ${inputEvidenceId}`,
      );
      if (
        evidence.missionId !== mission.id ||
        !evidence.immutable ||
        evidence.contentDigest !== inputContentDigest
      ) {
        throw new ScientificIntegrityError(
          "Operation input is not the exact immutable mission evidence",
          { operationId: operation.id, evidenceId: inputEvidenceId },
        );
      }
      if (
        operation.kind === "system_preparation" &&
        workUnit.protocolFragment.kind === "scientific_capability" &&
        workUnit.protocolFragment.capability.id === "biomolecular.build-system"
      ) {
        await assertExactSystemBuildSourceEvidence(
          transaction,
          mission.id,
          workUnit,
          BiomolecularSystemBuildRequestSchema.parse(operation.request),
        );
      }
    }
    const outbox = await readOperationIntentOutbox(transaction, operation);
    if (!outbox) {
      throw new ScientificIntegrityError(
        "Effect start requires an atomically recorded operation outbox; historical intents need explicit reconciliation",
        { operationId: operation.id },
      );
    }
    const claims = await transaction.queryRows<{
      id: string;
      owner_id: string;
      acquired_at: string;
      expires_at: string;
    }>(
      `SELECT id, owner_id, acquired_at, expires_at FROM scientific_work_unit_claims
         WHERE work_unit_id = $1 AND active = $2${store.lockClause()}`,
      [workUnit.id, true],
    );
    const claim = claims[0];
    if (
      claims.length !== 1 ||
      !claim ||
      claim.owner_id !== input.claimOwner ||
      claim.expires_at !== workUnit.claimExpiresAt ||
      Date.parse(claim.acquired_at) > Date.parse(input.at)
    ) {
      throw new ScientificIntegrityError("Effect admission requires the exact active claim record");
    }
    assertScientificTransition("operation", operation.state, "effect_started");
    assertScientificTransition("work_unit", workUnit.state, "executing");

    const nextOperation = ExternalOperationSchema.parse({
      ...operation,
      policyDigest: input.currentPolicyDigest,
      state: "effect_started",
      revision: operation.revision + 1,
      updatedAt: input.at,
    });
    const nextWorkUnit = WorkUnitSchema.parse({
      ...workUnit,
      state: "executing",
      revision: workUnit.revision + 1,
      jobId: input.jobId,
      attemptId: input.attemptId,
      updatedAt: input.at,
    });

    const changedOperation = await transaction.queryRows<{ id: string }>(
      `UPDATE scientific_external_operations
         SET state = $1, revision = $2, policy_digest = $3, payload_json = $4, updated_at = $5
         WHERE id = $6 AND revision = $7 AND state = 'intent' RETURNING id`,
      [
        nextOperation.state,
        nextOperation.revision,
        nextOperation.policyDigest,
        canonicalJson(nextOperation),
        nextOperation.updatedAt,
        nextOperation.id,
        operation.revision,
      ],
    );
    if (changedOperation.length === 0) {
      throw new ScientificRevisionConflictError(
        "external operation",
        operation.id,
        operation.revision,
        operation.revision + 1,
      );
    }
    const changedWorkUnit = await transaction.queryRows<{ id: string }>(
      `UPDATE scientific_work_units
         SET state = $1, revision = $2, job_id = $3, attempt_id = $4,
             payload_digest = $5, payload_json = $6, updated_at = $7
         WHERE id = $8 AND revision = $9 AND state = 'claimed' AND claim_owner = $10
         RETURNING id`,
      [
        nextWorkUnit.state,
        nextWorkUnit.revision,
        nextWorkUnit.jobId,
        nextWorkUnit.attemptId,
        digestCanonical(nextWorkUnit),
        canonicalJson(nextWorkUnit),
        nextWorkUnit.updatedAt,
        nextWorkUnit.id,
        workUnit.revision,
        input.claimOwner,
      ],
    );
    if (changedWorkUnit.length === 0) {
      throw new ScientificRevisionConflictError(
        "work unit",
        workUnit.id,
        workUnit.revision,
        workUnit.revision + 1,
      );
    }
    await insertScientificEffectAdmission(transaction, {
      operationId: operation.id,
      missionId: mission.id,
      workUnitId: workUnit.id,
      outboxDigest: outbox.envelopeDigest,
      requestDigest: operation.requestDigest,
      claimId: claim.id,
      claimOwner: input.claimOwner,
      claimExpiresAt: claim.expires_at,
      fencingGeneration: workUnit.revision,
      jobId: input.jobId,
      attemptId: input.attemptId,
      plan: {
        id: plan.id,
        version: plan.version,
        revision: plan.revision,
        digest: actualPlanDigest,
      },
      approvalId: approval.id,
      approvalResponseId: response.id,
      approvalDigest: digestCanonical(approval),
      approvedBy: response.actor,
      policyDigest: input.currentPolicyDigest,
      admittedAt: input.at,
    });
    return { operation: nextOperation, workUnit: nextWorkUnit };
  });
}
