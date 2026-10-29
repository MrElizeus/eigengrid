import {
  ActorIdentitySchema,
  BiomolecularAcquisitionCachePolicySchema,
  PdbIdentifierSchema,
  PubChemCidSchema,
  DigestSchema,
  IdSchema,
  MdStageOperationRequestSchema,
  TimestampSchema,
  digestCanonical,
} from "@eigengrid/scientific-schema";
import { z } from "zod";

export const MdToolRequestSchemaVersion = "eigengrid.md-tool-request/v2" as const;
export const MdToolReceiptSchemaVersion = "eigengrid.md-tool-receipt/v2" as const;

export const MdDecisionKindSchema = z.enum([
  "construct",
  "protonation",
  "microstate",
  "pose",
  "force_field_stack",
  "membrane_model",
  "protocol",
  "replica_set",
  "production_extension",
  "remediation",
]);

export const MdEvidenceBindingSchema = z
  .object({
    id: IdSchema,
    contentDigest: DigestSchema,
  })
  .strict();

export const MdExactSubjectReferenceSchema = z
  .object({
    id: IdSchema,
    revision: z.number().int().positive(),
    contentDigest: DigestSchema,
  })
  .strict();

export const MdDecisionReferenceSchema = MdExactSubjectReferenceSchema.extend({
  kind: MdDecisionKindSchema,
  approvalRequestId: IdSchema,
  approvalRequestRevision: z.number().int().positive(),
  approvalRequestDigest: DigestSchema,
}).strict();

export const MdPoseDecisionReferenceSchema = MdDecisionReferenceSchema.extend({
  kind: z.literal("pose"),
}).strict();

export const MdObservedVersionSchema = z
  .object({
    subjectId: IdSchema,
    revision: z.number().int().positive(),
    contentDigest: DigestSchema,
  })
  .strict();

export const MdObservedVersionsSchema = z
  .array(MdObservedVersionSchema)
  .min(1)
  .superRefine((versions, context) => {
    const exactVersionKeys = versions.map(
      (version) => `${version.subjectId}\u0000${version.revision}`,
    );
    if (new Set(exactVersionKeys).size !== exactVersionKeys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Each exact subject revision may be observed once",
      });
    }
  });

export const MdTrajectorySegmentReferenceSchema = MdExactSubjectReferenceSchema.extend({
  replicaId: IdSchema,
  segmentIndex: z.number().int().nonnegative(),
}).strict();

export const MdComponentPreparationOperationKindSchema = z.enum([
  "prepare_receptor",
  "prepare_ligand",
  "parameterize_ligand",
  "validate_ligand_parameters",
  "generate_pose_candidates",
  "select_pose",
]);

export const MdSystemPreparationOperationKindSchema = z.enum([
  "orient_membrane",
  "build_membrane_system",
  "solvate_ionize",
  "build_amber_topology",
  "validate_topology",
]);

function addDuplicateExactReferenceIssues(
  references: readonly { readonly id: string }[],
  context: z.RefinementCtx,
  path: string,
): void {
  const ids = references.map((reference) => reference.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [path],
      message: "Exact subject references must be unique by id",
    });
  }
}

export const MdToolEnvelopeShape = {
  schemaVersion: z.literal(MdToolRequestSchemaVersion),
  requestId: IdSchema,
  idempotencyKey: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  missionId: IdSchema,
  expectedMissionRevision: z.number().int().positive(),
  expectedSubjectRevision: z.number().int().positive(),
  actorRef: ActorIdentitySchema.strict(),
  evidenceRefs: z.array(MdEvidenceBindingSchema),
} as const;

export const EmptyPayloadSchema = z.object({}).strict();

export const SubjectPayloadSchema = z
  .object({
    subjectId: IdSchema,
    subjectRevision: z.number().int().positive(),
    subjectDigest: DigestSchema,
  })
  .strict();

export const PdbFetchPayloadSchema = z
  .object({
    pdbId: PdbIdentifierSchema,
    format: z.enum(["mmcif", "pdb"]),
    expectedContentDigest: DigestSchema.optional(),
    expectedProviderRevision: z.string().min(1).optional(),
    cachePolicy: BiomolecularAcquisitionCachePolicySchema,
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.cachePolicy === "cache_only" && payload.expectedContentDigest === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedContentDigest"],
        message: "cache_only requires an exact expected content digest",
      });
    }
  });

