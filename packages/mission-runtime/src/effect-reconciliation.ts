import {
  AtomMapPublicationRequestSchema,
  AtomMapPublicationRequestSchemaVersion,
  ApprovalRequestSchema,
  ApprovalResponseSchema,
  BiomolecularMaterialPublicationBindingSchema,
  BiomolecularSystemBuildRequestSchema,
  BiomolecularSystemBuildRequestSchemaVersion,
  BiomolecularSystemBuildWorkUnitParametersSchema,
  assertBiomolecularDecisionDigest,
  EvidenceReferenceSchema,
  ExternalOperationSchema,
  ForceFieldStackPublicationRequestSchema,
  ForceFieldStackPublicationRequestSchemaVersion,
  MdExecutionBindingParametersSchema,
  OperationReceiptSchema,
  ScientificMissionSchema,
  ScientificPlanSchema,
  WorkUnitSchema,
  DigestSchema,
  IdSchema,
  assertScientificTransition,
  canonicalJson,
  computeBiomolecularDecisionDigest,
  digestCanonical,
  type BiomolecularDecisionReference,
  type ExternalOperation,
  type OperationReceipt,
  type WorkUnit,
  type WorkUnitState,
} from "@eigengrid/scientific-schema";
import {
  ScientificEntityConflictError,
  ScientificEntityNotFoundError,
  ScientificIntegrityError,
  ScientificRevisionConflictError,
  ScientificStoreUnsupportedDatabaseError,
} from "./errors";
import type { ScientificDatabase, ScientificTransaction } from "./types";
import {
  insertScientificEffectAdmission,
  readOperationIntentOutbox,
  readScientificEffectAdmission,
  type ScientificEffectAdmission,
} from "./operation-outbox";
import { workUnitUsesMdExecutionBinding } from "./md-projection-store";
import {
  assertMdEffectAdmissionAuthority,
  mdStageEffectIdentity,
  type MdEffectAuthorityEvidence,
} from "./md-effect-authority";
import {
  MdDeliveryPrincipalSchema,
  assertMdDeliveryProjectAccess,
  freezeMdEffectDelivery,
  readMdEffectDelivery,
  type MdDeliveryPrincipal,
  type MdDeliveryDraft,
  type MdEffectDelivery,
} from "./effect-delivery";
import {
  assertMissionProjectCreationAuthority,
  readScientificMissionProjectAssociation,
} from "./mission-project";

export interface MdSubmissionAuthorityInput {
  operationId: string;
  claimOwner: string;
  currentPolicyDigest: string;
}

/** Head-internal, freshly read prerequisite for signing, NOT a capability or an
 * effect receipt. The transport must still persist its exact immutable delivery
 * binding/body, resolve current project/UID authority and verify engine bytes.
 */
export interface MdSubmissionAuthority extends MdEffectAuthorityEvidence {
  operation: ExternalOperation;
  workUnit: WorkUnit;
  mission: ReturnType<typeof ScientificMissionSchema.parse>;
  admission: ScientificEffectAdmission;
  checkedAt: string;
  expiresAt: string;
}

export interface BeginWorkUnitEffectInput {
  operationId: string;
  expectedOperationRevision: number;
  workUnitId: string;
  expectedWorkUnitRevision: number;
  claimOwner: string;
  jobId: string;
  attemptId: string;
  /** Policy authority resolved immediately before crossing the effect boundary. */
  currentPolicyDigest: string;
  at: string;
}

export interface BeginWorkUnitEffectResult {
  operation: ExternalOperation;
  workUnit: WorkUnit;
}

export type ReconciledEffectOutcome = "completed" | "failed" | "cancelled";

export interface ReconcileWorkUnitEffectInput {
  operationId: string;
  workUnitId: string;
  jobId: string;
  attemptId: string;
  outcome: ReconciledEffectOutcome;
  retryable?: boolean;
  at: string;
}

export interface ReconcileWorkUnitEffectResult {
  workUnit: WorkUnit;
  operation: ExternalOperation;
  receipt: OperationReceipt;
  transitionedThrough: WorkUnitState[];
  alreadyReconciled: boolean;
}

export interface ScientificEffectPersistence {
  beginWorkUnitEffect(input: BeginWorkUnitEffectInput): Promise<BeginWorkUnitEffectResult>;
  reconcileWorkUnitEffect(
    input: ReconcileWorkUnitEffectInput,
  ): Promise<ReconcileWorkUnitEffectResult>;
}

export type ScientificEffectReconciler = ScientificEffectPersistence;

type PayloadRow = { payload_json: unknown } & Record<string, unknown>;

