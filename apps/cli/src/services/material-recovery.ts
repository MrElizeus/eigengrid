import { digestCanonical } from "@eigengrid/scientific-schema";
import type { MissionProvenance } from "@eigengrid/mission-runtime";
import {
  AmberMaterialRequestSchema,
  assertMaterialPublicationRequest,
  materialOperationIdentity,
} from "./amber-material-publication";

export interface MaterialRecoveryRecord {
  actorId: string;
  projectId: string;
  expectedRevision: number;
  request: unknown;
}

/** Identify only the already-confirmed effect of this authenticated owner's exact execute request.
 * This never admits an intent or authorizes a replacement operation.
 */
export function confirmedMaterialRecovery(
  record: MaterialRecoveryRecord,
  provenance: MissionProvenance,
  currentPolicyDigest: string,
) {
  const parsed = AmberMaterialRequestSchema.safeParse(record.request);
  if (!parsed.success || parsed.data.action !== "execute") return null;
  const input = parsed.data;
  const mission = provenance.mission;
  if (
    !Number.isSafeInteger(record.expectedRevision) ||
    record.expectedRevision < 1 ||
    record.expectedRevision > mission.revision ||
    input.projectId !== record.projectId ||
    mission.id !== input.missionId ||
    mission.requestedBy.id !== record.actorId ||
    mission.requestedBy.kind !== "human" ||
    mission.activePlanId !== input.planId
  )
    return null;
  const unit = provenance.workUnits.find(
    (item) =>
      item.id === input.workUnitId &&
      item.missionId === input.missionId &&
      item.planId === input.planId,
  );
  if (!unit || !["executing", "observing", "succeeded"].includes(unit.state)) return null;
  let identity;
  try {
    identity = materialOperationIdentity(unit);
  } catch {
    return null;
  }
  const operation = provenance.operations.find((item) => item.id === identity.operationId);
  if (
    !operation ||
    operation.state !== "confirmed" ||
    operation.kind !== "system_preparation" ||
    operation.workUnitId !== unit.id ||
    operation.missionId !== mission.id ||
    operation.receiptId !== `receipt-${operation.id}` ||
    operation.policyDigest !== currentPolicyDigest
  )
    return null;
  let request;
  try {
    request = assertMaterialPublicationRequest(unit, operation.request);
  } catch {
    return null;
  }
  if (digestCanonical(request) !== operation.requestDigest) return null;
  const receipt = provenance.receipts.find((item) => item.id === operation.receiptId);
  const publisher = "eigengrid-frozen-amber-material-adoption/v1";
  if (
    !receipt ||
    receipt.status !== "confirmed" ||
    receipt.operationId !== operation.id ||
    receipt.requestDigest !== operation.requestDigest ||
    receipt.jobId !== identity.jobId ||
    receipt.attemptId !== identity.attemptId ||
    receipt.detailDigest !==
      digestCanonical({ request, verifiedInputs: unit.inputRefs, publisher }) ||
    operation.externalIdentity?.publisher !== publisher ||
    operation.externalIdentity?.requestDigest !== operation.requestDigest ||
    receipt.externalIdentity?.publisher !== publisher ||
    receipt.externalIdentity?.requestDigest !== operation.requestDigest
  )
    return null;
  const approval = provenance.approvals.find((item) => item.id === `approval-${operation.id}`);
  const response = approval?.response;
  if (
    !approval ||
    approval.state !== "approved" ||
    approval.missionId !== mission.id ||
    approval.subjectType !== "operation" ||
    approval.subjectVersion !== 1 ||
    approval.subjectRevision !== 1 ||
    approval.requestedBy.id !== record.actorId ||
    approval.requestedFromRole !== unit.approvalPolicy.minimumRole ||
    approval.subjectId !== operation.id ||
    approval.payloadDigest !== operation.requestDigest ||
    approval.policyDigest !== operation.policyDigest ||
    !response ||
    response.decision !== "approved" ||
    response.approvalRequestId !== approval.id ||
    response.actor.kind !== "human" ||
    response.role !== unit.approvalPolicy.minimumRole ||
    response.subjectVersion !== approval.subjectVersion ||
    response.subjectRevision !== approval.subjectRevision ||
    response.payloadDigest !== approval.payloadDigest ||
    response.policyDigest !== approval.policyDigest ||
    Date.parse(response.decidedAt) > Date.parse(receipt.recordedAt) ||
    (approval.expiresAt !== undefined &&
      Date.parse(receipt.recordedAt) >= Date.parse(approval.expiresAt))
  )
    return null;
  return { input, unit, operation, receipt };
}

/** Complete publication observations can reconstruct an explicit canonical recovery response. */
export function observeConfirmedMaterialExecution(
  record: MaterialRecoveryRecord,
  provenance: MissionProvenance,
  currentPolicyDigest: string,
) {
  const exact = confirmedMaterialRecovery(record, provenance, currentPolicyDigest);
  if (!exact || exact.unit.state !== "succeeded") return null;
  for (const kind of exact.unit.outputContract.requiredObservationKinds)
    if (
      !provenance.observations.some(
        (item) =>
          item.workUnitId === exact.unit.id &&
          item.type === kind &&
          item.payload.status === "passed",
      )
    )
      return null;
  return {
    status: "confirmed_material_publication",
    workUnitId: exact.unit.id,
    operationId: exact.operation.id,
    receiptId: exact.receipt.id,
    requestDigest: exact.operation.requestDigest,
  };
}

/** Host composition supplies only confirmed-projection recovery, never an admission or submit port. */
export async function repairConfirmedMaterialProjection(
  record: MaterialRecoveryRecord,
  currentPolicyDigest: string,
  ports: {
    assertCurrent(): Promise<void>;
    assertAccess(address: { projectId: string; missionId: string }): Promise<unknown>;
    provenance(missionId: string): Promise<MissionProvenance>;
    assertApproval(approvalId: string, at: string, policyDigest: string): Promise<unknown>;
    reconcile(
      operation: NonNullable<ReturnType<typeof confirmedMaterialRecovery>>["operation"],
    ): Promise<unknown>;
  },
) {
  const parsed = AmberMaterialRequestSchema.safeParse(record.request);
  if (!parsed.success || parsed.data.action !== "execute") return null;
  const input = parsed.data;
  await ports.assertCurrent();
  await ports.assertAccess({ projectId: record.projectId, missionId: input.missionId });
  const exact = confirmedMaterialRecovery(
    record,
    await ports.provenance(input.missionId),
    currentPolicyDigest,
  );
  if (!exact) return null;
  if (exact.unit.state !== "succeeded") {
    await ports.assertApproval(
      `approval-${exact.operation.id}`,
      exact.receipt.recordedAt,
      currentPolicyDigest,
    );
    await ports.assertCurrent();
    await ports.reconcile(exact.operation);
  }
  await ports.assertCurrent();
  await ports.assertAccess({ projectId: record.projectId, missionId: input.missionId });
  return observeConfirmedMaterialExecution(
    record,
    await ports.provenance(input.missionId),
    currentPolicyDigest,
  );
}
