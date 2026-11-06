import {
  type CancelLocalOutcome,
  type CancelPendingOutcome,
  type CollectLocalOutcome,
  type ExecutionCoordinatorDeps,
  type ExecutionService,
  type LocalExecutionOutcome,
  type LocalExecutionRequest,
  type ParseLocalOutcome,
  type ReconcileLocalOutcome,
  type RemoteExecutionBackend,
  type RemoteExecutionOutcome,
} from "./execution/contracts";

import { dispatchExistingJob, executeLocal } from "./execution/local-dispatch";
import {
  cancelLocal,
  cancelPending,
  collectLocal,
  reconcileLocal,
} from "./execution/local-lifecycle";
import { parseJob } from "./execution/parsing";
import { cancelRemote, collectRemote, dispatchRemote, reconcileRemote } from "./execution/remote";
export type {
  CancelLocalOutcome,
  CancelPendingOutcome,
  CollectLocalOutcome,
  ExecutionCoordinatorDeps,
  ExecutionService,
  LocalExecutionBackend,
  LocalExecutionBackendFactory,
  LocalExecutionOutcome,
  LocalExecutionRequest,
  ParseLocalOutcome,
  ParserBridge,
  ReconcileLocalOutcome,
  RemoteExecutionBackend,
  RemoteExecutionOutcome,
} from "./execution/contracts";

/** Stable application facade; domain modules retain authority and lifecycle checks. */
export class ExecutionCoordinator implements ExecutionService {
  constructor(private readonly deps: ExecutionCoordinatorDeps) {}

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
    return dispatchRemote(this.deps, jobIdArg, backend);
  }

  async reconcileRemote(
    jobIdArg: string,
    backend: RemoteExecutionBackend,
  ): Promise<RemoteExecutionOutcome> {
    return reconcileRemote(this.deps, jobIdArg, backend);
  }

  async cancelRemote(
    jobIdArg: string,
    backend: RemoteExecutionBackend,
  ): Promise<RemoteExecutionOutcome> {
    return cancelRemote(this.deps, jobIdArg, backend);
  }

  async collectRemote(
    jobIdArg: string,
    backend: RemoteExecutionBackend,
  ): Promise<RemoteExecutionOutcome> {
    return collectRemote(this.deps, jobIdArg, backend);
  }

  async executeLocal(request: LocalExecutionRequest): Promise<LocalExecutionOutcome> {
    return executeLocal(this.deps, request);
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
    return dispatchExistingJob(this.deps, jobId, attemptId);
  }

  // ── reconcileLocal — durable truth, no event emission ────
  // Blocker 4: Does NOT emit system.notice. Reconciliation is
  // side-effect-free (backend may persist receipt-confirmed state).

  async reconcileLocal(jobIdArg: string, attemptId?: string): Promise<ReconcileLocalOutcome> {
    return reconcileLocal(this.deps, jobIdArg, attemptId);
  }

  // ── cancelLocal ──────────────────────────────────────────
  // The DB terminal materializer owns process.cancelled atomically with state.
  // The coordinator must not append a second event after that transaction.

  async cancelLocal(jobIdArg: string): Promise<CancelLocalOutcome> {
    return cancelLocal(this.deps, jobIdArg);
  }

  async cancelPending(jobIdArg: string, reason?: string): Promise<CancelPendingOutcome> {
    return cancelPending(this.deps, jobIdArg, reason);
  }

  // ── collectLocal ─────────────────────────────────────────

  async collectLocal(jobIdArg: string): Promise<CollectLocalOutcome> {
    return collectLocal(this.deps, jobIdArg);
  }

  // ── parseJob — coordinator-owned ─────────────────────────
  //
  // Blocker 9: output artifact matched to exact attempt.
  // Blocker 10: on retry, find existing result, don't rerun parser,
  //   don't duplicate events, apply only missing transition.
  //   For already-parsed, return actual existing result ID directly
  //   from StoredResultRecord — no event scanning.

  async parseJob(jobIdArg: string, attemptIdArg?: string): Promise<ParseLocalOutcome> {
    return parseJob(this.deps, jobIdArg, attemptIdArg);
  }
}
