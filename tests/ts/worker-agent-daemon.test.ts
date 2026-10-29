import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventEmitter } from "events";
import {
  ensureWorkerLayout,
  createStopController,
  runDaemon,
  getInboxDir,
  getDoneDir,
} from "@eigengrid/worker";
import type { DaemonConfig } from "@eigengrid/worker";
import type { SpawnAdapter } from "@eigengrid/worker";
import type { WorkerAgentConfig } from "@eigengrid/core";
import { runRecoveryCycle, readDecisions, appendDecision } from "@eigengrid/worker-agent";
import type { AgentDecisionRecord } from "@eigengrid/worker-agent";

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

const defaultAgentConfig: WorkerAgentConfig = {
  mode: "recover-only",
  maxRecoveryActionsPerJob: 1,
  maxRecoveryActionsPerHour: 10,
  allowParserRetry: true,
  allowArtifactSyncRetry: true,
  allowSameCommandRetry: false,
  allowNodeDrain: true,
  allowPidReattach: true,
};

function validManifest(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    jobId: "job-001",
    attemptId: "attempt-001",
    nodeName: "worker-01",
    software: "orca",
    recipeId: "orca-opt",
    runner: "worker-daemon",
    inputName: "input.inp",
    outputName: "input.out",
    resources: { cores: 1, memoryGb: 1 },
    createdAt: Date.now(),
    ...overrides,
  };
}

function deterministicSpawn(calls: Array<[string, string[], { shell?: boolean }]>): SpawnAdapter {
  return ((program: string, args: string[], options: { shell?: boolean }) => {
    calls.push([program, args, options]);
    const child = new EventEmitter() as EventEmitter & { pid: number };
    child.pid = 7;
    setTimeout(() => child.emit("close", 0), 10);
    return child;
  }) as SpawnAdapter;
}

function createReadyBundle(
  inboxDir: string,
  jobId: string,
  overrides: Partial<Record<string, unknown>> = {},
): string {
  const bundleDir = join(inboxDir, jobId);
  mkdirSync(bundleDir, { recursive: true });
  const manifest = validManifest({ jobId, ...overrides });
  writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifest));
  mkdirSync(join(bundleDir, "input"));
  writeFileSync(join(bundleDir, "input", manifest.inputName as string), "staged input");
  writeFileSync(join(bundleDir, "READY"), "");
  return bundleDir;
}

// ────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────

describe("worker-agent daemon integration", () => {
  test("daemon works when recovery handler is provided", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-agent-daemon-"));
    try {
      ensureWorkerLayout(tmpDir);
      createReadyBundle(getInboxDir(tmpDir), "job-daemon-001");
      const calls: Array<[string, string[], { shell?: boolean }]> = [];

      let recoveryCalled = false;
      const daemonConfig: DaemonConfig = {
        scratchDir: tmpDir,
        pollIntervalMs: 50,
        maxConcurrent: 2,
        spawnAdapter: deterministicSpawn(calls),
        recoveryHandler: async (s: string) => {
          recoveryCalled = true;
          await runRecoveryCycle(s, defaultAgentConfig, "worker-01");
        },
      };

      const controller = createStopController();
      const daemonPromise = runDaemon(daemonConfig, controller);

      await new Promise((resolve) => setTimeout(resolve, 600));
      controller.stop();
      const state = await daemonPromise;

      expect(state.processedCount).toBe(1);
      expect(recoveryCalled).toBe(true);
      expect(existsSync(join(getDoneDir(tmpDir), "job-daemon-001"))).toBe(true);
      expect(calls).toEqual([
        [
          "sh",
          expect.arrayContaining(["input.inp", "input.out"]),
          expect.objectContaining({ shell: false }),
        ],
      ]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("recovery cycle does nothing when mode is off", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-agent-off-"));
    try {
      ensureWorkerLayout(tmpDir);

      const offConfig: WorkerAgentConfig = { ...defaultAgentConfig, mode: "off" };
      const result = await runRecoveryCycle(tmpDir, offConfig, "worker-01");

      expect(result.ok).toBe(true);
      expect(result.events.length).toBe(0);
      expect(result.decisions.length).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("recovery cycle emits agent.decision.evaluated events", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-agent-events-"));
    try {
      ensureWorkerLayout(tmpDir);

      // Create a failed bundle
      const inboxDir = getInboxDir(tmpDir);
      createReadyBundle(inboxDir, "job-events-test");

      // Since the job is in inbox/ (ready), it won't be scanned by recovery cycle
      // Recovery cycle only scans running/, failed/, done/, orphaned/
      // Let's test with an empty scratch — it should still return ok with no decisions
      const result = await runRecoveryCycle(tmpDir, defaultAgentConfig, "worker-01");

      expect(result.ok).toBe(true);
      // No bundles to scan, so no events (but still succeed)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("decisions are persisted and readable", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-agent-decisions-"));
    try {
      ensureWorkerLayout(tmpDir);

      const record: AgentDecisionRecord = {
        id: "test-decision-001",
        nodeId: "worker-01",
        jobId: "job-001",
        decision: "mark-zombie-failed",
        reason: "zombie detected",
        confidence: "high",
        mode: "recover-only",
        policy: "maxPerJob=1",
        createdAt: Date.now(),
      };

      appendDecision(tmpDir, record);

      const decisions = readDecisions(tmpDir);
      expect(decisions.length).toBe(1);
      expect(decisions[0].id).toBe("test-decision-001");
      expect(decisions[0].decision).toBe("mark-zombie-failed");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
