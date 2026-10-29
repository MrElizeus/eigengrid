import type {
  Artifact,
  Job,
  JobAttempt,
  RemoteProcessStatus,
  RunnerResult,
  StartedProcess,
} from "@eigengrid/core";
import { generateId } from "@eigengrid/core";
import type { Runner } from "./runner";
import { runCommand } from "./process-utils";
import { basename, join } from "path";
import { existsSync, statSync } from "fs";
import { effectRequestDigest, persistEffectIntent, readEffectIntent } from "./effect-intent";
import { quotePosixShellWord } from "./wrapper";
import {
  atomicCopyRunnerFile,
  assertRegularRunnerFile,
  atomicWriteRunnerFile,
  ensurePrivateRunnerDirectory,
} from "./safe-path";

function assertSafeJobId(jobId: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(jobId)) {
    throw new Error(`Unsafe job identifier for PBS execution: ${jobId}`);
  }
}

function assertSafeExternalJobId(externalJobId: string): void {
  if (!/^[0-9][A-Za-z0-9_.:+-]{0,127}$/u.test(externalJobId)) {
    throw new Error("Unsafe PBS job identity");
  }
}

// ────────────────────────────────────────────────────────────
// PbsRunnerConfig
// ────────────────────────────────────────────────────────────

export interface PbsRunnerConfig {
  queue?: string;
  walltime?: string;
  nodes?: number;
  ppn?: number;
  mem?: string;
  project?: string;
  qsubPath?: string;
  qstatPath?: string;
  qdelPath?: string;
  intentPath?: string;
  /** Test-only switch to replay the historical event-ordering defect. */
  legacyLifecycleForCharacterization?: boolean;
}

// ────────────────────────────────────────────────────────────
// Database Interface
// ────────────────────────────────────────────────────────────

interface PbsRunnerDatabase {
  createJobAttempt(attempt: {
    id: string;
    jobId: string;
    runner: "pbs";
    command: string;
    cwd: string;
    status?: JobAttempt["status"];
    pid?: number;
    exitCode?: number;
    startedAt?: number;
    finishedAt?: number;
  }): Promise<void>;
  updateJobStatus(jobId: string, status: Job["status"]): Promise<void>;
  updateJobExternalMetadata?(
    jobId: string,
    metadata: {
      backend?: string;
      externalJobId?: string;
      externalState?: string;
      lastSyncAt?: number;
    },
  ): Promise<void>;
  getJob?(
    jobId: string,
  ): Promise<{ externalJobId?: string | null; external_job_id?: string | null } | null>;
  updateJobAttemptStatus(
    attemptId: string,
    status: JobAttempt["status"],
    updates?: { pid?: number; startedAt?: number; exitCode?: number; finishedAt?: number },
  ): Promise<void>;
  listJobAttempts(jobId?: string): Promise<JobAttempt[]>;
  createArtifact(artifact: Omit<Artifact, "createdAt">): Promise<void>;
  listArtifacts(jobId?: string): Promise<Artifact[]>;
}

// ────────────────────────────────────────────────────────────
// Batch Script Generator
// ────────────────────────────────────────────────────────────