export const PubChemFetchPayloadSchema = z
  .object({
    cid: PubChemCidSchema,
    format: z.enum(["sdf", "json"]),
    expectedContentDigest: DigestSchema.optional(),
    expectedProviderRevision: z.string().min(1).optional(),
    cachePolicy: BiomolecularAcquisitionCachePolicySchema,
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.cachePolicy === "cache_only" && payload.expectedContentDigest === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedContentDigest"],
        message: "cache_only requires an exact expected content digest",
      });
    }
  });

export const ProposalPayloadSchema = z
  .object({
    subjectId: IdSchema,
    subjectRevision: z.number().int().positive(),
    subjectDigest: DigestSchema,
    decisionKind: MdDecisionKindSchema,
    constraintRefs: z.array(IdSchema),
  })
  .strict();

export const ProtocolPayloadSchema = z
  .object({
    planId: IdSchema,
    planRevision: z.number().int().positive(),
    planDigest: DigestSchema,
    systemManifestId: IdSchema,
    systemManifestRevision: z.number().int().positive(),
    systemManifestDigest: DigestSchema,
    protocolId: IdSchema.optional(),
    protocolRevision: z.number().int().positive().optional(),
    protocolDigest: DigestSchema.optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    const protocolFields = [payload.protocolId, payload.protocolRevision, payload.protocolDigest];
    if (![0, 3].includes(protocolFields.filter((value) => value !== undefined).length)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["protocolId"],
        message: "Protocol identity must be omitted or supplied in full",
      });
    }
  });

export const ProtocolDiffPayloadSchema = z
  .object({
    leftProtocolId: IdSchema,
    leftProtocolRevision: z.number().int().positive(),
    leftProtocolDigest: DigestSchema,
    rightProtocolId: IdSchema,
    rightProtocolRevision: z.number().int().positive(),
    rightProtocolDigest: DigestSchema,
  })
  .strict()
  .refine(
    (payload) =>
      payload.leftProtocolId !== payload.rightProtocolId ||
      payload.leftProtocolRevision !== payload.rightProtocolRevision ||
      payload.leftProtocolDigest !== payload.rightProtocolDigest,
    { message: "A protocol diff requires two distinct exact revisions" },
  );

export const EvidenceImportPayloadSchema = z
  .object({
    evidenceId: IdSchema,
    evidenceRevision: z.number().int().positive(),
    sourceKind: z.enum(["pdb", "pubchem", "notebook_reference", "operator_upload"]),
    sourceRecordId: z.string().min(1),
    mediaType: z.string().min(1),
    expectedContentDigest: DigestSchema,
    acquisitionRequestDigest: DigestSchema,
  })
  .strict();

export const SystemManifestCreatePayloadSchema = z
  .object({
    systemManifestId: IdSchema,
    systemManifestRevision: z.number().int().positive(),
    systemManifestDigest: DigestSchema,
    sourceEvidenceRefs: z.array(MdEvidenceBindingSchema).min(1),
    decisionRefs: z.array(MdDecisionReferenceSchema).min(1),
    forceFieldStackId: IdSchema,
    forceFieldStackRevision: z.number().int().positive(),
    forceFieldStackDigest: DigestSchema,
    parameterManifestId: IdSchema,
    parameterManifestRevision: z.number().int().positive(),
    parameterManifestDigest: DigestSchema,
  })
  .strict()
  .superRefine((payload, context) => {
    addDuplicateExactReferenceIssues(payload.decisionRefs, context, "decisionRefs");
  });

export const DecisionApprovalPayloadSchema = z
  .object({
    decisionKind: MdDecisionKindSchema,
    decisionId: IdSchema,
    decisionRevision: z.number().int().positive(),
    decisionDigest: DigestSchema,
    approvalRequestId: IdSchema,
    expectedApprovalRevision: z.number().int().positive(),
    approvalRequestDigest: DigestSchema,
  })
  .strict();

