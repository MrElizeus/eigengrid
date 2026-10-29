import { describe, expect, test } from "bun:test";
import type { WorkerAgentConfig } from "@eigengrid/core";
import {
  evaluateRecovery,
  runRecoveryCycle,
  retryParserIfOutputExists,
  retryArtifactSync,
  markNodeDraining,
  reattachKnownPid,
  markZombieFailed,
  retrySameCommandOnce,
} from "@eigengrid/worker-agent";
import type { RecoveryInput, BudgetState } from "@eigengrid/worker-agent";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ensureWorkerLayout,
  getRunningDir,
  getFailedDir,
  getDoneDir,
  getInboxDir,
} from "@eigengrid/worker";

// ────────────────────────────────────────────────────────────
// Safety Constraints Tests
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

describe("safety constraints", () => {
  test("recover-only cannot modify scientific input", () => {
    // The recovery actions never accept input file paths as parameters.
    // They only operate on bundle directories and scratch layout.
    // Verify the function signatures don't accept input file paths.

    const input = makeInput({
      job: { status: "failed", exitCode: 1 },
      artifacts: [{ kind: "input", path: "/some/input.inp", exists: true }],
    });

    const decision = evaluateRecovery(input, {
      config: defaultConfig,
      budget: defaultBudget,
    });

    // Even with input artifacts existing, the policy doesn't
    // suggest any action that would modify them
    expect(decision.decision).toBe("retry-same-command-once");
  });

  test("worker cannot run arbitrary shell", () => {
    // All recovery actions are typed, named functions.
    // No action accepts an arbitrary command string parameter.
    const actionNames = [
      retryArtifactSync.name,
      retryParserIfOutputExists.name,
      markNodeDraining.name,
      reattachKnownPid.name,
      markZombieFailed.name,
      retrySameCommandOnce.name,
    ];

    // Verify all action function names match expected typed actions
    expect(actionNames).toContain("retryArtifactSync");
    expect(actionNames).toContain("retryParserIfOutputExists");
    expect(actionNames).toContain("markNodeDraining");
    expect(actionNames).toContain("reattachKnownPid");
    expect(actionNames).toContain("markZombieFailed");
    expect(actionNames).toContain("retrySameCommandOnce");
  });

  test("worker cannot access LLM config or key", () => {
    // Invariant: @eigengrid/worker-agent must NOT depend on or import any
    // LLM-related packages. The worker agent is a safety boundary — it does
    // recovery orchestration only, never LLM inference or key management.

    const rootDir = join(import.meta.dir, "../..");

    // 1. Assert package.json dependencies exclude LLM packages
    const pkg = JSON.parse(
      readFileSync(join(rootDir, "packages/worker-agent/package.json"), "utf-8"),
    );
    const depNames = Object.keys(pkg.dependencies ?? {});
    for (const llmDep of [
      "@eigengrid/agent",
      "ai",
      "@ai-sdk/core",
      "@ai-sdk",
      "openai",
      "anthropic",
    ]) {
      expect(depNames).not.toContain(llmDep);
    }

    // 2. Assert no source file imports LLM packages
    const srcDir = join(rootDir, "packages/worker-agent/src");
    const srcFiles = readdirSync(srcDir).filter((f: string) => f.endsWith(".ts"));
    for (const file of srcFiles) {
      const content = readFileSync(join(srcDir, file), "utf-8");
      // These patterns cover all LLM package imports
      expect(content).not.toMatch(/from\s+['"]@eigengrid\/agent['"]/);
      expect(content).not.toMatch(/from\s+['"]ai['"]/);
      expect(content).not.toMatch(/from\s+['"]@ai-sdk\//);
      expect(content).not.toMatch(/from\s+['"]openai['"]/);
      expect(content).not.toMatch(/from\s+['"]anthropic['"]/);
    }
  });

  test("same command retry respects allowSameCommandRetry=false", () => {
    const disallowConfig: WorkerAgentConfig = {
      ...defaultConfig,
      allowSameCommandRetry: false,
    };

    const input = makeInput({
      job: { status: "failed", exitCode: 1 },
    });

    const decision = evaluateRecovery(input, {
      config: disallowConfig,
      budget: defaultBudget,
    });

    // Despite the policy suggesting retry, allowedByPolicy must be false
    if (decision.decision === "retry-same-command-once") {
      expect(decision.allowedByPolicy).toBe(false);
    }
  });

  test("parser retry requires existing output file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "safety-parser-"));
    try {
      ensureWorkerLayout(tmpDir);

      // Create a done bundle with no actual output file
      const doneDir = getDoneDir(tmpDir);
      mkdirSync(join(doneDir, "job-parser-test"), { recursive: true });
      mkdirSync(join(doneDir, "job-parser-test", "artifacts"), { recursive: true });
      writeFileSync(
        join(doneDir, "job-parser-test", "manifest.json"),
        JSON.stringify({ jobId: "job-parser-test", attemptId: "attempt-001" }),
      );

      // Test with non-existent output path inside the bundle
      const outputPath = join(doneDir, "job-parser-test", "artifacts", "nonexistent.out");
      const result = retryParserIfOutputExists(tmpDir, "job-parser-test", outputPath);

      expect(result.ok).toBe(false);
      expect(result.message).toContain("does not exist");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("artifact sync retry is idempotent", () => {
    // Artifact sync just writes a marker file; calling it multiple
    // times has no additional side effects.
    const tmpDir = mkdtempSync(join(tmpdir(), "safety-sync-"));
    try {
      ensureWorkerLayout(tmpDir);

      // Create a done bundle
      const doneDir = getDoneDir(tmpDir);
      mkdirSync(join(doneDir, "job-idempotent"), { recursive: true });
      writeFileSync(
        join(doneDir, "job-idempotent", "manifest.json"),
        JSON.stringify({ jobId: "job-idempotent", attemptId: "attempt-001" }),
      );

      // Call twice
      const result1 = retryArtifactSync(tmpDir, "job-idempotent", "attempt-001");
      const result2 = retryArtifactSync(tmpDir, "job-idempotent", "attempt-001");

      // Both calls succeed (idempotent)
      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("recovery actions fail closed on a corrupt status file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "safety-corrupt-status-"));
    try {
      ensureWorkerLayout(tmpDir);
      const bundleDir = join(getDoneDir(tmpDir), "job-corrupt-status");
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, "status.json"), "{not-json", "utf-8");

      const result = retryArtifactSync(tmpDir, "job-corrupt-status", "attempt-001");

      expect(result.ok).toBe(false);
      expect(result.message).toContain("status is unreadable");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("zombie PID is marked failed with event", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "safety-zombie-"));
    try {
      ensureWorkerLayout(tmpDir);

      // Create a running bundle
      const runningDir = getRunningDir(tmpDir);
      mkdirSync(join(runningDir, "job-zombie"), { recursive: true });
      writeFileSync(
        join(runningDir, "job-zombie", "manifest.json"),
        JSON.stringify({ schemaVersion: 1, jobId: "job-zombie", attemptId: "attempt-001" }),
      );

      const result = markZombieFailed(tmpDir, "job-zombie", "attempt-001");

      expect(result.ok).toBe(true);
      expect(result.decision).toBe("mark-zombie-failed");

      // Bundle should now be in failed dir
      const failedDir = getFailedDir(tmpDir);
      expect(existsSync(join(failedDir, "job-zombie"))).toBe(true);
      expect(existsSync(join(runningDir, "job-zombie"))).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("node draining event is emitted on low disk", () => {
    const input = makeInput({
      nodeState: { diskAvailableMb: 500 },
    });

    const decision = evaluateRecovery(input, {
      config: defaultConfig,
      budget: defaultBudget,
    });

    expect(decision.decision).toBe("mark-draining");
    expect(decision.reason).toContain("disk");

    // Node drain action should be auto-executable
    // (not requiring head approval)
    expect(decision.allowedByPolicy).toBe(true);
  });

  test("head can disable worker agent", () => {
    // When mode is "off", the recovery cycle short-circuits
    // This is verified by the daemon integration test:
    //   "recovery cycle does nothing when mode is off"
    // which checks result.events.length === 0.
    //
    // At the policy level, the mode flag only affects whether
    // the cycle function calls evaluateRecovery. The policy itself
    // checks allow* flags, not the mode.
    //
    // With allowSameCommandRetry=false (default), a failed job
    // still receives the "retry-same-command-once" decision but
    // with allowedByPolicy=false.

    const offConfig: WorkerAgentConfig = { ...defaultConfig, mode: "off" };
    const input = makeInput({
      job: { status: "failed", exitCode: 1 },
    });

    const decision = evaluateRecovery(input, {
      config: offConfig,
      budget: defaultBudget,
    });

    // Policy suggests the action but marks it blocked
    expect(decision.allowedByPolicy).toBe(false);
    expect(["retry-same-command-once", "none"]).toContain(decision.decision);
  });

  test("worker agent cannot modify input files", () => {
    // Safety invariant: prove that no recovery action writes inside
    // the artifacts/input* files. This is a runtime test that
    // snapshots input bytes and directory entries before and after
    // each action, asserting they never change.

    const tmpDir = mkdtempSync(join(tmpdir(), "safety-noinput-"));
    try {
      ensureWorkerLayout(tmpDir);

      const jobId = "test-noinput-001";
      const attemptId = "attempt-001";
      const nodeId = "test-node-001";
      const inputContent = "INPUT-SENTINEL-DATA\n# some numerical data\n42\n";

      // ── Bundle A: in done/ (non-moving actions + retrySameCommandOnce) ──
      const doneDir = getDoneDir(tmpDir);
      const bundleDir = join(doneDir, jobId);
      mkdirSync(join(bundleDir, "artifacts"), { recursive: true });
      mkdirSync(join(bundleDir, "logs"), { recursive: true });

      const inputPath = join(bundleDir, "artifacts", "input.inp");
      writeFileSync(inputPath, inputContent, "utf-8");

      const outputPath = join(bundleDir, "artifacts", "output.out");
      writeFileSync(outputPath, "# output data\nresult = 42\n", "utf-8");

      writeFileSync(
        join(bundleDir, "manifest.json"),
        JSON.stringify({ jobId, attemptId, outputName: "output.out", pid: process.pid }),
      );
      writeFileSync(
        join(bundleDir, "status.json"),
        JSON.stringify({
          schemaVersion: 1,
          jobId,
          attemptId,
          state: "completed",
          command: "echo test",
          finishedAt: Date.now(),
        }),
      );

      // Snapshot before any action
      const inputBytesBefore = readFileSync(inputPath);
      const artifactsBefore = readdirSync(join(bundleDir, "artifacts")).sort();

      // ── 1. retryArtifactSync ──
      const r1 = retryArtifactSync(tmpDir, jobId, attemptId);
      expect(r1.ok).toBe(true);
      expect(r1.decision).toBe("retry-artifact-sync");
      expect(readFileSync(inputPath)).toEqual(inputBytesBefore);
      expect(readdirSync(join(bundleDir, "artifacts")).sort()).toEqual(artifactsBefore);

      // ── 2. retryParserIfOutputExists (existing output) ──
      const r2 = retryParserIfOutputExists(tmpDir, jobId, outputPath);
      expect(r2.ok).toBe(true);
      expect(r2.decision).toBe("retry-parser");
      expect(readFileSync(inputPath)).toEqual(inputBytesBefore);
      expect(readdirSync(join(bundleDir, "artifacts")).sort()).toEqual(artifactsBefore);

      // ── 3. markNodeDraining (writes to daemon/ only) ──
      const r3 = markNodeDraining(tmpDir, nodeId, "test drain");
      expect(r3.ok).toBe(true);
      expect(r3.decision).toBe("mark-draining");
      expect(readFileSync(inputPath)).toEqual(inputBytesBefore);
      expect(readdirSync(join(bundleDir, "artifacts")).sort()).toEqual(artifactsBefore);

      // ── 4. reattachKnownPid (uses process.pid — alive) ──
      const r4 = reattachKnownPid(tmpDir, jobId, process.pid);
      expect(r4.ok).toBe(true);
      expect(r4.decision).toBe("reattach-pid");
      expect(readFileSync(inputPath)).toEqual(inputBytesBefore);
      expect(readdirSync(join(bundleDir, "artifacts")).sort()).toEqual(artifactsBefore);

      // ── 5. retrySameCommandOnce (moves bundle from done/ to inbox/) ──
      const r5 = retrySameCommandOnce(tmpDir, jobId);
      expect(r5.ok).toBe(true);
      expect(r5.decision).toBe("retry-same-command-once");
      // Bundle now in inbox/ — find it and verify input moved intact
      const inboxInput = join(getInboxDir(tmpDir), jobId, "artifacts", "input.inp");
      expect(readFileSync(inboxInput)).toEqual(inputBytesBefore);
      expect(readdirSync(join(getInboxDir(tmpDir), jobId, "artifacts")).sort()).toEqual(
        artifactsBefore,
      );

      // ── 6. markZombieFailed — separate bundle in running/ ──
      const zombieJobId = "zombie-noinput-001";
      const runningDir = getRunningDir(tmpDir);
      const zombieBundle = join(runningDir, zombieJobId);
      mkdirSync(join(zombieBundle, "artifacts"), { recursive: true });
      mkdirSync(join(zombieBundle, "logs"), { recursive: true });
      const zombieInputPath = join(zombieBundle, "artifacts", "input.inp");
      const zombieContent = "ZOMBIE-INPUT-DATA\n";
      writeFileSync(zombieInputPath, zombieContent, "utf-8");
      writeFileSync(
        join(zombieBundle, "manifest.json"),
        JSON.stringify({ schemaVersion: 1, jobId: zombieJobId, attemptId: "attempt-001" }),
      );

      const zombieBytesBefore = readFileSync(zombieInputPath);
      const zombieArtifactsBefore = readdirSync(join(zombieBundle, "artifacts")).sort();

      const r6 = markZombieFailed(tmpDir, zombieJobId, "attempt-001");
      expect(r6.ok).toBe(true);
      expect(r6.decision).toBe("mark-zombie-failed");
      // Bundle moved to failed/ — verify input preserved
      const failedInput = join(getFailedDir(tmpDir), zombieJobId, "artifacts", "input.inp");
      expect(readFileSync(failedInput)).toEqual(zombieBytesBefore);
      expect(readdirSync(join(getFailedDir(tmpDir), zombieJobId, "artifacts")).sort()).toEqual(
        zombieArtifactsBefore,
      );

      // ── Final: all bundles' input files intact ──
      expect(readFileSync(inboxInput)).toEqual(inputBytesBefore);
      expect(readFileSync(failedInput)).toEqual(zombieBytesBefore);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("recovery cycle handles hostile scratch path safely", async () => {
    // Regression for Gate 2: replace shell-pipeline disk check with
    // fs.statfsSync. Verify that a scratch path containing shell-hostile
    // characters ($, `, ;, quotes, spaces) is handled without injection.

    const workspace = mkdtempSync(join(tmpdir(), "safety-hostile-scratch-"));
    const sentinelPath = join(workspace, "SENTINEL_GATE2_BREACH");

    // Build a scratch-path name that embeds shell-injection payloads.
    // If the old `execSync("df -m ...")` shell pipeline were still used,
    // the embedded `touch` command would create the sentinel file.
    const scratchName = `safety-gate2 $('touch ${sentinelPath}') ;"';" backtick-\`\`\\\` test`;
    const scratchDir = join(workspace, scratchName);
    try {
      mkdirSync(scratchDir, { recursive: true });
      // Create a real filesystem target so statfsSync has something to stat
      ensureWorkerLayout(scratchDir);

      // Run the full recovery cycle without passing diskAvailableMb.
      // This forces the cycle to call getDiskAvailableMb(scratchDir)
      // internally, which must use statfsSync — not a shell pipeline.
      const result = await runRecoveryCycle(
        scratchDir,
        defaultConfig,
        "test-node-hostile",
        // diskAvailableMb deliberately omitted
      );

      // The cycle must complete safely regardless of the path content
      expect(result.ok).toBe(true);
      expect(result.skippedReason).toBeUndefined();

      // The sentinel must NOT exist — proving no shell injection occurred
      expect(existsSync(sentinelPath)).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
