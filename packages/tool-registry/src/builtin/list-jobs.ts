import { z } from "zod";
import type { Tool } from "../types";

const listJobsInput = z.object({
  status: z
    .enum(["created", "queued", "staged", "running", "completed", "failed", "cancelled", "parsed"])
    .optional()
    .describe("Filter by job status (optional)"),
  limit: z.number().optional().describe("Max number of jobs to return (default: 20)"),
});

const listJobsOutput = z.object({
  jobs: z.array(z.any()),
  total: z.number(),
});

export const listJobsTool: Tool<z.infer<typeof listJobsInput>, z.infer<typeof listJobsOutput>> = {
  name: "list-jobs",
  description: "List computational chemistry jobs with optional status filter",
  inputSchema: listJobsInput,
  outputSchema: listJobsOutput,
  async execute(ctx, input) {
    try {
      let jobs = await ctx.db.listJobs();

      if (input.status) {
        jobs = jobs.filter((j: any) => j.status === input.status);
      }

      const limit = input.limit ?? 20;
      const limited = jobs.slice(0, limit);

      return {
        ok: true,
        data: {
          jobs: limited,
          total: jobs.length,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "LIST_ERROR",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
};
