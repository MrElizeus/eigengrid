import { z } from "zod";
import { DigestSchema, IdSchema, TimestampSchema } from "../schemas";
import { BiomolecularDecisionSchemaVersion, StrictActorIdentitySchema, UniqueIds } from "./common";
import { canonicalDigestOmitting, ScientificSchemaDigestMismatchError } from "./digests";

const DecisionBaseShape = {
  schemaVersion: z.literal(BiomolecularDecisionSchemaVersion),
  id: IdSchema,
  missionId: IdSchema,
  revision: z.number().int().positive(),
  status: z.enum(["proposed", "approved", "rejected", "superseded"]),
  rationale: z.string().min(1),
  evidenceRefs: z.array(IdSchema).min(1),
  decidedBy: StrictActorIdentitySchema,
  approvalRef: IdSchema.optional(),
  approvedAt: TimestampSchema.optional(),
  decisionDigest: DigestSchema,
  createdAt: TimestampSchema,
} as const;

function validateDecisionApproval(
  decision: { status: string; approvalRef?: string; approvedAt?: string },
  context: z.RefinementCtx,
): void {
  if (decision.status === "approved" && (!decision.approvalRef || !decision.approvedAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["approvalRef"],
      message: "An approved scientific decision requires its exact approval and timestamp",
    });
  }
  if (decision.status !== "approved" && (decision.approvalRef || decision.approvedAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["approvalRef"],
      message: "Only an approved scientific decision may reference an approval",
    });
  }
}

export const ConstructDecisionSchema = z
  .object({
    ...DecisionBaseShape,
    kind: z.literal("construct"),
    sourceStructureDigest: DigestSchema,
    chainPolicies: z
      .array(
        z
          .object({
            chainId: z.string().min(1).max(8),
            action: z.enum(["preserve", "remove", "restore_to_reference"]),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    mutationPolicies: z.array(
      z
        .object({
          chainId: z.string().min(1).max(8),
          residueNumber: z.number().int(),
          observedResidue: z.string().min(1).max(4),
          referenceResidue: z.string().min(1).max(4),
          action: z.enum(["preserve", "restore"]),
          reason: z.string().min(1),
        })
        .strict(),
    ),
    missingRegionPolicies: z.array(
      z
        .object({
          chainId: z.string().min(1).max(8),
          startResidue: z.number().int(),
          endResidue: z.number().int(),
          action: z.enum(["model", "cap", "leave_unresolved", "remove_segment"]),
          reason: z.string().min(1),
        })
        .strict()
        .refine((region) => region.endResidue >= region.startResidue, {
          message: "A missing-region range must not be reversed",
          path: ["endResidue"],
        }),
    ),
    terminiPolicy: z.string().min(1),
    fusionPolicy: z.string().min(1),
    disulfidePolicy: z.string().min(1),
    outputConstructDigest: DigestSchema,
  })
  .strict()
  .superRefine((decision, context) => {
    validateDecisionApproval(decision, context);
    const chainIds = decision.chainPolicies.map((policy) => policy.chainId);
    if (new Set(chainIds).size !== chainIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chainPolicies"],
        message: "A construct decision may contain only one policy per chain",
      });
    }
  });

export type ConstructDecision = z.infer<typeof ConstructDecisionSchema>;

export const MicrostateAlternativeSchema = z
  .object({
    id: IdSchema,
    label: z.string().min(1),
    formalCharge: z.number().int(),
    protonationDescription: z.string().min(1),
    tautomerDescription: z.string().min(1),
    structureDigest: DigestSchema,
    estimatedPopulation: z.number().min(0).max(1).optional(),
  })
  .strict();

export type MicrostateAlternative = z.infer<typeof MicrostateAlternativeSchema>;

export const MicrostateDecisionSchema = z
  .object({
    ...DecisionBaseShape,
    kind: z.literal("microstate"),
    subjectComponentId: IdSchema,
    subjectKind: z.enum(["protein", "ligand", "cofactor"]),
    targetPh: z.number().min(0).max(14),
    temperatureKelvin: z.number().positive(),
    method: z.string().min(1),
    alternatives: z.array(MicrostateAlternativeSchema).min(1),
    selectedAlternativeId: IdSchema,
    selectedFormalCharge: z.number().int(),
  })
  .strict()
  .superRefine((decision, context) => {
    validateDecisionApproval(decision, context);
    const selected = decision.alternatives.find(
      (alternative) => alternative.id === decision.selectedAlternativeId,
    );
    if (!selected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selectedAlternativeId"],
        message: "The selected microstate must be one of the recorded alternatives",
      });
    } else if (selected.formalCharge !== decision.selectedFormalCharge) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selectedFormalCharge"],
        message: "Selected formal charge must match the selected microstate",
      });
    }
    if (!UniqueIds(decision.alternatives)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["alternatives"],
        message: "Microstate alternative identifiers must be unique",
      });
    }
  });

