import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runCommand, spawnCommand } from "@eigengrid/runners";

describe("process-utils argv execution", () => {
  const childScript = "process.stdout.write(process.argv[1])";

  test.skipIf(process.platform === "win32")(
    "timeout terminates descendants holding output pipes",
    async () => {
      const start = performance.now();
      const result = await runCommand("/bin/sh", ["-c", "sleep 15 & wait"], { timeout: 100 });
      expect(result.timedOut).toBe(true);
      expect(performance.now() - start).toBeLessThan(4500);
    },
    6000,
  );

  test.skipIf(process.platform === "win32")(
    "abort escalates for a child that ignores SIGTERM",
    async () => {
      const controller = new AbortController();
      const handle = spawnCommand("/bin/sh", ["-c", "trap '' TERM; sleep 15 & wait"], {
        signal: controller.signal,
        disableTimeout: true,
      });
      await Bun.sleep(100);
      const start = performance.now();
      controller.abort();
      const result = await handle.result;
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).not.toBe(0);
      expect(performance.now() - start).toBeLessThan(4500);
    },
    6000,
  );

  test.skipIf(process.platform === "win32")(
    "drainage is bounded when a descendant escapes the owned group",
    async () => {
      const script = `const {spawn}=require('node:child_process');
      const child=spawn('/bin/sh',['-c','sleep 15'],{detached:true,stdio:'inherit'});
      console.log(child.pid); setInterval(()=>{},1000);`;
      const start = performance.now();
      const result = await runCommand(process.execPath, ["-e", script], { timeout: 300 });
      const descendant = Number(result.stdout.trim());
      try {
        expect(result.timedOut).toBe(true);
        expect(performance.now() - start).toBeLessThan(4500);
        expect(Number.isSafeInteger(descendant) && descendant > 1).toBe(true);
      } finally {
        if (Number.isSafeInteger(descendant) && descendant > 1) {
          try {
            process.kill(-descendant, "SIGKILL");
          } catch {}
        }
      }
    },
    6000,
  );

  test("spawnCommand settles promptly when the executable is missing", async () => {
    const executable = "definitely-not-installed-eigengrid-process-utils";
    const result = await Promise.race([
      spawnCommand(executable).result,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("spawnCommand timed out")), 1_000),
      ),
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(executable);
    expect(result.stderr).toContain("ENOENT");
  });

  test("spawnCommand can delegate timeout ownership without scheduling a parent kill", async () => {
    const result = await spawnCommand(process.execPath, ["-e", "setTimeout(() => {}, 50)"], {
      timeout: 1,
      disableTimeout: true,
    }).result;

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test("runCommand settles promptly when the executable is missing", async () => {
    const executable = "definitely-not-installed-eigengrid-process-utils";
    const result = await Promise.race([
      runCommand(executable),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("runCommand timed out")), 1_000),
      ),
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(executable);
    expect(result.stderr).toContain("ENOENT");
  });

  test("runCommand preserves shell metacharacters as one argument without execution", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "eigengrid-process-security-"));
    const sentinel = join(tempDir, "run-sentinel");
    const argument = `unchanged; touch ${sentinel}; $(touch ${sentinel}-sub); \`touch ${sentinel}-backtick\``;

    try {
      const result = await runCommand(process.execPath, ["-e", childScript, argument]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(argument);
      expect(existsSync(sentinel)).toBe(false);
      expect(existsSync(`${sentinel}-sub`)).toBe(false);
      expect(existsSync(`${sentinel}-backtick`)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("spawnCommand preserves shell metacharacters as one argument without execution", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "eigengrid-process-security-"));
    const sentinel = join(tempDir, "spawn-sentinel");
    const argument = `unchanged; touch ${sentinel}; $(touch ${sentinel}-sub); \`touch ${sentinel}-backtick\``;

    try {
      const result = await spawnCommand(process.execPath, ["-e", childScript, argument]).result;

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(argument);
      expect(existsSync(sentinel)).toBe(false);
      expect(existsSync(`${sentinel}-sub`)).toBe(false);
      expect(existsSync(`${sentinel}-backtick`)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("rlimit wrapper passes command arguments positionally", async () => {
    const argument = "literal; $(not-executed) `nor-this`";
    const result = await runCommand(process.execPath, ["-e", childScript, argument], {
      maxFileSize: 1024 * 1024,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(argument);
  });
});
