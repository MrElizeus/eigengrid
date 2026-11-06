import { z } from "zod";
import { DigestSchema, IdSchema } from "../schemas";
import { BiomolecularComponentSchemaVersion } from "./common";

const ComponentReferenceBaseShape = {
  schemaVersion: z.literal(BiomolecularComponentSchemaVersion),
  id: IdSchema,
  revision: z.number().int().positive(),
  name: z.string().min(1),
  sourceEvidenceRefs: z.array(IdSchema).min(1),
  coordinateDigest: DigestSchema,
  atomCount: z.number().int().positive(),
  moleculeCount: z.number().int().positive(),
  /** Aggregate formal charge for every copy represented by this component. */
  formalCharge: z.number().int(),
} as const;

export const ProteinComponentReferenceSchema = z
  .object({
    ...ComponentReferenceBaseShape,
    kind: z.literal("protein"),
    role: z.enum(["receptor", "fusion", "partner", "other"]),
    chainIds: z.array(z.string().min(1).max(8)).min(1),
    residueCount: z.number().int().positive(),
    sequenceDigest: DigestSchema,
    /** Exact receptor protonation decision required by durable system publication. */
    protonationDecisionId: IdSchema.optional(),
  })
  .strict()
  .superRefine((component, context) => {
    if (new Set(component.chainIds).size !== component.chainIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chainIds"],
        message: "Protein chain identifiers must be unique",
      });
    }
  });

export type ProteinComponentReference = z.infer<typeof ProteinComponentReferenceSchema>;

export const LigandComponentReferenceSchema = z
  .object({
    ...ComponentReferenceBaseShape,
    kind: z.literal("ligand"),
    pubchemCid: z.number().int().positive().optional(),
    inchiKey: z
      .string()
      .regex(/^[A-Z]{14}-[A-Z]{10}-[A-Z]$/u, "Expected a standard upper-case InChIKey"),
    canonicalSmiles: z.string().min(1).optional(),
    stereochemistry: z.string().min(1),
    microstateDecisionId: IdSchema,
    poseDecisionId: IdSchema,
  })
  .strict();

export type LigandComponentReference = z.infer<typeof LigandComponentReferenceSchema>;

export const LipidComponentReferenceSchema = z
  .object({
    ...ComponentReferenceBaseShape,
    kind: z.literal("lipid"),
    residueName: z.string().min(1).max(8),
    lipidIdentity: z.string().min(1),
  })
  .strict();

export type LipidComponentReference = z.infer<typeof LipidComponentReferenceSchema>;

export const WaterComponentReferenceSchema = z
  .object({
    ...ComponentReferenceBaseShape,
    kind: z.literal("water"),
    waterModel: z.string().min(1),
  })
  .strict()
  .superRefine((component, context) => {
    if (component.formalCharge !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["formalCharge"],
        message: "A water component must have aggregate formal charge zero",
      });
    }
  });

export type WaterComponentReference = z.infer<typeof WaterComponentReferenceSchema>;

export const IonComponentReferenceSchema = z
  .object({
    ...ComponentReferenceBaseShape,
    kind: z.literal("ion"),
    element: z.string().regex(/^[A-Z][a-z]?$/u, "Expected an element symbol"),
    perIonFormalCharge: z
      .number()
      .int()
      .refine((charge) => charge !== 0, {
        message: "An ion must have a non-zero per-ion formal charge",
      }),
  })
  .strict()
  .superRefine((component, context) => {
    if (component.formalCharge !== component.perIonFormalCharge * component.moleculeCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["formalCharge"],
        message: "Aggregate ion charge must equal per-ion charge times molecule count",
      });
    }
  });

export type IonComponentReference = z.infer<typeof IonComponentReferenceSchema>;

export const CofactorComponentReferenceSchema = z
  .object({
    ...ComponentReferenceBaseShape,
    kind: z.literal("cofactor"),
    chemicalIdentity: z.string().min(1),
    residueNames: z.array(z.string().min(1).max(8)).min(1),
  })
  .strict();

export type CofactorComponentReference = z.infer<typeof CofactorComponentReferenceSchema>;

export const BiomolecularComponentReferenceSchema = z.union([
  ProteinComponentReferenceSchema,
  LigandComponentReferenceSchema,
  LipidComponentReferenceSchema,
  WaterComponentReferenceSchema,
  IonComponentReferenceSchema,
  CofactorComponentReferenceSchema,
]);

export type BiomolecularComponentReference = z.infer<typeof BiomolecularComponentReferenceSchema>;
