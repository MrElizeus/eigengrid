import { describe, expect, it } from "bun:test";
import type { Config } from "@eigengrid/core";
import type { DatabaseLike } from "@eigengrid/db";
import { ApplicationContext } from "../../apps/cli/src/composition";
import type { BackendRegistry, RecipeRegistry } from "../../apps/cli/src/composition";
import { showJobDetail } from "../../apps/cli/src/commands/status";

const state = {
  externalMetadata: [] as Array<{ jobId: string; metadata: Record<string, unknown> }>,
  statusUpdates: [] as Array<{ jobId: string; status: string }>,
  events: [] as Array<Record<string, unknown>>,
  consoleLogs: [] as string[],
};

function createFakeDatabase() {
  return {
    async init() {},
    async close() {},
    async runMigrations() {},
    async getMigrationVersion() {
      return 0;
    },
    async getJob(jobId: string) {
      if (jobId !== "job-1") return null;
      return {
        id: "job-1",
        name: "water",
        software: "orca",
        inputPath: "water.inp",
        outputPath: null,
        workdir: "/work/job-1",
        status: "running",
        backend: "slurm",
        externalJobId: "123456",
      };
    },
    async resolveJobId(jobId: string) {
      return jobId;
    },
    async listJobs() {
      return [];
    },
    async createJob() {},
    async updateJobStatus(jobId: string, status: string) {
      state.statusUpdates.push({ jobId, status });
    },
    async updateJobExternalMetadata(jobId: string, metadata: Record<string, unknown>) {
      state.externalMetadata.push({ jobId, metadata });
    },
    async listJobAttempts() {
      return [];
    },
    async createJobAttempt() {},
    async updateJobAttemptStatus() {},
    async createArtifact() {},
    async listArtifacts() {
      return [];
    },
    async getLogs() {
      return [];
    },
    async insertEvent() {},
    async appendEvent(event: Record<string, unknown>) {
      state.events.push(event);
    },
    async getEvents() {
      return [];
    },
    async listEvents() {
      return [];
    },
    async listJobEvents() {
      return [];
    },
    async listAttemptEvents() {
      return [];
    },
    async getTimeline() {
      return [];
    },
    async saveResult() {
      return "result-1";
    },
    async listResults() {
      return [];
    },
    async getLatestResult() {
      return null;
    },
    async createProposal() {
      return "prop-1";
    },
    async getProposal() {
      return null;
    },
    async listProposals() {
      return [];
    },
    async updateProposalStatus() {},
    async listPermissions() {
      return [];
    },
    async createPermission() {},
    async removePermission() {},
    async createUser() {},
    async getUser() {
      return null;
    },
    async getUserByUsername() {
      return null;
    },
    async listUsers() {
      return [];
    },
    async disableUser() {},
    async enableUser() {},
    async createProject() {},
    async getProject() {
      return null;
    },
    async getProjectByName() {
      return null;
    },
    async listProjects() {
      return [];
    },
    async archiveProject() {},
    async resolveProjectId() {
      return "project-1";
    },
    async addProjectMember() {},
    async removeProjectMember() {},
    async listProjectMembers() {
      return [];
    },
    async listUserProjects() {
      return [];
    },
    async getProjectQuota() {
      return null;
    },
    async setProjectQuota() {},
    async recordUsage() {},
    async getProjectUsage() {
      return [];
    },
    async getUserUsage() {
      return [];
    },
    async getProjectAggregatedUsage() {
      return {
        totalCpuThreads: 0,
        totalMemoryMb: 0,
        totalScratchMb: 0,
        totalWalltimeMs: 0,
        jobCount: 0,
      };
    },
    async isUserDisabled() {
      return false;
    },
    async createNode() {},
    async getNode() {
      return null;
    },
    async listNodes() {
      return [];
    },
    async removeNode() {},
    async resolveNodeId() {
      return "node-1";
    },
    async getNodeByName() {
      return null;
    },
  };
}

describe("status command Slurm sync", () => {
  it("refreshes external metadata for Slurm-backed jobs", async () => {
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      state.consoleLogs.push(args.map(String).join(" "));
    };

    try {
      const db = createFakeDatabase();
      const ctx = new ApplicationContext(
        {
          databasePath: ":memory:",
          dbProvider: "sqlite",
          jobsDir: "/work",
          logsDir: "/work/logs",
          outputsDir: "/work/outputs",
          pythonCommand: "python3",
          sessionsDir: "/work/sessions",
        } as Config,
        db as unknown as DatabaseLike,
        {
          runners: new Map(),
          get: () => undefined,
          available: () => [],
        } as unknown as BackendRegistry,
        {
          parse: async () => ({ ok: true, parser: "test", status: "completed" as const }),
          generate: async () => ({ ok: true }),
          conformers: async () => ({ ok: true, conformers: 0 }),
          run: async () => ({ ok: true }),
        } as unknown as PythonBridge,
        {
          recipes: [],
          find: () => undefined,
          findRunnable: () => undefined,
        } as unknown as RecipeRegistry,
      );

      await showJobDetail(ctx, "job-1", {
        createSlurmClient: () => ({
          async getJobStatus(slurmJobId: string) {
            expect(slurmJobId).toBe("123456");
            return {
              slurmJobId,
              state: "COMPLETED",
              stateCompact: "completed",
              elapsed: "00:42:00",
              nodeName: "node-a",
            };
          },
        }),
      });
    } finally {
      console.log = originalLog;
    }

    expect(state.externalMetadata).toHaveLength(1);
    expect(state.externalMetadata[0]).toMatchObject({
      jobId: "job-1",
      metadata: {
        externalState: "COMPLETED",
        nodeName: "node-a",
      },
    });
    expect(state.statusUpdates).toEqual([{ jobId: "job-1", status: "completed" }]);
    expect(state.events.some((event) => event.type === "slurm.job.status.synced")).toBe(true);
    expect(state.consoleLogs.some((line) => line.includes("Backend:     slurm"))).toBe(true);
    expect(state.consoleLogs.some((line) => line.includes("External ID: 123456"))).toBe(true);
    expect(state.consoleLogs.some((line) => line.includes("Slurm State: COMPLETED"))).toBe(true);
  });
});
