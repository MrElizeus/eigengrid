import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Artifact, Job, JobAttemptStatus, JobStatus, RunnerKind } from "@eigengrid/core";
import { VALID_TRANSITIONS } from "@eigengrid/core";
import {
  DbInvalidTransitionError,
  PostgresDatabase,
  SqliteDatabase,
  VALID_ATTEMPT_TRANSITIONS,
  type DatabaseLike,
  type EventRecord,
} from "@eigengrid/db";
import {
  LocalRunner,
  PbsRunner,
  SlurmRunner,
  SshRunner,
  type CommandExecutor,
} from "@eigengrid/runners";
import type { SlurmClient } from "@eigengrid/slurm";
import { cancelJobTool, parseJobOutputTool } from "@eigengrid/tool-registry";
import { WorkerSyncService } from "../../apps/cli/src/services/worker-sync-service";
import {
  canRunPostgres,
  startEphemeralPostgres,
  type EphemeralPostgresCluster,
} from "./helpers/postgres";

type TransitionMap = Record<string, string[]>;

interface GoldenScenario {
  operations: string[];
  events?: string[];
  final: { job: string; attempt: string };
  partialArtifacts?: number;
  results?: number;
  serviceResult?: { ok: boolean; syncedJobs: number; errors: string[] };
}

interface GoldenCharacterization {
  schemaVersion: number;
  kind: string;
  baseSha: string;
  jobAllowedTransitions: TransitionMap;
  attemptAllowedTransitions: TransitionMap;
  surfaceTraces: Record<string, GoldenScenario>;
}

const goldenPath = fileURLToPath(
  new URL("../fixtures/execution-transitions/current-v1.json", import.meta.url),
);
const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as GoldenCharacterization;

interface ProviderHarness {
  db: DatabaseLike;
  root: string;
  cleanup(): Promise<void>;
}

type ProviderFactory = () => Promise<ProviderHarness>;

interface ObservedDatabase {
  db: DatabaseLike;
  trace: string[];
  reset(): void;
}

function errorOutcome(error: unknown): "rejected" {
  expect(error).toBeInstanceOf(DbInvalidTransitionError);
  return "rejected";
}

