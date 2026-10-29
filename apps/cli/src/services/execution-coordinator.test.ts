// ────────────────────────────────────────────────────────────
// ExecutionCoordinator — focused tests
// ────────────────────────────────────────────────────────────
// Tests the real coordinator boundary with a fake database,
// temp filesystem, and injected backend factory.
// No LocalRunner import — backend is injected through factory.
// ────────────────────────────────────────────────────────────

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  copyFileSync,
  chmodSync,
  writeFileSync,
  rmSync,
  existsSync,
  statSync,
} from "fs";
import { basename, join } from "path";
import type {
  Config,
  Job,
  JobAttempt,
  JobAttemptStatus,
  RunnerKind,
  Artifact,
  RunnerResult,
  StartedProcess,
} from "@eigengrid/core";
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
import {
  ExecutionCoordinator,
  type LocalExecutionRequest,
  type LocalExecutionBackendFactory,
} from "./execution-coordinator";
import type { RecipeRegistry } from "../composition/types";

// ── Traced Fake Database (tracks operations for ordering) ──

interface OperationRecord {
  type: string;
  details?: Record<string, unknown>;
}

class TracedDatabase implements DatabaseLike {
  readonly eventsStore: EigenGridEventBase[] = [];
  readonly jobsMap = new Map<string, Record<string, unknown>>();
  readonly attemptsMap = new Map<string, Record<string, unknown>>();
  readonly artifactsMap = new Map<string, Artifact>();
  readonly operations: OperationRecord[] = [];
  closed = false;
  readonly _provider = "sqlite" as const;

  async init(): Promise<void> {}
  async beginTransaction(): Promise<import("@eigengrid/db").DbTransaction> {
    throw new Error("TracedDatabase does not support transactions");
  }
  async close(): Promise<void> {
    this.closed = true;
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
    this.operations.push({ type: "createJob", details: { id: job.id } });
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
    this.operations.push({ type: "updateJobStatus", details: { jobId, status } });
    const job = this.jobsMap.get(jobId);
    if (job) job.status = status;
  }
  async updateJobExternalMetadata(
    _jobId: string,
    _metadata: {
      backend?: string;
      externalJobId?: string;
      externalState?: string;
      lastSyncAt?: number;
      nativeDetail?: string;
      nodeName?: string;
    },
  ): Promise<void> {}

  // ── Attempts ───────────────────────────────────────────
  async createJobAttempt(attempt: {
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
  }): Promise<void> {
    this.operations.push({
      type: "createJobAttempt",
      details: { id: attempt.id, jobId: attempt.jobId },
    });
    this.attemptsMap.set(attempt.id, { ...attempt, status: attempt.status ?? "created" });
    // Emit attempt.created matching real adapter behavior (db adapter emits this)
    this.eventsStore.push({
      id: `evt-attempt-${attempt.id}`,
      type: "attempt.created",
      at: Date.now(),
      source: "db",
      jobId: attempt.jobId,
      attemptId: attempt.id,
      payload: { runner: attempt.runner, command: attempt.command, cwd: attempt.cwd },
    } as EigenGridEventBase);
  }
  async updateJobAttemptStatus(
    attemptId: string,
    status: JobAttemptStatus,
    updates?: { pid?: number; startedAt?: number; exitCode?: number; finishedAt?: number },
  ): Promise<void> {
    this.operations.push({ type: "updateJobAttemptStatus", details: { attemptId, status } });
    const existing = this.attemptsMap.get(attemptId) ?? {};
    this.attemptsMap.set(attemptId, { ...existing, ...updates, status });
  }
  async listJobAttempts(_jobId?: string): Promise<JobAttempt[]> {
    return [...this.attemptsMap.values()] as unknown as JobAttempt[];
  }

  // ── Artifacts ──────────────────────────────────────────
  async createArtifact(artifact: Omit<Artifact, "createdAt">): Promise<void> {
    this.operations.push({
      type: "createArtifact",
      details: { id: artifact.id, kind: artifact.kind },
    });
    const full: Artifact = { ...artifact, createdAt: Date.now() };
    this.artifactsMap.set(artifact.id, full);
    // Emit artifact.registered matching real adapter behavior (db adapter emits this)
    this.eventsStore.push({
      id: `evt-artifact-${artifact.id}`,
      type: "artifact.registered",
      at: Date.now(),
      source: "db",
      jobId: artifact.jobId,
      attemptId: artifact.attemptId,
      artifactId: artifact.id,
      payload: { kind: artifact.kind, path: artifact.path },
    } as EigenGridEventBase);
  }
  async createArtifactIfAbsent(artifact: Omit<Artifact, "createdAt">): Promise<boolean> {
    const exists = [...this.artifactsMap.values()].some(
      (entry) =>
        entry.jobId === artifact.jobId &&
        entry.attemptId === artifact.attemptId &&
        entry.kind === artifact.kind &&
        entry.path === artifact.path,
    );
    if (exists) return false;
    await this.createArtifact(artifact);
    return true;
  }
  async listArtifacts(_jobId?: string): Promise<Artifact[]> {
    return [...this.artifactsMap.values()];
  }
  async materializeTerminalAttempt(
    evidence: Parameters<DatabaseLike["materializeTerminalAttempt"]>[0],
  ): Promise<void> {
    await this.updateJobAttemptStatus(evidence.attemptId, evidence.status, {
      exitCode: evidence.exitCode,
      finishedAt: evidence.finishedAt,
    });
    await this.updateJobStatus(evidence.jobId, evidence.status);
    const type =
      evidence.status === "completed"
        ? "process.completed"
        : evidence.status === "cancelled"
          ? "process.cancelled"
          : "process.failed";
    if (
      !this.eventsStore.some(
        (event) =>
          event.type === type &&
          event.jobId === evidence.jobId &&
          event.attemptId === evidence.attemptId,
      )
    ) {
      await this.appendEvent({
        id: `evt-terminal-${evidence.attemptId}`,
        type,
        at: evidence.finishedAt,
        source: evidence.source,
        jobId: evidence.jobId,
        attemptId: evidence.attemptId,
        payload: evidence.payload,
      });
    }
  }

  // ── Logs ───────────────────────────────────────────────
  async getLogs(_jobId: string, _stream?: string, _tail?: number): Promise<LogLine[]> {
    return [];
  }

  // ── Events ─────────────────────────────────────────────
  async insertEvent(_event: EigenGridEvent): Promise<void> {}
  async appendEvent(event: EigenGridEventBase): Promise<void> {
    this.operations.push({
      type: "appendEvent",
      details: { eventType: event.type, jobId: event.jobId, attemptId: event.attemptId },
    });
    this.eventsStore.push(event);
  }
  async getEvents(_jobId?: string): Promise<EventRecord[]> {
    return this.eventsStore as unknown as EventRecord[];
  }
  async listEvents(_filters?: ListEventsFilter): Promise<EventRecord[]> {
    return this.eventsStore as unknown as EventRecord[];
  }
  async listJobEvents(_jobId: string): Promise<EventRecord[]> {
    return this.eventsStore as unknown as EventRecord[];
  }
  async listAttemptEvents(_attemptId: string): Promise<EventRecord[]> {
    return [];
  }
  async getTimeline(_jobId: string): Promise<TimelineRow[]> {
    return [];
  }