export const MdComponentPreparationPayloadObjectSchema = z
  .object({
    operationKind: MdComponentPreparationOperationKindSchema,
    componentKind: z.enum(["protein", "ligand"]),
    systemManifestId: IdSchema,
    systemManifestRevision: z.number().int().positive(),
    systemManifestDigest: DigestSchema,
    componentId: IdSchema,
    componentRevision: z.number().int().positive(),
    componentDigest: DigestSchema,
    decisionRefs: z.array(MdDecisionReferenceSchema).min(1),
    inputArtifactRefs: z.array(MdEvidenceBindingSchema).min(1),
    parameterManifestId: IdSchema,
    parameterManifestRevision: z.number().int().positive(),
    parameterManifestDigest: DigestSchema,
  })
  .strict();

export const ComponentPreparationPayloadSchema =
  MdComponentPreparationPayloadObjectSchema.superRefine((payload, context) => {
    addDuplicateExactReferenceIssues(payload.decisionRefs, context, "decisionRefs");
  });

export const MdSystemPreparationPayloadObjectSchema = z
  .object({
    operationKind: MdSystemPreparationOperationKindSchema,
    systemManifestId: IdSchema,
    systemManifestRevision: z.number().int().positive(),
    systemManifestDigest: DigestSchema,
    decisionRefs: z.array(MdDecisionReferenceSchema).min(1),
    inputArtifactRefs: z.array(MdEvidenceBindingSchema).min(1),
    parameterManifestId: IdSchema,
    parameterManifestRevision: z.number().int().positive(),
    parameterManifestDigest: DigestSchema,
  })
  .strict();

export const SystemPreparationPayloadSchema = MdSystemPreparationPayloadObjectSchema.superRefine(
  (payload, context) => {
    addDuplicateExactReferenceIssues(payload.decisionRefs, context, "decisionRefs");
  },
);

export const StageReferencePayloadSchema = z
  .object({
    protocolId: IdSchema,
    protocolRevision: z.number().int().positive(),
    protocolDigest: DigestSchema,
    stageId: IdSchema,
    stageRevision: z.number().int().positive(),
    stageDigest: DigestSchema,
  })
  .strict();

export const StageRenderPayloadSchema = StageReferencePayloadSchema.extend({
  workUnitId: IdSchema,
  workUnitRevision: z.number().int().positive(),
  workUnitDigest: DigestSchema,
  executionBindingDigest: DigestSchema,
  outputContractDigest: DigestSchema,
  environmentSnapshotId: IdSchema,
  environmentDigest: DigestSchema,
  environmentBindingDigest: DigestSchema,
  rendererContractDigest: DigestSchema,
}).strict();

export const StageOperationPayloadSchema = StageReferencePayloadSchema.extend({
  workUnitId: IdSchema,
  workUnitRevision: z.number().int().positive(),
  workUnitDigest: DigestSchema,
  operationId: IdSchema,
  expectedOperationRevision: z.number().int().positive(),
  operationDigest: DigestSchema,
}).strict();

export const StageStatusPayloadSchema = StageOperationPayloadSchema.extend({
  replicaSegment: z
    .object({
      replicaSetId: IdSchema,
      replicaSetRevision: z.number().int().positive(),
      replicaSetDigest: DigestSchema,
      replicaId: IdSchema,
      segmentId: IdSchema,
      segmentRevision: z.number().int().positive(),
      segmentDigest: DigestSchema,
      segmentIndex: z.number().int().nonnegative(),
    })
    .strict()
    .nullable(),
}).strict();

export const StageSubmissionPayloadSchema = StageRenderPayloadSchema.extend({
  operationRequest: MdStageOperationRequestSchema,
  operationRequestDigest: DigestSchema,
})
  .strict()
  .superRefine((payload, context) => {
    const request = payload.operationRequest;
    const mismatches = [
      request.workUnitId !== payload.workUnitId,
      request.bindingDigest !== payload.executionBindingDigest,
      request.outputContractDigest !== payload.outputContractDigest,
      request.stage.id !== payload.stageId,
      request.stage.revision !== payload.stageRevision,
      request.stage.digest !== payload.stageDigest,
      request.environment.canonicalSnapshotId !== payload.environmentSnapshotId,
      request.environment.canonicalSnapshotDigest !== payload.environmentDigest,
      request.environment.bindingDigest !== payload.environmentBindingDigest,
      request.render.mapperDigest !== payload.rendererContractDigest,
      digestCanonical(request) !== payload.operationRequestDigest,
    ];
    if (mismatches.some(Boolean)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operationRequest"],
        message: "Stage submission fields must match the exact v2 operation authorization",
      });
    }
  });

