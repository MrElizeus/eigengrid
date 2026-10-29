import { z } from "zod";
import {
  BiomolecularDecisionReferenceSchema,
  BiomolecularSystemManifestReferenceSchema,
  EngineBuildIdentitySchema,
  ScientificSchemaDigestMismatchError,
  type ForceFieldStackManifest,
} from "./biomolecular";
import { digestCanonical } from "./canonical";
import {
  ActorIdentitySchema,
  DigestSchema,
  IdSchema,
  ScientificCapabilityIdSchema,
  ScientificCapabilityReferenceSchema,
  SemverSchema,
  SkillVersionReferenceSchema,
  TimestampSchema,
} from "./schemas";

const StrictActorIdentitySchema = ActorIdentitySchema.strict();
const StrictSkillVersionReferenceSchema = SkillVersionReferenceSchema.strict();

export const MdProtocolSchemaVersion = "eigengrid.md-workflow-protocol/v2" as const;
export const MdStageSchemaVersion = "eigengrid.md-stage/v2" as const;
export const MdReplicaSetSchemaVersion = "eigengrid.md-replica-set/v1" as const;
export const TrajectorySegmentSchemaVersion = "eigengrid.trajectory-segment/v1" as const;
export const MdStageResultSchemaVersion = "eigengrid.md-stage-result/v1" as const;
export const MdMetricSeriesSchemaVersion = "eigengrid.md-metric-series/v1" as const;
export const MdAssessmentSchemaVersion = "eigengrid.md-assessment/v1" as const;

export const MdStageKindSchema = z.enum(["minimization", "heating", "equilibration", "production"]);
export type MdStageKind = z.infer<typeof MdStageKindSchema>;

export const MdExecutionBindingParametersSchemaVersion =
  "eigengrid.md-execution-binding/v2" as const;
export const MdStageOperationRequestSchemaVersion =
  "eigengrid.md-stage-operation-request/v2" as const;
export const MdEnvironmentCapabilitySnapshotSchemaVersion =
  "eigengrid.md-environment-capability-snapshot/v1" as const;

export const MdArtifactRoleSchema = z.enum([
  "topology",
  "coordinates",
  "parent_restart",
  "restart",
  "trajectory",
  "mdout",
  "mdinfo",
  "energy_series",
  "normalized_metrics",
  "analysis_plan",
  "analysis_result",
  "atom_map",
]);
export type MdArtifactRole = z.infer<typeof MdArtifactRoleSchema>;

export const MdArtifactReferenceSchema = z
  .object({
    artifactId: IdSchema,
    evidenceRef: IdSchema,
    role: MdArtifactRoleSchema,
    contentDigest: DigestSchema,
    mediaType: z.string().min(1),
    sizeBytes: z.number().finite().int().safe().nonnegative().optional(),
  })
  .strict();
export type MdArtifactReference = z.infer<typeof MdArtifactReferenceSchema>;

const MdAuthorizedStageOutputRoleSchema = z
  .object({
    engineRole: z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
    canonicalRole: MdArtifactRoleSchema.extract(["restart", "trajectory", "mdout", "mdinfo"]),
    mediaType: z.string().min(1),
    required: z.boolean(),
  })
  .strict();

/**
 * Command-free durable intent recorded after a renderer has produced and validated
 * one exact engine request, but before any external effect may start. The WorkUnit
 * remains owner of the scientific binding. Digests bind the internal render and
 * command without exposing argv, paths, or a shell surface to model-facing tools.
 */
export const MdStageOperationRequestSchema = z
  .object({
    schemaVersion: z.literal(MdStageOperationRequestSchemaVersion),
    workUnitId: IdSchema,
    bindingDigest: DigestSchema,
    outputContractDigest: DigestSchema,
    stage: z
      .object({
        id: IdSchema,
        revision: z.number().finite().int().safe().positive(),
        digest: DigestSchema,
        // Absent only in historical v2 requests, whose output set remains four roles.
        kind: MdStageKindSchema.optional(),
      })
      .strict(),
    environment: z
      .object({
        canonicalSnapshotId: IdSchema,
        canonicalSnapshotDigest: DigestSchema,
        engineEnvironmentDigest: DigestSchema,
        bindingVersion: SemverSchema,
        bindingDigest: DigestSchema,
        engine: EngineBuildIdentitySchema,
        binaryDigest: DigestSchema,
      })
      .strict(),
    render: z
      .object({
        schemaVersion: z.string().min(1),
        renderedStageDigest: DigestSchema,
        mapperVersion: SemverSchema,
        mapperDigest: DigestSchema,
        mdinDigest: DigestSchema,
        commandRequestDigest: DigestSchema,
      })
      .strict(),
    outputs: z
      .object({
        mappingVersion: SemverSchema,
        mappingDigest: DigestSchema,
        bindings: z.array(MdAuthorizedStageOutputRoleSchema).min(3).max(4),
      })
      .strict(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.environment.engine.buildDigest !== request.environment.binaryDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["environment", "binaryDigest"],
        message: "Authorized binary digest must equal the exact engine build digest",
      });
    }
    if (
      request.environment.engine.environmentDigest !== request.environment.engineEnvironmentDigest
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["environment", "engineEnvironmentDigest"],
        message: "Engine identity must bind the exact observed engine environment",
      });
    }
    const canonicalRoles = request.outputs.bindings.map((binding) => binding.canonicalRole);
    const engineRoles = request.outputs.bindings.map((binding) => binding.engineRole);
    const requiredCanonicalRoles =
      request.stage.kind === "minimization"
        ? (["restart", "mdout", "mdinfo"] as const)
        : (["restart", "trajectory", "mdout", "mdinfo"] as const);
    if (
      canonicalRoles.length !== requiredCanonicalRoles.length ||
      new Set(canonicalRoles).size !== requiredCanonicalRoles.length ||
      requiredCanonicalRoles.some((role) => !canonicalRoles.includes(role))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputs", "bindings"],
        message: "Stage authorization requires the complete closed canonical output-role set",
      });
    }
    if (new Set(engineRoles).size !== engineRoles.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputs", "bindings"],
        message: "Stage authorization engine output roles must be unique",
      });
    }
  });
export type MdStageOperationRequest = z.infer<typeof MdStageOperationRequestSchema>;

/** Canonical, versioned environment identity shared by compilers and engine adapters. */
export const MdEnvironmentCapabilitySnapshotSchema = z
  .object({
    schemaVersion: z.literal(MdEnvironmentCapabilitySnapshotSchemaVersion),
    id: IdSchema,
    environmentDigest: DigestSchema,
    engine: EngineBuildIdentitySchema,
    capabilities: z.array(ScientificCapabilityReferenceSchema).min(1),
    targetCompatibility: z
      .object({
        family: z.enum(["amber", "gromacs"]),
        versionRange: z.string().min(1),
        compatible: z.literal(true),
        evaluatorVersion: SemverSchema,
        evidenceDigest: DigestSchema,
      })
      .strict(),
    observedAt: TimestampSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    const identities = snapshot.capabilities.map(
      (capability) =>
        `${capability.id}\u0000${capability.version}\u0000${capability.contractDigest}`,
    );
    if (new Set(identities).size !== identities.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities"],
        message: "Environment capability identities must be unique",
      });
    }
  });
export type MdEnvironmentCapabilitySnapshot = z.infer<typeof MdEnvironmentCapabilitySnapshotSchema>;

