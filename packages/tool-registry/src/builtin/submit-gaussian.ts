import { z } from "zod";
import type { Tool } from "../types";

const submitJobInput = z.object({
  software: z
    .enum(["gaussian", "orca", "xtb", "cp2k"])
    .describe("Computational chemistry software to use"),
  inputPath: z.string().describe("Path to the input file"),
  name: z.string().optional().describe("Job name (auto-generated if omitted)"),
  runner: z
    .enum(["local", "ssh", "slurm", "pbs"])
    .optional()
    .describe("Runner type (default: local)"),
  nodeId: z.string().optional().describe("Target compute node ID"),
});

const submitJobOutput = z.object({
  ok: z.boolean(),
  jobId: z.string().optional(),
  message: z.string().optional(),
});

export const submitGaussianTool: Tool<
  z.infer<typeof submitJobInput>,
  z.infer<typeof submitJobOutput>
> = {
  name: "submit-gaussian",
  description:
    "Submit a computational chemistry job (Gaussian, ORCA, xTB, or CP2K) to a runner for execution",
  inputSchema: submitJobInput,
  outputSchema: submitJobOutput,
  async execute(ctx, input) {
    // Deprecated compatibility tool: if invoked from the production
    // composition, delegate to the canonical coordinator rather than
    // mutating jobs directly.  The legacy body is retained for old isolated
    // test contexts only.
    if (ctx.execution?.executeLocal) {
      const result = await ctx.execution.executeLocal({
        software: input.software,
        inputPath: input.inputPath,
        name: input.name,
      });
      return {
        ok: true,
        data: result.ok
          ? { ok: true, jobId: result.jobId, message: result.message ?? "Job submitted" }
          : { ok: false, jobId: result.jobId, message: result.message },
      };
    }
    const { existsSync } = await import("fs");
    const { basename } = await import("path");

    // Validate input file exists
    if (!existsSync(input.inputPath)) {
      return {
        ok: false,
        error: {
          code: "FILE_NOT_FOUND",
          message: `Input file not found: ${input.inputPath}`,
          hint: "Provide the full path to the input file.",
        },
      };
    }

    const jobId = `j-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const jobName = input.name ?? `${input.software}-${basename(input.inputPath, ".inp")}`;
    try {
      // Create job in DB
      await ctx.db.createJob({
        id: jobId,
        name: jobName,
        software: input.software,
        inputPath: input.inputPath,
        workdir: ctx.config.jobsDir,
      });

      // Emit event
      ctx.bus.emit({ type: "job:created", jobId, at: Date.now() });

      // Update status to queued
      await ctx.db.updateJobStatus(jobId, "queued");
      ctx.bus.emit({
        type: "job:status:changed",
        jobId,
        from: "created",
        to: "queued",
        at: Date.now(),
      });

      return {
        ok: true,
        data: {
          ok: true,
          jobId,
          message: `Job '${jobName}' (${jobId}) submitted with ${input.software} on ${input.runner} runner.`,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "SUBMIT_ERROR",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
};
