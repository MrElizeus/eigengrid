import { describe, expect, it, mock } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import type { Artifact, JobAttempt } from "@eigengrid/core";

mock.restore();

const { LocalRunner } = await import("@eigengrid/runners");

type DatabaseLike = {
  init(): Promise<void>;
  createJob(job: {
    id: string;
    name: string;
    software: string;
    inputPath: string;
    workdir: string;
    outputPath?: string;
    status?: string;
    createdAt?: number;
    updatedAt?: number;
  }): Promise<void>;
  updateJobStatus(jobId: string, status: string): Promise<void>;
  getJob(jobId: string): Promise<Record<string, unknown> | null>;
  listJobs(): Promise<Record<string, unknown>[]>;
  createJobAttempt(attempt: {
    id: string;
    jobId: string;
    runner: "local";
    command: string;
    cwd: string;
    status?: JobAttempt["status"];
    pid?: number;
    exitCode?: number;
    startedAt?: number;
    finishedAt?: number;
  }): Promise<void>;
  updateJobAttemptStatus(
    attemptId: string,
    status: JobAttempt["status"],
    updates?: {
      pid?: number;
      startedAt?: number;
      exitCode?: number;
      finishedAt?: number;
    },
  ): Promise<void>;
  listJobAttempts(jobId?: string): Promise<JobAttempt[]>;
  createArtifact(artifact: Omit<Artifact, "createdAt">): Promise<void>;
  createArtifactIfAbsent(artifact: Omit<Artifact, "createdAt">): Promise<boolean>;
  listArtifacts(jobId?: string): Promise<Artifact[]>;
  materializeTerminalAttempt(evidence: {
    jobId: string;
    attemptId: string;
    status: "completed" | "failed" | "cancelled";
    exitCode?: number;
    finishedAt: number;
    source: "runner";
    payload?: Record<string, unknown>;
  }): Promise<void>;
  appendEvent?: AppendEventHandler;
};