/** Exact, command-free identity copied into every executable MD WorkUnit. */
export const MdExecutionBindingParametersSchema = z
  .object({
    schemaVersion: z.literal(MdExecutionBindingParametersSchemaVersion),
    plan: z
      .object({
        id: IdSchema,
        version: z.number().finite().int().safe().positive(),
        revision: z.number().finite().int().safe().positive(),
        digest: DigestSchema,
        approvalRef: IdSchema,
      })
      .strict(),
    system: z
      .object({
        id: IdSchema,
        revision: z.number().finite().int().safe().positive(),
        digest: DigestSchema,
        approvalRef: IdSchema,
      })
      .strict(),
    protocol: z
      .object({
        id: IdSchema,
        revision: z.number().finite().int().safe().positive(),
        digest: DigestSchema,
        approvalRef: IdSchema,
      })
      .strict(),
    stage: z
      .object({
        id: IdSchema,
        revision: z.number().finite().int().safe().positive(),
        sequence: z.number().finite().int().safe().positive(),
        kind: MdStageKindSchema,
        digest: DigestSchema,
      })
      .strict(),
    decisions: z.array(BiomolecularDecisionReferenceSchema).min(1),
    parentRestart: MdArtifactReferenceSchema.optional(),
    replicaSegment: z
      .object({
        replicaSetId: IdSchema,
        replicaSetRevision: z.number().finite().int().safe().positive(),
        replicaSetDigest: DigestSchema,
        replicaId: IdSchema,
        replicaIndex: z.number().finite().int().safe().positive(),
        replicaSeed: z.number().finite().int().safe().min(1).max(2_147_483_646),
        segmentIndex: z.number().finite().int().safe().nonnegative(),
        segmentSeed: z.number().finite().int().safe().min(1).max(2_147_483_646).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.stage.sequence > 1 !== (binding.parentRestart !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parentRestart"],
        message: "Every downstream execution binding requires its exact parent restart artifact",
      });
    }
    if (binding.parentRestart !== undefined && binding.parentRestart.role !== "restart") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parentRestart", "role"],
        message: "An execution parent restart must use the canonical restart role",
      });
    }
    if ((binding.stage.kind === "production") !== (binding.replicaSegment !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replicaSegment"],
        message: "Production execution bindings require, and only production may use, a segment",
      });
    }
    const decisionIds = binding.decisions.map((decision) => decision.id);
    if (new Set(decisionIds).size !== decisionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decisions"],
        message: "Execution bindings may include each exact decision once",
      });
    }
  });
export type MdExecutionBindingParameters = z.infer<typeof MdExecutionBindingParametersSchema>;

export const MdEnsembleSchema = z.enum(["none", "nve", "nvt", "npt"]);
export type MdEnsemble = z.infer<typeof MdEnsembleSchema>;

/**
 * Open, namespaced capability identity used by MD workflows instead of widening the
 * legacy QC ProtocolFragment kind enum.
 */
export const MdCapabilityIdSchema = ScientificCapabilityIdSchema;
export const MdCapabilityReferenceSchema = ScientificCapabilityReferenceSchema;
export type MdCapabilityReference = z.infer<typeof MdCapabilityReferenceSchema>;

export const RandomSeedPolicySchema = z.discriminatedUnion("policy", [
  z
    .object({
      policy: z.literal("replica_segment"),
      segmentCount: z.number().finite().int().safe().positive().max(1024),
    })
    .strict(),
  z
    .object({
      policy: z.literal("fixed"),
      seed: z.number().finite().int().safe().min(1).max(2_147_483_646),
    })
    .strict(),
  z
    .object({
      policy: z.literal("derived"),
      baseSeed: z.number().finite().int().safe().min(1).max(2_147_483_646),
      replicaIndex: z.number().finite().int().safe().positive(),
      derivation: z.string().min(1),
      derivationDigest: DigestSchema,
      derivedSeed: z.number().finite().int().safe().min(1).max(2_147_483_646),
    })
    .strict(),
]);
export type RandomSeedPolicy = z.infer<typeof RandomSeedPolicySchema>;

export const TemperatureSchedulePointSchema = z
  .object({
    step: z.number().finite().int().safe().nonnegative(),
    kelvin: z.number().finite().nonnegative(),
  })
  .strict();

export const TemperatureScheduleSchema = z
  .object({
    points: z.array(TemperatureSchedulePointSchema).min(1),
  })
  .strict()
  .superRefine((schedule, context) => {
    for (let index = 1; index < schedule.points.length; index += 1) {
      if (schedule.points[index]!.step <= schedule.points[index - 1]!.step) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["points", index, "step"],
          message: "Temperature schedule steps must be strictly increasing",
        });
      }
    }
  });
export type TemperatureSchedule = z.infer<typeof TemperatureScheduleSchema>;

export const ThermostatSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("langevin"),
      collisionFrequencyPerPs: z.number().finite().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("berendsen"),
      couplingTimePs: z.number().finite().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("nose_hoover"),
      couplingTimePs: z.number().finite().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("velocity_rescale"),
      couplingTimePs: z.number().finite().positive(),
    })
    .strict(),
]);
export type ThermostatSpec = z.infer<typeof ThermostatSpecSchema>;

export const BarostatSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.enum(["berendsen", "monte_carlo", "parrinello_rahman", "c_rescale"]),
      coupling: z.enum(["isotropic", "semiisotropic", "anisotropic"]),
      targetPressureBar: z.number().finite().positive(),
      relaxationTimePs: z.number().finite().positive(),
      compressibilityPerBar: z.number().finite().positive().optional(),
    })
    .strict(),
]);
export type BarostatSpec = z.infer<typeof BarostatSpecSchema>;

const CanonicalAtomIndicesSchema = z
  .array(z.number().finite().int().safe().positive())
  .min(1)
  .max(1_000_000);

/** Digest of an exact ordered selection in one immutable canonical atom map. */
export function computeMdRestraintSelectionDigest(
  atomMapDigest: string,
  atomIndices: number[],
): string {
  return digestCanonical({
    schemaVersion: "eigengrid.md-atom-selection/v1",
    atomMapDigest: DigestSchema.parse(atomMapDigest),
    indexBase: 1,
    atomIndices: CanonicalAtomIndicesSchema.parse(atomIndices),
  });
}

export const RestraintSelectionSchema = z
  .object({
    id: IdSchema,
    definitionDigest: DigestSchema,
    atomCount: z.number().finite().int().safe().positive(),
    description: z.string().min(1),
    atomIndices: CanonicalAtomIndicesSchema.optional(),
  })
  .strict()
  .superRefine((selection, context) => {
    if (selection.atomIndices === undefined) return; // Historical metadata remains readable.
    if (
      selection.atomIndices.length !== selection.atomCount ||
      selection.atomIndices.some((atom, index, atoms) => index > 0 && atom <= atoms[index - 1]!)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["atomIndices"],
        message: "Explicit atom selections must match atomCount and be unique and strictly ordered",
      });
    }
  });
export type RestraintSelection = z.infer<typeof RestraintSelectionSchema>;

export const RestraintSchedulePointSchema = z
  .object({
    step: z.number().finite().int().safe().nonnegative(),
    forceConstant: z.number().finite().nonnegative(),
  })
  .strict();

export const MdRestraintSpecSchema = z
  .object({
    id: IdSchema,
    kind: z.enum(["positional", "distance", "angle", "dihedral"]),
    selections: z.array(RestraintSelectionSchema).min(1).max(4),
    targetValue: z.number().finite().optional(),
    targetUnit: z.string().min(1).optional(),
    schedule: z.array(RestraintSchedulePointSchema).min(1),
    sourceDecisionId: IdSchema,
  })
  .strict()
  .superRefine((restraint, context) => {
    const expectedSelections = {
      positional: 1,
      distance: 2,
      angle: 3,
      dihedral: 4,
    }[restraint.kind];
    if (restraint.selections.length !== expectedSelections) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selections"],
        message: `${restraint.kind} restraints require ${expectedSelections} selection(s)`,
      });
    }
    if (
      restraint.kind !== "positional" &&
      (restraint.targetValue === undefined || restraint.targetUnit === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetValue"],
        message: "Geometric restraints require an explicit target value and unit",
      });
    }
    if (
      restraint.kind === "positional" &&
      (restraint.targetValue !== undefined || restraint.targetUnit !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetValue"],
        message: "A positional restraint is anchored by its selection reference",
      });
    }
    for (let index = 1; index < restraint.schedule.length; index += 1) {
      if (restraint.schedule[index]!.step <= restraint.schedule[index - 1]!.step) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["schedule", index, "step"],
          message: "Restraint schedule steps must be strictly increasing",
        });
      }
    }
    if (!restraint.schedule.some((point) => point.forceConstant > 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["schedule"],
        message: "A restraint schedule must apply a positive force at some point",
      });
    }
  });
export type MdRestraintSpec = z.infer<typeof MdRestraintSpecSchema>;