export const ArtifactVerificationPayloadSchema = z
  .object({
    stageResultId: IdSchema,
    stageResultRevision: z.number().int().positive(),
    stageResultDigest: DigestSchema,
    artifactRefs: z.array(MdEvidenceBindingSchema).min(1),
  })
  .strict();

export const ReplicaSetCreatePayloadSchema = z
  .object({
    protocolId: IdSchema,
    protocolRevision: z.number().int().positive(),
    protocolDigest: DigestSchema,
    replicaSetId: IdSchema,
    replicaSetRevision: z.number().int().positive(),
    replicaSetDigest: DigestSchema,
    systemManifestId: IdSchema,
    systemManifestRevision: z.number().int().positive(),
    systemManifestDigest: DigestSchema,
    replicaCount: z.number().int().positive(),
    seedPolicyDigest: DigestSchema,
    decisionRef: MdDecisionReferenceSchema,
    initialRestartRefs: z.array(MdEvidenceBindingSchema).min(1),
  })
  .strict()
  .refine((payload) => payload.initialRestartRefs.length === payload.replicaCount, {
    path: ["initialRestartRefs"],
    message: "Each replica requires one exact initial restart",
  });

export const ProductionExtensionPayloadSchema = z
  .object({
    replicaSetId: IdSchema,
    replicaSetRevision: z.number().int().positive(),
    replicaSetDigest: DigestSchema,
    extensionTimePs: z.number().positive(),
    convergenceAssessmentId: IdSchema,
    convergenceAssessmentRevision: z.number().int().positive(),
    convergenceAssessmentDigest: DigestSchema,
    extensionDecisionId: IdSchema,
    extensionDecisionRevision: z.number().int().positive(),
    extensionDecisionDigest: DigestSchema,
    extensionDecisionKind: z.literal("production_extension"),
    approvalRequestId: IdSchema,
    approvalRequestRevision: z.number().int().positive(),
    approvalRequestDigest: DigestSchema,
  })
  .strict();

export const MdoutParsePayloadSchema = z
  .object({
    stageResultId: IdSchema,
    stageResultRevision: z.number().int().positive(),
    stageResultDigest: DigestSchema,
    mdoutRef: MdEvidenceBindingSchema,
    mdinfoRef: MdEvidenceBindingSchema.optional(),
    parserContractDigest: DigestSchema,
  })
  .strict();

export const TrajectoryAnalysisPayloadSchema = z
  .object({
    systemManifestId: IdSchema,
    systemManifestRevision: z.number().int().positive(),
    systemManifestDigest: DigestSchema,
    atomMapRef: MdEvidenceBindingSchema,
    topologyRef: MdEvidenceBindingSchema,
    replicaSetId: IdSchema,
    replicaSetRevision: z.number().int().positive(),
    replicaSetDigest: DigestSchema,
    stageResultRefs: z.array(MdExactSubjectReferenceSchema).min(1),
    trajectorySegmentRefs: z.array(MdTrajectorySegmentReferenceSchema).min(1),
    trajectoryRefs: z.array(MdEvidenceBindingSchema).min(1),
    analysisPlanId: IdSchema,
    analysisPlanRevision: z.number().int().positive(),
    analysisPlanDigest: DigestSchema,
  })
  .strict()
  .superRefine((payload, context) => {
    addDuplicateExactReferenceIssues(payload.stageResultRefs, context, "stageResultRefs");
    addDuplicateExactReferenceIssues(
      payload.trajectorySegmentRefs,
      context,
      "trajectorySegmentRefs",
    );
    const segmentCoordinates = payload.trajectorySegmentRefs.map(
      (segment) => `${segment.replicaId}\u0000${segment.segmentIndex}`,
    );
    if (new Set(segmentCoordinates).size !== segmentCoordinates.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trajectorySegmentRefs"],
        message: "Trajectory segments must be unique by replica and segment index",
      });
    }
    if (payload.trajectoryRefs.length !== payload.trajectorySegmentRefs.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trajectoryRefs"],
        message: "Each exact trajectory segment requires one trajectory artifact binding",
      });
    }
  });

