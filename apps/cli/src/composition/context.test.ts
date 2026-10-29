// ────────────────────────────────────────────────────────────
// ApplicationContext — focused tests
// ────────────────────────────────────────────────────────────

import { describe, expect, it } from "bun:test";
import type { Config, RunnerKind, Job } from "@eigengrid/core";
import type {
  Artifact,
  JobAttempt,
  JobAttemptStatus,
  RunnerResult,
  StartedProcess,
  RemoteProcessStatus,
} from "@eigengrid/core";
import type { ParseResult, GenerateResult, ConformerResult, PythonResult } from "@eigengrid/core";
import type { Runner } from "@eigengrid/runners";
import type {
  DatabaseLike,
  SaveResultInput,
  ListEventsFilter,
  TimelineRow,
  LogLine,
  CreateProposalInput,
  ProposalRow,
  ProposalStatus,
  JobRecord,
  EventRecord,
  StoredResultRecord,
  UserRecord,
  ProjectRecord,
  MembershipRecord,
  QuotaRecord,
  UsageRecord,
  NodeRecord,
} from "@eigengrid/db";
import type { EigenGridEvent, EigenGridEventBase } from "@eigengrid/events";
import type { PythonBridge } from "@eigengrid/python-bridge";
import type { BackendRegistry, RecipeRegistry } from "./types";
import { ApplicationContext, createApplicationContext } from "./context";
import { ProviderConflictError } from "./types";

// ── Fake database (exact DatabaseLike shapes) ───────────────

class FakeDatabase implements DatabaseLike {
  readonly jobsMap = new Map<string, Record<string, unknown>>();
  readonly eventsStore: EventRecord[] = [];
  readonly resultsStore: StoredResultRecord[] = [];
  closed = false;
  readonly _provider = "sqlite" as const;

  async init(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
  }
  async beginTransaction(): Promise<import("@eigengrid/db").DbTransaction> {
    throw new Error("FakeDatabase does not support transactions");
  }
  async runMigrations(): Promise<void> {}
  async getMigrationVersion(): Promise<number> {
    return 0;
  }

  // ── Jobs ───────────────────────────────────────────────
  async createJob(job: {
    id: string;
    name: string;
    software: string;
    inputPath: string;
    workdir: string;
    outputPath?: string;
    ownerUserId?: string;
    projectId?: string;
    backend?: string;
  }): Promise<void> {
    this.jobsMap.set(job.id, { ...job, status: "created" });
  }
  async getJob(jobId: string): Promise<JobRecord | null> {
    return (this.jobsMap.get(jobId) ?? null) as unknown as JobRecord | null;
  }
  async resolveJobId(prefix: string): Promise<string> {
    const found = [...this.jobsMap.keys()].find((k) => k.startsWith(prefix));
    if (!found) throw new Error(`Job not found: ${prefix}`);
    return found;
  }
  async listJobs(): Promise<JobRecord[]> {
    return [...this.jobsMap.values()] as unknown as JobRecord[];
  }
  async updateJobStatus(jobId: string, status: string): Promise<void> {
    const job = this.jobsMap.get(jobId);
    if (job) job.status = status;
  }
  async updateJobExternalMetadata(
    jobId: string,
    metadata: {
      backend?: string;
      externalJobId?: string;
      externalState?: string;
      lastSyncAt?: number;
      nativeDetail?: string;
      nodeName?: string;
    },
  ): Promise<void> {
    const job = this.jobsMap.get(jobId);
    if (job) Object.assign(job, metadata);
  }

  // ── Attempts ───────────────────────────────────────────
  async createJobAttempt(_attempt: {
    id: string;
    jobId: string;
    runner: RunnerKind;
    command: string;
    cwd: string;
    status?: JobAttemptStatus;
    pid?: number;
    exitCode?: number;
    startedAt?: number;
    finishedAt?: number;
  }): Promise<void> {}
  async updateJobAttemptStatus(
    _attemptId: string,
    _status: JobAttemptStatus,
    _updates?: {
      pid?: number;
      startedAt?: number;
      exitCode?: number;
      finishedAt?: number;
    },
  ): Promise<void> {}
  async listJobAttempts(_jobId?: string): Promise<JobAttempt[]> {
    return [];
  }