export type MicrostateDecision = z.infer<typeof MicrostateDecisionSchema>;

export const PoseCandidateSchema = z
  .object({
    id: IdSchema,
    method: z.enum(["crystal", "imported", "pharmacophore", "docking"]),
    coordinateDigest: DigestSchema,
    atomMapDigest: DigestSchema,
    generatorVersion: z.string().min(1),
    seed: z.number().int().min(0).max(2_147_483_646).optional(),
    score: z.number().finite().optional(),
    scoreUnit: z.string().min(1).optional(),
    validationEvidenceRefs: z.array(IdSchema),
  })
  .strict()
  .superRefine((candidate, context) => {
    if ((candidate.score === undefined) !== (candidate.scoreUnit === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scoreUnit"],
        message: "A pose score and its unit must be recorded together",
      });
    }
  });

export type PoseCandidate = z.infer<typeof PoseCandidateSchema>;

export const PoseDecisionSchema = z
  .object({
    ...DecisionBaseShape,
    kind: z.literal("pose"),
    receptorComponentId: IdSchema,
    ligandComponentId: IdSchema,
    pocketDefinitionDigest: DigestSchema,
    candidates: z.array(PoseCandidateSchema).min(1),
    selectedCandidateId: IdSchema,
    selectionCriteria: z.array(z.string().min(1)).min(1),
    uncertainty: z.enum(["low", "medium", "high", "unknown"]),
  })
  .strict()
  .superRefine((decision, context) => {
    validateDecisionApproval(decision, context);
    if (!UniqueIds(decision.candidates)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidates"],
        message: "Pose candidate identifiers must be unique",
      });
    }
    if (!decision.candidates.some((candidate) => candidate.id === decision.selectedCandidateId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selectedCandidateId"],
        message: "The selected pose must be one of the recorded candidates",
      });
    }
  });

export type PoseDecision = z.infer<typeof PoseDecisionSchema>;

const ForceFieldStackDecisionCandidateSchema = z
  .object({
    id: IdSchema,
    revision: z.number().int().positive(),
    digest: DigestSchema,
    evidenceRef: IdSchema,
    limitations: z.array(z.string().min(1)),
  })
  .strict();

export const ForceFieldStackDecisionSchema = z
  .object({
    ...DecisionBaseShape,
    kind: z.literal("force_field_stack"),
    candidates: z.array(ForceFieldStackDecisionCandidateSchema).min(1),
    selectedStack: z
      .object({ id: IdSchema, revision: z.number().int().positive(), digest: DigestSchema })
      .strict(),
    compatibilityCriteria: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .superRefine((decision, context) => {
    validateDecisionApproval(decision, context);
    const identities = decision.candidates.map(
      (candidate) => `${candidate.id}\u0000${candidate.revision}`,
    );
    if (new Set(identities).size !== identities.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidates"],
        message: "Force-field stack candidate identities must be unique",
      });
    }
    const selected = decision.candidates.find(
      (candidate) =>
        candidate.id === decision.selectedStack.id &&
        candidate.revision === decision.selectedStack.revision &&
        candidate.digest === decision.selectedStack.digest,
    );
    if (!selected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selectedStack"],
        message: "The selected force-field stack must match one exact candidate revision",
      });
    }
    const evidenceRefs = new Set(decision.evidenceRefs);
    if (decision.candidates.some((candidate) => !evidenceRefs.has(candidate.evidenceRef))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceRefs"],
        message: "Every force-field candidate evidence reference must be decision evidence",
      });
    }
  });

export type ForceFieldStackDecision = z.infer<typeof ForceFieldStackDecisionSchema>;

export const MembraneModelDecisionSchema = z
  .object({
    ...DecisionBaseShape,
    kind: z.literal("membrane_model"),
    receptorComponentId: IdSchema,
    receptorCoordinateDigest: DigestSchema,
    receptorCoordinateEvidenceRef: IdSchema,
    membraneDigest: DigestSchema,
    orientationDigest: DigestSchema,
    orientationEvidenceRef: IdSchema,
    selectionCriteria: z.array(z.string().min(1)).min(1),
    knownLimitations: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((decision, context) => {
    validateDecisionApproval(decision, context);
    const evidenceRefs = new Set(decision.evidenceRefs);
    for (const [field, evidenceRef] of [
      ["receptorCoordinateEvidenceRef", decision.receptorCoordinateEvidenceRef],
      ["orientationEvidenceRef", decision.orientationEvidenceRef],
    ] as const) {
      if (!evidenceRefs.has(evidenceRef)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["evidenceRefs"],
          message: `${field} must also be recorded in decision evidence`,
        });
      }
    }
  });

