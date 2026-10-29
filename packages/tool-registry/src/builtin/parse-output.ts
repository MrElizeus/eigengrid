import { z } from "zod";
import { ParseResultDataSchema } from "@eigengrid/protocol";
import type { Tool } from "../types";
import { resolveParsePath } from "./parse-path";

const parseOutputInput = z.object({
  software: z.enum(["gaussian", "orca", "xtb", "cp2k"]),
  outputPath: z.string(),
});

const parseOutputOutput = z.object({
  parser: z.string(),
  status: z.enum(["completed", "failed", "partial", "unknown"]),
  data: ParseResultDataSchema.optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      hint: z.string().optional(),
    })
    .optional(),
});

/**
 * Parse a computational chemistry output file through the Python bridge.
 *
 * Routes through `ctx.python.parse()` which invokes the Python CLI
 * (`python -m eigengrid_chem parse ...`) and validates the response
 * against the canonical ParseResultDataSchema.
 */
export const parseOutputTool: Tool<
  z.infer<typeof parseOutputInput>,
  z.infer<typeof parseOutputOutput>
> = {
  name: "parse-output",
  description: "Parse a computational chemistry output file and return structured results",
  inputSchema: parseOutputInput,
  outputSchema: parseOutputOutput,
  async execute(ctx, input) {
    const pathResult = resolveParsePath(input.outputPath, [
      ctx.config.jobsDir,
      ctx.config.outputsDir,
    ]);
    if (!pathResult.ok) {
      return { ok: false, error: { code: "INVALID_PATH", message: pathResult.message } };
    }

    const result = await ctx.python.parse(input.software, pathResult.path);
    if (result.ok) {
      return {
        ok: true,
        data: {
          parser: result.parser,
          status: result.status,
          data: result.data as z.infer<typeof ParseResultDataSchema> | undefined,
        },
      };
    }
    return {
      ok: true,
      data: {
        parser: result.parser,
        status: result.status,
        error: result.error,
      },
    };
  },
};
