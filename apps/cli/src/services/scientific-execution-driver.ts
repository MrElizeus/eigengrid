import type { ExternalOperation, WorkUnit } from "@eigengrid/scientific-schema";
import {
  ScientificStore,
  type MissionOperationReconciliation,
  type MissionWorkExecution,
  type ScientificMissionWorkDriver,
} from "@eigengrid/mission-runtime";
import type { ScientificExternalWorkUnitPostprocessor } from "./scientific-postprocessor";

export interface ScientificExecutionWithPostprocessingOptions {
  store: ScientificStore;
  executionDriver: ScientificMissionWorkDriver;
  postprocessor: ScientificExternalWorkUnitPostprocessor;
}

/**
 * Compose external effect execution with receipt-triggered scientific
 * postprocessing. A confirmed operation may be replayed through this wrapper
 * after restart; collect, parse, evidence, observations, and WorkUnit success
 * remain idempotent and no new external execution is dispatched.
 */
export class ScientificExecutionWithPostprocessingDriver implements ScientificMissionWorkDriver {
  constructor(private readonly options: ScientificExecutionWithPostprocessingOptions) {}

  async executeClaimedWorkUnit(
    workUnit: WorkUnit,
    context: {
      ownerId: string;
      claimOwner: string;
      now: string;
      signal?: AbortSignal;
    },
  ): Promise<MissionWorkExecution> {
    const execution = await this.options.executionDriver.executeClaimedWorkUnit(workUnit, context);
    const continued = await this.continueIfObserving(workUnit.id, context);
    return continued ?? execution;
  }

  async reconcileOperation(
    operation: ExternalOperation,
    context: { ownerId: string; now: string; signal?: AbortSignal },
  ): Promise<MissionOperationReconciliation> {
    const reconciliation = await this.options.executionDriver.reconcileOperation(
      operation,
      context,
    );
    if (reconciliation.status !== "reconciled") return reconciliation;
    const continued = await this.continueIfObserving(operation.workUnitId, context);
    if (!continued) return reconciliation;
    if (continued.status === "failed") {
      return {
        status: "failed",
        operationId: operation.id,
        detail: continued.detail,
        retryable: continued.retryable,
      };
    }
    if (continued.status === "waiting" || continued.status === "progressed") {
      return {
        status: "waiting",
        operationId: operation.id,
        detail: continued.detail,
      };
    }
    return {
      status: "reconciled",
      operationId: operation.id,
      detail: `${reconciliation.detail}; ${continued.detail}`,
    };
  }

  private async continueIfObserving(
    workUnitId: string,
    context: { ownerId: string; now: string; signal?: AbortSignal },
  ): Promise<MissionWorkExecution | undefined> {
    const current = await this.options.store.getWorkUnit(workUnitId);
    if (!current || current.state !== "observing") return undefined;
    return this.options.postprocessor.continueExternalWorkUnit(current, context);
  }
}
