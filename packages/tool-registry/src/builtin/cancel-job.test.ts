import { describe, it, expect, mock } from "bun:test";
import { cancelJobTool } from "./cancel-job";

// ── Helpers ──────────────────────────────────────────────────

function mockFn(impl?: (...args: any[]) => any) {
  return mock(impl ?? (() => {}));
}

function makeMockDb() {
  return {
    _provider: "sqlite",
    getJob: mockFn(),
    updateJobStatus: mockFn(() => Promise.resolve()),
    updateJobExternalMetadata: mockFn(() => Promise.resolve()),
    appendEvent: mockFn(),
    init: mockFn(),
    listJobs: mockFn(),
    createJob: mockFn(),
    resolveJobId: mockFn(),
    createJobAttempt: mockFn(),
    updateJobAttemptStatus: mockFn(),
    listJobAttempts: mockFn(),
    createArtifact: mockFn(),
    createArtifactIfAbsent: mockFn(() => Promise.resolve(true)),
    listArtifacts: mockFn(),
    materializeTerminalAttempt: mockFn(() => Promise.resolve()),
    getLogs: mockFn(),
    insertEvent: mockFn(),
    getEvents: mockFn(),
    listPermissions: mockFn(),
    createPermission: mockFn(),
    removePermission: mockFn(),
    createNode: mockFn(),
    getNode: mockFn(),
    listNodes: mockFn(),
    removeNode: mockFn(),
    resolveNodeId: mockFn(),
    getNodeByName: mockFn(),
    // Extended DatabaseLike methods (required for interface compatibility)
    close: mockFn(() => Promise.resolve()),
    runMigrations: mockFn(() => Promise.resolve()),
    getMigrationVersion: mockFn(() => Promise.resolve(0)),
    listEvents: mockFn(() => Promise.resolve([])),
    listJobEvents: mockFn(() => Promise.resolve([])),
    listAttemptEvents: mockFn(() => Promise.resolve([])),
    getTimeline: mockFn(() => Promise.resolve([])),
    saveResult: mockFn(() => Promise.resolve("")),
    listResults: mockFn(() => Promise.resolve([])),
    getLatestResult: mockFn(() => Promise.resolve(null)),
    createProposal: mockFn(() => Promise.resolve("")),
    getProposal: mockFn(() => Promise.resolve(null)),
    listProposals: mockFn(() => Promise.resolve([])),
    updateProposalStatus: mockFn(() => Promise.resolve()),
    // Identity and quota stubs
    createUser: mockFn(() => Promise.resolve()),
    getUser: mockFn(() => Promise.resolve(null)),
    getUserByUsername: mockFn(() => Promise.resolve(null)),
    listUsers: mockFn(() => Promise.resolve([])),
    disableUser: mockFn(() => Promise.resolve()),
    enableUser: mockFn(() => Promise.resolve()),
    createProject: mockFn(() => Promise.resolve()),
    getProject: mockFn(() => Promise.resolve(null)),
    getProjectByName: mockFn(() => Promise.resolve(null)),
    listProjects: mockFn(() => Promise.resolve([])),
    archiveProject: mockFn(() => Promise.resolve()),
    resolveProjectId: mockFn(() => Promise.resolve("")),
    addProjectMember: mockFn(() => Promise.resolve()),
    removeProjectMember: mockFn(() => Promise.resolve()),
    listProjectMembers: mockFn(() => Promise.resolve([])),
    listUserProjects: mockFn(() => Promise.resolve([])),
    getProjectQuota: mockFn(() => Promise.resolve(null)),
    setProjectQuota: mockFn(() => Promise.resolve()),
    recordUsage: mockFn(() => Promise.resolve()),
    getProjectUsage: mockFn(() => Promise.resolve([])),
    getUserUsage: mockFn(() => Promise.resolve([])),
    getProjectAggregatedUsage: mockFn(() =>
      Promise.resolve({
        totalCpuThreads: 0,
        totalMemoryMb: 0,
        totalScratchMb: 0,
        totalWalltimeMs: 0,
        jobCount: 0,
      }),
    ),
    isUserDisabled: mockFn(() => Promise.resolve(false)),
    beginTransaction: mockFn(() => Promise.reject(new Error("not implemented"))),
    claimJobForDispatch: mockFn(() =>
      Promise.resolve({ claimed: false, reason: "not_found", message: "mock" }),
    ),
    releaseJobDispatch: mockFn(() => Promise.resolve()),
  };
}

