import { z } from "zod";

import {
  BiomolecularSystemManifestReferenceSchema,
  ScientificSchemaDigestMismatchError,
} from "./biomolecular";
import { digestCanonical } from "./canonical";
import { DigestSchema, IdSchema, SemverSchema, TimestampSchema } from "./schemas";

export const QmmmRegionSelectionSchemaVersion = "eigengrid.qmmm-region-selection/v1" as const;
export const QmmmProtocolSchemaVersion = "eigengrid.qmmm-protocol/v1" as const;

export const QmmmDecisionCategorySchema = z.enum([
  "region",
  "charge_spin",
  "theory",
  "embedding",
  "boundary",
  "convergence",
]);
export type QmmmDecisionCategory = z.infer<typeof QmmmDecisionCategorySchema>;

/** Exact approved scientific decision identity; labels or model output are insufficient. */
export const QmmmDecisionReferenceSchema = z
  .object({
    id: IdSchema,
    revision: z.number().int().positive(),
    category: QmmmDecisionCategorySchema,
    decisionDigest: DigestSchema,
    approvalRef: IdSchema,
  })
  .strict();
export type QmmmDecisionReference = z.infer<typeof QmmmDecisionReferenceSchema>;

/**
 * Canonical one-based QM atom selection bound to an exact materialized system and atom map.
 * Engine masks are derived later; they are never the scientific source of truth.
 */
export const QmmmRegionSelectionSchema = z
  .object({
    schemaVersion: z.literal(QmmmRegionSelectionSchemaVersion),
    id: IdSchema,
    revision: z.number().int().positive(),
    system: BiomolecularSystemManifestReferenceSchema,
    atomMap: z
      .object({
        id: IdSchema,
        revision: z.number().int().positive(),
        digest: DigestSchema,
        atomCount: z.number().int().positive(),
        indexBase: z.literal(1),
      })
      .strict(),
    /** Prevent an all-QM engine smoke from being described as hybrid QM/MM evidence. */
    selectionClass: z.enum(["hybrid_qm_mm", "all_qm_engine_check"]),
    atomIndices: z.array(z.number().int().positive()).min(1),
    sourceEvidenceRefs: z.array(IdSchema).min(1),
    decision: QmmmDecisionReferenceSchema,
    selectionDigest: DigestSchema,
  })
  .strict()
  .superRefine((selection, context) => {
    if (selection.atomMap.digest !== selection.system.atomMapDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["atomMap", "digest"],
        message: "QM region atom map must match the exact system manifest",
      });
    }
    if (selection.decision.category !== "region") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decision", "category"],
        message: "QM atom selection requires an exact region decision",
      });
    }
    if (
      selection.atomIndices.some(
        (atomIndex, index) =>
          atomIndex > selection.atomMap.atomCount ||
          (index > 0 && atomIndex <= selection.atomIndices[index - 1]!),
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["atomIndices"],
        message: "QM atom indices must be unique, strictly increasing, and within the atom map",
      });
    }
    if (
      (selection.selectionClass === "hybrid_qm_mm" &&
        selection.atomIndices.length >= selection.atomMap.atomCount) ||
      (selection.selectionClass === "all_qm_engine_check" &&
        selection.atomIndices.length !== selection.atomMap.atomCount)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selectionClass"],
        message:
          "Hybrid QM/MM requires at least one MM atom; an all-QM engine check must select every atom",
      });
    }
    if (selection.selectionDigest !== computeQmmmRegionSelectionDigest(selection)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selectionDigest"],
        message: "QM region digest does not match its exact canonical selection",
      });
    }
  });
export type QmmmRegionSelection = z.infer<typeof QmmmRegionSelectionSchema>;

const QmmmBoundaryBondSchema = z
  .object({
    qmAtomIndex: z.number().int().positive(),
    mmAtomIndex: z.number().int().positive(),
    evidenceRef: IdSchema,
  })
  .strict()
  .refine((bond) => bond.qmAtomIndex !== bond.mmAtomIndex, {
    path: ["mmAtomIndex"],
    message: "A QM/MM boundary bond must join two different atoms",
  });

