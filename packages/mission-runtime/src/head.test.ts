import { describe, expect, test } from "bun:test";
import type {
  ExternalOperation,
  MissionCheckpoint,
  ScientificMission,
  WorkUnit,
} from "@eigengrid/scientific-schema";
import {
  ScientificMissionHead,
  type ScientificMissionHeadStore,
  type ScientificMissionWorkDriver,
} from "./head";
import type { MissionProvenance, WorkUnitClaimResult } from "./types";

const T0 = "2026-08-06T12:00:00.000Z";
const T1 = "2026-08-06T12:01:00.000Z";

const mission = {
  id: "mission-head-1",
  revision: 7,
  state: "ready",
  activePlanId: "plan-head-1",
  policyProfile: "policy-head-1",
} as unknown as ScientificMission;

const workUnit = {
  id: "work-head-1",
  missionId: mission.id,
  planId: mission.activePlanId,
  planVersion: 1,
  revision: 2,
  state: "ready",
  claimOwner: null,
  claimExpiresAt: null,
  jobId: null,
  attemptId: null,
} as unknown as WorkUnit;

const operation = {
  id: "operation-head-1",
  missionId: mission.id,
  workUnitId: workUnit.id,
  state: "ambiguous",
  revision: 3,
} as unknown as ExternalOperation;

function provenance(overrides: Partial<MissionProvenance> = {}): MissionProvenance {
  return {
    mission,
    budget: {} as MissionProvenance["budget"],
    budgetReservations: [],
    skillResolutions: [],
    plans: [
      {
        id: "plan-head-1",
        version: 1,
        revision: 1,
        status: "approved",
        planDigest: "1".repeat(64),
        protocol: { protocolDigest: "2".repeat(64) },
        skillResolution: { graphDigest: "3".repeat(64) },
      } as MissionProvenance["plans"][number],
    ],
    workUnits: [workUnit],
    workUnitClaims: [],
    checkpoints: [],
    decisions: [],
    approvals: [],
    operations: [],
    receipts: [],
    evidence: [],
    observations: [],
    validations: [],
    modelInvocationIntents: [],
    modelInvocations: [],
    planningClaims: [],
    criticFindings: [],
    assessments: [],
    transitions: [],
    missingReferences: [],
    complete: false,
    ...overrides,
  };
}

class FakeHeadStore implements ScientificMissionHeadStore {
  missions: ScientificMission[] = [mission];
  operations: ExternalOperation[] = [];
  runnable: WorkUnit[] = [workUnit];
  checkpoints: MissionCheckpoint[] = [];
  claimCalls = 0;
  renewCalls = 0;
  renewShouldFail = false;
  claimPolicyDigests: Array<string | undefined> = [];
  requiredPolicyDigest?: string;
  claimResult?: WorkUnitClaimResult;

  async listRecoverableMissions(): Promise<ScientificMission[]> {
    return [...this.missions];
  }

  async listOperationsForReconciliation(): Promise<ExternalOperation[]> {
    return [...this.operations];
  }

  async listRunnableWorkUnits(): Promise<WorkUnit[]> {
    return [...this.runnable];
  }

  async claimWorkUnit(input: {
    workUnitId: string;
    ownerId: string;
    now: string;
    expiresAt: string;
    claimId?: string;
    policyDigest?: string;
  }): Promise<WorkUnitClaimResult> {
    this.claimCalls += 1;
    this.claimPolicyDigests.push(input.policyDigest);
    if (this.requiredPolicyDigest && input.policyDigest !== this.requiredPolicyDigest) {
      return {
        claimed: false,
        reason: "approval_required",
        message: "No current exact-revision approval authorizes this work unit",
        workUnit,
      };
    }
    if (this.claimResult) return this.claimResult;
    const claimed = {
      ...workUnit,
      state: "claimed",
      revision: workUnit.revision + 1,
      claimOwner: input.ownerId,
      claimExpiresAt: input.expiresAt,
    } as WorkUnit;
    this.runnable = [];
    return {
      claimed: true,
      claimId: input.claimId ?? "claim-head-1",
      workUnit: claimed,
      ownerId: input.ownerId,
      expiresAt: input.expiresAt,
    };
  }

