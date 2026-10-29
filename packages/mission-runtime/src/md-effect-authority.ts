import {
  ApprovalRequestSchema,
  ApprovalResponseSchema,
  BudgetReservationSchema,
  EvidenceReferenceSchema,
  ExternalOperationSchema,
  DigestSchema,
  MdExecutionBindingParametersSchema,
  MdStageOperationRequestSchema,
  MissionBudgetSchema,
  TimestampSchema,
  assertMdStageSpecDigest,
  assertMdWorkflowProtocolDigest,
  canonicalJson,
  digestCanonical,
  type ExternalOperation,
  type ApprovalRequest,
  type MdStageSpec,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import { ScientificIntegrityError } from "./errors";
import {
  assertMdStageOperationRequestAuthority,
  assertMdWorkUnitProjectionBinding,
  assertMdWorkUnitProjectionDependencies,
} from "./md-projection-store";
import type { ScientificTransaction } from "./types";

/** Internal identities derive from the immutable operation, not Slurm JobID,
 * an RPC nonce, lease owner or caller-provided additions to the closed MD request.
 * A new scientific attempt requires a distinct durable operation; replay does not.
 */
export function mdStageEffectIdentity(value: ExternalOperation): {
  jobId: string;
  attemptId: string;
} {
  const operation = ExternalOperationSchema.parse(value);
  const request = MdStageOperationRequestSchema.parse(operation.request);
  if (
    operation.kind !== "md_stage_execution" ||
    request.workUnitId !== operation.workUnitId ||
    operation.requestDigest !== digestCanonical(request)
  ) {
    throw new ScientificIntegrityError(
      "MD effect identity requires the exact immutable stage intent",
    );
  }
  const token = digestCanonical({
    schemaVersion: "eigengrid.md-effect-identity/v1",
    operationId: operation.id,
    missionId: operation.missionId,
    workUnitId: operation.workUnitId,
    requestDigest: operation.requestDigest,
  });
  return { jobId: `job-md-${token}`, attemptId: `attempt-md-${token}` };
}

type PayloadRow = { payload_json: string } & Record<string, unknown>;

export interface MdEffectAuthorityEvidence {
  approvals: ApprovalRequest[];
  stage: MdStageSpec;
}

function assertColumnsMatch(
  row: Record<string, unknown>,
  expected: Record<string, unknown>,
  entity: string,
): void {
  if (Object.entries(expected).some(([key, value]) => row[key] !== value)) {
    throw new ScientificIntegrityError(
      `MD ${entity} columns diverge from the authoritative payload`,
    );
  }
}

/** Caller owns the SAME transaction as admission and holds mission/plan/WorkUnit
 * locks. This authorizes a new effect, not historical readability or result QC.
 * Every exact MD approval is locked and revalidated at the current effect time.
 */
export async function assertMdEffectAdmissionAuthority(
  tx: ScientificTransaction,
  input: {
    operation: ExternalOperation;
    workUnit: WorkUnit;
    currentPolicyDigest: string;
    at: string;
    provider: string;
  },
): Promise<MdEffectAuthorityEvidence> {
  const { operation, workUnit } = input;
  TimestampSchema.parse(input.at);
  DigestSchema.parse(input.currentPolicyDigest);
  const binding = MdExecutionBindingParametersSchema.parse(workUnit.protocolFragment.parameters);
  const request = assertMdStageOperationRequestAuthority(workUnit, operation.request);
  if (operation.kind !== "md_stage_execution" || request.stage.kind !== binding.stage.kind)
    throw new ScientificIntegrityError("New MD effects require their explicit exact stage kind");
  const lock = input.provider === "postgres" ? " FOR UPDATE" : "";
  if (!operation.budgetReservationId)
    throw new ScientificIntegrityError(
      "MD effect requires a durable external-operation reservation",
    );
  const [reservationRow] = await tx.queryRows<PayloadRow & { budget_payload_json: string }>(
    `SELECT reservation.*, budget.payload_json AS budget_payload_json,
            budget.payload_digest AS budget_payload_digest
     FROM scientific_budget_reservations AS reservation
     JOIN scientific_mission_budgets AS budget ON budget.id = reservation.budget_id
     WHERE reservation.id = $1 AND budget.mission_id = $2${lock}`,
    [operation.budgetReservationId, workUnit.missionId],
  );
  if (!reservationRow)
    throw new ScientificIntegrityError("MD effect budget reservation is missing");
  const reservation = BudgetReservationSchema.parse(JSON.parse(reservationRow.payload_json));
  const budget = MissionBudgetSchema.parse(JSON.parse(reservationRow.budget_payload_json));
  const aggregateReservations = budget.reservations.filter((item) => item.id === reservation.id);
  assertColumnsMatch(
    reservationRow,
    {
      id: reservation.id,
      budget_id: budget.id,
      kind: reservation.kind,
      amount: reservation.amount,
      state: reservation.state,
      work_unit_id: reservation.workUnitId,
      operation_id: reservation.operationId,
      created_at: reservation.createdAt,
      updated_at: reservation.updatedAt,
      budget_payload_digest: digestCanonical(budget),
    },
    "budget reservation",
  );
  if (
    reservation.id !== operation.budgetReservationId ||
    reservation.state !== "reserved" ||
    reservationRow.state !== "reserved" ||
    reservation.kind !== "external_operation" ||
    reservation.amount !== 1 ||
    reservation.workUnitId !== workUnit.id ||
    reservation.operationId !== operation.id ||
    reservationRow.work_unit_id !== workUnit.id ||
    reservationRow.operation_id !== operation.id ||
    budget.missionId !== workUnit.missionId ||
    aggregateReservations.length !== 1 ||
    canonicalJson(aggregateReservations[0]) !== canonicalJson(reservation) ||
    Date.parse(reservation.createdAt) > Date.parse(input.at)
  ) {
    throw new ScientificIntegrityError("MD effect budget is not its exact live reservation");
  }
  return assertMdWorkUnitScientificAuthority(tx, {
    workUnit,
    request,
    currentPolicyDigest: input.currentPolicyDigest,
    at: input.at,
    provider: input.provider,
  });
}

/** Exact scientific authority shared by pre-admission preparation and admission.
 * This performs no reservation, admission, command rendering or external effect.
 * The caller holds mission, plan and WorkUnit locks in the same transaction.
 */
export async function assertMdWorkUnitScientificAuthority(
  tx: ScientificTransaction,
  input: {
    workUnit: WorkUnit;
    request: unknown;
    currentPolicyDigest: string;
    at: string;
    provider: string;
  },
): Promise<MdEffectAuthorityEvidence> {
  const { workUnit } = input;
  TimestampSchema.parse(input.at);
  DigestSchema.parse(input.currentPolicyDigest);
  const binding = MdExecutionBindingParametersSchema.parse(workUnit.protocolFragment.parameters);
  const request = assertMdStageOperationRequestAuthority(workUnit, input.request);
  if (request.stage.kind !== binding.stage.kind)
    throw new ScientificIntegrityError("MD preparation requires its explicit exact stage kind");
  const lock = input.provider === "postgres" ? " FOR UPDATE" : "";
  const references = new Set([
    binding.plan.approvalRef,
    binding.system.approvalRef,
    binding.protocol.approvalRef,
    ...binding.decisions.map((decision) => decision.approvalRef),
  ]);
  // The current approved protocol may explicitly ratify the historical policy
  // of its exact frozen preparation decisions. No other approval can inherit it.
  const [protocolRow] = await tx.queryRows<PayloadRow>(
    `SELECT payload_json FROM scientific_md_protocols WHERE id = $1 AND revision = $2${lock}`,
    [binding.protocol.id, binding.protocol.revision],
  );
  if (!protocolRow) throw new ScientificIntegrityError("MD protocol is missing");
  const protocol = assertMdWorkflowProtocolDigest(JSON.parse(protocolRow.payload_json));
  if (
    protocol.protocolDigest !== binding.protocol.digest ||
    protocol.missionId !== workUnit.missionId
  )
    throw new ScientificIntegrityError(
      "MD preparation policy handoff protocol differs from binding",
    );
  const decisionPolicies = new Map(
    binding.decisions.map((decision) => [
      decision.approvalRef,
      protocol.preparationPolicyDigest ?? input.currentPolicyDigest,
    ]),
  );
  if (binding.replicaSegment) {
    const segment = binding.replicaSegment;
    const approvals = await tx.queryRows<{ id: string }>(
      `SELECT id FROM scientific_approval_requests
       WHERE mission_id = $1 AND subject_type = 'replica_set' AND subject_id = $2
         AND subject_version = $3 AND subject_revision = $3 AND payload_digest = $4
         AND state = 'approved' ORDER BY id${lock}`,
      [
        workUnit.missionId,
        segment.replicaSetId,
        segment.replicaSetRevision,
        segment.replicaSetDigest,
      ],
    );
    if (approvals.length !== 1)
      throw new ScientificIntegrityError("MD effect requires one exact replica-set approval");
    references.add(approvals[0]!.id);
  }
  const verifiedApprovals: ApprovalRequest[] = [];
  for (const id of [...references].sort()) {
    const expectedPolicy = decisionPolicies.get(id) ?? input.currentPolicyDigest;
    const [row] = await tx.queryRows<PayloadRow>(
      `SELECT * FROM scientific_approval_requests WHERE id = $1${lock}`,
      [id],
    );
    if (!row) throw new ScientificIntegrityError("MD effect approval is missing");
    const approval = ApprovalRequestSchema.parse(JSON.parse(row.payload_json));
    assertColumnsMatch(
      row,
      {
        id: approval.id,
        mission_id: approval.missionId,
        subject_type: approval.subjectType,
        subject_id: approval.subjectId,
        subject_version: approval.subjectVersion,
        subject_revision: approval.subjectRevision,
        state: approval.state,
        requested_from_role: approval.requestedFromRole,
        payload_digest: approval.payloadDigest,
        policy_digest: approval.policyDigest,
        requested_at: approval.requestedAt,
        expires_at: approval.expiresAt ?? null,
      },
      "approval",
    );
    if (
      approval.id !== id ||
      approval.missionId !== workUnit.missionId ||
      approval.state !== "approved" ||
      approval.policyDigest !== expectedPolicy ||
      !approval.response ||
      (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.parse(input.at)) ||
      Date.parse(approval.requestedAt) > Date.parse(input.at)
    ) {
      throw new ScientificIntegrityError(
        "MD effect approval is expired, revoked or outside current policy",
      );
    }
    const [responseRow] = await tx.queryRows<PayloadRow>(
      `SELECT * FROM scientific_approval_responses WHERE id = $1${lock}`,
      [approval.response.id],
    );
    if (!responseRow) throw new ScientificIntegrityError("MD effect human response is missing");
    const response = ApprovalResponseSchema.parse(JSON.parse(responseRow.payload_json));
    assertColumnsMatch(
      responseRow,
      {
        id: response.id,
        approval_request_id: response.approvalRequestId,
        decision: response.decision,
        actor_id: response.actor.id,
        role: response.role,
        subject_version: response.subjectVersion,
        subject_revision: response.subjectRevision,
        payload_digest: response.payloadDigest,
        policy_digest: response.policyDigest,
        decided_at: response.decidedAt,
      },
      "approval response",
    );
    if (
      canonicalJson(response) !== canonicalJson(approval.response) ||
      response.approvalRequestId !== approval.id ||
      response.decision !== "approved" ||
      response.actor.kind !== "human" ||
      response.actor.role !== approval.requestedFromRole ||
      response.role !== approval.requestedFromRole ||
      response.policyDigest !== expectedPolicy ||
      response.subjectVersion !== approval.subjectVersion ||
      response.subjectRevision !== approval.subjectRevision ||
      response.payloadDigest !== approval.payloadDigest ||
      Date.parse(response.decidedAt) > Date.parse(input.at)
    ) {
      throw new ScientificIntegrityError(
        "MD effect requires its exact current durable human decision",
      );
    }
    verifiedApprovals.push(approval);
  }
  // Reuse canonical compiler/projection checks: exact plan, system, protocol,
  // capability, stage, decisions, seed schedule and scientifically accepted parent.
  await assertMdWorkUnitProjectionBinding(tx, workUnit);
  await assertMdWorkUnitProjectionDependencies(tx, workUnit);

  const [stageRow] = await tx.queryRows<PayloadRow>(
    `SELECT payload_json FROM scientific_md_stage_specs
     WHERE id = $1 AND revision = $2 AND protocol_id = $3 AND protocol_revision = $4${lock}`,
    [binding.stage.id, binding.stage.revision, binding.protocol.id, binding.protocol.revision],
  );
  if (!stageRow) throw new ScientificIntegrityError("MD effect stage is missing");
  const stage = assertMdStageSpecDigest(JSON.parse(stageRow.payload_json));
  if (stage.stageDigest !== request.stage.digest)
    throw new ScientificIntegrityError("MD effect stage changed during admission");
  const expectedArtifacts = stage.inputs.filter((artifact) => artifact.role !== "parent_restart");
  if (binding.parentRestart) expectedArtifacts.push(binding.parentRestart);
  const expected = new Map<string, string>();
  for (const artifact of expectedArtifacts) {
    if (
      expected.has(artifact.evidenceRef) &&
      expected.get(artifact.evidenceRef) !== artifact.contentDigest
    )
      throw new ScientificIntegrityError(
        "MD inputs assign contradictory digests to one evidence ID",
      );
    expected.set(artifact.evidenceRef, artifact.contentDigest);
    if (!workUnit.inputRefs.includes(artifact.evidenceRef))
      throw new ScientificIntegrityError("MD effect input is outside its WorkUnit");
  }
  for (const id of [...new Set(workUnit.inputRefs)].sort()) {
    const [row] = await tx.queryRows<PayloadRow>(
      `SELECT * FROM scientific_evidence WHERE id = $1${lock}`,
      [id],
    );
    if (!row) throw new ScientificIntegrityError("MD effect input evidence is missing");
    const evidence = EvidenceReferenceSchema.parse(JSON.parse(row.payload_json));
    assertColumnsMatch(
      row,
      {
        id: evidence.id,
        mission_id: evidence.missionId,
        content_digest: evidence.contentDigest,
        uri: evidence.uri,
        immutable: input.provider === "postgres" ? evidence.immutable : Number(evidence.immutable),
        created_at: evidence.createdAt,
      },
      "input evidence",
    );
    if (
      evidence.id !== id ||
      evidence.missionId !== workUnit.missionId ||
      !evidence.immutable ||
      (expected.has(id) && evidence.contentDigest !== expected.get(id))
    ) {
      throw new ScientificIntegrityError("MD effect input is not exact immutable mission evidence");
    }
  }
  return { approvals: verifiedApprovals, stage };
}