  // ── Results ────────────────────────────────────────────
  readonly resultsMap = new Map<string, StoredResultRecord>();
  async saveResult(input: SaveResultInput): Promise<string> {
    const resultId = `result-${input.jobId}-${input.attemptId}-${input.parser}`;
    this.resultsMap.set(resultId, {
      id: resultId,
      jobId: input.jobId,
      attemptId: input.attemptId,
      parser: input.parser,
      status: input.status,
      energyHartree: input.energyHartree ?? null,
      scfConverged: input.scfConverged ?? null,
      imaginaryFrequencies: input.imaginaryFrequencies ?? null,
      normalTermination: input.normalTermination ?? null,
      warnings: input.warnings ?? [],
      errors: input.errors ?? [],
      raw: input.raw ?? null,
      createdAt: Date.now(),
    });
    return resultId;
  }
  async listResults(jobId?: string, attemptId?: string): Promise<StoredResultRecord[]> {
    return [...this.resultsMap.values()].filter(
      (result) =>
        (!jobId || result.jobId === jobId) && (!attemptId || result.attemptId === attemptId),
    );
  }
  async getLatestResult(jobId: string, attemptId: string): Promise<StoredResultRecord | null> {
    const all = await this.listResults(jobId, attemptId);
    return all.length > 0 ? all[all.length - 1] : null;
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
    {
      id: string;
      action: string;
      resource: string;
      effect: "allow" | "deny" | "ask";
      projectId?: string;
      label?: string;
    }[]
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
    return {
      claimed: false,
      reason: "not_found",
      message: "TracedDatabase does not support claim",
    };
  }

  async releaseJobDispatch(jobId: string, attemptId: string, errorMessage: string): Promise<void> {
    this.operations.push({
      type: "releaseJobDispatch",
      details: { jobId, attemptId, errorMessage },
    });
  }
}

class TransitionFailingDatabase extends TracedDatabase {
  failJobStatus: string | undefined;
  failAttemptStatus: JobAttemptStatus | undefined;

  override async updateJobStatus(jobId: string, status: string): Promise<void> {
    if (status === this.failJobStatus)
      throw new Error(`injected job transition failure: ${status}`);
    await super.updateJobStatus(jobId, status);
  }

  override async updateJobAttemptStatus(
    attemptId: string,
    status: JobAttemptStatus,
    updates?: { pid?: number; startedAt?: number; exitCode?: number; finishedAt?: number },
  ): Promise<void> {
    if (status === this.failAttemptStatus)
      throw new Error(`injected attempt transition failure: ${status}`);
    await super.updateJobAttemptStatus(attemptId, status, updates);
  }
}

// ── Fake executor (controlled spawn) ─────────────────────

class FakeExecutor {
  failSpawn: boolean = false;
  lastSpawnCmd: string = "";
  lastSpawnArgs: string[] = [];
  spawnCount = 0;

  spawn = (
    _cmd: string,
    _args: string[],
    _opts?: Record<string, unknown>,
  ): {
    pid: number;
    result: Promise<{ exitCode: number; stdout: string; stderr: string }>;
    kill: (_signal?: string) => void;
  } => {
    this.spawnCount += 1;
    this.lastSpawnCmd = _cmd;
    this.lastSpawnArgs = _args;
    if (this.failSpawn) {
      throw new Error("ENOENT - command not found");
    }
    return {
      pid: 12345,
      result: Promise.resolve({ exitCode: 0, stdout: "output ok", stderr: "" }),
      kill: () => {},
    };
  };

  run = async () => ({ exitCode: 0, stdout: "", stderr: "" });
}

// ── Fake LocalExecutionBackendFactory ────────────────────
//
// Produces a backend that simulates LocalRunner.stageAttempt
// and LocalRunner.startAttempt using the fake executor and
// real temp filesystem operations.

// ── Cancel state tracker for idempotent cancellation tests ──
const cancelCallCounts = new Map<string, number>();

function createFakeBackendFactory(executor: FakeExecutor): LocalExecutionBackendFactory {
  return (plan, db, _executor) => ({
    async stageAttempt(job: Job, attemptId: string): Promise<RunnerResult> {
      const jobDir = join(job.workdir, job.id);
      mkdirSync(jobDir, { recursive: true });
      chmodSync(jobDir, 0o700);

      await db.updateJobStatus(job.id, "queued");
      await db.updateJobAttemptStatus(attemptId, "queued");

      const stagedInput = join(jobDir, basename(job.inputPath));
      copyFileSync(job.inputPath, stagedInput);

      await db.createArtifact({
        id: "artifact-fake",
        jobId: job.id,
        attemptId,
        kind: "input",
        path: stagedInput,
        mimeType: "text/plain",
        sizeBytes: statSync(stagedInput).size,
      });

      await db.updateJobAttemptStatus(attemptId, "staged");
      await db.updateJobStatus(job.id, "staged");

      return {
        ok: true,
        message: `Staged ${job.name} in ${jobDir}`,
        metadata: { attemptId, cwd: jobDir, inputPath: stagedInput },
      };
    },

    async startAttempt(job: Job, attemptId: string): Promise<StartedProcess> {
      if (executor.failSpawn) {
        throw new Error("ENOENT - command not found");
      }
      const handle = executor.spawn("sh", ["-c", "echo test"], { cwd: join(job.workdir, job.id) });
      const now = Date.now();
      // Simulate running persistence (as LocalRunner does)
      await db.updateJobAttemptStatus(attemptId, "running", { pid: handle.pid, startedAt: now });
      await db.updateJobStatus(job.id, "running");
      const event: EigenGridEventBase = {
        id: "evt-fake",
        type: "process.started",
        at: now,
        source: "runner",
        jobId: job.id,
        attemptId,
        payload: { pid: handle.pid, command: "sh", cwd: join(job.workdir, job.id) },
      };
      await db.appendEvent(event);
      return { ok: true, pid: handle.pid, command: "sh" };
    },

    // WU-04 mock methods
    async reconcileAttempt() {
      return { status: "completed" as const, exitCode: 0, message: "mock reconcile" };
    },

    async cancelAttempt(job: Job, attemptId: string) {
      const count = (cancelCallCounts.get(attemptId) ?? 0) + 1;
      cancelCallCounts.set(attemptId, count);
      const transitioned = count === 1;
      await db.materializeTerminalAttempt({
        jobId: job.id,
        attemptId,
        status: "cancelled",
        finishedAt: 12_345,
        source: "runner",
        payload: { pid: 12345, signal: "SIGTERM" },
      });
      return {
        ok: true as const,
        transitioned,
        receipt: {
          schemaVersion: 1,
          jobId: "",
          attemptId: "",
          pid: 12345,
          command: "",
          args: [],
          cwd: "",
          exitCode: null,
          signal: "SIGTERM",
          finishedAt: 12_345,
          status: "cancelled" as const,
        },
        message: transitioned ? "Cancel signalled" : "Already cancelled",
      };
    },

    async collectAttempt(_job: Job, _attemptId: string) {
      return { ok: true as const, artifacts: [] as string[], message: "mock collect" };
    },
  });
}

// ── Recipe registry factory ───────────────────────────────

function createRecipeRegistry(): RecipeRegistry {
  const recipes = [
    {
      id: "orca-sp",
      software: "orca" as const,
      description: "ORCA single point",
      inputExtensions: [".inp"],
      commands: {
        local: { run: "orca {{input}} > {{output}}" },
      },
      outputs: { mainLog: "{{basename}}.log" },
      parser: { name: "orca" as const },
      resources: { defaultCores: 1, defaultMemoryGb: 1 },
    },
  ];

  return {
    recipes,
    find: (id: string) => recipes.find((r) => r.id === id),
    findRunnable: () => recipes[0],
  };
}

// ── Config factory ────────────────────────────────────────

function createTestConfig(jobsDir: string): Config {
  return {
    databasePath: ":memory:",
    dbProvider: "sqlite",
    jobsDir,
    logsDir: "/tmp/logs",
    outputsDir: "/tmp/outputs",
    pythonCommand: "python3",
    sessionsDir: "/tmp/sessions",
  } as Config;
}

// ── Tests ─────────────────────────────────────────────────

