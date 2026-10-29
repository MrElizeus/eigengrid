import { describe, expect, test } from "bun:test";
import { BunExecutor } from "@eigengrid/slurm";

describe("bounded Slurm CLI subprocesses (real processes)", () => {
  test("supervised backend children can inherit only their already-isolated parent group", async () => {
    const query = [
      "-I",
      "-c",
      "import os,json; print(json.dumps([os.getpid(),os.getpgrp(),os.getpgid(os.getppid())]))",
    ];
    const isolated = await new BunExecutor().run("/usr/bin/python3", query);
    const own = JSON.parse(isolated.stdout);
    expect(own[0]).toBe(own[1]);
    expect(own[1]).not.toBe(own[2]);
    const inherited = await new BunExecutor("parent").run("/usr/bin/python3", query);
    const shared = JSON.parse(inherited.stdout);
    expect(shared[0]).not.toBe(shared[1]);
    expect(shared[1]).toBe(shared[2]);
  });

  test("sends exact stdin, cwd and replacement environment without shell interpolation", async () => {
    const result = await new BunExecutor().run(
      "/usr/bin/python3",
      [
        "-I",
        "-c",
        "import os,sys,json; print(json.dumps(dict(data=sys.stdin.buffer.read().hex(),cwd=os.getcwd(),env=dict(os.environ))))",
      ],
      {
        stdin: Buffer.from("one\0two' $(false) á"),
        cwd: "/tmp",
        inheritEnv: false,
        env: { LC_ALL: "C", SAFE: "$(touch INJECTED),one\ntwo" },
        timeout: 5_000,
      },
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.data).toBe(Buffer.from("one\0two' $(false) á").toString("hex"));
    expect(payload.cwd).toBe("/tmp");
    expect(payload.env).toEqual({ LC_ALL: "C", SAFE: "$(touch INJECTED),one\ntwo" });
    expect(result.timedOut).toBe(false);
  });

  test("kills a SIGTERM-ignoring process within the deadline", async () => {
    const start = Date.now();
    const result = await new BunExecutor().run(
      "/usr/bin/python3",
      [
        "-I",
        "-c",
        "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); print('ready',flush=True); time.sleep(30)",
      ],
      { timeout: 200 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe("ready");
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - start).toBeLessThan(3_000);
  });

  test("parent exit does not cancel the deadline while a descendant holds stdout", async () => {
    const start = Date.now();
    const result = await new BunExecutor().run(
      "/usr/bin/python3",
      ["-I", "-c", "import os,time; child=os.fork(); time.sleep(30) if child==0 else os._exit(0)"],
      { timeout: 200 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - start).toBeLessThan(3_000);
  });

  test("bounds high-volume output from a child ignoring ordinary termination", async () => {
    const result = await new BunExecutor().run(
      "/usr/bin/python3",
      [
        "-I",
        "-c",
        "import os,signal; signal.signal(signal.SIGTERM,signal.SIG_IGN); os.write(1,b'x'*1048576)",
      ],
      { timeout: 2_000, maxOutputBytes: 17 },
    );
    expect(result.stdout).toBe("x".repeat(17));
    expect(result.stdoutTruncated).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  test("rejects invalid limits before a subprocess can start", async () => {
    for (const options of [
      { timeout: 0 },
      { timeout: NaN },
      { timeout: Infinity },
      { timeout: 300_001 },
      { maxOutputBytes: -1 },
      { maxErrorBytes: 0.5 },
    ]) {
      await expect(
        new BunExecutor().run("/unreachable-should-never-spawn", [], options),
      ).rejects.toThrow("execution limit");
    }
  });
});
