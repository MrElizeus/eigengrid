import type { ExternalOperation, WorkUnit } from "@eigengrid/scientific-schema";
import {
  ScientificStore,
  type MissionOperationReconciliation,
  type MissionWorkExecution,
  type ScientificMissionPolicyDigestResolver,
  type ScientificMissionWorkDriver,
} from "@eigengrid/mission-runtime";

export interface ExactApprovalScientificMissionDriverOptions {
  store: ScientificStore;
  delegate: ScientificMissionWorkDriver;
  currentPolicyDigestFor: ScientificMissionPolicyDigestResolver;
}

/**
 * Last fail-closed boundary before any new scientific effect. Reconciliation is
 * deliberately delegated even when approval later expires because an already
 * started effect must be observed and settled rather than abandoned or replayed.
 */
export class ExactApprovalScientificMissionDriver implements ScientificMissionWorkDriver {
  constructor(private readonly options: ExactApprovalScientificMissionDriverOptions) {}

  reconcileOperation(
    operation: ExternalOperation,
    context: { ownerId: string; now: string; signal?: AbortSignal },
  ): Promise<MissionOperationReconciliation> {
    return this.options.delegate.reconcileOperation(operation, context);
  }

  async executeClaimedWorkUnit(
    workUnit: WorkUnit,
    context: {
      ownerId: string;
      claimOwner: string;
      now: string;
      signal?: AbortSignal;
    },
  ): Promise<MissionWorkExecution> {
    try {
      const provenance = await this.options.store.getMissionProvenance(workUnit.missionId);
      if (provenance.mission.activePlanId !== workUnit.planId) {
        throw new Error(`Work unit ${workUnit.id} is not bound to the active mission plan`);
      }
      const plan = provenance.plans.find(
        (candidate) =>
          candidate.id === workUnit.planId && candidate.version === workUnit.planVersion,
      );
      if (!plan || plan.status !== "approved") {
        throw new Error(`Work unit ${workUnit.id} has no approved exact plan version`);
      }
      if (plan.requiredApprovals.length !== 1) {
        throw new Error(
          `Plan ${plan.id} does not have the executable single-role approval contract`,
        );
      }
      const requiredApprovalRole = plan.requiredApprovals[0]!;
      if (
        workUnit.approvalPolicy.required &&
        workUnit.approvalPolicy.minimumRole !== requiredApprovalRole
      ) {
        throw new Error(
          `Work unit ${workUnit.id} approval role does not match the exact plan approval role`,
        );
      }
      const currentPolicyDigest = await this.options.currentPolicyDigestFor(workUnit);
      if (!currentPolicyDigest) {
        throw new Error(`No current policy digest is available for work unit ${workUnit.id}`);
      }
      const approval = provenance.approvals
        .filter(
          (candidate) =>
            candidate.subjectType === "plan" &&
            candidate.subjectId === plan.id &&
            candidate.subjectVersion === plan.version &&
            candidate.subjectRevision === plan.revision &&
            candidate.payloadDigest === plan.planDigest &&
            candidate.policyDigest === currentPolicyDigest &&
            candidate.requestedFromRole === requiredApprovalRole &&
            candidate.state === "approved",
        )
        .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))[0];
      if (!approval) {
        throw new Error(
          `Work unit ${workUnit.id} has no exact-revision approval under the current policy`,
        );
      }
      await this.options.store.assertApprovalValid(approval.id, {
        now: context.now,
        currentPolicyDigest,
      });
      return this.options.delegate.executeClaimedWorkUnit(workUnit, context);
    } catch (error) {
      return {
        status: "failed",
        workUnitId: workUnit.id,
        detail: `Exact approval gate rejected execution: ${
          error instanceof Error ? error.message : String(error)
        }`,
        retryable: false,
      };
    }
  }
}
