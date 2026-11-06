import { expect, test } from "bun:test";
import { join } from "node:path";

test("interactive repaint keeps transcript rows unique and the composer below a bounded tool tail", async () => {
  // Ink intentionally suppresses interactive repaints in CI. Exercise its real
  // interactive path in a separate process without altering the main test environment.
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "fixtures/incremental-render.tsx")],
    {
      env: { PATH: process.env.PATH, CI: "0", NO_COLOR: "1" },
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
}, 10000);
