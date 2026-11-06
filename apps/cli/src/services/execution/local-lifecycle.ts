import { buildBackendForJob, resolveJobAndAttempt, resolveJobOnly } from "./context";
import {
  type CancelLocalOutcome,
  type CancelPendingOutcome,
  type CollectLocalOutcome,
  type ExecutionCoordinatorDeps,
  type ReconcileLocalOutcome,
} from "./contracts";

// ── reconcileLocal — durable truth, no event emission ────
// Blocker 4: Does NOT emit system.notice. Reconciliation is
// side-effect-free (backend may persist receipt-confirmed state).

export async function reconcileLocal(
  deps: ExecutionCoordinatorDeps,
  jobIdArg: string,
  attemptId?: string,
): Promise<ReconcileLocalOutcome> {
  if (deps.allowLegacyExecution === false)
    return {
      status: "safely-unknown",
      jobId: jobIdArg,
      attemptId,
      message: "Legacy local state mutation is disabled in production",
    };
  const resolved = await resolveJobAndAttempt(deps, jobIdArg, attemptId);
  if (!resolved.ok) return { status: "safely-unknown", jobId: jobIdArg, message: resolved.message };

  const { job, resolvedId, attempt } = resolved;
  const backend = buildBackendForJob(deps, job);

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

export async function cancelLocal(
  deps: ExecutionCoordinatorDeps,
  jobIdArg: string,
): Promise<CancelLocalOutcome> {
  if (deps.allowLegacyExecution === false)
    return {
      ok: false,
      jobId: jobIdArg,
      message: "Legacy local cancellation is disabled in production",
    };
  const resolved = await resolveJobAndAttempt(deps, jobIdArg);
  if (!resolved.ok) return { ok: false, jobId: jobIdArg, message: resolved.message };

  const { job, resolvedId, attempt } = resolved;
  const backend = buildBackendForJob(deps, job);

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

export async function cancelPending(
  deps: ExecutionCoordinatorDeps,
  jobIdArg: string,
  reason?: string,
): Promise<CancelPendingOutcome> {
  if (deps.allowLegacyExecution === false)
    return {
      ok: false,
      jobId: jobIdArg,
      message: "Legacy pending cancellation is disabled in production",
    };
  const resolved = await resolveJobOnly(deps, jobIdArg);
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

  const attempts = await deps.db.listJobAttempts(resolvedId);
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
      await deps.db.materializeTerminalAttempt({
        jobId: resolvedId,
        attemptId: attempt.id,
        status: "cancelled",
        finishedAt: deps.clock(),
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
    await deps.db.updateJobStatus(resolvedId, "cancelled");
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

export async function collectLocal(
  deps: ExecutionCoordinatorDeps,
  jobIdArg: string,
): Promise<CollectLocalOutcome> {
  if (deps.allowLegacyExecution === false)
    return {
      ok: false,
      jobId: jobIdArg,
      attemptId: "",
      artifacts: [],
      message: "Legacy local collection is disabled in production",
    };
  const resolved = await resolveJobAndAttempt(deps, jobIdArg);
  if (!resolved.ok)
    return {
      ok: false,
      jobId: jobIdArg,
      attemptId: "",
      artifacts: [],
      message: resolved.message,
    };

  const { job, resolvedId, attempt } = resolved;
  const backend = buildBackendForJob(deps, job);

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
