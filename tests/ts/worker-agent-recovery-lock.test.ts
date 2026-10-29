import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  acquireRecoveryLock,
  runRecoveryCycle,
  readLedgerWithIntegrity,
} from "@eigengrid/worker-agent";
import { ensureWorkerLayout, getFailedDir, getLocksDir, writeStatusFile } from "@eigengrid/worker";
import type { WorkerAgentConfig } from "@eigengrid/core";

const config: WorkerAgentConfig = {
  mode: "recover-only",
  maxRecoveryActionsPerJob: 1,
  maxRecoveryActionsPerHour: 10,
  allowParserRetry: true,
  allowArtifactSyncRetry: true,
  allowSameCommandRetry: false,
  allowNodeDrain: true,
  allowPidReattach: true,
};
function temp() {
  return mkdtempSync(join(tmpdir(), "worker-agent-lock-"));
}
function failedBundle(dir: string) {
  ensureWorkerLayout(dir);
  const bundle = join(getFailedDir(dir), "job");
  mkdirSync(bundle);
  writeStatusFile(bundle, {
    schemaVersion: 1,
    jobId: "job",
    attemptId: "attempt",
    state: "failed",
    command: "x",
    exitCode: 1,
  });
}

describe("worker-agent recovery admission lock", () => {
  test("admits one concurrent cycle and leaves the contender mutation-free", async () => {
    const dir = temp();
    try {
      failedBundle(dir);
      const [first, second] = await Promise.all([
        runRecoveryCycle(dir, config, "one", 500),
        runRecoveryCycle(dir, config, "two", 500),
      ]);
      expect(
        [first, second].filter((result) => result.skippedReason === "recovery-lock-contended"),
      ).toHaveLength(1);
      expect(readLedgerWithIntegrity(dir).records.map((record) => record.type)).toEqual([
        "decision.evaluated",
        "action.reserved",
        "action.completed",
      ]);
      expect(existsSync(join(getLocksDir(dir), "worker-agent-recovery.lock"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails closed for malformed existing locks", async () => {
    const dir = temp();
    try {
      failedBundle(dir);
      writeFileSync(join(getLocksDir(dir), "worker-agent-recovery.lock"), "bad");
      await expect(runRecoveryCycle(dir, config, "node", 500)).resolves.toMatchObject({
        ok: false,
        skippedReason: "recovery-lock-error",
        events: [],
        decisions: [],
      });
      expect(readLedgerWithIntegrity(dir).records).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("distinguishes valid contention and never deletes a changed owner", async () => {
    const dir = temp();
    const path = join(dir, "locks", "worker-agent-recovery.lock");
    try {
      failedBundle(dir);
      writeFileSync(
        path,
        JSON.stringify({ token: "other", pid: 1, nodeId: "other", acquiredAt: 1 }),
      );
      await expect(runRecoveryCycle(dir, config, "node", 500)).resolves.toMatchObject({
        ok: true,
        skippedReason: "recovery-lock-contended",
      });
      rmSync(path);
      const lock = acquireRecoveryLock(dir, "node");
      if (lock.kind !== "acquired") throw new Error("lock was not acquired");
      writeFileSync(
        path,
        JSON.stringify({ token: "other", pid: 1, nodeId: "other", acquiredAt: 1 }),
      );
      lock.release();
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails closed for unreadable locks and lock-directory errors", async () => {
    const dir = temp();
    const blocked = temp();
    try {
      failedBundle(dir);
      mkdirSync(join(getLocksDir(dir), "worker-agent-recovery.lock"));
      await expect(runRecoveryCycle(dir, config, "node", 500)).resolves.toMatchObject({
        ok: false,
        skippedReason: "recovery-lock-error",
      });
      expect(readLedgerWithIntegrity(dir).records).toEqual([]);
      writeFileSync(join(blocked, "locks"), "not a directory");
      await expect(runRecoveryCycle(blocked, config, "node", 500)).resolves.toMatchObject({
        ok: false,
        skippedReason: "recovery-lock-error",
        events: [],
        decisions: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(blocked, { recursive: true, force: true });
    }
  });
});
