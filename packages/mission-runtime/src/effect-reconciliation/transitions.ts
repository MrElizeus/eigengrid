import { type ExternalOperation, type WorkUnitState } from "@eigengrid/scientific-schema";
import { ScientificIntegrityError } from "../errors";
import { type ReconciledEffectOutcome } from "./contracts";

export function transitionPath(
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

export function expectedOperationState(
  outcome: ReconciledEffectOutcome,
): ExternalOperation["state"] {
  return outcome === "completed" ? "confirmed" : "failed";
}
