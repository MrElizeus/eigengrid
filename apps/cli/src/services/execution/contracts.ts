import type { Config, Job, ParseResult, RunnerResult, StartedProcess } from "@eigengrid/core";
import type { DatabaseLike } from "@eigengrid/db";
import { type CommandExecutor, type LocalReceipt, type Runner } from "@eigengrid/runners";
import type { RecipeRegistry } from "../../composition/types";
import { type LocalExecutionPlan } from "../submit-service";

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

export type EventPayload = Record<string, unknown>;

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
