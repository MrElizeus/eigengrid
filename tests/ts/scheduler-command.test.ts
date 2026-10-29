import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

describe("scheduler command", () => {
  test("run --once opens database and reports no dispatch decisions when queue empty", () => {
    const workspace = mkdtempSync(join(tmpdir(), "eigengrid-scheduler-run-"));
    const databasePath = join(workspace, "scheduler.sqlite");
    workspaces.push(workspace);

    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        join(import.meta.dir, "../../apps/cli/bin/eigengrid.ts"),
        "scheduler",
        "run",
        "--once",
      ],
      cwd: workspace,
      env: { ...process.env, EIGENGRID_DB_PATH: databasePath },
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
    expect(result.exitCode).toBe(0);
    expect(output).toContain("No dispatch decisions");
    expect(existsSync(databasePath)).toBe(true);
  });

  test("run without --once prints error and exits 1", () => {
    const workspace = mkdtempSync(join(tmpdir(), "eigengrid-scheduler-run-"));
    const databasePath = join(workspace, "scheduler.sqlite");
    workspaces.push(workspace);

    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        join(import.meta.dir, "../../apps/cli/bin/eigengrid.ts"),
        "scheduler",
        "run",
      ],
      cwd: workspace,
      env: { ...process.env, EIGENGRID_DB_PATH: databasePath },
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
    expect(result.exitCode).toBe(1);
    expect(output).toContain("--once is required");
  });
});