  async renewWorkUnitClaim(input: {
    workUnitId: string;
    claimId: string;
    ownerId: string;
    now: string;
    expiresAt: string;
    expectedRevision?: number;
  }): Promise<WorkUnit> {
    this.renewCalls += 1;
    if (this.renewShouldFail) throw new Error("database pause during lease renewal");
    if (input.workUnitId !== workUnit.id) {
      throw new Error("claim identity mismatch");
    }
    return {
      ...workUnit,
      revision: workUnit.revision + 1,
      claimOwner: input.ownerId,
      claimExpiresAt: input.expiresAt,
    } as WorkUnit;
  }

  async getMissionProvenance(): Promise<MissionProvenance> {
    return provenance({
      workUnits: [...this.runnable],
      operations: [...this.operations],
      checkpoints: [...this.checkpoints],
    });
  }

  async createCheckpoint(checkpoint: MissionCheckpoint): Promise<MissionCheckpoint> {
    this.checkpoints.push(checkpoint);
    return checkpoint;
  }
}

function makeClock(): () => Date {
  let tick = Date.parse(T0);
  return () => {
    const value = new Date(tick);
    tick += 1_000;
    return value;
  };
}

describe("ScientificMissionHead", () => {
  test("an unresolved ambiguous effect blocks every new scientific dispatch", async () => {
    const store = new FakeHeadStore();
    store.operations = [operation];
    let executions = 0;
    const driver: ScientificMissionWorkDriver = {
      async reconcileOperation(current) {
        return {
          status: "ambiguous",
          operationId: current.id,
          detail: "External truth is still unknown; replay is forbidden",
        };
      },
      async executeClaimedWorkUnit(current) {
        executions += 1;
        return { status: "completed", workUnitId: current.id, detail: "unexpected" };
      },
    };
    const head = new ScientificMissionHead({
      ownerId: "head-a",
      store,
      driver,
      policyDigestFor: () => "a".repeat(64),
      now: makeClock(),
    });

    const result = await head.tick();

    expect(result.missions[0]?.blockedByReconciliation).toBe(true);
    expect(result.totals.unresolvedOperations).toBe(1);
    expect(store.claimCalls).toBe(0);
    expect(executions).toBe(0);
  });

  test("resolves current policy per work unit and fails closed before execution when stale", async () => {
    const store = new FakeHeadStore();
    store.requiredPolicyDigest = "d".repeat(64);
    let resolvedWorkUnitId: string | undefined;
    let executions = 0;
    const head = new ScientificMissionHead({
      ownerId: "head-stale-policy",
      store,
      driver: {
        async reconcileOperation(current) {
          return { status: "reconciled", operationId: current.id, detail: "none" };
        },
        async executeClaimedWorkUnit(current) {
          executions += 1;
          return { status: "completed", workUnitId: current.id, detail: "unexpected" };
        },
      },
      policyDigestFor: (current) => {
        resolvedWorkUnitId = current.id;
        return "e".repeat(64);
      },
      now: makeClock(),
    });

    const result = await head.tick();

    expect(resolvedWorkUnitId).toBe(workUnit.id);
    expect(store.claimPolicyDigests).toEqual(["e".repeat(64)]);
    expect(result.totals.claimsLost).toBe(1);
    expect(result.missions[0]?.claims[0]).toMatchObject({
      claimed: false,
      reason: "approval_required",
    });
    expect(executions).toBe(0);
  });

  test("a replacement head reconciles first and executes a claimed work unit only once", async () => {
    const store = new FakeHeadStore();
    store.operations = [{ ...operation, state: "acknowledged" } as ExternalOperation];
    let executions = 0;
    const driver: ScientificMissionWorkDriver = {
      async reconcileOperation(current) {
        store.operations = store.operations.filter((candidate) => candidate.id !== current.id);
        return {
          status: "reconciled",
          operationId: current.id,
          detail: "Canonical execution receipt confirmed the prior effect",
        };
      },
      async executeClaimedWorkUnit(current) {
        executions += 1;
        return {
          status: "completed",
          workUnitId: current.id,
          detail: "Completed through the typed application driver",
        };
      },
    };

    const firstProcess = new ScientificMissionHead({
      ownerId: "head-stable-owner",
      store,
      driver,
      policyDigestFor: () => "b".repeat(64),
      now: makeClock(),
    });
    const first = await firstProcess.tick();
    expect(first.totals.reconciled).toBe(1);
    expect(first.totals.claimsWon).toBe(1);
    expect(executions).toBe(1);

    const replacementProcess = new ScientificMissionHead({
      ownerId: "head-stable-owner",
      store,
      driver,
      policyDigestFor: () => "b".repeat(64),
      now: makeClock(),
    });
    const second = await replacementProcess.tick();

    expect(second.totals.claimsWon).toBe(0);
    expect(store.claimCalls).toBe(1);
    expect(executions).toBe(1);
    expect(replacementProcess.health()).toMatchObject({
      status: "healthy",
      ready: true,
      running: false,
    });
  });

  test("continuous mode stops cleanly on AbortSignal without an orphan loop", async () => {
    const store = new FakeHeadStore();
    store.missions = [];
    const controller = new AbortController();
    let ticks = 0;
    const head = new ScientificMissionHead({
      ownerId: "head-continuous",
      store,
      driver: {
        async reconcileOperation(current) {
          return { status: "reconciled", operationId: current.id, detail: "none" };
        },
        async executeClaimedWorkUnit(current) {
          return { status: "completed", workUnitId: current.id, detail: "none" };
        },
      },
      policyDigestFor: () => "c".repeat(64),
      now: () => new Date(T1),
    });

    await head.run({
      signal: controller.signal,
      idleDelayMilliseconds: 0,
      onTick: () => {
        ticks += 1;
        controller.abort();
      },
    });

    expect(ticks).toBe(1);
    expect(head.health()).toMatchObject({ running: false, ready: true });
  });

  test("renews a lease independently while a work unit runs longer than its lease", async () => {
    const store = new FakeHeadStore();
    const driver: ScientificMissionWorkDriver = {
      async reconcileOperation() {
        return { status: "reconciled", operationId: "none", detail: "none" };
      },
      async executeClaimedWorkUnit(current) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { status: "completed", workUnitId: current.id, detail: "long work completed" };
      },
    };
    const head = new ScientificMissionHead({
      ownerId: "head-long",
      store,
      driver,
      policyDigestFor: () => "e".repeat(64),
      now: () => new Date(T0),
      leaseMilliseconds: 30,
      leaseHeartbeatMilliseconds: 5,
      leaseSafetyMarginMilliseconds: 2,
    });

    const result = await head.tick();
    expect(store.renewCalls).toBeGreaterThan(0);
    expect(result.totals.claimLostWorkUnits).toBe(0);
    const claim = result.missions[0]?.claims[0];
    expect(claim?.claimed ? claim.execution.status : undefined).toBe("completed");
  });

  test("turns a lost renewal into an explicit fail-closed claim_lost result", async () => {
    const store = new FakeHeadStore();
    store.renewShouldFail = true;
    let driverSawAbort = false;
    const driver: ScientificMissionWorkDriver = {
      async reconcileOperation() {
        return { status: "reconciled", operationId: "none", detail: "none" };
      },
      async executeClaimedWorkUnit(current, input) {
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) {
            driverSawAbort = true;
            resolve();
            return;
          }
          input.signal?.addEventListener(
            "abort",
            () => {
              driverSawAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        return { status: "waiting", workUnitId: current.id, detail: "aborted" };
      },
    };
    const head = new ScientificMissionHead({
      ownerId: "head-claim-loss",
      store,
      driver,
      policyDigestFor: () => "e".repeat(64),
      now: () => new Date(T0),
      leaseMilliseconds: 30,
      leaseHeartbeatMilliseconds: 5,
      leaseSafetyMarginMilliseconds: 2,
    });

    const result = await head.tick();
    expect(driverSawAbort).toBe(true);
    expect(result.totals.claimLostWorkUnits).toBe(1);
    const claim = result.missions[0]?.claims[0];
    expect(claim?.claimed ? claim.execution : undefined).toMatchObject({
      status: "claim_lost",
      retryable: false,
    });
  });
});
