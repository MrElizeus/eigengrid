import type {
  Artifact,
  Job,
  JobAttempt,
  JobStatus,
  RemoteProcessStatus,
  RunnerResult,
  StartedProcess,
} from "@eigengrid/core";
import { generateId, VALID_TRANSITIONS } from "@eigengrid/core";
import type { EigenGridEventBase, EigenGridEventType } from "@eigengrid/events";
import {
  buildSlurmScript,
  buildSlurmCommandScript,
  SlurmCliClient,
  isSlurmTerminal,
  mapSlurmState,
  shellQuoteWord,
  type SlurmClient,
  type SlurmSubmitOptions,
} from "@eigengrid/slurm";
import type { Runner } from "./runner";
import { basename, join } from "path";
import { existsSync, statSync } from "fs";
import { effectRequestDigest, persistEffectIntent, readEffectIntent } from "./effect-intent";
import {
  atomicCopyRunnerFile,
  assertRegularRunnerFile,
  atomicWriteRunnerFile,
  ensurePrivateRunnerDirectory,
} from "./safe-path";

// ────────────────────────────────────────────────────────────
// SlurmRunnerConfig
// ────────────────────────────────────────────────────────────

export interface SlurmRunnerConfig {
  partition?: string;
  account?: string;
  qos?: string;
  time?: string;
  nodes?: number;
  ntasks?: number;
  mem?: string;
  memPerCpu?: string;
  sbatchPath?: string;
  sacctPath?: string;
  scancelPath?: string;
  /** Rendered recipe command to persist on the attempt and submit. */
  command?: string;
  /** Structured executable identity used to render an injection-safe command. */
  commandProgram?: string;
  commandArgs?: string[];
  /** Slurm CPU count requested by the selected recipe/CLI. */
  cpusPerTask?: number;
  /** Injectable script builder for callers and deterministic tests. */
  scriptBuilder?: (command: string, options: SlurmSubmitOptions) => string;
  /** Optional location for the durable pre-effect intent record. */
  intentPath?: string;
  /** Test-only switch to replay the historical event-ordering defect. */
  legacyLifecycleForCharacterization?: boolean;
}

type SlurmExternalMetadata = {
  backend?: string;
  externalJobId?: string;
  externalState?: string;
  lastSyncAt?: number;
  nativeDetail?: string;
  nodeName?: string;
};

type SlurmEventType = Extract<EigenGridEventType, `slurm.${string}`>;

function assertSafeJobId(jobId: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(jobId)) {
    throw new Error(`Unsafe job identifier for Slurm execution: ${jobId}`);
  }
}

function assertSafeExternalJobId(externalJobId: string): void {
  if (!/^[0-9][A-Za-z0-9_.:+-]{0,127}$/u.test(externalJobId)) {
    throw new Error("Unsafe Slurm job identity");
  }
}

// ────────────────────────────────────────────────────────────
// Database Interface
// ────────────────────────────────────────────────────────────

interface SlurmRunnerDatabase {
  createJobAttempt(attempt: {
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
  }): Promise<void>;
  updateJobStatus(jobId: string, status: Job["status"]): Promise<void>;
  updateJobExternalMetadata?(jobId: string, metadata: SlurmExternalMetadata): Promise<void>;
  getJob(jobId: string): Promise<{
    externalJobId: string | null;
    external_job_id?: string | null;
  } | null>;
  appendEvent?(event: EigenGridEventBase): Promise<void>;
  listJobEvents?(
    jobId: string,
  ): Promise<
    Array<{ type: string; attemptId?: string | null; payload?: Record<string, unknown> | null }>
  >;
  updateJobAttemptStatus(
    attemptId: string,
    status: JobAttempt["status"],
    updates?: { pid?: number; startedAt?: number; exitCode?: number; finishedAt?: number },
  ): Promise<void>;
  listJobAttempts(jobId?: string): Promise<JobAttempt[]>;
  createArtifact(artifact: Omit<Artifact, "createdAt">): Promise<void>;
  listArtifacts(jobId?: string): Promise<Artifact[]>;
}