export const MdConstraintsSpecSchema = z
  .object({
    bondsToHydrogen: z.boolean(),
    tolerance: z.number().finite().positive().optional(),
    maximumIterations: z.number().finite().int().safe().positive().optional(),
  })
  .strict()
  .superRefine((constraints, context) => {
    if (
      constraints.bondsToHydrogen &&
      (constraints.tolerance === undefined || constraints.maximumIterations === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tolerance"],
        message: "Constrained bonds require explicit tolerance and iteration limits",
      });
    }
    if (
      !constraints.bondsToHydrogen &&
      (constraints.tolerance !== undefined || constraints.maximumIterations !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tolerance"],
        message: "Constraint controls are invalid when bond constraints are disabled",
      });
    }
  });
export type MdConstraintsSpec = z.infer<typeof MdConstraintsSpecSchema>;

export const MdNonbondedSpecSchema = z
  .object({
    cutoffAngstrom: z.number().finite().positive(),
    electrostatics: z.enum(["pme", "reaction_field", "direct"]),
    ewaldTolerance: z.number().finite().positive().lt(1).optional(),
    periodicBoundary: z.literal(true),
  })
  .strict()
  .superRefine((nonbonded, context) => {
    if (nonbonded.electrostatics === "pme" && nonbonded.ewaldTolerance === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ewaldTolerance"],
        message: "PME requires an explicit Ewald tolerance",
      });
    }
    if (nonbonded.electrostatics !== "pme" && nonbonded.ewaldTolerance !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ewaldTolerance"],
        message: "Ewald tolerance applies only to PME",
      });
    }
  });
export type MdNonbondedSpec = z.infer<typeof MdNonbondedSpecSchema>;

export const MdResourceProfileSchema = z
  .object({
    backendCapabilityId: z.string().min(1),
    cpuCores: z.number().finite().int().safe().positive(),
    gpuCount: z.number().finite().int().safe().nonnegative(),
    memoryBytes: z.number().finite().int().safe().positive(),
    scratchBytes: z.number().finite().int().safe().nonnegative(),
    wallTimeSeconds: z.number().finite().int().safe().positive(),
  })
  .strict();
export type MdResourceProfile = z.infer<typeof MdResourceProfileSchema>;

export const MdCheckpointSpecSchema = z
  .object({
    cadenceSteps: z.number().finite().int().safe().positive(),
    retainCount: z.number().finite().int().safe().positive(),
    stopAfterCheckpointSupported: z.boolean(),
  })
  .strict();
export type MdCheckpointSpec = z.infer<typeof MdCheckpointSpecSchema>;

export const MdOutputContractSchema = z
  .object({
    role: MdArtifactRoleSchema,
    required: z.boolean(),
    mediaType: z.string().min(1),
    cadenceSteps: z.number().finite().int().safe().positive().optional(),
  })
  .strict();
export type MdOutputContract = z.infer<typeof MdOutputContractSchema>;

export const MdAcceptanceCriterionSchema = z
  .object({
    schemaVersion: z.literal(MdAssessmentSchemaVersion),
    id: IdSchema,
    kind: z.enum([
      "normal_termination",
      "artifact_integrity",
      "restart_continuity",
      "thermodynamic_range",
      "membrane_observable",
      "replica_convergence",
      "custom",
    ]),
    description: z.string().min(1),
    observable: z.string().min(1).optional(),
    lowerBound: z.number().finite().optional(),
    upperBound: z.number().finite().optional(),
    unit: z.string().min(1).optional(),
    windowFraction: z
      .object({ start: z.number().finite().min(0).max(1), end: z.number().finite().min(0).max(1) })
      .strict()
      .refine((window) => window.end > window.start, {
        path: ["end"],
        message: "Assessment window end must be greater than its start",
      })
      .optional(),
    required: z.boolean(),
    evaluatorVersion: SemverSchema,
    criterionDigest: DigestSchema,
  })
  .strict()
  .superRefine((criterion, context) => {
    if (criterion.criterionDigest !== computeMdAcceptanceCriterionDigest(criterion)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["criterionDigest"],
        message: "Acceptance criterion digest does not match its material evaluator contract",
      });
    }
    const metricKind = [
      "thermodynamic_range",
      "membrane_observable",
      "replica_convergence",
    ].includes(criterion.kind);
    if (
      metricKind &&
      (!criterion.observable ||
        (criterion.lowerBound === undefined && criterion.upperBound === undefined) ||
        !criterion.unit)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observable"],
        message: "Metric acceptance criteria require an observable, bound, and unit",
      });
    }
    if (
      criterion.lowerBound !== undefined &&
      criterion.upperBound !== undefined &&
      criterion.lowerBound > criterion.upperBound
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["upperBound"],
        message: "Acceptance upper bound must not be below its lower bound",
      });
    }
  });
export type MdAcceptanceCriterion = z.infer<typeof MdAcceptanceCriterionSchema>;

/** Additive v2 field: historical stages remain readable but cannot acquire defaults. */
export const MdMinimizationControlsSchema = z
  .object({
    algorithm: z.literal("steepest_descent_then_conjugate_gradient"),
    steepestDescentCycles: z.number().finite().int().safe().nonnegative(),
    rmsGradientToleranceKcalMolAngstrom: z.number().finite().positive(),
    initialStepAngstrom: z.number().finite().positive(),
  })
  .strict();