export const StageAssessmentPayloadSchema = z
  .object({
    stageResultId: IdSchema,
    stageResultRevision: z.number().int().positive(),
    stageResultDigest: DigestSchema,
    normalizedMetricsRefs: z.array(MdEvidenceBindingSchema).min(1),
    acceptanceCriteriaDigest: DigestSchema,
    assessorContractDigest: DigestSchema,
  })
  .strict();

export const ReplicaConvergencePayloadSchema = z
  .object({
    replicaSetId: IdSchema,
    replicaSetRevision: z.number().int().positive(),
    replicaSetDigest: DigestSchema,
    metricSeriesRefs: z.array(MdEvidenceBindingSchema).min(2),
    analysisPlanId: IdSchema,
    analysisPlanRevision: z.number().int().positive(),
    analysisPlanDigest: DigestSchema,
  })
  .strict();

export const FailureDiagnosisPayloadSchema = z
  .object({
    stageResultId: IdSchema,
    stageResultRevision: z.number().int().positive(),
    stageResultDigest: DigestSchema,
    operationReceiptId: IdSchema,
    diagnosticArtifactRefs: z.array(MdEvidenceBindingSchema).min(1),
    diagnosticContractDigest: DigestSchema,
  })
  .strict();

export const RemediationProposalPayloadSchema = z
  .object({
    diagnosisId: IdSchema,
    diagnosisRevision: z.number().int().positive(),
    diagnosisDigest: DigestSchema,
    stageId: IdSchema,
    stageRevision: z.number().int().positive(),
    stageDigest: DigestSchema,
    permittedChangeKinds: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const ScientificAssessmentPayloadSchema = z
  .object({
    systemManifestId: IdSchema,
    systemManifestRevision: z.number().int().positive(),
    systemManifestDigest: DigestSchema,
    protocolId: IdSchema,
    protocolRevision: z.number().int().positive(),
    protocolDigest: DigestSchema,
    stageAssessmentRefs: z.array(MdEvidenceBindingSchema).min(1),
    convergenceAssessmentRef: MdEvidenceBindingSchema.optional(),
    assessmentContractDigest: DigestSchema,
  })
  .strict();

export const ComparisonPayloadSchema = z
  .object({
    leftSubjectId: IdSchema,
    leftRevision: z.number().int().positive(),
    leftDigest: DigestSchema,
    rightSubjectId: IdSchema,
    rightRevision: z.number().int().positive(),
    rightDigest: DigestSchema,
    atomMapDigest: DigestSchema,
    toleranceManifestDigest: DigestSchema.optional(),
  })
  .strict();

export const ProvenancePayloadSchema = z
  .object({
    subjectId: IdSchema,
    subjectRevision: z.number().int().positive(),
    subjectDigest: DigestSchema,
    traversal: z.enum(["ancestors", "descendants", "complete"]),
    bundleFormat: z.enum(["manifest", "tar"]),
  })
  .strict();

export type MdToolPayload =
  | z.infer<typeof EmptyPayloadSchema>
  | z.infer<typeof SubjectPayloadSchema>
  | z.infer<typeof PdbFetchPayloadSchema>
  | z.infer<typeof PubChemFetchPayloadSchema>
  | z.infer<typeof ProposalPayloadSchema>
  | z.infer<typeof ProtocolPayloadSchema>
  | z.infer<typeof ProtocolDiffPayloadSchema>
  | z.infer<typeof EvidenceImportPayloadSchema>
  | z.infer<typeof SystemManifestCreatePayloadSchema>
  | z.infer<typeof DecisionApprovalPayloadSchema>
  | z.infer<typeof ComponentPreparationPayloadSchema>
  | z.infer<typeof SystemPreparationPayloadSchema>
  | z.infer<typeof StageReferencePayloadSchema>
  | z.infer<typeof StageRenderPayloadSchema>
  | z.infer<typeof StageOperationPayloadSchema>
  | z.infer<typeof StageStatusPayloadSchema>
  | z.infer<typeof StageSubmissionPayloadSchema>
  | z.infer<typeof ArtifactVerificationPayloadSchema>
  | z.infer<typeof ReplicaSetCreatePayloadSchema>
  | z.infer<typeof ProductionExtensionPayloadSchema>
  | z.infer<typeof MdoutParsePayloadSchema>
  | z.infer<typeof TrajectoryAnalysisPayloadSchema>
  | z.infer<typeof StageAssessmentPayloadSchema>
  | z.infer<typeof ReplicaConvergencePayloadSchema>
  | z.infer<typeof FailureDiagnosisPayloadSchema>
  | z.infer<typeof RemediationProposalPayloadSchema>
  | z.infer<typeof ScientificAssessmentPayloadSchema>
  | z.infer<typeof ComparisonPayloadSchema>
  | z.infer<typeof ProvenancePayloadSchema>;

export const MdToolRecordSchema = z
  .object({
    id: IdSchema,
    kind: z.string().min(1),
    revision: z.number().int().positive(),
    contentDigest: DigestSchema,
    summary: z.string().min(1),
  })
  .strict();

export const MdReadResultSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.md-tool-read-result/v2"),
    requestId: IdSchema,
    missionId: IdSchema,
    status: z.literal("completed"),
    records: z.array(MdToolRecordSchema),
    observedVersions: MdObservedVersionsSchema,
    warnings: z.array(z.string().min(1)),
  })
  .strict();

