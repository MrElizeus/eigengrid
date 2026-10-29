import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

// Skip these tests unless EIGENGRID_ENABLE_ORCA_E2E=1
const hasOrca = process.env.EIGENGRID_ENABLE_ORCA_E2E === "1";
const CLI_ENTRY = resolve(import.meta.dir, "../../apps/cli/bin/eigengrid.ts");
const PYTHON_SOURCE = resolve(import.meta.dir, "../../python/src");
const REPOSITORY_VENV_PYTHON = resolve(import.meta.dir, "../../.venv/bin/python");
const TEST_PYTHON =
  process.env.EIGENGRID_TEST_PYTHON ??
  (existsSync(REPOSITORY_VENV_PYTHON) ? REPOSITORY_VENV_PYTHON : "python");

async function runCli(
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
    cwd,
    env: {
      ...process.env,
      PYTHONPATH: process.env.PYTHONPATH
        ? `${PYTHON_SOURCE}:${process.env.PYTHONPATH}`
        : PYTHON_SOURCE,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe.skipIf(!hasOrca)("ORCA real E2E", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "eigengrid-orca-real-"));

  beforeAll(() => {
    // Create ORCA input file for a minimal water single-point calculation
    writeFileSync(
      join(tmpDir, "water_sp.inp"),
      [
        "! HF STO-3G SP",
        "* xyz 0 1",
        "O 0.000000 0.000000 0.000000",
        "H 0.000000 0.757000 0.586000",
        "H 0.000000 -0.757000 0.586000",
        "*",
      ].join("\n") + "\n",
    );
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("real ORCA submit, status, logs, and artifacts", async () => {
    // Step 1: Init
    const initResult = await runCli(tmpDir, ["init", "--python", TEST_PYTHON]);
    expect(initResult.exitCode, initResult.stderr).toBe(0);

    // Step 2: Submit
    const submitResult = await runCli(tmpDir, [
      "submit",
      "orca",
      join(tmpDir, "water_sp.inp"),
      "--runner",
      "local",
    ]);
    expect(submitResult.exitCode, submitResult.stderr).toBe(0);

    const submitText = submitResult.stdout;
    expect(submitText).toMatch(/Created job/);

    const jobIdMatch = submitText.match(/Created job (\w+)/);
    expect(jobIdMatch).not.toBeNull();
    const jobId = jobIdMatch![1];

    // Step 3: Poll status through the restart-safe reconciliation path.
    let statusText = "";
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const statusResult = await runCli(tmpDir, ["status", jobId]);
      expect(statusResult.exitCode, statusResult.stderr).toBe(0);
      statusText = statusResult.stdout;
      if (/completed|failed/iu.test(statusText)) break;
      await Bun.sleep(500);
    }
    expect(statusText).toMatch(/Status:/);
    expect(statusText).toMatch(/completed/);

    // Step 4: Check logs
    const logsResult = await runCli(tmpDir, ["logs", jobId]);
    expect(logsResult.exitCode, logsResult.stderr).toBe(0);
    const logsText = logsResult.stdout;
    expect(logsText).toMatch(/Logs for job/);

    // Step 5: Check artifacts
    const artifactsResult = await runCli(tmpDir, ["artifacts", jobId]);
    expect(artifactsResult.exitCode, artifactsResult.stderr).toBe(0);

    // Step 6: Parse the real scientific output and inspect persisted results.
    const collectResult = await runCli(tmpDir, ["collect", jobId]);
    expect(collectResult.exitCode, collectResult.stderr).toBe(0);
    expect(collectResult.stdout).toContain("Collected");

    const parseResult = await runCli(tmpDir, ["parse", jobId]);
    expect(parseResult.exitCode, parseResult.stderr).toBe(0);
    expect(parseResult.stdout).toContain("Parse completed");
    expect(parseResult.stdout).toMatch(/Parser:\s+orca/iu);

    const resultsResult = await runCli(tmpDir, ["results", jobId, "--json"]);
    expect(resultsResult.exitCode, resultsResult.stderr).toBe(0);
    const parsed = JSON.parse(resultsResult.stdout) as Record<string, unknown>;
    expect(parsed.parser).toBe("orca");
    expect(parsed.normalTermination).toBe(true);
    expect(parsed.scfConverged).toBe(true);
    expect(typeof parsed.energyHartree).toBe("number");
    expect(parsed.energyHartree as number).toBeLessThan(0);
  });
});
