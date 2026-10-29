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
});

export const getJobStatusTool: Tool<
  z.infer<typeof getJobStatusInput>,
  z.infer<typeof getJobStatusOutput>
> = {
  name: "get-job-status",
  description: "Get detailed status of a specific job, including attempts and artifacts",
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
          job: job as any,
          attempts: attempts as any[],
          artifacts: artifacts as any[],
          message: `Job ${input.jobId}: ${(job as any).status ?? "unknown"} (${(job as any).software ?? "?"})`,
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
