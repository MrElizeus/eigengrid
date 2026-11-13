import { z } from "zod";
export const sessionIdSchema = z.string().uuid();
export const openSchema = z
  .object({
    projectId: z.string().min(1).max(160),
    missionId: z.string().min(1).max(160),
    prompt: z.string().trim().min(1).max(100_000),
    requestId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/u)
      .optional(),
  })
  .strict();
export const approvalSchema = z
  .object({
    callId: z.string().min(1).max(128),
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    cursor: z
      .object({
        sequence: z.number().int().positive(),
        digest: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    ttlSeconds: z.number().int().min(1).max(900),
  })
  .strict();
