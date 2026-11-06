import {
  DigestSchema,
  ExternalOperationSchema,
  IdSchema,
  MdExecutionBindingParametersSchema,
  ScientificMissionSchema,
  ScientificPlanSchema,
  WorkUnitSchema,
  canonicalJson,
  digestCanonical,
} from "@eigengrid/scientific-schema";
import { ScientificIntegrityError } from "../errors";
import { assertMdEffectAdmissionAuthority } from "../md-effect-authority";
import { workUnitUsesMdExecutionBinding } from "../md-projection-store";
import { readScientificEffectAdmission } from "../operation-outbox";
import type { ScientificTransaction } from "../types";
import { EffectReconciliationContext } from "./context";
import { type MdSubmissionAuthority, type MdSubmissionAuthorityInput } from "./contracts";
import { type PayloadRow, parsePayload } from "./payload";
import {
  EFFECT_COMPATIBLE_MISSION_STATES,
  computeExactPlanDigest,
  exactPlanApprovalRole,
} from "./system-preparation";

export async function withMdSubmissionAuthority<T>(
  store: EffectReconciliationContext,
  input: MdSubmissionAuthorityInput,
  body: (authority: MdSubmissionAuthority, tx: ScientificTransaction) => Promise<T>,
): Promise<{ authority: MdSubmissionAuthority; value: T }> {
  const operationId = IdSchema.parse(input.operationId);
  const claimOwner = IdSchema.parse(input.claimOwner);
  const currentPolicyDigest = DigestSchema.parse(input.currentPolicyDigest);
  const clock = (): number => {
    const value = store.now().getTime();
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new ScientificIntegrityError("Invalid live MD submission clock");
    return value;
  };
  const startedAt = clock();
  const result = await store.inTransaction("read MD submission authority", async (tx) => {
    const operationRow = await store.requiredRow(
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
    const workRow = await store.requiredRow(
      tx,
      "scientific_work_units",
      operation.workUnitId,
      "work unit",
      true,
    );
    const workUnit = parsePayload(WorkUnitSchema, workRow, "MD WorkUnit");
    const missionRow = await store.requiredRow(
      tx,
      "scientific_missions",
      operation.missionId,
      "mission",
      true,
    );
    const mission = parsePayload(ScientificMissionSchema, missionRow, "MD mission");
    const planRow = await store.requiredRow(tx, "scientific_plans", workUnit.planId, "plan", true);
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
    const binding = MdExecutionBindingParametersSchema.parse(workUnit.protocolFragment.parameters);
    if (binding.plan.approvalRef !== admission.approvalId)
      throw new ScientificIntegrityError("MD submission plan approval differs from admission");
    const claims = await tx.queryRows<Record<string, unknown>>(
      `SELECT * FROM scientific_work_unit_claims WHERE work_unit_id = $1 AND active = $2${store.lockClause()}`,
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
      throw new ScientificIntegrityError("MD submission requires the original still-active claim");
    const at = clock(); // Locks may have waited; never use an RPC-provided timestamp.
    if (at < startedAt || at < Date.parse(admission.admittedAt))
      throw new ScientificIntegrityError("MD submission clock precedes its durable authority");
    const evidence = await assertMdEffectAdmissionAuthority(tx, {
      operation,
      workUnit,
      currentPolicyDigest,
      at: new Date(at).toISOString(),
      provider: store.database._provider,
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
      ...evidence.approvals.map((item) => (item.expiresAt ? Date.parse(item.expiresAt) : Infinity)),
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