export const MdStageSpecSchema = z
  .object({
    schemaVersion: z.literal(MdStageSchemaVersion),
    id: IdSchema,
    revision: z.number().finite().int().safe().positive(),
    sequence: z.number().finite().int().safe().positive(),
    kind: MdStageKindSchema,
    name: z.string().min(1),
    system: BiomolecularSystemManifestReferenceSchema,
    parentStageId: IdSchema.nullable(),
    requiredParentOutputRole: z.literal("restart").nullable(),
    inputs: z.array(MdArtifactReferenceSchema).min(1),
    ensemble: MdEnsembleSchema,
    steps: z.number().finite().int().safe().positive(),
    minimization: MdMinimizationControlsSchema.optional(),
    timeStepPs: z.number().finite().positive().nullable(),
    simulatedTimePs: z.number().finite().positive().nullable(),
    temperature: TemperatureScheduleSchema.nullable(),
    thermostat: ThermostatSpecSchema,
    barostat: BarostatSpecSchema,
    constraints: MdConstraintsSpecSchema,
    restraints: z.array(MdRestraintSpecSchema),
    nonbonded: MdNonbondedSpecSchema,
    randomSeed: RandomSeedPolicySchema.nullable(),
    resourceProfile: MdResourceProfileSchema,
    checkpoint: MdCheckpointSpecSchema,
    outputs: z.array(MdOutputContractSchema).min(1),
    acceptanceCriteria: z.array(MdAcceptanceCriterionSchema).min(1),
    sourceDecisionRefs: z.array(IdSchema),
    rendererCompatibilityVersion: SemverSchema,
    stageDigest: DigestSchema,
  })
  .strict()
  .superRefine((stage, context) => {
    if (stage.randomSeed?.policy === "replica_segment" && stage.kind !== "production") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["randomSeed"],
        message: "Replica-segment seed schedules are valid only for production",
      });
    }
    const criterionIds = stage.acceptanceCriteria.map((criterion) => criterion.id);
    if (new Set(criterionIds).size !== criterionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["acceptanceCriteria"],
        message: "Stage acceptance criterion identifiers must be unique",
      });
    }
    const inputRoles = stage.inputs.map((input) => input.role);
    if (new Set(inputRoles).size !== inputRoles.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inputs"],
        message: "A stage may bind each input artifact role only once",
      });
    }
    const topology = stage.inputs.find((input) => input.role === "topology");
    if (!topology || topology.contentDigest !== stage.system.topologyDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inputs"],
        message: "Stage topology input must match the system-manifest topology digest",
      });
    }
    if (stage.inputs.some((input) => input.role === "parent_restart")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inputs"],
        message:
          "Protocol stages declare parent restart requirements; exact restart artifacts belong only to execution bindings",
      });
    }
    if (stage.sequence === 1) {
      if (stage.parentStageId !== null || stage.requiredParentOutputRole !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requiredParentOutputRole"],
          message: "The first MD stage cannot name a parent stage or required parent output",
        });
      }
      const coordinates = stage.inputs.find((input) => input.role === "coordinates");
      if (!coordinates || coordinates.contentDigest !== stage.system.coordinateDigest) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["inputs"],
          message: "The first stage coordinates must match the system-manifest digest",
        });
      }
    } else {
      if (stage.parentStageId === null || stage.requiredParentOutputRole !== "restart") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requiredParentOutputRole"],
          message: "Every stage after the first must require the parent stage restart output",
        });
      }
      if (stage.inputs.some((input) => input.role === "coordinates")) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["inputs"],
          message: "Downstream protocol stages cannot predeclare a future state artifact",
        });
      }
    }
    if (stage.kind === "minimization") {
      if (
        stage.minimization !== undefined &&
        stage.minimization.steepestDescentCycles > stage.steps
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["minimization", "steepestDescentCycles"],
          message: "Steepest-descent cycles cannot exceed the approved minimization length",
        });
      }
      if (
        stage.ensemble !== "none" ||
        stage.timeStepPs !== null ||
        stage.simulatedTimePs !== null ||
        stage.temperature !== null ||
        stage.thermostat.kind !== "none" ||
        stage.barostat.kind !== "none" ||
        stage.randomSeed !== null
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ensemble"],
          message: "Minimization must not declare dynamics controls or simulated time",
        });
      }
    } else {
      if (stage.minimization !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["minimization"],
          message: "Dynamics stages cannot declare minimization controls",
        });
      }
      if (
        stage.ensemble === "none" ||
        stage.timeStepPs === null ||
        stage.simulatedTimePs === null
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["timeStepPs"],
          message: "Dynamics stages require an ensemble, timestep, and simulated time",
        });
      } else {
        const expectedTime = stage.steps * stage.timeStepPs;
        const tolerance = Math.max(1e-9, expectedTime * 1e-9);
        if (
          !Number.isFinite(expectedTime) ||
          Math.abs(expectedTime - stage.simulatedTimePs) > tolerance
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["simulatedTimePs"],
            message: "Simulated time must equal steps multiplied by timestep",
          });
        }
      }
      if (stage.temperature === null || stage.randomSeed === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["temperature"],
          message: "Dynamics stages require explicit temperature and seed policies",
        });
      }
      if (stage.ensemble === "nve" && stage.thermostat.kind !== "none") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["thermostat"],
          message: "NVE must not use a thermostat",
        });
      }
      if (["nvt", "npt"].includes(stage.ensemble) && stage.thermostat.kind === "none") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["thermostat"],
          message: "NVT and NPT require an explicit thermostat",
        });
      }
      if (stage.kind === "heating" && (stage.temperature?.points.length ?? 0) < 2) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["temperature"],
          message: "Heating requires a temperature schedule with at least two points",
        });
      }
      const temperaturePoints = stage.temperature?.points ?? [];
      if (temperaturePoints[0]?.step !== 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["temperature", "points", 0, "step"],
          message: "A temperature schedule must begin at stage step zero",
        });
      }
      if ((temperaturePoints.at(-1)?.step ?? 0) > stage.steps) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["temperature", "points"],
          message: "A temperature schedule cannot extend beyond the stage",
        });
      }
      if (stage.kind === "heating" && temperaturePoints.at(-1)?.step !== stage.steps) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["temperature", "points"],
          message: "A heating schedule must define its target at the final stage step",
        });
      }
    }
    if (stage.ensemble === "npt") {
      if (stage.barostat.kind === "none") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["barostat"],
          message: "NPT requires an explicit barostat and pressure target",
        });
      } else if (
        stage.system.systemClass === "membrane" &&
        stage.barostat.coupling === "isotropic"
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["barostat", "coupling"],
          message: "Membrane NPT stages cannot use isotropic pressure coupling",
        });
      }
    } else if (stage.barostat.kind !== "none") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["barostat"],
        message: "Pressure coupling is valid only for NPT",
      });
    }
    for (const [restraintIndex, restraint] of stage.restraints.entries()) {
      for (const [selectionIndex, selection] of restraint.selections.entries()) {
        if (
          selection.atomIndices !== undefined &&
          selection.definitionDigest !==
            computeMdRestraintSelectionDigest(stage.system.atomMapDigest, selection.atomIndices)
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["restraints", restraintIndex, "selections", selectionIndex, "definitionDigest"],
            message:
              "Explicit restraint selection digest must bind its exact indices and canonical atom map",
          });
        }
      }
      const lastStep = restraint.schedule.at(-1)?.step ?? 0;
      if (lastStep > stage.steps) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["restraints", restraintIndex, "schedule"],
          message: "Restraint schedules cannot extend beyond the stage",
        });
      }
    }
    const outputRoles = stage.outputs.map((output) => output.role);
    if (new Set(outputRoles).size !== outputRoles.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputs"],
        message: "A stage may define each output role only once",
      });
    }
    for (const requiredRole of ["restart", "mdout", "mdinfo"] as const) {
      if (!stage.outputs.some((output) => output.role === requiredRole && output.required)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outputs"],
          message: `Stage output contract must require ${requiredRole}`,
        });
      }
    }
    if (
      stage.kind === "production" &&
      !stage.outputs.some((output) => output.role === "trajectory" && output.required)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputs"],
        message: "Production must require a trajectory artifact",
      });
    }
    for (const output of stage.outputs) {
      if (output.cadenceSteps !== undefined && output.cadenceSteps > stage.steps) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outputs"],
          message: "Output cadence cannot exceed the stage length",
        });
      }
    }
    if (stage.checkpoint.cadenceSteps > stage.steps) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["checkpoint", "cadenceSteps"],
        message: "Checkpoint cadence cannot exceed the stage length",
      });
    }
  });
export type MdStageSpec = z.infer<typeof MdStageSpecSchema>;

/** Separately reviewed admission evidence for one technical pilot. This record
 * preserves the deposited stack metadata and does not certify scientific
 * equilibration or general engine/GPU qualification. Its complete content is
 * bound by the protocol approval and independently retained in same-mission CAS.
 */
export const MdForceFieldEngineAdmissionSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.md-force-field-engine-admission/v1"),
    missionId: IdSchema,
    scope: z.literal("provisional_technical_pilot"),
    system: BiomolecularSystemManifestReferenceSchema,
    forceFieldStack: z
      .object({
        id: IdSchema,
        revision: z.number().finite().int().safe().positive(),
        digest: DigestSchema,
      })
      .strict(),
    parameterDigests: z.array(DigestSchema).min(1),
    targetEngine: z
      .object({ family: z.enum(["amber", "gromacs"]), versionRange: z.string().min(1) })
      .strict(),
    engine: EngineBuildIdentitySchema,
    sourceEvidence: z
      .array(
        z
          .object({
            evidenceRef: IdSchema,
            contentDigest: DigestSchema,
            kind: z.enum(["environment", "source_snapshot", "rendered_input"]),
          })
          .strict(),
      )
      .min(2),
    rationale: z.string().min(1),
    limitations: z.array(z.string().min(1)).min(1),
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((admission, context) => {
    if (
      admission.engine.engine.toLowerCase() !== admission.targetEngine.family ||
      new Set(admission.parameterDigests).size !== admission.parameterDigests.length ||
      new Set(admission.sourceEvidence.map((source) => source.evidenceRef)).size !==
        admission.sourceEvidence.length ||
      !admission.sourceEvidence.some((source) => source.kind === "environment") ||
      !admission.sourceEvidence.some((source) => source.kind !== "environment")
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Technical engine admission requires an exact family and distinct environment/material source evidence",
      });
  });
export type MdForceFieldEngineAdmission = z.infer<typeof MdForceFieldEngineAdmissionSchema>;

export const MdForceFieldEngineAdmissionBindingSchema = z
  .object({
    evidenceRef: IdSchema,
    contentDigest: DigestSchema,
    admission: MdForceFieldEngineAdmissionSchema,
  })
  .strict()
  .superRefine((binding, context) => {
    if (digestCanonical(binding.admission) !== binding.contentDigest)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contentDigest"],
        message: "Engine admission digest must cover its complete canonical CAS content",
      });
  });

export function mdForceFieldParameterDigests(stack: ForceFieldStackManifest): string[] {
  return [
    ...new Set([
      stack.protein.parameterDigest,
      stack.lipid.parameterDigest,
      stack.water.parameterSet.parameterDigest,
      stack.ions.parameterDigest,
      ...stack.ligands.flatMap((ligand) => [
        ligand.parameterSet.parameterDigest,
        ligand.atomTypeDigest,
        ligand.chargeDigest,
      ]),
      ...stack.cofactors.map((cofactor) => cofactor.parameterSet.parameterDigest),
    ]),
  ].sort();
}

