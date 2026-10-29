import { describe, expect, test } from "bun:test";
import type { ExternalOperation, WorkUnit } from "@eigengrid/scientific-schema";
import type {
  MissionOperationReconciliation,
  MissionProvenance,
  MissionWorkExecution,
  ScientificMissionWorkDriver,
  ScientificStore,
} from "@eigengrid/mission-runtime";
import { ExactApprovalScientificMissionDriver } from "./scientific-approval-driver";

const workUnit = {
  id: "work-approval-gate",
  missionId: "mission-approval-gate",
  planId: "plan-approval-gate",
  planVersion: 4,
  approvalPolicy: { required: true, minimumRole: "scientific_reviewer" },
} as WorkUnit;

function provenance(): MissionProvenance {
  return {
    mission: {
      id: workUnit.missionId,
      activePlanId: workUnit.planId,
    } as MissionProvenance["mission"],
    plans: [
      {
        id: workUnit.planId,
        version: workUnit.planVersion,
        revision: 7,
        status: "approved",
        planDigest: "a".repeat(64),
        requiredApprovals: ["scientific_reviewer"],
      } as MissionProvenance["plans"][number],
    ],
    approvals: [
      {
        id: "approval-exact-gate",
        subjectType: "plan",
        subjectId: workUnit.planId,
        subjectVersion: workUnit.planVersion,
        subjectRevision: 7,
        payloadDigest: "a".repeat(64),
        policyDigest: "b".repeat(64),
        requestedFromRole: "scientific_reviewer",
        state: "approved",
        requestedAt: "2026-08-06T00:00:00.000Z",
      } as MissionProvenance["approvals"][number],
    ],
  } as MissionProvenance;
}

class Delegate implements ScientificMissionWorkDriver {
  executions = 0;
  reconciliations = 0;

  async executeClaimedWorkUnit(): Promise<MissionWorkExecution> {
    this.executions += 1;
    return {
      status: "progressed",
      workUnitId: workUnit.id,
      detail: "delegated",
    };
  }

  async reconcileOperation(operation: ExternalOperation): Promise<MissionOperationReconciliation> {
    this.reconciliations += 1;
    return { status: "waiting", operationId: operation.id, detail: "delegated" };
  }
}

describe("ExactApprovalScientificMissionDriver", () => {
  test("delegates only after the current exact approval validates", async () => {
    const delegate = new Delegate();
    let validated = 0;
    const store = {
      async getMissionProvenance() {
        return provenance();
      },
      async assertApprovalValid(id: string, input: Record<string, unknown>) {
        validated += 1;
        expect(id).toBe("approval-exact-gate");
        expect(input).toEqual({
          now: "2026-08-06T00:01:00.000Z",
          currentPolicyDigest: "b".repeat(64),
        });
      },
    } as unknown as ScientificStore;
    const driver = new ExactApprovalScientificMissionDriver({
      store,
      delegate,
      currentPolicyDigestFor: () => "b".repeat(64),
    });
    const result = await driver.executeClaimedWorkUnit(workUnit, {
      ownerId: "head",
      claimOwner: "head",
      now: "2026-08-06T00:01:00.000Z",
    });
    expect(result.status).toBe("progressed");
    expect(validated).toBe(1);
    expect(delegate.executions).toBe(1);
  });

  test("fails closed before delegation when approval validation rejects", async () => {
    const delegate = new Delegate();
    const store = {
      async getMissionProvenance() {
        return provenance();
      },
      async assertApprovalValid() {
        throw new Error("approval expired");
      },
    } as unknown as ScientificStore;
    const driver = new ExactApprovalScientificMissionDriver({
      store,
      delegate,
      currentPolicyDigestFor: () => "b".repeat(64),
    });
    const result = await driver.executeClaimedWorkUnit(workUnit, {
      ownerId: "head",
      claimOwner: "head",
      now: "2026-08-07T00:00:00.000Z",
    });
    expect(result).toMatchObject({ status: "failed", retryable: false });
    expect(result.detail).toContain("approval expired");
    expect(delegate.executions).toBe(0);
  });

  test("fails closed when the authoritative policy is newer than the approval", async () => {
    const delegate = new Delegate();
    const store = {
      async getMissionProvenance() {
        return provenance();
      },
      async assertApprovalValid(_id: string, input: { currentPolicyDigest: string }) {
        if (input.currentPolicyDigest !== "b".repeat(64)) {
          throw new Error("approval policy digest is stale");
        }
      },
    } as unknown as ScientificStore;
    const driver = new ExactApprovalScientificMissionDriver({
      store,
      delegate,
      currentPolicyDigestFor: () => "c".repeat(64),
    });

    const result = await driver.executeClaimedWorkUnit(workUnit, {
      ownerId: "head",
      claimOwner: "head",
      now: "2026-08-06T00:01:00.000Z",
    });

    expect(result).toMatchObject({ status: "failed", retryable: false });
    expect(result.detail).toContain("current policy");
    expect(delegate.executions).toBe(0);
  });

  test("selects the current-policy approval even when a newer historical approval exists", async () => {
    const delegate = new Delegate();
    const current = provenance();
    current.approvals.push({
      ...current.approvals[0]!,
      id: "approval-newer-stale-policy",
      policyDigest: "c".repeat(64),
      requestedAt: "2026-08-06T00:02:00.000Z",
    });
    let validatedApprovalId = "";
    const store = {
      async getMissionProvenance() {
        return current;
      },
      async assertApprovalValid(id: string) {
        validatedApprovalId = id;
      },
    } as unknown as ScientificStore;
    const driver = new ExactApprovalScientificMissionDriver({
      store,
      delegate,
      currentPolicyDigestFor: () => "b".repeat(64),
    });

    const result = await driver.executeClaimedWorkUnit(workUnit, {
      ownerId: "head",
      claimOwner: "head",
      now: "2026-08-06T00:03:00.000Z",
    });

    expect(result.status).toBe("progressed");
    expect(validatedApprovalId).toBe("approval-exact-gate");
    expect(delegate.executions).toBe(1);
  });

  test("always permits reconciliation of an already-started effect", async () => {
    const delegate = new Delegate();
    const store = {} as ScientificStore;
    let policyLookups = 0;
    const driver = new ExactApprovalScientificMissionDriver({
      store,
      delegate,
      currentPolicyDigestFor: () => {
        policyLookups += 1;
        return undefined;
      },
    });
    const operation = { id: "operation-started" } as ExternalOperation;
    const result = await driver.reconcileOperation(operation, {
      ownerId: "head",
      now: "2026-08-07T00:00:00.000Z",
    });
    expect(result.status).toBe("waiting");
    expect(delegate.reconciliations).toBe(1);
    expect(policyLookups).toBe(0);
  });
});
