import { z } from "zod";
import { digestCanonical } from "./canonical";
import {
  ActorIdentitySchema,
  DigestSchema,
  IdSchema,
  SemverSchema,
  TimestampSchema,
} from "./schemas";

const StrictActorIdentitySchema = ActorIdentitySchema.strict();

export const BiomolecularComponentSchemaVersion = "eigengrid.biomolecular-component/v1" as const;
export const LegacyBiomolecularDecisionSchemaVersion =
  "eigengrid.biomolecular-decision/v1" as const;
export const BiomolecularDecisionSchemaVersion = "eigengrid.biomolecular-decision/v2" as const;
export const ForceFieldStackSchemaVersion = "eigengrid.force-field-stack/v1" as const;
export const AtomMapSchemaVersion = "eigengrid.atom-map/v1" as const;
export const BiomolecularSystemManifestSchemaVersion =
  "eigengrid.biomolecular-system-manifest/v1" as const;
export const PublishedBiomolecularSystemManifestSchemaVersion =
  "eigengrid.biomolecular-system-manifest/v2" as const;
export const BiomolecularSystemBuildRequestSchemaVersionV1 =
  "eigengrid.biomolecular-system-build-request/v1" as const;
export const BiomolecularSystemBuildRequestSchemaVersion =
  "eigengrid.biomolecular-system-build-request/v2" as const;
export const BiomolecularSystemBuildWorkUnitBindingSchemaVersion =
  "eigengrid.biomolecular-system-build-work-unit-binding/v1" as const;
export const BiomolecularMaterialPublicationBindingSchemaVersion =
  "eigengrid.biomolecular-material-publication-binding/v1" as const;
export const ForceFieldStackPublicationRequestSchemaVersionV1 =
  "eigengrid.force-field-stack-publication-request/v1" as const;
export const ForceFieldStackPublicationRequestSchemaVersion =
  "eigengrid.force-field-stack-publication-request/v2" as const;
export const AtomMapPublicationRequestSchemaVersionV1 =
  "eigengrid.atom-map-publication-request/v1" as const;
export const AtomMapPublicationRequestSchemaVersion =
  "eigengrid.atom-map-publication-request/v2" as const;

const UniqueIds = <T extends { id: string }>(items: T[]): boolean =>
  new Set(items.map((item) => item.id)).size === items.length;

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

/** Command-free, reviewed inputs for a system-build WorkUnit. The durable
 * operation request adds mission/plan/job identity and exact CAS digests. */
export const BiomolecularSystemBuildWorkUnitBindingSchema = z
  .object({
    schemaVersion: z.literal(BiomolecularSystemBuildWorkUnitBindingSchemaVersion),
    primaryInputEvidenceId: IdSchema,
    sourceEvidenceRefs: z.array(IdSchema).min(1),
    forceFieldStackEvidenceRef: IdSchema,
    decisionRefs: z.array(BiomolecularDecisionReferenceSchema).min(1),
    forceFieldStack: z
      .object({
        id: IdSchema,
        revision: z.number().int().positive(),
        digest: DigestSchema,
      })
      .strict(),
    outputArtifacts: z
      .object({
        topology: z
          .object({
            evidenceRef: IdSchema,
            mediaType: z.literal("application/vnd.amber.prmtop"),
          })
          .strict(),
        coordinates: z
          .object({
            evidenceRef: IdSchema,
            mediaType: z.literal("application/vnd.amber.rst7"),
          })
          .strict(),
        atomMap: z
          .object({
            evidenceRef: IdSchema,
            mediaType: z.literal("application/vnd.eigengrid.atom-map+json"),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((binding, context) => {
    if (!binding.sourceEvidenceRefs.includes(binding.primaryInputEvidenceId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["primaryInputEvidenceId"],
        message: "The primary input must be one of the exact source evidence references",
      });
    }
    if (new Set(binding.sourceEvidenceRefs).size !== binding.sourceEvidenceRefs.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceEvidenceRefs"],
        message: "Source evidence references must be unique",
      });
    }
    if (binding.sourceEvidenceRefs.includes(binding.forceFieldStackEvidenceRef)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["forceFieldStackEvidenceRef"],
        message: "Force-field stack evidence is bound separately from source evidence",
      });
    }
    const decisionIds = binding.decisionRefs.map((decision) => decision.id);
    if (new Set(decisionIds).size !== decisionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decisionRefs"],
        message: "Each exact system-build decision may be bound once",
      });
    }
    const outputIds = Object.values(binding.outputArtifacts).map(
      (artifact) => artifact.evidenceRef,
    );
    if (
      new Set(outputIds).size !== outputIds.length ||
      outputIds.some(
        (evidenceRef) =>
          binding.sourceEvidenceRefs.includes(evidenceRef) ||
          evidenceRef === binding.forceFieldStackEvidenceRef,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputArtifacts"],
        message: "Output evidence identities must be unique and distinct from all inputs",
      });
    }
  });