export const MdWorkflowProtocolSchema = z
  .object({
    schemaVersion: z.literal(MdProtocolSchemaVersion),
    id: IdSchema,
    missionId: IdSchema,
    revision: z.number().finite().int().safe().positive(),
    status: z.enum(["draft", "under_review", "approved", "superseded"]),
    system: BiomolecularSystemManifestReferenceSchema,
    forceFieldStack: z
      .object({
        id: IdSchema,
        revision: z.number().finite().int().safe().positive(),
        digest: DigestSchema,
      })
      .strict(),
    targetEngine: z
      .object({ family: z.enum(["amber", "gromacs"]), versionRange: z.string().min(1) })
      .strict(),
    /** Historical protocols retain the existing production requirement. */
    purpose: z.enum(["production", "technical_pilot"]).optional(),
    /** Exact historical preparation policy ratified by the current protocol
     * approval for frozen decisions and completed material receipts only.
     * Never authorizes a new effect under the old policy. */
    preparationPolicyDigest: DigestSchema.optional(),
    forceFieldEngineAdmission: MdForceFieldEngineAdmissionBindingSchema.optional(),
    capabilityRefs: z.array(MdCapabilityReferenceSchema).min(1),
    stages: z.array(MdStageSpecSchema).min(1),
    decisionRefs: z.array(IdSchema).min(1),
    assumptions: z.array(z.string().min(1)),
    skillRefs: z.array(StrictSkillVersionReferenceSchema).min(1),
    compilerVersion: SemverSchema,
    protocolDigest: DigestSchema,
    approvedByRef: IdSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((protocol, context) => {
    const stageIds = protocol.stages.map((stage) => stage.id);
    if (new Set(stageIds).size !== stageIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stages"],
        message: "MD stage identifiers must be unique",
      });
    }
    const rank: Record<MdStageKind, number> = {
      minimization: 0,
      heating: 1,
      equilibration: 2,
      production: 3,
    };
    for (let index = 0; index < protocol.stages.length; index += 1) {
      const stage = protocol.stages[index]!;
      if (stage.sequence !== index + 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stages", index, "sequence"],
          message: "Protocol stages must use contiguous one-based sequence numbers",
        });
      }
      if (digestCanonical(stage.system) !== digestCanonical(protocol.system)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stages", index, "system"],
          message: "Every stage must bind the complete exact protocol system reference",
        });
      }
      if (index === 0 && stage.kind === "production") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stages", index, "kind"],
          message: "Production requires a validated upstream stage and cannot be the first stage",
        });
      }
      if (index > 0) {
        const previous = protocol.stages[index - 1]!;
        if (stage.parentStageId !== previous.id) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stages", index, "parentStageId"],
            message: "Each stage must name the immediately preceding stage as parent",
          });
        }
        if (rank[stage.kind] < rank[previous.kind]) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["stages", index, "kind"],
            message: "MD workflow stage kinds cannot move backward",
          });
        }
      }
    }
    if (protocol.purpose === "technical_pilot") {
      if (protocol.stages.some((stage) => stage.kind === "production"))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stages"],
          message: "A technical pilot cannot contain or authorize a production stage",
        });
    } else if (!protocol.stages.some((stage) => stage.kind === "production")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stages"],
        message: "An MD workflow protocol must contain a production stage",
      });
    }
    if (protocol.forceFieldEngineAdmission !== undefined && protocol.purpose !== "technical_pilot")
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["forceFieldEngineAdmission"],
        message:
          "Provisional engine admission is restricted to an explicitly approved technical pilot",
      });
    if (protocol.preparationPolicyDigest !== undefined && protocol.purpose !== "technical_pilot")
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["preparationPolicyDigest"],
        message: "Preparation policy handoff requires an explicitly approved technical pilot",
      });
    const capabilityIds = protocol.capabilityRefs.map((capability) => capability.id);
    if (new Set(capabilityIds).size !== capabilityIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilityRefs"],
        message: "A workflow may bind each versioned capability only once",
      });
    }
    if ((protocol.status === "approved") !== (protocol.approvedByRef !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvedByRef"],
        message: "Only an approved protocol may carry, and must carry, its approval reference",
      });
    }
  });
export type MdWorkflowProtocol = z.infer<typeof MdWorkflowProtocolSchema>;

export const MdReplicaSchema = z
  .object({
    id: IdSchema,
    index: z.number().finite().int().safe().positive(),
    seed: z.number().finite().int().safe().min(1).max(2_147_483_646),
    segmentSeeds: z
      .array(z.number().finite().int().safe().min(1).max(2_147_483_646))
      .min(1)
      .max(1024)
      .optional(),
    initialRestart: MdArtifactReferenceSchema,
  })
  .strict()
  .superRefine((replica, context) => {
    if (replica.segmentSeeds !== undefined && replica.segmentSeeds[0] !== replica.seed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["segmentSeeds"],
        message: "The initial replica seed must equal its first explicit segment seed",
      });
    }
    if (replica.initialRestart.role !== "restart") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["initialRestart", "role"],
        message: "A replica must start from a restart artifact",
      });
    }
  });
export type MdReplica = z.infer<typeof MdReplicaSchema>;

/** The complete finite schedule is approved; no engine seed is generated at dispatch. */
export function computeMdReplicaSeedPolicyDigest(replicas: readonly MdReplica[]): string {
  return digestCanonical({
    schemaVersion: "eigengrid.md-replica-segment-seeds/v1",
    policy: "explicit_per_segment",
    replicas: replicas.map((replica) => {
      if (replica.segmentSeeds === undefined) throw new Error("Explicit segment seeds are missing");
      return { id: replica.id, index: replica.index, seeds: replica.segmentSeeds };
    }),
  });
}

export const ReplicaSetSchema = z
  .object({
    schemaVersion: z.literal(MdReplicaSetSchemaVersion),
    id: IdSchema,
    missionId: IdSchema,
    revision: z.number().finite().int().safe().positive(),
    protocolId: IdSchema,
    protocolRevision: z.number().finite().int().safe().positive(),
    protocolDigest: DigestSchema,
    systemManifestDigest: DigestSchema,
    replicaCount: z.number().finite().int().safe().positive(),
    replicas: z.array(MdReplicaSchema).min(1),
    seedPolicyDigest: DigestSchema,
    decisionRef: IdSchema,
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((replicaSet, context) => {
    if (replicaSet.replicas.some((replica) => replica.segmentSeeds !== undefined)) {
      const count = replicaSet.replicas[0]?.segmentSeeds?.length;
      const complete = replicaSet.replicas.every(
        (replica) => replica.segmentSeeds !== undefined && replica.segmentSeeds.length === count,
      );
      const segmentSeeds = replicaSet.replicas.flatMap((replica) => replica.segmentSeeds ?? []);
      if (!complete || new Set(segmentSeeds).size !== segmentSeeds.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["replicas"],
          message: "Every replica needs an equally long segment seed schedule, globally unique",
        });
      }
      if (
        complete &&
        replicaSet.seedPolicyDigest !== computeMdReplicaSeedPolicyDigest(replicaSet.replicas)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["seedPolicyDigest"],
          message: "Seed policy digest must bind the complete explicit segment seed schedule",
        });
      }
    }
    if (replicaSet.replicas.length !== replicaSet.replicaCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replicaCount"],
        message: "Replica count must equal the number of replica definitions",
      });
    }
    const ids = replicaSet.replicas.map((replica) => replica.id);
    const seeds = replicaSet.replicas.map((replica) => replica.seed);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replicas"],
        message: "Replica identifiers must be unique",
      });
    }
    if (new Set(seeds).size !== seeds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replicas"],
        message: "Independent replicas must use distinct random seeds",
      });
    }
    const indices = replicaSet.replicas.map((replica) => replica.index).sort((a, b) => a - b);
    if (indices.some((index, offset) => index !== offset + 1)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replicas"],
        message: "Replica indices must be contiguous and one-based",
      });
    }
  });
export type ReplicaSet = z.infer<typeof ReplicaSetSchema>;
export const MdReplicaSetSchema = ReplicaSetSchema;
export type MdReplicaSet = ReplicaSet;

