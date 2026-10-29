import { z } from "zod";

export const ChemistryResultSchema = z.object({
  jobId: z.string(),
  attemptId: z.string(),
  parser: z.enum(["gaussian", "orca", "xtb", "cp2k"]),
  status: z.enum(["completed", "failed", "partial", "unknown"]),
  energyHartree: z.number().optional(),
  scfConverged: z.boolean().optional(),
  imaginaryFrequencies: z.number().optional(),
  normalTermination: z.boolean().optional(),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
  raw: z.record(z.unknown()),
});
