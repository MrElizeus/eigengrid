import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Child processes isolate Ink, the catalog cache and provider configuration from other tests.
for (const command of ["/connect", "/conn", "/providers", "/pro", "/", " /CONNECT "]) {
  test(`provider picker supports navigation and selection from ${JSON.stringify(command)}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "eigengrid-provider-picker-"));
    mkdirSync(join(directory, ".eigengrid"), { mode: 0o700 });
    try {
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "fixtures/provider-navigation.tsx"), command],
        {
          cwd: directory,
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            EIGENGRID_AUTH_DIR: join(directory, "auth"),
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
  }, 10000);
}
