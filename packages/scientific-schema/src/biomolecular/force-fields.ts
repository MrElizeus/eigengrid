import { z } from "zod";
import { DigestSchema, IdSchema, TimestampSchema } from "../schemas";
import { ForceFieldStackSchemaVersion } from "./common";
import { canonicalSelfDigest, ScientificSchemaDigestMismatchError } from "./digests";

export const ForceFieldParameterSetSchema = z
  .object({
    id: IdSchema,
    family: z.string().min(1),
    version: z.string().min(1),
    source: z.string().min(1),
    sourceEvidenceRefs: z.array(IdSchema).min(1),
    parameterDigest: DigestSchema,
    knownLimitations: z.array(z.string().min(1)),
  })
  .strict();

export type ForceFieldParameterSet = z.infer<typeof ForceFieldParameterSetSchema>;

export const ForceFieldStackManifestSchema = z
  .object({
    schemaVersion: z.literal(ForceFieldStackSchemaVersion),
    id: IdSchema,
    revision: z.number().int().positive(),
    protein: ForceFieldParameterSetSchema,
    lipid: ForceFieldParameterSetSchema,
    ligands: z.array(
      z
        .object({
          componentId: IdSchema,
          parameterSet: ForceFieldParameterSetSchema,
          chargeMethod: z.string().min(1),
          chargeMethodVersion: z.string().min(1),
          formalCharge: z.number().int(),
          atomTypeDigest: DigestSchema,
          chargeDigest: DigestSchema,
        })
        .strict(),
    ),
    water: z
      .object({
        model: z.string().min(1),
        parameterSet: ForceFieldParameterSetSchema,
      })
      .strict(),
    ions: ForceFieldParameterSetSchema,
    cofactors: z.array(
      z.object({ componentId: IdSchema, parameterSet: ForceFieldParameterSetSchema }).strict(),
    ),
    engineCompatibility: z
      .array(z.object({ engine: z.string().min(1), versionRange: z.string().min(1) }).strict())
      .min(1),
    compatibilityEvidenceRefs: z.array(IdSchema).min(1),
    knownLimitations: z.array(z.string().min(1)),
    stackDigest: DigestSchema,
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    const ligandIds = manifest.ligands.map((entry) => entry.componentId);
    if (new Set(ligandIds).size !== ligandIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ligands"],
        message: "A force-field stack may define each ligand component only once",
      });
    }
    const cofactorIds = manifest.cofactors.map((entry) => entry.componentId);
    if (new Set(cofactorIds).size !== cofactorIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cofactors"],
        message: "A force-field stack may define each cofactor component only once",
      });
    }
  });

export type ForceFieldStackManifest = z.infer<typeof ForceFieldStackManifestSchema>;

/** Digests the complete force-field stack except its canonical self-digest. */
export function computeForceFieldStackDigest(value: object): string {
  return canonicalSelfDigest(value, "stackDigest");
}

/** Validates a force-field stack schema and its immutable canonical identity. */
export function assertForceFieldStackDigest(value: unknown): ForceFieldStackManifest {
  const stack = ForceFieldStackManifestSchema.parse(value);
  const observedDigest = computeForceFieldStackDigest(stack);
  if (observedDigest !== stack.stackDigest) {
    throw new ScientificSchemaDigestMismatchError(
      "ForceFieldStackManifest",
      stack.id,
      stack.stackDigest,
      observedDigest,
    );
  }
  return stack;
}