export function generatePbsScript(config: PbsRunnerConfig, job: Job, command: string): string {
  const textValues = [
    [job.name, "job name"],
    [job.workdir, "working directory"],
    [command, "command"],
    [config.queue, "queue"],
    [config.walltime, "walltime"],
    [config.mem, "memory"],
    [config.project, "project"],
  ] as const;
  for (const [value, label] of textValues) {
    if (
      value !== undefined &&
      (value.includes("\0") || value.includes("\r") || value.includes("\n"))
    )
      throw new Error(`PBS ${label} must not contain control characters`);
  }
  const lines: string[] = ["#!/bin/bash"];
  lines.push(`#PBS -N ${job.name}`);
  lines.push(`#PBS -o ${join(job.workdir, job.id, "pbs.out")}`);
  lines.push(`#PBS -e ${join(job.workdir, job.id, "pbs.err")}`);
  if (config.queue) lines.push(`#PBS -q ${config.queue}`);
  if (config.walltime) lines.push(`#PBS -l walltime=${config.walltime}`);
  if (config.nodes && config.ppn) lines.push(`#PBS -l nodes=${config.nodes}:ppn=${config.ppn}`);
  if (config.mem) lines.push(`#PBS -l mem=${config.mem}`);
  if (config.project) lines.push(`#PBS -A ${config.project}`);
  lines.push("");
  lines.push(`cd ${quotePosixShellWord(join(job.workdir, job.id))}`);
  lines.push(`echo "$$" > job.pid`);
  lines.push(`${command} > stdout.log 2> stderr.log`);
  lines.push("echo $? > exit.status");
  lines.push("");
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────
// PbsRunner
// ────────────────────────────────────────────────────────────

export class PbsRunner implements Runner {
  readonly kind = "pbs" as const;
  private activeJobs = new Map<string, string>(); // job.id -> pbs jobid

  constructor(
    private readonly config: PbsRunnerConfig = {},
    private readonly database?: PbsRunnerDatabase,
  ) {}

  private get db(): PbsRunnerDatabase {
    if (!this.database) throw new Error("PbsRunner requires a database instance");
    return this.database;
  }

  private jobDir(job: Job): string {
    assertSafeJobId(job.id);
    return join(job.workdir, job.id);
  }

  private async resolveExternalJobId(job: Job): Promise<string | undefined> {
    const active = this.activeJobs.get(job.id);
    if (active) return active;
    const persisted = await this.db.getJob?.(job.id);
    const persistedId = persisted?.externalJobId ?? persisted?.external_job_id;
    if (persistedId) {
      const value = String(persistedId);
      assertSafeExternalJobId(value);
      this.activeJobs.set(job.id, value);
      return value;
    }
    const intent = readEffectIntent(
      this.config.intentPath ?? join(this.jobDir(job), "effect-intent.json"),
    );
    if (intent?.externalId) {
      assertSafeExternalJobId(intent.externalId);
      this.activeJobs.set(job.id, intent.externalId);
      return intent.externalId;
    }
    return undefined;
  }

  private async registerArtifactOnce(artifact: Omit<Artifact, "createdAt">): Promise<void> {
    const artifacts = await this.db.listArtifacts(artifact.jobId);
    if (artifacts.some((entry) => entry.kind === artifact.kind && entry.path === artifact.path))
      return;
    await this.db.createArtifact(artifact);
  }

  async stage(job: Job): Promise<RunnerResult> {
    const dir = this.jobDir(job);

    ensurePrivateRunnerDirectory(dir);
    const existingAttempts = await this.db.listJobAttempts(job.id);
    const latestAttempt = existingAttempts.at(-1);
    const existingExternalId = job.externalJobId;
    if (
      existingExternalId ||
      (latestAttempt && ["created", "queued", "staged", "running"].includes(latestAttempt.status))
    ) {
      if (latestAttempt && latestAttempt.runner !== "pbs") {
        return {
          ok: false,
          failureDisposition: "termination-unknown",
          message: `Job already has an active ${latestAttempt.runner} attempt; refusing PBS replacement stage`,
        };
      }
      const intentPath = this.config.intentPath ?? join(dir, "effect-intent.json");
      const existingIntent = readEffectIntent(intentPath);
      if (
        existingIntent?.backend === "pbs" &&
        existingIntent.externalId &&
        (existingIntent.state === "submitted" || existingIntent.state === "confirmed")
      ) {
        return {
          ok: true,
          message: `PBS job ${existingIntent.externalId} is already durably staged`,
          metadata: { attemptId: latestAttempt?.id, externalJobId: existingIntent.externalId },
        };
      }
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message:
          "PBS stage has a prior effect or active attempt without a confirmed identity; reconcile before retrying",
      };
    }
    const attemptId = generateId("attempt");

    await this.db.updateJobStatus(job.id, "queued");
    await this.db.createJobAttempt({
      id: attemptId,
      jobId: job.id,
      runner: "pbs",
      command: "",
      cwd: dir,
    });
    // Preserve the attempt reducer's legal created -> queued -> staged path.
    if (!this.config.legacyLifecycleForCharacterization) {
      await this.db.updateJobAttemptStatus(attemptId, "queued");
    }

    const stagedInput = join(dir, basename(job.inputPath));
    assertRegularRunnerFile(stagedInput, "PBS staged input target");
    atomicCopyRunnerFile(job.inputPath, stagedInput);

    await this.registerArtifactOnce({
      id: generateId("artifact"),
      jobId: job.id,
      attemptId,
      kind: "input",
      path: stagedInput,
      mimeType: "text/plain",
      sizeBytes: statSync(stagedInput).size,
    });

    await this.db.updateJobAttemptStatus(attemptId, "staged");
    await this.db.updateJobStatus(job.id, "staged");

    return {
      ok: true,
      message: `Staged ${job.name} in ${dir}`,
      metadata: { attemptId, cwd: dir },
    };
  }

  async start(job: Job): Promise<StartedProcess> {
    const dir = this.jobDir(job);
    const attempts = await this.db.listJobAttempts(job.id);
    const attempt = attempts[attempts.length - 1];
    if (!attempt) {
      return { ok: false, message: "No staged attempt found. Call stage() first." };
    }

    const inputName = basename(job.inputPath);
    const outputName = job.outputPath
      ? basename(job.outputPath)
      : `${inputName.replace(/\.[^.]+$/, "")}.log`;
    const command = `${quotePosixShellWord(job.software)} ${quotePosixShellWord(inputName)} > ${quotePosixShellWord(outputName)}`;

    const script = generatePbsScript(this.config, job, command);
    const scriptPath = join(dir, "submit.pbs");
    ensurePrivateRunnerDirectory(dir);
    atomicWriteRunnerFile(scriptPath, script);

    await this.registerArtifactOnce({
      id: generateId("artifact"),
      jobId: job.id,
      attemptId: attempt.id,
      kind: "input",
      path: scriptPath,
      label: "pbs script",
      mimeType: "text/plain",
      sizeBytes: statSync(scriptPath).size,
    });

    const qsubPath = this.config.qsubPath ?? "qsub";
    const intentPath = this.config.intentPath ?? join(dir, "effect-intent.json");
    const operationId = `pbs-${job.id}-${attempt.id}`;
    const intentBase = {
      schema: "eigengrid.effect-intent.v1" as const,
      operationId,
      jobId: job.id,
      attemptId: attempt.id,
      backend: "pbs" as const,
      requestDigest: effectRequestDigest({ jobId: job.id, attemptId: attempt.id, script }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const previousIntent = readEffectIntent(intentPath);
    if (previousIntent) {
      if (previousIntent.requestDigest !== intentBase.requestDigest) {
        return {
          ok: false,
          message: "PBS dispatch request conflicts with the durable effect intent",
        };
      }
      if (previousIntent.state === "submitted" || previousIntent.state === "confirmed") {
        return {
          ok: true,
          command: previousIntent.externalId,
          message: `PBS job ${previousIntent.externalId ?? "already submitted"} is already durable`,
        };
      }
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message: `PBS dispatch has durable intent state ${previousIntent.state}; reconcile before retrying`,
      };
    }
    persistEffectIntent(intentPath, { ...intentBase, state: "intent_persisted" });
    let result: Awaited<ReturnType<typeof runCommand>>;
    try {
      result = await runCommand(qsubPath, [scriptPath], {
        timeout: 30_000,
        maxOutputBytes: 1024,
        cwd: dir,
      });
    } catch (error) {
      persistEffectIntent(intentPath, {
        ...intentBase,
        state: "ambiguous",
        updatedAt: new Date().toISOString(),
      });
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message: `qsub outcome is ambiguous: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (result.timedOut || result.exitCode === undefined) {
      try {
        persistEffectIntent(intentPath, {
          ...intentBase,
          state: "ambiguous",
          updatedAt: new Date().toISOString(),
        });
      } catch {
        // An unreadable intent remains a fail-closed reconciliation signal.
      }
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message: `qsub outcome is ambiguous${result.timedOut ? " after timeout" : ""}`,
      };
    }

    if (result.exitCode !== 0) {
      const errors: string[] = [];
      try {
        await this.db.updateJobAttemptStatus(attempt.id, "failed", { finishedAt: Date.now() });
      } catch (error) {
        errors.push(
          `attempt failed transition: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        await this.db.updateJobStatus(job.id, "failed");
      } catch (error) {
        errors.push(
          `job failed transition: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      persistEffectIntent(intentPath, {
        ...intentBase,
        state: "failed",
        updatedAt: new Date().toISOString(),
      });
      return {
        ok: false,
        message: [`qsub failed: ${result.stderr.slice(0, 500)}`, ...errors].join("; "),
      };
    }

    const pbsJobId = result.stdout.trim();
    if (!pbsJobId) {
      // A zero exit status without an external identity is not a confirmed
      // submission. Keep the intent ambiguous and refuse to mark the attempt
      // running; reconciliation must inspect the scheduler before retrying.
      persistEffectIntent(intentPath, {
        ...intentBase,
        state: "ambiguous",
        updatedAt: new Date().toISOString(),
      });
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message: "qsub returned success without an external PBS job ID",
      };
    }
    try {
      assertSafeExternalJobId(pbsJobId);
    } catch (error) {
      persistEffectIntent(intentPath, {
        ...intentBase,
        state: "ambiguous",
        updatedAt: new Date().toISOString(),
      });
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message: `qsub returned an invalid external job identity; outcome is ambiguous: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    this.activeJobs.set(job.id, pbsJobId);
    try {
      persistEffectIntent(intentPath, {
        ...intentBase,
        state: "submitted",
        externalId: pbsJobId,
        updatedAt: new Date().toISOString(),
      });
      await this.db.updateJobExternalMetadata?.(job.id, {
        backend: "pbs",
        externalJobId: pbsJobId,
        externalState: "QUEUED",
        lastSyncAt: Date.now(),
      });
      await this.db.updateJobAttemptStatus(attempt.id, "running", {
        startedAt: Date.now(),
      });
      await this.db.updateJobStatus(job.id, "running");
    } catch (error) {
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message: `qsub submitted ${pbsJobId}, but durable identity/state persistence failed; outcome is ambiguous: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    return {
      ok: true,
      pid: undefined,
      command: result.stdout.trim(),
      message: `Submitted as PBS job ${pbsJobId}`,
    };
  }

  async status(job: Job): Promise<RemoteProcessStatus> {
    const pbsJobId = await this.resolveExternalJobId(job);
    if (!pbsJobId) {
      return { status: "unknown", message: "No PBS job ID tracked for this job" };
    }

    const qstatPath = this.config.qstatPath ?? "qstat";
    const result = await runCommand(qstatPath, ["-f", pbsJobId], {
      timeout: 15_000,
      maxOutputBytes: 2048,
    });

    if (result.exitCode !== 0) {
      // Try simpler qstat format
      const simple = await runCommand(qstatPath, [pbsJobId], {
        timeout: 15_000,
        maxOutputBytes: 1024,
      });
      if (simple.exitCode === 0) {
        const state = simple.stdout
          .trim()
          .split("\n")
          .find((l) => l.includes(pbsJobId));
        if (state) {
          const parts = state.trim().split(/\s+/);
          const pbsState = parts[parts.length - 1] ?? "E";
          return this.mapPbsState(pbsState, job);
        }
      }
      return { status: "unknown", message: `qstat failed: ${result.stderr.slice(0, 200)}` };
    }

    // Parse full qstat -f output for job_state
    const lines = result.stdout.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("job_state")) {
        const state = trimmed.split("=")[1]?.trim() ?? "E";
        return this.mapPbsState(state, job);
      }
      if (trimmed.startsWith("exit_status")) {
        const exitCode = parseInt(trimmed.split("=")[1]?.trim() ?? "1", 10);
        return { status: exitCode === 0 ? "completed" : "failed", exitCode };
      }
    }

    return { status: "unknown", message: "Could not parse qstat output" };
  }

  private mapPbsState(state: string, _job: Job): RemoteProcessStatus {
    const upper = state.toUpperCase();
    if (upper === "C") return { status: "completed" };
    if (["E", "H", "Q", "W", "S"].includes(upper))
      return { status: "running", message: `PBS state: ${state}` };
    if (upper === "R") return { status: "running", message: "Running" };
    if (upper === "F") return { status: "failed" };
    return { status: "unknown", message: `Unknown PBS state: ${state}` };
  }

  async stop(job: Job): Promise<RunnerResult> {
    const pbsJobId = await this.resolveExternalJobId(job);
    if (!pbsJobId) {
      return { ok: false, message: "No PBS job ID tracked for this job" };
    }
    assertSafeExternalJobId(pbsJobId);

    const qdelPath = this.config.qdelPath ?? "qdel";
    const intentPath = this.config.intentPath ?? join(this.jobDir(job), "effect-intent.json");
    const attempts = await this.db.listJobAttempts(job.id);
    const attempt = attempts.at(-1);
    let intent = readEffectIntent(intentPath);
    if (!intent) {
      const now = new Date().toISOString();
      intent = {
        schema: "eigengrid.effect-intent.v1",
        operationId: `pbs-cancel-${job.id}-${attempt?.id ?? "unknown"}`,
        jobId: job.id,
        attemptId: attempt?.id ?? "unknown",
        backend: "pbs",
        state: "intent_persisted",
        requestDigest: effectRequestDigest({
          action: "cancel",
          jobId: job.id,
          externalJobId: pbsJobId,
        }),
        createdAt: now,
        updatedAt: now,
      };
      persistEffectIntent(intentPath, intent);
      persistEffectIntent(intentPath, {
        ...intent,
        state: "submitted",
        externalId: pbsJobId,
        updatedAt: new Date().toISOString(),
      });
      intent = readEffectIntent(intentPath)!;
    }
    if (intent.externalId && intent.externalId !== pbsJobId) {
      return { ok: false, message: "PBS cancellation identity conflicts with durable intent" };
    }
    if (intent.state === "cancelled") {
      return { ok: true, message: `PBS job ${pbsJobId} was already cancelled` };
    }
    persistEffectIntent(intentPath, {
      ...intent,
      state: "cancel_requested",
      updatedAt: new Date().toISOString(),
    });
    intent = { ...intent, state: "cancel_requested", updatedAt: new Date().toISOString() };
    let result: Awaited<ReturnType<typeof runCommand>>;
    try {
      result = await runCommand(qdelPath, [pbsJobId], {
        timeout: 15_000,
        maxOutputBytes: 1024,
      });
    } catch (error) {
      try {
        persistEffectIntent(intentPath, {
          ...intent,
          state: "ambiguous",
          updatedAt: new Date().toISOString(),
        });
      } catch {
        // Preserve the transport ambiguity; the unreadable intent itself is
        // a fail-closed reconciliation signal.
      }
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message: `qdel outcome is ambiguous: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (result.exitCode !== 0) {
      // qdel failure is not proof of cancellation. Preserve the running
      // aggregate and require status reconciliation before another action.
      try {
        persistEffectIntent(intentPath, {
          ...intent,
          state: "ambiguous",
          updatedAt: new Date().toISOString(),
        });
      } catch {
        // Preserve the scheduler failure; do not claim cancellation.
      }
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message: `qdel failed: ${result.stderr.slice(0, 200)}`,
      };
    }

    // PBS removes a job from qstat after qdel; a successful qdel response is
    // therefore not proof that cancellation completed. Reconcile first and
    // leave the durable intent ambiguous until the site adapter provides a
    // terminal cancellation observation.
    const observed = await this.status(job);
    if (observed.status === "unknown" || observed.status === "running") {
      persistEffectIntent(intentPath, {
        ...intent,
        state: "ambiguous",
        updatedAt: new Date().toISOString(),
      });
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message: `qdel was accepted but PBS cancellation is not externally confirmed (${observed.message ?? observed.status})`,
      };
    }
    return {
      ok: false,
      failureDisposition: "termination-unknown",
      message: `qdel completed after PBS reported terminal state ${observed.status}; cancellation was not confirmed`,
    };
  }

  async fetch(job: Job): Promise<RunnerResult> {
    const dir = this.jobDir(job);
    const attempts = await this.db.listJobAttempts(job.id);
    const attempt = attempts[attempts.length - 1];
    const attemptId = attempt?.id ?? "unknown";

    const filesToPull = ["stdout.log", "stderr.log", "exit.status", "pbs.out", "pbs.err"];
    let foundArtifacts = 0;

    for (const file of filesToPull) {
      const filePath = join(dir, file);
      if (existsSync(filePath)) {
        assertRegularRunnerFile(filePath, "PBS fetched artifact target");
        await this.registerArtifactOnce({
          id: generateId("artifact"),
          jobId: job.id,
          attemptId,
          kind: "log",
          path: filePath,
          label: file,
          mimeType: "text/plain",
          sizeBytes: statSync(filePath).size,
        });
        foundArtifacts++;
      }
    }

    if (job.outputPath) {
      const outputPath = join(dir, basename(job.outputPath));
      if (existsSync(outputPath)) {
        assertRegularRunnerFile(outputPath, "PBS fetched output target");
        await this.registerArtifactOnce({
          id: generateId("artifact"),
          jobId: job.id,
          attemptId,
          kind: "output",
          path: outputPath,
          mimeType: "text/plain",
          sizeBytes: statSync(outputPath).size,
        });
        foundArtifacts++;
      }
    }

    if (foundArtifacts === 0) {
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message: `PBS artifact collection found no regular artifacts in ${dir}`,
      };
    }
    return { ok: true, message: `Fetched artifacts from ${dir}` };
  }
}