function parsePayload<T>(schema: { parse(value: unknown): T }, row: PayloadRow, label: string): T {
  try {
    const payload =
      typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json;
    return schema.parse(payload);
  } catch (error) {
    throw new ScientificIntegrityError(`${label} contains an invalid authoritative payload`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function assertExactSystemBuildSourceEvidence(
  transaction: ScientificTransaction,
  missionId: string,
  workUnit: WorkUnit,
  request: ReturnType<typeof BiomolecularSystemBuildRequestSchema.parse>,
): Promise<void> {
  const parameters = BiomolecularSystemBuildWorkUnitParametersSchema.parse(
    workUnit.protocolFragment.kind === "scientific_capability"
      ? workUnit.protocolFragment.parameters
      : undefined,
  );
  const declared = [
    ...request.sourceEvidence.map((item) => ({
      id: item.id,
      contentDigest: item.contentDigest,
    })),
    {
      id: parameters.systemBuild.forceFieldStackEvidenceRef,
      contentDigest: request.forceFieldStack.digest,
      kind: "force_field_stack",
    },
  ];
  for (const expected of declared) {
    const rows = await transaction.queryRows<PayloadRow>(
      `SELECT payload_json FROM scientific_evidence WHERE id = $1`,
      [expected.id],
    );
    if (!rows[0]) {
      throw new ScientificEntityNotFoundError("scientific evidence", expected.id);
    }
    const evidence = parsePayload(
      EvidenceReferenceSchema,
      rows[0],
      `System-build evidence ${expected.id}`,
    );
    if (
      evidence.missionId !== missionId ||
      !evidence.immutable ||
      evidence.contentDigest !== expected.contentDigest ||
      ("kind" in expected && evidence.kind !== expected.kind)
    ) {
      throw new ScientificIntegrityError(
        "System-build source evidence is not the exact immutable same-mission CAS reference",
        { missionId, evidenceId: expected.id },
      );
    }
  }
}

export async function assertApprovedSystemBuildDecisionReferences(
  transaction: ScientificTransaction,
  missionId: string,
  references: readonly BiomolecularDecisionReference[],
  at: string,
): Promise<void> {
  for (const reference of references) {
    const rows = await transaction.queryRows<
      PayloadRow & {
        revision: number;
        decision_kind: string;
        decision_digest: string;
        approval_ref: string | null;
        approval_payload_json: unknown;
        response_payload_json: unknown;
      }
    >(
      `SELECT decision.revision, decision.decision_kind, decision.decision_digest,
              decision.approval_ref, decision.payload_json,
              approval.payload_json AS approval_payload_json,
              response.payload_json AS response_payload_json
       FROM scientific_biomolecular_decisions AS decision
       LEFT JOIN scientific_approval_requests AS approval ON approval.id = decision.approval_ref
       LEFT JOIN scientific_approval_responses AS response
         ON response.approval_request_id = approval.id
       WHERE decision.id = $1 AND decision.revision = $2 AND decision.mission_id = $3`,
      [reference.id, reference.revision, missionId],
    );
    const row = rows[0];
    if (!row) {
      throw new ScientificIntegrityError(
        "System-build request requires each exact biomolecular decision to be approved",
        { missionId, decisionId: reference.id },
      );
    }
    const decision = assertBiomolecularDecisionDigest(
      parsePayload(
        { parse: (value: unknown) => value },
        { payload_json: row.payload_json },
        `System-build decision ${reference.id}`,
      ),
    );
    const approval = ApprovalRequestSchema.parse(
      typeof row.approval_payload_json === "string"
        ? JSON.parse(row.approval_payload_json)
        : row.approval_payload_json,
    );
    const response = ApprovalResponseSchema.parse(
      typeof row.response_payload_json === "string"
        ? JSON.parse(row.response_payload_json)
        : row.response_payload_json,
    );
    const materialDigest = computeBiomolecularDecisionDigest(decision);
    const atMs = Date.parse(at);
    if (
      decision.missionId !== missionId ||
      decision.id !== reference.id ||
      decision.revision !== reference.revision ||
      decision.kind !== reference.kind ||
      decision.status !== "approved" ||
      decision.decisionDigest !== reference.decisionDigest ||
      decision.decisionDigest !== String(row.decision_digest) ||
      decision.kind !== String(row.decision_kind) ||
      decision.approvalRef !== reference.approvalRef ||
      decision.approvalRef !== String(row.approval_ref) ||
      approval.id !== reference.approvalRef ||
      approval.missionId !== missionId ||
      approval.subjectType !== "decision" ||
      approval.subjectId !== reference.id ||
      approval.subjectVersion !== reference.revision ||
      approval.subjectRevision !== reference.revision ||
      approval.state !== "approved" ||
      approval.payloadDigest !== materialDigest ||
      !approval.response ||
      response.approvalRequestId !== approval.id ||
      response.decision !== "approved" ||
      response.actor.kind !== "human" ||
      response.role !== approval.requestedFromRole ||
      response.actor.role !== approval.requestedFromRole ||
      response.subjectVersion !== reference.revision ||
      response.subjectRevision !== reference.revision ||
      response.payloadDigest !== materialDigest ||
      response.policyDigest !== approval.policyDigest ||
      canonicalJson(approval.response) !== canonicalJson(response) ||
      !Number.isFinite(atMs) ||
      (approval.expiresAt !== undefined && Date.parse(approval.expiresAt) <= atMs)
    ) {
      throw new ScientificIntegrityError(
        "System-build request requires each exact biomolecular decision to be approved",
        { missionId, decisionId: reference.id },
      );
    }
  }
}

function effectIdentity(value: unknown): { jobId?: string; attemptId?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.jobId === "string" ? { jobId: record.jobId } : {}),
    ...(typeof record.attemptId === "string" ? { attemptId: record.attemptId } : {}),
  };
}

function requestedEffectIdentity(operation: ExternalOperation): {
  jobId?: string;
  attemptId?: string;
} {
  if (operation.kind === "md_stage_execution") return mdStageEffectIdentity(operation);
  if (
    !operation.request ||
    typeof operation.request !== "object" ||
    Array.isArray(operation.request)
  ) {
    return {};
  }
  const request = operation.request as Record<string, unknown>;
  return {
    ...(typeof request.intendedJobId === "string" ? { jobId: request.intendedJobId } : {}),
    ...(typeof request.intendedAttemptId === "string"
      ? { attemptId: request.intendedAttemptId }
      : {}),
  };
}

const EFFECT_COMPATIBLE_MISSION_STATES = new Set([
  "ready",
  "executing",
  "observing",
  "diagnosing",
  "validating",
]);

function computeExactPlanDigest(plan: ReturnType<typeof ScientificPlanSchema.parse>): string {
  const {
    planDigest: _planDigest,
    status: _status,
    updatedAt: _updatedAt,
    ...immutablePlan
  } = plan;
  return digestCanonical(immutablePlan);
}

export function assertTypedSystemPreparationIntent(
  operation: ExternalOperation,
  workUnit: WorkUnit,
): void {
  if (operation.kind !== "system_preparation") return;
  if (workUnit.protocolFragment.kind !== "scientific_capability") {
    throw new ScientificIntegrityError(
      "System-preparation effects require a typed scientific-capability WorkUnit",
    );
  }
  const capabilityId = workUnit.protocolFragment.capability.id;
  if (capabilityId === "biomolecular.build-system") {
    const request = BiomolecularSystemBuildRequestSchema.parse(operation.request);
    const parameters = BiomolecularSystemBuildWorkUnitParametersSchema.parse(
      workUnit.protocolFragment.parameters,
    );
    const binding = parameters.systemBuild;
    const sourceIds = request.sourceEvidence.map((item) => item.id).sort();
    const bindingSourceIds = [...binding.sourceEvidenceRefs].sort();
    const inputIds = [...binding.sourceEvidenceRefs, binding.forceFieldStackEvidenceRef].sort();
    if (
      request.schemaVersion !== BiomolecularSystemBuildRequestSchemaVersion ||
      request.missionId !== operation.missionId ||
      request.planId !== workUnit.planId ||
      request.planVersion !== workUnit.planVersion ||
      request.workUnitId !== workUnit.id ||
      request.inputEvidenceId !== binding.primaryInputEvidenceId ||
      canonicalJson([...workUnit.inputRefs].sort()) !== canonicalJson(inputIds) ||
      canonicalJson(request.capability) !== canonicalJson(workUnit.protocolFragment.capability) ||
      request.parametersDigest !== digestCanonical(workUnit.protocolFragment.parameters) ||
      request.outputContractDigest !== digestCanonical(workUnit.outputContract) ||
      request.systemManifest.id !== parameters.manifestId ||
      request.systemManifest.revision !== parameters.manifestRevision ||
      canonicalJson(sourceIds) !== canonicalJson(bindingSourceIds) ||
      request.sourceEvidence.find((item) => item.id === request.inputEvidenceId)?.contentDigest !==
        request.inputContentDigest ||
      canonicalJson(request.decisionRefs) !== canonicalJson(binding.decisionRefs) ||
      canonicalJson(request.forceFieldStack) !== canonicalJson(binding.forceFieldStack) ||
      canonicalJson(request.outputArtifacts) !== canonicalJson(binding.outputArtifacts) ||
      !["topology", "coordinates", "atom_map"].every((kind) =>
        workUnit.outputContract.requiredEvidenceKinds.includes(kind),
      ) ||
      !["artifact_integrity", "topology_integrity"].every((kind) =>
        workUnit.outputContract.requiredObservationKinds.includes(kind),
      )
    ) {
      throw new ScientificIntegrityError(
        "System-build effect does not match its exact typed WorkUnit and manifest target",
        { operationId: operation.id, workUnitId: workUnit.id },
      );
    }
    return;
  }
  if (
    capabilityId === "amber.force-field-stack" ||
    capabilityId === "biomolecular.force-field-compatibility"
  ) {
    const request = ForceFieldStackPublicationRequestSchema.parse(operation.request);
    const binding = BiomolecularMaterialPublicationBindingSchema.parse(
      workUnit.protocolFragment.parameters,
    );
    const requestEvidenceIds = request.sourceEvidence.map((evidence) => evidence.id).sort();
    const bindingEvidenceIds = [...binding.sourceEvidenceRefs].sort();
    if (
      request.schemaVersion !== ForceFieldStackPublicationRequestSchemaVersion ||
      request.missionId !== operation.missionId ||
      request.planId !== workUnit.planId ||
      request.planVersion !== workUnit.planVersion ||
      request.workUnitId !== workUnit.id ||
      !workUnit.inputRefs.includes(request.inputEvidenceId) ||
      request.capability.id !== capabilityId ||
      request.parametersDigest !== digestCanonical(binding) ||
      request.outputContractDigest !== digestCanonical(workUnit.outputContract) ||
      binding.subjectKind !== "force_field_stack" ||
      canonicalJson(request.stack) !== canonicalJson(binding.subject) ||
      request.outputArtifact.evidenceRef !== binding.artifactEvidenceRef ||
      canonicalJson(requestEvidenceIds) !== canonicalJson(bindingEvidenceIds)
    ) {
      throw new ScientificIntegrityError(
        "Force-field stack effect does not match its exact typed WorkUnit and material binding",
        { operationId: operation.id, workUnitId: workUnit.id },
      );
    }
    return;
  }
  if (
    capabilityId === "amber.topology-coordinate-validation" ||
    capabilityId === "biomolecular.system-provenance"
  ) {
    const request = AtomMapPublicationRequestSchema.parse(operation.request);
    const binding = BiomolecularMaterialPublicationBindingSchema.parse(
      workUnit.protocolFragment.parameters,
    );
    if (
      request.schemaVersion !== AtomMapPublicationRequestSchemaVersion ||
      request.missionId !== operation.missionId ||
      request.planId !== workUnit.planId ||
      request.planVersion !== workUnit.planVersion ||
      request.workUnitId !== workUnit.id ||
      !workUnit.inputRefs.includes(request.inputEvidenceId) ||
      request.capability.id !== capabilityId ||
      request.parametersDigest !== digestCanonical(binding) ||
      request.outputContractDigest !== digestCanonical(workUnit.outputContract) ||
      binding.subjectKind !== "atom_map" ||
      canonicalJson(request.atomMap) !== canonicalJson(binding.subject) ||
      canonicalJson(request.systemManifest) !== canonicalJson(binding.systemManifest) ||
      request.sourceArtifact.evidenceRef !== binding.artifactEvidenceRef
    ) {
      throw new ScientificIntegrityError(
        "AtomMap effect does not match its exact typed WorkUnit and publication binding",
        { operationId: operation.id, workUnitId: workUnit.id },
      );
    }
    return;
  }
  throw new ScientificIntegrityError(
    "System-preparation capability has no registered typed effect contract",
    { operationId: operation.id, workUnitId: workUnit.id, capabilityId },
  );
}

/** Plan approval does not authorize a later material build by itself. Every
 * system-preparation effect needs a prior human decision on its exact request. */
export function assertApprovedSystemPreparationOperation(input: {
  operation: ExternalOperation;
  approvalValue: unknown;
  responseValue: unknown;
  currentPolicyDigest: string;
  requiredRole: string;
  at: string;
}): void {
  const { operation } = input;
  const approval = ApprovalRequestSchema.parse(input.approvalValue);
  const response = ApprovalResponseSchema.parse(input.responseValue);
  const at = Date.parse(input.at);
  if (
    operation.kind !== "system_preparation" ||
    operation.state !== "intent" ||
    operation.revision !== 1 ||
    operation.requestDigest !== digestCanonical(operation.request) ||
    operation.policyDigest !== input.currentPolicyDigest ||
    approval.missionId !== operation.missionId ||
    approval.subjectType !== "operation" ||
    approval.subjectId !== operation.id ||
    approval.subjectVersion !== 1 ||
    approval.subjectRevision !== 1 ||
    approval.state !== "approved" ||
    approval.requestedFromRole !== input.requiredRole ||
    approval.payloadDigest !== operation.requestDigest ||
    approval.policyDigest !== input.currentPolicyDigest ||
    !approval.response ||
    response.approvalRequestId !== approval.id ||
    response.decision !== "approved" ||
    response.actor.kind !== "human" ||
    response.actor.role !== input.requiredRole ||
    response.role !== input.requiredRole ||
    response.subjectVersion !== 1 ||
    response.subjectRevision !== 1 ||
    response.payloadDigest !== operation.requestDigest ||
    response.policyDigest !== input.currentPolicyDigest ||
    canonicalJson(response) !== canonicalJson(approval.response) ||
    !Number.isFinite(at) ||
    Date.parse(approval.requestedAt) > at ||
    Date.parse(response.decidedAt) < Date.parse(approval.requestedAt) ||
    Date.parse(response.decidedAt) > at ||
    (approval.expiresAt !== undefined && Date.parse(approval.expiresAt) <= at)
  ) {
    throw new ScientificIntegrityError(
      "System-preparation effect requires a prior exact human approval of its immutable operation request",
      { operationId: operation.id },
    );
  }
}

function exactPlanApprovalRole(plan: ReturnType<typeof ScientificPlanSchema.parse>): string {
  if (plan.requiredApprovals.length !== 1) {
    throw new ScientificIntegrityError("Executable plans require exactly one approval role", {
      planId: plan.id,
      requiredApprovals: plan.requiredApprovals,
    });
  }
  return plan.requiredApprovals[0]!;
}

function transitionPath(
  current: WorkUnitState,
  outcome: ReconciledEffectOutcome,
  retryable: boolean,
): WorkUnitState[] {
  if (outcome === "completed") {
    if (current === "observing" || current === "succeeded") return [];
    if (current === "claimed") return ["executing", "observing"];
    if (current === "executing") return ["observing"];
  }
  if (outcome === "failed") {
    const target: WorkUnitState = retryable ? "retryable_failed" : "failed";
    if (current === target || current === "failed") return [];
    if (current === "claimed") return ["executing", target];
    if (current === "executing" || current === "observing") return [target];
  }
  if (outcome === "cancelled") {
    if (current === "cancelled") return [];
    if (current === "claimed" || current === "executing" || current === "observing") {
      return ["cancel_requested", "cancelling", "cancelled"];
    }
    if (current === "cancel_requested") return ["cancelling", "cancelled"];
    if (current === "cancelling") return ["cancelled"];
  }
  throw new ScientificIntegrityError(
    `Persisted ${outcome} effect cannot reconcile work unit from ${current}`,
    { current, outcome, retryable },
  );
}

function expectedOperationState(outcome: ReconciledEffectOutcome): ExternalOperation["state"] {
  return outcome === "completed" ? "confirmed" : "failed";
}

/**
 * Persistence-owned effect boundary. It atomically binds a claimed WorkUnit to
 * the exact persisted operation identity before the canonical coordinator is
 * called, and later settles expired/in-flight leases only from an exact durable
 * receipt. Models, skills, and protocol content never receive this capability.
 */
export class ScientificEffectReconciliationStore implements ScientificEffectPersistence {
  constructor(
    private readonly database: ScientificDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!database.beginTransaction || !["sqlite", "postgres"].includes(database._provider)) {
      throw new ScientificStoreUnsupportedDatabaseError(database._provider);
    }
  }

  /** Revalidate an ALREADY CONSUMED MD admission from persistence, never from a
   * caller-supplied admission/digest/UID. Reads use the same lock order and MD
   * authority checks as admission. No state mutation, signature or external I/O.
   * An indeterminate/acknowledged effect is observation-only, not new submission.
   */
  async readMdSubmissionAuthority(
    input: MdSubmissionAuthorityInput,
  ): Promise<MdSubmissionAuthority> {
    return (await this.withMdSubmissionAuthority(input, async () => undefined)).authority;
  }

  /** Persist once under the same authority locks. Nothing may be signed/sent
   * until this returns a committed created=true delivery. Duplicate calls only
   * recover the immutable bytes; they do NOT authorize resubmission.
   */
  async prepareMdSubmissionDelivery(
    input: MdSubmissionAuthorityInput,
    principalValue: MdDeliveryPrincipal,
    build: (authority: MdSubmissionAuthority) => MdDeliveryDraft,
  ): Promise<{ delivery: MdEffectDelivery; created: boolean }> {
    const principal = MdDeliveryPrincipalSchema.parse(principalValue);
    return (
      await this.withMdSubmissionAuthority(input, (authority, tx) =>
        freezeMdEffectDelivery(tx, authority, principal, this.database._provider, build),
      )
    ).value;
  }

  /** Live submit revalidation of the EXACT committed delivery. This is not a
   * one-shot signing permit: only the creator's in-flight Head call may use it
   * for submit. Replays/restarts must use the historical observe reader instead.
   */
  async readMdDeliverySigningAuthority(
    input: MdSubmissionAuthorityInput,
    principalValue: MdDeliveryPrincipal,
  ): Promise<{ authority: MdSubmissionAuthority; delivery: MdEffectDelivery }> {
    const principal = MdDeliveryPrincipalSchema.parse(principalValue);
    const result = await this.withMdSubmissionAuthority(input, async (authority, tx) => {
      await assertMdDeliveryProjectAccess(
        tx,
        authority.mission,
        principal,
        this.database._provider,
        "submit",
      );
      const delivery = await readMdEffectDelivery(tx, authority.operation);
      if (!delivery || canonicalJson(delivery.principal) !== canonicalJson(principal))
        throw new ScientificIntegrityError("Signing requires the exact committed MD delivery");
      if (Date.parse(delivery.expiresAt) <= Date.parse(authority.checkedAt))
        throw new ScientificIntegrityError("Frozen MD delivery has expired");
      return delivery;
    });
    if (Date.parse(result.value.expiresAt) <= Date.parse(result.authority.checkedAt))
      throw new ScientificIntegrityError("Frozen MD delivery expired before signing");
    return { authority: result.authority, delivery: result.value };
  }

  /** Historical transport recovery remains available after scientific lease/
   * approval expiry, but only to the currently authorized mission owner/project.
   * This never returns permission to submit. Site epoch/UID policy is additional.
   */
  async readMdSubmissionDelivery(
    operationIdValue: string,
    principalValue: MdDeliveryPrincipal,
  ): Promise<MdEffectDelivery | null> {
    const operationId = IdSchema.parse(operationIdValue);
    const principal = MdDeliveryPrincipalSchema.parse(principalValue);
    return this.inTransaction("read MD delivery", async (tx) => {
      const operation = parsePayload(
        ExternalOperationSchema,
        await this.requiredRow(
          tx,
          "scientific_external_operations",
          operationId,
          "operation",
          true,
        ),
        "MD operation",
      );
      const missionRow = await this.requiredRow(
        tx,
        "scientific_missions",
        operation.missionId,
        "mission",
        true,
      );
      const mission = parsePayload(ScientificMissionSchema, missionRow, "MD mission");
      if (
        operation.id !== operationId ||
        mission.id !== operation.missionId ||
        missionRow.payload_digest !== digestCanonical(mission)
      )
        throw new ScientificIntegrityError(
          "MD delivery owner is outside its exact durable mission",
        );
      await assertMdDeliveryProjectAccess(
        tx,
        mission,
        principal,
        this.database._provider,
        "observe",
      );
      const delivery = await readMdEffectDelivery(tx, operation);
      if (delivery && canonicalJson(delivery.principal) !== canonicalJson(principal))
        throw new ScientificIntegrityError(
          "MD delivery belongs to a different user/project/UID/site",
        );
      return delivery;
    });
  }

  private async withMdSubmissionAuthority<T>(
    input: MdSubmissionAuthorityInput,
    body: (authority: MdSubmissionAuthority, tx: ScientificTransaction) => Promise<T>,
  ): Promise<{ authority: MdSubmissionAuthority; value: T }> {
    const operationId = IdSchema.parse(input.operationId);
    const claimOwner = IdSchema.parse(input.claimOwner);
    const currentPolicyDigest = DigestSchema.parse(input.currentPolicyDigest);
    const clock = (): number => {
      const value = this.now().getTime();
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new ScientificIntegrityError("Invalid live MD submission clock");
      return value;
    };
    const startedAt = clock();
    const result = await this.inTransaction("read MD submission authority", async (tx) => {
      const operationRow = await this.requiredRow(
        tx,
        "scientific_external_operations",
        operationId,
        "external operation",
        true,
      );
      const operation = parsePayload(ExternalOperationSchema, operationRow, "MD operation");
      const admission = await readScientificEffectAdmission(tx, operation);
      if (
        operation.id !== operationId ||
        operation.kind !== "md_stage_execution" ||
        operation.state !== "effect_started" ||
        operation.revision !== 2 ||
        operation.externalIdentity !== undefined ||
        operation.receiptId !== undefined ||
        !admission ||
        admission.claimOwner !== claimOwner ||
        admission.policyDigest !== currentPolicyDigest
      )
        throw new ScientificIntegrityError("MD submission requires its exact consumed admission");
      const workRow = await this.requiredRow(
        tx,
        "scientific_work_units",
        operation.workUnitId,
        "work unit",
        true,
      );
      const workUnit = parsePayload(WorkUnitSchema, workRow, "MD WorkUnit");
      const missionRow = await this.requiredRow(
        tx,
        "scientific_missions",
        operation.missionId,
        "mission",
        true,
      );
      const mission = parsePayload(ScientificMissionSchema, missionRow, "MD mission");
      const planRow = await this.requiredRow(tx, "scientific_plans", workUnit.planId, "plan", true);
      const plan = parsePayload(ScientificPlanSchema, planRow, "MD plan");
      // Reject index/payload divergence even if both payloads are self-consistent.
      const columns = (row: PayloadRow, expected: Record<string, unknown>): void => {
        if (Object.entries(expected).some(([key, value]) => row[key] !== value))
          throw new ScientificIntegrityError("MD submission columns differ from durable authority");
      };
      columns(operationRow, {
        id: operation.id,
        mission_id: operation.missionId,
        work_unit_id: operation.workUnitId,
        operation_kind_id: operation.kind,
        state: operation.state,
        revision: operation.revision,
        request_digest: operation.requestDigest,
        policy_digest: operation.policyDigest,
        budget_reservation_id: operation.budgetReservationId,
        receipt_id: null,
      });
      columns(workRow, {
        id: workUnit.id,
        mission_id: workUnit.missionId,
        plan_id: workUnit.planId,
        plan_version: workUnit.planVersion,
        state: workUnit.state,
        revision: workUnit.revision,
        claim_owner: workUnit.claimOwner,
        claim_expires_at: workUnit.claimExpiresAt,
        job_id: workUnit.jobId,
        attempt_id: workUnit.attemptId,
        payload_digest: digestCanonical(workUnit),
      });
      columns(missionRow, {
        id: mission.id,
        state: mission.state,
        revision: mission.revision,
        active_plan_id: mission.activePlanId,
        payload_digest: digestCanonical(mission),
      });
      columns(planRow, {
        id: plan.id,
        mission_id: plan.missionId,
        version: plan.version,
        revision: plan.revision,
        status: plan.status,
        plan_digest: plan.planDigest,
      });
      if (
        !workUnitUsesMdExecutionBinding(workUnit) ||
        workUnit.state !== "executing" ||
        workUnit.missionId !== operation.missionId ||
        workUnit.claimOwner !== claimOwner ||
        workUnit.jobId !== admission.jobId ||
        workUnit.attemptId !== admission.attemptId ||
        workUnit.revision < admission.fencingGeneration + 1 ||
        !workUnit.claimExpiresAt ||
        mission.activePlanId !== plan.id ||
        !EFFECT_COMPATIBLE_MISSION_STATES.has(mission.state) ||
        mission.terminalAt !== undefined ||
        plan.missionId !== mission.id ||
        plan.id !== admission.plan.id ||
        plan.version !== admission.plan.version ||
        plan.version !== workUnit.planVersion ||
        plan.revision !== admission.plan.revision ||
        plan.status !== "approved" ||
        plan.planDigest !== admission.plan.digest ||
        computeExactPlanDigest(plan) !== admission.plan.digest
      )
        throw new ScientificIntegrityError(
          "MD submission is outside its active admitted mission/plan/claim",
        );
      const binding = MdExecutionBindingParametersSchema.parse(
        workUnit.protocolFragment.parameters,
      );
      if (binding.plan.approvalRef !== admission.approvalId)
        throw new ScientificIntegrityError("MD submission plan approval differs from admission");
      const claims = await tx.queryRows<Record<string, unknown>>(
        `SELECT * FROM scientific_work_unit_claims WHERE work_unit_id = $1 AND active = $2${this.lockClause()}`,
        [workUnit.id, true],
      );
      const claim = claims[0];
      if (
        claims.length !== 1 ||
        !claim ||
        claim.id !== admission.claimId ||
        claim.owner_id !== claimOwner ||
        claim.expires_at !== workUnit.claimExpiresAt ||
        claim.released_at !== null ||
        claim.release_reason !== null ||
        !Number.isFinite(Date.parse(String(claim.acquired_at))) ||
        Date.parse(String(claim.acquired_at)) > Date.parse(admission.admittedAt)
      )
        throw new ScientificIntegrityError(
          "MD submission requires the original still-active claim",
        );
      const at = clock(); // Locks may have waited; never use an RPC-provided timestamp.
      if (at < startedAt || at < Date.parse(admission.admittedAt))
        throw new ScientificIntegrityError("MD submission clock precedes its durable authority");
      const evidence = await assertMdEffectAdmissionAuthority(tx, {
        operation,
        workUnit,
        currentPolicyDigest,
        at: new Date(at).toISOString(),
        provider: this.database._provider,
      });
      const approval = evidence.approvals.find((item) => item.id === admission.approvalId);
      if (
        !approval ||
        digestCanonical(approval) !== admission.approvalDigest ||
        approval.response?.id !== admission.approvalResponseId ||
        canonicalJson(approval.response.actor) !== canonicalJson(admission.approvedBy) ||
        exactPlanApprovalRole(plan) !== approval.requestedFromRole ||
        (workUnit.approvalPolicy.required &&
          workUnit.approvalPolicy.minimumRole !== approval.requestedFromRole) ||
        evidence.approvals.some(
          (item) =>
            Date.parse(item.requestedAt) > Date.parse(admission.admittedAt) ||
            Date.parse(item.response!.decidedAt) > Date.parse(admission.admittedAt),
        )
      )
        throw new ScientificIntegrityError("MD submission approval changed after admission");
      // Renewing a lease must never extend the original consumed authority.
      // Every approval (including decisions and replica set) bounds the window.
      const expiresAtMs = Math.min(
        at + 60_000,
        Date.parse(admission.claimExpiresAt),
        Date.parse(workUnit.claimExpiresAt),
        ...evidence.approvals.map((item) =>
          item.expiresAt ? Date.parse(item.expiresAt) : Infinity,
        ),
      );
      const checkedAtMs = clock(); // Includes all MD projection/evidence/approval waits.
      if (checkedAtMs < at || checkedAtMs >= expiresAtMs)
        throw new ScientificIntegrityError("MD submission authority expired while validating");
      const authority: MdSubmissionAuthority = {
        operation,
        workUnit,
        mission,
        admission,
        ...evidence,
        checkedAt: new Date(checkedAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
      const value = await body(authority, tx);
      const preparedAt = clock();
      if (preparedAt < checkedAtMs || preparedAt >= expiresAtMs)
        throw new ScientificIntegrityError("MD submission authority expired during preparation");
      return { authority: { ...authority, checkedAt: new Date(preparedAt).toISOString() }, value };
    });
    // Commit ACK can itself be delayed. Never return an already-expired snapshot.
    const committedAt = clock();
    if (
      committedAt < Date.parse(result.authority.checkedAt) ||
      committedAt >= Date.parse(result.authority.expiresAt)
    )
      throw new ScientificIntegrityError("MD submission authority expired before delivery");
    return {
      ...result,
      authority: { ...result.authority, checkedAt: new Date(committedAt).toISOString() },
    };
  }

  async beginWorkUnitEffect(input: BeginWorkUnitEffectInput): Promise<BeginWorkUnitEffectResult> {
    return this.inTransaction("begin work-unit effect", async (transaction) => {
      const operationRow = await this.requiredRow(
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
      const workRow = await this.requiredRow(
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
        throw new ScientificIntegrityError(
          "Effect boundary authority does not match durable state",
          {
            operationId: operation.id,
            workUnitId: workUnit.id,
            expectedClaimOwner: workUnit.claimOwner,
            actualClaimOwner: input.claimOwner,
          },
        );
      }
      if (!workUnit.claimExpiresAt || Date.parse(workUnit.claimExpiresAt) <= Date.parse(input.at)) {
        throw new ScientificEntityConflictError(
          "work-unit claim",
          workUnit.id,
          "lease expired before the effect boundary",
        );
      }
      const missionRow = await this.requiredRow(
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
          this.database._provider,
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
          this.database._provider,
        );
      }

      const planRows = await transaction.queryRows<PayloadRow & { plan_digest: string }>(
        `SELECT payload_json, plan_digest FROM scientific_plans WHERE id = $1${this.lockClause()}`,
        [workUnit.planId],
      );
      const planRow = planRows[0];
      if (!planRow) throw new ScientificEntityNotFoundError("scientific plan", workUnit.planId);
      const plan = parsePayload(
        ScientificPlanSchema,
        planRow,
        `Scientific plan ${workUnit.planId}`,
      );
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
         ORDER BY requested_at DESC, id DESC LIMIT 1${this.lockClause()}`,
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
      const responseRow = await this.requiredRow(
        transaction,
        "scientific_approval_responses",
        approval.response.id,
        "approval response",
        true,
      );
      const response = parsePayload(
        ApprovalResponseSchema,
        responseRow,
        "Effect approval response",
      );
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
          provider: this.database._provider,
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
             ORDER BY requested_at DESC, id DESC LIMIT 1${this.lockClause()}`,
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
          const operationResponseRow = (await this.requiredRow(
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
          `SELECT payload_json FROM scientific_evidence WHERE id = $1${this.lockClause()}`,
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
         WHERE work_unit_id = $1 AND active = $2${this.lockClause()}`,
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
        throw new ScientificIntegrityError(
          "Effect admission requires the exact active claim record",
        );
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

  async reconcileWorkUnitEffect(
    input: ReconcileWorkUnitEffectInput,
  ): Promise<ReconcileWorkUnitEffectResult> {
    return this.inTransaction("reconcile work-unit effect", async (transaction) => {
      const operationRow = await this.requiredRow(
        transaction,
        "scientific_external_operations",
        input.operationId,
        "external operation",
      );
      const operation = parsePayload(
        ExternalOperationSchema,
        operationRow,
        `External operation ${input.operationId}`,
      );
      if (operation.workUnitId !== input.workUnitId) {
        throw new ScientificIntegrityError("External operation targets a different work unit", {
          operationId: operation.id,
          expectedWorkUnitId: input.workUnitId,
          actualWorkUnitId: operation.workUnitId,
        });
      }
      const requiredOperationState = expectedOperationState(input.outcome);
      if (operation.state !== requiredOperationState || !operation.receiptId) {
        throw new ScientificIntegrityError(
          `Effect reconciliation requires a ${requiredOperationState} operation with a receipt`,
          { operationId: operation.id, operationState: operation.state },
        );
      }

      const receiptRow = await this.requiredRow(
        transaction,
        "scientific_operation_receipts",
        operation.receiptId,
        "operation receipt",
      );
      const receipt = parsePayload(
        OperationReceiptSchema,
        receiptRow,
        `Operation receipt ${operation.receiptId}`,
      );
      if (
        receipt.operationId !== operation.id ||
        receipt.requestDigest !== operation.requestDigest
      ) {
        throw new ScientificIntegrityError("Operation receipt is not bound to the exact request", {
          operationId: operation.id,
          receiptId: receipt.id,
        });
      }
      if (
        (input.outcome === "completed" && receipt.status !== "confirmed") ||
        (input.outcome !== "completed" && receipt.status !== "failed")
      ) {
        throw new ScientificIntegrityError(
          "Operation receipt status does not match the effect outcome",
          {
            operationId: operation.id,
            receiptStatus: receipt.status,
            outcome: input.outcome,
          },
        );
      }
      let identity = {
        ...requestedEffectIdentity(operation),
        ...effectIdentity(operation.externalIdentity),
        ...effectIdentity(receipt.externalIdentity),
        ...(receipt.jobId ? { jobId: receipt.jobId } : {}),
        ...(receipt.attemptId ? { attemptId: receipt.attemptId } : {}),
      };
      if (operation.kind === "md_stage_execution") {
        const admission = await readScientificEffectAdmission(transaction, operation);
        const exact = mdStageEffectIdentity(operation);
        if (!admission || receipt.jobId !== exact.jobId || receipt.attemptId !== exact.attemptId) {
          throw new ScientificIntegrityError(
            "MD reconciliation requires its consumed admission and exact receipt identity",
          );
        }
        // An external scheduler identity may supplement, never replace, the
        // internal job/attempt derived from the immutable scientific intent.
        for (const candidate of [operation.externalIdentity, receipt.externalIdentity]) {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
          for (const key of ["jobId", "attemptId"] as const) {
            if (Object.hasOwn(candidate, key) && candidate[key] !== exact[key]) {
              throw new ScientificIntegrityError("MD external identity conflicts with admission");
            }
          }
        }
        identity = exact;
      }
      if (identity.jobId !== input.jobId || identity.attemptId !== input.attemptId) {
        throw new ScientificIntegrityError("Effect identity does not match the canonical receipt", {
          operationId: operation.id,
          expectedJobId: input.jobId,
          expectedAttemptId: input.attemptId,
          actualJobId: identity.jobId,
          actualAttemptId: identity.attemptId,
        });
      }

      const workRow = await this.requiredRow(
        transaction,
        "scientific_work_units",
        input.workUnitId,
        "work unit",
      );
      const current = parsePayload(WorkUnitSchema, workRow, `Work unit ${input.workUnitId}`);
      if (current.missionId !== operation.missionId) {
        throw new ScientificIntegrityError("Operation and work unit cross a mission boundary", {
          operationId: operation.id,
          workUnitId: current.id,
        });
      }
      if (
        (current.jobId && current.jobId !== input.jobId) ||
        (current.attemptId && current.attemptId !== input.attemptId)
      ) {
        throw new ScientificIntegrityError("Work unit effect identity conflicts with the receipt", {
          workUnitId: current.id,
          currentJobId: current.jobId,
          currentAttemptId: current.attemptId,
          receiptJobId: input.jobId,
          receiptAttemptId: input.attemptId,
        });
      }

      const path = transitionPath(current.state, input.outcome, input.retryable === true);
      let logicalState = current.state;
      for (const nextState of path) {
        assertScientificTransition("work_unit", logicalState, nextState);
        logicalState = nextState;
      }
      if (path.length === 0) {
        return {
          workUnit: current,
          operation,
          receipt,
          transitionedThrough: [],
          alreadyReconciled: true,
        };
      }

      const finalState = path[path.length - 1]!;
      const releasesClaim = !["claimed", "executing", "observing"].includes(finalState);
      const next = WorkUnitSchema.parse({
        ...current,
        state: finalState,
        revision: current.revision + path.length,
        claimOwner: releasesClaim ? null : current.claimOwner,
        claimExpiresAt: releasesClaim ? null : current.claimExpiresAt,
        jobId: input.jobId,
        attemptId: input.attemptId,
        updatedAt: input.at,
      });
      const changed = await transaction.queryRows<{ id: string }>(
        `UPDATE scientific_work_units
         SET state = $1, revision = $2, claim_owner = $3, claim_expires_at = $4,
             job_id = $5, attempt_id = $6, payload_digest = $7, payload_json = $8,
             updated_at = $9
         WHERE id = $10 AND revision = $11 AND state = $12 RETURNING id`,
        [
          next.state,
          next.revision,
          next.claimOwner,
          next.claimExpiresAt,
          next.jobId,
          next.attemptId,
          digestCanonical(next),
          canonicalJson(next),
          next.updatedAt,
          next.id,
          current.revision,
          current.state,
        ],
      );
      if (changed.length === 0) {
        throw new ScientificRevisionConflictError(
          "work unit",
          current.id,
          current.revision,
          current.revision + 1,
        );
      }
      if (releasesClaim && current.claimOwner) {
        await transaction.query(
          `UPDATE scientific_work_unit_claims
           SET active = $1, released_at = $2, release_reason = $3
           WHERE work_unit_id = $4 AND active = $5`,
          [false, input.at, `effect_reconciled:${operation.id}:${input.outcome}`, current.id, true],
        );
      }
      return {
        workUnit: next,
        operation,
        receipt,
        transitionedThrough: path,
        alreadyReconciled: false,
      };
    });
  }

  private async inTransaction<T>(
    operation: string,
    body: (transaction: ScientificTransaction) => Promise<T>,
  ): Promise<T> {
    const transaction = (await this.database.beginTransaction()) as ScientificTransaction;
    if (!transaction.queryRows) {
      await transaction.rollback();
      throw new ScientificStoreUnsupportedDatabaseError(this.database._provider);
    }
    try {
      const result = await body(transaction);
      await transaction.commit();
      return result;
    } catch (error) {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        throw new ScientificIntegrityError(`${operation} failed and rollback also failed`, {
          cause: error instanceof Error ? error.message : String(error),
          rollback: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      }
      throw error;
    }
  }

  private async requiredRow(
    transaction: ScientificTransaction,
    table: string,
    id: string,
    label: string,
    lock = false,
  ): Promise<PayloadRow> {
    if (!/^[a-z_]+$/u.test(table)) {
      throw new ScientificIntegrityError("Unsafe internal table identifier", { table });
    }
    const rows = await transaction.queryRows<PayloadRow>(
      `SELECT * FROM ${table} WHERE id = $1${lock ? this.lockClause() : ""}`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new ScientificEntityNotFoundError(label, id);
    if (rows.length > 1) {
      throw new ScientificEntityConflictError(label, id, "multiple rows share a unique identifier");
    }
    return row;
  }

  private lockClause(): string {
    return this.database._provider === "postgres" ? " FOR UPDATE" : "";
  }
}
