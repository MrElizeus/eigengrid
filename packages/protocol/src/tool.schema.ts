import { z } from "zod";

export const ToolResultSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      hint: z.string().optional(),
    })
    .optional(),
});

export const ToolInputSchema = z.record(z.unknown());

export type ToolResultType = z.infer<typeof ToolResultSchema>;
