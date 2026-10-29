import type {
  ApprovalState,
  ExternalOperationState,
  MissionState,
  PlanStatus,
  WorkUnitState,
} from "./schemas";

export type ScientificAggregateKind = "mission" | "plan" | "work_unit" | "approval" | "operation";

export class IllegalScientificTransitionError extends Error {
  readonly code = "ILLEGAL_SCIENTIFIC_TRANSITION";

  constructor(
    public readonly aggregate: ScientificAggregateKind,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Illegal ${aggregate} transition: ${from} -> ${to}`);
    this.name = "IllegalScientificTransitionError";
  }
}

const missionTransitions = {
  created: ["scoping", "paused", "blocked", "failed", "cancel_requested"],
  scoping: ["planning", "awaiting_approval", "paused", "blocked", "failed", "cancel_requested"],
  planning: ["awaiting_approval", "ready", "paused", "blocked", "failed", "cancel_requested"],
  awaiting_approval: ["planning", "ready", "paused", "blocked", "failed", "cancel_requested"],
  ready: ["executing", "paused", "blocked", "failed", "cancel_requested"],
  executing: [
    "observing",
    "diagnosing",
    "validating",
    "paused",
    "blocked",
    "failed",
    "cancel_requested",
  ],
  observing: [
    "executing",
    "diagnosing",
    "validating",
    "paused",
    "blocked",
    "failed",
    "cancel_requested",
  ],
  diagnosing: ["executing", "replanning", "paused", "blocked", "failed", "cancel_requested"],
  replanning: ["awaiting_approval", "ready", "paused", "blocked", "failed", "cancel_requested"],
  validating: [
    "completed",
    "diagnosing",
    "replanning",
    "paused",
    "blocked",
    "failed",
    "cancel_requested",
  ],
  paused: [
    "scoping",
    "planning",
    "awaiting_approval",
    "ready",
    "executing",
    "observing",
    "diagnosing",
    "replanning",
    "validating",
    "cancel_requested",
  ],
  blocked: [
    "scoping",
    "planning",
    "awaiting_approval",
    "ready",
    "diagnosing",
    "replanning",
    "failed",
    "cancel_requested",
  ],
  cancel_requested: ["cancelling", "cancelled", "failed"],
  cancelling: ["cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
} satisfies Record<MissionState, readonly MissionState[]>;

const planTransitions = {
  draft: ["under_review", "superseded"],
  under_review: ["approved", "rejected", "superseded"],
  approved: ["superseded"],
  rejected: ["superseded"],
  superseded: [],
} satisfies Record<PlanStatus, readonly PlanStatus[]>;

const workUnitTransitions = {
  created: ["ready", "awaiting_approval", "blocked", "cancel_requested"],
  ready: ["awaiting_approval", "claimed", "blocked", "cancel_requested"],
  awaiting_approval: ["ready", "blocked", "cancel_requested"],
  claimed: ["executing", "ready", "blocked", "cancel_requested"],
  executing: ["observing", "retryable_failed", "failed", "blocked", "cancel_requested"],
  observing: ["succeeded", "retryable_failed", "failed", "blocked", "cancel_requested"],
  retryable_failed: ["ready", "failed", "blocked", "cancel_requested"],
  cancel_requested: ["cancelling", "cancelled", "failed"],
  cancelling: ["cancelled", "failed"],
  succeeded: [],
  failed: [],
  blocked: ["ready", "failed", "cancel_requested"],
  cancelled: [],
} satisfies Record<WorkUnitState, readonly WorkUnitState[]>;

const approvalTransitions = {
  pending: ["approved", "rejected", "expired", "superseded"],
  approved: ["superseded"],
  rejected: ["superseded"],
  expired: ["superseded"],
  superseded: [],
} satisfies Record<ApprovalState, readonly ApprovalState[]>;

const operationTransitions = {
  intent: ["effect_started", "failed", "abandoned"],
  effect_started: ["acknowledged", "failed", "ambiguous"],
  acknowledged: ["confirmed", "failed", "ambiguous"],
  ambiguous: ["acknowledged", "confirmed", "failed", "abandoned"],
  confirmed: [],
  failed: [],
  abandoned: [],
} satisfies Record<ExternalOperationState, readonly ExternalOperationState[]>;

function canTransition<S extends string>(graph: Record<S, readonly S[]>, from: S, to: S): boolean {
  return graph[from].includes(to);
}

export const canTransitionMission = (from: MissionState, to: MissionState): boolean =>
  canTransition(missionTransitions, from, to);
export const canTransitionPlan = (from: PlanStatus, to: PlanStatus): boolean =>
  canTransition(planTransitions, from, to);
export const canTransitionWorkUnit = (from: WorkUnitState, to: WorkUnitState): boolean =>
  canTransition(workUnitTransitions, from, to);
export const canTransitionApproval = (from: ApprovalState, to: ApprovalState): boolean =>
  canTransition(approvalTransitions, from, to);
export const canTransitionOperation = (
  from: ExternalOperationState,
  to: ExternalOperationState,
): boolean => canTransition(operationTransitions, from, to);

export function assertScientificTransition(
  aggregate: "mission",
  from: MissionState,
  to: MissionState,
): void;
export function assertScientificTransition(
  aggregate: "plan",
  from: PlanStatus,
  to: PlanStatus,
): void;
export function assertScientificTransition(
  aggregate: "work_unit",
  from: WorkUnitState,
  to: WorkUnitState,
): void;
export function assertScientificTransition(
  aggregate: "approval",
  from: ApprovalState,
  to: ApprovalState,
): void;
export function assertScientificTransition(
  aggregate: "operation",
  from: ExternalOperationState,
  to: ExternalOperationState,
): void;
export function assertScientificTransition(
  aggregate: ScientificAggregateKind,
  from: string,
  to: string,
): void {
  const allowed =
    aggregate === "mission"
      ? canTransitionMission(from as MissionState, to as MissionState)
      : aggregate === "plan"
        ? canTransitionPlan(from as PlanStatus, to as PlanStatus)
        : aggregate === "work_unit"
          ? canTransitionWorkUnit(from as WorkUnitState, to as WorkUnitState)
          : aggregate === "approval"
            ? canTransitionApproval(from as ApprovalState, to as ApprovalState)
            : canTransitionOperation(from as ExternalOperationState, to as ExternalOperationState);
  if (!allowed) throw new IllegalScientificTransitionError(aggregate, from, to);
}
