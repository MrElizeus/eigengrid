import { describe, expect, test } from "bun:test";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventEmitter } from "events";
import {
  ensureWorkerLayout,
  createStopController,
  runDaemon,
  runOnce,
  getInboxDir,
  getDoneDir,
} from "@eigengrid/worker";
import type { SpawnAdapter } from "@eigengrid/worker";

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

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
    resources: {
      cores: 1,
      memoryGb: 1,
    },
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
  manifestOverrides: Partial<Record<string, unknown>> = {},
): string {
  const bundleDir = join(inboxDir, jobId);
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(
    join(bundleDir, "manifest.json"),
    JSON.stringify(validManifest({ jobId, ...manifestOverrides })),
  );
  const manifest = validManifest({ jobId, ...manifestOverrides });
  mkdirSync(join(bundleDir, "input"));
  writeFileSync(join(bundleDir, "input", manifest.inputName as string), "staged input");
  writeFileSync(join(bundleDir, "READY"), "");
  return bundleDir;
}

// ────────────────────────────────────────────────────────────
// runOnce Tests
// ────────────────────────────────────────────────────────────

describe("runOnce", () => {
  test("returns {processed: 0} when inbox is empty", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-daemon-"));
    try {
      ensureWorkerLayout(tmpDir);
      const result = await runOnce(tmpDir);
      expect(result.ok).toBe(true);
      expect(result.processed).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("processes one ready bundle when one exists", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-daemon-"));
    try {
      ensureWorkerLayout(tmpDir);
      createReadyBundle(getInboxDir(tmpDir), "job-runonce-001");
      const calls: Array<[string, string[], { shell?: boolean }]> = [];

      const result = await runOnce(tmpDir, deterministicSpawn(calls));
      expect(result.ok).toBe(true);
      expect(result.processed).toBe(1);

      // Bundle should have moved to done
      expect(existsSync(join(getDoneDir(tmpDir), "job-runonce-001"))).toBe(true);

      // Bundle should no longer be in inbox
      expect(existsSync(join(getInboxDir(tmpDir), "job-runonce-001"))).toBe(false);

      // The executor creates the expected log layout.
      const doneBundle = join(getDoneDir(tmpDir), "job-runonce-001");
      const stdoutPath = join(doneBundle, "logs", "stdout.log");
      expect(existsSync(stdoutPath)).toBe(true);
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

  test("materializes staged input for the default spawn before moving to done", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-daemon-e2e-"));
    const originalPath = process.env.PATH;
    try {
      ensureWorkerLayout(tmpDir);
      const binDir = join(tmpDir, "bin");
      mkdirSync(binDir);
      const orca = join(binDir, "orca");
      writeFileSync(orca, '#!/bin/sh\ncat "$1"\n');
      chmodSync(orca, 0o755);
      process.env.PATH = `${binDir}:${originalPath}`;
      createReadyBundle(getInboxDir(tmpDir), "job-e2e");
      const inboxBundle = join(getInboxDir(tmpDir), "job-e2e");
      writeFileSync(join(inboxBundle, "input", "input.inp"), "distinctive staged input\n");

      expect(await runOnce(tmpDir)).toMatchObject({ ok: true, processed: 1 });
      const done = join(getDoneDir(tmpDir), "job-e2e");
      expect(readFileSync(join(done, "input", "input.inp"), "utf8")).toBe(
        "distinctive staged input\n",
      );
      expect(readFileSync(join(done, "work", "input.inp"), "utf8")).toBe(
        "distinctive staged input\n",
      );
      expect(readFileSync(join(done, "work", "input.out"), "utf8")).toBe(
        "distinctive staged input\n",
      );
    } finally {
      process.env.PATH = originalPath;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns processed:0 when claim fails (invalid manifest)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-daemon-"));
    try {
      ensureWorkerLayout(tmpDir);
      const inboxDir = getInboxDir(tmpDir);

      // Create bundle with invalid manifest
      const bundleDir = join(inboxDir, "job-invalid");
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify({ invalid: "manifest" }));
      writeFileSync(join(bundleDir, "READY"), "");

      const result = await runOnce(tmpDir);
      expect(result.ok).toBe(false);
      expect(result.processed).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────
// runDaemon Tests
// ────────────────────────────────────────────────────────────

describe("runDaemon", () => {
  test("can be stopped via stop controller", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-daemon-"));
    try {
      ensureWorkerLayout(tmpDir);

      const controller = createStopController();
      const daemonPromise = runDaemon(
        {
          scratchDir: tmpDir,
          pollIntervalMs: 100,
          maxConcurrent: 2,
        },
        controller,
      );

      // Let the daemon start and poll once
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Stop the daemon
      controller.stop();

      const state = await daemonPromise;
      expect(state.running).toBe(false);
      expect(state.startedAt).toBeGreaterThan(0);
      expect(state.processedCount).toBe(0);
      expect(state.activeCount).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("processes a ready bundle when one exists", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-daemon-"));
    try {
      ensureWorkerLayout(tmpDir);

      // Create a ready bundle BEFORE starting the daemon
      createReadyBundle(getInboxDir(tmpDir), "job-daemon-001");
      const calls: Array<[string, string[], { shell?: boolean }]> = [];

      const controller = createStopController();
      const daemonPromise = runDaemon(
        {
          scratchDir: tmpDir,
          pollIntervalMs: 50,
          maxConcurrent: 2,
          spawnAdapter: deterministicSpawn(calls),
        },
        controller,
      );

      // Wait for the daemon to discover and process the bundle
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Stop the daemon
      controller.stop();

      const state = await daemonPromise;

      // The daemon should have processed the bundle
      expect(state.processedCount).toBe(1);

      // Bundle should be in done directory
      const donePath = join(getDoneDir(tmpDir), "job-daemon-001");
      expect(existsSync(donePath)).toBe(true);

      // Bundle should NOT still be in inbox
      expect(existsSync(join(getInboxDir(tmpDir), "job-daemon-001"))).toBe(false);

      // The executor creates the expected log layout.
      const stdoutPath = join(donePath, "logs", "stdout.log");
      expect(existsSync(stdoutPath)).toBe(true);
      expect(calls).toEqual([
        [
          "sh",
          expect.arrayContaining(["input.inp", "input.out"]),
          expect.objectContaining({ shell: false }),
        ],
      ]);

      // exit.status should be 0
      const exitStatusPath = join(donePath, "exit.status");
      expect(existsSync(exitStatusPath)).toBe(true);
      const exitCode = parseInt(readFileSync(exitStatusPath, "utf-8").trim(), 10);
      expect(exitCode).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("processes multiple bundles up to maxConcurrent", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-daemon-"));
    try {
      ensureWorkerLayout(tmpDir);

      // Create two ready bundles
      createReadyBundle(getInboxDir(tmpDir), "job-daemon-002");
      createReadyBundle(getInboxDir(tmpDir), "job-daemon-003");
      const calls: Array<[string, string[], { shell?: boolean }]> = [];

      const controller = createStopController();
      const daemonPromise = runDaemon(
        {
          scratchDir: tmpDir,
          pollIntervalMs: 50,
          maxConcurrent: 4,
          spawnAdapter: deterministicSpawn(calls),
        },
        controller,
      );

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 1000));

      controller.stop();
      const state = await daemonPromise;

      // Both should have been processed
      expect(state.processedCount).toBe(2);

      // Both should be in done
      expect(existsSync(join(getDoneDir(tmpDir), "job-daemon-002"))).toBe(true);
      expect(existsSync(join(getDoneDir(tmpDir), "job-daemon-003"))).toBe(true);
      expect(calls).toHaveLength(2);
      expect(
        calls.every(
          ([program, args, options]) =>
            program === "sh" &&
            args.includes("input.inp") &&
            args.includes("input.out") &&
            options.shell === false,
        ),
      ).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("throws if daemon directory does not exist", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-daemon-"));
    try {
      // Do NOT call ensureWorkerLayout — daemon dir will be missing
      const controller = createStopController();

      // Wrap in a function since the error might be thrown or the promise rejected
      let threw = false;
      try {
        const promise = runDaemon(
          {
            scratchDir: tmpDir,
            pollIntervalMs: 100,
            maxConcurrent: 2,
          },
          controller,
        );
        // Stop immediately to avoid hang
        setTimeout(() => controller.stop(), 10);
        await promise;
      } catch (e) {
        threw = true;
        expect((e as Error).message).toContain("layout not initialized");
      }
      expect(threw).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
