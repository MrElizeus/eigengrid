import { join } from "node:path";
import type { Job, RemoteProcessStatus, RunnerResult, StartedProcess } from "@eigengrid/core";
import type { DatabaseLike } from "@eigengrid/db";
import {
  effectRequestDigest,
  readEffectIntent,
  persistEffectIntent,
  type Runner,
  SshDaemonStager,
} from "@eigengrid/runners";
import type { WorkerJobManifest } from "@eigengrid/worker";
import type { WorkerSyncService, SyncResult } from "./worker-sync-service";

export interface WorkerDaemonBackendOptions {
  db: DatabaseLike;
  stager: SshDaemonStager;
  manifest: WorkerJobManifest;
  command: string;
  remoteScratchDir: string;
  sync?: WorkerSyncService;
  nodeName?: string;
}

/**
 * Coordinator-facing worker-daemon backend. Staging is the only remote effect
 * at dispatch time; the deterministic worker claims and executes the bundle
 * later. Collection/reconciliation still enter through the same Runner seam.
 */
export class WorkerDaemonBackend implements Runner {
  readonly kind = "worker-daemon" as const;
  private stageOutcome: RunnerResult | undefined;

  constructor(private readonly options: WorkerDaemonBackendOptions) {}

  async stage(job: Job): Promise<RunnerResult> {
    if (job.id !== this.options.manifest.jobId) {
      return { ok: false, message: "worker manifest job identity does not match coordinator job" };
    }
    const existing = (await this.options.db.listJobAttempts(job.id)).find(
      (attempt) => attempt.id === this.options.manifest.attemptId,
    );
    if (!existing) {
      await this.options.db.updateJobStatus(job.id, "queued");
      await this.options.db.createJobAttempt({
        id: this.options.manifest.attemptId,
        jobId: job.id,
        runner: "worker-daemon",
        command: this.options.command,
        cwd: `${this.options.remoteScratchDir}/inbox/${job.id}`,
      });
    } else if (existing.status === "created") {
      await this.options.db.updateJobAttemptStatus(existing.id, "queued");
    }

    const intentPath = join(job.workdir, job.id, "effect-intent.json");
    const operationId = `worker-${job.id}-${this.options.manifest.attemptId}`;
    const intent = {
      schema: "eigengrid.effect-intent.v1" as const,
      operationId,
      jobId: job.id,
      attemptId: this.options.manifest.attemptId,
      backend: "worker" as const,
      state: "intent_persisted" as const,
      requestDigest: effectRequestDigest({
        jobId: job.id,
        attemptId: this.options.manifest.attemptId,
        manifest: this.options.manifest,
      }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const previous = readEffectIntent(intentPath);
    if (previous) {
      if (previous.requestDigest !== intent.requestDigest) {
        return {
          ok: false,
          message: "worker dispatch idempotency key has a conflicting request digest",
        };
      }
      if (previous.state === "submitted" || previous.state === "confirmed") {
        this.stageOutcome = {
          ok: true,
          message: `worker bundle already staged${previous.externalId ? ` at ${previous.externalId}` : ""}`,
          metadata: {
            attemptId: this.options.manifest.attemptId,
            remoteBundlePath: previous.externalId,
          },
        };
        return this.stageOutcome;
      }
      if (previous.state === "ambiguous") {
        return {
          ok: false,
          message: "worker dispatch outcome is ambiguous; reconcile before retrying",
        };
      }
      if (previous.state === "intent_persisted") {
        return {
          ok: false,
          message:
            "worker dispatch may have crossed the remote effect boundary; reconcile before retrying",
        };
      }
      if (previous.state === "failed" || previous.state === "cancelled") {
        return {
          ok: false,
          message: `worker dispatch is terminal in durable intent state ${previous.state}`,
        };
      }
    }
    if (existing && (existing.status === "queued" || existing.status === "staged")) {
      // An attempt that already crossed the local reducer without an intent
      // cannot safely be re-staged: the remote bundle may exist even though
      // this process never recorded its identity. Reconcile it explicitly.
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message:
          "worker attempt exists without a durable dispatch intent; reconcile before retrying",
      };
    }
    persistEffectIntent(intentPath, intent);

    const staged = await this.options.stager.stage(job, this.options.manifest);
    if (!staged.ok) {
      const errors: string[] = [];
      // A remote transport failure can occur after mkdir/copy/rename has
      // crossed the worker effect boundary.  Only a failure explicitly marked
      // terminal-confirmed may be projected into terminal DB state.  Unknown
      // outcomes remain durable and require reconciliation before retry.
      const failureDisposition = staged.failureDisposition ?? "terminal-confirmed";
      try {
        persistEffectIntent(intentPath, {
          ...intent,
          state: failureDisposition === "termination-unknown" ? "ambiguous" : "failed",
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        errors.push(
          `effect intent failure state could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (failureDisposition === "terminal-confirmed") {
        try {
          await this.options.db.updateJobAttemptStatus(this.options.manifest.attemptId, "failed", {
            finishedAt: Date.now(),
          });
        } catch (error) {
          errors.push(
            `worker attempt failure state could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        try {
          await this.options.db.updateJobStatus(job.id, "failed");
        } catch (error) {
          errors.push(
            `worker job failure state could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      this.stageOutcome = staged;
      return {
        ok: false,
        failureDisposition,
        message: [staged.error ?? "worker staging failed", ...errors].join("; "),
      };
    }

    try {
      // The remote bundle already exists at this point. Record its exact
      // external identity before projecting any local lifecycle state so a
      // crash cannot leave a staged effect with no durable reconciliation
      // handle.
      persistEffectIntent(intentPath, {
        ...intent,
        state: "submitted",
        externalId: staged.remoteBundlePath,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      // The remote bundle now exists, but its external identity was not
      // durably recorded. Never report a normal stage failure that could be
      // retried blindly; force explicit reconciliation instead.
      this.stageOutcome = {
        ok: false,
        failureDisposition: "termination-unknown",
        message: `worker bundle was staged but effect identity persistence failed; outcome is ambiguous: ${error instanceof Error ? error.message : String(error)}`,
      };
      return this.stageOutcome;
    }
    try {
      const current = (await this.options.db.listJobAttempts(job.id)).find(
        (attempt) => attempt.id === this.options.manifest.attemptId,
      );
      if (!current) throw new Error("worker attempt disappeared during staging");
      if (current.status === "created") {
        await this.options.db.updateJobAttemptStatus(current.id, "queued");
      }
      if (current.status === "queued") {
        await this.options.db.updateJobAttemptStatus(current.id, "staged");
      }
      await this.options.db.updateJobStatus(job.id, "staged");
    } catch (error) {
      this.stageOutcome = {
        ok: false,
        failureDisposition: "termination-unknown",
        message: `worker bundle identity is durable but local lifecycle projection failed; outcome is ambiguous: ${error instanceof Error ? error.message : String(error)}`,
      };
      return this.stageOutcome;
    }
    this.stageOutcome = {
      ok: true,
      message: `staged worker bundle ${staged.remoteBundlePath ?? job.id}`,
      metadata: {
        attemptId: this.options.manifest.attemptId,
        remoteBundlePath: staged.remoteBundlePath,
      },
    };
    return this.stageOutcome;
  }

  async start(_job: Job): Promise<StartedProcess> {
    if (!this.stageOutcome?.ok) {
      return { ok: false, message: "worker bundle was not staged" };
    }
    return { ok: true, message: "worker daemon will claim the staged bundle" };
  }

  async status(job: Job): Promise<RemoteProcessStatus> {
    const persisted = await this.options.db.getJob(job.id);
    const status = persisted?.status;
    if (status === "running") return { status: "running", message: "worker daemon is executing" };
    if (status === "completed") return { status: "completed", message: "worker daemon completed" };
    if (status === "failed") return { status: "failed", message: "worker daemon failed" };
    if (status === "cancelled") return { status: "stopped", message: "worker daemon cancelled" };
    return { status: "unknown", message: `worker daemon state is ${status ?? "missing"}` };
  }

  async stop(_job: Job): Promise<RunnerResult> {
    return {
      ok: false,
      message: "worker-daemon cancellation requires an explicit worker control capability",
    };
  }

  async fetch(job: Job): Promise<RunnerResult> {
    if (!this.options.sync) {
      return { ok: false, message: "worker-daemon collection is unavailable in this context" };
    }
    const result: SyncResult = await this.options.sync.collectArtifacts(
      job.id,
      this.options.nodeName,
    );
    return {
      ok: result.ok,
      message: result.ok
        ? `worker artifacts synchronized (${result.syncedJobs} bundle${result.syncedJobs === 1 ? "" : "s"})`
        : result.errors.join("; "),
      metadata: { syncedJobs: result.syncedJobs, errors: result.errors },
    };
  }
}

/** Read/collection-only adapter used by `collect`; it cannot stage or start. */
export class WorkerDaemonCollectionBackend implements Runner {
  readonly kind = "worker-daemon" as const;

  constructor(
    private readonly db: DatabaseLike,
    private readonly sync: WorkerSyncService,
    private readonly nodeName?: string,
  ) {}

  async stage(_job: Job): Promise<RunnerResult> {
    return { ok: false, message: "worker-daemon collection backend cannot stage" };
  }

  async start(_job: Job): Promise<StartedProcess> {
    return { ok: false, message: "worker-daemon collection backend cannot start" };
  }

  async status(job: Job): Promise<RemoteProcessStatus> {
    const persisted = await this.db.getJob(job.id);
    if (persisted?.status === "running") return { status: "running" };
    if (persisted?.status === "completed") return { status: "completed" };
    if (persisted?.status === "failed") return { status: "failed" };
    if (persisted?.status === "cancelled") return { status: "stopped" };
    return { status: "unknown", message: "worker daemon status is not terminal" };
  }

  async stop(_job: Job): Promise<RunnerResult> {
    return {
      ok: false,
      message: "worker-daemon cancellation requires an explicit worker control capability",
    };
  }

  async fetch(job: Job): Promise<RunnerResult> {
    const result: SyncResult = await this.sync.collectArtifacts(job.id, this.nodeName);
    return {
      ok: result.ok,
      message: result.ok
        ? `worker artifacts synchronized (${result.syncedJobs} bundle${result.syncedJobs === 1 ? "" : "s"})`
        : result.errors.join("; "),
      metadata: { syncedJobs: result.syncedJobs, errors: result.errors },
    };
  }
}