export const MdProposalResultSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.md-tool-proposal-result/v2"),
    requestId: IdSchema,
    missionId: IdSchema,
    proposal: z
      .object({
        id: IdSchema,
        revision: z.number().int().positive(),
        proposalDigest: DigestSchema,
        status: z.literal("proposed"),
        approvalRequired: z.literal(true),
      })
      .strict(),
    evidenceRefs: z.array(MdEvidenceBindingSchema),
    observedVersions: MdObservedVersionsSchema,
    warnings: z.array(z.string().min(1)),
  })
  .strict();

export const MdOperationReceiptSchema = z
  .object({
    schemaVersion: z.literal(MdToolReceiptSchemaVersion),
    requestId: IdSchema,
    missionId: IdSchema,
    operationId: IdSchema,
    requestDigest: DigestSchema,
    status: z.enum(["intent", "acknowledged", "confirmed", "failed", "ambiguous"]),
    effectStage: z.enum([
      "intent_recorded",
      "effect_started",
      "acknowledged",
      "receipt_recorded",
      "reconciled",
    ]),
    correlationId: IdSchema,
    externalIdentity: z
      .object({
        kind: z.string().min(1),
        id: z.string().min(1),
        identityDigest: DigestSchema,
      })
      .strict()
      .optional(),
    artifactRefs: z.array(MdEvidenceBindingSchema),
    observedVersions: MdObservedVersionsSchema,
    recordedAt: TimestampSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    const artifactIds = receipt.artifactRefs.map((artifact) => artifact.id);
    if (new Set(artifactIds).size !== artifactIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifactRefs"],
        message: "A receipt may bind each artifact id once",
      });
    }
    const allowedEffectStages = {
      intent: ["intent_recorded"],
      acknowledged: ["acknowledged", "receipt_recorded"],
      confirmed: ["receipt_recorded", "reconciled"],
      failed: [
        "intent_recorded",
        "effect_started",
        "acknowledged",
        "receipt_recorded",
        "reconciled",
      ],
      ambiguous: ["effect_started", "acknowledged", "receipt_recorded", "reconciled"],
    } as const;
    if (!(allowedEffectStages[receipt.status] as readonly string[]).includes(receipt.effectStage)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effectStage"],
        message: `effectStage ${receipt.effectStage} is impossible for status ${receipt.status}`,
      });
    }
  });

export const MdAnalysisResultSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.md-tool-analysis-result/v2"),
    requestId: IdSchema,
    missionId: IdSchema,
    analysisRef: MdToolRecordSchema,
    sourceArtifactRefs: z.array(MdEvidenceBindingSchema).min(1),
    observedVersions: MdObservedVersionsSchema,
    validationStatus: z.enum(["passed", "failed", "inconclusive", "not_applicable"]),
    warnings: z.array(z.string().min(1)),
  })
  .strict();

export const MdToolOutputSchemas = {
  read: MdReadResultSchema,
  proposal: MdProposalResultSchema,
  receipt: MdOperationReceiptSchema,
  analysis: MdAnalysisResultSchema,
} as const;

export type MdToolOutputKind = keyof typeof MdToolOutputSchemas;
export type MdToolOutput = z.infer<(typeof MdToolOutputSchemas)[MdToolOutputKind]>;
