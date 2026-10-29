// ────────────────────────────────────────────────────────────
// ExecutionCoordinator — canonical local lifecycle orchestrator
// ────────────────────────────────────────────────────────────
// Typed, injectable service that owns the full local execution
// lifecycle. Extended with WU-04 operations:
//   reconcileLocal — verifies durable truth from receipts/identity
//   cancelLocal    — idempotent safe cancellation via atomic DB evidence
//   collectLocal   — reconstructs paths from persisted state
//   parseJob       — coordinator-owned job-aware parse
//
// The DB terminal materializer owns cancellation events; the coordinator owns
// parse events and returns typed lifecycle outcomes.
// ────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
  createReadStream,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Config, Job, RunnerResult, StartedProcess } from "@eigengrid/core";
import type { ParseResult } from "@eigengrid/core";
import type { DatabaseLike, JobRecord } from "@eigengrid/db";
import type { EigenGridEventBase } from "@eigengrid/events";
import type { Recipe, RecipeRunnerKind, RenderedRecipePlan } from "@eigengrid/recipes";
import { findRunnableRecipe, renderRecipePlan, validateRecipe } from "@eigengrid/recipes";
import {
  ensurePrivateRunnerDirectory,
  type CommandExecutor,
  type LocalReceipt,
  type Runner,
} from "@eigengrid/runners";
import type { RecipeRegistry } from "../composition/types";
import { validateSubmissionInput, type LocalExecutionPlan } from "./submit-service";

// ── Parser interface ────────────────────────────────────────

export interface ParserBridge {
  parse(software: string, outputPath: string): Promise<ParseResult>;
}

// ── Typed Request / Outcome ─────────────────────────────────

export interface LocalExecutionRequest {
  software: string;
  inputPath: string;
  name?: string;
  recipeId?: string;
  projectId?: string;
  /** Stable effect identity allocated before calling the coordinator. */
  intendedJobId?: string;
  /** Stable attempt identity paired with intendedJobId. */
  intendedAttemptId?: string;
  /** Digest of the bytes that must have been staged before the process may start. */
  expectedInputDigest?: string;
}

export type LocalExecutionOutcome =
  | {
      ok: true;
      jobId: string;
      attemptId: string;
      pid?: number;
      command?: string;
      replayed?: boolean;
      status?: "running" | "completed" | "failed" | "cancelled";
    }
  | {
      ok: false;
      jobId?: string;
      attemptId?: string;
      status?: "safely-unknown";
      message: string;
    };

export type ReconcileLocalOutcome =
  | {
      status: "running" | "completed" | "failed" | "cancelled";
      jobId: string;
      attemptId: string;
      receipt?: LocalReceipt;
      exitCode?: number;
      message: string;
    }
  | {
      status: "safely-unknown";
      jobId: string;
      attemptId?: string;
      message: string;
    };

export type CancelLocalOutcome =
  | {
      ok: true;
      jobId: string;
      attemptId: string;
      transitioned: boolean;
      receipt: LocalReceipt;
      message: string;
    }
  | {
      ok: false;
      jobId: string;
      attemptId?: string;
      message: string;
    };

export type CancelPendingOutcome =
  | { ok: true; jobId: string; attemptId?: string; previousStatus: string; message: string }
  | { ok: false; jobId: string; attemptId?: string; message: string };

export type CollectLocalOutcome =
  | { ok: true; jobId: string; attemptId: string; artifacts: string[]; message: string }
  | { ok: false; jobId: string; attemptId: string; artifacts: string[]; message: string };

export type ParseLocalOutcome =
  | {
      ok: true;
      jobId: string;
      attemptId: string;
      resultId: string;
      parser: string;
      message: string;
    }
  | {
      ok: false;
      jobId: string;
      attemptId?: string;
      resultId?: string;
      parser?: string;
      message: string;
    };

// ── Local Execution Backend ─────────────────────────────────

export interface LocalExecutionBackend {
  stageAttempt(job: Job, attemptId: string): Promise<RunnerResult>;
  startAttempt(job: Job, attemptId: string): Promise<StartedProcess>;
  reconcileAttempt(
    job: Job,
    attemptId: string,
  ): Promise<{
    status: "running" | "completed" | "failed" | "cancelled" | "safely-unknown";
    receipt?: LocalReceipt;
    exitCode?: number;
    message: string;
  }>;
  cancelAttempt(
    job: Job,
    attemptId: string,
  ): Promise<
    | { ok: true; transitioned: boolean; receipt: LocalReceipt; message: string }
    | { ok: false; message: string }
  >;
  collectAttempt(
    job: Job,
    attemptId: string,
    options?: { requiredOutput?: boolean },
  ): Promise<
    | { ok: true; artifacts: string[]; message: string }
    | { ok: false; artifacts: string[]; message: string }
  >;
}

export type LocalExecutionBackendFactory = (
  plan: LocalExecutionPlan,
  db: DatabaseLike,
  executor?: CommandExecutor,
) => LocalExecutionBackend;

/**
 * Provider-neutral remote backend contract. Transport details stay in the
 * runner, but every effectful operation enters through the coordinator.
 */
export type RemoteExecutionBackend = Runner;

export type RemoteExecutionOutcome =
  | { ok: true; jobId: string; message: string; status?: string }
  | { ok: false; jobId: string; message: string; status?: "safely-unknown" };

// ── ExecutionService ────────────────────────────────────────

export interface ExecutionService {
  executeLocal(request: LocalExecutionRequest): Promise<LocalExecutionOutcome>;
  dispatchExistingJob(jobId: string, attemptId: string): Promise<LocalExecutionOutcome>;
  reconcileLocal(jobId: string, attemptId?: string): Promise<ReconcileLocalOutcome>;
  cancelLocal(jobId: string): Promise<CancelLocalOutcome>;
  /** Cancel a job that has not crossed an external execution boundary. */
  cancelPending?(jobId: string, reason?: string): Promise<CancelPendingOutcome>;
  collectLocal(jobId: string): Promise<CollectLocalOutcome>;
  parseJob(jobId: string, attemptId?: string): Promise<ParseLocalOutcome>;
  dispatchRemote?(jobId: string, backend: RemoteExecutionBackend): Promise<RemoteExecutionOutcome>;
  reconcileRemote?(jobId: string, backend: RemoteExecutionBackend): Promise<RemoteExecutionOutcome>;
  cancelRemote?(jobId: string, backend: RemoteExecutionBackend): Promise<RemoteExecutionOutcome>;
  collectRemote?(jobId: string, backend: RemoteExecutionBackend): Promise<RemoteExecutionOutcome>;
}