export type BiomolecularSystemBuildWorkUnitBinding = z.infer<
  typeof BiomolecularSystemBuildWorkUnitBindingSchema
>;

export const BiomolecularSystemBuildWorkUnitParametersSchema = z
  .object({
    manifestId: IdSchema,
    manifestRevision: z.number().int().positive(),
    manifestDigest: DigestSchema,
    systemBuild: BiomolecularSystemBuildWorkUnitBindingSchema,
  })
  .strict();
export type BiomolecularSystemBuildWorkUnitParameters = z.infer<
  typeof BiomolecularSystemBuildWorkUnitParametersSchema
>;

const BiomolecularBuildEvidenceBindingSchema = z
  .object({
    evidenceRef: IdSchema,
    mediaType: z.string().min(1),
  })
  .strict();

/**
 * Canonical intent payload for the one external effect allowed to publish a
 * biomolecular system manifest. It deliberately contains no executable, argv,
 * path, or shell field.
 */
const BiomolecularSystemBuildRequestShape = {
  workUnitId: IdSchema,
  capability: z
    .object({
      id: IdSchema,
      version: SemverSchema,
      contractDigest: DigestSchema,
    })
    .strict(),
  systemManifest: z
    .object({
      id: IdSchema,
      revision: z.number().int().positive(),
    })
    .strict(),
  sourceEvidence: z.array(z.object({ id: IdSchema, contentDigest: DigestSchema }).strict()).min(1),
  decisionRefs: z.array(BiomolecularDecisionReferenceSchema).min(1),
  forceFieldStack: z
    .object({
      id: IdSchema,
      revision: z.number().int().positive(),
      digest: DigestSchema,
    })
    .strict(),
  outputArtifacts: z
    .object({
      topology: BiomolecularBuildEvidenceBindingSchema,
      coordinates: BiomolecularBuildEvidenceBindingSchema,
      atomMap: BiomolecularBuildEvidenceBindingSchema,
    })
    .strict(),
  parametersDigest: DigestSchema,
  outputContractDigest: DigestSchema,
};

function refineBiomolecularSystemBuildRequest(
  request: {
    sourceEvidence: Array<{ id: string; contentDigest: string }>;
    decisionRefs: Array<{ id: string }>;
    outputArtifacts: Record<string, { evidenceRef: string }>;
    inputEvidenceId?: string;
    inputContentDigest?: string;
  },
  context: z.RefinementCtx,
): void {
  const sourceIds = request.sourceEvidence.map((evidence) => evidence.id);
  if (
    "inputEvidenceId" in request &&
    !request.sourceEvidence.some(
      (evidence) =>
        evidence.id === request.inputEvidenceId &&
        evidence.contentDigest === request.inputContentDigest,
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["inputEvidenceId"],
      message: "The coordinator input must be one exact source-evidence binding",
    });
  }
  if (new Set(sourceIds).size !== sourceIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceEvidence"],
      message: "A system-build request may bind each source evidence object only once",
    });
  }
  if (!UniqueIds(request.decisionRefs)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["decisionRefs"],
      message: "A system-build request may bind each exact decision only once",
    });
  }
  const outputIds = Object.values(request.outputArtifacts).map((artifact) => artifact.evidenceRef);
  if (new Set(outputIds).size !== outputIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outputArtifacts"],
      message: "Topology, coordinates, and atom map require distinct evidence identities",
    });
  }
}

