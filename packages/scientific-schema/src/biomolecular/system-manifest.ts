import { z } from "zod";
import { DigestSchema, IdSchema, TimestampSchema } from "../schemas";
import {
  BiomolecularSystemManifestSchemaVersion,
  PublishedBiomolecularSystemManifestSchemaVersion,
  StrictActorIdentitySchema,
  UniqueIds,
} from "./common";
import {
  type BiomolecularComponentReference,
  CofactorComponentReferenceSchema,
  IonComponentReferenceSchema,
  LigandComponentReferenceSchema,
  LipidComponentReferenceSchema,
  ProteinComponentReferenceSchema,
  WaterComponentReferenceSchema,
} from "./components";
import { BiomolecularDecisionReferenceSchema } from "./decisions";
import { canonicalSelfDigest, ScientificSchemaDigestMismatchError } from "./digests";

export const PeriodicBoxSchema = z
  .object({
    shape: z.enum(["orthorhombic", "triclinic", "truncated_octahedron"]),
    lengthsAngstrom: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
    anglesDegrees: z.tuple([
      z.number().gt(0).lt(180),
      z.number().gt(0).lt(180),
      z.number().gt(0).lt(180),
    ]),
    periodic: z.literal(true),
  })
  .strict()
  .superRefine((box, context) => {
    if (
      box.shape === "orthorhombic" &&
      box.anglesDegrees.some((angle) => Math.abs(angle - 90) > 1e-6)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["anglesDegrees"],
        message: "An orthorhombic box must have 90-degree angles",
      });
    }
  });

export type PeriodicBox = z.infer<typeof PeriodicBoxSchema>;

export const MembraneDefinitionSchema = z
  .object({
    orientationProvider: z.string().min(1),
    orientationProviderVersion: z.string().min(1),
    orientationEvidenceRef: IdSchema,
    orientationDigest: DigestSchema,
    normalVector: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
    hydrophobicThicknessAngstrom: z.number().positive(),
    composition: z
      .array(
        z
          .object({
            lipidComponentId: IdSchema,
            upperLeafletCount: z.number().int().nonnegative(),
            lowerLeafletCount: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((membrane, context) => {
    const length = Math.hypot(...membrane.normalVector);
    if (Math.abs(length - 1) > 1e-6) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["normalVector"],
        message: "The membrane normal must be a unit vector",
      });
    }
    const lipidIds = membrane.composition.map((entry) => entry.lipidComponentId);
    if (new Set(lipidIds).size !== lipidIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["composition"],
        message: "A membrane composition may list each lipid component only once",
      });
    }
    if (
      membrane.composition.some((entry) => entry.upperLeafletCount + entry.lowerLeafletCount === 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["composition"],
        message: "Each membrane lipid must occur in at least one leaflet",
      });
    }
  });

export type MembraneDefinition = z.infer<typeof MembraneDefinitionSchema>;