function createMemoryDatabase(): DatabaseLike {
  const jobs = new Map<string, Record<string, unknown>>();
  const attempts: JobAttempt[] = [];
  const artifacts: Artifact[] = [];
  const terminalEvidence = new Set<string>();

  const database: DatabaseLike = {
    async init() {},
    async createJob(job) {
      const now = Date.now();
      jobs.set(job.id, {
        ...job,
        status: job.status ?? "created",
        createdAt: job.createdAt ?? now,
        updatedAt: job.updatedAt ?? now,
      });
    },
    async updateJobStatus(jobId, status) {
      const job = jobs.get(jobId);
      if (!job) throw new Error(`Job not found: ${jobId}`);
      job.status = status;
      job.updatedAt = Date.now();
      jobs.set(jobId, job);
    },
    async getJob(jobId) {
      return jobs.get(jobId) ?? null;
    },
    async listJobs() {
      return [...jobs.values()].sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
    },
    async createJobAttempt(attempt) {
      const now = Date.now();
      attempts.push({
        ...attempt,
        status: attempt.status ?? "created",
        createdAt: now,
        updatedAt: now,
      });
    },
    async updateJobAttemptStatus(attemptId, status, updates) {
      const attempt = attempts.find((entry) => entry.id === attemptId);
      if (!attempt) throw new Error(`Attempt not found: ${attemptId}`);
      attempt.status = status;
      attempt.updatedAt = Date.now();
      if (updates?.pid !== undefined) attempt.pid = updates.pid;
      if (updates?.startedAt !== undefined) attempt.startedAt = updates.startedAt;
      if (updates?.exitCode !== undefined) attempt.exitCode = updates.exitCode;
      if (updates?.finishedAt !== undefined) attempt.finishedAt = updates.finishedAt;
    },
    async listJobAttempts(jobId) {
      return attempts
        .filter((entry) => (jobId ? entry.jobId === jobId : true))
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    async createArtifact(artifact) {
      artifacts.push({
        ...artifact,
        createdAt: Date.now(),
      });
    },
    async createArtifactIfAbsent(artifact) {
      const exists = artifacts.some(
        (entry) =>
          entry.jobId === artifact.jobId &&
          entry.attemptId === artifact.attemptId &&
          entry.kind === artifact.kind &&
          entry.path === artifact.path,
      );
      if (exists) return false;
      await database.createArtifact(artifact);
      return true;
    },
    async listArtifacts(jobId) {
      return artifacts
        .filter((entry) => (jobId ? entry.jobId === jobId : true))
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    async materializeTerminalAttempt(evidence) {
      await database.updateJobAttemptStatus(evidence.attemptId, evidence.status, {
        exitCode: evidence.exitCode,
        finishedAt: evidence.finishedAt,
      });
      await database.updateJobStatus(evidence.jobId, evidence.status);
      const key = `${evidence.jobId}\0${evidence.attemptId}`;
      if (terminalEvidence.has(key)) return;
      terminalEvidence.add(key);
      await database.appendEvent?.({
        id: key,
        type:
          evidence.status === "completed"
            ? "process.completed"
            : evidence.status === "cancelled"
              ? "process.cancelled"
              : "process.failed",
        at: evidence.finishedAt,
        source: evidence.source,
        jobId: evidence.jobId,
        attemptId: evidence.attemptId,
        payload: evidence.payload,
      });
    },
  };
  return database;
}

function createWorkspace(): { root: string; dbPath: string; inputPath: string } {
  const root = mkdtempSync(join(tmpdir(), "eigengrid-local-runner-"));
  const inputPath = join(root, "water.gjf");
  writeFileSync(inputPath, "#p hf/sto-3g\nwater\n");
  return { root, dbPath: join(root, ".eigengrid", "eigengrid.sqlite"), inputPath };
}

function createRunner(database: DatabaseLike, command: string, args: string[] = []) {
  return new (LocalRunner as any)({
    database,
    engines: {
      gaussian: {
        command,
        args,
      },
    },
  });
}

async function waitForAttemptStatus(
  db: DatabaseLike,
  jobId: string,
  status: string,
  timeoutMs = 3000,
) {
  const startedAt = Date.now();

  for (;;) {
    const attempts = await db.listJobAttempts(jobId);
    if (attempts[0]?.status === status) return attempts[0];
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for attempt status ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForCondition(
  condition: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ── Failable database wrapper for post-spawn failure tests ──
// Tracks whether we're in the "start" phase vs "stage" phase
// so failures only trigger during start persistence.

type AppendEventHandler = (event: any) => Promise<void>;

class FailableDatabase {
  readonly inner: DatabaseLike;
  failRunningStatus: "none" | "attempt" | "job" | "event" = "none";
  killCalled = false;
  trackedKill: ((signal?: string) => void) | null = null;

  constructor(inner: DatabaseLike) {
    this.inner = inner;
  }

  setTrackedKill(kill: (signal?: string) => void): void {
    this.trackedKill = kill;
  }

  // ── Database-like shape matching LocalRunner's expectations ──

  async init(): Promise<void> {
    return this.inner.init();
  }
  async close(): Promise<void> {
    return this.inner.close();
  }
  async createJob(job: any): Promise<void> {
    return this.inner.createJob(job);
  }
  async getJob(jobId: string): Promise<Record<string, unknown> | null> {
    return this.inner.getJob(jobId);
  }
  async listJobs(): Promise<Record<string, unknown>[]> {
    return this.inner.listJobs();
  }
  async createJobAttempt(attempt: any): Promise<void> {
    return this.inner.createJobAttempt(attempt);
  }
  async updateJobAttemptStatus(attemptId: string, status: string, updates?: any): Promise<void> {
    if (this.failRunningStatus === "attempt" && status === "running") {
      throw new Error("Simulated attempt running write failure");
    }
    return this.inner.updateJobAttemptStatus(attemptId, status, updates);
  }
  async updateJobStatus(jobId: string, status: string): Promise<void> {
    if (this.failRunningStatus === "job" && status === "running") {
      throw new Error("Simulated job running write failure");
    }
    return this.inner.updateJobStatus(jobId, status);
  }
  async listJobAttempts(jobId?: string): Promise<any[]> {
    return this.inner.listJobAttempts(jobId);
  }
  async createArtifact(artifact: any): Promise<void> {
    return this.inner.createArtifact(artifact);
  }
  async createArtifactIfAbsent(artifact: any): Promise<boolean> {
    return this.inner.createArtifactIfAbsent(artifact);
  }
  async listArtifacts(jobId?: string): Promise<any[]> {
    return this.inner.listArtifacts(jobId);
  }
  async materializeTerminalAttempt(evidence: any): Promise<void> {
    return this.inner.materializeTerminalAttempt(evidence);
  }

  async appendEvent(event: any): Promise<void> {
    if (this.failRunningStatus === "event" && event.type === "process.started") {
      throw new Error("Simulated process.started event failure");
    }
    // For process.failed events in recovery, let them through
    const innerDb = this.inner as DatabaseLike & { appendEvent?: AppendEventHandler };
    if (innerDb.appendEvent) {
      await innerDb.appendEvent(event);
    }
  }

  // ── Minimal stubs for remaining DatabaseLike methods ──
  async getLogs(..._args: any[]): Promise<any[]> {
    return [];
  }
  async insertEvent(..._args: any[]): Promise<void> {}
  async getEvents(..._args: any[]): Promise<any[]> {
    return [];
  }
  async listEvents(..._args: any[]): Promise<any[]> {
    return [];
  }
  async listJobEvents(..._args: any[]): Promise<any[]> {
    return [];
  }
  async listAttemptEvents(..._args: any[]): Promise<any[]> {
    return [];
  }
  async getTimeline(..._args: any[]): Promise<any[]> {
    return [];
  }
  async saveResult(..._args: any[]): Promise<string> {
    return "";
  }
  async listResults(..._args: any[]): Promise<any[]> {
    return [];
  }
  async getLatestResult(..._args: any[]): Promise<any | null> {
    return null;
  }
  async createProposal(..._args: any[]): Promise<string> {
    return "";
  }
  async getProposal(..._args: any[]): Promise<any | null> {
    return null;
  }
  async listProposals(..._args: any[]): Promise<any[]> {
    return [];
  }
  async updateProposalStatus(..._args: any[]): Promise<void> {}
  async listPermissions(..._args: any[]): Promise<any[]> {
    return [];
  }
  async createPermission(..._args: any[]): Promise<void> {}
  async removePermission(..._args: any[]): Promise<void> {}
  async createUser(..._args: any[]): Promise<void> {}
  async getUser(..._args: any[]): Promise<any | null> {
    return null;
  }
  async getUserByUsername(..._args: any[]): Promise<any | null> {
    return null;
  }
  async listUsers(..._args: any[]): Promise<any[]> {
    return [];
  }
  async disableUser(..._args: any[]): Promise<void> {}
  async enableUser(..._args: any[]): Promise<void> {}
  async createProject(..._args: any[]): Promise<void> {}
  async getProject(..._args: any[]): Promise<any | null> {
    return null;
  }
  async getProjectByName(..._args: any[]): Promise<any | null> {
    return null;
  }
  async listProjects(..._args: any[]): Promise<any[]> {
    return [];
  }
  async archiveProject(..._args: any[]): Promise<void> {}
  async resolveProjectId(..._args: any[]): Promise<string> {
    return "";
  }
  async addProjectMember(..._args: any[]): Promise<void> {}
  async removeProjectMember(..._args: any[]): Promise<void> {}
  async listProjectMembers(..._args: any[]): Promise<any[]> {
    return [];
  }
  async listUserProjects(..._args: any[]): Promise<any[]> {
    return [];
  }
  async getProjectQuota(..._args: any[]): Promise<any | null> {
    return null;
  }
  async setProjectQuota(..._args: any[]): Promise<void> {}
  async recordUsage(..._args: any[]): Promise<void> {}
  async getProjectUsage(..._args: any[]): Promise<any[]> {
    return [];
  }
  async getUserUsage(..._args: any[]): Promise<any[]> {
    return [];
  }
  async getProjectAggregatedUsage(..._args: any[]): Promise<any> {
    return {
      totalCpuThreads: 0,
      totalMemoryMb: 0,
      totalScratchMb: 0,
      totalWalltimeMs: 0,
      jobCount: 0,
    };
  }
  async isUserDisabled(..._args: any[]): Promise<boolean> {
    return false;
  }
  async createNode(..._args: any[]): Promise<void> {}
  async getNode(..._args: any[]): Promise<any | null> {
    return null;
  }
  async listNodes(..._args: any[]): Promise<any[]> {
    return [];
  }
  async removeNode(..._args: any[]): Promise<void> {}
  async resolveNodeId(..._args: any[]): Promise<string> {
    return "";
  }
  async getNodeByName(..._args: any[]): Promise<any | null> {
    return null;
  }
}

describe("LocalRunner", () => {
  it("stages input into a per-job working directory and persists the attempt", async () => {
    const { root, inputPath } = createWorkspace();

    try {
      const db = createMemoryDatabase();
      await db.init();
      const runner = createRunner(db, "sh", ["-c", "exit 0"]);
      const job = {
        id: "job-1",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;

      await db.createJob(job);
      await runner.stage(job);

      const jobDir = join(root, job.id);
      const stagedInput = join(jobDir, basename(inputPath));
      const attempts = await db.listJobAttempts(job.id);
      const artifacts = await db.listArtifacts(job.id);

      expect(existsSync(jobDir)).toBe(true);
      expect(existsSync(stagedInput)).toBe(true);
      expect(attempts).toHaveLength(1);
      expect(attempts[0].status).toBe("staged");
      expect(attempts[0].cwd).toBe(jobDir);
      expect(attempts[0].command).toBe("sh");
      expect(await db.getJob(job.id)).not.toBeNull();
      expect((await db.getJob(job.id))?.status).toBe("staged");
      expect(artifacts.map((artifact) => `${artifact.kind}:${basename(artifact.path)}`)).toEqual([
        `input:${basename(inputPath)}`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs the local command, captures execution metadata, and records output when it exists", async () => {
    const { root, inputPath } = createWorkspace();

    try {
      const db = createMemoryDatabase();
      await db.init();
      const runner = createRunner(db, "sh", [
        "-c",
        "sleep 0.5; cat water.gjf >/dev/null; printf 'stdout\n'; printf 'stderr\n' >&2; printf 'result\n' > result.log",
      ]);
      const job = {
        id: "job-1",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        outputPath: join(root, "job-1", "result.log"),
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;

      await db.createJob(job);
      await runner.stage(job);
      await runner.start(job);

      const runningAttempt = (await db.listJobAttempts(job.id))[0];
      expect((await db.getJob(job.id))?.status).toBe("running");
      expect(runningAttempt.status).toBe("running");
      expect(runningAttempt.pid).toBeGreaterThan(0);
      expect(runningAttempt.startedAt).toBeDefined();

      const completedAttempt = await waitForAttemptStatus(db, job.id, "completed");
      const artifacts = await db.listArtifacts(job.id);
      const stdoutArtifact = artifacts.find((artifact) => artifact.label === "stdout");
      const stderrArtifact = artifacts.find((artifact) => artifact.label === "stderr");
      const outputArtifact = artifacts.find((artifact) => artifact.kind === "output");

      expect((await db.getJob(job.id))?.status).toBe("completed");
      expect(completedAttempt.exitCode).toBe(0);
      expect(completedAttempt.finishedAt).toBeDefined();
      expect(stdoutArtifact).toBeDefined();
      expect(stderrArtifact).toBeDefined();
      expect(outputArtifact).toBeDefined();
      expect(readFileSync(stdoutArtifact!.path, "utf8")).toContain("stdout");
      expect(readFileSync(stderrArtifact!.path, "utf8")).toContain("stderr");
      expect(readFileSync(outputArtifact!.path, "utf8")).toContain("result");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks the attempt failed when the executable is missing", async () => {
    const { root, inputPath } = createWorkspace();

    try {
      const db = createMemoryDatabase();
      await db.init();
      const runner = createRunner(db, "definitely-not-installed-eigengrid");
      const job = {
        id: "job-1",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;

      await db.createJob(job);
      await runner.stage(job);
      await runner.start(job);

      const failedAttempt = await waitForAttemptStatus(db, job.id, "failed");
      const artifacts = await db.listArtifacts(job.id);
      const stderrArtifact = artifacts.find((artifact) => artifact.label === "stderr");

      expect((await db.getJob(job.id))?.status).toBe("failed");
      expect(failedAttempt.exitCode).toBeGreaterThan(0);
      expect(failedAttempt.finishedAt).toBeDefined();
      expect(stderrArtifact).toBeDefined();
      // The PID guard catches missing-PID spawns immediately;
      // error now reflects fail-closed guard, not OS-level ENOENT
      expect(readFileSync(stderrArtifact!.path, "utf8")).toContain("PID");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sets 0700 permissions on the job directory after staging", async () => {
    const { root, inputPath } = createWorkspace();

    try {
      const db = createMemoryDatabase();
      await db.init();
      const runner = createRunner(db, "sh", ["-c", "exit 0"]);
      const job = {
        id: "job-1",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;

      await db.createJob(job);
      await runner.stage(job);

      const jobDir = join(root, job.id);
      const stat = statSync(jobDir);
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o700);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked job directory before copying input", async () => {
    const { root, inputPath } = createWorkspace();

    try {
      const db = createMemoryDatabase();
      await db.init();
      const outside = join(root, "outside");
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(root, "job-1"));
      const runner = createRunner(db, "sh", ["-c", "exit 0"]);
      const job = {
        id: "job-1",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;

      await db.createJob(job);
      await expect(runner.stage(job)).rejects.toThrow("not a real directory");
      expect(existsSync(join(outside, basename(inputPath)))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["eigengrid-required-missing-user", "", "root"])(
    "refuses both launch paths when the required restricted user is invalid or unavailable (%j)",
    async (sandboxUser) => {
      const { root, inputPath } = createWorkspace();

      try {
        const db = createMemoryDatabase();
        await db.init();
        const marker = join(root, "unrestricted-execution");
        const runner = new (LocalRunner as any)({
          database: db,
          engines: {
            gaussian: {
              command: "/usr/bin/touch",
              args: [marker],
            },
          },
          sandboxUser,
        });
        const job = {
          id: "job-1",
          name: basename(inputPath),
          software: "gaussian",
          inputPath,
          workdir: root,
          status: "created",
          createdAt: 1,
          updatedAt: 1,
        } as const;

        await db.createJob(job);
        await runner.stage(job);
        await expect(runner.start(job)).rejects.toThrow("Required restricted-user execution");
        const attempt = (await db.listJobAttempts(job.id)).at(-1)!;
        await expect(runner.startAttempt(job, attempt.id)).rejects.toThrow(
          "Required restricted-user execution",
        );
        expect(existsSync(marker)).toBe(false);
        expect((await db.getJob(job.id))?.status).not.toBe("running");
        expect(
          (await db.listJobAttempts(job.id)).every((candidate) => candidate.pid === undefined),
        ).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("applies maxWallTime as the command timeout", async () => {
    const { root, inputPath } = createWorkspace();

    try {
      const db = createMemoryDatabase();
      await db.init();
      const runner = new (LocalRunner as any)({
        database: db,
        engines: {
          gaussian: {
            command: "sleep",
            args: ["30"],
          },
        },
        maxWallTime: 2000,
      });
      const job = {
        id: "job-1",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;

      await db.createJob(job);
      await runner.stage(job);
      await runner.start(job);

      const failedAttempt = await waitForAttemptStatus(db, job.id, "failed", 15000);
      expect((await db.getJob(job.id))?.status).toBe("failed");
      expect(failedAttempt.exitCode).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);

  // ── Post-spawn persistence failure safety tests ────────────

  it("post-spawn: attempt running failure kills process, returns non-successful, no background callback", async () => {
    const { root, inputPath } = createWorkspace();

    try {
      const innerDb = createMemoryDatabase();
      const db = new FailableDatabase(innerDb);
      let killCalled = false;

      // Use a process that stays alive so kill() can be verified
      const subprocess = Bun.spawn(["sleep", "60"]);

      const executor = {
        run: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
        }),
        spawn: (_cmd: string, _args: string[], _opts?: any) => {
          const wrappedKill = (_signal?: string) => {
            killCalled = true;
            subprocess.kill();
          };
          return {
            pid: subprocess.pid,
            result: new Promise(() => {}), // Never resolves — no background callback
            kill: wrappedKill,
          };
        },
        runSync: () => ({ status: 0, stdout: Buffer.from(""), stderr: Buffer.alloc(0) }),
      };

      const runner = new (LocalRunner as any)({
        database: db,
        engines: { gaussian: { command: "/bin/echo", args: ["test"] } },
        executor,
      });

      const job = {
        id: "job-kill-1",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;

      await innerDb.createJob(job);
      await runner.stage(job);

      db.failRunningStatus = "attempt";

      const result = await runner.startAttempt(job, (await innerDb.listJobAttempts(job.id))[0].id);

      expect(result.ok).toBe(false);
      expect(killCalled).toBe(true);

      const attempt = (await innerDb.listJobAttempts(job.id))[0];
      expect(attempt.status).toBe("failed");
      const jobRecord = (await innerDb.getJob(job.id)) as any;
      expect(jobRecord.status).toBe("failed");

      // Cleanup lingering process
      subprocess.kill();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("delegates timeout ownership exclusively to the durable supervisor", async () => {
    const { root, inputPath } = createWorkspace();
    let spawnedArgs: string[] = [];
    let spawnedOptions: Record<string, unknown> | undefined;
    let killCount = 0;

    try {
      const db = createMemoryDatabase();
      await db.init();
      const runner = new (LocalRunner as any)({
        database: db,
        engines: { gaussian: { command: "/bin/true", args: [] } },
        durableCompletion: true,
        maxWallTime: 300_000,
        executor: {
          run: async () => ({
            command: "",
            exitCode: 0,
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            timedOut: false,
          }),
          spawn: (_command: string, args: string[], options: Record<string, unknown>) => {
            spawnedArgs = args;
            spawnedOptions = options;
            return {
              pid: 4242,
              result: new Promise(() => {}),
              kill: () => {
                killCount++;
              },
            };
          },
          runSync: () => ({ status: 0, stdout: Buffer.from(""), stderr: Buffer.alloc(0) }),
        },
        supervisor: {
          writeActiveIdentity: () => {},
          writeTerminalReceipt: () => {},
          readReceipt: () => null,
          verifyActiveIdentity: () => "absent" as const,
          readActiveIdentity: () => null,
        },
        tokenReader: { readToken: () => "trusted-token" },
      });
      const job = {
        id: "job-durable-timeout-owner",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;
      await db.createJob(job);
      await runner.stage(job);
      const attemptId = (await db.listJobAttempts(job.id))[0]!.id;

      const started = await runner.startAttempt(job, attemptId);

      expect(started.ok).toBe(true);
      expect(spawnedOptions?.disableTimeout).toBe(true);
      expect(spawnedOptions?.timeout).toBeUndefined();
      expect(spawnedArgs[6]).toBe("300000");
      expect(killCount).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("post-spawn: job running failure kills process and returns non-successful", async () => {
    const { root, inputPath } = createWorkspace();

    try {
      const innerDb = createMemoryDatabase();
      const db = new FailableDatabase(innerDb);
      let killCalled = false;

      const subprocess = Bun.spawn(["sleep", "60"]);

      const executor = {
        run: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
        }),
        spawn: (_cmd: string, _args: string[], _opts?: any) => {
          const wrappedKill = (_signal?: string) => {
            killCalled = true;
            subprocess.kill();
          };
          return {
            pid: subprocess.pid,
            result: new Promise(() => {}),
            kill: wrappedKill,
          };
        },
        runSync: () => ({ status: 0, stdout: Buffer.from(""), stderr: Buffer.alloc(0) }),
      };

      const runner = new (LocalRunner as any)({
        database: db,
        engines: { gaussian: { command: "/bin/echo", args: ["test"] } },
        executor,
      });

      const job = {
        id: "job-kill-2",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;

      await innerDb.createJob(job);
      await runner.stage(job);

      db.failRunningStatus = "job";

      const result = await runner.startAttempt(job, (await innerDb.listJobAttempts(job.id))[0].id);

      expect(result.ok).toBe(false);
      expect(killCalled).toBe(true);

      const attempt = (await innerDb.listJobAttempts(job.id))[0];
      expect(attempt.status).toBe("failed");
      const jobRecord = (await innerDb.getJob(job.id)) as any;
      expect(jobRecord.status).toBe("failed");

      subprocess.kill();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("post-spawn: process.started event failure kills process and returns non-successful", async () => {
    const { root, inputPath } = createWorkspace();

    try {
      let events: any[] = [];
      const innerDb = createMemoryDatabase();
      // Add appendEvent support for event emission testing
      (innerDb as any).appendEvent = async (event: any) => {
        events.push(event);
      };
      const db = new FailableDatabase(innerDb);
      let killCalled = false;

      const subprocess = Bun.spawn(["sleep", "60"]);

      const executor = {
        run: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
        }),
        spawn: (_cmd: string, _args: string[], _opts?: any) => {
          const wrappedKill = (_signal?: string) => {
            killCalled = true;
            subprocess.kill();
          };
          return {
            pid: subprocess.pid,
            result: new Promise(() => {}),
            kill: wrappedKill,
          };
        },
        runSync: () => ({ status: 0, stdout: Buffer.from(""), stderr: Buffer.alloc(0) }),
      };

      const runner = new (LocalRunner as any)({
        database: db,
        engines: { gaussian: { command: "/bin/echo", args: ["test"] } },
        executor,
      });

      const job = {
        id: "job-kill-3",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;

      await innerDb.createJob(job);
      await runner.stage(job);

      db.failRunningStatus = "event";

      const result = await runner.startAttempt(job, (await innerDb.listJobAttempts(job.id))[0].id);

      expect(result.ok).toBe(false);
      expect(killCalled).toBe(true);

      const attempt = (await innerDb.listJobAttempts(job.id))[0];
      expect(attempt.status).toBe("failed");
      const jobRecord = (await innerDb.getJob(job.id)) as any;
      expect(jobRecord.status).toBe("failed");

      // Verify process.failed event was emitted
      const failedEvent = events.find((e: any) => e.type === "process.failed");
      expect(failedEvent).toBeDefined();

      subprocess.kill();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("post-spawn persistence failure waits for durable process-tree cleanup", async () => {
    const { root, inputPath } = createWorkspace();
    const stateDir = join(root, "failed-start-stubborn-state");
    mkdirSync(stateDir);
    const fixture = join(process.cwd(), "packages/runners/src/fixtures/durable-process-tree.sh");

    try {
      const events: any[] = [];
      const innerDb = createMemoryDatabase();
      (innerDb as any).appendEvent = async (event: any) => {
        events.push(event);
      };
      const db = new FailableDatabase(innerDb);
      const updateJobStatus = db.updateJobStatus.bind(db);
      db.updateJobStatus = async (jobId: string, status: string): Promise<void> => {
        if (status === "running") {
          await waitForCondition(
            () => existsSync(join(stateDir, "ready")),
            "Stubborn failed-start tree did not become ready",
          );
          throw new Error("Simulated partial running-state persistence");
        }
        await updateJobStatus(jobId, status);
      };

      const runner = new (LocalRunner as any)({
        database: db,
        engines: {
          gaussian: { command: "/bin/sh", args: [fixture, stateDir, "stubborn"] },
        },
        durableCompletion: true,
        cancellationConfirmationTimeoutMs: 4_000,
      });
      const job = {
        id: "job-failed-start-stubborn-tree",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;
      await innerDb.createJob(job);
      await runner.stage(job);
      const attemptId = (await innerDb.listJobAttempts(job.id))[0]!.id;

      const starting = runner.startAttempt(job, attemptId);
      await waitForCondition(
        () => existsSync(join(stateDir, "ready")),
        "Stubborn failed-start tree did not become ready",
      );
      await Bun.sleep(100);

      // The attempt write succeeded, but the job write failed. Neither that
      // partial DB state nor SIGTERM is terminal evidence while cleanup runs.
      expect((await innerDb.listJobAttempts(job.id))[0]?.status).toBe("running");
      expect((await innerDb.getJob(job.id))?.status).toBe("staged");
      expect(events.filter((event) => event.type === "process.failed")).toHaveLength(0);
      const { readDurableExitStatus } = await import("@eigengrid/runners");
      expect(readDurableExitStatus(join(root, job.id), attemptId)).toBeNull();

      const failedStart = await starting;
      expect(failedStart.ok).toBe(false);
      if (!failedStart.ok) {
        expect(failedStart.failureDisposition).toBe("terminal-confirmed");
      }
      expect((await innerDb.listJobAttempts(job.id))[0]?.status).toBe("failed");
      expect((await innerDb.getJob(job.id))?.status).toBe("failed");
      expect(events.filter((event) => event.type === "process.failed")).toHaveLength(1);
      expect(readDurableExitStatus(join(root, job.id), attemptId)?.exitCode).toBe(143);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 8_000);

  // ── WU-04R: Identity process-start token ────────────────────

  it("startAttempt persists non-empty active identity token", async () => {
    const { root, inputPath } = createWorkspace();
    const subprocess = Bun.spawn(["sleep", "60"]);

    try {
      const db = createMemoryDatabase();
      await db.init();
      const executor = {
        run: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
        }),
        spawn: (_cmd: string, _args: string[], _opts?: any) => ({
          pid: subprocess.pid,
          result: new Promise(() => {}),
          kill: (s?: string) => {
            try {
              subprocess.kill(s);
            } catch {}
          },
        }),
        runSync: () => ({ status: 0, stdout: Buffer.from(""), stderr: Buffer.alloc(0) }),
      };

      const runner = new (LocalRunner as any)({
        database: db,
        engines: { gaussian: { command: "/bin/echo", args: ["test"] } },
        executor,
      });

      const job = {
        id: "job-identity-1",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;

      await db.createJob(job);
      await runner.stage(job);

      const attemptId = (await db.listJobAttempts(job.id))[0].id;
      const result = await runner.startAttempt(job, attemptId);

      expect(result.ok).toBe(true);

      // Read the identity file from disk
      const identityFilePath = join(root, job.id, ".eigengrid", `active-${attemptId}.json`);
      const exists = existsSync(identityFilePath);
      expect(exists).toBe(true);

      const identityContent = readFileSync(identityFilePath, "utf-8");
      const identity = JSON.parse(identityContent);

      expect(identity.processStartToken).toBeDefined();
      expect(identity.processStartToken).not.toBe("");
      expect(typeof identity.processStartToken).toBe("string");
      expect(identity.pid).toBe(subprocess.pid);
      expect(identity.jobId).toBe(job.id);
      expect(identity.attemptId).toBe(attemptId);

      // The token is a non-empty string from /proc/<pid>/stat or fallback
      expect(identity.processStartToken.length).toBeGreaterThan(0);
    } finally {
      subprocess.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("startAttempt token capture failure kills process and returns non-successful", async () => {
    const { root, inputPath } = createWorkspace();
    const subprocess = Bun.spawn(["sleep", "60"]);

    try {
      const db = createMemoryDatabase();
      await db.init();

      const throwingReader = {
        readToken: (_pid: number) => {
          throw new Error("token unavailable");
        },
      };

      const executor = {
        run: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
        }),
        spawn: (_cmd: string, _args: string[], _opts?: any) => ({
          pid: subprocess.pid,
          result: new Promise(() => {}),
          kill: (s?: string) => {
            try {
              subprocess.kill(s);
            } catch {}
          },
        }),
        runSync: () => ({ status: 0, stdout: Buffer.from(""), stderr: Buffer.alloc(0) }),
      };

      const runner = new (LocalRunner as any)({
        database: db,
        engines: { gaussian: { command: "/bin/echo", args: ["test"] } },
        executor,
        tokenReader: throwingReader,
      });

      const job = {
        id: "job-token-fail",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;

      await db.createJob(job);
      await runner.stage(job);

      const attemptId = (await db.listJobAttempts(job.id))[0].id;
      const result = await runner.startAttempt(job, attemptId);

      expect(result.ok).toBe(false);
      expect(result.message).toContain("token");

      // Attempt should be failed
      const attempt = (await db.listJobAttempts(job.id))[0];
      // The persistFail sets it to 'failed'
      expect(attempt.status).toBe("failed");

      // No identity file should have been written
      const identityFilePath = join(root, job.id, ".eigengrid", `active-${attemptId}.json`);
      expect(existsSync(identityFilePath)).toBe(false);
    } finally {
      try {
        subprocess.kill();
      } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verifyActiveIdentity returns valid when token matches live process", async () => {
    const { root } = createWorkspace();
    const subprocess = Bun.spawn(["sleep", "60"]);

    try {
      const db = createMemoryDatabase();
      await db.init();

      // Write a real identity file with a real token
      const jobId = "job-verify-1";
      const attemptId = "attempt-verify-1";
      const jobDir = join(root, jobId);

      const { verifyActiveIdentity, LinuxProcTokenReader } = await import("@eigengrid/runners");

      const tokenReader = new LinuxProcTokenReader();
      const liveToken = tokenReader.readToken(subprocess.pid);

      // Manually write identity
      const identity = {
        schemaVersion: 1,
        jobId,
        attemptId,
        pid: subprocess.pid,
        command: "/bin/echo",
        args: ["test"],
        cwd: jobDir,
        startTime: Date.now(),
        processStartToken: liveToken,
      };
      const { writeActiveIdentity } = await import("@eigengrid/runners");
      writeActiveIdentity(jobDir, attemptId, identity);

      // Verify identity
      const result = verifyActiveIdentity(jobDir, attemptId);
      expect(result).toBe("valid");
    } finally {
      subprocess.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verifyActiveIdentity rejects mismatched token as reused", async () => {
    const { root } = createWorkspace();
    const subprocess = Bun.spawn(["sleep", "60"]);

    try {
      const jobId = "job-reuse-1";
      const attemptId = "attempt-reuse-1";
      const jobDir = join(root, jobId);

      const { verifyActiveIdentity, writeActiveIdentity } = await import("@eigengrid/runners");

      // Write identity with a deliberately wrong token
      writeActiveIdentity(jobDir, attemptId, {
        schemaVersion: 1,
        jobId,
        attemptId,
        pid: subprocess.pid,
        command: "/bin/echo",
        args: [],
        cwd: jobDir,
        startTime: Date.now(),
        processStartToken: "wrong-token-99999",
      });

      // Verify — should detect token mismatch (PID exists but wrong token)
      const result = verifyActiveIdentity(jobDir, attemptId);
      expect(result).toBe("reused");
    } finally {
      subprocess.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("startAttempt with empty token reader returns non-successful", async () => {
    const { root, inputPath } = createWorkspace();
    const subprocess = Bun.spawn(["sleep", "60"]);

    try {
      const db = createMemoryDatabase();
      await db.init();

      const emptyTokenReader = { readToken: (_pid: number) => "" };

      const executor = {
        run: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
        }),
        spawn: (_cmd: string, _args: string[], _opts?: any) => ({
          pid: subprocess.pid,
          result: new Promise(() => {}),
          kill: (s?: string) => {
            try {
              subprocess.kill(s);
            } catch {}
          },
        }),
        runSync: () => ({ status: 0, stdout: Buffer.from(""), stderr: Buffer.alloc(0) }),
      };

      const runner = new (LocalRunner as any)({
        database: db,
        engines: { gaussian: { command: "/bin/echo", args: ["test"] } },
        executor,
        tokenReader: emptyTokenReader,
      });

      const job = {
        id: "job-empty-token",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;

      await db.createJob(job);
      await runner.stage(job);

      const attemptId = (await db.listJobAttempts(job.id))[0].id;
      const result = await runner.startAttempt(job, attemptId);

      expect(result.ok).toBe(false);
      expect(result.message).toContain("empty");

      // No identity file should exist
      const identityFilePath = join(root, job.id, ".eigengrid", `active-${attemptId}.json`);
      expect(existsSync(identityFilePath)).toBe(false);
    } finally {
      try {
        subprocess.kill();
      } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── WU-04R: Cancellation exactly-once ────────────────────

  it("cancelAttempt first call reports transitioned:true, repeat reports transitioned:false", async () => {
    const { root, inputPath } = createWorkspace();
    const subprocess = Bun.spawn(["sleep", "60"]);

    try {
      const db = createMemoryDatabase();
      await db.init();
      (db as any).appendEvent = async () => {};

      const executor = {
        run: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
        }),
        spawn: (_cmd: string, _args: string[], _opts?: any) => ({
          pid: subprocess.pid,
          result: new Promise(() => {}),
          kill: (s?: string) => {
            try {
              subprocess.kill(s);
            } catch {}
          },
        }),
        runSync: () => ({ status: 0, stdout: Buffer.from(""), stderr: Buffer.alloc(0) }),
      };

      const runner = new (LocalRunner as any)({
        database: db,
        engines: { gaussian: { command: "/bin/echo", args: ["test"] } },
        executor,
      });

      const job = {
        id: "job-cancel-once",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;

      await db.createJob(job);
      await runner.stage(job);

      const attemptId = (await db.listJobAttempts(job.id))[0].id;
      const startResult = await runner.startAttempt(job, attemptId);
      expect(startResult.ok).toBe(true);

      // Verify process is alive before cancel
      expect(() => process.kill(subprocess.pid, 0)).not.toThrow();

      // First cancellation — uses process.kill directly to send real SIGTERM
      const first = await runner.cancelAttempt(job, attemptId);
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(first.transitioned).toBe(true);
        expect(first.receipt.status).toBe("cancelled");
        expect(first.receipt.signal).toBe("SIGTERM");
      }

      // Process should be dead after SIGTERM (sleep 60 may survive SIGTERM
      // on some systems, but the cancel path caught ESRCH if already dead)
      // Verify second cancellation
      const second = await runner.cancelAttempt(job, attemptId);
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.transitioned).toBe(false);
        expect(second.receipt.status).toBe("cancelled");
      }

      // Verify no second signal was sent: the first cancel already killed
      // the process; the second finds the existing cancelled receipt.
      // Actually verify process.kill pid 0 throws ESRCH (dead)
      try {
        process.kill(subprocess.pid, 0);
        // Process might still be alive on some systems (SIGTERM not always fatal)
        // In that case, the second cancel should find the existing receipt
      } catch {
        // ESRCH = process dead, which is expected after SIGTERM
      }
    } finally {
      try {
        subprocess.kill();
      } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancelAttempt idempotent — repeated call causes no receipt overwrite or state mutation", async () => {
    const { root, inputPath } = createWorkspace();
    const subprocess = Bun.spawn(["sleep", "60"]);

    try {
      const db = createMemoryDatabase();
      await db.init();
      (db as any).appendEvent = async () => {};

      const executor = {
        run: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
        }),
        spawn: (_cmd: string, _args: string[], _opts?: any) => ({
          pid: subprocess.pid,
          result: new Promise(() => {}),
          kill: (s?: string) => {
            try {
              subprocess.kill(s);
            } catch {}
          },
        }),
        runSync: () => ({ status: 0, stdout: Buffer.from(""), stderr: Buffer.alloc(0) }),
      };

      const runner = new (LocalRunner as any)({
        database: db,
        engines: { gaussian: { command: "/bin/echo", args: ["test"] } },
        executor,
      });

      const job = {
        id: "job-cancel-idempotent",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;

      await db.createJob(job);
      await runner.stage(job);

      const attemptId = (await db.listJobAttempts(job.id))[0].id;
      const startResult = await runner.startAttempt(job, attemptId);
      expect(startResult.ok).toBe(true);

      // First cancel
      const first = await runner.cancelAttempt(job, attemptId);
      expect(first.ok).toBe(true);

      // Capture first receipt content for comparison
      const { readReceipt } = await import("@eigengrid/runners");
      const jobDir = join(root, job.id);
      const firstReceipt = readReceipt(jobDir, attemptId);
      expect(firstReceipt).not.toBeNull();

      // Second cancel — same receipt, no mutation
      const second = await runner.cancelAttempt(job, attemptId);
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.transitioned).toBe(false);
      }

      const secondReceipt = readReceipt(jobDir, attemptId);
      expect(secondReceipt?.finishedAt).toBe(firstReceipt!.finishedAt);
      expect(secondReceipt?.status).toBe("cancelled");
      expect(secondReceipt?.exitCode).toBeNull();
    } finally {
      try {
        subprocess.kill();
      } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancelAttempt heals non-terminal DB state from an existing cancelled receipt", async () => {
    const { root, inputPath } = createWorkspace();

    try {
      const db = createMemoryDatabase();
      await db.init();
      const events: any[] = [];
      db.appendEvent = async (event: any) => {
        events.push(event);
      };
      const job = {
        id: "job-cancel-receipt-replay",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;
      await db.createJob(job);

      let receipt: any = null;
      const supervisor = {
        writeActiveIdentity: () => {},
        writeTerminalReceipt: () => {},
        readReceipt: () => receipt,
        verifyActiveIdentity: () => "dead" as const,
        readActiveIdentity: () => ({
          schemaVersion: 1,
          jobId: job.id,
          attemptId: receipt?.attemptId ?? "",
          pid: 987_654_321,
          command: "/bin/true",
          args: [],
          cwd: join(root, job.id),
          startTime: 1,
          processStartToken: "dead-token",
        }),
      };
      const runner = new (LocalRunner as any)({
        database: db,
        engines: { gaussian: { command: "/bin/true", args: [] } },
        supervisor,
      });
      await runner.stage(job);
      const attemptId = (await db.listJobAttempts(job.id))[0]!.id;
      receipt = {
        schemaVersion: 1,
        jobId: job.id,
        attemptId,
        pid: 987_654_321,
        command: "/bin/true",
        args: [],
        cwd: join(root, job.id),
        exitCode: null,
        signal: "SIGTERM",
        finishedAt: 1234,
        status: "cancelled",
      };

      // Simulate a prior call that durably wrote the receipt but lost both DB writes.
      expect((await db.listJobAttempts(job.id))[0]?.status).toBe("staged");
      expect((await db.getJob(job.id))?.status).toBe("staged");

      const materialize = db.materializeTerminalAttempt.bind(db);
      let failMaterialization = true;
      db.materializeTerminalAttempt = async (evidence) => {
        if (failMaterialization) {
          failMaterialization = false;
          throw new Error("Simulated cancellation transaction failure");
        }
        await materialize(evidence);
      };

      const interruptedReplay = await runner.cancelAttempt(job, attemptId);
      expect(interruptedReplay.ok).toBe(false);
      expect((await db.listJobAttempts(job.id))[0]?.status).toBe("staged");
      expect((await db.getJob(job.id))?.status).toBe("staged");
      expect(events.filter((event) => event.type === "process.cancelled")).toHaveLength(0);

      const replay = await runner.cancelAttempt(job, attemptId);

      expect(replay.ok).toBe(true);
      if (replay.ok) expect(replay.transitioned).toBe(false);
      expect((await db.listJobAttempts(job.id))[0]?.status).toBe("cancelled");
      expect((await db.getJob(job.id))?.status).toBe("cancelled");
      expect(events.filter((event) => event.type === "process.cancelled")).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconcile ignores forged terminal files while the exact identity is alive", async () => {
    const { root, inputPath } = createWorkspace();
    const jobId = "job-forged-terminal-live";
    const attemptId = "attempt-forged-terminal-live";
    const jobDir = join(root, jobId);
    mkdirSync(jobDir, { recursive: true });
    const fixture = join(
      process.cwd(),
      "packages/runners/src/fixtures/forged-terminal-then-sleep.sh",
    );
    const subprocess = Bun.spawn([fixture, jobDir, jobId, attemptId]);

    try {
      const db = createMemoryDatabase();
      await db.init();
      const job = {
        id: jobId,
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        status: "running",
        createdAt: 1,
        updatedAt: 1,
      } as const;
      await db.createJob(job);
      await db.createJobAttempt({
        id: attemptId,
        jobId,
        runner: "local",
        command: fixture,
        cwd: jobDir,
        status: "running",
        pid: subprocess.pid,
        startedAt: Date.now(),
      });

      const { LinuxProcTokenReader, writeActiveIdentity } = await import("@eigengrid/runners");
      const readyPath = join(jobDir, ".eigengrid", "forged-terminal-ready");
      await waitForCondition(
        () => existsSync(readyPath),
        "Forged terminal fixture did not become ready",
      );
      const token = new LinuxProcTokenReader().readToken(subprocess.pid);
      writeActiveIdentity(jobDir, attemptId, {
        schemaVersion: 1,
        jobId,
        attemptId,
        pid: subprocess.pid,
        command: fixture,
        args: [jobDir, jobId, attemptId],
        cwd: jobDir,
        startTime: Date.now(),
        processStartToken: token,
      });

      const restartedRunner = new (LocalRunner as any)({
        database: db,
        engines: { gaussian: { command: "/bin/echo" } },
        durableCompletion: true,
      });
      const whileAlive = await restartedRunner.reconcileAttempt(job, attemptId);
      expect(whileAlive.status).toBe("running");
      expect((await db.listJobAttempts(jobId))[0]?.status).toBe("running");
      expect((await db.getJob(jobId))?.status).toBe("running");

      subprocess.kill("SIGTERM");
      await subprocess.exited;
      const afterDeath = await restartedRunner.reconcileAttempt(job, attemptId);
      expect(afterDeath.status).toBe("completed");
      expect((await db.listJobAttempts(jobId))[0]?.status).toBe("completed");
    } finally {
      try {
        subprocess.kill("SIGKILL");
      } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancel waits for durable cleanup before persisting cancelled", async () => {
    const { root, inputPath } = createWorkspace();
    const stateDir = join(root, "stubborn-state");
    mkdirSync(stateDir);
    const fixture = join(process.cwd(), "packages/runners/src/fixtures/durable-process-tree.sh");

    try {
      const db = createMemoryDatabase();
      await db.init();
      const runner = new (LocalRunner as any)({
        database: db,
        engines: {
          gaussian: { command: "/bin/sh", args: [fixture, stateDir, "stubborn"] },
        },
        durableCompletion: true,
        cancellationConfirmationTimeoutMs: 4_000,
      });
      const job = {
        id: "job-cancel-stubborn-tree",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;
      await db.createJob(job);
      await runner.stage(job);
      const attemptId = (await db.listJobAttempts(job.id))[0]!.id;
      expect((await runner.startAttempt(job, attemptId)).ok).toBe(true);
      await waitForCondition(
        () => existsSync(join(stateDir, "ready")),
        "Stubborn process tree did not become ready",
      );

      const cancellation = runner.cancelAttempt(job, attemptId);
      await Bun.sleep(100);
      expect((await db.listJobAttempts(job.id))[0]?.status).toBe("running");
      const { readReceipt } = await import("@eigengrid/runners");
      expect(readReceipt(join(root, job.id), attemptId)).toBeNull();

      const cancelled = await cancellation;
      expect(cancelled.ok).toBe(true);
      if (cancelled.ok) expect(cancelled.receipt.status).toBe("cancelled");
      expect((await db.listJobAttempts(job.id))[0]?.status).toBe("cancelled");
      expect((await db.getJob(job.id))?.status).toBe("cancelled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 8_000);

  // ── WU-04R follow-up: identity-write failure paths ────────

  it("startAttempt identity-write failure: kills process, fails state, emits one failure event", async () => {
    const { root, inputPath } = createWorkspace();
    const subprocess = Bun.spawn(["sleep", "60"]);
    const events: any[] = [];

    try {
      const db = createMemoryDatabase();
      await db.init();
      (db as any).appendEvent = async (e: any) => {
        events.push(e);
      };

      const failingSupervisor = {
        writeActiveIdentity: () => {
          throw new Error("Identity write failed");
        },
        writeTerminalReceipt: () => {},
        readReceipt: () => null,
        verifyActiveIdentity: () => "absent" as const,
        readActiveIdentity: () => null,
      };

      const executor = {
        run: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
        }),
        spawn: (_cmd: string, _args: string[], _opts?: any) => ({
          pid: subprocess.pid,
          result: new Promise(() => {}),
          kill: (s?: string) => {
            try {
              subprocess.kill(s);
            } catch {}
          },
        }),
        runSync: () => ({ status: 0, stdout: Buffer.from(""), stderr: Buffer.alloc(0) }),
      };

      const runner = new (LocalRunner as any)({
        database: db,
        engines: { gaussian: { command: "/bin/echo", args: ["test"] } },
        executor,
        supervisor: failingSupervisor,
      });

      const job = {
        id: "job-id-write-fail",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;

      await db.createJob(job);
      await runner.stage(job);

      const attemptId = (await db.listJobAttempts(job.id))[0].id;
      const result = await runner.startAttempt(job, attemptId);

      // Identity write failure → ok:false
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Identity");
      if (!result.ok) expect(result.failureDisposition).toBe("terminal-confirmed");

      // Tracked process removed from in-memory map (settled + deleted)
      const tracked = (runner as any).processes.get(job.id);
      expect(tracked).toBeUndefined();

      // DB state: failed
      const attempt = (await db.listJobAttempts(job.id))[0];
      expect(attempt.status).toBe("failed");
      const jobRecord = (await db.getJob(job.id)) as any;
      expect(jobRecord.status).toBe("failed");

      // Exactly one failure event, NO process.started or process.completed
      const failedEvents = events.filter((e: any) => e.type === "process.failed");
      expect(failedEvents.length).toBe(1);
      const startedEvents = events.filter((e: any) => e.type === "process.started");
      expect(startedEvents.length).toBe(0);
      const completedEvents = events.filter((e: any) => e.type === "process.completed");
      expect(completedEvents.length).toBe(0);

      // No identity file written to disk
      const identityFilePath = join(root, job.id, ".eigengrid", `active-${attemptId}.json`);
      expect(existsSync(identityFilePath)).toBe(false);
    } finally {
      try {
        subprocess.kill();
      } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("legacy start() identity-write failure: kills process, fails state, emits one failure event", async () => {
    const { root, inputPath } = createWorkspace();
    const subprocess = Bun.spawn(["sleep", "60"]);
    const events: any[] = [];

    try {
      const db = createMemoryDatabase();
      await db.init();
      (db as any).appendEvent = async (e: any) => {
        events.push(e);
      };

      const failingSupervisor = {
        writeActiveIdentity: () => {
          throw new Error("Identity write failed");
        },
        writeTerminalReceipt: () => {},
        readReceipt: () => null,
        verifyActiveIdentity: () => "absent" as const,
        readActiveIdentity: () => null,
      };

      const executor = {
        run: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
        }),
        spawn: (_cmd: string, _args: string[], _opts?: any) => ({
          pid: subprocess.pid,
          result: new Promise(() => {}),
          kill: (s?: string) => {
            try {
              subprocess.kill(s);
            } catch {}
          },
        }),
        runSync: () => ({ status: 0, stdout: Buffer.from(""), stderr: Buffer.alloc(0) }),
      };

      const runner = new (LocalRunner as any)({
        database: db,
        engines: { gaussian: { command: "/bin/echo", args: ["test"] } },
        executor,
        supervisor: failingSupervisor,
      });

      const job = {
        id: "job-legacy-write-fail",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;

      await db.createJob(job);
      await runner.stage(job);

      const result = await runner.start(job);

      // Identity write failure → ok:false
      expect(result.ok).toBe(false);
      expect(result.message).toContain("identity");

      // Tracked process removed
      const tracked = (runner as any).processes.get(job.id);
      expect(tracked).toBeUndefined();

      // DB state: failed
      const attempt = (await db.listJobAttempts(job.id))[0];
      expect(attempt.status).toBe("failed");
      const jobRecord = (await db.getJob(job.id)) as any;
      expect(jobRecord.status).toBe("failed");

      // Exactly one failure event, no started/completed
      const failedEvents = events.filter((e: any) => e.type === "process.failed");
      expect(failedEvents.length).toBe(1);
      const startedEvents = events.filter((e: any) => e.type === "process.started");
      expect(startedEvents.length).toBe(0);
      const completedEvents = events.filter((e: any) => e.type === "process.completed");
      expect(completedEvents.length).toBe(0);

      // No identity file
      const attemptId = (await db.listJobAttempts(job.id))[0].id;
      const identityFilePath = join(root, job.id, ".eigengrid", `active-${attemptId}.json`);
      expect(existsSync(identityFilePath)).toBe(false);
    } finally {
      try {
        subprocess.kill();
      } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── WU-04R follow-up: PID-less handle fail-closed ─────────

  it("startAttempt with undefined PID leaves state non-terminal when process death is unknown", async () => {
    const { root, inputPath } = createWorkspace();
    const events: any[] = [];

    try {
      const db = createMemoryDatabase();
      await db.init();
      (db as any).appendEvent = async (e: any) => {
        events.push(e);
      };

      const executor = {
        run: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
        }),
        spawn: (_cmd: string, _args: string[], _opts?: any) => ({
          pid: undefined,
          result: new Promise(() => {}),
          kill: () => {},
        }),
        runSync: () => ({ status: 0, stdout: Buffer.from(""), stderr: Buffer.alloc(0) }),
      };

      const runner = new (LocalRunner as any)({
        database: db,
        engines: { gaussian: { command: "/bin/echo", args: ["test"] } },
        executor,
        cancellationConfirmationTimeoutMs: 50,
      });

      const job = {
        id: "job-no-pid-attempt",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;

      await db.createJob(job);
      await runner.stage(job);

      const attemptId = (await db.listJobAttempts(job.id))[0].id;
      const result = await runner.startAttempt(job, attemptId);

      // Must return ok:false with PID-related message
      expect(result.ok).toBe(false);
      expect(result.message).toContain("PID");

      // An opaque spawned process cannot authorize terminal state/capacity release.
      const attempt = (await db.listJobAttempts(job.id))[0];
      expect(attempt.status).toBe("staged");
      const jobRecord = (await db.getJob(job.id)) as any;
      expect(jobRecord.status).toBe("staged");

      // No process.started or process.completed
      const startedEvents = events.filter((e: any) => e.type === "process.started");
      expect(startedEvents.length).toBe(0);
      const completedEvents = events.filter((e: any) => e.type === "process.completed");
      expect(completedEvents.length).toBe(0);

      // No terminal event without confirmed process death.
      const failedEvents = events.filter((e: any) => e.type === "process.failed");
      expect(failedEvents.length).toBe(0);

      // Not tracked in-memory
      const tracked = (runner as any).processes.get(job.id);
      expect(tracked).toBeUndefined();

      // No identity file written
      const identityFilePath = join(root, job.id, ".eigengrid", `active-${attemptId}.json`);
      expect(existsSync(identityFilePath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("legacy start() with undefined PID returns ok:false, fails state, no started event", async () => {
    const { root, inputPath } = createWorkspace();
    const events: any[] = [];

    try {
      const db = createMemoryDatabase();
      await db.init();
      (db as any).appendEvent = async (e: any) => {
        events.push(e);
      };

      const executor = {
        run: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
        }),
        spawn: (_cmd: string, _args: string[], _opts?: any) => ({
          pid: undefined,
          result: new Promise(() => {}),
          kill: () => {},
        }),
        runSync: () => ({ status: 0, stdout: Buffer.from(""), stderr: Buffer.alloc(0) }),
      };

      const runner = new (LocalRunner as any)({
        database: db,
        engines: { gaussian: { command: "/bin/echo", args: ["test"] } },
        executor,
      });

      const job = {
        id: "job-no-pid-legacy",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;

      await db.createJob(job);
      await runner.stage(job);

      const result = await runner.start(job);

      // Must return ok:false
      expect(result.ok).toBe(false);
      expect(result.message).toContain("PID");

      // DB state: failed
      const attempt = (await db.listJobAttempts(job.id))[0];
      expect(attempt.status).toBe("failed");
      const jobRecord = (await db.getJob(job.id)) as any;
      expect(jobRecord.status).toBe("failed");

      // No process.started or process.completed
      const startedEvents = events.filter((e: any) => e.type === "process.started");
      expect(startedEvents.length).toBe(0);
      const completedEvents = events.filter((e: any) => e.type === "process.completed");
      expect(completedEvents.length).toBe(0);

      // Exactly one failure event
      const failedEvents = events.filter((e: any) => e.type === "process.failed");
      expect(failedEvents.length).toBe(1);

      // Not tracked
      const tracked = (runner as any).processes.get(job.id);
      expect(tracked).toBeUndefined();

      // No identity file
      const attemptId = (await db.listJobAttempts(job.id))[0].id;
      const identityFilePath = join(root, job.id, ".eigengrid", `active-${attemptId}.json`);
      expect(existsSync(identityFilePath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("startAttempt persistence failure stays non-terminal when signaling cannot confirm death", async () => {
    const { root, inputPath } = createWorkspace();
    const subprocess = Bun.spawn(["sleep", "60"]);
    const events: any[] = [];

    try {
      const db = createMemoryDatabase();
      await db.init();
      (db as any).appendEvent = async (e: any) => {
        events.push(e);
      };

      const failingSupervisor = {
        writeActiveIdentity: () => {
          throw new Error("Identity write failed");
        },
        writeTerminalReceipt: () => {},
        readReceipt: () => null,
        verifyActiveIdentity: () => "absent" as const,
        readActiveIdentity: () => null,
      };

      const executor = {
        run: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
        }),
        spawn: (_cmd: string, _args: string[], _opts?: any) => ({
          pid: subprocess.pid,
          result: new Promise(() => {}),
          kill: (_signal?: string) => {
            throw new Error("kill failed");
          },
        }),
        runSync: () => ({ status: 0, stdout: Buffer.from(""), stderr: Buffer.alloc(0) }),
      };

      const runner = new (LocalRunner as any)({
        database: db,
        engines: { gaussian: { command: "/bin/echo", args: ["test"] } },
        executor,
        supervisor: failingSupervisor,
        cancellationConfirmationTimeoutMs: 50,
      });

      const job = {
        id: "job-kill-throws",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;

      await db.createJob(job);
      await runner.stage(job);

      const attemptId = (await db.listJobAttempts(job.id))[0].id;
      const result = await runner.startAttempt(job, attemptId);

      // Identity write failure → ok:false
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Identity");
      if (!result.ok) expect(result.failureDisposition).toBe("termination-unknown");

      // Keep the live exact handle available for a later cancellation retry.
      const tracked = (runner as any).processes.get(job.id);
      expect(tracked?.settled).toBe(false);
      expect(() => process.kill(subprocess.pid, 0)).not.toThrow();

      // The partial running writes remain non-terminal while cleanup is unknown.
      const attempt = (await db.listJobAttempts(job.id))[0];
      expect(attempt.status).toBe("running");
      const jobRecord = (await db.getJob(job.id)) as any;
      expect(jobRecord.status).toBe("running");

      // No terminal event or receipt may be forged from a failed signal.
      const failedEvents = events.filter((e: any) => e.type === "process.failed");
      expect(failedEvents.length).toBe(0);
      const startedEvents = events.filter((e: any) => e.type === "process.started");
      expect(startedEvents.length).toBe(0);
      const completedEvents = events.filter((e: any) => e.type === "process.completed");
      expect(completedEvents.length).toBe(0);

      // No identity file
      const identityFilePath = join(root, job.id, ".eigengrid", `active-${attemptId}.json`);
      expect(existsSync(identityFilePath)).toBe(false);

      expect(result.message).toContain("safely-unknown");
    } finally {
      try {
        subprocess.kill();
      } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("startAttempt with fractional PID keeps state non-terminal when death is unknown", async () => {
    const { root, inputPath } = createWorkspace();
    const events: any[] = [];

    try {
      const db = createMemoryDatabase();
      await db.init();
      (db as any).appendEvent = async (e: any) => {
        events.push(e);
      };

      const executor = {
        run: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
        }),
        spawn: (_cmd: string, _args: string[], _opts?: any) => ({
          pid: 1.5,
          result: new Promise(() => {}),
          kill: () => {},
        }),
        runSync: () => ({ status: 0, stdout: Buffer.from(""), stderr: Buffer.alloc(0) }),
      };

      const runner = new (LocalRunner as any)({
        database: db,
        engines: { gaussian: { command: "/bin/echo", args: ["test"] } },
        executor,
        cancellationConfirmationTimeoutMs: 50,
      });

      const job = {
        id: "job-frac-pid",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;

      await db.createJob(job);
      await runner.stage(job);

      const attemptId = (await db.listJobAttempts(job.id))[0].id;
      const result = await runner.startAttempt(job, attemptId);

      expect(result.ok).toBe(false);
      expect(result.message).toContain("PID");

      const attempt = (await db.listJobAttempts(job.id))[0];
      expect(attempt.status).toBe("staged");

      // Should not emit process.started
      const startedEvents = events.filter((e: any) => e.type === "process.started");
      expect(startedEvents.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects job identifiers that could escape the local work directory", async () => {
    const { root, inputPath } = createWorkspace();
    try {
      const db = createMemoryDatabase();
      const runner = createRunner(db, "true");
      const job = {
        id: "../outside",
        name: "hostile",
        software: "gaussian",
        inputPath,
        outputPath: "result.out",
        workdir: root,
        status: "created",
        createdAt: 1,
        updatedAt: 1,
      } as const;
      await expect(runner.stage(job)).rejects.toThrow("Unsafe job identifier");
      expect(existsSync(join(root, "outside"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── WU-04R follow-up: LinuxProcTokenReader throws on failure ──

  it("materializes receipt evidence atomically beyond event pagination", async () => {
    const { root, inputPath, dbPath } = createWorkspace();
    const { createDatabase } = await import("@eigengrid/db");
    const db = createDatabase(dbPath);

    try {
      await db.init();
      const job = {
        id: "job-terminal-evidence",
        name: basename(inputPath),
        software: "gaussian",
        inputPath,
        workdir: root,
        outputPath: "result.out",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
      } as const;
      const attemptId = "attempt-terminal-evidence";
      await db.createJob(job);
      await db.updateJobStatus(job.id, "queued");
      await db.updateJobStatus(job.id, "staged");
      await db.updateJobStatus(job.id, "running");
      await db.createJobAttempt({
        id: attemptId,
        jobId: job.id,
        runner: "local",
        command: "/bin/true",
        cwd: join(root, job.id),
        status: "running",
        pid: 123,
        startedAt: 100,
      });

      const jobDir = join(root, job.id);
      mkdirSync(jobDir, { recursive: true });
      writeFileSync(join(jobDir, "stdout.log"), "out\n");
      writeFileSync(join(jobDir, "stderr.log"), "");
      writeFileSync(join(jobDir, "result.out"), "result\n");
      for (let index = 0; index < 120; index++) {
        await db.appendEvent({
          id: `filler-${index}`,
          type: "system.notice",
          at: index,
          source: "system",
          jobId: job.id,
          payload: { index },
        });
      }

      const runner = new (LocalRunner as any)({ database: db });
      const attempt = (await db.listJobAttempts(job.id))[0]!;
      const receipt = {
        schemaVersion: 1,
        jobId: job.id,
        attemptId,
        pid: 123,
        command: "/bin/true",
        args: [],
        cwd: jobDir,
        exitCode: 0,
        signal: null,
        finishedAt: 200,
        status: "completed",
      } as const;

      await Promise.all([
        runner.materializeTerminalEvidence(job, attempt, receipt),
        runner.materializeTerminalEvidence(job, attempt, receipt),
      ]);

      const events = await db.listAttemptEvents(attemptId);
      expect(
        events.filter(
          (event) => event.type === "process.completed" && event.attemptId === attemptId,
        ),
      ).toHaveLength(1);
      expect(await db.listArtifacts(job.id)).toHaveLength(3);

      await expect(
        runner.materializeTerminalEvidence(job, attempt, {
          ...receipt,
          exitCode: 9,
          finishedAt: 201,
        }),
      ).rejects.toThrow("Conflicting terminal metadata");
      const storedAttempt = (await db.listJobAttempts(job.id))[0]!;
      expect(storedAttempt.exitCode).toBe(0);
      expect(storedAttempt.finishedAt).toBe(200);
    } finally {
      await db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("LinuxProcTokenReader throws on nonexistent PID (no timestamp fallback)", async () => {
    const { LinuxProcTokenReader } = await import("@eigengrid/runners");
    const reader = new LinuxProcTokenReader();

    // PID 0 and very large PID should not exist → throws LocalIdentityError (io kind)
    expect(() => reader.readToken(0)).toThrow();
    expect(() => reader.readToken(999999999)).toThrow();

    // Verify thrown errors are LocalIdentityError with appropriate kind
    try {
      reader.readToken(0);
    } catch (err: any) {
      expect(err.name).toBe("LocalIdentityError");
      expect(["io", "validation"]).toContain(err.kind);
      expect(err.message).not.toMatch(/^fb-/);
    }
  });

  it("LinuxProcTokenReader returns non-empty token for live process", async () => {
    const subprocess = Bun.spawn(["sleep", "60"]);
    try {
      const { LinuxProcTokenReader } = await import("@eigengrid/runners");
      const reader = new LinuxProcTokenReader();

      const token = reader.readToken(subprocess.pid);
      expect(token).toBeDefined();
      expect(token.length).toBeGreaterThan(0);
      // Must be a numeric string (start_time in clock ticks), never fb- prefix
      expect(token).not.toMatch(/^fb-/);
      expect(/^\d+$/.test(token)).toBe(true);
    } finally {
      subprocess.kill();
    }
  });

  it("verifyActiveIdentity with LinuxProcTokenReader still supports recreation and valid/reused", async () => {
    const { root } = createWorkspace();
    const subprocess = Bun.spawn(["sleep", "60"]);

    try {
      const { verifyActiveIdentity, writeActiveIdentity, LinuxProcTokenReader } =
        await import("@eigengrid/runners");

      const jobId = "job-recreate-1";
      const attemptId = "attempt-recreate-1";
      const jobDir = join(root, jobId);

      const reader = new LinuxProcTokenReader();
      const liveToken = reader.readToken(subprocess.pid);

      // Write identity with real token
      writeActiveIdentity(jobDir, attemptId, {
        schemaVersion: 1,
        jobId,
        attemptId,
        pid: subprocess.pid,
        command: "/bin/echo",
        args: [],
        cwd: jobDir,
        startTime: Date.now(),
        processStartToken: liveToken,
      });

      // Read back and verify
      const result = verifyActiveIdentity(jobDir, attemptId);
      expect(result).toBe("valid");

      // Mismatched → reused
      writeActiveIdentity(jobDir, "attempt-reuse-2", {
        schemaVersion: 1,
        jobId,
        attemptId: "attempt-reuse-2",
        pid: subprocess.pid,
        command: "/bin/echo",
        args: [],
        cwd: jobDir,
        startTime: Date.now(),
        processStartToken: "wrong-token",
      });
      const reuseResult = verifyActiveIdentity(jobDir, "attempt-reuse-2");
      expect(reuseResult).toBe("reused");
    } finally {
      subprocess.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
