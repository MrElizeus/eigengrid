import type { RunnerResult, StartedProcess } from "@eigengrid/core";
import { join } from "node:path";
import { resolveJobOnly } from "./context";
import {
  type ExecutionCoordinatorDeps,
  type RemoteExecutionBackend,
  type RemoteExecutionOutcome,
} from "./contracts";
import { type DispatchLease, acquireDispatchLease, releaseDispatchLease } from "./dispatch-lease";

/**
 * Canonical remote dispatch boundary. It resolves durable state before
 * staging, then starts only through the supplied runner. A thrown start or
 * an explicitly ambiguous runner result remains safely unknown for later
 * reconciliation; it is never silently retried here.
 */
const SAFE_STABLE_ID = /^[A-Za-z0-9._-]{1,128}$/u;

/**
 * Canonical remote dispatch boundary. It resolves durable state before
 * staging, then starts only through the supplied runner. A thrown start or
 * an explicitly ambiguous runner result remains safely unknown for later
 * reconciliation; it is never silently retried here.
 */
export async function dispatchRemote(
  deps: ExecutionCoordinatorDeps,
  jobIdArg: string,
  backend: RemoteExecutionBackend,
): Promise<RemoteExecutionOutcome> {
  if (deps.allowLegacyExecution === false)
    return {
      ok: false,
      jobId: jobIdArg,
      message: "Legacy remote execution is disabled in production",
    };
  const resolved = await resolveJobOnly(deps, jobIdArg);
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
    const existingAttempts = await deps.db.listJobAttempts(resolved.resolvedId);
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

export async function reconcileRemote(
  deps: ExecutionCoordinatorDeps,
  jobIdArg: string,
  backend: RemoteExecutionBackend,
): Promise<RemoteExecutionOutcome> {
  if (deps.allowLegacyExecution === false)
    return {
      ok: false,
      jobId: jobIdArg,
      message: "Legacy remote state mutation is disabled in production",
    };
  const resolved = await resolveJobOnly(deps, jobIdArg);
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

export async function cancelRemote(
  deps: ExecutionCoordinatorDeps,
  jobIdArg: string,
  backend: RemoteExecutionBackend,
): Promise<RemoteExecutionOutcome> {
  if (deps.allowLegacyExecution === false)
    return {
      ok: false,
      jobId: jobIdArg,
      message: "Legacy remote cancellation is disabled in production",
    };
  const resolved = await resolveJobOnly(deps, jobIdArg);
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

export async function collectRemote(
  deps: ExecutionCoordinatorDeps,
  jobIdArg: string,
  backend: RemoteExecutionBackend,
): Promise<RemoteExecutionOutcome> {
  if (deps.allowLegacyExecution === false)
    return {
      ok: false,
      jobId: jobIdArg,
      message: "Legacy remote collection is disabled in production",
    };
  const resolved = await resolveJobOnly(deps, jobIdArg);
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