export const BiomolecularSystemManifestSchema = z
  .object({
    schemaVersion: z.union([
      z.literal(BiomolecularSystemManifestSchemaVersion),
      z.literal(PublishedBiomolecularSystemManifestSchemaVersion),
    ]),
    id: IdSchema,
    revision: z.number().int().positive(),
    missionId: IdSchema,
    name: z.string().min(1),
    sourceEvidenceRefs: z.array(IdSchema).min(1),
    constructDecisionId: IdSchema,
    /** Required by the durable publication boundary; optional here for legacy draft parsing. */
    forceFieldStackDecisionId: IdSchema.optional(),
    membraneModelDecisionId: IdSchema.optional(),
    decisionRefs: z.array(BiomolecularDecisionReferenceSchema).min(1),
    components: z
      .object({
        proteins: z.array(ProteinComponentReferenceSchema).min(1),
        ligands: z.array(LigandComponentReferenceSchema),
        lipids: z.array(LipidComponentReferenceSchema),
        waters: z.array(WaterComponentReferenceSchema).min(1),
        ions: z.array(IonComponentReferenceSchema),
        cofactors: z.array(CofactorComponentReferenceSchema),
      })
      .strict(),
    membrane: MembraneDefinitionSchema.nullable(),
    environment: z
      .object({
        targetPh: z.number().min(0).max(14),
        targetTemperatureKelvin: z.number().positive(),
        targetPressureBar: z.number().positive(),
        targetIonicStrengthMolar: z.number().nonnegative(),
      })
      .strict(),
    forceFieldStack: z
      .object({
        id: IdSchema,
        revision: z.number().int().positive(),
        digest: DigestSchema,
      })
      .strict(),
    topologyDigest: DigestSchema,
    coordinateDigest: DigestSchema,
    atomMapDigest: DigestSchema,
    totalCharge: z.number().int(),
    atomCount: z.number().int().positive(),
    box: PeriodicBoxSchema,
    provenance: z
      .object({
        parentManifestId: IdSchema.optional(),
        parentManifestRevision: z.number().int().positive().optional(),
        operationId: IdSchema,
        operationReceiptId: IdSchema.optional(),
        builder: z.object({ name: z.string().min(1), version: z.string().min(1) }).strict(),
        createdBy: StrictActorIdentitySchema,
        createdAt: TimestampSchema,
      })
      .strict(),
    manifestDigest: DigestSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    const components: BiomolecularComponentReference[] = [
      ...manifest.components.proteins,
      ...manifest.components.ligands,
      ...manifest.components.lipids,
      ...manifest.components.waters,
      ...manifest.components.ions,
      ...manifest.components.cofactors,
    ];
    if (!UniqueIds(components)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["components"],
        message: "Component identifiers must be unique across the complete system",
      });
    }
    if (!UniqueIds(manifest.decisionRefs)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decisionRefs"],
        message: "A system manifest may bind each approved decision only once",
      });
    }
    const published = manifest.schemaVersion === PublishedBiomolecularSystemManifestSchemaVersion;
    const receptorComponents = manifest.components.proteins.filter(
      (component) => component.role === "receptor",
    );
    if (!published) {
      if (
        manifest.forceFieldStackDecisionId !== undefined ||
        manifest.membraneModelDecisionId !== undefined ||
        receptorComponents.some((component) => component.protonationDecisionId !== undefined) ||
        manifest.decisionRefs.some((reference) =>
          ["force_field_stack", "membrane_model", "protonation"].includes(reference.kind),
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["schemaVersion"],
          message: "Draft manifest v1 cannot carry durable v2 decision authority",
        });
      }
    } else {
      if (manifest.forceFieldStackDecisionId === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["forceFieldStackDecisionId"],
          message: "Published manifest v2 requires an exact force-field stack decision",
        });
      }
      for (const receptor of receptorComponents) {
        if (receptor.protonationDecisionId === undefined) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["components", "proteins"],
            message: `Published receptor ${receptor.id} requires a protonation decision`,
          });
        }
      }
      if ((manifest.membrane !== null) !== (manifest.membraneModelDecisionId !== undefined)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["membraneModelDecisionId"],
          message: "Published membrane and exact membrane-model decision must occur together",
        });
      }
      if (manifest.decisionRefs.some((reference) => reference.kind === "other")) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["decisionRefs"],
          message: "Published manifest v2 accepts only typed scientific decisions",
        });
      }
    }
    const constructReference = manifest.decisionRefs.find(
      (decision) => decision.id === manifest.constructDecisionId,
    );
    if (!constructReference || constructReference.kind !== "construct") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["constructDecisionId"],
        message: "Construct decision id must resolve to an exact approved construct reference",
      });
    }
    if (manifest.forceFieldStackDecisionId !== undefined) {
      const stackReference = manifest.decisionRefs.find(
        (decision) => decision.id === manifest.forceFieldStackDecisionId,
      );
      if (!stackReference || stackReference.kind !== "force_field_stack") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["forceFieldStackDecisionId"],
          message: "Force-field decision id must resolve to an exact force-field reference",
        });
      }
    }
    if (manifest.membraneModelDecisionId !== undefined) {
      const membraneReference = manifest.decisionRefs.find(
        (decision) => decision.id === manifest.membraneModelDecisionId,
      );
      if (!membraneReference || membraneReference.kind !== "membrane_model") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["membraneModelDecisionId"],
          message: "Membrane decision id must resolve to an exact membrane-model reference",
        });
      }
    }
    for (const receptor of manifest.components.proteins.filter(
      (component) => component.role === "receptor",
    )) {
      if (receptor.protonationDecisionId !== undefined) {
        const protonationReference = manifest.decisionRefs.find(
          (decision) => decision.id === receptor.protonationDecisionId,
        );
        if (!protonationReference || protonationReference.kind !== "protonation") {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["components", "proteins"],
            message: `Receptor ${receptor.id} protonation id lacks an exact protonation reference`,
          });
        }
      }
    }
    for (const ligand of manifest.components.ligands) {
      const microstateReference = manifest.decisionRefs.find(
        (decision) => decision.id === ligand.microstateDecisionId,
      );
      const poseReference = manifest.decisionRefs.find(
        (decision) => decision.id === ligand.poseDecisionId,
      );
      if (!microstateReference || microstateReference.kind !== "microstate") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["decisionRefs"],
          message: `Ligand ${ligand.id} lacks an exact approved microstate reference`,
        });
      }
      if (!poseReference || poseReference.kind !== "pose") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["decisionRefs"],
          message: `Ligand ${ligand.id} lacks an exact approved pose reference`,
        });
      }
    }
    const calculatedAtomCount = components.reduce(
      (total, component) => total + component.atomCount,
      0,
    );
    if (calculatedAtomCount !== manifest.atomCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["atomCount"],
        message: "System atom count must equal the sum of component atom counts",
      });
    }
    const calculatedCharge = components.reduce(
      (total, component) => total + component.formalCharge,
      0,
    );
    if (calculatedCharge !== manifest.totalCharge) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["totalCharge"],
        message: "System charge must equal the sum of aggregate component charges",
      });
    }
    if (
      manifest.components.proteins.filter((protein) => protein.role === "receptor").length !== 1
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["components", "proteins"],
        message: "A biomolecular system manifest must identify exactly one receptor",
      });
    }
    if (manifest.membrane === null && manifest.components.lipids.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["membrane"],
        message: "Lipid components require an explicit membrane definition",
      });
    }
    if (manifest.membrane !== null) {
      const lipidById = new Map(
        manifest.components.lipids.map((component) => [component.id, component]),
      );
      for (const entry of manifest.membrane.composition) {
        const lipid = lipidById.get(entry.lipidComponentId);
        if (!lipid) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["membrane", "composition"],
            message: `Membrane composition references unknown lipid ${entry.lipidComponentId}`,
          });
        } else if (entry.upperLeafletCount + entry.lowerLeafletCount !== lipid.moleculeCount) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["membrane", "composition"],
            message: `Leaflet counts do not match molecule count for lipid ${lipid.id}`,
          });
        }
      }
      if (manifest.membrane.composition.length !== manifest.components.lipids.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["membrane", "composition"],
          message: "Every lipid component must appear in the membrane composition",
        });
      }
    }
    const parentFields = [
      manifest.provenance.parentManifestId,
      manifest.provenance.parentManifestRevision,
    ];
    if (parentFields.filter((value) => value !== undefined).length === 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provenance"],
        message: "Parent manifest id and revision must be recorded together",
      });
    }
  });