function observeDatabase(target: DatabaseLike): ObservedDatabase {
  const trace: string[] = [];
  const targetRecord = target as unknown as Record<PropertyKey, unknown>;

  const proxy = new Proxy(targetRecord, {
    get(_object, property) {
      if (property === "updateJobStatus") {
        return async (jobId: string, status: JobStatus): Promise<void> => {
          const before = (await target.getJob(jobId))?.status ?? "missing";
          try {
            await target.updateJobStatus(jobId, status);
            trace.push(`job:${before}->${status}:${before === status ? "noop" : "applied"}`);
          } catch (error) {
            errorOutcome(error);
            trace.push(`job:${before}->${status}:rejected`);
            throw error;
          }
        };
      }

      if (property === "createJobAttempt") {
        return async (attempt: {
          id: string;
          jobId: string;
          runner: RunnerKind;
          command: string;
          cwd: string;
          status?: JobAttemptStatus;
        }): Promise<void> => {
          const status = attempt.status ?? "created";
          try {
            await target.createJobAttempt(attempt);
            trace.push(`attempt:create:${attempt.runner}:${status}:applied`);
          } catch (error) {
            trace.push(`attempt:create:${attempt.runner}:${status}:rejected`);
            throw error;
          }
        };
      }

      if (property === "updateJobAttemptStatus") {
        return async (
          attemptId: string,
          status: JobAttemptStatus,
          updates?: {
            pid?: number;
            startedAt?: number;
            exitCode?: number;
            finishedAt?: number;
          },
        ): Promise<void> => {
          const before = (await target.listJobAttempts()).find(
            (attempt) => attempt.id === attemptId,
          )?.status;
          try {
            await target.updateJobAttemptStatus(attemptId, status, updates);
            trace.push(
              `attempt:${before ?? "missing"}->${status}:${before === status ? "noop" : "applied"}`,
            );
          } catch (error) {
            errorOutcome(error);
            trace.push(`attempt:${before ?? "missing"}->${status}:rejected`);
            throw error;
          }
        };
      }

      if (property === "createArtifact" || property === "createArtifactIfAbsent") {
        return async (artifact: Omit<Artifact, "createdAt">): Promise<void | boolean> => {
          const operation =
            property === "createArtifactIfAbsent" ? "createArtifactIfAbsent" : "createArtifact";
          const result = await (
            target[operation] as (input: Omit<Artifact, "createdAt">) => Promise<void | boolean>
          )(artifact);
          const outcome = result === false ? "noop" : "applied";
          trace.push(`artifact:${artifact.kind}:${artifact.label ?? "-"}:${outcome}`);
          return result;
        };
      }

      if (property === "appendEvent") {
        return async (event: Parameters<DatabaseLike["appendEvent"]>[0]): Promise<void> => {
          await target.appendEvent(event);
          trace.push(`event:${event.type}:applied`);
        };
      }

      if (property === "insertEvent") {
        return async (event: Parameters<DatabaseLike["insertEvent"]>[0]): Promise<void> => {
          await target.insertEvent(event);
          trace.push(`legacy-event:${event.type}:applied`);
        };
      }

      if (property === "materializeTerminalAttempt") {
        return async (
          evidence: Parameters<DatabaseLike["materializeTerminalAttempt"]>[0],
        ): Promise<void> => {
          const before = (await target.listJobAttempts(evidence.jobId)).find(
            (attempt) => attempt.id === evidence.attemptId,
          )?.status;
          await target.materializeTerminalAttempt(evidence);
          trace.push(`terminal:${before ?? "missing"}->${evidence.status}:applied`);
        };
      }

      if (property === "saveResult") {
        return async (input: Parameters<DatabaseLike["saveResult"]>[0]): Promise<string> => {
          const resultId = await target.saveResult(input);
          trace.push(`result:${input.status}:applied`);
          return resultId;
        };
      }

      const value = targetRecord[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as DatabaseLike;

  return {
    db: proxy,
    trace,
    reset() {
      trace.length = 0;
    },
  };
}

function runResult(command: string, stdout = "", stderr = "") {
  return {
    command,
    exitCode: 0,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
  };
}

function fakeExecutor(
  handler: (
    command: string,
    args: string[],
  ) => { stdout?: string; stderr?: string; exitCode?: number },
): CommandExecutor {
  return {
    async run(command, args = []) {
      const handled = handler(command, args);
      return {
        ...runResult(command, handled.stdout ?? "", handled.stderr ?? ""),
        exitCode: handled.exitCode ?? 0,
      };
    },
    spawn() {
      throw new Error("spawn is outside this characterization fake");
    },
    runSync() {
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  };
}

async function createFixtureJob(
  db: DatabaseLike,
  root: string,
  id: string,
  software = "unknown",
): Promise<Job> {
  const inputDir = join(root, "inputs");
  const jobsDir = join(root, "jobs");
  mkdirSync(inputDir, { recursive: true });
  mkdirSync(jobsDir, { recursive: true });
  const inputPath = join(inputDir, `${id}.inp`);
  writeFileSync(inputPath, "characterization input\n");
  await db.createJob({
    id,
    name: `${id}.inp`,
    software,
    inputPath,
    workdir: jobsDir,
  });
  const job = await db.getJob(id);
  if (!job) throw new Error(`Fixture job ${id} was not persisted`);
  return job as unknown as Job;
}

async function eventMark(db: DatabaseLike, jobId: string): Promise<number> {
  const events = await db.getEvents(jobId);
  return events.reduce((maximum, event) => Math.max(maximum, event.id), 0);
}

function parsePayload(event: EventRecord): Record<string, unknown> {
  if (!event.payloadJson) return {};
  const value = JSON.parse(event.payloadJson) as unknown;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeLifecycleEvents(events: EventRecord[]): string[] {
  return [...events]
    .sort((left, right) => left.id - right.id)
    .flatMap((event): string[] => {
      const payload = parsePayload(event);
      if (event.type === "job.status.changed") {
        return [`job:${String(payload.from)}->${String(payload.to)}`];
      }
      if (event.type === "attempt.created") {
        return [`attempt:create:${String(payload.runner)}:created`];
      }
      if (event.type === "attempt.status.changed") {
        return [`attempt:${String(payload.from)}->${String(payload.to)}`];
      }
      if (
        event.type.startsWith("process.") ||
        event.type.startsWith("slurm.") ||
        event.type.startsWith("parse.") ||
        event.type === "result.saved"
      ) {
        return [`event:${event.type}`];
      }
      return [];
    });
}

async function eventsAfter(db: DatabaseLike, jobId: string, mark: number): Promise<string[]> {
  return normalizeLifecycleEvents((await db.getEvents(jobId)).filter((event) => event.id > mark));
}

async function waitForTerminal(db: DatabaseLike, jobId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = (await db.getJob(jobId))?.status;
    if (status === "completed" || status === "failed" || status === "cancelled") return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${jobId}; current status=${status ?? "missing"}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

async function waitForEventsAfter(
  db: DatabaseLike,
  jobId: string,
  mark: number,
  expectedCount: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await db.getEvents(jobId)).filter((event) => event.id > mark).length >= expectedCount)
      return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for lifecycle events for ${jobId}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

function findTransitionPath(matrix: TransitionMap, target: string): string[] {
  const queue: string[][] = [["created"]];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const path = queue.shift()!;
    const current = path[path.length - 1]!;
    if (current === target) return path;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of matrix[current] ?? []) queue.push([...path, next]);
  }
  throw new Error(`No legal path from created to ${target}`);
}

async function createJobAtStatus(
  db: DatabaseLike,
  root: string,
  id: string,
  status: string,
): Promise<void> {
  await createFixtureJob(db, root, id);
  for (const next of findTransitionPath(golden.jobAllowedTransitions, status).slice(1)) {
    await db.updateJobStatus(id, next);
  }
}

async function createAttemptAtStatus(
  db: DatabaseLike,
  root: string,
  jobId: string,
  attemptId: string,
  status: string,
  runner: RunnerKind = "local",
): Promise<void> {
  await createFixtureJob(db, root, jobId);
  await db.createJobAttempt({
    id: attemptId,
    jobId,
    runner,
    command: "characterization",
    cwd: join(root, "jobs", jobId),
  });
  for (const next of findTransitionPath(golden.attemptAllowedTransitions, status).slice(1)) {
    await db.updateJobAttemptStatus(attemptId, next as JobAttemptStatus);
  }
}

async function assertExhaustiveJobMatrix(db: DatabaseLike, root: string, provider: string) {
  const statuses = Object.keys(golden.jobAllowedTransitions);
  for (const from of statuses) {
    for (const to of statuses) {
      const id = `matrix-job-${provider}-${from}-${to}`;
      await createJobAtStatus(db, root, id, from);
      const mark = await eventMark(db, id);
      const allowed = from === to || golden.jobAllowedTransitions[from]!.includes(to);
      let thrown: unknown;
      try {
        await db.updateJobStatus(id, to);
      } catch (error) {
        thrown = error;
      }

      if (allowed) {
        expect(thrown).toBeUndefined();
        expect((await db.getJob(id))?.status).toBe(to);
      } else {
        expect(thrown).toBeInstanceOf(DbInvalidTransitionError);
        expect((await db.getJob(id))?.status).toBe(from);
      }

      const statusEvents = (await db.getEvents(id)).filter(
        (event) => event.id > mark && event.type === "job.status.changed",
      );
      expect(statusEvents).toHaveLength(allowed && from !== to ? 1 : 0);
    }
  }
}

async function assertExhaustiveAttemptMatrix(db: DatabaseLike, root: string, provider: string) {
  const statuses = Object.keys(golden.attemptAllowedTransitions);
  for (const from of statuses) {
    for (const to of statuses) {
      const suffix = `${provider}-${from}-${to}`;
      const jobId = `matrix-attempt-job-${suffix}`;
      const attemptId = `matrix-attempt-${suffix}`;
      await createAttemptAtStatus(db, root, jobId, attemptId, from);
      const mark = await eventMark(db, jobId);
      const allowed = from === to || golden.attemptAllowedTransitions[from]!.includes(to);
      let thrown: unknown;
      try {
        await db.updateJobAttemptStatus(attemptId, to as JobAttemptStatus);
      } catch (error) {
        thrown = error;
      }

      const attempt = (await db.listJobAttempts(jobId))[0];
      if (allowed) {
        expect(thrown).toBeUndefined();
        expect(attempt?.status).toBe(to);
      } else {
        expect(thrown).toBeInstanceOf(DbInvalidTransitionError);
        expect(attempt?.status).toBe(from);
      }

      const statusEvents = (await db.getEvents(jobId)).filter(
        (event) => event.id > mark && event.type === "attempt.status.changed",
      );
      expect(statusEvents).toHaveLength(allowed && from !== to ? 1 : 0);
    }
  }
}

function makeSlurmClient(onSubmit: () => void): SlurmClient {
  return {
    async submitJob() {
      onSubmit();
      return { success: true, slurmJobId: "unexpected-submit" };
    },
    async getJobStatus(slurmJobId) {
      return { slurmJobId, state: "PENDING", stateCompact: "pending" };
    },
    async cancelJob() {
      return { success: true };
    },
    async getNodes() {
      return [];
    },
    async getPartitions() {
      return [];
    },
    async getAccounting() {
      return null;
    },
  };
}

function registerProviderSuite(name: "sqlite" | "postgres", factory: ProviderFactory): void {
  describe(`Execution transition characterization (${name})`, () => {
    let harness: ProviderHarness;

    beforeAll(async () => {
      harness = await factory();
    });

    afterAll(async () => {
      await harness.cleanup();
    });

    test("golden transition matrices match exported runtime policy", () => {
      expect(golden.schemaVersion).toBe(1);
      expect(golden.kind).toBe("current-behavior-characterization");
      expect(golden.baseSha).toBe("90d6aafc9c828ce509a5114d12f5d42ba07ce3e4");
      expect(VALID_TRANSITIONS).toEqual(golden.jobAllowedTransitions);
      expect(VALID_ATTEMPT_TRANSITIONS).toEqual(golden.attemptAllowedTransitions);
    });

    test("real adapter accepts every legal/no-op transition and rejects every illegal job transition", async () => {
      await assertExhaustiveJobMatrix(harness.db, harness.root, name);
    });

    test("real adapter accepts every legal/no-op transition and rejects every illegal attempt transition", async () => {
      await assertExhaustiveAttemptMatrix(harness.db, harness.root, name);
    });

    test("Local stage/start/terminal behavior matches the current golden trace", async () => {
      const scenario = golden.surfaceTraces.localSuccess!;
      const observed = observeDatabase(harness.db);
      const job = await createFixtureJob(harness.db, harness.root, `surface-local-${name}`);
      const mark = await eventMark(harness.db, job.id);
      const runner = new LocalRunner({
        database: observed.db,
        engines: {
          unknown: {
            command: "/bin/sh",
            args: ["-c", "sleep 0.2"],
            displayCommand: "characterization-local-success",
          },
        },
      });

      expect(await runner.stage(job)).toMatchObject({ ok: true });
      expect(await runner.start(job)).toMatchObject({ ok: true });
      await waitForTerminal(harness.db, job.id, 5_000);

      expect(observed.trace).toEqual(scenario.operations);
      expect(await eventsAfter(harness.db, job.id, mark)).toEqual(scenario.events);
      expect((await harness.db.getJob(job.id))?.status).toBe(scenario.final.job);
      expect((await harness.db.listJobAttempts(job.id))[0]?.status).toBe(scenario.final.attempt);
    }, 10_000);

    test("SSH valid stage and start ordering match current golden traces", async () => {
      const stageScenario = golden.surfaceTraces.sshStage!;
      const startScenario = golden.surfaceTraces.sshStartAndCompletion!;
      const observed = observeDatabase(harness.db);
      const job = await createFixtureJob(harness.db, harness.root, `surface-ssh-${name}`);
      const executor = fakeExecutor((command, args) => {
        const remoteCommand = args.at(-1) ?? "";
        if (command === "ssh" && remoteCommand.includes("if [ -f exit.status ]")) {
          return { stdout: "EXIT:0\n" };
        }
        if (
          command === "ssh" &&
          remoteCommand.includes("job.pid") &&
          remoteCommand.includes('echo "unknown"')
        ) {
          return { stdout: "4242\n" };
        }
        return { stdout: "" };
      });
      const runner = new SshRunner(
        {
          host: "characterization.invalid",
          username: "eigengrid-test",
          port: 22,
          remoteScratchDir: "/tmp/eigengrid-characterization",
          legacyLifecycleForCharacterization: true,
        },
        observed.db,
        {
          engines: {
            unknown: {
              command: "/bin/true",
              args: [],
              displayCommand: "characterization-ssh-success",
            },
          },
          executor,
        },
      );

      const stageMark = await eventMark(harness.db, job.id);
      expect(await runner.stage(job)).toMatchObject({ ok: true });
      expect(observed.trace).toEqual(stageScenario.operations);
      expect(await eventsAfter(harness.db, job.id, stageMark)).toEqual(stageScenario.events);

      observed.reset();
      const startMark = await eventMark(harness.db, job.id);
      expect(await runner.start(job)).toMatchObject({ ok: true, pid: 4242 });
      await waitForTerminal(harness.db, job.id, 8_000);
      await waitForEventsAfter(harness.db, job.id, startMark, startScenario.events.length, 8_000);

      expect(observed.trace).toEqual(startScenario.operations);
      expect(await eventsAfter(harness.db, job.id, startMark)).toEqual(startScenario.events);
      expect((await harness.db.getJob(job.id))?.status).toBe(startScenario.final.job);
      expect((await harness.db.listJobAttempts(job.id))[0]?.status).toBe(
        startScenario.final.attempt,
      );
    }, 12_000);

    test("SSH cancellation transitions both running rows but emits no runner terminal event", async () => {
      const scenario = golden.surfaceTraces.sshCancellation!;
      const observed = observeDatabase(harness.db);
      const job = await createFixtureJob(harness.db, harness.root, `surface-ssh-cancel-${name}`);
      await harness.db.updateJobStatus(job.id, "queued");
      await harness.db.updateJobStatus(job.id, "staged");
      await harness.db.updateJobStatus(job.id, "running");
      await harness.db.createJobAttempt({
        id: `surface-ssh-cancel-attempt-${name}`,
        jobId: job.id,
        runner: "ssh",
        command: "characterization",
        cwd: "/tmp/eigengrid-characterization/cancel",
      });
      const attemptId = `surface-ssh-cancel-attempt-${name}`;
      await harness.db.updateJobAttemptStatus(attemptId, "queued");
      await harness.db.updateJobAttemptStatus(attemptId, "staged");
      await harness.db.updateJobAttemptStatus(attemptId, "running");
      observed.reset();
      const mark = await eventMark(harness.db, job.id);

      const runner = new SshRunner(
        {
          host: "characterization.invalid",
          username: "eigengrid-test",
          port: 22,
          remoteScratchDir: "/tmp/eigengrid-characterization",
        },
        observed.db,
        { executor: fakeExecutor(() => ({ stdout: "STOPPED\n" })) },
      );

      expect(await runner.stop(job)).toMatchObject({ ok: true });
      expect(observed.trace).toEqual(scenario.operations);
      expect(await eventsAfter(harness.db, job.id, mark)).toEqual(scenario.events);
      expect((await harness.db.getJob(job.id))?.status).toBe(scenario.final.job);
      expect((await harness.db.listJobAttempts(job.id))[0]?.status).toBe(scenario.final.attempt);
    });

    test("Worker sync reproduces terminal-event/created-aggregate contradiction", async () => {
      const scenario = golden.surfaceTraces.workerCompletedSyncContradiction!;
      const observed = observeDatabase(harness.db);
      const job = await createFixtureJob(harness.db, harness.root, `surface-worker-${name}`);
      const attemptId = `surface-worker-attempt-${name}`;
      await harness.db.createJobAttempt({
        id: attemptId,
        jobId: job.id,
        runner: "worker-daemon",
        command: "characterization-worker",
        cwd: `/scratch/eigengrid/inbox/${job.id}`,
      });
      const nodeName = `surface-worker-node-${name}`;
      await harness.db.createNode({
        id: `node-${name}-worker-characterization`,
        name: nodeName,
        host: "characterization.invalid",
        user: "eigengrid-test",
        runner: "worker-daemon",
        remoteScratchDir: "/scratch/eigengrid",
      });
      const executor = fakeExecutor((command, args) => {
        if (command !== "ssh") return {};
        const remoteCommand = args.at(-1) ?? "";
        if (remoteCommand.startsWith("cat ") && remoteCommand.includes("status.json")) {
          return {
            stdout: `${JSON.stringify({
              jobId: job.id,
              state: "completed",
              exitCode: 0,
              finishedAt: 1_700_000_000_000,
            })}\n`,
          };
        }
        if (remoteCommand.startsWith("ls -1 ") && remoteCommand.includes("/done/")) {
          return { stdout: `${job.id}\n` };
        }
        if (remoteCommand.startsWith("ls -1 ") && remoteCommand.includes("/failed/")) {
          return { stdout: "" };
        }
        return { stdout: "" };
      });
      const service = new WorkerSyncService(
        observed.db,
        { jobsDir: join(harness.root, "jobs") } as never,
        executor,
      );
      observed.reset();
      const mark = await eventMark(harness.db, job.id);

      const result = await service.syncNode(nodeName);

      expect(result).toEqual(scenario.serviceResult);
      expect(observed.trace).toEqual(scenario.operations);
      expect(await eventsAfter(harness.db, job.id, mark)).toEqual(scenario.events);
      expect((await harness.db.getJob(job.id))?.status).toBe(scenario.final.job);
      expect((await harness.db.listJobAttempts(job.id))[0]?.status).toBe(scenario.final.attempt);
    });

    test("Slurm stage reproduces created-to-staged rejection and partial writes", async () => {
      const scenario = golden.surfaceTraces.slurmStageIllegalTransition!;
      const observed = observeDatabase(harness.db);
      const job = await createFixtureJob(harness.db, harness.root, `surface-slurm-${name}`);
      let submitCalls = 0;
      const runner = new SlurmRunner(
        { legacyLifecycleForCharacterization: true },
        observed.db,
        makeSlurmClient(() => submitCalls++),
      );
      observed.reset();
      const mark = await eventMark(harness.db, job.id);

      let thrown: unknown;
      try {
        await runner.stage(job);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(DbInvalidTransitionError);
      expect(String((thrown as Error).message)).toContain("created");
      expect(String((thrown as Error).message)).toContain("staged");
      expect(submitCalls).toBe(0);
      expect(observed.trace).toEqual(scenario.operations);
      expect(await eventsAfter(harness.db, job.id, mark)).toEqual(scenario.events);
      expect((await harness.db.getJob(job.id))?.status).toBe(scenario.final.job);
      expect((await harness.db.listJobAttempts(job.id))[0]?.status).toBe(scenario.final.attempt);
      expect(await harness.db.listArtifacts(job.id)).toHaveLength(scenario.partialArtifacts!);
    });

    test("PBS stage reproduces created-to-staged rejection and partial writes", async () => {
      const scenario = golden.surfaceTraces.pbsStageIllegalTransition!;
      const observed = observeDatabase(harness.db);
      const job = await createFixtureJob(harness.db, harness.root, `surface-pbs-${name}`);
      const runner = new PbsRunner({ legacyLifecycleForCharacterization: true }, observed.db);
      observed.reset();
      const mark = await eventMark(harness.db, job.id);

      let thrown: unknown;
      try {
        await runner.stage(job);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(DbInvalidTransitionError);
      expect(String((thrown as Error).message)).toContain("created");
      expect(String((thrown as Error).message)).toContain("staged");
      expect(observed.trace).toEqual(scenario.operations);
      expect(await eventsAfter(harness.db, job.id, mark)).toEqual(scenario.events);
      expect((await harness.db.getJob(job.id))?.status).toBe(scenario.final.job);
      expect((await harness.db.listJobAttempts(job.id))[0]?.status).toBe(scenario.final.attempt);
      expect(await harness.db.listArtifacts(job.id)).toHaveLength(scenario.partialArtifacts!);
    });

    test("legacy cancel tool leaves attempt live and emits a Slurm event for a local job", async () => {
      const scenario = golden.surfaceTraces.legacyCancelTool!;
      const observed = observeDatabase(harness.db);
      const job = await createFixtureJob(harness.db, harness.root, `surface-tool-cancel-${name}`);
      const attemptId = `surface-tool-cancel-attempt-${name}`;
      await harness.db.updateJobStatus(job.id, "queued");
      await harness.db.createJobAttempt({
        id: attemptId,
        jobId: job.id,
        runner: "local",
        command: "characterization",
        cwd: join(harness.root, "jobs", job.id),
      });
      await harness.db.updateJobAttemptStatus(attemptId, "queued");
      observed.reset();

      const result = await cancelJobTool.execute({ db: observed.db } as never, { jobId: job.id });

      expect(result).toMatchObject({ ok: true, data: { status: "cancelled" } });
      expect(observed.trace).toEqual(scenario.operations);
      expect((await harness.db.getJob(job.id))?.status).toBe(scenario.final.job);
      expect((await harness.db.listJobAttempts(job.id))[0]?.status).toBe(scenario.final.attempt);
    });

    test("legacy parse tool saves evidence without transitioning job or attempt to parsed", async () => {
      const scenario = golden.surfaceTraces.legacyParseTool!;
      const observed = observeDatabase(harness.db);
      const job = await createFixtureJob(harness.db, harness.root, `surface-tool-parse-${name}`);
      const attemptId = `surface-tool-parse-attempt-${name}`;
      for (const status of ["queued", "staged", "running", "completed"] as const) {
        await harness.db.updateJobStatus(job.id, status);
      }
      await harness.db.createJobAttempt({
        id: attemptId,
        jobId: job.id,
        runner: "local",
        command: "characterization",
        cwd: join(harness.root, "jobs", job.id),
      });
      for (const status of ["queued", "staged", "running", "completed"] as const) {
        await harness.db.updateJobAttemptStatus(attemptId, status);
      }
      const outputPath = join(harness.root, "jobs", job.id, "output.log");
      mkdirSync(join(harness.root, "jobs", job.id), { recursive: true });
      writeFileSync(outputPath, "characterization output\n");
      await harness.db.createArtifact({
        id: `surface-tool-parse-artifact-${name}`,
        jobId: job.id,
        attemptId,
        kind: "output",
        path: outputPath,
      });
      observed.reset();
      const mark = await eventMark(harness.db, job.id);

      const result = await parseJobOutputTool.execute(
        {
          db: observed.db,
          config: {
            jobsDir: join(harness.root, "jobs"),
            outputsDir: join(harness.root, "outputs"),
          },
          python: {
            async parse() {
              return {
                ok: true,
                status: "completed" as const,
                parser: "unknown",
                data: {
                  energy_hartree: -1,
                  scf_converged: true,
                  normal_termination: true,
                },
              };
            },
          },
        } as never,
        { jobId: job.id, attemptId },
      );

      expect(result).toMatchObject({ ok: true, data: { ok: true, status: "completed" } });
      expect(observed.trace).toEqual(scenario.operations);
      expect(await eventsAfter(harness.db, job.id, mark)).toEqual(scenario.events);
      expect((await harness.db.getJob(job.id))?.status).toBe(scenario.final.job);
      expect((await harness.db.listJobAttempts(job.id))[0]?.status).toBe(scenario.final.attempt);
      expect(await harness.db.listResults(job.id, attemptId)).toHaveLength(scenario.results!);
    });
  });
}

registerProviderSuite("sqlite", async () => {
  const root = mkdtempSync(join(tmpdir(), "eigengrid-eg002-sqlite-"));
  const db = new SqliteDatabase(join(root, "eigengrid.sqlite"));
  await db.init();
  return {
    db,
    root,
    async cleanup() {
      await db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
});

if (canRunPostgres) {
  registerProviderSuite("postgres", async () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-eg002-postgres-"));
    const cluster: EphemeralPostgresCluster = await startEphemeralPostgres();
    const db = new PostgresDatabase(cluster.url);
    await db.init();
    return {
      db,
      root,
      async cleanup() {
        await db.close();
        cluster.cleanup();
        rmSync(root, { recursive: true, force: true });
      },
    };
  });
} else {
  test.skip("PostgreSQL characterization requires initdb or EIGENGRID_TEST_POSTGRES_URL", () => {});
}