// ── Event-helper type ───────────────────────────────────────

type EventPayload = Record<string, unknown>;

type DispatchLease = { path: string; token: string };

const SAFE_STABLE_ID = /^[A-Za-z0-9._-]{1,128}$/u;

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("dispatch lease write made no progress");
    offset += written;
  }
}

/**
 * Cross-process fence for remote dispatch. A same-job dispatch must not race
 * two stage/start sequences before either one has created a durable attempt.
 * Live owners cause a safe retry outcome; dead owners may be reclaimed, but
 * only after their PID is no longer alive and the replacement is token-fenced.
 */
function acquireDispatchLease(jobDir: string): DispatchLease | null {
  ensurePrivateRunnerDirectory(jobDir);
  const path = join(jobDir, ".dispatch.lock");

  for (;;) {
    const token = randomUUID();
    try {
      const descriptor = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        writeAll(descriptor, Buffer.from(JSON.stringify({ pid: process.pid, token }) + "\n"));
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      fsyncDirectory(jobDir);
      return { path, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid?: number; token?: string };
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error(`Execution dispatch lock is not a regular file: ${path}`);
        }
        owner = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; token?: string };
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error(
          `Execution dispatch lock is unreadable; refusing concurrent dispatch: ${readError instanceof Error ? readError.message : String(readError)}`,
        );
      }
      if (owner.pid !== undefined && processIsAlive(owner.pid)) return null;
      try {
        unlinkSync(path);
        fsyncDirectory(jobDir);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
    }
  }
}

