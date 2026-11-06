import { z } from "zod";
import type { Tool } from "../types";

const getJobStatusInput = z.object({
  jobId: z.string().describe("The job ID to check"),
});

const getJobStatusOutput = z.object({
  ok: z.boolean(),
  job: z.record(z.unknown()).optional(),
  attempts: z.array(z.record(z.unknown())).optional(),
  artifacts: z.array(z.record(z.unknown())).optional(),
  message: z.string().optional(),
  statusSource: z.literal("database"),
  liveVerified: z.literal(false),
  reconciliation: z.object({
    command: z.string(),
    args: z.array(z.string()),
    mutatesState: z.literal(true),
  }),
});

export const getJobStatusTool: Tool<
  z.infer<typeof getJobStatusInput>,
  z.infer<typeof getJobStatusOutput>
> = {
  name: "get-job-status",
  description:
    "Read persisted job status, attempts and artifacts. This is a database snapshot, not a live process check. Returns the canonical command for authorized reconciliation.",
  inputSchema: getJobStatusInput,
  outputSchema: getJobStatusOutput,
  async execute(ctx, input) {
    try {
      const job = await ctx.db.getJob(input.jobId);
      if (!job) {
        return {
          ok: false,
          error: {
            code: "JOB_NOT_FOUND",
            message: `Job '${input.jobId}' not found.`,
            hint: "Use 'list-jobs' to see available jobs.",
          },
        };
      }

      const attempts = await ctx.db.listJobAttempts(input.jobId);
      const artifacts = await ctx.db.listArtifacts(input.jobId);

      return {
        ok: true,
        data: {
          ok: true,
          statusSource: "database",
          liveVerified: false,
          reconciliation: {
            command: "eigengrid",
            args: ["status", input.jobId],
            mutatesState: true,
          },
          job: job as any,
          attempts: attempts as any[],
          artifacts: artifacts as any[],
          message: `Stored status: ${job.status} (${job.software}). This may be stale. Reconciliation checks canonical runner evidence and can update persisted lifecycle state; use the returned command only under the active action permissions.`,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "STATUS_ERROR",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
};
