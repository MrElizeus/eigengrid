import { z } from "zod";
import { DigestSchema, SemverSchema } from "../schemas";

export const EngineBuildIdentitySchema = z
  .object({
    engine: z.string().min(1),
    executable: z.string().min(1),
    version: z.string().min(1),
    buildDigest: DigestSchema,
    environmentDigest: DigestSchema,
    compatibilityVersion: SemverSchema,
  })
  .strict();

export type EngineBuildIdentity = z.infer<typeof EngineBuildIdentitySchema>;
