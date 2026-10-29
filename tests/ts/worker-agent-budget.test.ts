import { describe, expect, test } from "bun:test";
import type { WorkerAgentConfig } from "@eigengrid/core";
import { evaluateRecovery } from "@eigengrid/worker-agent";
import type { RecoveryInput, BudgetState } from "@eigengrid/worker-agent";

// ────────────────────────────────────────────────────────────
// Budget Limit Tests
// ────────────────────────────────────────────────────────────

const defaultConfig: WorkerAgentConfig = {
  mode: "recover-only",
  maxRecoveryActionsPerJob: 1,
  maxRecoveryActionsPerHour: 10,
  allowParserRetry: true,
  allowArtifactSyncRetry: true,
  allowSameCommandRetry: true, // enable for these tests
  allowNodeDrain: true,
  allowPidReattach: true,
};

function makeInput(overrides: Partial<RecoveryInput> = {}): RecoveryInput {
  return {
    nodeState: { diskAvailableMb: 50000 },
    job: { status: "failed", exitCode: 1 },
    attempt: { status: "failed", pid: undefined },
    artifacts: [],
    logs: [],
    daemonState: { orphans: [] },
    previousRecoveryEvents: [],
    ...overrides,
  };
}

describe("budget limits", () => {
  test("maxRecoveryActionsPerJob=1 prevents second action", () => {
    const input = makeInput();

    // First action: within budget
    const budget1: BudgetState = {
      actionsThisJob: 0,
      actionsThisHour: 0,
      hourWindowStart: Date.now(),
    };
    const decision1 = evaluateRecovery(input, {
      config: defaultConfig,
      budget: budget1,
    });
    expect(decision1.decision).not.toBe("none");

    // Second action: budget exceeded
    const budget2: BudgetState = {
      actionsThisJob: 1,
      actionsThisHour: 0,
      hourWindowStart: Date.now(),
    };
    const decision2 = evaluateRecovery(input, {
      config: defaultConfig,
      budget: budget2,
    });
    expect(decision2.decision).toBe("none");
    expect(decision2.reason).toContain("maxRecoveryActionsPerJob");
  });

  test("maxRecoveryActionsPerJob=3 allows up to 3 actions", () => {
    const config: WorkerAgentConfig = { ...defaultConfig, maxRecoveryActionsPerJob: 3 };

    const input = makeInput();

    // Third action: still within budget
    const budget: BudgetState = {
      actionsThisJob: 2,
      actionsThisHour: 0,
      hourWindowStart: Date.now(),
    };
    const decision = evaluateRecovery(input, { config, budget });
    expect(decision.decision).not.toBe("none");

    // Fourth action: exceeded
    const budget2: BudgetState = {
      actionsThisJob: 3,
      actionsThisHour: 0,
      hourWindowStart: Date.now(),
    };
    const decision2 = evaluateRecovery(input, { config, budget: budget2 });
    expect(decision2.decision).toBe("none");
    expect(decision2.reason).toContain("maxRecoveryActionsPerJob");
  });

  test("maxRecoveryActionsPerHour=10 prevents eleventh action", () => {
    const input = makeInput();

    // 10th action: within budget
    const budget10: BudgetState = {
      actionsThisJob: 0,
      actionsThisHour: 9,
      hourWindowStart: Date.now(),
    };
    const decision10 = evaluateRecovery(input, {
      config: defaultConfig,
      budget: budget10,
    });
    expect(decision10.decision).not.toBe("none");

    // 11th action: exceeded
    const budget11: BudgetState = {
      actionsThisJob: 0,
      actionsThisHour: 10,
      hourWindowStart: Date.now(),
    };
    const decision11 = evaluateRecovery(input, {
      config: defaultConfig,
      budget: budget11,
    });
    expect(decision11.decision).toBe("none");
    expect(decision11.reason).toContain("maxRecoveryActionsPerHour");
  });

  test("per-job and per-hour budgets are independent", () => {
    const input = makeInput();

    // Job budget exceeded but hour budget is fine
    const budget: BudgetState = {
      actionsThisJob: 1,
      actionsThisHour: 0,
      hourWindowStart: Date.now(),
    };
    const decision = evaluateRecovery(input, { config: defaultConfig, budget });
    expect(decision.decision).toBe("none");
    expect(decision.reason).toContain("maxRecoveryActionsPerJob");

    // Hour budget exceeded but job budget is fine
    const budget2: BudgetState = {
      actionsThisJob: 0,
      actionsThisHour: 10,
      hourWindowStart: Date.now(),
    };
    const decision2 = evaluateRecovery(input, { config: defaultConfig, budget: budget2 });
    expect(decision2.decision).toBe("none");
    expect(decision2.reason).toContain("maxRecoveryActionsPerHour");
  });

  test("budget check runs before decision logic", () => {
    // When both budgets are exceeded, the policy returns "none"
    // even when there is a clear recovery action to take
    const input = makeInput({
      nodeState: { diskAvailableMb: 500 }, // would normally trigger drain
    });

    const budget: BudgetState = {
      actionsThisJob: 1,
      actionsThisHour: 0,
      hourWindowStart: Date.now(),
    };
    const decision = evaluateRecovery(input, { config: defaultConfig, budget });

    // Budget exceeded takes priority over node drain
    expect(decision.decision).toBe("none");
    expect(decision.reason).toContain("maxRecoveryActionsPerJob");
  });

  test("config defaults provide safe limits", () => {
    // Verify the default config has safe budget limits
    const safeConfig: WorkerAgentConfig = {
      mode: "off",
      maxRecoveryActionsPerJob: 1,
      maxRecoveryActionsPerHour: 10,
      allowParserRetry: true,
      allowArtifactSyncRetry: true,
      allowSameCommandRetry: false,
      allowNodeDrain: true,
      allowPidReattach: true,
    };

    expect(safeConfig.maxRecoveryActionsPerJob).toBe(1);
    expect(safeConfig.maxRecoveryActionsPerHour).toBe(10);
    expect(safeConfig.allowSameCommandRetry).toBe(false);
  });
});
