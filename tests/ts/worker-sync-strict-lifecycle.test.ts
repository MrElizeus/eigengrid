import { describe, expect, test } from "bun:test";
import { WorkerSyncService } from "../../apps/cli/src/services/worker-sync-service";

describe("worker sync authoritative lifecycle", () => {
  test("production/default executor requires configured host identity", () => {
    const service = new WorkerSyncService({} as never, { jobsDir: "/tmp/jobs" } as never);
    expect(() => (service as unknown as { sshOptions(): string[] }).sshOptions()).toThrow(
      /host identity/,
    );
  });

  test("rejects an unsafe configured remote scratch path before SSH", async () => {
    const calls: string[] = [];
    const db = {
      resolveNodeId: async () => "node-1",
      getNode: async () => ({
        host: "worker.test",
        user: "eigengrid",
        remoteScratchDir: "/scratch/eigengrid;touch /tmp/pwned",
      }),
    };
    const executor = {
      run: async (command: string) => {
        calls.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    } as never;
    const service = new WorkerSyncService(db as never, { jobsDir: "/tmp/jobs" } as never, executor);

    const result = await service.syncNode("node-1");

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("Unsafe worker remote scratch directory");
    expect(calls).toEqual([]);
  });

  test("rejects hostile bundle names returned by a worker", async () => {
    const calls: string[] = [];
    const db = {
      resolveNodeId: async () => "node-1",
      getNode: async () => ({
        host: "worker.test",
        user: "eigengrid",
        remoteScratchDir: "/scratch/eigengrid",
      }),
    };
    const executor = {
      run: async (command: string, args: string[]) => {
        calls.push(`${command} ${args.at(-1) ?? ""}`);
        return {
          exitCode: 0,
          stdout: command === "ssh" ? "../escape;touch\n" : "",
          stderr: "",
        };
      },
    } as never;
    const service = new WorkerSyncService(db as never, { jobsDir: "/tmp/jobs" } as never, executor);

    const result = await service.syncNode("node-1");

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("Unsafe worker job identifier");
    expect(calls).toHaveLength(2);
  });
});