/** Undefined is a historical binding, never permission for a production renderer fallback. */
export function resolveMdReplicaSegmentSeed(
  stage: MdStageSpec,
  replicaSet: ReplicaSet,
  replicaId: string,
  segmentIndex: number,
): number | undefined {
  replicaSet = ReplicaSetSchema.parse(replicaSet);
  const replica = replicaSet.replicas.find((candidate) => candidate.id === replicaId);
  if (
    stage.kind !== "production" ||
    replica === undefined ||
    !Number.isSafeInteger(segmentIndex) ||
    segmentIndex < 0
  ) {
    throw new Error("Invalid replica segment seed request");
  }
  const policy = stage.randomSeed;
  if (policy?.policy !== "replica_segment") {
    if (replicaSet.replicas.some((candidate) => candidate.segmentSeeds !== undefined)) {
      throw new Error("An explicit replica schedule requires a replica_segment protocol policy");
    }
    return undefined;
  }
  if (
    segmentIndex >= policy.segmentCount ||
    replicaSet.replicas.some((candidate) => candidate.segmentSeeds?.length !== policy.segmentCount)
  ) {
    throw new Error("Segment index or seed schedule exceeds the exact approved production length");
  }
  return replica.segmentSeeds![segmentIndex]!;
}

export const TrajectorySegmentSchema = z
  .object({
    schemaVersion: z.literal(TrajectorySegmentSchemaVersion),
    id: IdSchema,
    revision: z.number().finite().int().safe().positive(),
    missionId: IdSchema,
    replicaId: IdSchema,
    stageResultId: IdSchema,
    segmentIndex: z.number().finite().int().safe().nonnegative(),
    parentRestart: MdArtifactReferenceSchema,
    restart: MdArtifactReferenceSchema,
    trajectory: MdArtifactReferenceSchema,
    startStep: z.number().finite().int().safe().nonnegative(),
    endStep: z.number().finite().int().safe().positive(),
    startTimePs: z.number().finite().nonnegative(),
    endTimePs: z.number().finite().positive(),
    frameCount: z.number().finite().int().safe().positive(),
    netcdf: z
      .object({
        convention: z.string().min(1),
        atomCount: z.number().finite().int().safe().positive(),
        frameCount: z.number().finite().int().safe().positive(),
        hasPeriodicBox: z.boolean(),
      })
      .strict(),
    continuity: z
      .object({
        status: z.enum(["verified", "failed", "indeterminate"]),
        expectedParentRestartDigest: DigestSchema,
        observedParentRestartDigest: DigestSchema,
        expectedStartStep: z.number().finite().int().safe().nonnegative(),
        observedStartStep: z.number().finite().int().safe().nonnegative(),
        expectedStartTimePs: z.number().finite().nonnegative(),
        observedStartTimePs: z.number().finite().nonnegative(),
        reason: z.string().min(1),
      })
      .strict(),
    segmentDigest: DigestSchema,
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((segment, context) => {
    if (
      segment.parentRestart.role !== "restart" ||
      segment.restart.role !== "restart" ||
      segment.trajectory.role !== "trajectory"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parentRestart"],
        message: "Trajectory segment artifacts must use their canonical roles",
      });
    }
    if (segment.endStep <= segment.startStep || segment.endTimePs <= segment.startTimePs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endStep"],
        message: "A trajectory segment must advance both step and simulated time",
      });
    }
    if (segment.netcdf.frameCount !== segment.frameCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["netcdf", "frameCount"],
        message: "Parsed NetCDF frame count must match the segment frame count",
      });
    }
    if (segment.continuity.expectedParentRestartDigest !== segment.parentRestart.contentDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["continuity", "expectedParentRestartDigest"],
        message: "Continuity must be checked against the declared parent restart",
      });
    }
    if (
      segment.continuity.status === "verified" &&
      (segment.continuity.expectedParentRestartDigest !==
        segment.continuity.observedParentRestartDigest ||
        segment.continuity.expectedStartStep !== segment.continuity.observedStartStep ||
        Math.abs(segment.continuity.expectedStartTimePs - segment.continuity.observedStartTimePs) >
          1e-9)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["continuity", "status"],
        message: "Continuity cannot be verified when expected and observed values differ",
      });
    }
  });
export type TrajectorySegment = z.infer<typeof TrajectorySegmentSchema>;

export const MdMetricNameSchema = z.enum([
  "potential_energy",
  "kinetic_energy",
  "total_energy",
  "temperature",
  "pressure",
  "density",
  "volume",
  "rmsd",
  "rmsf",
  "area_per_lipid",
  "membrane_thickness",
  "protein_tilt",
  "ligand_contact_fraction",
  "custom",
]);
export type MdMetricName = z.infer<typeof MdMetricNameSchema>;

export const MdMetricPointSchema = z
  .object({
    step: z.number().finite().int().safe().nonnegative(),
    timePs: z.number().finite().nonnegative(),
    value: z.number().finite(),
  })
  .strict();

export const MdMetricSeriesSchema = z
  .object({
    schemaVersion: z.literal(MdMetricSeriesSchemaVersion),
    id: IdSchema,
    stageResultId: IdSchema,
    replicaId: IdSchema.optional(),
    metric: MdMetricNameSchema,
    customMetricName: z.string().min(1).optional(),
    unit: z.string().min(1),
    points: z.array(MdMetricPointSchema).min(1),
    sourceArtifactRef: IdSchema,
    parserVersion: SemverSchema,
    seriesDigest: DigestSchema,
  })
  .strict()
  .superRefine((series, context) => {
    if ((series.metric === "custom") !== (series.customMetricName !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customMetricName"],
        message: "Only a custom metric must provide a custom metric name",
      });
    }
    for (let index = 1; index < series.points.length; index += 1) {
      const previous = series.points[index - 1]!;
      const current = series.points[index]!;
      if (current.step <= previous.step || current.timePs <= previous.timePs) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["points", index],
          message: "Normalized metric points must advance in both step and time",
        });
      }
    }
  });
export type MdMetricSeries = z.infer<typeof MdMetricSeriesSchema>;

export const NormalizedMdMetricsSchema = z
  .object({
    schemaVersion: z.literal(MdMetricSeriesSchemaVersion),
    id: IdSchema,
    stageResultId: IdSchema,
    series: z.array(MdMetricSeriesSchema).min(1),
    warnings: z.array(z.string().min(1)),
    metricsDigest: DigestSchema,
  })
  .strict()
  .superRefine((metrics, context) => {
    if (metrics.series.some((series) => series.stageResultId !== metrics.stageResultId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["series"],
        message: "Every normalized series must belong to the enclosing stage result",
      });
    }
    const keys = metrics.series.map(
      (series) =>
        `${series.metric}\u0000${series.customMetricName ?? ""}\u0000${series.replicaId ?? ""}`,
    );
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["series"],
        message: "A normalized metrics bundle cannot contain duplicate series",
      });
    }
  });
export type NormalizedMdMetrics = z.infer<typeof NormalizedMdMetricsSchema>;

export const MdDiagnosticMessageSchema = z
  .object({
    code: z.string().min(1),
    severity: z.enum(["info", "warning", "error", "fatal"]),
    message: z.string().min(1),
    sourceEvidenceRefs: z.array(IdSchema),
  })
  .strict();
export type MdDiagnosticMessage = z.infer<typeof MdDiagnosticMessageSchema>;