const BiomolecularSystemBuildRequestV1Schema = z
  .object({
    schemaVersion: z.literal(BiomolecularSystemBuildRequestSchemaVersionV1),
    ...BiomolecularSystemBuildRequestShape,
  })
  .strict();
const BiomolecularSystemBuildRequestV2Schema = z
  .object({
    schemaVersion: z.literal(BiomolecularSystemBuildRequestSchemaVersion),
    ...BiomolecularSystemBuildRequestShape,
    missionId: IdSchema,
    planId: IdSchema,
    planVersion: z.number().int().positive(),
    intendedJobId: IdSchema,
    intendedAttemptId: IdSchema,
    inputEvidenceId: IdSchema,
    inputContentDigest: DigestSchema,
  })
  .strict();
export const BiomolecularSystemBuildRequestSchema = z
  .union([BiomolecularSystemBuildRequestV1Schema, BiomolecularSystemBuildRequestV2Schema])
  .superRefine(refineBiomolecularSystemBuildRequest);
export type BiomolecularSystemBuildRequest = z.infer<typeof BiomolecularSystemBuildRequestSchema>;

const BiomolecularMaterialSubjectSchema = z
  .object({
    id: IdSchema,
    revision: z.number().int().positive(),
    digest: DigestSchema,
  })
  .strict();

const BiomolecularMaterialCapabilitySchema = z
  .object({
    id: IdSchema,
    version: SemverSchema,
    contractDigest: DigestSchema,
  })
  .strict();

/**
 * Command-free WorkUnit parameters for publishing one exact biomolecular
 * material revision. The operation request binds their canonical digest.
 */
export const BiomolecularMaterialPublicationBindingSchema = z.discriminatedUnion("subjectKind", [
  z
    .object({
      schemaVersion: z.literal(BiomolecularMaterialPublicationBindingSchemaVersion),
      subjectKind: z.literal("force_field_stack"),
      subject: BiomolecularMaterialSubjectSchema,
      sourceEvidenceRefs: z.array(IdSchema).min(1),
      artifactEvidenceRef: IdSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(BiomolecularMaterialPublicationBindingSchemaVersion),
      subjectKind: z.literal("atom_map"),
      subject: BiomolecularMaterialSubjectSchema,
      systemManifest: z
        .object({
          id: IdSchema,
          revision: z.number().int().positive(),
          digest: DigestSchema,
        })
        .strict(),
      sourceEvidenceRefs: z.array(IdSchema).length(1),
      artifactEvidenceRef: IdSchema,
    })
    .strict(),
]);
export type BiomolecularMaterialPublicationBinding = z.infer<
  typeof BiomolecularMaterialPublicationBindingSchema
>;

/** Exact, command-free intent used to publish a force-field stack CAS artifact. */
const ForceFieldStackPublicationRequestShape = {
  workUnitId: IdSchema,
  capability: BiomolecularMaterialCapabilitySchema,
  stack: BiomolecularMaterialSubjectSchema,
  sourceEvidence: z.array(z.object({ id: IdSchema, contentDigest: DigestSchema }).strict()).min(1),
  outputArtifact: BiomolecularBuildEvidenceBindingSchema,
  parametersDigest: DigestSchema,
  outputContractDigest: DigestSchema,
};

