import { z } from "zod";
import { generateId } from "@eigengrid/core";
import type { Tool, ToolContext, ToolResult } from "../types";

// ── Input / Output Schemas ──────────────────────────────────

const cancelJobInput = z.object({
  jobId: z.string().describe("ID of the job to cancel"),
  reason: z.string().optional().describe("Optional reason for cancellation"),
});

const cancelJobOutput = z.object({
  jobId: z.string(),
  previousStatus: z.string(),
  status: z.literal("cancelled"),
});

type CancelJobResult = ToolResult<z.infer<typeof cancelJobOutput>>;

// ── Cancel Job Tool ─────────────────────────────────────────

/**
 * Cancel a job by ID.
 *
 * Only jobs in the following states can be cancelled:
 *   queued, staged, running (when owned by a remote/local coordinator)
 *
 * Jobs in running, completed, failed, parsed, or cancelled states
 * are rejected with a descriptive error.
 */
export const cancelJobTool: Tool<
  z.infer<typeof cancelJobInput>,
  z.infer<typeof cancelJobOutput>
> = {
  name: "cancel-job",
  description: "Cancel a queued, staged, or coordinator-owned running job by its ID.",
  inputSchema: cancelJobInput,
  outputSchema: cancelJobOutput,
  async execute(ctx, input) {
    return executeCancelJob(ctx, input);
  },
};

export async function executeCancelJob(
  ctx: ToolContext,
  input: z.infer<typeof cancelJobInput>,
): Promise<CancelJobResult> {
  // 1. Look up the job
  const job = await ctx.db.getJob(input.jobId);
  if (!job) {
    return {
      ok: false,
      error: { code: "JOB_NOT_FOUND", message: `Job '${input.jobId}' not found.` },
    };
  }

  const status = job.status;
  const externalJobId = job.externalJobId ?? undefined;
  let attempts: Awaited<ReturnType<typeof ctx.db.listJobAttempts>> = [];
  if (typeof ctx.db.listJobAttempts === "function") {
    try {
      const listed = await ctx.db.listJobAttempts(input.jobId);
      // A few legacy/test database facades predate attempt listing and return
      // undefined. Treat that as an empty read-only projection; never let a
      // compatibility adapter turn cancellation into an uncaught exception.
      attempts = Array.isArray(listed) ? listed : [];
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "DATABASE_UNAVAILABLE",
          message: `Unable to resolve the job's execution owner: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }
  const latestAttempt = attempts.at(-1);
  const backend = job.backend ?? latestAttempt?.runner;
  const remoteBackend = backend === "worker-daemon" ? "worker-daemon" : backend;

  if (
    (remoteBackend === "slurm" ||
      remoteBackend === "pbs" ||
      remoteBackend === "ssh" ||
      remoteBackend === "worker-daemon") &&
    (status === "running" || Boolean(externalJobId) || latestAttempt?.status === "running")
  ) {
    const coordinator = ctx.execution?.cancelRemote;
    const runner = ctx.runners[remoteBackend];
    if (coordinator && runner) {
      const result = await coordinator(input.jobId, runner);
      if (!result.ok) {
        return {
          ok: false,
          error: { code: "CANCEL_FAILED", message: result.message ?? "Slurm cancellation failed" },
        };
      }
      return {
        ok: true,
        data: {
          jobId: input.jobId,
          previousStatus: status,
          status: "cancelled" as const,
        },
      };
    }

    return {
      ok: false,
      error: {
        code: "EXECUTION_COORDINATOR_UNAVAILABLE",
        message: `${remoteBackend} cancellation requires the canonical execution coordinator and runner`,
      },
    };
  }

  // Local cancellation is only valid when the durable attempt identifies a
  // local runner (or when no attempt exists and the ordinary queued-state
  // reducer below can perform the cancellation). Never send an SSH/worker
  // job through the local backend merely because the coordinator is present.
  if (
    ctx.execution?.cancelLocal &&
    latestAttempt &&
    latestAttempt.runner === "local" &&
    status === "running"
  ) {
    const result = await ctx.execution.cancelLocal(input.jobId);
    if (!result.ok) {
      return {
        ok: false,
        error: { code: "CANCEL_FAILED", message: result.message },
      };
    }
    return {
      ok: true,
      data: {
        jobId: result.jobId ?? input.jobId,
        previousStatus: status,
        status: "cancelled" as const,
      },
    };
  }

  // A queued/staged job with no external owner is still a domain mutation,
  // so production contexts route it through the coordinator's atomic pending
  // cancellation use case.  The legacy DB-only branch below is retained only
  // for pre-coordinator test/compatibility facades and is never present in the
  // application composition root.
  if (ctx.execution?.cancelPending && (status === "queued" || status === "staged")) {
    const result = await ctx.execution.cancelPending(input.jobId, input.reason);
    if (!result.ok) {
      return {
        ok: false,
        error: { code: "CANCEL_FAILED", message: result.message },
      };
    }
    return {
      ok: true,
      data: {
        jobId: result.jobId ?? input.jobId,
        previousStatus: result.previousStatus ?? status,
        status: "cancelled" as const,
      },
    };
  }

  if (ctx.execution && status === "created") {
    return {
      ok: false,
      error: {
        code: "INVALID_STATUS",
        message: `Job '${input.jobId}' is still created; queue it before requesting cancellation.`,
      },
    };
  }

  // 2. Validate cancellable status
  const cancellableStatuses = ["created", "queued", "staged"];
  if (!cancellableStatuses.includes(status)) {
    const message =
      status === "running"
        ? `Job '${input.jobId}' is currently running and cannot be cancelled via this tool.`
        : status === "completed"
          ? `Job '${input.jobId}' has already completed.`
          : status === "failed"
            ? `Job '${input.jobId}' has already failed.`
            : status === "parsed"
              ? `Job '${input.jobId}' has already been parsed.`
              : status === "cancelled"
                ? `Job '${input.jobId}' is already cancelled.`
                : `Job '${input.jobId}' is in status '${status}' and cannot be cancelled.`;
    return {
      ok: false,
      error: { code: "INVALID_STATUS", message },
    };
  }

  // 3. Update status in database
  await ctx.db.updateJobStatus(input.jobId, "cancelled");

  // 4. Append cancellation event
  await ctx.db.appendEvent?.({
    id: generateId("evt"),
    type: "slurm.job.cancelled",
    at: Date.now(),
    source: "cli",
    jobId: input.jobId,
    payload: {
      backend: "slurm",
      externalJobId,
      slurmJobId: externalJobId,
      externalState: "CANCELLED",
      eigengridStatus: "cancelled",
      cancelledAt: Date.now(),
    },
  });

  await ctx.db.insertEvent({
    type: "job:status:changed",
    jobId: input.jobId,
    from: status as any,
    to: "cancelled" as any,
    at: Date.now(),
  });

  // Track cancellation reason in a system notice when provided
  if (input.reason) {
    await ctx.db.insertEvent({
      type: "system:notice",
      message: `Job ${input.jobId} cancelled: ${input.reason}`,
      at: Date.now(),
    });
  }

  // 5. Return result
  return {
    ok: true,
    data: {
      jobId: input.jobId,
      previousStatus: status,
      status: "cancelled" as const,
    },
  };
}
