import { describe, expect, it } from "bun:test";
import type { Config } from "@eigengrid/core";
import type { DatabaseLike } from "@eigengrid/db";
import { collectJob } from "../../apps/cli/src/commands/collect";
import { ApplicationContext } from "../../apps/cli/src/composition";
import type { BackendRegistry, RecipeRegistry } from "../../apps/cli/src/composition";

type ArtifactRow = {
  kind: string;
  label?: string | null;
  path: string;
  sizeBytes?: number | null;
};

function createMemoryDatabase() {
  const artifacts: ArtifactRow[] = [];

  return {
    artifacts,
    async init() {},
    async resolveJobId(jobId: string) {
      return jobId;
    },
    async getJob(jobId: string) {
      if (jobId !== "job-1") return null;
      return {
        id: "job-1",
        name: "water.inp",
        software: "orca",
        inputPath: "/work/job-1/water.inp",
        workdir: "/work",
        outputPath: "/work/job-1/result.log",
        status: "running",
        backend: "slurm",
        externalJobId: "123456",
        externalState: "RUNNING",
        nodeName: "node-a",
      };
    },
    async listJobAttempts(jobId: string) {
      if (jobId !== "job-1") return [];
      return [
        {
          id: "attempt-1",
          jobId,
          runner: "slurm",
          command: "",
          cwd: "/work/job-1",
          status: "created",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];
    },
    async createArtifact(
      artifact: ArtifactRow & {
        id: string;
        jobId: string;
        attemptId: string;
        mimeType: string;
        createdAt?: number;
      },
    ) {
      artifacts.push({
        kind: artifact.kind,
        label: artifact.label,
        path: artifact.path,
        sizeBytes: artifact.sizeBytes,
      });
    },
    async listArtifacts(jobId?: string) {
      if (jobId && jobId !== "job-1") return [];
      return artifacts;
    },
  };
}

function makeCollectContext(config: Config, db: DatabaseLike) {
  const backends: BackendRegistry = {
    runners: new Map(),
    get: () => undefined,
    available: () => [],
  };
  const recipeRegistry: RecipeRegistry = {
    recipes: [],
    find: () => undefined,
    findRunnable: () => undefined,
  };
  const bridge = {
    parse: async () => ({ ok: true, parser: "test", status: "completed" as const, data: {} }),
    generate: async () => ({ ok: true }),
    conformers: async () => ({ ok: true, conformers: [] }),
    run: async () => ({ ok: true, stdout: "", stderr: "" }),
  };
  return new ApplicationContext(config, db, backends, bridge, recipeRegistry);
}

describe("collectJob Slurm support", () => {
  it("calls SlurmRunner.fetch and prints collected artifacts", async () => {
    const state = {
      fetchCalls: [] as Array<Record<string, unknown>>,
      consoleLogs: [] as string[],
    };

    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      state.consoleLogs.push(args.map(String).join(" "));
    };

    try {
      const db = createMemoryDatabase();
      const ctx = makeCollectContext(
        {
          databasePath: "/tmp/eigengrid-collect-slurm.sqlite",
          dbProvider: "sqlite",
          jobsDir: "/work",
          logsDir: "/work/logs",
          outputsDir: "/work/outputs",
          pythonCommand: "python",
          sessionsDir: "/work/sessions",
        } as Config,
        db as unknown as DatabaseLike,
      );
      await collectJob(
        { jobId: "job-1" },
        {
          createContext: async () => ctx,
          slurmRunnerFactory: (database) => ({
            async fetch(job: Record<string, unknown>) {
              state.fetchCalls.push(job);
              await (database as typeof db).createArtifact({
                id: "artifact-1",
                jobId: "job-1",
                attemptId: "attempt-1",
                kind: "log",
                path: "/work/job-1/slurm-123456.out",
                label: "slurm-123456.out",
                mimeType: "text/plain",
                sizeBytes: 12,
              });
              await (database as typeof db).createArtifact({
                id: "artifact-2",
                jobId: "job-1",
                attemptId: "attempt-1",
                kind: "output",
                path: "/work/job-1/result.log",
                mimeType: "text/plain",
                sizeBytes: 21,
              });
              return { ok: true, message: "Fetched artifacts from /work/job-1" };
            },
          }),
        },
      );
    } finally {
      console.log = originalLog;
    }

    expect(state.fetchCalls).toHaveLength(1);
    expect(state.fetchCalls[0]).toMatchObject({
      id: "job-1",
      backend: "slurm",
      externalJobId: "123456",
      external_job_id: "123456",
      externalState: "RUNNING",
      nodeName: "node-a",
    });
    expect(
      state.consoleLogs.some((line) =>
        line.includes("Artifacts collected: Fetched artifacts from /work/job-1"),
      ),
    ).toBe(true);
    expect(state.consoleLogs.some((line) => line.includes("Collected files:"))).toBe(true);
    expect(
      state.consoleLogs.some((line) =>
        line.includes("slurm-123456.out: /work/job-1/slurm-123456.out (12 B)"),
      ),
    ).toBe(true);
    expect(
      state.consoleLogs.some((line) => line.includes("output: /work/job-1/result.log (21 B)")),
    ).toBe(true);
  });

  it("keeps the non-Slurm collect warning unchanged except for Slurm mention", async () => {
    const state = {
      consoleLogs: [] as string[],
    };

    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      state.consoleLogs.push(args.map(String).join(" "));
    };

    try {
      const fakeDb = {
        async init() {},
        async close() {},
        async resolveJobId(jobId: string) {
          return jobId;
        },
        async getJob() {
          return { id: "job-2", backend: "pbs" };
        },
        async listJobAttempts() {
          return [
            {
              id: "attempt-1",
              jobId: "job-2",
              runner: "pbs",
              command: "",
              cwd: "/work/job-2",
              status: "created",
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ];
        },
      } as unknown as DatabaseLike;
      const ctx = makeCollectContext(
        {
          databasePath: "/tmp/eigengrid-collect-slurm.sqlite",
          dbProvider: "sqlite",
          jobsDir: "/work",
          logsDir: "/work/logs",
          outputsDir: "/work/outputs",
          pythonCommand: "python",
          sessionsDir: "/work/sessions",
        } as Config,
        fakeDb,
      );
      await collectJob(
        { jobId: "job-2" },
        {
          createContext: async () => ctx,
        },
      );
    } finally {
      console.log = originalLog;
    }

    expect(
      state.consoleLogs.some((line) =>
        line.includes("Collect is only for local, SSH, worker-daemon, and Slurm jobs."),
      ),
    ).toBe(true);
  });
});