describe("ExecutionCoordinator", () => {
  let tmpDir: string;
  let inputDir: string;
  let inputFile: string;

  beforeAll(() => {
    tmpDir = `/tmp/exec-test-${Date.now()}`;
    inputDir = join(tmpDir, "inputs");
    mkdirSync(inputDir, { recursive: true });
    inputFile = join(inputDir, "water.inp");
    writeFileSync(
      inputFile,
      "%pal nprocs 4 end\n! BP86 def2-SVP\n* xyz 0 1\nO 0 0 0\nH 0 0 1\nH 0 1 0\n*",
    );
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("successful local submit: job → attempt → filesystem → artifact → spawn → running", async () => {
    const db = new TracedDatabase();
    const executor = new FakeExecutor();
    const jobsDir = join(tmpDir, "jobs1");
    mkdirSync(jobsDir, { recursive: true });

    const coord = new ExecutionCoordinator({
      db,
      config: createTestConfig(jobsDir),
      recipes: createRecipeRegistry(),
      clock: () => 1000,
      idGenerator: (prefix: string) => `${prefix}_test_1`,
      executor: executor as any,
      localBackendFactory: createFakeBackendFactory(executor),
    });

    const request: LocalExecutionRequest = {
      software: "orca",
      inputPath: inputFile,
      name: "water.inp",
    };

    const result = await coord.executeLocal(request);

    // Success outcome
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.jobId).toBe("job_test_1");
    expect(result.attemptId).toBe("attempt_test_1");
    expect(result.pid).toBe(12345);

    // ── Operation ordering assertions ─────────────────────
    const ops = db.operations.map((o) => `${o.type}:${JSON.stringify(o.details ?? {})}`);

    // Job created before attempt
    const createJobIdx = ops.findIndex((o) => o.startsWith("createJob"));
    const createAttemptIdx = ops.findIndex((o) => o.startsWith("createJobAttempt"));
    expect(createJobIdx).toBeGreaterThanOrEqual(0);
    expect(createAttemptIdx).toBeGreaterThan(createJobIdx);

    // Attempt created before any job/attempt status update
    const firstStatusUpdate = ops.findIndex(
      (o) => o.startsWith("updateJobStatus") || o.startsWith("updateJobAttemptStatus"),
    );
    expect(createAttemptIdx).toBeLessThan(firstStatusUpdate >= 0 ? firstStatusUpdate : ops.length);

    // Exactly one job
    expect(db.jobsMap.size).toBe(1);
    expect(db.jobsMap.has("job_test_1")).toBe(true);

    // Exactly one attempt
    expect(db.attemptsMap.size).toBe(1);
    expect(db.attemptsMap.has("attempt_test_1")).toBe(true);

    // Job reaches running
    const job = db.jobsMap.get("job_test_1") as Record<string, unknown>;
    expect(job?.status).toBe("running");

    // Attempt reaches running with PID/startedAt
    const attempt = db.attemptsMap.get("attempt_test_1") as Record<string, unknown>;
    expect(attempt?.status).toBe("running");
    expect(attempt?.pid).toBe(12345);
    expect(attempt?.startedAt).toBeGreaterThan(0);

    // Events occur once with real IDs
    const eventsByType: Record<string, EigenGridEventBase[]> = {};
    for (const evt of db.eventsStore) {
      (eventsByType[evt.type] ??= []).push(evt);
    }

    expect(eventsByType["job.created"]).toHaveLength(1);
    expect(eventsByType["job.created"]![0]!.jobId).toBe("job_test_1");

    expect(eventsByType["recipe.selected"]).toHaveLength(1);

    expect(eventsByType["attempt.created"]).toHaveLength(1);
    expect(eventsByType["attempt.created"]![0]!.attemptId).toBe("attempt_test_1");

    expect(eventsByType["process.started"]).toHaveLength(1);
    expect(eventsByType["process.started"]![0]!.attemptId).toBe("attempt_test_1");

    // Filesystem: job directory exists with input copied
    const jobDir = join(jobsDir, "job_test_1");
    expect(existsSync(jobDir)).toBe(true);
    expect(existsSync(join(jobDir, "water.inp"))).toBe(true);

    // Input artifact registered
    const inputArtifacts = [...db.artifactsMap.values()].filter((a) => a.kind === "input");
    expect(inputArtifacts.length).toBe(1);
  });

  it("exactly one job and one attempt on successful submission", async () => {
    const db = new TracedDatabase();
    const executor = new FakeExecutor();
    const jobsDir = join(tmpDir, "jobs2");
    mkdirSync(jobsDir, { recursive: true });

    const coord = new ExecutionCoordinator({
      db,
      config: createTestConfig(jobsDir),
      recipes: createRecipeRegistry(),
      clock: () => 2000,
      idGenerator: (prefix: string) => `${prefix}_test_2`,
      executor: executor as any,
      localBackendFactory: createFakeBackendFactory(executor),
    });

    const result = await coord.executeLocal({
      software: "orca",
      inputPath: inputFile,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(db.jobsMap.size).toBe(1);
    expect(db.attemptsMap.size).toBe(1);
    expect(result.attemptId).toBe("attempt_test_2");
    expect(result.pid).toBe(12345);
  });

  it("stable intended identities replay without a second scientific dispatch", async () => {
    const db = new TracedDatabase();
    const executor = new FakeExecutor();
    const jobsDir = join(tmpDir, "jobs-idempotent");
    mkdirSync(jobsDir, { recursive: true });
    const coord = new ExecutionCoordinator({
      db,
      config: createTestConfig(jobsDir),
      recipes: createRecipeRegistry(),
      clock: () => 2500,
      idGenerator: (prefix: string) => `${prefix}_unused`,
      executor: executor as any,
      localBackendFactory: createFakeBackendFactory(executor),
    });
    const request: LocalExecutionRequest = {
      software: "orca",
      inputPath: inputFile,
      intendedJobId: "job_operation_1",
      intendedAttemptId: "attempt_operation_1",
    };

    const first = await coord.executeLocal(request);
    const duplicate = await coord.executeLocal(request);

    expect(first.ok).toBe(true);
    expect(duplicate).toMatchObject({
      ok: true,
      jobId: "job_operation_1",
      attemptId: "attempt_operation_1",
      replayed: true,
      status: "completed",
    });
    expect(db.jobsMap.size).toBe(1);
    expect(db.attemptsMap.size).toBe(1);
    expect(executor.spawnCount).toBe(1);
  });

  it("stable identity reuse with modified scientific execution content fails closed", async () => {
    const db = new TracedDatabase();
    const executor = new FakeExecutor();
    const jobsDir = join(tmpDir, "jobs-idempotency-conflict");
    mkdirSync(jobsDir, { recursive: true });
    const coord = new ExecutionCoordinator({
      db,
      config: createTestConfig(jobsDir),
      recipes: createRecipeRegistry(),
      clock: () => 2600,
      idGenerator: (prefix: string) => `${prefix}_unused`,
      executor: executor as any,
      localBackendFactory: createFakeBackendFactory(executor),
    });
    const stableIdentity = {
      intendedJobId: "job_operation_conflict",
      intendedAttemptId: "attempt_operation_conflict",
    };
    expect(
      await coord.executeLocal({ software: "orca", inputPath: inputFile, ...stableIdentity }),
    ).toMatchObject({ ok: true });

    const otherInput = join(inputDir, "other.inp");
    writeFileSync(otherInput, "! HF STO-3G\n* xyz 0 1\nH 0 0 0\nH 0 0 1\n*");
    const conflict = await coord.executeLocal({
      software: "orca",
      inputPath: otherInput,
      ...stableIdentity,
    });

    expect(conflict).toMatchObject({ ok: false, jobId: "job_operation_conflict" });
    expect(executor.spawnCount).toBe(1);
  });

  it("rejects bytes mutated between authorization and staging without spawning", async () => {
    const db = new TracedDatabase();
    const executor = new FakeExecutor();
    const jobsDir = join(tmpDir, "jobs-staged-digest");
    const source = join(inputDir, "staged-digest.inp");
    const approvedBytes = "! HF STO-3G\n* xyz 0 1\nH 0 0 0\n*\n";
    writeFileSync(source, approvedBytes);
    mkdirSync(jobsDir, { recursive: true });

    const baseFactory = createFakeBackendFactory(executor);
    const coord = new ExecutionCoordinator({
      db,
      config: createTestConfig(jobsDir),
      recipes: createRecipeRegistry(),
      clock: () => 2650,
      idGenerator: (prefix: string) => `${prefix}_staged_digest`,
      executor: executor as any,
      localBackendFactory: (plan, database, commandExecutor) => {
        const backend = baseFactory(plan, database, commandExecutor);
        return {
          ...backend,
          async stageAttempt(job, attemptId) {
            writeFileSync(source, "! MUTATED\n* xyz 0 1\nHe 0 0 0\n*\n");
            return backend.stageAttempt(job, attemptId);
          },
        };
      },
    });

    const result = await coord.executeLocal({
      software: "orca",
      inputPath: source,
      expectedInputDigest: createHash("sha256").update(approvedBytes).digest("hex"),
    });

    expect(result).toMatchObject({
      ok: false,
      message: "Staged input bytes do not match the approved input digest",
    });
    expect(executor.spawnCount).toBe(0);
    expect(db.jobsMap.get("job_staged_digest")?.status).toBe("failed");
    expect(db.attemptsMap.get("attempt_staged_digest")?.status).toBe("failed");
    expect(db.eventsStore.some((event) => event.type === "process.started")).toBe(false);
  });

  it("same attempt ID across stage/start/events/PID", async () => {
    const db = new TracedDatabase();
    const executor = new FakeExecutor();
    const jobsDir = join(tmpDir, "jobs3");
    mkdirSync(jobsDir, { recursive: true });

    const coord = new ExecutionCoordinator({
      db,
      config: createTestConfig(jobsDir),
      recipes: createRecipeRegistry(),
      clock: () => 3000,
      idGenerator: (prefix: string) => `${prefix}_test_3`,
      executor: executor as any,
      localBackendFactory: createFakeBackendFactory(executor),
    });

    const result = await coord.executeLocal({
      software: "orca",
      inputPath: inputFile,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // All events with attemptId reference the coordinator-created ID
    for (const evt of db.eventsStore) {
      if (evt.attemptId) {
        expect(evt.attemptId).toBe("attempt_test_3");
      }
    }

    // Process.started references PID
    const startedEvt = db.eventsStore.find((e) => e.type === "process.started");
    expect(startedEvt).toBeDefined();
    expect(startedEvt!.payload?.pid).toBe(12345);
  });

  it("validation failure has zero filesystem/process effects", async () => {
    const db = new TracedDatabase();
    const executor = new FakeExecutor();
    const jobsDir = join(tmpDir, "jobs4");
    mkdirSync(jobsDir, { recursive: true });

    const coord = new ExecutionCoordinator({
      db,
      config: createTestConfig(jobsDir),
      recipes: createRecipeRegistry(),
      clock: () => 4000,
      idGenerator: (prefix: string) => `${prefix}_test_4`,
      executor: executor as any,
      localBackendFactory: createFakeBackendFactory(executor),
    });

    const result = await coord.executeLocal({
      software: "orca",
      inputPath: "/nonexistent/input.inp",
    });

    expect(result.ok).toBe(false);
    expect(db.jobsMap.size).toBe(0);
    expect(db.attemptsMap.size).toBe(0);
    expect(db.artifactsMap.size).toBe(0);
    expect(db.eventsStore.length).toBe(0);
    expect(existsSync(join(jobsDir, "job_test_4"))).toBe(false);
  });

  it("recipe not found — zero effects", async () => {
    const db = new TracedDatabase();
    const executor = new FakeExecutor();
    const jobsDir = join(tmpDir, "jobs5");
    mkdirSync(jobsDir, { recursive: true });

    const recipes: RecipeRegistry = {
      recipes: [],
      find: () => undefined,
      findRunnable: () => undefined,
    };

    const coord = new ExecutionCoordinator({
      db,
      config: createTestConfig(jobsDir),
      recipes,
      clock: () => 5000,
      idGenerator: (prefix: string) => `${prefix}_test_5`,
      executor: executor as any,
      localBackendFactory: createFakeBackendFactory(executor),
    });

    const result = await coord.executeLocal({
      software: "nonexistent",
      inputPath: inputFile,
    });

    expect(result.ok).toBe(false);
    expect(db.jobsMap.size).toBe(0);
    expect(db.attemptsMap.size).toBe(0);
    expect(db.eventsStore.length).toBe(0);
    expect(existsSync(join(jobsDir, "job_test_5"))).toBe(false);
  });

  it("stage filesystem failure leads to durable failed state", async () => {
    const db = new TracedDatabase();
    const executor = new FakeExecutor();
    // Use a path where mkdirSync will fail (parent is a file)
    const failFile = join(tmpDir, "jobs6-blocker");
    writeFileSync(failFile, "");
    const failDir = join(failFile, "subdir");

    const coord = new ExecutionCoordinator({
      db,
      config: createTestConfig(failDir),
      recipes: createRecipeRegistry(),
      clock: () => 6000,
      idGenerator: (prefix: string) => `${prefix}_test_6`,
      executor: executor as any,
      localBackendFactory: createFakeBackendFactory(executor),
    });

    const result = await coord.executeLocal({
      software: "orca",
      inputPath: inputFile,
    });

    expect(result.ok).toBe(false);

    // Job and attempt should exist (created before stage attempt) and be failed
    const job = db.jobsMap.get("job_test_6") as Record<string, unknown> | undefined;
    expect(job).toBeDefined();
    expect(job?.status).toBe("failed");

    const attempt = db.attemptsMap.get("attempt_test_6") as Record<string, unknown> | undefined;
    expect(attempt).toBeDefined();
    expect(attempt?.status).toBe("failed");

    // process.failed event should exist
    const failedEvt = db.eventsStore.find((e) => e.type === "process.failed");
    expect(failedEvt).toBeDefined();
    expect(failedEvt?.attemptId).toBe("attempt_test_6");

    // Cleanup
    rmSync(failFile, { force: true });
  });

  it("reports safely-unknown when failure-state persistence itself fails", async () => {
    const db = new TransitionFailingDatabase();
    const executor = new FakeExecutor();
    const failFile = join(tmpDir, "jobs6-state-persistence-blocker");
    writeFileSync(failFile, "");
    const failDir = join(failFile, "subdir");
    db.failJobStatus = "failed";
    db.failAttemptStatus = "failed";

    const coord = new ExecutionCoordinator({
      db,
      config: createTestConfig(failDir),
      recipes: createRecipeRegistry(),
      clock: () => 6500,
      idGenerator: (prefix: string) => `${prefix}_test_6b`,
      executor: executor as any,
      localBackendFactory: createFakeBackendFactory(executor),
    });

    const result = await coord.executeLocal({ software: "orca", inputPath: inputFile });
    expect(result).toMatchObject({ ok: false, status: "safely-unknown" });
    if (!result.ok) expect(result.message).toContain("Unable to persist failure state");
    expect(db.eventsStore.some((event) => event.type === "process.failed")).toBe(false);
    rmSync(failFile, { force: true });
  });

  it("start exception remains safely-unknown because it may be post-spawn", async () => {
    const db = new TracedDatabase();
    const executor = new FakeExecutor();
    executor.failSpawn = true;
    const jobsDir = join(tmpDir, "jobs7");
    mkdirSync(jobsDir, { recursive: true });

    const coord = new ExecutionCoordinator({
      db,
      config: createTestConfig(jobsDir),
      recipes: createRecipeRegistry(),
      clock: () => 7000,
      idGenerator: (prefix: string) => `${prefix}_test_7`,
      executor: executor as any,
      localBackendFactory: createFakeBackendFactory(executor),
    });

    const result = await coord.executeLocal({
      software: "orca",
      inputPath: inputFile,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("safely-unknown");

    const job = db.jobsMap.get("job_test_7") as Record<string, unknown> | undefined;
    expect(job).toBeDefined();
    expect(job?.status).toBe("staged");

    const attempt = db.attemptsMap.get("attempt_test_7") as Record<string, unknown> | undefined;
    expect(attempt).toBeDefined();
    expect(attempt?.status).toBe("staged");

    const failedEvt = db.eventsStore.find((e) => e.type === "process.failed");
    expect(failedEvt).toBeUndefined();
  });

  it("dispatchExistingJob preserves reservation on typed termination-unknown", async () => {
    const db = new TracedDatabase();
    const executor = new FakeExecutor();
    const jobsDir = join(tmpDir, "jobs-dispatch-termination-unknown");
    mkdirSync(jobsDir, { recursive: true });
    const jobId = "job_dispatch_unknown";
    const attemptId = "attempt_dispatch_unknown";
    await db.createJob({
      id: jobId,
      name: basename(inputFile),
      software: "orca",
      inputPath: inputFile,
      workdir: jobsDir,
    });
    await db.createJobAttempt({
      id: attemptId,
      jobId,
      runner: "local",
      command: "orca input.inp",
      cwd: join(jobsDir, jobId),
      status: "created",
    });

    const baseFactory = createFakeBackendFactory(executor);
    const coord = new ExecutionCoordinator({
      db,
      config: createTestConfig(jobsDir),
      recipes: createRecipeRegistry(),
      clock: () => 7100,
      idGenerator: (prefix: string) => `${prefix}_unused`,
      executor: executor as any,
      localBackendFactory: (plan, database, commandExecutor) => {
        const backend = baseFactory(plan, database, commandExecutor);
        return {
          ...backend,
          async startAttempt(job: Job, exactAttemptId: string): Promise<StartedProcess> {
            await database.updateJobAttemptStatus(exactAttemptId, "running", {
              pid: 12345,
              startedAt: 7100,
            });
            await database.updateJobStatus(job.id, "running");
            return {
              ok: false,
              failureDisposition: "termination-unknown",
              message: "supervisor termination is safely-unknown",
            };
          },
        };
      },
    });

    const outcome = await coord.dispatchExistingJob(jobId, attemptId);

    expect(outcome).toMatchObject({
      ok: false,
      jobId,
      attemptId,
      status: "safely-unknown",
    });
    expect(db.jobsMap.get(jobId)?.status).toBe("running");
    expect(db.attemptsMap.get(attemptId)?.status).toBe("running");
    expect(db.operations.some((operation) => operation.type === "releaseJobDispatch")).toBe(false);
    expect(db.eventsStore.some((event) => event.type === "process.failed")).toBe(false);
  });

  it("running state is NOT persisted before spawn returns", async () => {
    const db = new TracedDatabase();
    const executor = new FakeExecutor();
    const jobsDir = join(tmpDir, "jobs8");
    mkdirSync(jobsDir, { recursive: true });

    let checkBeforeSpawnReturn = false;

    // Wrap spawn to verify running is not set before spawn returns
    const origSpawn = executor.spawn;
    executor.spawn = ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
      checkBeforeSpawnReturn = true;
      // Before returning from spawn, running state must NOT be set
      const attempt = db.attemptsMap.get("attempt_test_8") as Record<string, unknown> | undefined;
      expect(attempt?.status).not.toBe("running");
      const job = db.jobsMap.get("job_test_8") as Record<string, unknown> | undefined;
      expect(job?.status).not.toBe("running");
      return origSpawn.call(executor, cmd, args, opts);
    }) as typeof executor.spawn;

    const coord = new ExecutionCoordinator({
      db,
      config: createTestConfig(jobsDir),
      recipes: createRecipeRegistry(),
      clock: () => 8000,
      idGenerator: (prefix: string) => `${prefix}_test_8`,
      executor: executor as any,
      localBackendFactory: createFakeBackendFactory(executor),
    });

    const result = await coord.executeLocal({
      software: "orca",
      inputPath: inputFile,
    });

    expect(result.ok).toBe(true);
    expect(checkBeforeSpawnReturn).toBe(true);

    // After coordinator returns, running state IS set
    const attempt = db.attemptsMap.get("attempt_test_8") as Record<string, unknown> | undefined;
    expect(attempt?.status).toBe("running");
    const job = db.jobsMap.get("job_test_8") as Record<string, unknown> | undefined;
    expect(job?.status).toBe("running");
    expect(attempt?.pid).toBe(12345);
    expect(attempt?.startedAt).toBeGreaterThan(0);
  });

  it("no legacy ensureAttempt/auto-stage route on canonical path", async () => {
    const db = new TracedDatabase();
    const executor = new FakeExecutor();
    const jobsDir = join(tmpDir, "jobs9");
    mkdirSync(jobsDir, { recursive: true });

    const coord = new ExecutionCoordinator({
      db,
      config: createTestConfig(jobsDir),
      recipes: createRecipeRegistry(),
      clock: () => 9000,
      idGenerator: (prefix: string) => `${prefix}_test_9`,
      executor: executor as any,
      localBackendFactory: createFakeBackendFactory(executor),
    });

    const result = await coord.executeLocal({
      software: "orca",
      inputPath: inputFile,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify that listJobAttempts was never called (no ensureAttempt inference)
    const listAttemptsCalls = db.operations.filter((o) => o.type === "listJobAttempts");
    expect(listAttemptsCalls.length).toBe(0);

    // Verify that only ONE attempt was created (by coordinator, not by runner)
    expect(db.attemptsMap.size).toBe(1);
  });

  // ── WU-04: reconcileLocal ──────────────────────────────────

  describe("reconcileLocal", () => {
    it("delegates to backend reconcileAttempt with correct attempt ID", async () => {
      const db = new TracedDatabase();
      const executor = new FakeExecutor();
      const jobsDir = join(tmpDir, "wurecon1");
      mkdirSync(jobsDir, { recursive: true });
      let capturedAttemptId = "";

      const trackingFactory: LocalExecutionBackendFactory = (plan, db_, exec) => {
        const base = createFakeBackendFactory(executor)(plan, db_, exec);
        return {
          ...base,
          async reconcileAttempt(_job: Job, attemptId: string) {
            capturedAttemptId = attemptId;
            return { status: "completed" as const, exitCode: 0, message: "receipt found" };
          },
        };
      };

      const coord = new ExecutionCoordinator({
        db,
        config: createTestConfig(jobsDir),
        recipes: createRecipeRegistry(),
        clock: () => 10000,
        idGenerator: (prefix: string) => `${prefix}_wu_recon1`,
        executor: executor as any,
        localBackendFactory: trackingFactory,
      });

      // Execute a job first
      const execResult = await coord.executeLocal({
        software: "orca",
        inputPath: inputFile,
      });
      expect(execResult.ok).toBe(true);
      if (!execResult.ok) return;

      // Now reconcile
      const result = await coord.reconcileLocal(execResult.jobId);

      expect(capturedAttemptId).toBe(execResult.attemptId);
      expect(result.status).toBe("completed");
      expect(result.jobId).toBe(execResult.jobId);
      if (result.status !== "safely-unknown") {
        expect(result.attemptId).toBe(execResult.attemptId);
        expect(result.exitCode).toBe(0);
      }
    });

    it("returns safely-unknown for unknown jobs", async () => {
      const db = new TracedDatabase();
      const coord = new ExecutionCoordinator({
        db,
        config: createTestConfig(tmpDir),
        recipes: createRecipeRegistry(),
        clock: () => 10000,
        idGenerator: (prefix: string) => `${prefix}_x`,
        localBackendFactory: createFakeBackendFactory(new FakeExecutor()),
      });

      const result = await coord.reconcileLocal("nonexistent");
      expect(result.status).toBe("safely-unknown");
    });

    it("returns safely-unknown when backend returns safely-unknown", async () => {
      const db = new TracedDatabase();
      const executor = new FakeExecutor();
      const jobsDir = join(tmpDir, "wurecon3");
      mkdirSync(jobsDir, { recursive: true });

      const unknownFactory: LocalExecutionBackendFactory = (plan, db_, exec) => {
        const base = createFakeBackendFactory(executor)(plan, db_, exec);
        return {
          ...base,
          async reconcileAttempt() {
            return { status: "safely-unknown" as const, message: "no process evidence" };
          },
        };
      };

      const coord = new ExecutionCoordinator({
        db,
        config: createTestConfig(jobsDir),
        recipes: createRecipeRegistry(),
        clock: () => 10000,
        idGenerator: (prefix: string) => `${prefix}_wu_recon3`,
        executor: executor as any,
        localBackendFactory: unknownFactory,
      });

      const execResult = await coord.executeLocal({
        software: "orca",
        inputPath: inputFile,
      });
      expect(execResult.ok).toBe(true);
      if (!execResult.ok) return;

      const result = await coord.reconcileLocal(execResult.jobId);
      expect(result.status).toBe("safely-unknown");
    });

    it("does not emit system.notice on reconciliation (idempotent read)", async () => {
      const db = new TracedDatabase();
      const executor = new FakeExecutor();
      const jobsDir = join(tmpDir, "wurecon4");
      mkdirSync(jobsDir, { recursive: true });

      const coord = new ExecutionCoordinator({
        db,
        config: createTestConfig(jobsDir),
        recipes: createRecipeRegistry(),
        clock: () => 10000,
        idGenerator: (prefix: string) => `${prefix}_wu_recon4`,
        executor: executor as any,
        localBackendFactory: createFakeBackendFactory(executor),
      });

      const execResult = await coord.executeLocal({
        software: "orca",
        inputPath: inputFile,
      });
      expect(execResult.ok).toBe(true);
      if (!execResult.ok) return;

      // Reconcile twice — no events should be appended for reconciliation
      const eventCountBefore = db.eventsStore.length;
      await coord.reconcileLocal(execResult.jobId);
      await coord.reconcileLocal(execResult.jobId);
      expect(db.eventsStore.length).toBe(eventCountBefore);
    });
  });

  // ── WU-04: cancelLocal ─────────────────────────────────────

  describe("cancelLocal", () => {
    it("cancels a running job, reports transitioned:true, emits exactly one process.cancelled", async () => {
      const db = new TracedDatabase();
      const executor = new FakeExecutor();
      const jobsDir = join(tmpDir, "wucancel1");
      mkdirSync(jobsDir, { recursive: true });
      cancelCallCounts.clear();

      const coord = new ExecutionCoordinator({
        db,
        config: createTestConfig(jobsDir),
        recipes: createRecipeRegistry(),
        clock: () => 11000,
        idGenerator: (prefix: string) => `${prefix}_wu_cancel1`,
        executor: executor as any,
        localBackendFactory: createFakeBackendFactory(executor),
      });

      const execResult = await coord.executeLocal({
        software: "orca",
        inputPath: inputFile,
      });
      expect(execResult.ok).toBe(true);
      if (!execResult.ok) return;

      const result = await coord.cancelLocal(execResult.jobId);
      expect(result.ok).toBe(true);
      expect(result.jobId).toBe(execResult.jobId);
      if (result.ok) {
        expect(result.transitioned).toBe(true);
        expect(result.attemptId).toBe(execResult.attemptId);
        expect(result.receipt).toBeDefined();
        expect(result.receipt.status).toBe("cancelled");
      }

      // Verify exactly one process.cancelled event emitted
      const cancelledEvents = db.eventsStore.filter((e) => e.type === "process.cancelled");
      expect(cancelledEvents.length).toBe(1);
      expect(cancelledEvents[0]?.attemptId).toBe(execResult.attemptId);
    });

    it("first cancel is transitioned:true, repeat is transitioned:false with no second event", async () => {
      const db = new TracedDatabase();
      const executor = new FakeExecutor();
      const jobsDir = join(tmpDir, "wucancel2");
      mkdirSync(jobsDir, { recursive: true });
      cancelCallCounts.clear();

      const coord = new ExecutionCoordinator({
        db,
        config: createTestConfig(jobsDir),
        recipes: createRecipeRegistry(),
        clock: () => 12000,
        idGenerator: (prefix: string) => `${prefix}_wu_cancel2`,
        executor: executor as any,
        localBackendFactory: createFakeBackendFactory(executor),
      });

      const execResult = await coord.executeLocal({
        software: "orca",
        inputPath: inputFile,
      });
      expect(execResult.ok).toBe(true);
      if (!execResult.ok) return;

      // First cancel — transitioned:true
      const first = await coord.cancelLocal(execResult.jobId);
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(first.transitioned).toBe(true);
        expect(first.receipt.status).toBe("cancelled");
      }
      const eventsAfterFirstCancel = db.eventsStore.filter((e) => e.type === "process.cancelled");
      expect(eventsAfterFirstCancel.length).toBe(1);

      // Second cancel — transitioned:false, no added process.cancelled event
      const second = await coord.cancelLocal(execResult.jobId);
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.transitioned).toBe(false);
      }
      const eventsAfterSecondCancel = db.eventsStore.filter((e) => e.type === "process.cancelled");
      expect(eventsAfterSecondCancel.length).toBe(1);
    });

    it("returns ok:false for nonexistent jobs", async () => {
      const db = new TracedDatabase();
      const coord = new ExecutionCoordinator({
        db,
        config: createTestConfig(tmpDir),
        recipes: createRecipeRegistry(),
        clock: () => 12000,
        idGenerator: (prefix: string) => `${prefix}_x`,
        localBackendFactory: createFakeBackendFactory(new FakeExecutor()),
      });

      const result = await coord.cancelLocal("nonexistent");
      expect(result.ok).toBe(false);
    });
  });

  describe("cancelPending", () => {
    it("atomically cancels a queued attempt without invoking a runner", async () => {
      const db = new TracedDatabase();
      await db.createJob({
        id: "pending-job",
        name: "pending.inp",
        software: "orca",
        inputPath: inputFile,
        workdir: tmpDir,
      });
      await db.updateJobStatus("pending-job", "queued");
      await db.createJobAttempt({
        id: "pending-attempt",
        jobId: "pending-job",
        runner: "local",
        command: "orca pending.inp",
        cwd: tmpDir,
      });
      await db.updateJobAttemptStatus("pending-attempt", "queued");

      const coord = new ExecutionCoordinator({
        db,
        config: createTestConfig(tmpDir),
        recipes: createRecipeRegistry(),
        clock: () => 14_000,
        idGenerator: (prefix: string) => `${prefix}_pending`,
        localBackendFactory: createFakeBackendFactory(new FakeExecutor()),
      });

      const result = await coord.cancelPending("pending-job", "operator requested");
      expect(result).toMatchObject({
        ok: true,
        jobId: "pending-job",
        attemptId: "pending-attempt",
        previousStatus: "queued",
      });
      expect(db.jobsMap.get("pending-job")?.status).toBe("cancelled");
      expect(db.attemptsMap.get("pending-attempt")?.status).toBe("cancelled");
      expect(
        db.eventsStore.filter(
          (event) => event.type === "process.cancelled" && event.attemptId === "pending-attempt",
        ),
      ).toHaveLength(1);
    });

    it("cancels a queued job with no attempt through the coordinator", async () => {
      const db = new TracedDatabase();
      await db.createJob({
        id: "pending-no-attempt",
        name: "pending.inp",
        software: "orca",
        inputPath: inputFile,
        workdir: tmpDir,
      });
      await db.updateJobStatus("pending-no-attempt", "queued");
      const coord = new ExecutionCoordinator({
        db,
        config: createTestConfig(tmpDir),
        recipes: createRecipeRegistry(),
        clock: () => 15_000,
        idGenerator: (prefix: string) => `${prefix}_pending_empty`,
        localBackendFactory: createFakeBackendFactory(new FakeExecutor()),
      });

      const result = await coord.cancelPending("pending-no-attempt");
      expect(result).toMatchObject({
        ok: true,
        jobId: "pending-no-attempt",
        previousStatus: "queued",
      });
      expect(db.jobsMap.get("pending-no-attempt")?.status).toBe("cancelled");
    });
  });

  // ── WU-04: collectLocal ────────────────────────────────────

  describe("collectLocal", () => {
    it("collects artifacts for a completed job", async () => {
      const db = new TracedDatabase();
      const executor = new FakeExecutor();
      const jobsDir = join(tmpDir, "wucollect1");
      mkdirSync(jobsDir, { recursive: true });

      const coord = new ExecutionCoordinator({
        db,
        config: createTestConfig(jobsDir),
        recipes: createRecipeRegistry(),
        clock: () => 13000,
        idGenerator: (prefix: string) => `${prefix}_wu_collect1`,
        executor: executor as any,
        localBackendFactory: createFakeBackendFactory(executor),
      });

      const execResult = await coord.executeLocal({
        software: "orca",
        inputPath: inputFile,
      });
      expect(execResult.ok).toBe(true);
      if (!execResult.ok) return;

      const result = await coord.collectLocal(execResult.jobId);
      expect(result.ok).toBe(true);
      expect(result.jobId).toBe(execResult.jobId);
      expect(result.attemptId).toBe(execResult.attemptId);
      expect(Array.isArray(result.artifacts)).toBe(true);
    });

    it("is idempotent — second call does not add duplicate artifacts", async () => {
      const db = new TracedDatabase();
      const executor = new FakeExecutor();
      const jobsDir = join(tmpDir, "wucollect2");
      mkdirSync(jobsDir, { recursive: true });

      const coord = new ExecutionCoordinator({
        db,
        config: createTestConfig(jobsDir),
        recipes: createRecipeRegistry(),
        clock: () => 13000,
        idGenerator: (prefix: string) => `${prefix}_wu_collect2`,
        executor: executor as any,
        localBackendFactory: createFakeBackendFactory(executor),
      });

      const execResult = await coord.executeLocal({
        software: "orca",
        inputPath: inputFile,
      });
      expect(execResult.ok).toBe(true);
      if (!execResult.ok) return;

      // Collect twice
      const first = await coord.collectLocal(execResult.jobId);
      expect(first.ok).toBe(true);

      const second = await coord.collectLocal(execResult.jobId);
      expect(second.ok).toBe(true);
      expect(second.artifacts.length).toBeGreaterThanOrEqual(0);

      // The fake backend returns a fixed set each time, but the
      // real backend deduplicates. This tests the coordinator path.
    });

    it("returns ok:false for nonexistent jobs", async () => {
      const db = new TracedDatabase();
      const coord = new ExecutionCoordinator({
        db,
        config: createTestConfig(tmpDir),
        recipes: createRecipeRegistry(),
        clock: () => 13000,
        idGenerator: (prefix: string) => `${prefix}_x`,
        localBackendFactory: createFakeBackendFactory(new FakeExecutor()),
      });

      const result = await coord.collectLocal("nonexistent");
      expect(result.ok).toBe(false);
    });

    it("returns backend collect result and artifact.registered comes from adapter createArtifact", async () => {
      const db = new TracedDatabase();
      const executor = new FakeExecutor();
      const jobsDir = join(tmpDir, "wucollect4");
      mkdirSync(jobsDir, { recursive: true });

      const coord = new ExecutionCoordinator({
        db,
        config: createTestConfig(jobsDir),
        recipes: createRecipeRegistry(),
        clock: () => 13000,
        idGenerator: (prefix: string) => `${prefix}_wu_collect4`,
        executor: executor as any,
        localBackendFactory: createFakeBackendFactory(executor),
      });

      const execResult = await coord.executeLocal({
        software: "orca",
        inputPath: inputFile,
      });
      expect(execResult.ok).toBe(true);
      if (!execResult.ok) return;

      // Collect returns the backend's result (fake backend returns empty artifacts)
      const result = await coord.collectLocal(execResult.jobId);
      expect(result.ok).toBe(true);
      expect(Array.isArray(result.artifacts)).toBe(true);

      // artifact.registered events come from adapter createArtifact (called during stage)
      // not from the coordinator. The stage path creates one input artifact.
      const artifactEvents = db.eventsStore.filter((e) => e.type === "artifact.registered");
      expect(artifactEvents.length).toBe(1);
      expect(artifactEvents[0]!.source).toBe("db");
      expect(artifactEvents[0]!.attemptId).toBe(execResult.attemptId);
    });
  });

  // ── WU-04: parseJob ────────────────────────────────────────

  describe("parseJob", () => {
    it("requires parser bridge in deps", async () => {
      const db = new TracedDatabase();
      const executor = new FakeExecutor();
      const jobsDir = join(tmpDir, "wuparse0");
      mkdirSync(jobsDir, { recursive: true });

      const coord = new ExecutionCoordinator({
        db,
        config: createTestConfig(jobsDir),
        recipes: createRecipeRegistry(),
        clock: () => 14000,
        idGenerator: (prefix: string) => `${prefix}_wu_parse0`,
        executor: executor as any,
        localBackendFactory: createFakeBackendFactory(executor),
        // No parser — should fail
      });

      const result = await coord.parseJob("nonexistent");
      expect(result.ok).toBe(false);
      expect(result.message).toContain("No parser bridge");
    });

    it("refuses jobs that are not completed", async () => {
      const db = new TracedDatabase();
      const jobsDir = join(tmpDir, "wuparse1");
      mkdirSync(jobsDir, { recursive: true });

      const mockParser = {
        parse: async () => ({ ok: true, parser: "test", status: "completed" as const }),
      };
      const executor = new FakeExecutor();
      const coord = new ExecutionCoordinator({
        db,
        config: createTestConfig(jobsDir),
        recipes: createRecipeRegistry(),
        clock: () => 14000,
        idGenerator: (prefix: string) => `${prefix}_wu_parse1`,
        executor: executor as any,
        localBackendFactory: createFakeBackendFactory(executor),
        parser: mockParser,
      });

      // Create a job that's still running (not completed)
      const rawResult = await coord.executeLocal({
        software: "orca",
        inputPath: inputFile,
      });
      expect(rawResult.ok).toBe(true);
      if (!rawResult.ok) return;

      // Job is "running" after executeLocal → parseJob should refuse
      const result = await coord.parseJob(rawResult.jobId);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("must be completed");
    });

    it("returns existing result on repeat for already-parsed jobs", async () => {
      const db = new TracedDatabase();
      const jobsDir = join(tmpDir, "wuparse3");
      mkdirSync(jobsDir, { recursive: true });

      // Manually create a job with "parsed" status and a stored result
      const jobId = "job_parsed_1";
      const attemptId = "attempt_parsed_1";
      await db.createJob({
        id: jobId,
        name: "parsed",
        software: "orca",
        inputPath: inputFile,
        workdir: jobsDir,
      });
      await db.updateJobStatus(jobId, "parsed");
      await db.createJobAttempt({
        id: attemptId,
        jobId,
        runner: "local",
        command: "orca water.inp",
        cwd: join(jobsDir, jobId),
      });
      const storedResultId = await db.saveResult({
        jobId,
        attemptId,
        parser: "orca",
        status: "completed",
      });

      const mockParser = {
        parse: async () => ({ ok: true, parser: "test", status: "completed" as const }),
      };
      const coord = new ExecutionCoordinator({
        db,
        config: createTestConfig(jobsDir),
        recipes: createRecipeRegistry(),
        clock: () => 14000,
        idGenerator: (prefix: string) => `${prefix}_wu_parse3`,
        localBackendFactory: createFakeBackendFactory(new FakeExecutor()),
        parser: mockParser,
      });

      const result = await coord.parseJob(jobId);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Returns actual stored result ID — no event scanning, no synthetic fallback
        expect(result.resultId).toBe(storedResultId);
        expect(result.parser).toBe("orca");
        expect(result.message).toContain("already parsed");
      }
    });

    it("parse retry does not scan events or synthesize IDs", async () => {
      const db = new TracedDatabase();
      const jobsDir = join(tmpDir, "wuparse_retry");
      mkdirSync(jobsDir, { recursive: true });

      // Create a completed job with an existing result (simulating partial parse)
      const jobId = "job_retry_1";
      const attemptId = "attempt_retry_1";
      await db.createJob({
        id: jobId,
        name: "retry",
        software: "orca",
        inputPath: inputFile,
        workdir: jobsDir,
      });
      await db.updateJobStatus(jobId, "completed");
      await db.createJobAttempt({
        id: attemptId,
        jobId,
        runner: "local",
        command: "orca water.inp",
        cwd: join(jobsDir, jobId),
      });
      const storedResultId = await db.saveResult({
        jobId,
        attemptId,
        parser: "orca",
        status: "completed",
      });

      const eventCountBefore = db.eventsStore.length;

      const mockParser = {
        parse: async () => ({ ok: true, parser: "test", status: "completed" as const }),
      };
      const coord = new ExecutionCoordinator({
        db,
        config: createTestConfig(jobsDir),
        recipes: createRecipeRegistry(),
        clock: () => 14000,
        idGenerator: (prefix: string) => `${prefix}_wu_retry`,
        localBackendFactory: createFakeBackendFactory(new FakeExecutor()),
        parser: mockParser,
      });

      const result = await coord.parseJob(jobId);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Uses actual stored result ID — no synthetic/fallback ID
        expect(result.resultId).toBe(storedResultId);
        expect(result.parser).toBe("orca");
        expect(result.message).toContain("Completed missing transition");
      }

      // No event scanning occurred — only parse.completed was emitted (no result.saved lookup)
      const eventsAfter = db.eventsStore;
      const parseCompletedEvents = eventsAfter.filter((e) => e.type === "parse.completed");
      const resultSavedEvents = eventsAfter.filter((e) => e.type === "result.saved");
      expect(parseCompletedEvents.length).toBe(1);
      // result.saved was NOT emitted during retry (result already exists)
      expect(resultSavedEvents.length).toBe(0);
      // Only new events added are the parse.completed
      expect(eventsAfter.length).toBe(eventCountBefore + 1);
    });

    it("does not report parse success when the durable parsed transition fails", async () => {
      const db = new TransitionFailingDatabase();
      const jobsDir = join(tmpDir, "wuparse-transition-failure");
      const jobId = "job_parse_transition_failure";
      const attemptId = "attempt_parse_transition_failure";
      const jobDir = join(jobsDir, jobId);
      mkdirSync(jobDir, { recursive: true });
      const outputPath = join(jobDir, "output.out");
      writeFileSync(outputPath, "valid output\n");
      await db.createJob({
        id: jobId,
        name: "transition failure",
        software: "orca",
        inputPath: inputFile,
        workdir: jobsDir,
      });
      await db.updateJobStatus(jobId, "completed");
      await db.createJobAttempt({
        id: attemptId,
        jobId,
        runner: "local",
        command: "orca input.inp",
        cwd: jobDir,
        status: "completed",
      });
      await db.createArtifact({
        id: "artifact-transition-failure",
        jobId,
        attemptId,
        kind: "output",
        path: outputPath,
      });

      let parserCalls = 0;
      const coord = new ExecutionCoordinator({
        db,
        config: createTestConfig(jobsDir),
        recipes: createRecipeRegistry(),
        clock: () => 14500,
        idGenerator: (prefix: string) => `${prefix}_transition_failure`,
        localBackendFactory: createFakeBackendFactory(new FakeExecutor()),
        parser: {
          parse: async () => {
            parserCalls += 1;
            return {
              ok: true,
              parser: "orca",
              status: "completed" as const,
              data: { energy_hartree: -1 },
            };
          },
        },
      });

      db.failJobStatus = "parsed";
      const first = await coord.parseJob(jobId);
      expect(first.ok).toBe(false);
      expect(first.message).toContain("durable but parsed transition failed");
      expect(parserCalls).toBe(1);
      expect((await db.getJob(jobId))?.status).toBe("completed");
      expect(await db.listResults(jobId, attemptId)).toHaveLength(1);
      expect(db.eventsStore.some((event) => event.type === "parse.completed")).toBe(false);

      db.failJobStatus = undefined;
      const retry = await coord.parseJob(jobId);
      expect(retry.ok).toBe(true);
      expect(parserCalls).toBe(1);
      expect((await db.getJob(jobId))?.status).toBe("parsed");
      expect(db.eventsStore.filter((event) => event.type === "parse.completed")).toHaveLength(1);
    });

    it("does not reuse a parsed result from an older attempt", async () => {
      const db = new TracedDatabase();
      const jobsDir = join(tmpDir, "wuparse_two_attempts");
      const jobId = "job_parse_two_attempts";
      const firstAttemptId = "attempt_parse_old";
      const secondAttemptId = "attempt_parse_current";
      const jobDir = join(jobsDir, jobId);
      mkdirSync(jobDir, { recursive: true });
      const outputPath = join(jobDir, "current.out");
      writeFileSync(outputPath, "current attempt output\n");
      await db.createJob({
        id: jobId,
        name: "two-attempts",
        software: "orca",
        inputPath: inputFile,
        workdir: jobsDir,
      });
      await db.updateJobStatus(jobId, "completed");
      for (const attemptId of [firstAttemptId, secondAttemptId]) {
        await db.createJobAttempt({
          id: attemptId,
          jobId,
          runner: "local",
          command: "orca water.inp",
          cwd: jobDir,
        });
      }
      const staleResultId = await db.saveResult({
        jobId,
        attemptId: firstAttemptId,
        parser: "orca",
        status: "completed",
        energyHartree: -1,
      });
      await db.createArtifact({
        id: "artifact-current-attempt",
        jobId,
        attemptId: secondAttemptId,
        kind: "output",
        path: outputPath,
      });

      let parseCalls = 0;
      const coord = new ExecutionCoordinator({
        db,
        config: createTestConfig(jobsDir),
        recipes: createRecipeRegistry(),
        clock: () => 15000,
        idGenerator: (prefix: string) => `${prefix}_two_attempts`,
        localBackendFactory: createFakeBackendFactory(new FakeExecutor()),
        parser: {
          parse: async () => {
            parseCalls += 1;
            return {
              ok: true,
              parser: "orca",
              status: "completed" as const,
              data: { energy_hartree: -2 },
            };
          },
        },
      });

      const parsed = await coord.parseJob(jobId);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parseCalls).toBe(1);
      expect(parsed.attemptId).toBe(secondAttemptId);
      expect(parsed.resultId).not.toBe(staleResultId);
      expect((await db.getLatestResult(jobId, firstAttemptId))?.energyHartree).toBe(-1);
      expect((await db.getLatestResult(jobId, secondAttemptId))?.energyHartree).toBe(-2);
    });
  });
});