function refineForceFieldStackPublicationRequest(
  request: {
    sourceEvidence: Array<{ id: string; contentDigest: string }>;
    outputArtifact: { evidenceRef: string };
    inputEvidenceId?: string;
    inputContentDigest?: string;
  },
  context: z.RefinementCtx,
): void {
  const evidenceIds = request.sourceEvidence.map((evidence) => evidence.id);
  if (
    "inputEvidenceId" in request &&
    !request.sourceEvidence.some(
      (evidence) =>
        evidence.id === request.inputEvidenceId &&
        evidence.contentDigest === request.inputContentDigest,
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["inputEvidenceId"],
      message: "The coordinator input must be one exact force-field source-evidence binding",
    });
  }
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceEvidence"],
      message: "A stack publication may bind each source evidence object only once",
    });
  }
  if (evidenceIds.includes(request.outputArtifact.evidenceRef)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outputArtifact"],
      message: "A stack output artifact cannot also be one of its source inputs",
    });
  }
}

const ForceFieldStackPublicationRequestV1Schema = z
  .object({
    schemaVersion: z.literal(ForceFieldStackPublicationRequestSchemaVersionV1),
    ...ForceFieldStackPublicationRequestShape,
  })
  .strict();
const ForceFieldStackPublicationRequestV2Schema = z
  .object({
    schemaVersion: z.literal(ForceFieldStackPublicationRequestSchemaVersion),
    ...ForceFieldStackPublicationRequestShape,
    missionId: IdSchema,
    planId: IdSchema,
    planVersion: z.number().int().positive(),
    intendedJobId: IdSchema,
    intendedAttemptId: IdSchema,
    inputEvidenceId: IdSchema,
    inputContentDigest: DigestSchema,
  })
  .strict();
export const ForceFieldStackPublicationRequestSchema = z
  .union([ForceFieldStackPublicationRequestV1Schema, ForceFieldStackPublicationRequestV2Schema])
  .superRefine(refineForceFieldStackPublicationRequest);
export type ForceFieldStackPublicationRequest = z.infer<
  typeof ForceFieldStackPublicationRequestSchema
>;

/** Exact, command-free intent used to validate the atom-map artifact of one manifest revision. */
const AtomMapPublicationRequestShape = {
  workUnitId: IdSchema,
  capability: BiomolecularMaterialCapabilitySchema,
  atomMap: BiomolecularMaterialSubjectSchema,
  systemManifest: z
    .object({
      id: IdSchema,
      revision: z.number().int().positive(),
      digest: DigestSchema,
    })
    .strict(),
  sourceArtifact: BiomolecularBuildEvidenceBindingSchema,
  parametersDigest: DigestSchema,
  outputContractDigest: DigestSchema,
};
const AtomMapPublicationRequestV1Schema = z
  .object({
    schemaVersion: z.literal(AtomMapPublicationRequestSchemaVersionV1),
    ...AtomMapPublicationRequestShape,
  })
  .strict();
const AtomMapPublicationRequestV2Schema = z
  .object({
    schemaVersion: z.literal(AtomMapPublicationRequestSchemaVersion),
    ...AtomMapPublicationRequestShape,
    missionId: IdSchema,
    planId: IdSchema,
    planVersion: z.number().int().positive(),
    intendedJobId: IdSchema,
    intendedAttemptId: IdSchema,
    inputEvidenceId: IdSchema,
    inputContentDigest: DigestSchema,
  })
  .strict();
export const AtomMapPublicationRequestSchema = z
  .union([AtomMapPublicationRequestV1Schema, AtomMapPublicationRequestV2Schema])
  .superRefine((request, context) => {
    if (
      "inputEvidenceId" in request &&
      (request.inputEvidenceId !== request.sourceArtifact.evidenceRef ||
        request.inputContentDigest !== request.atomMap.digest)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inputEvidenceId"],
        message: "Coordinator input must match the exact AtomMap source artifact and digest",
      });
    }
  });
export type AtomMapPublicationRequest = z.infer<typeof AtomMapPublicationRequestSchema>;

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

export const AtomMapEntrySchema = z
  .object({
    systemAtomIndex: z.number().int().positive(),
    componentId: IdSchema,
    componentAtomIndex: z.number().int().positive(),
    chainId: z.string().min(1).max(8).optional(),
    residueIndex: z.number().int(),
    residueName: z.string().min(1).max(8),
    atomName: z.string().min(1).max(8),
    element: z.string().regex(/^[A-Z][a-z]?$/u, "Expected an element symbol"),
  })
  .strict();
