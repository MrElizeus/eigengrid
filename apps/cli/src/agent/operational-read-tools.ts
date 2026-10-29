import { loadBuiltinRecipes } from "@eigengrid/recipes";
import type { ListEventsFilter } from "@eigengrid/db";
import type { Tool } from "@eigengrid/tool-registry";
import { z } from "zod";

const jobId = z.string().min(1).max(160).describe("Exact job ID or unambiguous prefix");

const listArtifactsInput = z.object({ jobId });
const listArtifactsOutput = z.object({
  jobId: z.string(),
  artifacts: z.array(z.any()),
  total: z.number().int().nonnegative(),
});

export const listArtifactsTool: Tool<
  z.infer<typeof listArtifactsInput>,
  z.infer<typeof listArtifactsOutput>
> = {
  name: "list-artifacts",
  description: "List persisted artifacts for one job using an exact ID or unambiguous prefix",
  inputSchema: listArtifactsInput,
  outputSchema: listArtifactsOutput,
  async execute(ctx, input) {
    try {
      const resolvedJobId = await ctx.db.resolveJobId(input.jobId);
      const artifacts = await ctx.db.listArtifacts(resolvedJobId);
      return { ok: true, data: { jobId: resolvedJobId, artifacts, total: artifacts.length } };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "LIST_ARTIFACTS_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  },
};

const listResultsInput = z.object({
  jobId,
  attemptId: z.string().min(1).max(160).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
const listResultsOutput = z.object({
  jobId: z.string(),
  results: z.array(z.any()),
  total: z.number().int().nonnegative(),
});

export const listResultsTool: Tool<
  z.infer<typeof listResultsInput>,
  z.infer<typeof listResultsOutput>
> = {
  name: "list-results",
  description: "List parsed scientific results for a job and optional attempt",
  inputSchema: listResultsInput,
  outputSchema: listResultsOutput,
  async execute(ctx, input) {
    try {
      const resolvedJobId = await ctx.db.resolveJobId(input.jobId);
      const results = await ctx.db.listResults(resolvedJobId, input.attemptId);
      return {
        ok: true,
        data: {
          jobId: resolvedJobId,
          results: results.slice(-(input.limit ?? 20)),
          total: results.length,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "LIST_RESULTS_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  },
};

const listEventsInput = z.object({
  jobId: jobId.optional(),
  type: z.string().min(1).max(160).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
const listEventsOutput = z.object({
  jobId: z.string().optional(),
  events: z.array(z.any()),
  total: z.number().int().nonnegative(),
});

export const listEventsTool: Tool<
  z.infer<typeof listEventsInput>,
  z.infer<typeof listEventsOutput>
> = {
  name: "list-events",
  description:
    "Read the earliest persisted events in database sequence, optionally scoped to one job and event type. The limit and count cover returned events, not the full history.",
  inputSchema: listEventsInput,
  outputSchema: listEventsOutput,
  async execute(ctx, input) {
    try {
      const resolvedJobId = input.jobId ? await ctx.db.resolveJobId(input.jobId) : undefined;
      const limit = input.limit ?? 50;
      const events = await ctx.db.listEvents({
        jobId: resolvedJobId,
        type: input.type as ListEventsFilter["type"],
        limit,
      });
      return {
        ok: true,
        data: {
          ...(resolvedJobId ? { jobId: resolvedJobId } : {}),
          events,
          total: events.length,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "LIST_EVENTS_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  },
};

const listRecipesInput = z.object({
  software: z.string().min(1).max(80).optional(),
});
const listRecipesOutput = z.object({
  recipes: z.array(
    z.object({
      id: z.string(),
      software: z.string(),
      description: z.string(),
      inputExtensions: z.array(z.string()),
      runners: z.array(z.string()),
      parser: z.string(),
      defaultCores: z.number(),
      defaultMemoryGb: z.number(),
    }),
  ),
  total: z.number().int().nonnegative(),
});

export const listRecipesTool: Tool<
  z.infer<typeof listRecipesInput>,
  z.infer<typeof listRecipesOutput>
> = {
  name: "list-recipes",
  description:
    "List execution templates and supported runners. Templates are command mappings, not reviewed scientific protocols; use list-protocols for scientific methodology.",
  inputSchema: listRecipesInput,
  outputSchema: listRecipesOutput,
  async execute(_ctx, input) {
    const software = input.software?.toLowerCase();
    const recipes = loadBuiltinRecipes()
      .filter((recipe) => !software || recipe.software.toLowerCase() === software)
      .map((recipe) => ({
        id: recipe.id,
        software: recipe.software,
        description: recipe.description,
        inputExtensions: recipe.inputExtensions,
        runners: Object.keys(recipe.commands).sort(),
        parser: recipe.parser.name,
        defaultCores: recipe.resources.defaultCores,
        defaultMemoryGb: recipe.resources.defaultMemoryGb,
      }));
    return { ok: true, data: { recipes, total: recipes.length } };
  },
};