export const MdStageResultSchema = z
  .object({
    schemaVersion: z.literal(MdStageResultSchemaVersion),
    id: IdSchema,
    revision: z.number().finite().int().safe().positive(),
    missionId: IdSchema,
    workUnitId: IdSchema,
    operationId: IdSchema,
    operationReceiptId: IdSchema,
    protocolId: IdSchema,
    protocolRevision: z.number().finite().int().safe().positive(),
    protocolDigest: DigestSchema,
    stageId: IdSchema,
    stageRevision: z.number().finite().int().safe().positive(),
    stageDigest: DigestSchema,
    stageKind: MdStageKindSchema,
    replicaSetId: IdSchema.optional(),
    replicaSetRevision: z.number().finite().int().safe().positive().optional(),
    replicaSetDigest: DigestSchema.optional(),
    replicaId: IdSchema.optional(),
    segmentIndex: z.number().finite().int().safe().nonnegative().optional(),
    parentRestartDigest: DigestSchema.optional(),
    terminalReason: z.enum([
      "completed",
      "cancelled",
      "timeout",
      "signal",
      "engine_failure",
      "validation_failure",
      "ambiguous",
    ]),
    exitCode: z.number().finite().int().safe().nonnegative().nullable(),
    signal: z.string().min(1).nullable(),
    startedAt: TimestampSchema,
    finishedAt: TimestampSchema,
    startStep: z.number().finite().int().safe().nonnegative(),
    endStep: z.number().finite().int().safe().nonnegative(),
    startTimePs: z.number().finite().nonnegative(),
    endTimePs: z.number().finite().nonnegative(),
    engine: EngineBuildIdentitySchema,
    gpu: z
      .object({
        model: z.string().min(1),
        driverVersion: z.string().min(1),
        runtimeVersion: z.string().min(1),
        deviceUuidDigest: DigestSchema,
      })
      .strict()
      .optional(),
    artifacts: z.array(MdArtifactReferenceSchema),
    normalizedMetricsRef: MdArtifactReferenceSchema.optional(),
    warnings: z.array(MdDiagnosticMessageSchema),
    errors: z.array(MdDiagnosticMessageSchema),
    validationStatus: z.enum(["passed", "failed", "inconclusive", "not_run"]),
    validationRefs: z.array(IdSchema),
    resultDigest: DigestSchema,
  })
  .strict()
  .superRefine((result, context) => {
    const segmentBinding = [
      result.replicaSetId,
      result.replicaSetRevision,
      result.replicaSetDigest,
      result.replicaId,
      result.segmentIndex,
      result.parentRestartDigest,
    ];
    const segmentBindingCount = segmentBinding.filter((value) => value !== undefined).length;
    if (segmentBindingCount !== 0 && segmentBindingCount !== segmentBinding.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replicaSetId"],
        message: "Replica-set, replica, segment, and parent-restart identity are all-or-none",
      });
    }
    if (result.stageKind === "production" && segmentBindingCount !== segmentBinding.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["segmentIndex"],
        message: "Every production result must identify its exact replica segment",
      });
    }
    if (result.stageKind !== "production" && segmentBindingCount !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replicaSetId"],
        message: "Replica segments are valid only for production stage results",
      });
    }
    if (Date.parse(result.finishedAt) < Date.parse(result.startedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finishedAt"],
        message: "A stage result cannot finish before it starts",
      });
    }
    if (result.endStep < result.startStep || result.endTimePs < result.startTimePs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endStep"],
        message: "A stage result cannot move backward in step or simulated time",
      });
    }
    const roles = result.artifacts.map((artifact) => artifact.role);
    if (new Set(roles).size !== roles.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifacts"],
        message: "A stage result may record each canonical artifact role only once",
      });
    }
    if (result.terminalReason === "completed") {
      if (result.exitCode !== 0 || result.signal !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["exitCode"],
          message: "A completed stage requires exit code zero and no signal",
        });
      }
      for (const role of ["restart", "mdout", "mdinfo"] as const) {
        if (!result.artifacts.some((artifact) => artifact.role === role)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["artifacts"],
            message: `A completed stage result requires its ${role} artifact`,
          });
        }
      }
      if (
        result.stageKind === "production" &&
        !result.artifacts.some((artifact) => artifact.role === "trajectory")
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["artifacts"],
          message: "A completed production result requires a trajectory artifact",
        });
      }
    }
    if (result.terminalReason === "signal" && result.signal === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["signal"],
        message: "Signal termination must identify the observed signal",
      });
    }
    if (
      result.normalizedMetricsRef !== undefined &&
      result.normalizedMetricsRef.role !== "normalized_metrics"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["normalizedMetricsRef", "role"],
        message: "Normalized metrics reference must use the normalized_metrics role",
      });
    }
    if (result.warnings.some((warning) => !["info", "warning"].includes(warning.severity))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["warnings"],
        message: "Warnings may contain only info or warning diagnostics",
      });
    }
    if (result.errors.some((error) => !["error", "fatal"].includes(error.severity))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errors"],
        message: "Errors may contain only error or fatal diagnostics",
      });
    }
    if (
      ["engine_failure", "validation_failure"].includes(result.terminalReason) &&
      result.errors.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errors"],
        message: "Engine and validation failures require a normalized error diagnostic",
      });
    }
  });
export type MdStageResult = z.infer<typeof MdStageResultSchema>;

export const MdAcceptanceEvaluationSchema = z
  .object({
    criterionId: IdSchema,
    criterionDigest: DigestSchema,
    required: z.boolean(),
    status: z.enum(["passed", "failed", "inconclusive", "not_applicable"]),
    observedValue: z.number().finite().optional(),
    observedUnit: z.string().min(1).optional(),
    summary: z.string().min(1),
    evidenceRefs: z.array(IdSchema).min(1),
  })
  .strict()
  .superRefine((evaluation, context) => {
    if ((evaluation.observedValue === undefined) !== (evaluation.observedUnit === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observedUnit"],
        message: "An observed value and its unit must be recorded together",
      });
    }
  });
export type MdAcceptanceEvaluation = z.infer<typeof MdAcceptanceEvaluationSchema>;

export const MdStageAssessmentSchema = z
  .object({
    schemaVersion: z.literal(MdAssessmentSchemaVersion),
    id: IdSchema,
    revision: z.number().finite().int().safe().positive(),
    missionId: IdSchema,
    stageResultId: IdSchema,
    stageResultRevision: z.number().finite().int().safe().positive(),
    stageResultDigest: DigestSchema,
    status: z.enum(["accepted", "rejected", "indeterminate"]),
    evaluations: z.array(MdAcceptanceEvaluationSchema).min(1),
    nextStageEligible: z.boolean(),
    limitations: z.array(z.string().min(1)),
    evidenceRefs: z.array(IdSchema).min(1),
    assessor: StrictActorIdentitySchema,
    assessmentDigest: DigestSchema,
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((assessment, context) => {
    const hasRequiredNonPass = assessment.evaluations.some(
      (evaluation) => evaluation.required && evaluation.status !== "passed",
    );
    if (assessment.status === "accepted" && hasRequiredNonPass) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "An accepted stage requires every required evaluation to pass",
      });
    }
    if (assessment.nextStageEligible !== (assessment.status === "accepted")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextStageEligible"],
        message: "Only an accepted stage is eligible to advance",
      });
    }
    const criterionIds = assessment.evaluations.map((evaluation) => evaluation.criterionId);
    if (new Set(criterionIds).size !== criterionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evaluations"],
        message: "A stage assessment may evaluate each criterion only once",
      });
    }
  });
export type MdStageAssessment = z.infer<typeof MdStageAssessmentSchema>;

export const ReplicaConvergenceAssessmentSchema = z
  .object({
    schemaVersion: z.literal(MdAssessmentSchemaVersion),
    id: IdSchema,
    revision: z.number().finite().int().safe().positive(),
    missionId: IdSchema,
    replicaSetId: IdSchema,
    replicaIds: z.array(IdSchema).min(2),
    status: z.enum(["converged", "not_converged", "indeterminate"]),
    observables: z
      .array(
        z
          .object({
            name: z.string().min(1),
            unit: z.string().min(1),
            method: z.string().min(1),
            effectiveSampleSize: z.number().finite().positive().optional(),
            betweenReplicaAssessment: z.string().min(1),
            evidenceRefs: z.array(IdSchema).min(1),
          })
          .strict(),
      )
      .min(1),
    samplingLimitations: z.array(z.string().min(1)).min(1),
    extensionDecisionRequired: z.boolean(),
    assessorVersion: SemverSchema,
    assessmentDigest: DigestSchema,
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((assessment, context) => {
    if (new Set(assessment.replicaIds).size !== assessment.replicaIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replicaIds"],
        message: "Convergence assessment replica identifiers must be unique",
      });
    }
    if (assessment.status === "converged" && assessment.extensionDecisionRequired) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["extensionDecisionRequired"],
        message: "A converged assessment cannot require a sampling extension",
      });
    }
  });
export type ReplicaConvergenceAssessment = z.infer<typeof ReplicaConvergenceAssessmentSchema>;