function readExternalJobId(job: Job | Record<string, unknown>): string | undefined {
  return String((job as any).externalJobId ?? (job as any).external_job_id ?? "") || undefined;
}

function toRemoteStatus(state: string): RemoteProcessStatus["status"] {
  switch (state) {
    case "COMPLETED":
      return "completed";
    case "CANCELLED":
      return "stopped";
    case "FAILED":
    case "TIMEOUT":
    case "NODE_FAIL":
    case "PREEMPTED":
    case "BOOT_FAIL":
    case "OUT_OF_MEMORY":
    case "DEADLINE":
    case "SPECIAL_EXIT":
    case "REVOKED":
      return "failed";
    case "PENDING":
    case "RUNNING":
    case "COMPLETING":
    case "CONFIGURING":
    case "SIGNALING":
    case "STAGE_OUT":
    case "STOPPED":
    case "REQUEUED":
    case "RESIZING":
    case "SUSPENDED":
    case "RESV_DEL_HOLD":
    case "REQUEUE_HOLD":
    case "REQUEUE_FED":
      return "running";
    default:
      return "unknown";
  }
}

function toPersistableJobStatus(status: string): Job["status"] | undefined {
  switch (status) {
    case "created":
    case "queued":
    case "staged":
    case "running":
    case "completed":
    case "failed":
    case "cancelled":
    case "parsed":
      return status;
    default:
      return undefined;
  }
}

const VALID_ATTEMPT_TRANSITIONS: Readonly<
  Record<JobAttempt["status"], readonly JobAttempt["status"][]>
