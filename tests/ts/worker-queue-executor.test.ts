import { describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { EventEmitter } from "events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ensureWorkerLayout,
  listReadyJobs,
  claimJob,
  executeBundle,
  getInboxDir,
  getRunningDir,
  getFailedDir,
  getLocksDir,
  readStatusFile,
  detectOrphaned,
} from "@eigengrid/worker";
import type { SpawnAdapter, WorkerJobManifest } from "@eigengrid/worker";

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function validV2Manifest(
  jobId: string,
  overrides: Partial<WorkerJobManifest> = {},
): WorkerJobManifest {
  return {
    schemaVersion: 2,
    attemptId: "attempt-001",
    nodeName: "worker-01",
    software: "orca",
    recipeId: "orca-opt",
    runner: "worker-daemon",
    inputName: "input.inp",
    outputName: "input.out",
    resources: {
      cores: 1,
      memoryGb: 1,
    },
    createdAt: 1,
    ...overrides,
    jobId,
  };
}

interface SpawnCall {
  program: string;
  args: string[];
  options: { cwd?: string; shell?: boolean };
}

function createSpawnAdapter(
  outcome: { stdout?: string; stderr?: string; exitCode?: number; error?: string } = {},
): { adapter: SpawnAdapter; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const adapter: SpawnAdapter = (program, args, options) => {
    calls.push({
      program,
      args: [...args],
      options: { cwd: options.cwd?.toString(), shell: options.shell },
    });
    if (outcome.error) {
      const child = new EventEmitter() as EventEmitter & { pid: number };
      child.pid = 4242;
      queueMicrotask(() => child.emit("error", new Error(outcome.error)));
      return child as ReturnType<SpawnAdapter>;
    }
    const source = `process.stdout.write(${JSON.stringify(outcome.stdout ?? "")});process.stderr.write(${JSON.stringify(outcome.stderr ?? "")});process.exit(${outcome.exitCode ?? 0})`;
    return spawn(process.execPath, ["-e", source], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
  };
  return { adapter, calls };
}

function expectCanonicalCall(
  calls: SpawnCall[],
  manifest: WorkerJobManifest,
  bundleDir: string,
): void {
  const baseName = manifest.inputName.slice(0, -4);
  expect(calls).toEqual([
    {
      program: "sh",
      args: [
        "-c",
        'orca "$1" > "$2"',
        "eigengrid-recipe",
        manifest.inputName,
        manifest.outputName,
        baseName,
        manifest.jobId,
        join(bundleDir, "work"),
      ],
      options: { cwd: expect.stringContaining("/fd/"), shell: false },
    },
  ]);
}

function createV2ReadyBundle(
  inboxDir: string,
  jobId: string,
  manifestOverrides: Partial<Record<string, unknown>> = {},
): string {
  const bundleDir = join(inboxDir, jobId);
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(
    join(bundleDir, "manifest.json"),
    JSON.stringify(validV2Manifest(jobId, manifestOverrides)),
  );
  writeFileSync(join(bundleDir, "READY"), "");
  mkdirSync(join(bundleDir, "input"));
  writeFileSync(
    join(bundleDir, "input", validV2Manifest(jobId, manifestOverrides).inputName),
    "staged input",
  );
  return bundleDir;
}

function stageInput(bundleDir: string, manifest: WorkerJobManifest): void {
  mkdirSync(join(bundleDir, "input"), { recursive: true });
  writeFileSync(join(bundleDir, "input", manifest.inputName), "staged input");
}

// ────────────────────────────────────────────────────────────
// listReadyJobs Tests
// ────────────────────────────────────────────────────────────

describe("listReadyJobs", () => {
  test("returns empty for empty inbox", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-queue-"));
    try {
      ensureWorkerLayout(tmpDir);
      const jobs = listReadyJobs(tmpDir);
      expect(jobs).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("ignores .tmp directories", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-queue-"));
    try {
      ensureWorkerLayout(tmpDir);
      const inboxDir = getInboxDir(tmpDir);

      // Create a .tmp directory (like scp in progress)
      const tmpBundleDir = join(inboxDir, "job-001.tmp");
      mkdirSync(tmpBundleDir, { recursive: true });
      writeFileSync(
        join(tmpBundleDir, "manifest.json"),
        JSON.stringify(validV2Manifest("job-001.tmp")),
      );
      writeFileSync(join(tmpBundleDir, "READY"), "");

      const jobs = listReadyJobs(tmpDir);
      expect(jobs).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("ignores non-directory entries in inbox", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-queue-"));
    try {
      ensureWorkerLayout(tmpDir);
      const inboxDir = getInboxDir(tmpDir);

      // Create a regular file (not a directory)
      writeFileSync(join(inboxDir, "some-file.txt"), "not a bundle");

      const jobs = listReadyJobs(tmpDir);
      expect(jobs).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("finds bundles with both READY and manifest.json", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-queue-"));
    try {
      ensureWorkerLayout(tmpDir);
      const inboxDir = getInboxDir(tmpDir);
      createV2ReadyBundle(inboxDir, "job-001");

      const jobs = listReadyJobs(tmpDir);
      expect(jobs.length).toBe(1);
      expect(jobs[0].jobId).toBe("job-001");
      expect(jobs[0].bundlePath).toBe(join(inboxDir, "job-001"));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("ignores bundles without READY marker", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-queue-"));
    try {
      ensureWorkerLayout(tmpDir);
      const inboxDir = getInboxDir(tmpDir);

      const bundleDir = join(inboxDir, "job-001");
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(validV2Manifest("job-001")));
      // No READY file

      const jobs = listReadyJobs(tmpDir);
      expect(jobs).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("lists READY bundles without manifest.json for quarantine", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-queue-"));
    try {
      ensureWorkerLayout(tmpDir);
      const inboxDir = getInboxDir(tmpDir);

      const bundleDir = join(inboxDir, "job-001");
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, "READY"), "");
      // No manifest.json

      const jobs = listReadyJobs(tmpDir);
      expect(jobs.map((job) => job.jobId)).toEqual(["job-001"]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────
// claimJob Tests
// ────────────────────────────────────────────────────────────

describe("claimJob", () => {
  test("atomically moves bundle from inbox to running", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-queue-"));
    try {
      ensureWorkerLayout(tmpDir);
      createV2ReadyBundle(getInboxDir(tmpDir), "job-001");

      const result = claimJob(tmpDir, "job-001");
      expect(result.ok).toBe(true);
      expect(result.runningPath).toBe(join(getRunningDir(tmpDir), "job-001"));

      // Bundle should no longer be in inbox
      expect(existsSync(join(getInboxDir(tmpDir), "job-001"))).toBe(false);
      // Bundle should now be in running
      expect(existsSync(join(getRunningDir(tmpDir), "job-001"))).toBe(true);

      // Status file should exist and show claimed state
      const status = readStatusFile(join(getRunningDir(tmpDir), "job-001"));
      expect(status).not.toBeNull();
      expect(status!.state).toBe("claimed");
      expect(status!.jobId).toBe("job-001");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("rejects bundle without READY marker", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-queue-"));
    try {
      ensureWorkerLayout(tmpDir);
      const inboxDir = getInboxDir(tmpDir);

      const bundleDir = join(inboxDir, "job-001");
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(validV2Manifest("job-001")));
      // No READY file

      const result = claimJob(tmpDir, "job-001");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("no READY marker");

      // Bundle should remain in inbox
      expect(existsSync(join(inboxDir, "job-001"))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("quarantines bundle without manifest.json", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-queue-"));
    try {
      ensureWorkerLayout(tmpDir);
      const inboxDir = getInboxDir(tmpDir);

      const bundleDir = join(inboxDir, "job-001");
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, "READY"), "");
      // No manifest.json

      const result = claimJob(tmpDir, "job-001");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("no manifest.json");
      expect(readStatusFile(join(getFailedDir(tmpDir), "job-001"))?.state).toBe("failed");
      expect(existsSync(join(inboxDir, "job-001"))).toBe(false);
      expect(existsSync(join(getRunningDir(tmpDir), "job-001"))).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("quarantines invalid JSON manifests", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-queue-"));
    try {
      ensureWorkerLayout(tmpDir);
      const inboxDir = getInboxDir(tmpDir);

      const bundleDir = join(inboxDir, "job-001");
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, "manifest.json"), "{");
      writeFileSync(join(bundleDir, "READY"), "");

      const result = claimJob(tmpDir, "job-001");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("manifest invalid");
      expect(readStatusFile(join(getFailedDir(tmpDir), "job-001"))?.state).toBe("failed");
      expect(existsSync(join(inboxDir, "job-001"))).toBe(false);
      expect(existsSync(join(getRunningDir(tmpDir), "job-001"))).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("quarantines invalid v2 schemas", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-queue-"));
    try {
      ensureWorkerLayout(tmpDir);
      const inboxDir = getInboxDir(tmpDir);
      const bundleDir = join(inboxDir, "job-001");
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify({ schemaVersion: 2 }));
      writeFileSync(join(bundleDir, "READY"), "");

      const result = claimJob(tmpDir, "job-001");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("manifest invalid");
      expect(readStatusFile(join(getFailedDir(tmpDir), "job-001"))?.state).toBe("failed");
      expect(existsSync(join(inboxDir, "job-001"))).toBe(false);
      expect(existsSync(join(getRunningDir(tmpDir), "job-001"))).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("quarantines v2 manifests whose job ID mismatches the directory", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-queue-"));
    try {
      ensureWorkerLayout(tmpDir);
      const inboxDir = getInboxDir(tmpDir);
      const bundleDir = join(inboxDir, "job-001");
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(validV2Manifest("other-job")));
      writeFileSync(join(bundleDir, "READY"), "");

      const result = claimJob(tmpDir, "job-001");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("jobId mismatch");
      expect(readStatusFile(join(getFailedDir(tmpDir), "job-001"))?.state).toBe("failed");
      expect(existsSync(join(inboxDir, "job-001"))).toBe(false);
      expect(existsSync(join(getRunningDir(tmpDir), "job-001"))).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("rejects non-existent bundle", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-queue-"));
    try {
      ensureWorkerLayout(tmpDir);
      const result = claimJob(tmpDir, "non-existent-job");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("not found in inbox");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("reclaims an old lock only when the recorded owner is dead", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-queue-"));
    try {
      ensureWorkerLayout(tmpDir);
      createV2ReadyBundle(getInboxDir(tmpDir), "job-dead-lock");
      const lockPath = join(getLocksDir(tmpDir), "job-dead-lock.lock");
      writeFileSync(lockPath, "999999:dead-token\n", { mode: 0o600 });
      const old = new Date(Date.now() - 120_000);
      utimesSync(lockPath, old, old);

      const result = claimJob(tmpDir, "job-dead-lock", 5_000);
      expect(result.ok).toBe(true);
      expect(existsSync(join(getRunningDir(tmpDir), "job-dead-lock"))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("does not reclaim an old lock while its recorded owner is alive", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-queue-"));
    try {
      ensureWorkerLayout(tmpDir);
      createV2ReadyBundle(getInboxDir(tmpDir), "job-live-lock");
      const lockPath = join(getLocksDir(tmpDir), "job-live-lock.lock");
      writeFileSync(lockPath, `${process.pid}:live-token\n`, { mode: 0o600 });
      const old = new Date(Date.now() - 120_000);
      utimesSync(lockPath, old, old);

      const result = claimJob(tmpDir, "job-live-lock", 5_000);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("cannot acquire lock");
      expect(existsSync(join(getInboxDir(tmpDir), "job-live-lock"))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("worker crash recovery", () => {
  test("detects a daemon crash after claim but before child spawn", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-orphan-"));
    try {
      ensureWorkerLayout(tmpDir);
      const running = join(getRunningDir(tmpDir), "job-claimed");
      mkdirSync(running, { recursive: true });
      writeFileSync(
        join(running, "status.json"),
        JSON.stringify({
          schemaVersion: 1,
          jobId: "job-claimed",
          attemptId: "attempt-claimed",
          state: "claimed",
          command: "",
          updatedAt: Date.now() - 120_000,
        }),
      );

      expect(detectOrphaned(tmpDir, 60_000)).toEqual([
        expect.objectContaining({ jobId: "job-claimed", bundlePath: running }),
      ]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────
// executeBundle Tests
// ────────────────────────────────────────────────────────────

describe("executeBundle", () => {
  test("writes recipe stdout.log and returns a PID", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-exec-"));
    try {
      const manifestObj = validV2Manifest("job-001");
      const { adapter, calls } = createSpawnAdapter({ stdout: "done\n" });
      const bundleDir = join(tmpDir, "bundle");
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifestObj));
      stageInput(bundleDir, manifestObj);

      const result = await executeBundle(bundleDir, manifestObj, adapter);

      expect(result.ok).toBe(true);
      expect(typeof result.pid).toBe("number");

      expectCanonicalCall(calls, manifestObj, bundleDir);
      const stdoutPath = join(bundleDir, "logs", "stdout.log");
      expect(existsSync(stdoutPath)).toBe(true);
      const stdoutContent = readFileSync(stdoutPath, "utf-8").trim();
      expect(stdoutContent).toBe("done");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("writes exit.status with exit code 0 on success", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-exec-"));
    try {
      const manifestObj = validV2Manifest("job-001");
      const { adapter, calls } = createSpawnAdapter();
      const bundleDir = join(tmpDir, "bundle");
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifestObj));
      stageInput(bundleDir, manifestObj);

      const result = await executeBundle(bundleDir, manifestObj, adapter);

      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);

      const exitStatusPath = join(bundleDir, "exit.status");
      expect(existsSync(exitStatusPath)).toBe(true);
      const exitCode = parseInt(readFileSync(exitStatusPath, "utf-8").trim(), 10);
      expect(exitCode).toBe(0);
      expectCanonicalCall(calls, manifestObj, bundleDir);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("writes exit.status with exit code 1 on failure", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-exec-"));
    try {
      const manifestObj = validV2Manifest("job-fail-001");
      const { adapter, calls } = createSpawnAdapter({ exitCode: 1, stderr: "recipe failed\n" });

      const bundleDir = join(tmpDir, "bundle-fail");
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifestObj));
      stageInput(bundleDir, manifestObj);

      const result = await executeBundle(bundleDir, manifestObj, adapter);

      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);

      const exitStatusPath = join(bundleDir, "exit.status");
      expect(existsSync(exitStatusPath)).toBe(true);
      const exitCode = parseInt(readFileSync(exitStatusPath, "utf-8").trim(), 10);
      expect(exitCode).toBe(1);
      expect(readStatusFile(bundleDir)?.state).toBe("failed");
      expect(readFileSync(join(bundleDir, "logs", "stderr.log"), "utf-8")).toBe("recipe failed\n");
      expectCanonicalCall(calls, manifestObj, bundleDir);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("readStatusFile after execution shows correct state", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-exec-"));
    try {
      const manifestObj = validV2Manifest("job-001");
      const { adapter, calls } = createSpawnAdapter();
      const bundleDir = join(tmpDir, "bundle");
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifestObj));
      stageInput(bundleDir, manifestObj);

      await executeBundle(bundleDir, manifestObj, adapter);

      const status = readStatusFile(bundleDir);
      expect(status).not.toBeNull();
      expect(status!.state).toBe("completed");
      expect(status!.jobId).toBe("job-001");
      expect(status!.attemptId).toBe("attempt-001");
      expect(status!.exitCode).toBe(0);
      expect(status!.pid).toBeGreaterThan(0);
      expect(status!.finishedAt).toBeGreaterThan(0);
      expect(status!.command).toBe("orca input.inp > input.out");
      expectCanonicalCall(calls, manifestObj, bundleDir);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("creates work, logs, and artifacts directories", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-exec-"));
    try {
      const manifestObj = validV2Manifest("job-001");
      const { adapter, calls } = createSpawnAdapter();
      const bundleDir = join(tmpDir, "bundle");
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifestObj));
      stageInput(bundleDir, manifestObj);

      await executeBundle(bundleDir, manifestObj, adapter);

      expect(existsSync(join(bundleDir, "work"))).toBe(true);
      expect(existsSync(join(bundleDir, "logs"))).toBe(true);
      expect(existsSync(join(bundleDir, "artifacts"))).toBe(true);
      expectCanonicalCall(calls, manifestObj, bundleDir);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("passes metacharacter file names as positional canonical arguments", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-exec-shell-"));
    try {
      const manifestObj = validV2Manifest("job-shell-001", {
        inputName: "input;$(data).inp",
        outputName: "input;$(data).out",
      });
      const { adapter, calls } = createSpawnAdapter();

      const bundleDir = join(tmpDir, "bundle");
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifestObj));
      stageInput(bundleDir, manifestObj);

      const result = await executeBundle(bundleDir, manifestObj, adapter);

      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);

      expectCanonicalCall(calls, manifestObj, bundleDir);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("passes every registered recipe argument in canonical order", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-exec-shell2-"));
    try {
      const manifestObj = validV2Manifest("job-shell-002");
      const { adapter, calls } = createSpawnAdapter();

      const bundleDir = join(tmpDir, "bundle");
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifestObj));
      stageInput(bundleDir, manifestObj);

      const result = await executeBundle(bundleDir, manifestObj, adapter);

      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);

      expectCanonicalCall(calls, manifestObj, bundleDir);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("rejects injected command fields without spawning", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-exec-shell3-"));
    try {
      const manifestObj = { ...validV2Manifest("job-shell-003"), command: { program: "echo" } };
      const { adapter, calls } = createSpawnAdapter();

      const bundleDir = join(tmpDir, "bundle");
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifestObj));

      const result = await executeBundle(bundleDir, manifestObj, adapter);

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Unrecognized key");
      expect(calls).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("records a spawn error diagnostic", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-exec-error-"));
    try {
      const manifestObj = validV2Manifest("job-spawn-error");
      const { adapter, calls } = createSpawnAdapter({ error: "deterministic spawn error" });
      const bundleDir = join(tmpDir, "bundle");
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifestObj));
      stageInput(bundleDir, manifestObj);

      const result = await executeBundle(bundleDir, manifestObj, adapter);

      expect(result).toEqual({ ok: false, pid: 4242, error: "deterministic spawn error" });
      expect(readStatusFile(bundleDir)?.message).toBe("deterministic spawn error");
      expectCanonicalCall(calls, manifestObj, bundleDir);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("writes pid file", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-exec-"));
    try {
      const manifestObj = validV2Manifest("job-001");
      const { adapter, calls } = createSpawnAdapter();
      const bundleDir = join(tmpDir, "bundle");
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifestObj));
      stageInput(bundleDir, manifestObj);

      await executeBundle(bundleDir, manifestObj, adapter);

      const pidPath = join(bundleDir, "pid");
      expect(existsSync(pidPath)).toBe(true);
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      expect(pid).toBeGreaterThan(0);
      expectCanonicalCall(calls, manifestObj, bundleDir);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
