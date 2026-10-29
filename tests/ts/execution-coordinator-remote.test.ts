import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Runner } from "@eigengrid/runners";
import { ExecutionCoordinator } from "../../apps/cli/src/services/execution-coordinator";

const temporaryJobRoots: string[] = [];
afterEach(() => {
  for (const directory of temporaryJobRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function coordinator(db: any): ExecutionCoordinator {
  return new ExecutionCoordinator({
    db,
    config: { jobsDir: db.workdir } as any,
    recipes: { recipes: [], find: () => undefined, findRunnable: () => undefined },
    clock: () => 1,
    idGenerator: (prefix: string) => `${prefix}-1`,
    localBackendFactory: () => {
      throw new Error("local backend not used");
    },
  });
}

function dbWithJob(workdir?: string) {
  if (workdir === undefined) {
    workdir = mkdtempSync(join(tmpdir(), "eigengrid-remote-job-"));
    temporaryJobRoots.push(workdir);
  }
  return {
    workdir,
    async resolveJobId(id: string) {
      return id;
    },
    async getJob(id: string) {
      return {
        id,
        name: "job",
        software: "unknown",
        inputPath: join(workdir, "input"),
        workdir,
        outputPath: null,
        status: "queued",
        createdAt: 1,
        updatedAt: 1,
      };
    },
    async listJobAttempts() {
      return [];
    },
  };
}

function remote(overrides: Partial<Runner> = {}): Runner {
  return {
    kind: "slurm",
    stage: async () => ({ ok: true }),
    start: async () => ({ ok: true, message: "started" }),
    status: async () => ({ status: "running", message: "running" }),
    stop: async () => ({ ok: true, message: "cancelled" }),
    fetch: async () => ({ ok: true, message: "collected" }),
    ...overrides,
  };
}

describe("ExecutionCoordinator remote boundary", () => {
  test("owns stage/start ordering and rejects local runners", async () => {
    const calls: string[] = [];
    const runner = remote({
      stage: async () => {
        calls.push("stage");
        return { ok: true };
      },
      start: async () => {
        calls.push("start");
        return { ok: true, message: "started" };
      },
    });
    const result = await coordinator(dbWithJob()).dispatchRemote("job-1", runner);
    expect(result).toMatchObject({ ok: true, status: "running" });
    expect(calls).toEqual(["stage", "start"]);
    expect(
      await coordinator(dbWithJob()).dispatchRemote("job-1", remote({ kind: "local" })),
    ).toMatchObject({ ok: false });
  });

  test("preserves ambiguous start and routes cancel/collect through one runner", async () => {
    const calls: string[] = [];
    const runner = remote({
      start: async () => ({
        ok: false,
        failureDisposition: "termination-unknown" as const,
        message: "timeout",
      }),
      stop: async () => {
        calls.push("stop");
        return { ok: true, message: "cancelled" };
      },
      fetch: async () => {
        calls.push("fetch");
        return { ok: true, message: "collected" };
      },
    });
    const coord = coordinator(dbWithJob());
    expect(await coord.dispatchRemote("job-1", runner)).toMatchObject({
      ok: false,
      status: "safely-unknown",
    });
    expect(await coord.cancelRemote("job-1", runner)).toMatchObject({ ok: true });
    expect(await coord.collectRemote("job-1", runner)).toMatchObject({ ok: true });
    expect(calls).toEqual(["stop", "fetch"]);
  });

  test("fences concurrent remote dispatches for the same job", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "eigengrid-dispatch-fence-"));
    try {
      const db1 = dbWithJob(workdir);
      const db2 = dbWithJob(workdir);
      let releaseStage!: () => void;
      const stageBlocked = new Promise<void>((resolve) => {
        releaseStage = resolve;
      });
      let stageCalls = 0;
      const firstRunner = remote({
        stage: async () => {
          stageCalls++;
          await stageBlocked;
          return { ok: true };
        },
      });
      const secondRunner = remote();
      const first = coordinator(db1).dispatchRemote("job-1", firstRunner);
      await Promise.resolve();
      const second = await coordinator(db2).dispatchRemote("job-1", secondRunner);

      expect(second).toMatchObject({ ok: false, status: "safely-unknown" });
      expect(second.message).toContain("dispatch is in progress");
      expect(stageCalls).toBe(1);

      releaseStage();
      await expect(first).resolves.toMatchObject({ ok: true, status: "running" });
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
