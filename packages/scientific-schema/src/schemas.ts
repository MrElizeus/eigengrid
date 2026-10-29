import { z } from "zod";

export const SchemaVersion = "eigengrid.scientific/v1" as const;

export const IdSchema = z.string().min(1).max(256);
export const TimestampSchema = z.string().datetime({ offset: true });
export const DigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, "Expected a lower-case SHA-256 digest");
export const SemverSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);

export const ActorIdentitySchema = z.object({
  id: IdSchema,
  kind: z.enum(["human", "model", "service"]),
  displayName: z.string().min(1).optional(),
  role: z.string().min(1),
});
export type ActorIdentity = z.infer<typeof ActorIdentitySchema>;

export const ScientificRiskClassSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export type ScientificRiskClass = z.infer<typeof ScientificRiskClassSchema>;

export const CapabilityMaturitySchema = z.enum([
  "reference",
  "advisory",
  "plannable",
  "renderable",
  "executable",
  "validated",
]);

export const KnowledgeMaturitySchema = z.enum([
  "draft",
  "reference_curated",
  "expert_reviewed",
  "benchmark_backed",
  "production_certified",
]);

/** Open, versioned execution capability identity; avoids widening domain-specific enums. */
export const ScientificCapabilityIdSchema = z
  .string()
  .min(3)
  .max(160)
  .regex(
    /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u,
    "Expected a stable, namespaced lower-case capability id",
  );
export type ScientificCapabilityId = z.infer<typeof ScientificCapabilityIdSchema>;

export const ScientificCapabilityReferenceSchema = z
  .object({
    id: ScientificCapabilityIdSchema,
    version: SemverSchema,
    contractDigest: DigestSchema,
  })
  .strict();
export type ScientificCapabilityReference = z.infer<typeof ScientificCapabilityReferenceSchema>;

export const MolecularSystemReferenceSchema = z.object({
  evidenceId: IdSchema,
  format: z.enum(["xyz", "sdf", "mol", "pdb", "smiles", "inchi", "engine_input"]),
  contentDigest: DigestSchema,
  atomCount: z.number().int().positive().optional(),
  charge: z.number().int().optional(),
  multiplicity: z.number().int().positive().optional(),
});
export type MolecularSystemReference = z.infer<typeof MolecularSystemReferenceSchema>;

export const ScientificObjectiveSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  id: IdSchema,
  statement: z.string().min(1),
  system: MolecularSystemReferenceSchema,
  targetProperties: z.array(z.string().min(1)).min(1),
  environmentalModel: z.string().min(1).optional(),
  requiredConfidence: z.enum(["exploratory", "screening", "defensible"]).default("screening"),
});
export type ScientificObjective = z.infer<typeof ScientificObjectiveSchema>;

export const MissionConstraintsSchema = z.object({
  allowedEngines: z.array(z.string().min(1)).min(1),
  deniedEngines: z.array(z.string().min(1)).default([]),
  maximumWallTimeSeconds: z.number().int().positive().optional(),
  maximumCost: z.number().nonnegative().optional(),
  offlineRequired: z.boolean().default(false),
  materialChangesRequireApproval: z.boolean().default(true),
  immutableScientificFields: z
    .array(z.string().min(1))
    .default(["objective", "charge", "multiplicity", "method", "basis", "physicalModel"]),
});
export type MissionConstraints = z.infer<typeof MissionConstraintsSchema>;

export const ScientificAssumptionSchema = z.object({
  id: IdSchema,
  statement: z.string().min(1),
  status: z.enum(["proposed", "accepted", "rejected", "invalidated"]),
  riskClass: ScientificRiskClassSchema,
  evidenceRefs: z.array(IdSchema).default([]),
});
export type ScientificAssumption = z.infer<typeof ScientificAssumptionSchema>;

