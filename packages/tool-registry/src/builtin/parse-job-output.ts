import { z } from "zod";
import type { Tool } from "../types";
import { resolveParsePath } from "./parse-path";

const parseJobOutputInput = z.object({
  jobId: z.string().describe("Job ID to parse output for"),
  attemptId: z.string().describe("Exact job attempt that produced the output"),
});

const parseJobOutputOutput = z.object({
  ok: z.boolean(),
  parser: z.string().optional(),
  status: z.string().optional(),
  energyHartree: z.number().optional(),
  message: z.string().optional(),
  error: z.string().optional(),
});

export const parseJobOutputTool: Tool<
  z.infer<typeof parseJobOutputInput>,
  z.infer<typeof parseJobOutputOutput>
> = {
  name: "parse-job-output",
  description: "Parse the output of a completed job and persist the results",
  inputSchema: parseJobOutputInput,
  outputSchema: parseJobOutputOutput,
  async execute(ctx, input) {
    // Production composition routes parsing through the coordinator, which
    // owns exact-attempt binding, idempotent result persistence, and lifecycle
    // transitions.  The legacy body below remains only for isolated contexts
    // that intentionally omit that authority boundary.
    if (ctx.execution?.parseJob) {
      const result = await ctx.execution.parseJob(input.jobId, input.attemptId);
      return {
        ok: true,
        data: {
          ok: result.ok,
          parser: result.parser,
          message: result.message,
          ...(result.resultId ? { status: "completed" } : {}),
          ...(result.ok ? {} : { error: result.message }),
        },
      };
    }
    try {
      const job = await ctx.db.getJob(input.jobId);
      if (!job) {
        return { ok: false, error: { code: "NOT_FOUND", message: `Job ${input.jobId} not found` } };
      }

      const software = String(job.software ?? "unknown");
      const attempt = (await ctx.db.listJobAttempts(input.jobId)).find(
        (candidate) => candidate.id === input.attemptId,
      );
      if (!attempt) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Attempt ${input.attemptId} not found for job ${input.jobId}`,
          },
        };
      }

      const roots = [ctx.config.jobsDir, ctx.config.outputsDir];
      let pathResult: ReturnType<typeof resolveParsePath> | undefined;
      const artifacts = await ctx.db.listArtifacts(input.jobId);
      for (const artifact of artifacts) {
        if (artifact.kind !== "output" || artifact.attemptId !== attempt.id) continue;
        const candidate = resolveParsePath(String(artifact.path), roots);
        pathResult = candidate;
        if (candidate.ok) {
          break;
        }
      }

      if (!pathResult?.ok) {
        return {
          ok: false,
          error: {
            code: pathResult ? "INVALID_PATH" : "NO_OUTPUT",
            message: `No safe output file found for attempt ${attempt.id}`,
          },
        };
      }

      await ctx.db.appendEvent({
        id: crypto.randomUUID?.() ?? `${Date.now()}-parse`,
        type: "parse.started",
        at: Date.now(),
        source: "parser",
        jobId: input.jobId,
        attemptId: attempt.id,
      });

      const parseResult = await ctx.python.parse(software, pathResult.path);

      if (!parseResult.ok) {
        await ctx.db.appendEvent({
          id: crypto.randomUUID?.() ?? `${Date.now()}-parse-fail`,
          type: "parse.failed",
          at: Date.now(),
          source: "parser",
          jobId: input.jobId,
          attemptId: attempt.id,
          payload: { error: parseResult.error?.message ?? "Parse failed" },
        });
        return {
          ok: true,
          data: {
            ok: false,
            parser: software,
            status: parseResult.status,
            error: parseResult.error?.message ?? "Parse failed",
          },
        };
      }

      const parseData = (parseResult.data ?? {}) as Record<string, unknown>;

      const resultId = await ctx.db.saveResult({
        jobId: input.jobId,
        attemptId: attempt.id,
        parser: software,
        status: parseResult.status,
        energyHartree:
          parseData.energy_hartree != null ? Number(parseData.energy_hartree) : undefined,
        scfConverged:
          parseData.scf_converged != null ? Boolean(parseData.scf_converged) : undefined,
        imaginaryFrequencies:
          parseData.imaginary_frequencies != null
            ? Number(parseData.imaginary_frequencies)
            : undefined,
        normalTermination:
          parseData.normal_termination != null ? Boolean(parseData.normal_termination) : undefined,
        warnings: Array.isArray(parseData.warnings) ? (parseData.warnings as string[]) : undefined,
        errors: Array.isArray(parseData.errors) ? (parseData.errors as string[]) : undefined,
        raw: parseData.raw ? (parseData.raw as Record<string, unknown>) : undefined,
      });

      await ctx.db.appendEvent({
        id: crypto.randomUUID?.() ?? `${Date.now()}-result`,
        type: "result.saved",
        at: Date.now(),
        source: "parser",
        jobId: input.jobId,
        attemptId: attempt.id,
        resultId,
      });

      await ctx.db.appendEvent({
        id: crypto.randomUUID?.() ?? `${Date.now()}-parse-done`,
        type: "parse.completed",
        at: Date.now(),
        source: "parser",
        jobId: input.jobId,
        attemptId: attempt.id,
      });

      return {
        ok: true,
        data: {
          ok: true,
          parser: software,
          status: parseResult.status,
          energyHartree:
            parseData.energy_hartree != null ? Number(parseData.energy_hartree) : undefined,
          message: `Parsed ${software} output for job ${input.jobId}`,
        },
      };
    } catch (err) {
      return { ok: false, error: { code: "INTERNAL", message: String(err) } };
    }
  },
};
