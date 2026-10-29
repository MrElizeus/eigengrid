import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
/**
 * ORCA local E2E test using Bun.spawn with .cwd() isolation.
 *
 * Uses Bun.spawn() with per-command cwd and env to avoid
 * global process.chdir() and process.env.PATH mutations that leak CWD/env
 * across test files in the full suite.
 *
 * WARNING: Do NOT use process.chdir() or mutate process.env.PATH in tests.
 * These are process-global and leak across concurrent test files.
 */

const context = {
  tmpDir: "",
  fakeOrcaDir: "",
  jobId: "",
};

// Use absolute path to the CLI entry since .cwd() changes subprocess CWD.
const REPO_ROOT = process.cwd();

/**
 * Run the EigenGrid CLI as a subprocess with controlled CWD and env.
 * Uses Bun.spawn directly to avoid path quoting issues with Bun $ template.
 */
async function runCli(
  args: string[],
  opts?: { cwd: string; env?: Record<string, string | undefined> },
): Promise<{ exitCode: number; text: string; stderr: string }> {
  const binPath = require("path").join(REPO_ROOT, "apps", "cli", "bin", "eigengrid.ts");
  const proc = Bun.spawn(["bun", "run", binPath, ...args], {
    cwd: opts?.cwd,
    env: { ...(process.env as Record<string, string>), ...opts?.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Drain both pipes concurrently; retain diagnostics and reap before cleanup.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, 10_000);
  try {
    const [exitCode, text, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (timedOut) throw new Error(`CLI deadline exceeded: ${args[0]}\n${stderr}\n${text}`);
    return { exitCode, text, stderr };
  } finally {
    clearTimeout(timer);
  }
}

describe("ORCA local E2E", () => {
  beforeAll(async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "eigengrid-orca-test-"));
    const fakeOrcaDir = join(tmpDir, "fake-orca");
    context.tmpDir = tmpDir;
    context.fakeOrcaDir = fakeOrcaDir;

    // Create fake ORCA script
    mkdirSync(fakeOrcaDir, { recursive: true });
    writeFileSync(
      join(fakeOrcaDir, "orca"),
      "#!/usr/bin/env bash\n" +
        "# Fake ORCA for testing\n" +
        'input="$1"\n' +
        'output="${2:-/dev/stdout}"\n' +
        'echo "ORCA FAKE RUN: $input" > "$output"\n' +
        'echo "FINAL SINGLE POINT ENERGY -76.000000" >> "$output"\n' +
        'echo "****ORCA TERMINATED NORMALLY****" >> "$output"\n' +
        'echo "Fake ORCA completed successfully"\n',
      { mode: 0o755 },
    );

    // Create ORCA input
    writeFileSync(
      join(tmpDir, "water_sp.inp"),
      "! HF STO-3G SP\n* xyz 0 1\nO 0.000000 0.000000 0.000000\nH 0.000000 0.757000 0.586000\nH 0.000000 -0.757000 0.586000\n*\n",
    );
  });

  afterAll(() => {
    rmSync(context.tmpDir, { recursive: true, force: true });
  });

  const testEnv = (): Record<string, string | undefined> => ({
    PATH: `${context.fakeOrcaDir}:${process.env.PATH ?? ""}`,
  });

  test("submit with fake ORCA creates completed job", async () => {
    const env = testEnv();

    // Step 1: Init
    const init = await runCli(["init"], { cwd: context.tmpDir, env });
    expect(init.exitCode, init.stderr).toBe(0);

    // Step 2: Submit
    const submit = await runCli(
      ["submit", "orca", join(context.tmpDir, "water_sp.inp"), "--runner", "local"],
      { cwd: context.tmpDir, env },
    );
    expect(submit.exitCode, submit.stderr).toBe(0);
    const submitText = submit.text;
    const jobIdMatch = submitText.match(/Created job (\S+)/);
    expect(jobIdMatch).not.toBeNull();
    context.jobId = jobIdMatch![1];

    // Observe completion instead of spending three of the default five seconds
    // sleeping. Each CLI is bounded; this scenario has its own finite deadline.
    const deadline = Date.now() + 10_000;
    let status = await runCli(["status", context.jobId], { cwd: context.tmpDir, env });
    while (!/Status:\s+completed/u.test(status.text) && Date.now() < deadline) {
      expect(status.exitCode, status.stderr).toBe(0);
      await Bun.sleep(100);
      status = await runCli(["status", context.jobId], { cwd: context.tmpDir, env });
    }
    expect(status.exitCode, status.stderr).toBe(0);
    expect(status.text).toMatch(/Status:/);
    expect(status.text).toMatch(/completed/);
    expect(status.text).toMatch(/Command:/);
    expect(status.text).toMatch(/water_sp\.inp/);
    expect(status.text).not.toMatch(/Command:\s+sh\b/);
  }, 45_000);

  test("artifacts command lists job artifacts", async () => {
    expect(context.jobId).not.toBe("");

    const env = testEnv();
    const result = await runCli(["artifacts", context.jobId], { cwd: context.tmpDir, env });
    expect(result.exitCode).toBe(0);
    expect(result.text).toMatch(/Artifacts for job/);
  }, 15_000);

  test("logs command shows job logs", async () => {
    expect(context.jobId).not.toBe("");

    const env = testEnv();
    const result = await runCli(["logs", context.jobId], { cwd: context.tmpDir, env });
    expect(result.exitCode).toBe(0);
    expect(result.text).toMatch(/Logs for job/);
    expect(result.text).not.toMatch(/No log files found/);
  }, 15_000);

  test("events command shows lifecycle events in order", async () => {
    expect(context.jobId).not.toBe("");

    const env = testEnv();
    const result = await runCli(["events", context.jobId], { cwd: context.tmpDir, env });
    expect(result.exitCode).toBe(0);
    expect(result.text).toMatch(/Event Log for job/);
    expect(result.text).toMatch(/job\.created/);
    expect(result.text).toMatch(/recipe\.selected/);
    expect(result.text).toMatch(/attempt\.created/);
    expect(result.text).toMatch(/process\.started/);
    expect(result.text).toMatch(/process\.completed/);
    expect(result.text).toMatch(/artifact\.registered/);
  }, 15_000);

  test("timeline command shows human-readable lifecycle", async () => {
    expect(context.jobId).not.toBe("");

    const env = testEnv();
    const result = await runCli(["timeline", context.jobId], { cwd: context.tmpDir, env });
    expect(result.exitCode).toBe(0);
    expect(result.text).toMatch(/Timeline for job/);
    expect(result.text).toMatch(/job\.created/);
    expect(result.text).toMatch(/recipe\.selected/);
    expect(result.text).toMatch(/attempt\.created/);
    expect(result.text).toMatch(/process\.started/);
    expect(result.text).toMatch(/process\.completed/);
    expect(result.text).toMatch(/artifact\.registered/);
  }, 15_000);
});