function releaseDispatchLease(lease: DispatchLease): void {
  try {
    const stat = lstatSync(lease.path);
    if (stat.isSymbolicLink() || !stat.isFile()) return;
    const owner = JSON.parse(readFileSync(lease.path, "utf8")) as { token?: string };
    if (owner.token !== lease.token) return;
    unlinkSync(lease.path);
    fsyncDirectory(dirname(lease.path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Releasing a lease cannot safely turn a completed/ambiguous dispatch
      // into a different outcome. Leave the lock for reconciliation instead.
    }
  }
}

// ── ExecutionCoordinator ────────────────────────────────────

export interface ExecutionCoordinatorDeps {
  db: DatabaseLike;
  config: Config;
  recipes: RecipeRegistry;
  clock: () => number;
  idGenerator: (prefix: string) => string;
  executor?: CommandExecutor;
  localBackendFactory: LocalExecutionBackendFactory;
  parser?: ParserBridge;
  /** Legacy local/Runner-mutating routes are development-only, never V1 production. */
  allowLegacyExecution?: boolean;
}

export class ExecutionCoordinator implements ExecutionService {
  constructor(private readonly deps: ExecutionCoordinatorDeps) {}

  private async emit(
    type: EigenGridEventBase["type"],
    jobId: string,
    attemptId?: string,
    payload?: EventPayload,
  ): Promise<void> {
    const event: EigenGridEventBase = {
      id: this.deps.idGenerator("evt"),
      type,
      at: this.deps.clock(),
      source: "cli",
      jobId,
      attemptId,
      payload,
    };
    await this.deps.db.appendEvent(event);
  }

  private jobFromDb(raw: JobRecord): Job {
    return {
      id: raw.id,
      name: raw.name,
      software: raw.software as Job["software"],
      inputPath: raw.inputPath,
      workdir: raw.workdir ?? this.deps.config.jobsDir,
      outputPath: raw.outputPath ?? undefined,
      status: raw.status as Job["status"],
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      projectId: raw.projectId ?? undefined,
      backend: raw.backend ?? undefined,
    };
  }

  private async resolveJobAndAttempt(
    jobIdArg: string,
    attemptId?: string,
  ): Promise<
    | { ok: true; job: Job; resolvedId: string; attempt: { id: string } }
    | { ok: false; message: string }
  > {
    let resolvedId: string;
    try {
      resolvedId = await this.deps.db.resolveJobId(jobIdArg);
    } catch {
      return { ok: false, message: `Job not found: ${jobIdArg}` };
    }
    const raw = await this.deps.db.getJob(resolvedId);
    if (!raw) return { ok: false, message: `Job not found: ${resolvedId}` };
    const job = this.jobFromDb(raw);

    const attempts = await this.deps.db.listJobAttempts(resolvedId);
    const selected = attemptId
      ? attempts.find((candidate) => candidate.id === attemptId)
      : attempts[attempts.length - 1];
    if (!selected) {
      return {
        ok: false,
        message: attemptId
          ? `Attempt ${attemptId} not found for job ${resolvedId}`
          : `No attempts found for job ${resolvedId}`,
      };
    }
    return { ok: true, job, resolvedId, attempt: selected };
  }

  private buildBackendForJob(job: Job): LocalExecutionBackend {
    return this.deps.localBackendFactory(
      { command: "", program: "", args: [], job },
      this.deps.db,
      this.deps.executor,
    );
  }

  private async resolveJobOnly(
    jobIdArg: string,
  ): Promise<
    | { ok: true; resolvedId: string; job: Job & Record<string, unknown> }
    | { ok: false; resolvedId: string; message: string }
  > {
    let resolvedId: string;
    try {
      resolvedId = await this.deps.db.resolveJobId(jobIdArg);
    } catch {
      return { ok: false, resolvedId: jobIdArg, message: `Job not found: ${jobIdArg}` };
    }
    const raw = await this.deps.db.getJob(resolvedId);
    if (!raw) return { ok: false, resolvedId, message: `Job not found: ${resolvedId}` };
    // Preserve provider-specific metadata for remote adapters while still
    // normalizing the canonical Job fields.  Older runner fakes and external
    // backends may rely on fields such as externalJobId/nodeName that are not
    // part of the narrow local Job shape; dropping them at this boundary would
    // make the coordinator observably lossy.
    const preserved = {
      ...(raw as unknown as Record<string, unknown>),
      ...this.jobFromDb(raw),
    } as Job & Record<string, unknown>;
    // The legacy Slurm adapter accepted the historical snake_case alias;
    // retaining it during the migration keeps external runner contracts
    // source-compatible without making it part of the canonical domain Job.
    if (preserved.external_job_id === undefined && preserved.externalJobId !== undefined) {
      preserved.external_job_id = preserved.externalJobId;
    }
    return {
      ok: true,
      resolvedId,
      job: preserved,
    };
  }

  /**
   * Canonical remote dispatch boundary. It resolves durable state before
   * staging, then starts only through the supplied runner. A thrown start or
   * an explicitly ambiguous runner result remains safely unknown for later
   * reconciliation; it is never silently retried here.
   */
  async dispatchRemote(
    jobIdArg: string,
    backend: RemoteExecutionBackend,
  ): Promise<RemoteExecutionOutcome> {
    if (this.deps.allowLegacyExecution === false)
      return {
        ok: false,
        jobId: jobIdArg,
        message: "Legacy remote execution is disabled in production",
      };
    const resolved = await this.resolveJobOnly(jobIdArg);
    if (!resolved.ok) return { ok: false, jobId: resolved.resolvedId, message: resolved.message };
    if (backend.kind === "local") {
      return {
        ok: false,
        jobId: resolved.resolvedId,
        message: "Remote coordinator cannot dispatch a local backend",
      };
    }
    if (!SAFE_STABLE_ID.test(resolved.resolvedId)) {
      return {
        ok: false,
        jobId: resolved.resolvedId,
        status: "safely-unknown",
        message: "Remote dispatch resolved an unsafe job identity",
      };
    }
    let dispatchLease: DispatchLease | null;
    try {
      dispatchLease = acquireDispatchLease(join(resolved.job.workdir, resolved.resolvedId));
    } catch (error) {
      return {
        ok: false,
        jobId: resolved.resolvedId,
        status: "safely-unknown",
        message: `Remote dispatch lease could not be acquired: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!dispatchLease) {
      return {
        ok: false,
        jobId: resolved.resolvedId,
        status: "safely-unknown",
        message: "Another remote dispatch is in progress; reconcile before retrying",
      };
    }

    try {
      // A retry after a process restart must reconcile an existing remote
      // attempt before calling stage/start again.  Without this guard a second
      // dispatch could create a fresh attempt (and, for SSH, a second remote
      // bundle) for the same durable job.  A backend status observation is
      // allowed to project durable state; an unknown result remains explicitly
      // safely-unknown and never falls through to a replacement effect.
      const existingAttempts = await this.deps.db.listJobAttempts(resolved.resolvedId);
      const latestAttempt = existingAttempts.at(-1);
      const latestAttemptIsActive =
        latestAttempt && ["created", "queued", "staged", "running"].includes(latestAttempt.status);
      if (latestAttemptIsActive && latestAttempt.runner !== backend.kind) {
        return {
          ok: false,
          jobId: resolved.resolvedId,
          status: "safely-unknown",
          message: `Job already has an active ${latestAttempt.runner} attempt; refusing ${backend.kind} replacement dispatch`,
        };
      }
      const activeAttempt = latestAttemptIsActive && latestAttempt.runner === backend.kind;
      if (activeAttempt || resolved.job.externalJobId) {
        try {
          const observed = await backend.status(resolved.job);
          if (observed.status !== "unknown") {
            return {
              ok: true,
              jobId: resolved.resolvedId,
              status: observed.status,
              message: observed.message ?? `Remote execution is already ${observed.status}`,
            };
          }
          return {
            ok: false,
            jobId: resolved.resolvedId,
            status: "safely-unknown",
            message:
              observed.message ??
              "A prior remote attempt exists; reconcile its external identity before retrying",
          };
        } catch (error) {
          return {
            ok: false,
            jobId: resolved.resolvedId,
            status: "safely-unknown",
            message: `Existing remote attempt reconciliation threw: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }

      let staged: RunnerResult;
      try {
        staged = await backend.stage(resolved.job);
      } catch (error) {
        return {
          ok: false,
          jobId: resolved.resolvedId,
          status: "safely-unknown",
          message: `Remote stage threw: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (!staged.ok) {
        return {
          ok: false,
          jobId: resolved.resolvedId,
          ...(staged.failureDisposition === "termination-unknown"
            ? { status: "safely-unknown" as const }
            : {}),
          message: staged.message ?? "Remote stage failed",
        };
      }

      let started: StartedProcess;
      try {
        started = await backend.start(resolved.job);
      } catch (error) {
        return {
          ok: false,
          jobId: resolved.resolvedId,
          status: "safely-unknown",
          message: `Remote start threw: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (!started.ok) {
        return {
          ok: false,
          jobId: resolved.resolvedId,
          ...(started.failureDisposition === "termination-unknown"
            ? { status: "safely-unknown" as const }
            : {}),
          message: started.message ?? "Remote start failed",
        };
      }
      return {
        ok: true,
        jobId: resolved.resolvedId,
        status: "running",
        message: started.message ?? "Remote execution started",
      };
    } finally {
      releaseDispatchLease(dispatchLease);
    }
  }

  async reconcileRemote(
    jobIdArg: string,
    backend: RemoteExecutionBackend,
  ): Promise<RemoteExecutionOutcome> {
    if (this.deps.allowLegacyExecution === false)
      return {
        ok: false,
        jobId: jobIdArg,
        message: "Legacy remote state mutation is disabled in production",
      };
    const resolved = await this.resolveJobOnly(jobIdArg);
    if (!resolved.ok) return { ok: false, jobId: resolved.resolvedId, message: resolved.message };
    try {
      const result = await backend.status(resolved.job);
      if (result.status === "unknown") {
        return {
          ok: false,
          jobId: resolved.resolvedId,
          status: "safely-unknown",
          message: result.message ?? "Remote state is unknown",
        };
      }
      return {
        ok: true,
        jobId: resolved.resolvedId,
        status: result.status,
        message: result.message ?? `Remote state: ${result.status}`,
      };
    } catch (error) {
      return {
        ok: false,
        jobId: resolved.resolvedId,
        status: "safely-unknown",
        message: `Remote reconciliation threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async cancelRemote(
    jobIdArg: string,
    backend: RemoteExecutionBackend,
  ): Promise<RemoteExecutionOutcome> {
    if (this.deps.allowLegacyExecution === false)
      return {
        ok: false,
        jobId: jobIdArg,
        message: "Legacy remote cancellation is disabled in production",
      };
    const resolved = await this.resolveJobOnly(jobIdArg);
    if (!resolved.ok) return { ok: false, jobId: resolved.resolvedId, message: resolved.message };
    try {
      const result = await backend.stop(resolved.job);
      return {
        ok: result.ok,
        jobId: resolved.resolvedId,
        ...(result.failureDisposition === "termination-unknown"
          ? { status: "safely-unknown" as const }
          : {}),
        message:
          result.message ??
          (result.ok ? "Remote cancellation requested" : "Remote cancellation failed"),
      };
    } catch (error) {
      return {
        ok: false,
        jobId: resolved.resolvedId,
        status: "safely-unknown",
        message: `Remote cancellation threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async collectRemote(
    jobIdArg: string,
    backend: RemoteExecutionBackend,
  ): Promise<RemoteExecutionOutcome> {
    if (this.deps.allowLegacyExecution === false)
      return {
        ok: false,
        jobId: jobIdArg,
        message: "Legacy remote collection is disabled in production",
      };
    const resolved = await this.resolveJobOnly(jobIdArg);
    if (!resolved.ok) return { ok: false, jobId: resolved.resolvedId, message: resolved.message };
    try {
      const result = await backend.fetch(resolved.job);
      return {
        ok: result.ok,
        jobId: resolved.resolvedId,
        message:
          result.message ?? (result.ok ? "Remote artifacts collected" : "Remote collection failed"),
      };
    } catch (error) {
      return {
        ok: false,
        jobId: resolved.resolvedId,
        message: `Remote collection threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // ── Local execution ──────────────────────────────────────

  private async verifyStagedInput(
    stageResult: RunnerResult,
    expectedDigest: string,
    job: Job,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!/^[a-f0-9]{64}$/u.test(expectedDigest)) {
      return { ok: false, message: "Expected input digest is not a canonical SHA-256 digest" };
    }
    const stagedInputPath = stageResult.metadata?.inputPath;
    if (typeof stagedInputPath !== "string" || !stagedInputPath) {
      return {
        ok: false,
        message: "The local backend did not identify the staged input for digest verification",
      };
    }
    const expectedStagedPath = resolve(job.workdir, job.id, basename(job.inputPath));
    if (resolve(stagedInputPath) !== expectedStagedPath) {
      return {
        ok: false,
        message: "The local backend did not return the exact staged execution input",
      };
    }
    try {
      const hash = createHash("sha256");
      await new Promise<void>((resolvePromise, reject) => {
        const stream = createReadStream(stagedInputPath);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("error", reject);
        stream.on("end", resolvePromise);
      });
      if (hash.digest("hex") !== expectedDigest) {
        return {
          ok: false,
          message: "Staged input bytes do not match the approved input digest",
        };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: `Unable to verify staged input bytes: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async executeLocal(request: LocalExecutionRequest): Promise<LocalExecutionOutcome> {
    if (this.deps.allowLegacyExecution === false)
      return { ok: false, message: "Local scientific execution is disabled in production" };
    if ((request.intendedJobId === undefined) !== (request.intendedAttemptId === undefined)) {
      return {
        ok: false,
        message: "intendedJobId and intendedAttemptId must be supplied together",
      };
    }
    for (const [label, id] of [
      ["intendedJobId", request.intendedJobId],
      ["intendedAttemptId", request.intendedAttemptId],
    ] as const) {
      if (id !== undefined && !/^[A-Za-z0-9._-]{1,128}$/u.test(id)) {
        return { ok: false, message: `${label} is not a safe stable identifier` };
      }
    }

    const inputValidation = validateSubmissionInput(request.inputPath);
    if (!inputValidation.ok) return { ok: false, message: inputValidation.message };
    const canonicalPath = inputValidation.canonicalPath;

    const runKind: RecipeRunnerKind = "local";
    const allRecipes: readonly Recipe[] = this.deps.recipes.recipes;

    let selectedRecipe: Recipe | undefined;
    if (request.recipeId) {
      selectedRecipe = this.deps.recipes.find(request.recipeId);
      if (!selectedRecipe) return { ok: false, message: `Recipe "${request.recipeId}" not found` };
      const runnable = findRunnableRecipe(
        [...allRecipes],
        request.software,
        runKind,
        "",
        request.recipeId,
      );
      if (!runnable)
        return {
          ok: false,
          message: `Recipe "${request.recipeId}" is for ${selectedRecipe.software}, not ${request.software}`,
        };
    } else {
      selectedRecipe = findRunnableRecipe([...allRecipes], request.software, runKind, "");
    }
    if (!selectedRecipe) return { ok: false, message: `No recipe found for ${request.software}` };
    const recipeValidation = validateRecipe(selectedRecipe);
    if (!recipeValidation.valid) {
      return {
        ok: false,
        message: `Recipe "${selectedRecipe.id}" validation failed: ${recipeValidation.errors.join("; ")}`,
      };
    }

    const jobId = request.intendedJobId ?? this.deps.idGenerator("job");
    const attemptId = request.intendedAttemptId ?? this.deps.idGenerator("attempt");
    const { plan: executionPlan, recipePlan } = buildLocalExecutionPlanInternal(
      selectedRecipe,
      canonicalPath,
      jobId,
      this.deps.config.jobsDir,
      runKind,
    );

    const existingJob = await this.deps.db.getJob(jobId);
    if (existingJob) {
      if (
        existingJob.software !== request.software ||
        existingJob.inputPath !== canonicalPath ||
        existingJob.workdir !== this.deps.config.jobsDir
      ) {
        return {
          ok: false,
          jobId,
          attemptId,
          message: `Stable job identity ${jobId} is already bound to different execution content`,
        };
      }
      const attempts = await this.deps.db.listJobAttempts(jobId);
      const intendedAttempt = attempts.find((attempt) => attempt.id === attemptId);
      if (intendedAttempt) {
        const reconciliation = await this.reconcileLocal(jobId, attemptId);
        if (reconciliation.status === "safely-unknown") {
          return {
            ok: false,
            jobId,
            attemptId,
            message: `Stable execution ${jobId}/${attemptId} requires reconciliation: ${reconciliation.message}`,
          };
        }
        return {
          ok: true,
          jobId,
          attemptId,
          ...(intendedAttempt.pid ? { pid: intendedAttempt.pid } : {}),
          replayed: true,
          status: reconciliation.status,
        };
      }
      if (attempts.length > 0 || existingJob.status !== "created") {
        return {
          ok: false,
          jobId,
          attemptId,
          message: `Stable job identity ${jobId} exists without the intended attempt; refusing replay`,
        };
      }
    } else {
      await this.deps.db.createJob({
        id: jobId,
        name: request.name ?? canonicalPath,
        software: request.software,
        inputPath: canonicalPath,
        outputPath: recipePlan.outputName,
        workdir: this.deps.config.jobsDir,
        projectId: request.projectId,
      });
      await this.emit("job.created", jobId, undefined, {
        software: request.software,
        inputPath: canonicalPath,
        runner: "local",
      });
    }
    await this.emit("recipe.selected", jobId, undefined, {
      recipeId: selectedRecipe.id,
      command: recipePlan.command.display,
      resources: selectedRecipe.resources,
    });

    await this.deps.db.createJobAttempt({
      id: attemptId,
      jobId,
      runner: "local",
      command: executionPlan.displayCommand ?? recipePlan.command.display,
      cwd: `${this.deps.config.jobsDir}/${jobId}`,
      status: "created",
    });
    // attempt.created is emitted by the DB adapter's createJobAttempt

    const backend = this.deps.localBackendFactory(executionPlan, this.deps.db, this.deps.executor);

    let stageResult: RunnerResult;
    try {
      stageResult = await backend.stageAttempt(executionPlan.job, attemptId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Stage threw unexpectedly";
      const failure = await this.failJobAndAttempt(jobId, attemptId, message);
      if (!failure.ok) {
        return {
          ok: false,
          jobId,
          attemptId,
          status: "safely-unknown",
          message: `${message}; ${failure.message}`,
        };
      }
      return { ok: false, jobId, attemptId, message };
    }
    if (!stageResult.ok) {
      const message = stageResult.message ?? "Stage failed";
      if (stageResult.failureDisposition === "termination-unknown") {
        return { ok: false, jobId, attemptId, status: "safely-unknown", message };
      }
      const failure = await this.failJobAndAttempt(jobId, attemptId, message);
      if (!failure.ok) {
        return {
          ok: false,
          jobId,
          attemptId,
          status: "safely-unknown",
          message: `${message}; ${failure.message}`,
        };
      }
      return { ok: false, jobId, attemptId, message: stageResult.message ?? "Stage failed" };
    }
    if (request.expectedInputDigest !== undefined) {
      const verification = await this.verifyStagedInput(
        stageResult,
        request.expectedInputDigest,
        executionPlan.job,
      );
      if (!verification.ok) {
        const failure = await this.failJobAndAttempt(jobId, attemptId, verification.message);
        if (!failure.ok) {
          return {
            ok: false,
            jobId,
            attemptId,
            status: "safely-unknown",
            message: `${verification.message}; ${failure.message}`,
          };
        }
        return { ok: false, jobId, attemptId, message: verification.message };
      }
    }

    let startResult: StartedProcess;
    try {
      startResult = await backend.startAttempt(executionPlan.job, attemptId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Start threw unexpectedly";
      // An unexpected start exception may be post-spawn. Without a typed
      // terminal confirmation, failing the DB could release live capacity.
      return { ok: false, jobId, attemptId, status: "safely-unknown", message };
    }
    if (!startResult.ok) {
      return {
        ok: false,
        jobId,
        attemptId,
        ...(startResult.failureDisposition === "termination-unknown"
          ? { status: "safely-unknown" as const }
          : {}),
        message: startResult.message ?? "Start failed",
      };
    }

    return { ok: true, jobId, attemptId, pid: startResult.pid, command: startResult.command };
  }

  // ── dispatchExistingJob — for scheduler-dispatched jobs ──
  //
  // Takes a job and attempt that were already persisted atomically
  // by the scheduler's claim operation. Builds the execution plan
  // from the job's persisted state, selects the recipe, stages
  // and starts. Preserves attempt-before-effects and
  // confirmed-start-only running semantics.
  //
  // On synchronous failure, leaves failed state in DB and reconciles
  // the reservation. On success, returns durable job/attempt/pid.

  async dispatchExistingJob(jobId: string, attemptId: string): Promise<LocalExecutionOutcome> {
    if (this.deps.allowLegacyExecution === false)
      return {
        ok: false,
        jobId,
        attemptId,
        message: "Legacy existing-job dispatch is disabled in production",
      };
    // Helper to release dispatch on failure
    const release = async (
      msg: string,
    ): Promise<{ ok: false; jobId: string; attemptId: string; message: string }> => {
      await this.deps.db.releaseJobDispatch(jobId, attemptId, msg);
      return { ok: false, jobId, attemptId, message: msg };
    };

    // 1. Resolve job from DB
    const raw = await this.deps.db.getJob(jobId);
    if (!raw) return await release(`Job ${jobId} not found`);
    const job = this.jobFromDb(raw);
    const software = typeof job.software === "string" ? job.software : String(job.software ?? "");
    const inputPath = job.inputPath;

    // 2. Resolve attempt
    const attempts = await this.deps.db.listJobAttempts(jobId);
    const attempt = attempts.find((a) => a.id === attemptId);
    if (!attempt) return await release(`Attempt ${attemptId} not found for job ${jobId}`);
    if (attempt.status !== "created") {
      return await release(
        `Attempt ${attemptId} has status "${attempt.status}", expected "created"`,
      );
    }

    // 3. Find recipe for job's software
    const runKind: RecipeRunnerKind = "local";
    const allRecipes: readonly Recipe[] = this.deps.recipes.recipes;
    const selectedRecipe = findRunnableRecipe([...allRecipes], software, runKind, "");
    if (!selectedRecipe) return await release(`No recipe found for ${software}`);
    const recipeValidation = validateRecipe(selectedRecipe);
    if (!recipeValidation.valid) {
      return await release(
        `Recipe "${selectedRecipe.id}" validation failed: ${recipeValidation.errors.join("; ")}`,
      );
    }

    // 4. Render recipe plan from persisted job state
    const recipePlan = renderRecipePlan(selectedRecipe, inputPath, jobId, job.workdir, runKind);
    const plan: import("./submit-service").LocalExecutionPlan = {
      command: recipePlan.command.display,
      program: recipePlan.command.program,
      args: recipePlan.command.args,
      displayCommand: recipePlan.command.display,
      job,
    };

    // 5. Emit recipe.selected — recipe choice is part of dispatch
    await this.emit("recipe.selected", jobId, attemptId, {
      recipeId: selectedRecipe.id,
      command: recipePlan.command.display,
      resources: selectedRecipe.resources,
    });

    // 6. Build backend and stage (attempt-before-effects: attempt already exists)
    const backend = this.deps.localBackendFactory(plan, this.deps.db, this.deps.executor);

    let stageResult: RunnerResult;
    try {
      stageResult = await backend.stageAttempt(job, attemptId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Stage threw unexpectedly";
      await this.deps.db.releaseJobDispatch(jobId, attemptId, message);
      return { ok: false, jobId, attemptId, message };
    }
    if (!stageResult.ok) {
      if (stageResult.failureDisposition === "termination-unknown") {
        return {
          ok: false,
          jobId,
          attemptId,
          status: "safely-unknown",
          message: stageResult.message ?? "Stage termination is safely-unknown",
        };
      }
      await this.deps.db.releaseJobDispatch(
        jobId,
        attemptId,
        stageResult.message ?? "Stage failed",
      );
      return { ok: false, jobId, attemptId, message: stageResult.message ?? "Stage failed" };
    }

    // 7. Start (confirmed-start-only running)
    let startResult: StartedProcess;
    try {
      startResult = await backend.startAttempt(job, attemptId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Start threw unexpectedly";
      // Same fail-closed boundary as executeLocal: a thrown start has no typed
      // proof that a spawned supervisor/process tree is dead.
      return { ok: false, jobId, attemptId, status: "safely-unknown", message };
    }
    if (!startResult.ok) {
      if (startResult.failureDisposition === "termination-unknown") {
        return {
          ok: false,
          jobId,
          attemptId,
          status: "safely-unknown",
          message: startResult.message ?? "Start termination is safely-unknown",
        };
      }
      await this.deps.db.releaseJobDispatch(
        jobId,
        attemptId,
        startResult.message ?? "Start failed",
      );
      return { ok: false, jobId, attemptId, message: startResult.message ?? "Start failed" };
    }

    return { ok: true, jobId, attemptId, pid: startResult.pid, command: startResult.command };
  }

  // ── reconcileLocal — durable truth, no event emission ────
  // Blocker 4: Does NOT emit system.notice. Reconciliation is
  // side-effect-free (backend may persist receipt-confirmed state).

  async reconcileLocal(jobIdArg: string, attemptId?: string): Promise<ReconcileLocalOutcome> {
    if (this.deps.allowLegacyExecution === false)
      return {
        status: "safely-unknown",
        jobId: jobIdArg,
        attemptId,
        message: "Legacy local state mutation is disabled in production",
      };
    const resolved = await this.resolveJobAndAttempt(jobIdArg, attemptId);
    if (!resolved.ok)
      return { status: "safely-unknown", jobId: jobIdArg, message: resolved.message };

    const { job, resolvedId, attempt } = resolved;
    const backend = this.buildBackendForJob(job);

    try {
      const result = await backend.reconcileAttempt(job, attempt.id);
      if (result.status === "safely-unknown") {
        return {
          status: "safely-unknown",
          jobId: resolvedId,
          attemptId: attempt.id,
          message: result.message,
        };
      }
      return {
        status: result.status,
        jobId: resolvedId,
        attemptId: attempt.id,
        receipt: result.receipt,
        exitCode: result.exitCode,
        message: result.message,
      };
    } catch (err) {
      return {
        status: "safely-unknown",
        jobId: resolvedId,
        attemptId: attempt.id,
        message: `Reconciliation threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ── cancelLocal ──────────────────────────────────────────
  // The DB terminal materializer owns process.cancelled atomically with state.
  // The coordinator must not append a second event after that transaction.

  async cancelLocal(jobIdArg: string): Promise<CancelLocalOutcome> {
    if (this.deps.allowLegacyExecution === false)
      return {
        ok: false,
        jobId: jobIdArg,
        message: "Legacy local cancellation is disabled in production",
      };
    const resolved = await this.resolveJobAndAttempt(jobIdArg);
    if (!resolved.ok) return { ok: false, jobId: jobIdArg, message: resolved.message };

    const { job, resolvedId, attempt } = resolved;
    const backend = this.buildBackendForJob(job);

    try {
      const result = await backend.cancelAttempt(job, attempt.id);
      if (result.ok) {
        return {
          ok: true,
          jobId: resolvedId,
          attemptId: attempt.id,
          transitioned: result.transitioned,
          receipt: result.receipt,
          message: result.message,
        };
      }
      return { ok: false, jobId: resolvedId, attemptId: attempt.id, message: result.message };
    } catch (err) {
      return {
        ok: false,
        jobId: resolvedId,
        attemptId: attempt.id,
        message: `Cancel threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async cancelPending(jobIdArg: string, reason?: string): Promise<CancelPendingOutcome> {
    if (this.deps.allowLegacyExecution === false)
      return {
        ok: false,
        jobId: jobIdArg,
        message: "Legacy pending cancellation is disabled in production",
      };
    const resolved = await this.resolveJobOnly(jobIdArg);
    if (!resolved.ok) return { ok: false, jobId: resolved.resolvedId, message: resolved.message };

    const { resolvedId, job } = resolved;
    if (job.status !== "queued" && job.status !== "staged") {
      return {
        ok: false,
        jobId: resolvedId,
        message: `Job ${resolvedId} is ${job.status}; only queued or staged jobs without an external owner can be cancelled here`,
      };
    }
    if (job.externalJobId) {
      return {
        ok: false,
        jobId: resolvedId,
        message: `Job ${resolvedId} has external owner ${job.externalJobId}; cancel through its backend coordinator`,
      };
    }

    const attempts = await this.deps.db.listJobAttempts(resolvedId);
    const attempt = attempts.at(-1);
    if (attempt) {
      if (attempt.status !== "queued" && attempt.status !== "staged") {
        return {
          ok: false,
          jobId: resolvedId,
          attemptId: attempt.id,
          message: `Attempt ${attempt.id} is ${attempt.status}; reconcile through its owning backend before cancellation`,
        };
      }
      try {
        await this.deps.db.materializeTerminalAttempt({
          jobId: resolvedId,
          attemptId: attempt.id,
          status: "cancelled",
          finishedAt: this.deps.clock(),
          source: "cli",
          payload: {
            reason,
            backend: attempt.runner,
            cancellation: "pending-no-external-owner",
          },
        });
      } catch (error) {
        return {
          ok: false,
          jobId: resolvedId,
          attemptId: attempt.id,
          message: `Pending cancellation could not be committed atomically: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      return {
        ok: true,
        jobId: resolvedId,
        attemptId: attempt.id,
        previousStatus: job.status,
        message: `Cancelled pending attempt ${attempt.id}`,
      };
    }

    try {
      await this.deps.db.updateJobStatus(resolvedId, "cancelled");
    } catch (error) {
      return {
        ok: false,
        jobId: resolvedId,
        message: `Pending cancellation could not be committed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return {
      ok: true,
      jobId: resolvedId,
      previousStatus: job.status,
      message: `Cancelled pending job ${resolvedId}`,
    };
  }

  // ── collectLocal ─────────────────────────────────────────

  async collectLocal(jobIdArg: string): Promise<CollectLocalOutcome> {
    if (this.deps.allowLegacyExecution === false)
      return {
        ok: false,
        jobId: jobIdArg,
        attemptId: "",
        artifacts: [],
        message: "Legacy local collection is disabled in production",
      };
    const resolved = await this.resolveJobAndAttempt(jobIdArg);
    if (!resolved.ok)
      return {
        ok: false,
        jobId: jobIdArg,
        attemptId: "",
        artifacts: [],
        message: resolved.message,
      };

    const { job, resolvedId, attempt } = resolved;
    const backend = this.buildBackendForJob(job);

    try {
      const result = await backend.collectAttempt(job, attempt.id, { requiredOutput: true });
      // artifact.registered is emitted by the DB adapter's createArtifact
      return {
        ok: result.ok,
        jobId: resolvedId,
        attemptId: attempt.id,
        artifacts: result.artifacts,
        message: result.message,
      };
    } catch (err) {
      return {
        ok: false,
        jobId: resolvedId,
        attemptId: attempt.id,
        artifacts: [],
        message: `Collect threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ── parseJob — coordinator-owned ─────────────────────────
  //
  // Blocker 9: output artifact matched to exact attempt.
  // Blocker 10: on retry, find existing result, don't rerun parser,
  //   don't duplicate events, apply only missing transition.
  //   For already-parsed, return actual existing result ID directly
  //   from StoredResultRecord — no event scanning.

  async parseJob(jobIdArg: string, attemptIdArg?: string): Promise<ParseLocalOutcome> {
    if (this.deps.allowLegacyExecution === false)
      return {
        ok: false,
        jobId: jobIdArg,
        message: "Legacy job parsing/state mutation is disabled in production",
      };
    const parser = this.deps.parser;
    if (!parser)
      return { ok: false, jobId: jobIdArg, message: "No parser bridge configured in coordinator" };

    const resolved = await this.resolveJobAndAttempt(jobIdArg, attemptIdArg);
    if (!resolved.ok) return { ok: false, jobId: jobIdArg, message: resolved.message };

    const { job, resolvedId, attempt } = resolved;

    // Already parsed — return actual durable result ID from stored record
    if (job.status === "parsed") {
      const existingResult = await this.deps.db.getLatestResult(resolvedId, attempt.id);
      if (existingResult) {
        return {
          ok: true,
          jobId: resolvedId,
          attemptId: attempt.id,
          resultId: existingResult.id,
          parser: existingResult.parser,
          message: `Job ${resolvedId} is already parsed`,
        };
      }
      // Parsed but no result record — fall through to parse
    }

    // Only completed jobs can be parsed
    if (job.status !== "completed") {
      return {
        ok: false,
        jobId: resolvedId,
        attemptId: attempt.id,
        message: `Job ${resolvedId} is ${job.status}; must be completed to parse`,
      };
    }

    // Check for existing result (retry — blocker 10, no event scanning)
    const existingResults = await this.deps.db.listResults(resolvedId, attempt.id);
    if (existingResults.length > 0) {
      const lastResult = existingResults[existingResults.length - 1];

      // Result saved but state transition missing — apply it, don't reparse
      try {
        await this.deps.db.updateJobStatus(resolvedId, "parsed");
      } catch (error) {
        // The result is durable, but the lifecycle transition is authoritative
        // too.  Never report a completed parse while the job remains
        // `completed`; callers can retry and this path will not rerun the
        // parser or duplicate the result.
        return {
          ok: false,
          jobId: resolvedId,
          attemptId: attempt.id,
          message: `Result ${lastResult.id} is durable but parsed transition failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      await this.emit("parse.completed", resolvedId, attempt.id, {
        parser: lastResult.parser,
        status: lastResult.status,
        resultId: lastResult.id,
      });
      return {
        ok: true,
        jobId: resolvedId,
        attemptId: attempt.id,
        resultId: lastResult.id,
        parser: lastResult.parser,
        message: "Completed missing transition",
      };
    }

    // Find output artifact matching exact attempt (blocker 9)
    const artifacts = await this.deps.db.listArtifacts(resolvedId);
    const outputArtifact = artifacts.find((a) => a.kind === "output" && a.attemptId === attempt.id);
    if (!outputArtifact) {
      return {
        ok: false,
        jobId: resolvedId,
        attemptId: attempt.id,
        message: `No output artifact found for attempt ${attempt.id}. Run collect first.`,
      };
    }

    const outputPath = outputArtifact.path;
    const software = job.software;

    // Emit parse.started
    await this.emit("parse.started", resolvedId, attempt.id, { software, outputPath });

    // Run parser
    let parseResult: ParseResult;
    try {
      parseResult = await parser.parse(software, outputPath);
    } catch (err) {
      await this.emit("parse.failed", resolvedId, attempt.id, {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        ok: false,
        jobId: resolvedId,
        attemptId: attempt.id,
        message: `Parser threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!parseResult.ok || !parseResult.data) {
      await this.emit("parse.failed", resolvedId, attempt.id, {
        error: parseResult.error?.message ?? "Parser returned no data",
      });
      return {
        ok: false,
        jobId: resolvedId,
        attemptId: attempt.id,
        message: parseResult.error?.message ?? "Parse failed",
      };
    }

    // Save result
    const data = parseResult.data as Record<string, unknown>;
    let resultId: string;
    try {
      resultId = await this.deps.db.saveResult({
        jobId: resolvedId,
        attemptId: attempt.id,
        parser: parseResult.parser ?? software,
        status:
          (parseResult.status as "completed" | "failed" | "partial" | "unknown") ?? "completed",
        energyHartree: data.energy_hartree != null ? Number(data.energy_hartree) : undefined,
        scfConverged: data.scf_converged != null ? Boolean(data.scf_converged) : undefined,
        imaginaryFrequencies:
          data.imaginary_frequencies != null ? Number(data.imaginary_frequencies) : undefined,
        normalTermination:
          data.normal_termination != null ? Boolean(data.normal_termination) : undefined,
        warnings: Array.isArray(data.warnings) ? (data.warnings as string[]) : [],
        errors: Array.isArray(data.errors) ? (data.errors as string[]) : [],
        raw: data,
      });
    } catch (err) {
      await this.emit("parse.failed", resolvedId, attempt.id, {
        error: `Parse succeeded but result save failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return {
        ok: false,
        jobId: resolvedId,
        attemptId: attempt.id,
        message: `Parse succeeded but failed to save result: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Emit result.saved
    await this.emit("result.saved", resolvedId, attempt.id, {
      resultId,
      parser: parseResult.parser ?? software,
      energy: data.energy_hartree,
    });

    // Transition completed→parsed AFTER persistence
    try {
      await this.deps.db.updateJobStatus(resolvedId, "parsed");
    } catch (error) {
      // Keep the durable result and make the missing transition explicit. A
      // successful-looking parse outcome here would contradict the DB state
      // and could cause a caller to release capacity or promote evidence.
      // Retry parseJob will find the existing result and only apply the
      // missing transition.
      return {
        ok: false,
        jobId: resolvedId,
        attemptId: attempt.id,
        resultId,
        parser: parseResult.parser ?? software,
        message: `Parse result ${resultId} is durable but parsed transition failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    // Emit parse.completed
    await this.emit("parse.completed", resolvedId, attempt.id, {
      parser: parseResult.parser ?? software,
      status: parseResult.status,
      resultId,
    });

    return {
      ok: true,
      jobId: resolvedId,
      attemptId: attempt.id,
      resultId,
      parser: parseResult.parser ?? software,
      message: "Parse completed",
    };
  }

  // ── Failure helper ────────────────────────────────────────

  private async failJobAndAttempt(
    jobId: string,
    attemptId: string,
    message: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const now = this.deps.clock();
    const persistenceErrors: string[] = [];
    try {
      await this.deps.db.updateJobAttemptStatus(attemptId, "failed", { finishedAt: now });
    } catch (error) {
      persistenceErrors.push(
        `attempt failed transition: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      await this.deps.db.updateJobStatus(jobId, "failed");
    } catch (error) {
      persistenceErrors.push(
        `job failed transition: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (persistenceErrors.length > 0) {
      return {
        ok: false,
        message: `Unable to persist failure state for ${jobId}/${attemptId}: ${persistenceErrors.join(
          "; ",
        )}`,
      };
    }
    try {
      await this.emit("process.failed", jobId, attemptId, {
        error: message,
        pid: null,
        exitCode: 1,
      });
    } catch (error) {
      return {
        ok: false,
        message: `Failure state is durable but process.failed event persistence failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    return { ok: true };
  }
}

// ── Internal plan builder ──────────────────────────────────

function buildLocalExecutionPlanInternal(
  selectedRecipe: Recipe,
  inputPath: string,
  id: string,
  jobsDir: string,
  runner: RecipeRunnerKind = "local",
): { plan: LocalExecutionPlan; recipePlan: RenderedRecipePlan } {
  const recipePlan = renderRecipePlan(selectedRecipe, inputPath, id, jobsDir, runner);
  const executionPlan: LocalExecutionPlan = {
    command: recipePlan.command.display,
    program: recipePlan.command.program,
    args: recipePlan.command.args,
    displayCommand: recipePlan.command.display,
    job: {
      id,
      name: inputPath,
      software: selectedRecipe.software,
      inputPath,
      outputPath: recipePlan.outputName,
      workdir: jobsDir,
      status: "created",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };
  return { plan: executionPlan, recipePlan };
}
