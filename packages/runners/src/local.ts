import type {
  Job,
  JobAttempt,
  RemoteProcessStatus,
  RunnerResult,
  StartedProcess,
} from "@eigengrid/core";
import type { LocalReceipt } from "./local-receipt";
import { localCancelAttempt } from "./local/cancellation";
import { localCollectAttempt } from "./local/collection";
import { LocalRunnerContext } from "./local/context";
import { type LocalRunnerOptions } from "./local/contracts";
import { localStartAttempt } from "./local/dispatch";
import { localFetch, localStart, localStatus, localStop } from "./local/legacy";
import { localReconcileAttempt } from "./local/reconciliation";
import { localStage, localStageAttempt } from "./local/staging";
import { localMaterializeTerminalEvidence } from "./local/terminal";
import type { Runner } from "./runner";
export type { LocalRunnerOptions, ProcessSupervisor } from "./local/contracts";
export { DefaultProcessSupervisor } from "./local/supervisor";

/** Stable facade; state and complete lifecycle operations live in domain modules. */
export class LocalRunner implements Runner {
  readonly kind = "local" as const;
  private readonly context: LocalRunnerContext;
  constructor(options: LocalRunnerOptions = {}) {
    this.context = new LocalRunnerContext(options);
  }
  // Keep legacy lifecycle inspection on the same process map as the domain modules.
  private get processes() {
    return this.context.processes;
  }
  /**
   * Materialize the database evidence derived from an authoritative terminal
   * receipt. The detached durable supervisor can outlive the CLI process, so
   * this work must also be available to a later reconciliation context.
   *
   * Every operation is idempotent: artifacts are deduplicated by their exact
   * attempt/path identity and the terminal event is appended only when the
   * durable event log does not already contain it.
   */
  private materializeTerminalEvidence(
    job: Job,
    attempt: JobAttempt,
    receipt: LocalReceipt,
  ): Promise<void> {
    return localMaterializeTerminalEvidence(this.context, job, attempt, receipt);
  }

  // ── Coordinator-Driven Explicit-Attempt Methods ─────────

  async stageAttempt(job: Job, attemptId: string): Promise<RunnerResult> {
    return localStageAttempt(this.context, job, attemptId);
  }

  async startAttempt(job: Job, attemptId: string): Promise<StartedProcess> {
    return localStartAttempt(this.context, job, attemptId);
  }

  // ── Runner Interface ────────────────────────────────────

  async stage(job: Job): Promise<RunnerResult> {
    return localStage(this.context, job);
  }

  async start(job: Job): Promise<StartedProcess> {
    return localStart(this.context, job);
  }

  async status(job: Job): Promise<RemoteProcessStatus> {
    return localStatus(this.context, job);
  }

  async stop(job: Job): Promise<RunnerResult> {
    return localStop(this.context, job);
  }

  async fetch(job: Job): Promise<RunnerResult> {
    return localFetch(this.context, job);
  }

  /**
   * Reconcile the durable truth about an attempt.
   *
   * 1. Check identity + receipt (most authoritative)
   * 2. Check in-memory tracked process
   * 3. Check persisted attempt PID with identity verification
   * 4. Use persisted terminal state if available
   *
   * Never infers running from status or PID existence alone.
   * Applies receipt-confirmed terminal state to DB.
   */
  async reconcileAttempt(
    job: Job,
    attemptId: string,
  ): Promise<{
    status: "running" | "completed" | "failed" | "cancelled" | "safely-unknown";
    receipt?: LocalReceipt;
    exitCode?: number;
    message: string;
  }> {
    return localReconcileAttempt(this.context, job, attemptId);
  }

  /**
   * Cancel a local attempt.
   *
   * The DB terminal materializer owns cancellation state and event atomically;
   * the backend returns whether this call initiated the cancellation.
   *
   * Race-safe: marks settled and removes in-memory tracking
   * BEFORE any awaits (signal → mark → await DB/receipt).
   */
  async cancelAttempt(
    job: Job,
    attemptId: string,
  ): Promise<
    | { ok: true; transitioned: boolean; receipt: LocalReceipt; message: string }
    | { ok: false; message: string }
  > {
    return localCancelAttempt(this.context, job, attemptId);
  }

  /**
   * Collect artifacts for a specific attempt.
   * Deduplicates by jobId + attemptId + kind + canonical path.
   */
  async collectAttempt(
    job: Job,
    attemptId: string,
    options?: { requiredOutput?: boolean },
  ): Promise<
    | { ok: true; artifacts: string[]; message: string }
    | { ok: false; artifacts: string[]; message: string }
  > {
    return localCollectAttempt(this.context, job, attemptId, options);
  }
}