  // ── Artifacts ──────────────────────────────────────────
  async createArtifact(_artifact: Omit<Artifact, "createdAt">): Promise<void> {}
  async createArtifactIfAbsent(_artifact: Omit<Artifact, "createdAt">): Promise<boolean> {
    return true;
  }
  async listArtifacts(_jobId?: string): Promise<Artifact[]> {
    return [];
  }
  async materializeTerminalAttempt(
    _evidence: Parameters<DatabaseLike["materializeTerminalAttempt"]>[0],
  ): Promise<void> {}

  // ── Logs ───────────────────────────────────────────────
  async getLogs(_jobId: string, _stream?: string, _tail?: number): Promise<LogLine[]> {
    return [];
  }

  // ── Events ─────────────────────────────────────────────
  async insertEvent(_event: EigenGridEvent): Promise<void> {}
  async appendEvent(_event: EigenGridEventBase): Promise<void> {}
  async getEvents(_jobId?: string): Promise<EventRecord[]> {
    return this.eventsStore;
  }
  async listEvents(_filters?: ListEventsFilter): Promise<EventRecord[]> {
    return this.eventsStore;
  }
  async listJobEvents(_jobId: string): Promise<EventRecord[]> {
    return this.eventsStore;
  }
  async listAttemptEvents(_attemptId: string): Promise<EventRecord[]> {
    return [];
  }
  async getTimeline(_jobId: string): Promise<TimelineRow[]> {
    return [];
  }

  // ── Results ────────────────────────────────────────────
  async saveResult(_input: SaveResultInput): Promise<string> {
    return "result-1";
  }
  async listResults(_jobId?: string): Promise<StoredResultRecord[]> {
    return this.resultsStore;
  }
  async getLatestResult(_jobId: string): Promise<StoredResultRecord | null> {
    return this.resultsStore[this.resultsStore.length - 1] ?? null;
  }

  // ── Proposals ──────────────────────────────────────────
  async createProposal(_input: CreateProposalInput): Promise<string> {
    return "prop-1";
  }
  async getProposal(_proposalId: string): Promise<ProposalRow | null> {
    return null;
  }
  async listProposals(_filters?: {
    jobId?: string;
    status?: ProposalStatus;
  }): Promise<ProposalRow[]> {
    return [];
  }
  async updateProposalStatus(_proposalId: string, _status: ProposalStatus): Promise<void> {}

  // ── Permissions ────────────────────────────────────────
  async listPermissions(_projectId?: string): Promise<
    Array<{
      id: string;
      action: string;
      resource: string;
      effect: "allow" | "deny" | "ask";
      projectId?: string;
      label?: string;
    }>
  > {
    return [];
  }
  async createPermission(_permission: {
    id: string;
    action: string;
    resource?: string;
    effect: "allow" | "deny" | "ask";
    projectId?: string;
    label?: string;
  }): Promise<void> {}
  async removePermission(_id: string): Promise<void> {}

  // ── Users ──────────────────────────────────────────────
  async createUser(_user: {
    id: string;
    username: string;
    displayName?: string;
    email?: string;
  }): Promise<void> {}
  async getUser(_userId: string): Promise<UserRecord | null> {
    return null;
  }
  async getUserByUsername(_username: string): Promise<UserRecord | null> {
    return null;
  }
  async listUsers(): Promise<UserRecord[]> {
    return [];
  }
  async disableUser(_userId: string): Promise<void> {}
  async enableUser(_userId: string): Promise<void> {}

  // ── Projects ───────────────────────────────────────────
  async createProject(_project: {
    id: string;
    name: string;
    description?: string;
    maxConcurrentJobs?: number;
  }): Promise<void> {}
  async getProject(_projectId: string): Promise<ProjectRecord | null> {
    return null;
  }
  async getProjectByName(_name: string): Promise<ProjectRecord | null> {
    return null;
  }
  async listProjects(): Promise<ProjectRecord[]> {
    return [];
  }
  async archiveProject(_projectId: string): Promise<void> {}
  async resolveProjectId(_prefix: string): Promise<string> {
    return "project-1";
  }

  // ── Memberships ────────────────────────────────────────
  async addProjectMember(_projectId: string, _userId: string, _role?: string): Promise<void> {}
  async removeProjectMember(_projectId: string, _userId: string): Promise<void> {}
  async listProjectMembers(_projectId: string): Promise<MembershipRecord[]> {
    return [];
  }
  async listUserProjects(_userId: string): Promise<ProjectRecord[]> {
    return [];
  }