function makeMockCtx(dbOverrides?: Partial<ReturnType<typeof makeMockDb>>) {
  const db = { ...makeMockDb(), ...dbOverrides };
  return {
    db,
    python: {} as any,
    runners: {},
    bus: { emit: mockFn(), on: mockFn(), off: mockFn() },
    config: {
      databasePath: "",
      dbProvider: "sqlite" as const,
      jobsDir: "",
      logsDir: "",
      outputsDir: "",
      pythonCommand: "",
      sessionsDir: "",
    },
  };
}

describe("cancelJobTool", () => {
  it("has the correct tool name", () => {
    expect(cancelJobTool.name).toBe("cancel-job");
  });

  it("has a description", () => {
    expect(cancelJobTool.description).toBeDefined();
    expect(cancelJobTool.description.length).toBeGreaterThan(0);
  });

  it("has input and output schemas", () => {
    expect(cancelJobTool.inputSchema).toBeDefined();
    expect(cancelJobTool.outputSchema).toBeDefined();
  });

  describe("execute", () => {
    it("rejects a job that does not exist", async () => {
      const ctx = makeMockCtx({ getJob: mockFn(() => Promise.resolve(null)) });
      const result = await cancelJobTool.execute(ctx, { jobId: "nonexistent" });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("JOB_NOT_FOUND");
    });

    it("cancels a job with status 'created'", async () => {
      const db = makeMockDb();
      db.getJob = mockFn(() => Promise.resolve({ id: "job-1", status: "created" }));
      const ctx = makeMockCtx(db);
      const result = await cancelJobTool.execute(ctx, { jobId: "job-1" });
      expect(result.ok).toBe(true);
      expect(result.data?.status).toBe("cancelled");
      expect(result.data?.jobId).toBe("job-1");
      expect(ctx.db.updateJobStatus).toHaveBeenCalledWith("job-1", "cancelled");
    });

    it("cancels a job with status 'queued'", async () => {
      const ctx = makeMockCtx({
        getJob: mockFn(() => Promise.resolve({ id: "job-2", status: "queued" })),
      });
      const result = await cancelJobTool.execute(ctx, { jobId: "job-2" });
      expect(result.ok).toBe(true);
      expect(result.data?.status).toBe("cancelled");
    });

    it("cancels a job with status 'staged'", async () => {
      const ctx = makeMockCtx({
        getJob: mockFn(() => Promise.resolve({ id: "job-3", status: "staged" })),
      });
      const result = await cancelJobTool.execute(ctx, { jobId: "job-3" });
      expect(result.ok).toBe(true);
      expect(result.data?.status).toBe("cancelled");
    });

    it("rejects a job with status 'running' with descriptive error", async () => {
      const ctx = makeMockCtx({
        getJob: mockFn(() => Promise.resolve({ id: "job-4", status: "running" })),
      });
      const result = await cancelJobTool.execute(ctx, { jobId: "job-4" });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("INVALID_STATUS");
      expect(result.error?.message).toContain("running");
    });

    it("rejects a job with status 'completed'", async () => {
      const ctx = makeMockCtx({
        getJob: mockFn(() => Promise.resolve({ id: "job-5", status: "completed" })),
      });
      const result = await cancelJobTool.execute(ctx, { jobId: "job-5" });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("INVALID_STATUS");
    });

    it("rejects a job with status 'failed'", async () => {
      const ctx = makeMockCtx({
        getJob: mockFn(() => Promise.resolve({ id: "job-6", status: "failed" })),
      });
      const result = await cancelJobTool.execute(ctx, { jobId: "job-6" });
      expect(result.ok).toBe(false);
    });

    it("rejects a job with status 'parsed'", async () => {
      const ctx = makeMockCtx({
        getJob: mockFn(() => Promise.resolve({ id: "job-7", status: "parsed" })),
      });
      const result = await cancelJobTool.execute(ctx, { jobId: "job-7" });
      expect(result.ok).toBe(false);
    });

    it("rejects a job with status 'cancelled' (already cancelled)", async () => {
      const ctx = makeMockCtx({
        getJob: mockFn(() => Promise.resolve({ id: "job-8", status: "cancelled" })),
      });
      const result = await cancelJobTool.execute(ctx, { jobId: "job-8" });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("INVALID_STATUS");
    });

    it("returns previousStatus in the output", async () => {
      const ctx = makeMockCtx({
        getJob: mockFn(() => Promise.resolve({ id: "job-9", status: "queued" })),
      });
      const result = await cancelJobTool.execute(ctx, { jobId: "job-9" });
      expect(result.ok).toBe(true);
      expect(result.data?.previousStatus).toBe("queued");
    });

    it("accepts an optional reason string", async () => {
      const ctx = makeMockCtx({
        getJob: mockFn(() => Promise.resolve({ id: "job-10", status: "created" })),
      });
      const result = await cancelJobTool.execute(ctx, {
        jobId: "job-10",
        reason: "User requested cancellation",
      });
      expect(result.ok).toBe(true);
      expect(result.data?.status).toBe("cancelled");
    });

    it("inserts a job:status:changed event after successful cancellation", async () => {
      const db = makeMockDb();
      db.getJob = mockFn(() => Promise.resolve({ id: "job-11", status: "created" }));
      const ctx = makeMockCtx(db);
      const result = await cancelJobTool.execute(ctx, { jobId: "job-11" });
      expect(result.ok).toBe(true);
      expect(ctx.db.insertEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "job:status:changed", jobId: "job-11", to: "cancelled" }),
      );
    });

    it("inserts a system:notice event when reason is provided", async () => {
      const db = makeMockDb();
      db.getJob = mockFn(() => Promise.resolve({ id: "job-12", status: "created" }));
      const ctx = makeMockCtx(db);
      const result = await cancelJobTool.execute(ctx, { jobId: "job-12", reason: "Testing" });
      expect(result.ok).toBe(true);
      expect(ctx.db.insertEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "system:notice" }),
      );
    });

    it("cancels an SSH job without a projected external ID through pending coordinator state", async () => {
      const db = makeMockDb();
      db.getJob = mockFn(() =>
        Promise.resolve({ id: "job-ssh", status: "staged", backend: "ssh" }),
      );
      db.listJobAttempts = mockFn(() =>
        Promise.resolve([
          {
            id: "attempt-ssh",
            jobId: "job-ssh",
            runner: "ssh",
            status: "staged",
          },
        ]),
      );
      const stop = mockFn(() => Promise.resolve({ ok: true, message: "remote cancelled" }));
      const cancelPending = mockFn(() =>
        Promise.resolve({
          ok: true,
          jobId: "job-ssh",
          previousStatus: "staged",
          message: "cancelled",
        }),
      );
      const ctx = makeMockCtx(db);
      ctx.runners = { ssh: { kind: "ssh", stop } } as any;
      (ctx as any).execution = {
        cancelPending,
        cancelRemote: mockFn(async (_jobId: string, runner: any) => runner.stop()),
      } as any;

      const result = await cancelJobTool.execute(ctx, { jobId: "job-ssh" });
      expect(result.ok).toBe(true);
      expect(cancelPending).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      expect(db.updateJobStatus).not.toHaveBeenCalled();
    });
  });
});