export type MembraneModelDecision = z.infer<typeof MembraneModelDecisionSchema>;

export const ReceptorProtonationDecisionSchema = z
  .object({
    ...DecisionBaseShape,
    kind: z.literal("protonation"),
    subjectKind: z.literal("protein"),
    subjectRole: z.literal("receptor"),
    subjectComponentId: IdSchema,
    targetPh: z.number().min(0).max(14),
    temperatureKelvin: z.number().positive(),
    method: z.string().min(1),
    inputCoordinateDigest: DigestSchema,
    inputCoordinateEvidenceRef: IdSchema,
    residueStates: z
      .array(
        z
          .object({
            chainId: z.string().min(1).max(8),
            residueNumber: z.number().int(),
            residueName: z.string().min(1).max(4),
            selectedState: z.string().min(1),
            formalCharge: z.number().int(),
          })
          .strict(),
      )
      .min(1),
    terminiPolicy: z.string().min(1),
    selectedFormalCharge: z.number().int(),
    outputCoordinateDigest: DigestSchema,
    outputCoordinateEvidenceRef: IdSchema,
  })
  .strict()
  .superRefine((decision, context) => {
    validateDecisionApproval(decision, context);
    const residueIdentities = decision.residueStates.map(
      (state) => `${state.chainId}\u0000${state.residueNumber}`,
    );
    if (new Set(residueIdentities).size !== residueIdentities.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["residueStates"],
        message: "A protonation decision may assign each receptor residue only once",
      });
    }
    const evidenceRefs = new Set(decision.evidenceRefs);
    for (const [field, evidenceRef] of [
      ["inputCoordinateEvidenceRef", decision.inputCoordinateEvidenceRef],
      ["outputCoordinateEvidenceRef", decision.outputCoordinateEvidenceRef],
    ] as const) {
      if (!evidenceRefs.has(evidenceRef)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["evidenceRefs"],
          message: `${field} must also be recorded in decision evidence`,
        });
      }
    }
  });

export type ReceptorProtonationDecision = z.infer<typeof ReceptorProtonationDecisionSchema>;

export type BiomolecularDecision =
  | ConstructDecision
  | MicrostateDecision
  | PoseDecision
  | ForceFieldStackDecision
  | MembraneModelDecision
  | ReceptorProtonationDecision;

/** Exact approved decision identity embedded into a material system revision. */
export const BiomolecularDecisionReferenceSchema = z
  .object({
    id: IdSchema,
    revision: z.number().int().positive(),
    kind: z.enum([
      "construct",
      "microstate",
      "pose",
      "force_field_stack",
      "membrane_model",
      "protonation",
      "other",
    ]),
    decisionDigest: DigestSchema,
    approvalRef: IdSchema,
  })
  .strict();

export type BiomolecularDecisionReference = z.infer<typeof BiomolecularDecisionReferenceSchema>;

/**
 * Digests the immutable scientific content of a reviewed decision. Approval
 * lifecycle fields are excluded so the exact payload reviewed while proposed
 * remains identical after an approved/rejected transition.
 */
export function computeBiomolecularDecisionDigest(value: object): string {
  return canonicalDigestOmitting(value, ["decisionDigest", "status", "approvalRef", "approvedAt"]);
}

/** Validates a typed biomolecular decision and its stable material digest. */
export function assertBiomolecularDecisionDigest(value: unknown): BiomolecularDecision {
  for (const schema of [
    ConstructDecisionSchema,
    MicrostateDecisionSchema,
    PoseDecisionSchema,
    ForceFieldStackDecisionSchema,
    MembraneModelDecisionSchema,
    ReceptorProtonationDecisionSchema,
  ] as const) {
    const parsed = schema.safeParse(value);
    if (!parsed.success) continue;
    const decision = parsed.data as BiomolecularDecision;
    const observedDigest = computeBiomolecularDecisionDigest(decision);
    if (observedDigest !== decision.decisionDigest) {
      throw new ScientificSchemaDigestMismatchError(
        "BiomolecularDecision",
        decision.id,
        decision.decisionDigest,
        observedDigest,
      );
    }
    return decision;
  }
  throw new TypeError("Biomolecular decision failed schema validation");
}