> = {
  created: ["queued", "failed"],
  queued: ["staged", "failed", "cancelled"],
  staged: ["running", "failed", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

function findTransitionPath<T extends string>(
  from: T,
  to: T,
  transitions: Readonly<Record<T, readonly T[]>>,
): T[] | undefined {
  if (from === to) return [];
  const queue: Array<{ state: T; path: T[] }> = [{ state: from, path: [] }];
  const visited = new Set<T>([from]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of transitions[current.state]) {
      if (visited.has(next)) continue;
      const path = [...current.path, next];
      if (next === to) return path;
      visited.add(next);
      queue.push({ state: next, path });
    }
  }
  return undefined;
}

function buildCommand(job: Job): string {
  const inputName = basename(job.inputPath);
  const outputName = job.outputPath
    ? basename(job.outputPath)
    : `${inputName.replace(/\.[^.]+$/, "")}.log`;
  return `${shellQuoteWord(job.software)} ${shellQuoteWord(inputName)} > ${shellQuoteWord(outputName)}`;
}

function buildStructuredCommand(program: string, args: readonly string[]): string {
  return [program, ...args].map(shellQuoteWord).join(" ");
}

function buildSubmitOptions(
  config: SlurmRunnerConfig,
  job: Job,
  jobDir: string,
): SlurmSubmitOptions {
  return {
    jobName: job.name,
    partition: config.partition,
    account: config.account,
    qos: config.qos,
    time: config.time,
    cpusPerTask: config.cpusPerTask ?? 1,
    mem: config.mem,
    nodes: config.nodes,
    ntasks: config.ntasks,
    output: join(jobDir, "slurm-%j.out"),
    error: join(jobDir, "slurm-%j.err"),
    chdir: jobDir,
  };
}

// ────────────────────────────────────────────────────────────
// SlurmRunner
// ────────────────────────────────────────────────────────────

export class SlurmRunner implements Runner {
  readonly kind = "slurm" as const;

  constructor(
    private readonly config: SlurmRunnerConfig = {},
    private readonly database?: SlurmRunnerDatabase,
    private readonly slurmClient: SlurmClient = new SlurmCliClient(),
  ) {}

  private get db(): SlurmRunnerDatabase {
    if (!this.database) throw new Error("SlurmRunner requires a database instance");
    return this.database;
  }

  private jobDir(job: Job): string {
    assertSafeJobId(job.id);
    return join(job.workdir, job.id);
  }

  private async registerArtifactOnce(artifact: Omit<Artifact, "createdAt">): Promise<boolean> {
    const artifacts = await this.db.listArtifacts(artifact.jobId);
    if (artifacts.some((entry) => entry.kind === artifact.kind && entry.path === artifact.path))
      return false;
    await this.db.createArtifact(artifact);
    return true;
  }

  private async emitSlurmEvent(input: {
    type: SlurmEventType;
    jobId: string;
    payload?: Record<string, unknown>;
    attemptId?: string;
    artifactId?: string;
  }): Promise<void> {
    if (!this.db.appendEvent) return;

    const at = Date.now();
    await this.db.appendEvent({
      id: generateId("evt"),
      type: input.type,
      at,
      source: "runner",
      jobId: input.jobId,
      attemptId: input.attemptId,
      artifactId: input.artifactId,
      payload: {
        backend: "slurm",
        ...input.payload,
      },
    });
  }

  private async emitArtifactRegistered(
    job: Job,
    artifact: Omit<Artifact, "createdAt">,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await this.emitSlurmEvent({
      type: "slurm.artifact.registered",
      jobId: job.id,
      attemptId: artifact.attemptId,
      artifactId: artifact.id,
      payload: {
        kind: artifact.kind,
        path: artifact.path,
        label: artifact.label,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        ...payload,
      },
    });
  }

  private async emitJobFailed(job: Job, payload: Record<string, unknown>): Promise<void> {
    await this.emitSlurmEvent({
      type: "slurm.job.failed",
      jobId: job.id,
      payload,
    });
  }

  private async resolveExternalJobId(job: Job): Promise<string | undefined> {
    const validate = (value: string | undefined): string | undefined => {
      if (value) assertSafeExternalJobId(value);
      return value;
    };
    const direct = readExternalJobId(job);
    if (direct) return validate(direct);

    const persisted = await this.db.getJob(job.id);
    const persistedId = persisted ? readExternalJobId(persisted) : undefined;
    if (persistedId) return validate(persistedId);
    const intent = readEffectIntent(
      this.config.intentPath ?? join(this.jobDir(job), "effect-intent.json"),
    );
    return validate(intent?.externalId);
  }

  private async updateExternalMetadata(
    jobId: string,
    metadata: SlurmExternalMetadata,
  ): Promise<void> {
    await this.db.updateJobExternalMetadata?.(jobId, metadata);
  }

  private async advanceJobStatus(
    jobId: string,
    current: JobStatus,
    target: JobStatus,
  ): Promise<void> {
    const path = findTransitionPath(current, target, VALID_TRANSITIONS);
    if (path === undefined) {
      // An observation can legitimately lag a more advanced durable state;
      // never regress it merely because squeue/sacct returned stale data.
      if (
        (current === "staged" && target === "queued") ||
        (current === "running" && (target === "queued" || target === "staged")) ||
        (current === "completed" && target !== "parsed") ||
        current === "parsed" ||
        current === "failed" ||
        current === "cancelled"
      )
        return;
      throw new Error(`Cannot project Slurm observation ${current} -> ${target}`);
    }
    for (const next of path) await this.db.updateJobStatus(jobId, next);
  }

  private async advanceAttemptStatus(
    attempt: JobAttempt,
    target: JobAttempt["status"],
  ): Promise<void> {
    const path = findTransitionPath(attempt.status, target, VALID_ATTEMPT_TRANSITIONS);
    if (path === undefined) {
      if (
        ((attempt.status === "staged" || attempt.status === "running") && target === "queued") ||
        (attempt.status === "running" && target === "staged") ||
        attempt.status === "completed" ||
        attempt.status === "failed" ||
        attempt.status === "cancelled"
      )
        return;
      throw new Error(`Cannot project Slurm attempt observation ${attempt.status} -> ${target}`);
    }
    let current = attempt.status;
    for (const next of path) {
      await this.db.updateJobAttemptStatus(attempt.id, next);
      current = next;
    }
    // Keep the in-memory snapshot coherent for callers that inspect it after
    // a multi-step projection; no external authority is inferred from this.
    attempt.status = current;
  }

  async stage(job: Job): Promise<RunnerResult> {
    const dir = this.jobDir(job);

    ensurePrivateRunnerDirectory(dir);
    const existingAttempts = await this.db.listJobAttempts(job.id);
    const latestAttempt = existingAttempts.at(-1);
    const existingExternalId = readExternalJobId(job);
    if (
      existingExternalId ||
      (latestAttempt && ["created", "queued", "staged", "running"].includes(latestAttempt.status))
    ) {
      if (latestAttempt && latestAttempt.runner !== "slurm") {
        return {
          ok: false,
          failureDisposition: "termination-unknown",
          message: `Job already has an active ${latestAttempt.runner} attempt; refusing Slurm replacement stage`,
        };
      }
      const intentPath = this.config.intentPath ?? join(dir, "effect-intent.json");
      const existingIntent = readEffectIntent(intentPath);
      if (
        existingIntent?.backend === "slurm" &&
        existingIntent.externalId &&
        (existingIntent.state === "submitted" || existingIntent.state === "confirmed")
      ) {
        return {
          ok: true,
          message: `SLURM job ${existingIntent.externalId} is already durably staged`,
          metadata: { attemptId: latestAttempt?.id, externalJobId: existingIntent.externalId },
        };
      }
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message:
          "Slurm stage has a prior effect or active attempt without a confirmed identity; reconcile before retrying",
      };
    }
    const attemptId = generateId("attempt");

    await this.db.updateJobStatus(job.id, "queued");
    await this.db.createJobAttempt({
      id: attemptId,
      jobId: job.id,
      runner: "slurm",
      command: this.config.command ?? "",
      cwd: dir,
    });
    // Attempt lifecycle mirrors the aggregate: created -> queued -> staged.
    // The previous direct created -> staged write violated the durable reducer
    // and caused real SQLite/PostgreSQL staging failures.
    if (!this.config.legacyLifecycleForCharacterization) {
      await this.db.updateJobAttemptStatus(attemptId, "queued");
    }

    const stagedInput = join(dir, basename(job.inputPath));
    assertRegularRunnerFile(stagedInput, "Slurm staged input target");
    atomicCopyRunnerFile(job.inputPath, stagedInput);

    const stagedInputArtifact: Omit<Artifact, "createdAt"> = {
      id: generateId("artifact"),
      jobId: job.id,
      attemptId,
      kind: "input",
      path: stagedInput,
      mimeType: "text/plain",
      sizeBytes: statSync(stagedInput).size,
    };
    if (await this.registerArtifactOnce(stagedInputArtifact)) {
      await this.emitArtifactRegistered(job, stagedInputArtifact, {
        workdir: dir,
        registeredAt: Date.now(),
      });
    }

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

    const command = this.config.commandProgram
      ? buildStructuredCommand(this.config.commandProgram, this.config.commandArgs ?? [])
      : (this.config.command ?? buildCommand(job));
    const scriptPath = join(dir, "submit.slurm");
    const submitOptions = buildSubmitOptions(this.config, job, dir);
    let script = this.config.scriptBuilder
      ? this.config.scriptBuilder(command, submitOptions)
      : this.config.commandProgram
        ? buildSlurmCommandScript(
            { executable: this.config.commandProgram, argv: this.config.commandArgs ?? [] },
            submitOptions,
          )
        : buildSlurmScript(command, submitOptions);

    if (this.config.memPerCpu) {
      script = script.replace(
        "#SBATCH --cpus-per-task=1\n",
        `#SBATCH --cpus-per-task=1\n#SBATCH --mem-per-cpu=${this.config.memPerCpu}\n`,
      );
    }

    ensurePrivateRunnerDirectory(dir);
    atomicWriteRunnerFile(scriptPath, script);

    const scriptArtifact: Omit<Artifact, "createdAt"> = {
      id: generateId("artifact"),
      jobId: job.id,
      attemptId: attempt.id,
      kind: "input",
      path: scriptPath,
      label: "slurm script",
      mimeType: "text/plain",
      sizeBytes: statSync(scriptPath).size,
    };
    if (await this.registerArtifactOnce(scriptArtifact)) {
      await this.emitArtifactRegistered(job, scriptArtifact, {
        scriptPath,
        workdir: dir,
        command,
        registeredAt: Date.now(),
      });
    }

    const intentPath = this.config.intentPath ?? join(dir, "effect-intent.json");
    const operationId = `slurm-${job.id}-${attempt.id}`;
    const intentBase = {
      schema: "eigengrid.effect-intent.v1" as const,
      operationId,
      jobId: job.id,
      attemptId: attempt.id,
      backend: "slurm" as const,
      requestDigest: effectRequestDigest({ jobId: job.id, attemptId: attempt.id, script }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const previousIntent = readEffectIntent(intentPath);
    if (previousIntent) {
      if (previousIntent.requestDigest !== intentBase.requestDigest) {
        return {
          ok: false,
          message: "SLURM dispatch request conflicts with the durable effect intent",
        };
      }
      if (previousIntent.state === "submitted" || previousIntent.state === "confirmed") {
        return {
          ok: true,
          command: previousIntent.externalId
            ? `Submitted batch job ${previousIntent.externalId}`
            : undefined,
          message: `SLURM job ${previousIntent.externalId ?? "already submitted"} is already durable`,
        };
      }
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message: `SLURM dispatch has durable intent state ${previousIntent.state}; reconcile before retrying`,
      };
    }
    // Intent is durably recorded before sbatch. A timeout or process crash
    // therefore leaves an AMBIGUOUS record for reconciliation instead of
    // silently retrying a possibly accepted scheduler submission.
    persistEffectIntent(intentPath, { ...intentBase, state: "intent_persisted" });

    let submitResult: Awaited<ReturnType<SlurmClient["submitJob"]>>;
    try {
      submitResult = await this.slurmClient.submitJob(scriptPath, submitOptions);
    } catch (error) {
      persistEffectIntent(intentPath, {
        ...intentBase,
        state: "ambiguous",
        updatedAt: new Date().toISOString(),
      });
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message: `sbatch outcome is ambiguous: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!submitResult.success) {
      if (submitResult.ambiguous) {
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
          message: `sbatch outcome is ambiguous: ${submitResult.error ?? "scheduler transport timed out"}`,
        };
      }
      const resolvedExternalJobId = await this.resolveExternalJobId(job);
      const finishedAt = Date.now();
      await this.db.updateJobAttemptStatus(attempt.id, "failed", { finishedAt });
      await this.db.updateJobStatus(job.id, "failed");
      await this.emitJobFailed(job, {
        action: "submit",
        externalJobId: resolvedExternalJobId,
        slurmJobId: resolvedExternalJobId,
        scriptPath,
        workdir: dir,
        command,
        failedAt: finishedAt,
        error: submitResult.error ?? "unknown error",
      });
      persistEffectIntent(intentPath, {
        ...intentBase,
        state: "failed",
        updatedAt: new Date().toISOString(),
      });
      return { ok: false, message: `sbatch failed: ${submitResult.error ?? "unknown error"}` };
    }

    try {
      assertSafeExternalJobId(submitResult.slurmJobId);
    } catch (error) {
      persistEffectIntent(intentPath, {
        ...intentBase,
        state: "ambiguous",
        updatedAt: new Date().toISOString(),
      });
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message: `sbatch returned an invalid external job identity; outcome is ambiguous: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    persistEffectIntent(intentPath, {
      ...intentBase,
      state: "submitted",
      externalId: submitResult.slurmJobId,
      updatedAt: new Date().toISOString(),
    });

    await this.updateExternalMetadata(job.id, {
      backend: "slurm",
      externalJobId: submitResult.slurmJobId,
      externalState: "PENDING",
      lastSyncAt: Date.now(),
      nativeDetail: JSON.stringify({ scriptPath, runner: "slurm" }),
    });

    await this.db.updateJobAttemptStatus(attempt.id, "running", {
      startedAt: Date.now(),
    });
    await this.db.updateJobStatus(job.id, "running");

    await this.emitSlurmEvent({
      type: "slurm.job.submitted",
      jobId: job.id,
      attemptId: attempt.id,
      payload: {
        externalJobId: submitResult.slurmJobId,
        slurmJobId: submitResult.slurmJobId,
        scriptPath,
        workdir: dir,
        command,
        externalState: "PENDING",
        eigengridStatus: "running",
        submittedAt: Date.now(),
      },
    });

    return {
      ok: true,
      command: `Submitted batch job ${submitResult.slurmJobId}`,
      message: `Submitted as SLURM job ${submitResult.slurmJobId}`,
    };
  }

  async status(job: Job): Promise<RemoteProcessStatus> {
    const externalJobId = await this.resolveExternalJobId(job);
    if (!externalJobId) {
      return { status: "unknown", message: "No SLURM job ID available for this job" };
    }

    const attempts = await this.db.listJobAttempts(job.id);
    const attempt = attempts[attempts.length - 1];

    const status = await this.slurmClient.getJobStatus(externalJobId);
    const mappedStatus = mapSlurmState(status.state);
    const syncedAt = Date.now();

    await this.updateExternalMetadata(job.id, {
      backend: "slurm",
      externalJobId,
      externalState: status.state,
      lastSyncAt: syncedAt,
      nodeName: status.nodeName,
    });

    const nextStatus = toPersistableJobStatus(mappedStatus);
    const currentStatus = job.status as JobStatus;
    if (nextStatus) {
      try {
        await this.advanceJobStatus(job.id, currentStatus, nextStatus);
        if (attempt && nextStatus !== "queued" && nextStatus !== "staged") {
          await this.advanceAttemptStatus(
            attempt,
            nextStatus === "cancelled"
              ? "cancelled"
              : nextStatus === "completed"
                ? "completed"
                : nextStatus === "failed"
                  ? "failed"
                  : nextStatus === "running"
                    ? "running"
                    : attempt.status,
          );
        }
      } catch (error) {
        return {
          status: "unknown",
          message: `SLURM state ${status.state} observed but durable projection failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    await this.emitSlurmEvent({
      type: "slurm.job.status.synced",
      jobId: job.id,
      attemptId: attempt?.id,
      payload: {
        externalJobId,
        slurmJobId: externalJobId,
        externalState: status.state,
        eigengridStatus: mappedStatus,
        nodeName: status.nodeName,
        exitCode: status.exitCode,
        command: attempt?.command,
        syncedAt,
      },
    });

    if (mappedStatus === "failed" && isSlurmTerminal(status.state)) {
      let failedEventAlreadyExists = false;
      if (this.db.listJobEvents) {
        try {
          const events = await this.db.listJobEvents(job.id);
          failedEventAlreadyExists = events.some(
            (event) =>
              event.type === "slurm.job.failed" &&
              (event.attemptId ?? null) === (attempt?.id ?? null) &&
              event.payload?.externalJobId === externalJobId,
          );
        } catch (error) {
          return {
            status: "unknown",
            message: `SLURM failure observation is durable but event deduplication failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      if (!failedEventAlreadyExists) {
        await this.emitSlurmEvent({
          type: "slurm.job.failed",
          jobId: job.id,
          attemptId: attempt?.id,
          payload: {
            externalJobId,
            slurmJobId: externalJobId,
            externalState: status.state,
            eigengridStatus: mappedStatus,
            nodeName: status.nodeName,
            exitCode: status.exitCode,
            command: attempt?.command,
            failedAt: syncedAt,
          },
        });
      }
    }

    const accounting = await this.slurmClient.getAccounting(externalJobId).catch(() => null);
    if (accounting) {
      await this.emitSlurmEvent({
        type: "slurm.accounting.synced",
        jobId: job.id,
        attemptId: attempt?.id,
        payload: {
          externalJobId: accounting.slurmJobId,
          slurmJobId: accounting.slurmJobId,
          externalState: accounting.state,
          exitCode: accounting.exitCode,
          elapsed: accounting.elapsed,
          maxRss: accounting.maxRss,
          reqMem: accounting.reqMem,
          nNodes: accounting.nNodes,
          nCpus: accounting.nCpus,
          accountingSyncedAt: Date.now(),
        },
      });
    }

    return {
      status: toRemoteStatus(status.state),
      exitCode: status.exitCode,
      message: `SLURM state: ${status.state}`,
    };
  }

  async stop(job: Job): Promise<RunnerResult> {
    const externalJobId = await this.resolveExternalJobId(job);
    if (!externalJobId) {
      return { ok: false, message: "No SLURM job ID available for this job" };
    }

    const attempts = await this.db.listJobAttempts(job.id);
    const attempt = attempts.at(-1);
    const intentPath = this.config.intentPath ?? join(this.jobDir(job), "effect-intent.json");
    let intent = readEffectIntent(intentPath);
    if (!intent) {
      const now = new Date().toISOString();
      intent = {
        schema: "eigengrid.effect-intent.v1",
        operationId: `slurm-cancel-${job.id}-${attempt?.id ?? "unknown"}`,
        jobId: job.id,
        attemptId: attempt?.id ?? "unknown",
        backend: "slurm",
        state: "intent_persisted",
        requestDigest: effectRequestDigest({ action: "cancel", jobId: job.id, externalJobId }),
        createdAt: now,
        updatedAt: now,
      };
      persistEffectIntent(intentPath, intent);
      persistEffectIntent(intentPath, {
        ...intent,
        state: "submitted",
        externalId: externalJobId,
        updatedAt: new Date().toISOString(),
      });
      intent = readEffectIntent(intentPath)!;
    }
    if (intent.externalId && intent.externalId !== externalJobId) {
      return { ok: false, message: "SLURM cancellation identity conflicts with durable intent" };
    }
    if (intent.state === "cancelled") {
      try {
        if (attempt) await this.advanceAttemptStatus(attempt, "cancelled");
        await this.advanceJobStatus(job.id, job.status as JobStatus, "cancelled");
        return { ok: true, message: `SLURM job ${externalJobId} was already cancelled` };
      } catch (error) {
        return {
          ok: false,
          message: `SLURM cancellation was already confirmed but local reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    try {
      persistEffectIntent(intentPath, {
        ...intent,
        state: "cancel_requested",
        updatedAt: new Date().toISOString(),
      });
      intent = { ...intent, state: "cancel_requested", updatedAt: new Date().toISOString() };
    } catch (error) {
      return {
        ok: false,
        message: `SLURM cancellation intent could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    let result: Awaited<ReturnType<SlurmClient["cancelJob"]>>;
    try {
      result = await this.slurmClient.cancelJob(externalJobId);
    } catch (error) {
      try {
        persistEffectIntent(intentPath, {
          ...intent,
          state: "ambiguous",
          updatedAt: new Date().toISOString(),
        });
      } catch {
        // The thrown transport error remains the primary outcome; the next
        // reconciliation call will fail closed if the intent is unreadable.
      }
      return {
        ok: false,
        message: `scancel outcome is ambiguous: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!result.success) {
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
        message: `scancel failed${result.ambiguous ? " with ambiguous outcome" : ""}: ${result.error ?? "unknown error"}`,
      };
    }

    let observed: Awaited<ReturnType<SlurmClient["getJobStatus"]>>;
    try {
      observed = await this.slurmClient.getJobStatus(externalJobId);
    } catch (error) {
      persistEffectIntent(intentPath, {
        ...intent,
        state: "ambiguous",
        updatedAt: new Date().toISOString(),
      });
      return {
        ok: false,
        message: `scancel was accepted but cancellation outcome is ambiguous: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (observed.state !== "CANCELLED") {
      await this.updateExternalMetadata(job.id, {
        backend: "slurm",
        externalJobId,
        externalState: observed.state,
        lastSyncAt: Date.now(),
      });
      if (isSlurmTerminal(observed.state)) {
        try {
          const projected = toPersistableJobStatus(mapSlurmState(observed.state));
          if (projected) await this.advanceJobStatus(job.id, job.status as JobStatus, projected);
          if (attempt && projected) {
            const attemptTarget =
              projected === "completed"
                ? "completed"
                : projected === "failed"
                  ? "failed"
                  : attempt.status;
            if (attemptTarget !== attempt.status)
              await this.advanceAttemptStatus(attempt, attemptTarget);
          }
          persistEffectIntent(intentPath, {
            ...intent,
            state: "confirmed",
            externalId: externalJobId,
            updatedAt: new Date().toISOString(),
          });
        } catch (error) {
          return {
            ok: false,
            message: `scancel raced with terminal state ${observed.state}, but durable projection failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        return {
          ok: false,
          message: `SLURM job ${externalJobId} reached ${observed.state} before cancellation was confirmed`,
        };
      }
      return {
        ok: false,
        message: `scancel was accepted; SLURM still reports ${observed.state}. Cancellation remains pending reconciliation`,
      };
    }

    await this.updateExternalMetadata(job.id, {
      backend: "slurm",
      externalJobId,
      externalState: "CANCELLED",
      lastSyncAt: Date.now(),
    });

    try {
      if (attempt) await this.advanceAttemptStatus(attempt, "cancelled");
      await this.advanceJobStatus(job.id, job.status as JobStatus, "cancelled");
      persistEffectIntent(intentPath, {
        ...intent,
        state: "cancelled",
        externalId: externalJobId,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      return {
        ok: false,
        message: `SLURM cancellation was confirmed externally but local durability failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    await this.emitSlurmEvent({
      type: "slurm.job.cancelled",
      jobId: job.id,
      attemptId: attempt?.id,
      payload: {
        externalJobId,
        slurmJobId: externalJobId,
        externalState: "CANCELLED",
        eigengridStatus: "cancelled",
        cancelledAt: Date.now(),
      },
    });

    return {
      ok: true,
      message: `Cancelled SLURM job ${externalJobId}`,
    };
  }

  async fetch(job: Job): Promise<RunnerResult> {
    const dir = this.jobDir(job);
    const attempts = await this.db.listJobAttempts(job.id);
    const attempt = attempts[attempts.length - 1];
    const attemptId = attempt?.id ?? "unknown";
    const externalJobId = await this.resolveExternalJobId(job);

    const filesToPull = ["stdout.log", "stderr.log", "exit.status"];
    if (externalJobId) {
      filesToPull.push(`slurm-${externalJobId}.out`, `slurm-${externalJobId}.err`);
    }

    let foundArtifacts = 0;
    for (const file of filesToPull) {
      const filePath = join(dir, file);
      if (existsSync(filePath)) {
        assertRegularRunnerFile(filePath, "Slurm fetched artifact target");
        const artifact: Omit<Artifact, "createdAt"> = {
          id: generateId("artifact"),
          jobId: job.id,
          attemptId,
          kind: "log",
          path: filePath,
          label: file,
          mimeType: "text/plain",
          sizeBytes: statSync(filePath).size,
        };
        if (await this.registerArtifactOnce(artifact)) {
          await this.emitArtifactRegistered(job, artifact, {
            workdir: dir,
            externalJobId,
            command: attempt?.command,
            registeredAt: Date.now(),
          });
        }
        foundArtifacts++;
      }
    }

    if (job.outputPath) {
      const outputPath = join(dir, basename(job.outputPath));
      if (existsSync(outputPath)) {
        assertRegularRunnerFile(outputPath, "Slurm fetched output target");
        const artifact: Omit<Artifact, "createdAt"> = {
          id: generateId("artifact"),
          jobId: job.id,
          attemptId,
          kind: "output",
          path: outputPath,
          mimeType: "text/plain",
          sizeBytes: statSync(outputPath).size,
        };
        if (await this.registerArtifactOnce(artifact)) {
          await this.emitArtifactRegistered(job, artifact, {
            workdir: dir,
            externalJobId,
            command: attempt?.command,
            registeredAt: Date.now(),
          });
        }
        foundArtifacts++;
      }
    }

    if (foundArtifacts === 0) {
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message: `SLURM artifact collection found no regular artifacts in ${dir}`,
      };
    }
    return { ok: true, message: `Fetched artifacts from ${dir}` };
  }
}
