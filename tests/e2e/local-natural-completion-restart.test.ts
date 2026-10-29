import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplicationContext } from "../../apps/cli/src/composition/context";
import { durableExitStatusPath, receiptPath } from "@eigengrid/runners";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for durable completion evidence");
    await Bun.sleep(20);
  }
}

describe("local natural completion after launcher restart", () => {
  test("a new ApplicationContext reconciles exactly one detached execution", async () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-natural-restart-"));
    roots.push(root);
    const binDir = join(root, "bin");
    const jobsDir = join(root, "jobs");
    const databasePath = join(root, "eigengrid.db");
    const inputPath = join(root, "water.xyz");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(jobsDir, { recursive: true });
    writeFileSync(inputPath, "3\nwater\nO 0 0 0\nH 0 0 1\nH 1 0 0\n");

    const fixtureOutput = join(root, "xtb-success.out");
    writeFileSync(
      fixtureOutput,
      [
        "Method: GFN2-xTB",
        "TOTAL ENERGY = -5.070544 Eh",
        "VIBRATIONAL FREQUENCIES",
        " mode freq(cm^-1) int.(km/mol)",
        " 1 1600.0 2.0",
        " 2 3650.0 3.0",
        " normal termination of xtb",
        "",
      ].join("\n"),
    );
    const xtb = join(binDir, "xtb");
    writeFileSync(xtb, '#!/bin/sh\nsleep 1\ncat "$EIGENGRID_XTB_FIXTURE"\n', { mode: 0o700 });
    chmodSync(xtb, 0o700);

    const launcher = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../fixtures/durable-local-launcher.ts"),
        databasePath,
        jobsDir,
        inputPath,
      ],
      {
        cwd: join(import.meta.dir, "../.."),
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          EIGENGRID_XTB_FIXTURE: fixtureOutput,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdoutPromise = new Response(launcher.stdout).text();
    const stderrPromise = new Response(launcher.stderr).text();
    const exitCode = await launcher.exited;
    const stdout = await stdoutPromise;
    const stderr = await stderrPromise;
    expect(exitCode, stderr).toBe(0);

    const launched = JSON.parse(stdout.trim()) as {
      ok: boolean;
      jobId: string;
      attemptId: string;
    };
    expect(launched.ok).toBe(true);
    const jobDir = join(jobsDir, launched.jobId);
    expect(existsSync(durableExitStatusPath(jobDir, launched.attemptId))).toBe(false);
    expect(existsSync(receiptPath(jobDir, launched.attemptId))).toBe(false);

    await waitFor(() => existsSync(durableExitStatusPath(jobDir, launched.attemptId)));
    const restarted = await createApplicationContext({
      config: { databasePath, jobsDir, dbProvider: "sqlite" },
    });
    try {
      const reconciled = await restarted.execution.reconcileLocal(
        launched.jobId,
        launched.attemptId,
      );
      expect(reconciled.status).toBe("completed");
      expect(reconciled.receipt?.exitCode).toBe(0);
      expect(existsSync(receiptPath(jobDir, launched.attemptId))).toBe(true);

      const repeated = await restarted.execution.reconcileLocal(launched.jobId, launched.attemptId);
      expect(repeated.status).toBe("completed");
      expect((await restarted.db.listJobAttempts(launched.jobId)).length).toBe(1);

      const collected = await restarted.execution.collectLocal(launched.jobId);
      expect(collected.ok).toBe(true);
      const artifacts = await restarted.db.listArtifacts(launched.jobId);
      expect(artifacts.filter((artifact) => artifact.kind === "output")).toHaveLength(1);
    } finally {
      await restarted.close();
    }
  });
});