  // ── Quotas ─────────────────────────────────────────────
  async getProjectQuota(_projectId: string): Promise<QuotaRecord | null> {
    return null;
  }
  async setProjectQuota(
    _projectId: string,
    _quota: {
      maxCpuThreads?: number;
      maxMemoryMb?: number;
      maxScratchMb?: number;
      maxJobsTotal?: number;
    },
  ): Promise<void> {}

  // ── Usage ──────────────────────────────────────────────
  async recordUsage(_usage: {
    id: string;
    projectId: string;
    userId: string;
    jobId: string;
    cpuThreads?: number;
    memoryMb?: number;
    scratchMb?: number;
    walltimeMs?: number;
  }): Promise<void> {}
  async getProjectUsage(_projectId: string): Promise<UsageRecord[]> {
    return [];
  }
  async getUserUsage(_userId: string): Promise<UsageRecord[]> {
    return [];
  }
  async getProjectAggregatedUsage(_projectId: string): Promise<{
    totalCpuThreads: number;
    totalMemoryMb: number;
    totalScratchMb: number;
    totalWalltimeMs: number;
    jobCount: number;
  }> {
    return {
      totalCpuThreads: 0,
      totalMemoryMb: 0,
      totalScratchMb: 0,
      totalWalltimeMs: 0,
      jobCount: 0,
    };
  }

  // ── Privilege ──────────────────────────────────────────
  async isUserDisabled(_userId: string): Promise<boolean> {
    return false;
  }

  // ── Nodes ──────────────────────────────────────────────
  async createNode(_node: {
    id: string;
    name: string;
    host: string;
    user: string;
    runner: string;
    port?: number;
    maxJobs?: number;
    tags?: string[];
    privateKeyPath?: string;
    remoteScratchDir?: string;
  }): Promise<void> {}
  async getNode(_nodeId: string): Promise<NodeRecord | null> {
    return null;
  }
  async listNodes(): Promise<NodeRecord[]> {
    return [];
  }
  async removeNode(_nodeId: string): Promise<void> {}
  async resolveNodeId(_prefix: string): Promise<string> {
    return "node-1";
  }
  async getNodeByName(_name: string): Promise<NodeRecord | null> {
    return null;
  }

  async claimJobForDispatch(
    _jobId: string,
    _nodeId: string,
    _attemptId: string,
    _runner: import("@eigengrid/core").RunnerKind,
    _command: string,
    _cwd: string,
  ): Promise<import("@eigengrid/db").ClaimDispatchResult> {
    return { claimed: false, reason: "not_found", message: "FakeDatabase does not support claim" };
  }

  async releaseJobDispatch(
    _jobId: string,
    _attemptId: string,
    _errorMessage: string,
  ): Promise<void> {
    // no-op
  }
}

// ── Fake Python bridge (exact PythonBridge shapes) ──────────

class FakeBridge implements PythonBridge {
  async parse(_software: string, _outputPath: string): Promise<ParseResult> {
    return { ok: true, parser: "test", status: "completed" };
  }
  async generate(_recipe: string, _params: Record<string, unknown>): Promise<GenerateResult> {
    return { ok: true };
  }
  async conformers(_smiles: string, _n: number): Promise<ConformerResult> {
    return { ok: true, conformers: 0 };
  }
  async run(_cmd: string, _args: string[]): Promise<PythonResult> {
    return { ok: true };
  }
}

// ── Fake runner (exact Runner interface types) ──────────────

class FakeRunner implements Runner {
  readonly kind: RunnerKind = "local";
  async stage(_job: Job): Promise<RunnerResult> {
    return { ok: true };
  }
  async start(_job: Job): Promise<StartedProcess> {
    return { ok: true, pid: 42 };
  }
  async status(_job: Job): Promise<RemoteProcessStatus> {
    return { status: "completed", exitCode: 0 };
  }
  async stop(_job: Job): Promise<RunnerResult> {
    return { ok: true };
  }
  async fetch(_job: Job): Promise<RunnerResult> {
    return { ok: true };
  }
}

// ── Shared helpers ──────────────────────────────────────────

