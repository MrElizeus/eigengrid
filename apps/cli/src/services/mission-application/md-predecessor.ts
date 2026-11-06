import { MissionApplicationError } from "./contracts";

/** New MD phases may activate only after their exact previous plan is closed. */
export function assertCompletedMdPredecessor(input: {
  state: string;
  activePlanId: string;
  parentPlanId?: string;
  workUnits: readonly { id: string; planId: string; state: string }[];
  operations: readonly { workUnitId: string; state: string }[];
  plans?: readonly {
    id: string;
    parentPlanId?: string;
    version: number;
    revision: number;
    planDigest: string;
  }[];
  approvals?: readonly {
    subjectType: string;
    subjectId: string;
    subjectVersion: number;
    subjectRevision: number;
    payloadDigest: string;
    state: string;
  }[];
}): void {
  const predecessorIds = new Set([input.activePlanId]);
  let ancestorId = input.parentPlanId;
  while (ancestorId && ancestorId !== input.activePlanId) {
    const ancestor = input.plans?.find((plan) => plan.id === ancestorId);
    const rejected =
      ancestor &&
      input.approvals?.some(
        (approval) =>
          approval.subjectType === "plan" &&
          approval.subjectId === ancestor.id &&
          approval.subjectVersion === ancestor.version &&
          approval.subjectRevision === ancestor.revision &&
          approval.payloadDigest === ancestor.planDigest &&
          approval.state === "rejected",
      );
    if (
      !ancestor ||
      !rejected ||
      predecessorIds.has(ancestorId) ||
      input.workUnits.some((work) => work.planId === ancestorId)
    )
      break;
    predecessorIds.add(ancestorId);
    ancestorId = ancestor.parentPlanId;
  }
  const units = input.workUnits.filter((work) => predecessorIds.has(work.planId));
  const ids = new Set(units.map((work) => work.id));
  if (
    input.state !== "awaiting_approval" ||
    ancestorId !== input.activePlanId ||
    units.some((work) => !["succeeded", "cancelled"].includes(work.state)) ||
    input.operations.some(
      (operation) =>
        ids.has(operation.workUnitId) && !["confirmed", "abandoned"].includes(operation.state),
    )
  )
    throw new MissionApplicationError(
      "CONFLICT",
      "MD successor requires its exact completed preparation plan and no live predecessor effects",
    );
}
