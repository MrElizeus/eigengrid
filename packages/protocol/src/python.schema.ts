import { z } from "zod";
import { ParseResultDataSchema, ExcitationSchema } from "./parse-result.schema";

// ------------------------------------------------------------
// Parse Response
// ------------------------------------------------------------

export const PythonParseResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    parser: z.string(),
    status: z.enum(["completed", "failed", "partial", "unknown"]),
    data: ParseResultDataSchema,
  }),
  z.object({
    ok: z.literal(false),
    parser: z.string(),
    status: z.enum(["completed", "failed", "partial", "unknown"]),
    error: z.object({
      code: z.string(),
      message: z.string(),
      hint: z.string().optional(),
    }),
  }),
]);

// ------------------------------------------------------------
// Generate Response
// ------------------------------------------------------------

export const PythonGenerateResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    data: z.record(z.unknown()).optional(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.string(),
      message: z.string(),
      hint: z.string().optional(),
    }),
  }),
]);

// ------------------------------------------------------------
// Conformer Response
// ------------------------------------------------------------

export const PythonConformerResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    conformers: z.number().optional(),
    data: z.record(z.unknown()).optional(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.string(),
      message: z.string(),
      hint: z.string().optional(),
    }),
  }),
]);

// ------------------------------------------------------------
// Type Exports
// ------------------------------------------------------------

export type PythonParseResponse = z.infer<typeof PythonParseResponseSchema>;
export type PythonGenerateResponse = z.infer<typeof PythonGenerateResponseSchema>;
export type PythonConformerResponse = z.infer<typeof PythonConformerResponseSchema>;

export { ParseResultDataSchema, ExcitationSchema };
export type { ParseResultData } from "./parse-result.schema";