export const MdScientificAssessmentSchema = z
  .object({
    schemaVersion: z.literal(MdAssessmentSchemaVersion),
    id: IdSchema,
    revision: z.number().finite().int().safe().positive(),
    missionId: IdSchema,
    systemManifestId: IdSchema,
    systemManifestRevision: z.number().finite().int().safe().positive(),
    systemManifestDigest: DigestSchema,
    protocolId: IdSchema,
    protocolRevision: z.number().finite().int().safe().positive(),
    protocolDigest: DigestSchema,
    status: z.enum(["supported", "partially_supported", "inconclusive", "refuted"]),
    claims: z
      .array(
        z
          .object({
            statement: z.string().min(1),
            support: z.enum(["supported", "limited", "unsupported"]),
            evidenceRefs: z.array(IdSchema).min(1),
          })
          .strict(),
      )
      .min(1),
    uncertaintySources: z.array(z.string().min(1)).min(1),
    limitations: z.array(z.string().min(1)).min(1),
    stageAssessmentRefs: z.array(IdSchema).min(1),
    convergenceAssessmentRef: IdSchema.optional(),
    decisionRefs: z.array(IdSchema).min(1),
    generatedBy: StrictActorIdentitySchema,
    reviewedBy: z.array(StrictActorIdentitySchema),
    assessmentDigest: DigestSchema,
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((assessment, context) => {
    const claimSupport = assessment.claims.map((claim) => claim.support);
    if (
      assessment.status === "supported" &&
      claimSupport.some((support) => support !== "supported")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "A supported assessment requires every claim to be supported",
      });
    }
    if (
      assessment.status === "refuted" &&
      claimSupport.some((support) => support !== "unsupported")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "A refuted assessment requires every claim to be unsupported",
      });
    }
    if (
      assessment.status === "partially_supported" &&
      (claimSupport.every((support) => support === "supported") ||
        claimSupport.every((support) => support === "unsupported"))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "A partially supported assessment requires mixed or limited claim support",
      });
    }
    if (
      assessment.status === "supported" &&
      !assessment.reviewedBy.some((reviewer) => reviewer.kind === "human")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewedBy"],
        message: "A supported scientific assessment requires human review",
      });
    }
    const reviewerIds = assessment.reviewedBy.map((reviewer) => reviewer.id);
    if (new Set(reviewerIds).size !== reviewerIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewedBy"],
        message: "Scientific assessment reviewers must be unique",
      });
    }
  });
export type MdScientificAssessment = z.infer<typeof MdScientificAssessmentSchema>;

function canonicalSelfDigest(value: object, selfDigestField: string): string {
  return canonicalDigestOmitting(value, [selfDigestField]);
}

function canonicalDigestOmitting(value: object, omittedFields: readonly string[]): string {
  const omitted = new Set(omittedFields);
  const payload: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!omitted.has(key)) payload[key] = item;
  }
  return digestCanonical(payload);
}

function assertSelfDigest<T extends { id: string }>(
  recordType: string,
  record: T,
  expectedDigest: string,
  selfDigestField: string,
): T {
  const observedDigest = canonicalSelfDigest(record, selfDigestField);
  if (observedDigest !== expectedDigest) {
    throw new ScientificSchemaDigestMismatchError(
      recordType,
      record.id,
      expectedDigest,
      observedDigest,
    );
  }
  return record;
}

/** Digests every acceptance-criterion field except `criterionDigest` itself. */
export function computeMdAcceptanceCriterionDigest(value: object): string {
  return canonicalSelfDigest(value, "criterionDigest");
}

/** Rejects a criterion whose stable identity does not cover its material evaluator contract. */
export function assertMdAcceptanceCriterionDigest(value: unknown): MdAcceptanceCriterion {
  const criterion = MdAcceptanceCriterionSchema.parse(value);
  return assertSelfDigest(
    "MdAcceptanceCriterion",
    criterion,
    criterion.criterionDigest,
    "criterionDigest",
  );
}

/** Digests every normalized stage field except `stageDigest` itself. */
export function computeMdStageSpecDigest(value: object): string {
  return canonicalSelfDigest(value, "stageDigest");
}

export const computeMdStageDigest = computeMdStageSpecDigest;

/** Validates both the stage schema and its canonical self-digest. */
export function assertMdStageSpecDigest(value: unknown): MdStageSpec {
  const stage = MdStageSpecSchema.parse(value);
  for (const criterion of stage.acceptanceCriteria) assertMdAcceptanceCriterionDigest(criterion);
  return assertSelfDigest("MdStageSpec", stage, stage.stageDigest, "stageDigest");
}

export const assertMdStageDigest = assertMdStageSpecDigest;

/**
 * Digests the immutable scientific content of a workflow. Lifecycle fields are omitted
 * so an exact approval can bind the reviewed digest before the durable transition to
 * `approved`; nested stage digests remain included and bind exact stage revisions.
 */
export function computeMdWorkflowProtocolDigest(value: object): string {
  return canonicalDigestOmitting(value, ["protocolDigest", "status", "approvedByRef", "updatedAt"]);
}

export const computeMdProtocolDigest = computeMdWorkflowProtocolDigest;

/** Validates both the workflow schema and its canonical self-digest. */
export function assertMdWorkflowProtocolDigest(value: unknown): MdWorkflowProtocol {
  const protocol = MdWorkflowProtocolSchema.parse(value);
  const observedDigest = computeMdWorkflowProtocolDigest(protocol);
  if (observedDigest !== protocol.protocolDigest) {
    throw new ScientificSchemaDigestMismatchError(
      "MdWorkflowProtocol",
      protocol.id,
      protocol.protocolDigest,
      observedDigest,
    );
  }
  return protocol;
}

export const assertMdProtocolDigest = assertMdWorkflowProtocolDigest;

/** Digests every normalized result field except `resultDigest` itself. */
export function computeMdStageResultDigest(value: object): string {
  return canonicalSelfDigest(value, "resultDigest");
}

/** Digests the complete capability snapshot except its self-digest. */
export function computeMdEnvironmentCapabilitySnapshotDigest(value: object): string {
  return canonicalSelfDigest(value, "environmentDigest");
}

/** Validates a canonical environment snapshot and its exact self-digest. */
export function assertMdEnvironmentCapabilitySnapshotDigest(
  value: unknown,
): MdEnvironmentCapabilitySnapshot {
  const snapshot = MdEnvironmentCapabilitySnapshotSchema.parse(value);
  return assertSelfDigest(
    "MdEnvironmentCapabilitySnapshot",
    snapshot,
    snapshot.environmentDigest,
    "environmentDigest",
  );
}

/** Canonical identity for a complete replica-set revision. */
export function computeMdReplicaSetDigest(value: object): string {
  return digestCanonical(value);
}

/** Validates both the result schema and its canonical self-digest. */
export function assertMdStageResultDigest(value: unknown): MdStageResult {
  const result = MdStageResultSchema.parse(value);
  return assertSelfDigest("MdStageResult", result, result.resultDigest, "resultDigest");
}

/** Digests every stage-assessment field except `assessmentDigest` itself. */
export function computeMdStageAssessmentDigest(value: object): string {
  return canonicalSelfDigest(value, "assessmentDigest");
}

/** Validates an exact stage assessment before it may authorize downstream work. */
export function assertMdStageAssessmentDigest(value: unknown): MdStageAssessment {
  const assessment = MdStageAssessmentSchema.parse(value);
  return assertSelfDigest(
    "MdStageAssessment",
    assessment,
    assessment.assessmentDigest,
    "assessmentDigest",
  );
}

/** Digests every normalized segment field except `segmentDigest` itself. */
export function computeTrajectorySegmentDigest(value: object): string {
  return canonicalSelfDigest(value, "segmentDigest");
}

/** Validates both the trajectory-segment schema and its canonical self-digest. */
export function assertTrajectorySegmentDigest(value: unknown): TrajectorySegment {
  const segment = TrajectorySegmentSchema.parse(value);
  return assertSelfDigest("TrajectorySegment", segment, segment.segmentDigest, "segmentDigest");
}

/** Digests every normalized metric-series field except `seriesDigest` itself. */
export function computeMdMetricSeriesDigest(value: object): string {
  return canonicalSelfDigest(value, "seriesDigest");
}

/** Validates both the normalized metric-series schema and its canonical self-digest. */
export function assertMdMetricSeriesDigest(value: unknown): MdMetricSeries {
  const series = MdMetricSeriesSchema.parse(value);
  return assertSelfDigest("MdMetricSeries", series, series.seriesDigest, "seriesDigest");
}