export type BiomolecularSystemManifest = z.infer<typeof BiomolecularSystemManifestSchema>;

export type PublishedBiomolecularSystemManifest = BiomolecularSystemManifest & {
  schemaVersion: typeof PublishedBiomolecularSystemManifestSchemaVersion;
  forceFieldStackDecisionId: string;
};

/** A versioned reference used wherever embedding the complete system would be unsafe. */
export const BiomolecularSystemManifestReferenceSchema = z
  .object({
    id: IdSchema,
    revision: z.number().int().positive(),
    systemClass: z.enum(["soluble", "membrane"]),
    manifestDigest: DigestSchema,
    topologyDigest: DigestSchema,
    coordinateDigest: DigestSchema,
    atomMapDigest: DigestSchema,
  })
  .strict();

export type BiomolecularSystemManifestReference = z.infer<
  typeof BiomolecularSystemManifestReferenceSchema
>;

/**
 * Digests every normalized manifest field, including provenance and child content digests,
 * except the `manifestDigest` field itself.
 */
export function computeBiomolecularSystemManifestDigest(value: object): string {
  return canonicalSelfDigest(value, "manifestDigest");
}

/** Validates both the manifest schema and its canonical self-digest. */
export function assertBiomolecularSystemManifestDigest(value: unknown): BiomolecularSystemManifest {
  const manifest = BiomolecularSystemManifestSchema.parse(value);
  const observedDigest = computeBiomolecularSystemManifestDigest(manifest);
  if (observedDigest !== manifest.manifestDigest) {
    throw new ScientificSchemaDigestMismatchError(
      "BiomolecularSystemManifest",
      manifest.id,
      manifest.manifestDigest,
      observedDigest,
    );
  }
  return manifest;
}

/** Accepts only a v2 manifest whose mandatory decision identities are present. */
export function assertPublishedBiomolecularSystemManifestDigest(
  value: unknown,
): PublishedBiomolecularSystemManifest {
  const manifest = assertBiomolecularSystemManifestDigest(value);
  if (
    manifest.schemaVersion !== PublishedBiomolecularSystemManifestSchemaVersion ||
    manifest.forceFieldStackDecisionId === undefined
  ) {
    throw new TypeError("Durable system publication requires biomolecular manifest v2");
  }
  return manifest as PublishedBiomolecularSystemManifest;
}