function minConfig(): Config {
  return {
    databasePath: ":memory:",
    dbProvider: "sqlite",
    jobsDir: "/tmp/jobs",
    logsDir: "/tmp/logs",
    outputsDir: "/tmp/outputs",
    pythonCommand: "python3",
    sessionsDir: "/tmp/sessions",
  };
}

function emptyRegistry(): BackendRegistry {
  const runners = new Map<RunnerKind, Runner>();
  return {
    runners,
    get: (k) => runners.get(k),
    available: () => [...runners.keys()],
  };
}

function emptyRecipes(): RecipeRegistry {
  return {
    recipes: [],
    find: () => undefined,
    findRunnable: () => undefined,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe("ApplicationContext", () => {
  it("constructs with fake dependencies", () => {
    const fakeDb = new FakeDatabase();
    const fakeBridge = new FakeBridge();
    const runners = new Map<RunnerKind, Runner>([["local", new FakeRunner()]]);

    const ctx = new ApplicationContext(
      {
        ...minConfig(),
        workerAgent: {
          mode: "off" as const,
          maxRecoveryActionsPerJob: 1,
          maxRecoveryActionsPerHour: 10,
          allowParserRetry: true,
          allowArtifactSyncRetry: true,
          allowSameCommandRetry: false,
          allowNodeDrain: true,
          allowPidReattach: true,
        },
      },
      fakeDb,
      { runners, get: (k) => runners.get(k), available: () => [...runners.keys()] },
      fakeBridge,
      emptyRecipes(),
      { clock: () => 42, idGenerator: (p) => `${p}_test` },
    );

    expect(ctx).toBeDefined();
    expect(ctx.config.dbProvider).toBe("sqlite");
    expect(ctx.db).toBe(fakeDb);
    expect(ctx.parsers).toBe(fakeBridge);
    expect(ctx.recipes).toBeDefined();
    expect(ctx.backends).toBeDefined();
    expect(ctx.jobs).toBeDefined();
    expect(ctx.queries).toBeDefined();
    expect(ctx.clock()).toBe(42);
    expect(ctx.idGenerator("test")).toBe("test_test");
    expect(ctx.isClosed).toBe(false);
  });

  it("exposes execution coordinator via context.execution", () => {
    const fakeDb = new FakeDatabase();
    const ctx = new ApplicationContext(
      {
        ...minConfig(),
        workerAgent: {
          mode: "off" as const,
          maxRecoveryActionsPerJob: 1,
          maxRecoveryActionsPerHour: 10,
          allowParserRetry: true,
          allowArtifactSyncRetry: true,
          allowSameCommandRetry: false,
          allowNodeDrain: true,
          allowPidReattach: true,
        },
      },
      fakeDb,
      { runners: new Map(), get: () => undefined, available: () => [] },
      new FakeBridge(),
      emptyRecipes(),
    );

    expect(ctx.execution).toBeDefined();
    expect(ctx.execution.executeLocal).toBeFunction();
  });

  it("accepts execution coordinator override typed as ExecutionService", () => {
    const fakeDb = new FakeDatabase();
    const mockExecute = async () => ({
      ok: true as const,
      jobId: "mock",
      attemptId: "mock-attempt",
    });

    const ctx = new ApplicationContext(
      {
        ...minConfig(),
      },
      fakeDb,
      { runners: new Map(), get: () => undefined, available: () => [] },
      new FakeBridge(),
      emptyRecipes(),
      {
        execution: {
          executeLocal: mockExecute,
          dispatchExistingJob: async () => ({
            ok: false,
            jobId: "mock",
            attemptId: "mock",
            message: "mock",
          }),
          reconcileLocal: async () => ({
            status: "safely-unknown" as const,
            jobId: "mock",
            message: "mock",
          }),
          cancelLocal: async () => ({ ok: false, jobId: "mock", message: "mock" }),
          collectLocal: async () => ({
            ok: false,
            jobId: "mock",
            attemptId: "mock",
            artifacts: [],
            message: "mock",
          }),
          parseJob: async () => ({ ok: false, jobId: "mock", message: "mock" }),
        },
      },
    );

    expect(ctx.execution).toBeDefined();
    expect(typeof ctx.execution.executeLocal).toBe("function");
  });

  it("injects typed localBackendFactory override", () => {
    const fakeDb = new FakeDatabase();
    const fakeBackend = {
      stageAttempt: async () => ({ ok: true as const, message: "fake stage" }),
      startAttempt: async () => ({ ok: true as const, pid: 999, command: "fake" }),
      reconcileAttempt: async () => ({ status: "safely-unknown" as const, message: "mock" }),
      cancelAttempt: async () => ({ ok: false as const, message: "mock" }),
      collectAttempt: async () => ({
        ok: true as const,
        artifacts: [] as string[],
        message: "mock",
      }),
    };
    const fakeBackendFactory = () => fakeBackend;

    const ctx = new ApplicationContext(
      { ...minConfig() },
      fakeDb,
      { runners: new Map(), get: () => undefined, available: () => [] },
      new FakeBridge(),
      emptyRecipes(),
      { localBackendFactory: fakeBackendFactory },
    );

    expect(ctx.execution).toBeDefined();
  });

  it("close is idempotent", async () => {
    const fakeDb = new FakeDatabase();
    const ctx = new ApplicationContext(
      minConfig(),
      fakeDb,
      emptyRegistry(),
      new FakeBridge(),
      emptyRecipes(),
    );

    expect(fakeDb.closed).toBe(false);
    await ctx.close();
    expect(fakeDb.closed).toBe(true);
    expect(ctx.isClosed).toBe(true);

    // Second close — no error, idempotent
    await ctx.close();
    expect(ctx.isClosed).toBe(true);
  });

  it("close without init is safe", async () => {
    const ctx = new ApplicationContext(
      minConfig(),
      new FakeDatabase(),
      emptyRegistry(),
      new FakeBridge(),
      emptyRecipes(),
    );

    await ctx.close();
    expect(ctx.isClosed).toBe(true);
  });

  describe("createApplicationContext", () => {
    it("uses override database and bridge", async () => {
      const fakeDb = new FakeDatabase();
      const fakeBridge = new FakeBridge();
      const ctx = await createApplicationContext({
        db: fakeDb,
        bridge: fakeBridge,
        config: { databasePath: ":memory:", dbProvider: "sqlite" },
      });

      expect(ctx.db).toBe(fakeDb);
      expect(ctx.parsers).toBe(fakeBridge);
      expect(ctx.config.dbProvider).toBe("sqlite");
      await ctx.close();
    });

    it("registers runners via overrides", async () => {
      const runner = new FakeRunner();
      const runners = new Map<RunnerKind, Runner>([["local", runner]]);
      const ctx = await createApplicationContext({
        db: new FakeDatabase(),
        bridge: new FakeBridge(),
        runners,
        config: { databasePath: ":memory:", dbProvider: "sqlite" },
      });

      expect(ctx.backends.get("local")).toBe(runner);
      expect(ctx.backends.available()).toEqual(["local"]);
      await ctx.close();
    });

    it("config overrides are applied atop loaded config", async () => {
      const ctx = await createApplicationContext({
        db: new FakeDatabase(),
        bridge: new FakeBridge(),
        config: {
          databasePath: "/custom/path.db",
          dbProvider: "sqlite",
          pythonCommand: "python3.11",
        },
      });

      expect(ctx.config.databasePath).toBe("/custom/path.db");
      expect(ctx.config.pythonCommand).toBe("python3.11");
      await ctx.close();
    });
  });

  describe("JobService", () => {
    it("creates and retrieves jobs", async () => {
      const fakeDb = new FakeDatabase();
      const ctx = new ApplicationContext(
        minConfig(),
        fakeDb,
        emptyRegistry(),
        new FakeBridge(),
        emptyRecipes(),
      );

      await ctx.jobs.create({
        id: "job-1",
        name: "test-job",
        software: "gaussian",
        inputPath: "/input.in",
        workdir: "/work",
      });

      const job = await ctx.jobs.get("job-1");
      expect(job).not.toBeNull();
      expect(job?.name).toBe("test-job");
      expect(job?.software).toBe("gaussian");

      const all = await ctx.jobs.list();
      expect(all).toHaveLength(1);
    });

    it("resolves job by prefix", async () => {
      const fakeDb = new FakeDatabase();
      await fakeDb.createJob({
        id: "job-abc123",
        name: "resolve-test",
        software: "orca",
        inputPath: "/input.inp",
        workdir: "/tmp",
      });

      const ctx = new ApplicationContext(
        minConfig(),
        fakeDb,
        emptyRegistry(),
        new FakeBridge(),
        emptyRecipes(),
      );

      const resolved = await ctx.jobs.resolveId("job-abc");
      expect(resolved).toBe("job-abc123");
    });

    it("updates job status", async () => {
      const fakeDb = new FakeDatabase();
      await fakeDb.createJob({
        id: "job-status-test",
        name: "status-test",
        software: "gaussian",
        inputPath: "/in.gjf",
        workdir: "/tmp",
      });

      const ctx = new ApplicationContext(
        minConfig(),
        fakeDb,
        emptyRegistry(),
        new FakeBridge(),
        emptyRecipes(),
      );

      await ctx.jobs.updateStatus("job-status-test", "queued");
      const job = await ctx.jobs.get("job-status-test");
      expect(job?.status).toBe("queued");
    });
  });

  describe("QueryService", () => {
    it("delegates events queries", async () => {
      const fakeDb = new FakeDatabase();
      const ctx = new ApplicationContext(
        minConfig(),
        fakeDb,
        emptyRegistry(),
        new FakeBridge(),
        emptyRecipes(),
      );

      const evts = await ctx.queries.events.list();
      expect(evts).toEqual([]);
    });

    it("delegates results queries with ChemistryResult types", async () => {
      const fakeDb = new FakeDatabase();
      const ctx = new ApplicationContext(
        minConfig(),
        fakeDb,
        emptyRegistry(),
        new FakeBridge(),
        emptyRecipes(),
      );

      const results = await ctx.queries.results.list();
      expect(results).toEqual([]);

      const latest = await ctx.queries.results.getLatest("job-1", "attempt-1");
      expect(latest).toBeNull();
    });

    it("delegates log queries", async () => {
      const fakeDb = new FakeDatabase();
      const ctx = new ApplicationContext(
        minConfig(),
        fakeDb,
        emptyRegistry(),
        new FakeBridge(),
        emptyRecipes(),
      );

      const logs = await ctx.queries.logs.get("job-1");
      expect(logs).toEqual([]);
    });
  });

  describe("RecipeRegistry", () => {
    it("loads builtin recipes and finds by id", async () => {
      const ctx = await createApplicationContext({
        db: new FakeDatabase(),
        bridge: new FakeBridge(),
        config: { databasePath: ":memory:", dbProvider: "sqlite" },
      });

      expect(ctx.recipes.recipes.length).toBeGreaterThan(0);
      expect(ctx.recipes.find("gaussian-opt")).toBeDefined();
      expect(ctx.recipes.find("nonexistent")).toBeUndefined();
      await ctx.close();
    });
  });

  describe("BackendRegistry", () => {
    it("provides runner lookup", () => {
      const runner = new FakeRunner();
      const runners = new Map<RunnerKind, Runner>([["local", runner]]);
      const registry: BackendRegistry = {
        runners,
        get: (k) => runners.get(k),
        available: () => [...runners.keys()],
      };

      expect(registry.get("local")).toBe(runner);
      expect(registry.get("ssh")).toBeUndefined();
      expect(registry.available()).toEqual(["local"]);
    });
  });

  describe("Provider conflict detection", () => {
    it("throws ProviderConflictError for mismatched provider markers", async () => {
      const fakeDb = new FakeDatabase();
      expect(fakeDb._provider).toBe("sqlite");

      await expect(
        createApplicationContext({
          db: fakeDb,
          bridge: new FakeBridge(),
          config: { databasePath: ":memory:", dbProvider: "postgres" },
        }),
      ).rejects.toThrow(ProviderConflictError);
    });

    it("ProviderConflictError message is descriptive", () => {
      const err = new ProviderConflictError("postgres", "sqlite");
      expect(err.message).toContain("postgres");
      expect(err.message).toContain("sqlite");
      expect(err.name).toBe("ProviderConflictError");
    });

    it("passes when providers match (sqlite + sqlite)", async () => {
      const ctx = await createApplicationContext({
        db: new FakeDatabase(),
        bridge: new FakeBridge(),
        config: { databasePath: ":memory:", dbProvider: "sqlite" },
      });

      expect(ctx).toBeDefined();
      expect(ctx.config.dbProvider).toBe("sqlite");
      await ctx.close();
    });
  });
});