export type AtomMapEntry = z.infer<typeof AtomMapEntrySchema>;

export const AtomMapSchema = z
  .object({
    schemaVersion: z.literal(AtomMapSchemaVersion),
    id: IdSchema,
    revision: z.number().int().positive(),
    systemManifestId: IdSchema,
    systemManifestRevision: z.number().int().positive(),
    indexBase: z.literal(1),
    atomCount: z.number().int().positive(),
    topologyDigest: DigestSchema,
    coordinateDigest: DigestSchema,
    entries: z.array(AtomMapEntrySchema).min(1),
    mapDigest: DigestSchema,
  })
  .strict()
  .superRefine((atomMap, context) => {
    if (atomMap.entries.length !== atomMap.atomCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["atomCount"],
        message: "Atom-map count must equal the number of mapping entries",
      });
    }
    const systemIndices = atomMap.entries.map((entry) => entry.systemAtomIndex);
    if (new Set(systemIndices).size !== systemIndices.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries"],
        message: "System atom indices must be unique",
      });
    }
    const sortedIndices = [...systemIndices].sort((left, right) => left - right);
    if (sortedIndices.some((value, index) => value !== index + 1)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries"],
        message: "System atom indices must be contiguous and one-based",
      });
    }
    const componentIndices = atomMap.entries.map(
      (entry) => `${entry.componentId}\u0000${entry.componentAtomIndex}`,
    );
    if (new Set(componentIndices).size !== componentIndices.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries"],
        message: "A component atom may map to only one system atom",
      });
    }
    const indicesByComponent = new Map<string, number[]>();
    for (const entry of atomMap.entries) {
      const indices = indicesByComponent.get(entry.componentId) ?? [];
      indices.push(entry.componentAtomIndex);
      indicesByComponent.set(entry.componentId, indices);
    }
    for (const [componentId, indices] of indicesByComponent) {
      const sorted = [...indices].sort((left, right) => left - right);
      if (sorted.some((value, index) => value !== index + 1)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries"],
          message: `Component ${componentId} atom indices must be contiguous and one-based`,
        });
      }
    }
  });
export type AtomMap = z.infer<typeof AtomMapSchema>;

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

/** Raised when a valid versioned record no longer matches its canonical self-digest. */
export class ScientificSchemaDigestMismatchError extends Error {
  readonly code = "SCIENTIFIC_SCHEMA_DIGEST_MISMATCH" as const;

  constructor(
    readonly recordType: string,
    readonly recordId: string,
    readonly expectedDigest: string,
    readonly observedDigest: string,
  ) {
    super(
      `${recordType} ${recordId} digest mismatch: expected ${expectedDigest}, observed ${observedDigest}`,
    );
    this.name = "ScientificSchemaDigestMismatchError";
  }
}

function canonicalDigestOmitting(value: object, omittedFields: readonly string[]): string {
  const omitted = new Set(omittedFields);
  const payload: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!omitted.has(key)) payload[key] = item;
  }
  return digestCanonical(payload);
}

function canonicalSelfDigest(value: object, selfDigestField: string): string {
  return canonicalDigestOmitting(value, [selfDigestField]);
}

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

/** Digests the complete canonical atom mapping except its self-digest. */
export function computeAtomMapDigest(value: object): string {
  return canonicalSelfDigest(value, "mapDigest");
}

/** Validates the sole atom-map identity accepted by preparation and engine adapters. */
export function assertAtomMapDigest(value: unknown): AtomMap {
  const atomMap = AtomMapSchema.parse(value);
  const observedDigest = computeAtomMapDigest(atomMap);
  if (observedDigest !== atomMap.mapDigest) {
    throw new ScientificSchemaDigestMismatchError(
      "AtomMap",
      atomMap.id,
      atomMap.mapDigest,
      observedDigest,
    );
  }
  return atomMap;
}

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
