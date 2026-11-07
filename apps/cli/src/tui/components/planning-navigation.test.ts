import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("planning questions, free text, persistent mode, execution boundary and cancellation work in the TUI", async () => {
  const directory = mkdtempSync(join(tmpdir(), "eigengrid-planning-ui-"));
  mkdirSync(join(directory, ".eigengrid"), { mode: 0o700 });
  try {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "fixtures/planning-navigation.tsx")],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          EIGENGRID_PERMISSIONS_DIR: join(directory, "private-policy"),
          EIGENGRID_DB_PROVIDER: "sqlite",
          EIGENGRID_DB_PATH: join(directory, "test.sqlite"),
          NO_COLOR: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
