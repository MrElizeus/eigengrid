import { z } from "zod";
import type { Tool } from "../types";
import type { RecipeRegistry } from "../../../../apps/cli/src/composition/types";
import { LocalRunner } from "@eigengrid/runners";
import { generateId } from "@eigengrid/core";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const submitJobInput = z.object({
  software: z.enum(["gaussian", "orca", "xtb", "cp2k"]).describe("Software to run"),
  inputPath: z.string().describe("Path to input file"),
  name: z.string().optional().describe("Job name"),
  runner: z
    .enum(["local"])
    .optional()
    .describe("Runner (default: local, only local supported for now)"),
  nodeId: z.string().optional().describe("Target node"),
});

const submitJobOutput = z.object({
  ok: z.boolean(),
  jobId: z.string().optional(),
  message: z.string().optional(),
});

export const submitJobTool: Tool<
  z.infer<typeof submitJobInput>,
  z.infer<typeof submitJobOutput>
> = {
  name: "submit-job",
  description: "Submit a computational chemistry job for execution on a runner",
  inputSchema: submitJobInput,
  outputSchema: submitJobOutput,
  async execute(ctx, input) {
    // Production composition supplies the canonical coordinator. Keep the
    // legacy construction below only for isolated test/compatibility contexts
    // that intentionally omit the execution boundary.
    if (ctx.execution?.executeLocal) {
      const result = await ctx.execution.executeLocal({
        software: input.software,
        inputPath: input.inputPath,
        name: input.name,
        expectedInputDigest: createHash("sha256")
          .update(readFileSync(input.inputPath))
          .digest("hex"),
      });
      return {
        ok: true,
        data: result.ok
          ? { ok: true, jobId: result.jobId, message: `Job ${result.jobId} submitted` }
          : { ok: false, jobId: result.jobId, message: result.message },
      };
    }

    const { ExecutionCoordinator } =
      await import("../../../../apps/cli/src/services/execution-coordinator");
    const { loadBuiltinRecipes, findRunnableRecipe } = await import("@eigengrid/recipes");

    // Minimal RecipeRegistry loading builtin recipes
    const builtinRecipes = loadBuiltinRecipes();
    const recipes: RecipeRegistry = {
      recipes: builtinRecipes,
      find: (id: string) => builtinRecipes.find((r) => r.id === id),
      findRunnable: (software, runner, inputExtension, recipeId) =>
        findRunnableRecipe([...builtinRecipes], software, runner, inputExtension, recipeId),
    };

    const coord = new ExecutionCoordinator({
      db: ctx.db,
      config: ctx.config,
      recipes,
      clock: Date.now,
      idGenerator: generateId,
      localBackendFactory: (plan, db, executor) =>
        new LocalRunner({
          database: db,
          engines: {
            [plan.job.software]: {
              command: plan.program,
              args: plan.args,
              displayCommand: plan.displayCommand,
            },
          },
          executor,
        }),
    });

    const result = await coord.executeLocal({
      software: input.software,
      inputPath: input.inputPath,
      name: input.name,
    });

    return {
      ok: true,
      data: result.ok
        ? { ok: true, jobId: result.jobId, message: `Job ${result.jobId} submitted` }
        : { ok: false, jobId: result.jobId, message: result.message },
    };
  },
};