export const AcceptanceCriterionSchema = z.object({
  id: IdSchema,
  kind: z.enum([
    "normal_termination",
    "electronic_convergence",
    "geometry_convergence",
    "minimum_frequency",
    "transition_state",
    "uncertainty",
    "custom",
  ]),
  description: z.string().min(1),
  required: z.boolean(),
  threshold: z.number().optional(),
  unit: z.string().min(1).optional(),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const BudgetReservationSchema = z.object({
  id: IdSchema,
  workUnitId: IdSchema.optional(),
  operationId: IdSchema.optional(),
  kind: z.enum(["external_operation", "model_tokens", "wall_time_seconds", "cost"]),
  amount: z.number().nonnegative(),
  state: z.enum(["reserved", "consumed", "released", "ambiguous"]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type BudgetReservation = z.infer<typeof BudgetReservationSchema>;

export const MissionBudgetSchema = z.object({
  id: IdSchema,
  missionId: IdSchema,
  revision: z.number().int().positive(),
  limits: z.object({
    externalOperations: z.number().int().nonnegative(),
    modelTokens: z.number().int().nonnegative(),
    wallTimeSeconds: z.number().int().nonnegative(),
    cost: z.number().nonnegative(),
  }),
  consumed: z.object({
    externalOperations: z.number().int().nonnegative(),
    modelTokens: z.number().int().nonnegative(),
    wallTimeSeconds: z.number().int().nonnegative(),
    cost: z.number().nonnegative(),
  }),
  reservations: z.array(BudgetReservationSchema).default([]),
});
export type MissionBudget = z.infer<typeof MissionBudgetSchema>;

export const MissionStateSchema = z.enum([
  "created",
  "scoping",
  "planning",
  "awaiting_approval",
  "ready",
  "executing",
  "observing",
  "diagnosing",
  "replanning",
  "validating",
  "completed",
  "paused",
  "blocked",
  "failed",
  "cancel_requested",
  "cancelling",
  "cancelled",
]);
export type MissionState = z.infer<typeof MissionStateSchema>;

export const ScientificMissionSchema = z.object({
  schemaVersion: z.literal(SchemaVersion),
  id: IdSchema,
  revision: z.number().int().positive(),
  state: MissionStateSchema,
  objective: ScientificObjectiveSchema,
  constraints: MissionConstraintsSchema,
  assumptions: z.array(ScientificAssumptionSchema),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
  activePlanId: IdSchema.nullable(),
  budgetId: IdSchema,
  policyProfile: IdSchema,
  requestedBy: ActorIdentitySchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  terminalAt: TimestampSchema.optional(),
});
export type ScientificMission = z.infer<typeof ScientificMissionSchema>;

export const SkillVersionReferenceSchema = z.object({
  skillId: IdSchema,
  version: SemverSchema,
  contentDigest: DigestSchema,
});
export type SkillVersionReference = z.infer<typeof SkillVersionReferenceSchema>;

export const SkillFragmentReferenceSchema = SkillVersionReferenceSchema.extend({
  fragmentId: IdSchema,
  fragmentDigest: DigestSchema,
  relativePath: z.string().min(1),
  selector: z.string().min(1),
});
export type SkillFragmentReference = z.infer<typeof SkillFragmentReferenceSchema>;

export const ResolvedSkillGraphSchema = z.object({
  id: IdSchema,
  schemaVersion: z.literal("eigengrid.resolved-skill-graph/v1"),
  missionId: IdSchema,
  requestedSkillIds: z.array(IdSchema),
  nodes: z.array(SkillVersionReferenceSchema),
  edges: z.array(
    z.object({
      from: IdSchema,
      to: IdSchema,
      kind: z.enum(["hard", "optional"]),
    }),
  ),
  selectedFragments: z.array(SkillFragmentReferenceSchema),
  resolverVersion: SemverSchema,
  environmentDigest: DigestSchema,
  graphDigest: DigestSchema,
  resolvedAt: TimestampSchema,
});
export type ResolvedSkillGraph = z.infer<typeof ResolvedSkillGraphSchema>;

export const ProtocolFragmentSchema = z.object({
  id: IdSchema,
  kind: z.enum([
    "structure_validation",
    "optimization",
    "frequency",
    "collection",
    "parsing",
    "validation",
    "assessment",
    "diagnosis",
  ]),
  reason: z.string().min(1),
  parameters: z.record(z.unknown()),
  sourceFragments: z.array(SkillFragmentReferenceSchema).min(1),
  riskClass: ScientificRiskClassSchema,
});
export type ProtocolFragment = z.infer<typeof ProtocolFragmentSchema>;

/**
 * Generic binding used by non-QC verticals. Its namespaced capability is authoritative;
 * the literal kind exists only to preserve WorkUnit indexing and ownership semantics.
 */
export const ScientificCapabilityProtocolFragmentSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.scientific-capability-fragment/v1"),
    id: IdSchema,
    kind: z.literal("scientific_capability"),
    capability: ScientificCapabilityReferenceSchema,
    reason: z.string().min(1),
    parameters: z.record(z.unknown()),
    sourceFragments: z.array(SkillFragmentReferenceSchema).min(1),
    riskClass: ScientificRiskClassSchema,
  })
  .strict();
export type ScientificCapabilityProtocolFragment = z.infer<
  typeof ScientificCapabilityProtocolFragmentSchema
>;

export const WorkUnitProtocolFragmentSchema = z.union([
  ProtocolFragmentSchema,
  ScientificCapabilityProtocolFragmentSchema,
]);
export type WorkUnitProtocolFragment = z.infer<typeof WorkUnitProtocolFragmentSchema>;

export const WorkUnitKindSchema = z.union([
  ProtocolFragmentSchema.shape.kind,
  z.literal("scientific_capability"),
]);
export type WorkUnitKind = z.infer<typeof WorkUnitKindSchema>;

export const ScientificProtocolSchema = z.object({
  id: IdSchema,
  schemaVersion: z.literal("eigengrid.scientific-protocol/v1"),
  objectiveId: IdSchema,
  system: MolecularSystemReferenceSchema,
  charge: z.number().int(),
  multiplicity: z.number().int().positive(),
  method: z.string().min(1),
  basis: z.string().min(1),
  physicalModel: z.string().min(1),
  engineAgnosticSteps: z.array(ProtocolFragmentSchema).min(1),
  /** Exact closed application-owned capability fragments reviewed under the
   * protocol digest. Generic QC compilation does not dispatch these steps. */
  capabilitySteps: z.array(ScientificCapabilityProtocolFragmentSchema).optional(),
  assumptions: z.array(IdSchema),
  decisions: z.array(IdSchema),
  acceptanceCriteria: z.array(IdSchema).min(1),
  skillGraphDigest: DigestSchema,
  compilerVersion: SemverSchema,
  protocolDigest: DigestSchema,
});
export type ScientificProtocol = z.infer<typeof ScientificProtocolSchema>;

export const PlanStatusSchema = z.enum([
  "draft",
  "under_review",
  "approved",
  "rejected",
  "superseded",
]);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const ScientificPlanSchema = z.object({
  id: IdSchema,
  missionId: IdSchema,
  version: z.number().int().positive(),
  revision: z.number().int().positive(),
  status: PlanStatusSchema,
  normalizedObjective: z.string().min(1),
  missingInputs: z.array(z.string()),
  assumptions: z.array(ScientificAssumptionSchema),
  skillResolution: ResolvedSkillGraphSchema,
  protocol: ScientificProtocolSchema,
  alternatives: z.array(z.object({ id: IdSchema, description: z.string().min(1) })),
  risks: z.array(
    z.object({
      id: IdSchema,
      riskClass: ScientificRiskClassSchema,
      description: z.string().min(1),
      mitigation: z.string().min(1),
    }),
  ),
  estimatedCost: z.object({
    wallTimeSeconds: z.number().int().nonnegative(),
    cpuCoreHours: z.number().nonnegative(),
    cost: z.number().nonnegative(),
  }),
  requiredApprovals: z.array(z.string().min(1)),
  validationGates: z.array(IdSchema),
  limitations: z.array(z.string().min(1)),
  createdBy: ActorIdentitySchema,
  parentPlanId: IdSchema.optional(),
  planDigest: DigestSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ScientificPlan = z.infer<typeof ScientificPlanSchema>;

export const WorkUnitStateSchema = z.enum([
  "created",
  "ready",
  "awaiting_approval",
  "claimed",
  "executing",
  "observing",
  "succeeded",
  "retryable_failed",
  "failed",
  "blocked",
  "cancel_requested",
  "cancelling",
  "cancelled",
]);
export type WorkUnitState = z.infer<typeof WorkUnitStateSchema>;

export const WorkUnitDependencySchema = z.object({
  workUnitId: IdSchema,
  dependsOnWorkUnitId: IdSchema,
});
export type WorkUnitDependency = z.infer<typeof WorkUnitDependencySchema>;

export const WorkUnitSchema = z
  .object({
    id: IdSchema,
    missionId: IdSchema,
    planId: IdSchema,
    planVersion: z.number().int().positive(),
    kind: WorkUnitKindSchema,
    state: WorkUnitStateSchema,
    reason: z.string().min(1),
    dependencies: z.array(IdSchema),
    inputRefs: z.array(IdSchema),
    outputContract: z.object({
      requiredEvidenceKinds: z.array(z.string().min(1)),
      requiredObservationKinds: z.array(z.string().min(1)),
    }),
    skillRefs: z.array(SkillFragmentReferenceSchema).min(1),
    protocolFragment: WorkUnitProtocolFragmentSchema,
    retryPolicy: z.object({
      maximumAttempts: z.number().int().positive(),
      ambiguityRequiresReconciliation: z.boolean(),
    }),
    approvalPolicy: z.object({
      required: z.boolean(),
      minimumRole: z.string().min(1).optional(),
    }),
    executionPolicy: z.object({
      capability: z.string().min(1),
      riskClass: ScientificRiskClassSchema,
    }),
    revision: z.number().int().positive(),
    claimOwner: IdSchema.nullable(),
    claimExpiresAt: TimestampSchema.nullable(),
    jobId: IdSchema.nullable(),
    attemptId: IdSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .superRefine((workUnit, context) => {
    if (workUnit.kind !== workUnit.protocolFragment.kind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["kind"],
        message: "WorkUnit kind must match its protocol-fragment kind",
      });
    }
    if (
      workUnit.protocolFragment.kind === "scientific_capability" &&
      workUnit.executionPolicy.capability !== workUnit.protocolFragment.capability.id
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executionPolicy", "capability"],
        message: "WorkUnit execution capability must match its versioned fragment binding",
      });
    }
  });
export type WorkUnit = z.infer<typeof WorkUnitSchema>;

export const MissionCheckpointSchema = z.object({
  id: IdSchema,
  missionId: IdSchema,
  planId: IdSchema,
  sequence: z.number().int().positive(),
  reason: z.enum(["step_completed", "interrupt", "replan", "shutdown", "failure"]),
  runnableWorkUnits: z.array(IdSchema),
  blockedWorkUnits: z.array(IdSchema),
  pendingApprovals: z.array(IdSchema),
  evidenceFrontier: z.array(IdSchema),
  contextDigest: DigestSchema,
  createdAt: TimestampSchema,
});
export type MissionCheckpoint = z.infer<typeof MissionCheckpointSchema>;

export const ScientificDecisionSchema = z.object({
  id: IdSchema,
  missionId: IdSchema,
  planId: IdSchema,
  category: z.enum([
    "charge",
    "multiplicity",
    "method",
    "basis",
    "physical_model",
    "numerical",
    "operational",
    "acceptance_criterion",
    "objective",
  ]),
  question: z.string().min(1),
  selectedOption: z.string().min(1),
  alternatives: z.array(
    z.object({ option: z.string().min(1), reasonNotSelected: z.string().min(1) }),
  ),
  rationale: z.string().min(1),
  skillRefs: z.array(SkillFragmentReferenceSchema),
  evidenceRefs: z.array(IdSchema),
  confidence: z.object({ level: z.enum(["low", "medium", "high"]), basis: z.string().min(1) }),
  riskClass: ScientificRiskClassSchema,
  requiresApproval: z.boolean(),
  actor: ActorIdentitySchema,
  createdAt: TimestampSchema,
});
export type ScientificDecision = z.infer<typeof ScientificDecisionSchema>;

export const ApprovalStateSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
  "superseded",
]);
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;

export const ApprovalResponseSchema = z.object({
  id: IdSchema,
  approvalRequestId: IdSchema,
  decision: z.enum(["approved", "rejected"]),
  actor: ActorIdentitySchema,
  role: z.string().min(1),
  reason: z.string().min(1),
  subjectVersion: z.number().int().positive(),
  subjectRevision: z.number().int().positive(),
  payloadDigest: DigestSchema,
  policyDigest: DigestSchema,
  decidedAt: TimestampSchema,
});
export type ApprovalResponse = z.infer<typeof ApprovalResponseSchema>;

export const ApprovalRequestSchema = z.object({
  id: IdSchema,
  missionId: IdSchema,
  subjectType: z.enum([
    "plan",
    "decision",
    "operation",
    "result",
    "biomolecular_system_manifest",
    "md_protocol",
    "md_stage",
    "qmmm_protocol",
    "replica_set",
    "md_assessment",
  ]),
  subjectId: IdSchema,
  subjectVersion: z.number().int().positive(),
  subjectRevision: z.number().int().positive(),
  state: ApprovalStateSchema,
  requestedFromRole: z.string().min(1),
  payloadDigest: DigestSchema,
  policyDigest: DigestSchema,
  editableFields: z.array(z.string()),
  requestedBy: ActorIdentitySchema,
  requestedAt: TimestampSchema,
  expiresAt: TimestampSchema.optional(),
  response: ApprovalResponseSchema.optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ExternalOperationStateSchema = z.enum([
  "intent",
  "effect_started",
  "acknowledged",
  "confirmed",
  "failed",
  "ambiguous",
  "abandoned",
]);
export type ExternalOperationState = z.infer<typeof ExternalOperationStateSchema>;

export const OperationReceiptSchema = z.object({
  id: IdSchema,
  operationId: IdSchema,
  requestDigest: DigestSchema,
  status: z.enum(["confirmed", "failed", "ambiguous"]),
  externalIdentity: z.record(z.unknown()).optional(),
  jobId: IdSchema.optional(),
  attemptId: IdSchema.optional(),
  detailDigest: DigestSchema,
  recordedAt: TimestampSchema,
});
export type OperationReceipt = z.infer<typeof OperationReceiptSchema>;

export const ExternalOperationSchema = z.object({
  id: IdSchema,
  missionId: IdSchema,
  workUnitId: IdSchema,
  idempotencyKey: z.string().min(1).max(512),
  kind: z.enum([
    "local_execution",
    "collect",
    "parse",
    "cancel",
    "model_invocation",
    "evidence_fetch",
    "system_preparation",
    "ligand_parameterization",
    "topology_build",
    "md_stage_execution",
    "trajectory_analysis",
    "artifact_export",
  ]),
  state: ExternalOperationStateSchema,
  request: z.record(z.unknown()),
  requestDigest: DigestSchema,
  policyDigest: DigestSchema,
  budgetReservationId: IdSchema.optional(),
  externalIdentity: z.record(z.unknown()).optional(),
  receiptId: IdSchema.optional(),
  revision: z.number().int().positive(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ExternalOperation = z.infer<typeof ExternalOperationSchema>;

export const EvidenceReferenceSchema = z.object({
  id: IdSchema,
  missionId: IdSchema,
  workUnitId: IdSchema.optional(),
  kind: z.enum([
    "objective",
    "structure",
    "rendered_input",
    "environment",
    "operation_receipt",
    "artifact",
    "parser_output",
    "skill_fragment",
    "human_review",
    "source_snapshot",
    "construct_audit",
    "biomolecular_system_manifest",
    "force_field_stack",
    "microstate_decision",
    "pose_candidate",
    "atom_map",
    "topology",
    "coordinates",
    "restart",
    "trajectory",
    "mdout",
    "mdinfo",
    "normalized_metrics",
    "analysis_result",
    "md_assessment",
    "reproducibility_bundle",
  ]),
  uri: z.string().min(1),
  contentDigest: DigestSchema,
  sizeBytes: z.number().int().nonnegative().optional(),
  mediaType: z.string().min(1).optional(),
  immutable: z.boolean(),
  sourceId: IdSchema.optional(),
  createdAt: TimestampSchema,
});
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;

export const ScientificObservationSchema = z.object({
  id: IdSchema,
  missionId: IdSchema,
  workUnitId: IdSchema,
  type: z.enum([
    "structure_validity",
    "normal_termination",
    "electronic_convergence",
    "geometry_convergence",
    "imaginary_frequencies",
    "energy",
    "failure_signature",
    "artifact_integrity",
    "topology_integrity",
    "stage_completion",
    "restart_continuity",
    "temperature",
    "pressure",
    "density",
    "volume",
    "membrane_observable",
    "ligand_stability",
    "replica_convergence",
    "engine_parity",
  ]),
  payload: z.record(z.unknown()),
  source: z.object({ kind: z.enum(["parser", "validator", "operator", "runtime"]), id: IdSchema }),
  evidenceRefs: z.array(IdSchema).min(1),
  qualityFlags: z.array(z.string().min(1)),
  observedAt: TimestampSchema,
});
export type ScientificObservation = z.infer<typeof ScientificObservationSchema>;

export const ValidationResultSchema = z.object({
  id: IdSchema,
  missionId: IdSchema,
  workUnitId: IdSchema,
  criterionId: IdSchema,
  status: z.enum(["passed", "failed", "inconclusive", "not_applicable"]),
  summary: z.string().min(1),
  observationRefs: z.array(IdSchema),
  evidenceRefs: z.array(IdSchema),
  validatorVersion: SemverSchema,
  createdAt: TimestampSchema,
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

export const ScientificAssessmentSchema = z.object({
  id: IdSchema,
  missionId: IdSchema,
  revision: z.number().int().positive(),
  status: z.enum(["supported", "partially_supported", "inconclusive", "refuted"]),
  claims: z.array(
    z.object({
      statement: z.string().min(1),
      support: z.enum(["supported", "limited", "unsupported"]),
    }),
  ),
  uncertainty: z.object({
    level: z.enum(["low", "medium", "high", "unknown"]),
    sources: z.array(z.string()),
  }),
  limitations: z.array(z.string().min(1)),
  unresolvedQuestions: z.array(z.string().min(1)),
  decisionRefs: z.array(IdSchema),
  evidenceRefs: z.array(IdSchema),
  validationRefs: z.array(IdSchema),
  skillRefs: z.array(SkillFragmentReferenceSchema),
  protocolVersion: z.string().min(1),
  parserVersion: z.string().min(1),
  fixtureEvidence: z.boolean(),
  generatedBy: ActorIdentitySchema,
  reviewedBy: z.array(ActorIdentitySchema).optional(),
  createdAt: TimestampSchema,
});
export type ScientificAssessment = z.infer<typeof ScientificAssessmentSchema>;

export const ModelInvocationRecordSchema = z.object({
  id: IdSchema,
  missionId: IdSchema,
  planId: IdSchema.optional(),
  role: z.enum([
    "planner",
    "critic",
    "operator",
    "monitor",
    "diagnostician",
    "analyst",
    "reporter",
    "assessment_composer",
  ]),
  provider: z.string().min(1),
  model: z.string().min(1),
  capabilityDigest: DigestSchema,
  requestDigest: DigestSchema,
  responseDigest: DigestSchema.optional(),
  contextDigest: DigestSchema,
  status: z.enum(["succeeded", "failed", "unavailable", "invalid_output"]),
  repairAttempts: z.number().int().nonnegative().max(2),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cost: z.number().nonnegative().optional(),
  conciseRationale: z.string().min(1).optional(),
  errorCode: z.string().min(1).optional(),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema,
});
export type ModelInvocationRecord = z.infer<typeof ModelInvocationRecordSchema>;

export const ModelInvocationIntentStatusSchema = z.enum([
  "invoking",
  "observed",
  "unavailable",
  "ambiguous",
]);
export type ModelInvocationIntentStatus = z.infer<typeof ModelInvocationIntentStatusSchema>;

/** Durable identity written before a provider effect is allowed to start. */
export const ModelInvocationIntentSchema = z
  .object({
    id: IdSchema,
    idempotencyKey: z.string().min(1).max(512),
    missionId: IdSchema,
    planId: IdSchema.optional(),
    planningClaimId: IdSchema.optional(),
    role: z.enum(["planner", "critic", "diagnostician", "assessment_composer"]),
    provider: z.string().min(1),
    model: z.string().min(1),
    capabilityDigest: DigestSchema,
    requestDigest: DigestSchema,
    contextDigest: DigestSchema,
    budget: z
      .object({
        maximumCalls: z.number().int().positive(),
        maximumInputTokens: z.number().int().nonnegative(),
        maximumOutputTokens: z.number().int().nonnegative(),
        maximumTotalTokens: z.number().int().nonnegative(),
        maximumCost: z.number().nonnegative(),
      })
      .strict(),
    budgetReservationIds: z
      .object({
        modelTokens: IdSchema,
        cost: IdSchema,
      })
      .strict(),
    timeoutMilliseconds: z.number().int().positive(),
    maximumRepairAttempts: z.number().int().nonnegative().max(2),
    status: ModelInvocationIntentStatusSchema,
    responseDigest: DigestSchema.optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cost: z.number().nonnegative().optional(),
    errorCode: z.string().min(1).optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type ModelInvocationIntent = z.infer<typeof ModelInvocationIntentSchema>;

export const PlanningClaimSchema = z
  .object({
    id: IdSchema,
    missionId: IdSchema,
    expectedMissionRevision: z.number().int().positive(),
    parentPlanId: IdSchema.optional(),
    proposedNextVersion: z.number().int().positive(),
    ownerId: IdSchema,
    acquiredAt: TimestampSchema,
    expiresAt: TimestampSchema,
    status: z.enum(["active", "expired", "completed", "released"]),
    releasedAt: TimestampSchema.optional(),
    releaseReason: z.string().min(1).optional(),
  })
  .strict();
export type PlanningClaim = z.infer<typeof PlanningClaimSchema>;

export const CriticFindingSchema = z.object({
  id: IdSchema,
  missionId: IdSchema,
  planId: IdSchema,
  severity: z.enum(["info", "warning", "error", "blocking"]),
  code: z.enum([
    "missing_charge",
    "missing_multiplicity",
    "missing_electronic_state_alternative",
    "inappropriate_method",
    "missing_conformational_treatment",
    "missing_numerical_convergence",
    "insufficient_validation",
    "unsupported_engine",
    "unsupported_maturity",
    "excessive_cost",
    "silent_objective_change",
    "contradictory_evidence",
    "unsafe_remediation",
    "missing_provenance",
  ]),
  summary: z.string().min(1),
  evidenceRefs: z.array(IdSchema),
  skillRefs: z.array(SkillFragmentReferenceSchema),
});
export type CriticFinding = z.infer<typeof CriticFindingSchema>;