export const QmmmBoundaryPolicySchema = z
  .discriminatedUnion("mode", [
    z
      .object({
        mode: z.literal("no_covalent_boundary"),
        covalentBonds: z.array(QmmmBoundaryBondSchema).length(0),
        decision: QmmmDecisionReferenceSchema,
      })
      .strict(),
    z
      .object({
        mode: z.literal("engine_managed_link_atoms"),
        engineFamily: z.literal("amber"),
        method: z.literal("amber-qmmm-default"),
        covalentBonds: z.array(QmmmBoundaryBondSchema).min(1),
        qualificationEvidenceRef: IdSchema,
        decision: QmmmDecisionReferenceSchema,
      })
      .strict(),
  ])
  .superRefine((boundary, context) => {
    if (boundary.decision.category !== "boundary") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decision", "category"],
        message: "QM/MM boundary treatment requires an exact boundary decision",
      });
    }
  });
export type QmmmBoundaryPolicy = z.infer<typeof QmmmBoundaryPolicySchema>;

export const QmmmElectronicStateSchema = z
  .object({
    qmCharge: z.number().int(),
    spinMultiplicity: z.number().int().positive(),
    decision: QmmmDecisionReferenceSchema,
  })
  .strict()
  .superRefine((state, context) => {
    if (state.decision.category !== "charge_spin") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decision", "category"],
        message: "QM charge and spin require an exact charge-spin decision",
      });
    }
  });
export type QmmmElectronicState = z.infer<typeof QmmmElectronicStateSchema>;

export const QmmmTheorySchema = z
  .object({
    provider: z.literal("amber-sqm"),
    /** Exact engine token; renderer qualification, not this open contract, controls support. */
    theory: z
      .string()
      .min(1)
      .max(24)
      .regex(/^[A-Za-z0-9][A-Za-z0-9+_.-]*$/u),
    parameterSet: z
      .object({
        id: IdSchema,
        version: z.string().min(1),
        digest: DigestSchema,
        evidenceRef: IdSchema,
      })
      .strict()
      .optional(),
    qualificationEvidenceRef: IdSchema,
    decision: QmmmDecisionReferenceSchema,
  })
  .strict()
  .superRefine((theory, context) => {
    if (theory.decision.category !== "theory") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decision", "category"],
        message: "QM theory requires an exact theory decision",
      });
    }
  });
export type QmmmTheory = z.infer<typeof QmmmTheorySchema>;

export const QmmmEmbeddingPolicySchema = z
  .object({
    mode: z.enum(["electrostatic", "mechanical"]),
    cutoffAngstrom: z.number().finite().positive(),
    longRangeTreatment: z.enum(["direct_cutoff", "periodic_ewald"]),
    decision: QmmmDecisionReferenceSchema,
  })
  .strict()
  .superRefine((embedding, context) => {
    if (embedding.decision.category !== "embedding") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decision", "category"],
        message: "QM/MM embedding requires an exact embedding decision",
      });
    }
  });
export type QmmmEmbeddingPolicy = z.infer<typeof QmmmEmbeddingPolicySchema>;

/** V1 never mutates material scientific controls automatically after a failure. */
export const QmmmConvergencePolicySchema = z
  .object({
    maximumScfIterations: z.number().int().positive(),
    scfConvergenceTolerance: z.number().finite().positive().lt(1),
    failureDisposition: z.literal("stop_and_escalate"),
    automaticScientificCorrectionAttempts: z.literal(0),
    escalationConditions: z.array(z.string().min(1)).min(1),
    decision: QmmmDecisionReferenceSchema,
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.decision.category !== "convergence") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decision", "category"],
        message: "QM convergence requires an exact convergence decision",
      });
    }
  });
export type QmmmConvergencePolicy = z.infer<typeof QmmmConvergencePolicySchema>;

