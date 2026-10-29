import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import type { Artifact, Job, JobAttempt } from "@eigengrid/core";
import { SlurmRunner } from "@eigengrid/runners";
import type { SlurmClient, SlurmJobStatus } from "@eigengrid/slurm";

type JobRow = Record<string, unknown> & {
  id: string;
  status: string;
  backend?: string;
  external_job_id?: string;
  externalState?: string;
  externalJobId?: string;
  node_name?: string;
  nodeName?: string;
  lastSyncAt?: number;
  nativeDetail?: string;
};

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    name: "water.inp",
    software: "orca",
    inputPath: "/tmp/water.inp",
    workdir: "/tmp/eigengrid-slurm",
    outputPath: "/tmp/eigengrid-slurm/job-1/result.log",
    status: "created",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createMemoryDatabase() {
  const jobs = new Map<string, JobRow>();
  const attempts: JobAttempt[] = [];
  const artifacts: Artifact[] = [];
  const events: Array<Record<string, unknown>> = [];

  return {
    async init() {},
    async createJob(job: {
      id: string;
      name: string;
      software: string;
      inputPath: string;
      workdir: string;
      outputPath?: string;
    }) {
      const now = Date.now();
      jobs.set(job.id, {
        ...job,
        status: "created",
        createdAt: now,
        updatedAt: now,
      });
    },
    async updateJobStatus(jobId: string, status: string) {
      const job = jobs.get(jobId);
      if (!job) throw new Error(`Job not found: ${jobId}`);
      job.status = status;
      job.updatedAt = Date.now();
      jobs.set(jobId, job);
    },
    async updateJobExternalMetadata(jobId: string, metadata: Record<string, unknown>) {
      const job = jobs.get(jobId);
      if (!job) throw new Error(`Job not found: ${jobId}`);
      if (metadata.backend !== undefined) job.backend = String(metadata.backend);
      if (metadata.externalJobId !== undefined) job.externalJobId = String(metadata.externalJobId);
      if (metadata.externalJobId !== undefined)
        job.external_job_id = String(metadata.externalJobId);
      if (metadata.externalState !== undefined) job.externalState = String(metadata.externalState);
      if (metadata.lastSyncAt !== undefined) job.lastSyncAt = Number(metadata.lastSyncAt);
      if (metadata.nativeDetail !== undefined) job.nativeDetail = String(metadata.nativeDetail);
      if (metadata.nodeName !== undefined) job.nodeName = String(metadata.nodeName);
      if (metadata.nodeName !== undefined) job.node_name = String(metadata.nodeName);
      jobs.set(jobId, job);
    },
    async getJob(jobId: string) {
      return jobs.get(jobId) ?? null;
    },
    async createJobAttempt(attempt: {
      id: string;
      jobId: string;
      runner: "slurm";
      command: string;
      cwd: string;
      status?: JobAttempt["status"];
      pid?: number;
      exitCode?: number;
      startedAt?: number;
      finishedAt?: number;
    }) {
      const now = Date.now();
      attempts.push({
        ...attempt,
        status: attempt.status ?? "created",
        createdAt: now,
        updatedAt: now,
      });
    },
    async updateJobAttemptStatus(
      attemptId: string,
      status: JobAttempt["status"],
      updates?: { pid?: number; startedAt?: number; exitCode?: number; finishedAt?: number },
    ) {
      const attempt = attempts.find((entry) => entry.id === attemptId);
      if (!attempt) throw new Error(`Attempt not found: ${attemptId}`);
      attempt.status = status;
      attempt.updatedAt = Date.now();
      if (updates?.pid !== undefined) attempt.pid = updates.pid;
      if (updates?.startedAt !== undefined) attempt.startedAt = updates.startedAt;
      if (updates?.exitCode !== undefined) attempt.exitCode = updates.exitCode;
      if (updates?.finishedAt !== undefined) attempt.finishedAt = updates.finishedAt;
    },
    async listJobAttempts(jobId?: string) {
      return attempts
        .filter((entry) => (jobId ? entry.jobId === jobId : true))
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    async createArtifact(artifact: Omit<Artifact, "createdAt">) {
      artifacts.push({ ...artifact, createdAt: Date.now() });
    },
    async listArtifacts(jobId?: string) {
      return artifacts
        .filter((entry) => (jobId ? entry.jobId === jobId : true))
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    async appendEvent(event: Record<string, unknown>) {
      events.push(event);
    },
    attempts,
    artifacts,
    events,
    jobs,
  };
}

function makeClient(handlers: {
  submitJob?: (
    scriptPath: string,
    opts?: Record<string, unknown>,
  ) => Promise<{ success: boolean; slurmJobId: string; error?: string }>;
  getJobStatus?: (slurmJobId: string) => Promise<SlurmJobStatus>;
  cancelJob?: (slurmJobId: string) => Promise<{ success: boolean; error?: string }>;
  getAccounting?: (slurmJobId: string) => Promise<{
    slurmJobId: string;
    state: SlurmJobStatus["state"];
    exitCode: number;
    elapsed?: string;
    maxRss?: string;
    reqMem?: string;
    nNodes?: number;
    nCpus?: number;
  } | null>;
}): SlurmClient {
  return {
    submitJob: mock(handlers.submitJob ?? (async () => ({ success: true, slurmJobId: "123456" }))),
    getJobStatus: mock(
      handlers.getJobStatus ??
        (async (slurmJobId: string) => ({ slurmJobId, state: "RUNNING", stateCompact: "running" })),
    ),
    cancelJob: mock(handlers.cancelJob ?? (async () => ({ success: true }))),
    getNodes: mock(async () => []),
    getPartitions: mock(async () => []),
    getAccounting: mock(handlers.getAccounting ?? (async () => null)),
  };
}

describe("SlurmRunner", () => {
  test("start persists backend metadata and external job id", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "eigengrid-slurm-start-"));
    const inputPath = join(workspace, "water.inp");
    writeFileSync(inputPath, "* xyz 0 1\nH 0 0 0\nH 0 0 1\n*");

    try {
      const db = createMemoryDatabase();
      await db.createJob({
        id: "job-1",
        name: "water.inp",
        software: "orca",
        inputPath,
        workdir: workspace,
        outputPath: join(workspace, "job-1", "result.log"),
      });
      const client = makeClient({
        submitJob: async (scriptPath, opts) => {
          expect(scriptPath).toBe(join(workspace, "job-1", "submit.slurm"));
          expect(opts).toMatchObject({
            jobName: "water.inp",
            chdir: join(workspace, "job-1"),
            output: join(workspace, "job-1", "slurm-%j.out"),
            error: join(workspace, "job-1", "slurm-%j.err"),
          });
          return { success: true, slurmJobId: "123456" };
        },
      });
      const runner = new SlurmRunner({}, db as never, client);
      const job = makeJob({
        inputPath,
        workdir: workspace,
        outputPath: join(workspace, "job-1", "result.log"),
      });

      expect(await runner.stage(job)).toMatchObject({ ok: true });
      expect(await runner.start(job)).toMatchObject({ ok: true });

      const persisted = await db.getJob(job.id);
      expect(persisted).toMatchObject({
        backend: "slurm",
        externalJobId: "123456",
        externalState: "PENDING",
      });
      expect(String(persisted?.nativeDetail ?? "")).toContain(
        join(workspace, "job-1", "submit.slurm"),
      );
      expect(db.events.some((event) => event.type === "slurm.job.submitted")).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("status resolves persisted external job id after restart", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "eigengrid-slurm-status-"));
    const inputPath = join(workspace, "water.inp");
    writeFileSync(inputPath, "* xyz 0 1\nH 0 0 0\nH 0 0 1\n*");

    try {
      const db = createMemoryDatabase();
      await db.createJob({
        id: "job-1",
        name: "water.inp",
        software: "orca",
        inputPath,
        workdir: workspace,
      });
      await db.updateJobExternalMetadata("job-1", {
        backend: "slurm",
        externalJobId: "123456",
        externalState: "PENDING",
      });
      const client = makeClient({
        getJobStatus: async (slurmJobId) => {
          expect(slurmJobId).toBe("123456");
          return {
            slurmJobId,
            state: "COMPLETED",
            stateCompact: "completed",
            exitCode: 0,
            nodeName: "node-a",
          };
        },
        getAccounting: async (slurmJobId) => {
          expect(slurmJobId).toBe("123456");
          return {
            slurmJobId,
            state: "COMPLETED",
            exitCode: 0,
            elapsed: "01:23:45",
            maxRss: "123456K",
            reqMem: "8Gn",
            nNodes: 1,
            nCpus: 8,
          };
        },
      });
      const runner = new SlurmRunner({}, db as never, client);

      const result = await runner.status(
        makeJob({ inputPath, workdir: workspace, status: "running" }),
      );
      expect(result).toEqual({
        status: "completed",
        exitCode: 0,
        message: "SLURM state: COMPLETED",
      });

      expect(await db.getJob("job-1")).toMatchObject({
        status: "completed",
        externalState: "COMPLETED",
        nodeName: "node-a",
      });
      expect(db.events.some((event) => event.type === "slurm.job.status.synced")).toBe(true);
      expect(db.events.some((event) => event.type === "slurm.accounting.synced")).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("rejects an unsafe persisted external job identity before contacting Slurm", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "eigengrid-slurm-unsafe-id-"));
    const inputPath = join(workspace, "water.inp");
    writeFileSync(inputPath, "* xyz 0 1\nH 0 0 0\nH 0 0 1\n*");

    try {
      const db = createMemoryDatabase();
      await db.createJob({
        id: "job-1",
        name: "water.inp",
        software: "orca",
        inputPath,
        workdir: workspace,
      });
      await db.updateJobExternalMetadata("job-1", {
        backend: "slurm",
        externalJobId: "123; touch /tmp/should-not-run",
        externalState: "RUNNING",
      });
      const getJobStatus = mock(async () => {
        throw new Error("Slurm client must not receive an unsafe identity");
      });
      const runner = new SlurmRunner({}, db as never, makeClient({ getJobStatus }));

      await expect(
        runner.status(makeJob({ inputPath, workdir: workspace, status: "running" })),
      ).rejects.toThrow("Unsafe Slurm job identity");
      expect(getJobStatus).not.toHaveBeenCalled();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("stop resolves persisted external job id after restart", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "eigengrid-slurm-stop-"));
    const inputPath = join(workspace, "water.inp");
    writeFileSync(inputPath, "* xyz 0 1\nH 0 0 0\nH 0 0 1\n*");

    try {
      const db = createMemoryDatabase();
      await db.createJob({
        id: "job-1",
        name: "water.inp",
        software: "orca",
        inputPath,
        workdir: workspace,
      });
      await db.updateJobExternalMetadata("job-1", {
        backend: "slurm",
        externalJobId: "123456",
        externalState: "RUNNING",
      });
      const client = makeClient({
        cancelJob: async (slurmJobId) => {
          expect(slurmJobId).toBe("123456");
          return { success: true };
        },
        getJobStatus: async (slurmJobId) => ({
          slurmJobId,
          state: "CANCELLED",
          stateCompact: "cancelled",
        }),
      });
      const runner = new SlurmRunner({}, db as never, client);

      expect(
        await runner.stop(makeJob({ inputPath, workdir: workspace, status: "running" })),
      ).toMatchObject({ ok: true });
      expect(await db.getJob("job-1")).toMatchObject({
        status: "cancelled",
        externalState: "CANCELLED",
      });
      expect(db.events.some((event) => event.type === "slurm.job.cancelled")).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("fetch registers artifacts using the persisted external job id", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "eigengrid-slurm-fetch-"));
    const inputPath = join(workspace, "water.inp");
    writeFileSync(inputPath, "* xyz 0 1\nH 0 0 0\nH 0 0 1\n*");

    try {
      const db = createMemoryDatabase();
      await db.createJob({
        id: "job-1",
        name: "water.inp",
        software: "orca",
        inputPath,
        workdir: workspace,
        outputPath: join(workspace, "job-1", "result.log"),
      });
      await db.updateJobExternalMetadata("job-1", {
        backend: "slurm",
        externalJobId: "123456",
      });

      const jobDir = join(workspace, "job-1");
      mkdirSync(jobDir, { recursive: true });
      writeFileSync(join(jobDir, "slurm-123456.out"), "slurm out\n");
      writeFileSync(join(jobDir, "slurm-123456.err"), "slurm err\n");
      writeFileSync(join(jobDir, "result.log"), "final output\n");

      const runner = new SlurmRunner({}, db as never, makeClient({}));
      expect(await runner.fetch(makeJob({ inputPath, workdir: workspace }))).toMatchObject({
        ok: true,
      });

      const labels = (await db.listArtifacts("job-1")).map(
        (artifact) => `${artifact.kind}:${artifact.label ?? basename(artifact.path)}`,
      );
      expect(labels).toContain("log:slurm-123456.out");
      expect(labels).toContain("log:slurm-123456.err");
      expect(labels).toContain("output:result.log");
      expect(db.artifacts.length).toBeGreaterThanOrEqual(3);
      expect(db.events.some((event) => event.type === "slurm.artifact.registered")).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
