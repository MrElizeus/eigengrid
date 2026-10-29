import { describe, expect, test } from "bun:test";
import { runContendingProcesses } from "./helpers/process-contention";

describe("contention process harness", () => {
  test("releases every ready process and preserves all outcomes", async () => {
    const outcomes = await runContendingProcesses(
      3,
      `
      process.stdout.write("ready\\n");
      await Bun.stdin.text();
      process.stdout.write("done");
    `,
      {},
    );
    expect(outcomes).toEqual(
      Array.from({ length: 3 }, () => ({ stdout: "done", stderr: "", exitCode: 0 })),
    );
  });

  for (const phase of ["startup", "contention"] as const) {
    test(`kills and reaps every child on ${phase} timeout`, async () => {
      const pids: number[] = [];
      const source =
        phase === "startup"
          ? "await Bun.sleep(60_000);"
          : `process.stdout.write("ready\\n"); await Bun.stdin.text(); await Bun.sleep(60_000);`;
      await expect(
        runContendingProcesses(3, source, {}, { timeoutMs: 300, onSpawn: (pid) => pids.push(pid) }),
      ).rejects.toThrow("round timed out");
      expect(pids).toHaveLength(3);
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    });
  }

  test("rejects malformed/early-exit contenders and reaps their siblings", async () => {
    const pids: number[] = [];
    await expect(
      runContendingProcesses(
        3,
        "process.stdout.write('invalid\\n');",
        {},
        { onSpawn: (pid) => pids.push(pid) },
      ),
    ).rejects.toThrow("startup message");
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  });
});