export const QmmmProtocolSchema = z
  .object({
    schemaVersion: z.literal(QmmmProtocolSchemaVersion),
    id: IdSchema,
    missionId: IdSchema,
    revision: z.number().int().positive(),
    status: z.enum(["draft", "under_review", "approved", "superseded"]),
    system: BiomolecularSystemManifestReferenceSchema,
    parentMdProtocol: z
      .object({ id: IdSchema, revision: z.number().int().positive(), digest: DigestSchema })
      .strict(),
    appliedStageIds: z.array(IdSchema).min(1),
    region: QmmmRegionSelectionSchema,
    electronicState: QmmmElectronicStateSchema,
    theory: QmmmTheorySchema,
    embedding: QmmmEmbeddingPolicySchema,
    boundary: QmmmBoundaryPolicySchema,
    convergence: QmmmConvergencePolicySchema,
    decisionRefs: z.array(QmmmDecisionReferenceSchema).length(6),
    rendererCompatibilityVersion: SemverSchema,
    assumptions: z.array(z.string().min(1)),
    limitations: z.array(z.string().min(1)).min(1),
    protocolDigest: DigestSchema,
    approvedByRef: IdSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((protocol, context) => {
    if (digestCanonical(protocol.system) !== digestCanonical(protocol.region.system)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["region", "system"],
        message: "QM region must bind the exact protocol system revision",
      });
    }
    if (new Set(protocol.appliedStageIds).size !== protocol.appliedStageIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["appliedStageIds"],
        message: "A QM/MM protocol may bind each MD stage only once",
      });
    }
    const required: Record<QmmmDecisionCategory, QmmmDecisionReference> = {
      region: protocol.region.decision,
      charge_spin: protocol.electronicState.decision,
      theory: protocol.theory.decision,
      embedding: protocol.embedding.decision,
      boundary: protocol.boundary.decision,
      convergence: protocol.convergence.decision,
    };
    const categories = protocol.decisionRefs.map((decision) => decision.category);
    for (const category of QmmmDecisionCategorySchema.options) {
      if (categories.filter((candidate) => candidate === category).length !== 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["decisionRefs"],
          message: `QM/MM protocol requires exactly one ${category} decision`,
        });
      }
      const referenced = protocol.decisionRefs.find((decision) => decision.category === category);
      if (referenced && digestCanonical(referenced) !== digestCanonical(required[category])) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["decisionRefs"],
          message: `QM/MM ${category} decision identity differs from its material control`,
        });
      }
    }
    const qmAtoms = new Set(protocol.region.atomIndices);
    const boundaryIdentities = new Set<string>();
    for (const bond of protocol.boundary.covalentBonds) {
      const identity = `${bond.qmAtomIndex}:${bond.mmAtomIndex}`;
      if (boundaryIdentities.has(identity)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["boundary", "covalentBonds"],
          message: "QM/MM covalent boundary bonds must be unique",
        });
      }
      boundaryIdentities.add(identity);
      if (!qmAtoms.has(bond.qmAtomIndex) || qmAtoms.has(bond.mmAtomIndex)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["boundary", "covalentBonds"],
          message: "Each boundary bond must point from an authorized QM atom to an MM atom",
        });
      }
      if (
        bond.qmAtomIndex > protocol.region.atomMap.atomCount ||
        bond.mmAtomIndex > protocol.region.atomMap.atomCount
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["boundary", "covalentBonds"],
          message: "Boundary atom index exceeds the exact atom map",
        });
      }
    }
    if ((protocol.status === "approved") !== (protocol.approvedByRef !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvedByRef"],
        message: "Only an approved QM/MM protocol may carry, and must carry, its approval",
      });
    }
  });
export type QmmmProtocol = z.infer<typeof QmmmProtocolSchema>;

function digestOmitting(value: object, omittedFields: readonly string[]): string {
  const omitted = new Set(omittedFields);
  return digestCanonical(
    Object.fromEntries(Object.entries(value).filter(([field]) => !omitted.has(field))),
  );
}

export function computeQmmmRegionSelectionDigest(value: object): string {
  return digestOmitting(value, ["selectionDigest"]);
}

export function assertQmmmRegionSelectionDigest(value: unknown): QmmmRegionSelection {
  const selection = QmmmRegionSelectionSchema.parse(value);
  const observed = computeQmmmRegionSelectionDigest(selection);
  if (observed !== selection.selectionDigest) {
    throw new ScientificSchemaDigestMismatchError(
      "QmmmRegionSelection",
      selection.id,
      selection.selectionDigest,
      observed,
    );
  }
  return selection;
}

/** Approval lifecycle fields do not change the scientific object that was reviewed. */
export function computeQmmmProtocolDigest(value: object): string {
  return digestOmitting(value, ["protocolDigest", "status", "approvedByRef", "updatedAt"]);
}

export function assertQmmmProtocolDigest(value: unknown): QmmmProtocol {
  const protocol = QmmmProtocolSchema.parse(value);
  const observed = computeQmmmProtocolDigest(protocol);
  if (observed !== protocol.protocolDigest) {
    throw new ScientificSchemaDigestMismatchError(
      "QmmmProtocol",
      protocol.id,
      protocol.protocolDigest,
      observed,
    );
  }
  return protocol;
}
