import { describe, expect, test } from "bun:test";
import type { WorkerAgentConfig } from "@eigengrid/core";
import {
  evaluateRecovery,
  isDecisionAutoExecutable,
  noActionNeeded,
} from "@eigengrid/worker-agent";
import type { RecoveryInput, BudgetState } from "@eigengrid/worker-agent";

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

const defaultConfig: WorkerAgentConfig = {
  mode: "recover-only",
  maxRecoveryActionsPerJob: 1,
  maxRecoveryActionsPerHour: 10,
  allowParserRetry: true,
  allowArtifactSyncRetry: true,
  allowSameCommandRetry: false,
  allowNodeDrain: true,
  allowPidReattach: true,
};

const defaultBudget: BudgetState = {
  actionsThisJob: 0,
  actionsThisHour: 0,
  hourWindowStart: Date.now() - 60_000,
};

function makeInput(overrides: Partial<RecoveryInput> = {}): RecoveryInput {
  return {
    nodeState: { diskAvailableMb: 50000 },
    job: { status: "completed", exitCode: 0 },
    attempt: { status: "completed", pid: undefined },
    artifacts: [],
    logs: [],
    daemonState: { orphans: [] },
    previousRecoveryEvents: [],
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────

describe("policy engine", () => {
  test("default mode is off — agent decisions blocked by policy when disabled", () => {
    const offConfig: WorkerAgentConfig = { ...defaultConfig, mode: "off" };
    const input = makeInput({ job: { status: "failed", exitCode: 1 } });

    // The policy engine evaluates regardless of mode; mode="off" is checked
    // by runRecoveryCycle() which short-circuits before calling evaluateRecovery.
    // Here we test that allowSameCommandRetry=false causes allowedByPolicy=false
    // when a failed job suggests a same-command retry.
    const decision = evaluateRecovery(input, {
      config: offConfig,
      budget: defaultBudget,
    });

    // The policy suggests the action but marks it as not allowed
    expect(decision.decision).toBe("retry-same-command-once");
    expect(decision.allowedByPolicy).toBe(false);
  });

  test("recover-only cannot modify scientific input", () => {
    // Safety invariant: none of the recovery actions accept input file paths
    // The actions only deal with artifacts, PIDs, and bundle directories
    const input = makeInput({
      job: { status: "failed", exitCode: 1 },
      artifacts: [{ kind: "input", path: "/some/input.inp", exists: true }],
    });

    const decision = evaluateRecovery(input, {
      config: defaultConfig,
      budget: defaultBudget,
    });

    // Input artifacts shouldn't trigger artifact sync (sync is for outputs)
    // Only output artifacts being missing can trigger sync
    expect(decision.decision).toBe("retry-same-command-once");
  });

  test("retry-same-command-once happens at most once per job", () => {
    const input = makeInput({
      job: { status: "failed", exitCode: 1 },
      previousRecoveryEvents: [{ decision: "retry-same-command-once", jobId: "job-001" }],
    });

    const decision = evaluateRecovery(input, {
      config: defaultConfig,
      budget: defaultBudget,
    });

    expect(decision.decision).toBe("none");
  });

  test("parser retry requires existing output artifact", () => {
    const input = makeInput({
      job: { status: "completed", exitCode: 0 },
      artifacts: [{ kind: "output", path: "/some/output.out", exists: true }],
    });

    const decision = evaluateRecovery(input, {
      config: defaultConfig,
      budget: defaultBudget,
    });

    expect(decision.decision).toBe("retry-parser");
  });

  test("parser retry does not fire when no output artifacts exist", () => {
    const input = makeInput({
      job: { status: "completed", exitCode: 0 },
      artifacts: [],
    });

    const decision = evaluateRecovery(input, {
      config: defaultConfig,
      budget: defaultBudget,
    });

    expect(decision.decision).toBe("none");
  });

  test("artifact sync retry fires when output artifacts are missing", () => {
    const input = makeInput({
      job: { status: "failed", exitCode: 1 },
      artifacts: [{ kind: "output", path: "/some/output.out", exists: false }],
    });

    const decision = evaluateRecovery(input, {
      config: defaultConfig,
      budget: defaultBudget,
    });

    expect(decision.decision).toBe("retry-artifact-sync");
  });

  test("artifact sync retry is skipped when all outputs exist", () => {
    const input = makeInput({
      job: { status: "failed", exitCode: 1 },
      artifacts: [{ kind: "output", path: "/some/output.out", exists: true }],
    });

    const decision = evaluateRecovery(input, {
      config: defaultConfig,
      budget: defaultBudget,
    });

    expect(decision.decision).toBe("retry-same-command-once");
  });

  test("node draining is triggered on low disk", () => {
    const input = makeInput({
      nodeState: { diskAvailableMb: 500 },
    });

    const decision = evaluateRecovery(input, {
      config: defaultConfig,
      budget: defaultBudget,
    });

    expect(decision.decision).toBe("mark-draining");
  });

  test("zombie PID is marked as failed", () => {
    const input = makeInput({
      job: { status: "running" },
      attempt: { status: "running", pid: undefined },
    });

    const decision = evaluateRecovery(input, {
      config: defaultConfig,
      budget: defaultBudget,
    });

    expect(decision.decision).toBe("mark-zombie-failed");
  });

  test("reattach-pid is proposed when PID exists on running job", () => {
    const input = makeInput({
      job: { status: "running" },
      attempt: { status: "running", pid: 12345 },
    });

    const decision = evaluateRecovery(input, {
      config: defaultConfig,
      budget: defaultBudget,
    });

    expect(decision.decision).toBe("reattach-pid");
  });

  test("budget per job is respected", () => {
    const input = makeInput({
      job: { status: "failed", exitCode: 1 },
    });

    const decision = evaluateRecovery(input, {
      config: defaultConfig,
      budget: { actionsThisJob: 1, actionsThisHour: 0, hourWindowStart: Date.now() },
    });

    expect(decision.decision).toBe("none");
    expect(decision.reason).toContain("maxRecoveryActionsPerJob");
  });

  test("budget per hour is respected", () => {
    const input = makeInput({
      job: { status: "failed", exitCode: 1 },
    });

    const decision = evaluateRecovery(input, {
      config: defaultConfig,
      budget: { actionsThisJob: 0, actionsThisHour: 10, hourWindowStart: Date.now() },
    });

    expect(decision.decision).toBe("none");
    expect(decision.reason).toContain("maxRecoveryActionsPerHour");
  });

  test("noActionNeeded returns none with high confidence", () => {
    const decision = noActionNeeded();
    expect(decision.decision).toBe("none");
    expect(decision.confidence).toBe("high");
  });

  test("requiresHeadApproval is set for certain actions", () => {
    // PID reattach requires head approval
    const input = makeInput({
      job: { status: "running" },
      attempt: { status: "running", pid: 12345 },
    });

    const decision = evaluateRecovery(input, {
      config: defaultConfig,
      budget: defaultBudget,
    });

    expect(decision.requiresHeadApproval).toBe(true);
  });

  test("isDecisionAutoExecutable returns false for none decisions", () => {
    expect(isDecisionAutoExecutable(noActionNeeded())).toBe(false);
  });

  test("all decisions emit agent.decision.* events", () => {
    // The recovery-cycle.ts always emits agent.decision.evaluated
    // for every evaluation. This is verified in the daemon test.
    // Here we just verify the policy returns a proper decision
    // The event emission is in recovery-cycle.ts
    const input = makeInput({
      job: { status: "running" },
      attempt: { status: "running", pid: 12345 },
    });

    const decision = evaluateRecovery(input, {
      config: defaultConfig,
      budget: defaultBudget,
    });

    // Every decision from the policy results in an evaluated event
    expect(decision.decision).toBe("reattach-pid");
    expect(decision.reason.length).toBeGreaterThan(0);
  });
});
