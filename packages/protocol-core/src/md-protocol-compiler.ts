import {
  ApprovalRequestSchema,
  BiomolecularDecisionReferenceSchema,
  BiomolecularSystemManifestSchema,
  PublishedBiomolecularSystemManifestSchemaVersion,
  DigestSchema,
  MdEnvironmentCapabilitySnapshotSchema,
  MdExecutionBindingParametersSchema,
  MdExecutionBindingParametersSchemaVersion,
  MdReplicaSetSchema,
  MdStageAssessmentSchema,
  MdStageResultSchema,
  MdStageKindSchema,
  MdWorkflowProtocolSchema,
  ScientificCapabilityReferenceSchema,
  ScientificRiskClassSchema,
  SemverSchema,
  SkillFragmentReferenceSchema,
  TimestampSchema,
  assertPublishedBiomolecularSystemManifestDigest,
  assertMdStageResultDigest,
  assertMdStageAssessmentDigest,
  assertMdStageSpecDigest,
  assertMdWorkflowProtocolDigest,
  computeMdReplicaSetDigest,
  resolveMdReplicaSegmentSeed,
  computeMdEnvironmentCapabilitySnapshotDigest,
  digestCanonical,
  type ApprovalRequest,
  type BiomolecularDecisionReference,
  type PublishedBiomolecularSystemManifest,
  type MdArtifactReference,
  type MdArtifactRole,
  type MdExecutionBindingParameters,
  type MdEnvironmentCapabilitySnapshot,
  type MdReplicaSet,
  type MdStageAssessment,
  type MdStageResult,
  type MdStageSpec,
  type MdStageKind,
  type MdWorkflowProtocol,
  type ScientificCapabilityReference,
  type SkillFragmentReference,
  type WorkUnit,
  type WorkUnitDependency,
} from "@eigengrid/scientific-schema";
import { z } from "zod";
import { snapshotProtocolData, compareProtocolText } from "./data";

export const MdProtocolCompilerVersion = "2.0.1" as const;
/** Producer versions observed in supported v2 protocol records; no implicit upgrade. */
export const SupportedMdProtocolCompilerVersions = ["1.0.0", "2.0.0", "2.0.1"] as const;
export const MdWorkUnitDagVersion = "eigengrid.md-work-unit-dag/v2" as const;
export const MdNextStageCompilationVersion = "eigengrid.md-next-stage-compilation/v1" as const;
export const MdProductionSegmentCompilationVersion =
  "eigengrid.md-production-segment-compilation/v2" as const;

const stageKinds = MdStageKindSchema.options;

const CapabilityByStageKindSchema = z
  .object({
    minimization: ScientificCapabilityReferenceSchema,
    heating: ScientificCapabilityReferenceSchema,
    equilibration: ScientificCapabilityReferenceSchema,
    production: ScientificCapabilityReferenceSchema,
  })
  .strict();

const RiskByStageKindSchema = z
  .object({
    minimization: ScientificRiskClassSchema,
    heating: ScientificRiskClassSchema,
    equilibration: ScientificRiskClassSchema,
    production: ScientificRiskClassSchema,
  })
  .strict();

export const MdCompilerPolicySchema = z
  .object({
    id: z.string().min(1),
    version: SemverSchema,
    policyDigest: DigestSchema,
    minimumApprovalRole: z.string().min(1),
    capabilityByStageKind: CapabilityByStageKindSchema,
    riskByStageKind: RiskByStageKindSchema,
    retryPolicy: z
      .object({
        maximumAttempts: z.number().int().safe().positive(),
        ambiguityRequiresReconciliation: z.literal(true),
      })
      .strict(),
  })
  .strict();
export type MdCompilerPolicy = z.infer<typeof MdCompilerPolicySchema>;

export const ApprovedMdPlanProjectionSchema = z
  .object({
    id: z.string().min(1),
    missionId: z.string().min(1),
    version: z.number().int().safe().positive(),
    revision: z.number().int().safe().positive(),
    status: z.literal("approved"),
    planDigest: DigestSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type ApprovedMdPlanProjection = z.infer<typeof ApprovedMdPlanProjectionSchema>;

export const MdStageSkillBindingSchema = z
  .object({
    stageId: z.string().min(1),
    fragments: z.array(SkillFragmentReferenceSchema).min(1),
  })
  .strict();
export type MdStageSkillBinding = z.infer<typeof MdStageSkillBindingSchema>;

export interface MdProtocolCompilationInput {
  readonly plan: ApprovedMdPlanProjection;
  readonly planApproval: ApprovalRequest;
  readonly system: PublishedBiomolecularSystemManifest;
  readonly systemApproval: ApprovalRequest;
  readonly protocol: MdWorkflowProtocol;
  readonly protocolApproval: ApprovalRequest;
  readonly decisionRefs: readonly BiomolecularDecisionReference[];
  readonly decisionApprovals: readonly ApprovalRequest[];
  readonly stageSkillBindings: readonly MdStageSkillBinding[];
  readonly policy: MdCompilerPolicy;
  readonly environment: MdEnvironmentCapabilitySnapshot;
}

export interface CompiledMdWorkUnitDag {
  readonly schemaVersion: typeof MdWorkUnitDagVersion;
  readonly compilerVersion: typeof MdProtocolCompilerVersion;
  readonly missionId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly planRevision: number;
  readonly systemManifestId: string;
  readonly systemManifestRevision: number;
  readonly systemManifestDigest: string;
  readonly protocolId: string;
  readonly protocolRevision: number;
  readonly protocolDigest: string;
  readonly policyDigest: string;
  readonly environmentDigest: string;
  readonly workUnits: WorkUnit[];
  readonly dependencies: WorkUnitDependency[];
  readonly deferredStages: DeferredMdStage[];
  /** @deprecated Use `deferredStages` and select `kind === "production"`. */
  readonly deferredProductionStages: DeferredMdProductionStage[];
  readonly graphDigest: string;
}

export interface DeferredMdStage {
  readonly stageId: string;
  readonly stageRevision: number;
  readonly stageSequence: number;
  readonly stageDigest: string;
  readonly kind: MdStageKind;
  readonly parentStageId: string | null;
  readonly capability: ScientificCapabilityReference;
  readonly riskClass: z.infer<typeof ScientificRiskClassSchema>;
  readonly sourceFragments: SkillFragmentReference[];
}

export interface DeferredMdProductionStage extends DeferredMdStage {
  readonly kind: "production";
}

export interface MdNextStageCompilationInput extends MdProtocolCompilationInput {
  readonly nextStageId: string;
  readonly parentStageResult: MdStageResult;
  readonly parentStageAssessment: MdStageAssessment;
}

export interface CompiledMdNextStage {
  readonly schemaVersion: typeof MdNextStageCompilationVersion;
  readonly compilerVersion: typeof MdProtocolCompilerVersion;
  readonly workUnit: WorkUnit;
  readonly dependency: WorkUnitDependency;
  readonly parentResultDigest: string;
  readonly parentAssessmentDigest: string;
  readonly compilationDigest: string;
}

export interface MdProductionSegmentCompilationInput extends MdProtocolCompilationInput {
  readonly replicaSet: MdReplicaSet;
  readonly replicaSetApproval: ApprovalRequest;
  readonly productionStageId: string;
  readonly replicaId: string;
  readonly segmentIndex: number;
  readonly parentStageResult: MdStageResult;
  readonly parentStageAssessment: MdStageAssessment;
}

export interface CompiledMdProductionSegment {
  readonly schemaVersion: typeof MdProductionSegmentCompilationVersion;
  readonly compilerVersion: typeof MdProtocolCompilerVersion;
  readonly replicaSetDigest: string;
  readonly parentResultDigest: string;
  readonly parentAssessmentDigest: string;
  readonly workUnit: WorkUnit;
  readonly dependency: WorkUnitDependency;
  readonly compilationDigest: string;
}

export type MdProtocolCompilationErrorCode =
  | "INVALID_INPUT"
  | "COMPILER_VERSION_UNSUPPORTED"
  | "DIGEST_MISMATCH"
  | "APPROVAL_MISMATCH"
  | "MISSION_MISMATCH"
  | "SYSTEM_MISMATCH"
  | "DECISION_MISMATCH"
  | "POLICY_DIGEST_MISMATCH"
  | "ENVIRONMENT_DIGEST_MISMATCH"
  | "ENGINE_INCOMPATIBLE"
  | "CAPABILITY_UNAVAILABLE"
  | "SKILL_BINDING_MISMATCH"
  | "STAGE_GATE_MISMATCH"
  | "REPLICA_SET_MISMATCH"
  | "SEGMENT_CONTINUITY_MISMATCH";

export class MdProtocolCompilationError extends Error {
  readonly name = "MdProtocolCompilationError";

  constructor(
    readonly code: MdProtocolCompilationErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

function fail(
  code: MdProtocolCompilationErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new MdProtocolCompilationError(code, message, details);
}

function withoutField(value: object, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}

export function computeMdCompilerPolicyDigest(
  policy: Omit<MdCompilerPolicy, "policyDigest"> | MdCompilerPolicy,
): string {
  return digestCanonical("policyDigest" in policy ? withoutField(policy, "policyDigest") : policy);
}

export function computeMdEnvironmentDigest(
  environment:
    | Omit<MdEnvironmentCapabilitySnapshot, "environmentDigest">
    | MdEnvironmentCapabilitySnapshot,
): string {
  return computeMdEnvironmentCapabilitySnapshotDigest(environment);
}

function capabilityIdentity(capability: ScientificCapabilityReference): string {
  return `${capability.id}\u0000${capability.version}\u0000${capability.contractDigest}`;
}

function skillVersionIdentity(skill: {
  skillId: string;
  version: string;
  contentDigest: string;
}): string {
  return `${skill.skillId}\u0000${skill.version}\u0000${skill.contentDigest}`;
}

function skillFragmentIdentity(fragment: SkillFragmentReference): string {
  return `${skillVersionIdentity(fragment)}\u0000${fragment.fragmentId}\u0000${fragment.fragmentDigest}\u0000${fragment.relativePath}\u0000${fragment.selector}`;
}

function decisionIdentity(decision: BiomolecularDecisionReference): string {
  return `${decision.id}\u0000${decision.revision}\u0000${decision.kind}\u0000${decision.decisionDigest}\u0000${decision.approvalRef}`;
}

const PublishedBiomolecularSystemManifestInputSchema = BiomolecularSystemManifestSchema.refine(
  (manifest) => manifest.schemaVersion === PublishedBiomolecularSystemManifestSchemaVersion,
  { message: "MD execution compilation requires a published biomolecular manifest v2" },
);

function snapshotMdInput<T extends MdProtocolCompilationInput>(input: T): T {
  try {
    const copy = snapshotProtocolData(input);
    if (!copy || typeof copy !== "object" || Array.isArray(copy))
      throw new TypeError("Expected MD compiler input");
    return copy;
  } catch (error) {
    fail("INVALID_INPUT", "MD compiler accepts only bounded data records", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseInput(input: MdProtocolCompilationInput): void {
  const parsed = {
    plan: ApprovedMdPlanProjectionSchema.safeParse(input.plan),
    planApproval: ApprovalRequestSchema.safeParse(input.planApproval),
    system: PublishedBiomolecularSystemManifestInputSchema.safeParse(input.system),
    systemApproval: ApprovalRequestSchema.safeParse(input.systemApproval),
    protocol: MdWorkflowProtocolSchema.safeParse(input.protocol),
    protocolApproval: ApprovalRequestSchema.safeParse(input.protocolApproval),
    decisions: z.array(BiomolecularDecisionReferenceSchema).safeParse(input.decisionRefs),
    decisionApprovals: z.array(ApprovalRequestSchema).safeParse(input.decisionApprovals),
    bindings: z.array(MdStageSkillBindingSchema).safeParse(input.stageSkillBindings),
    policy: MdCompilerPolicySchema.safeParse(input.policy),
    environment: MdEnvironmentCapabilitySnapshotSchema.safeParse(input.environment),
  };
  const invalid = Object.entries(parsed).filter(([, result]) => !result.success);
  if (invalid.length > 0) {
    fail("INVALID_INPUT", "MD compiler input failed schema validation", {
      invalid: invalid.map(([field, result]) => ({
        field,
        issues: result.success ? [] : result.error.issues,
      })),
    });
  }
}

function parseProductionSegmentInput(input: MdProductionSegmentCompilationInput): void {
  parseInput(input);
  const parsed = {
    replicaSet: MdReplicaSetSchema.safeParse(input.replicaSet),
    replicaSetApproval: ApprovalRequestSchema.safeParse(input.replicaSetApproval),
    productionStageId: z.string().min(1).safeParse(input.productionStageId),
    replicaId: z.string().min(1).safeParse(input.replicaId),
    segmentIndex: z.number().int().nonnegative().safeParse(input.segmentIndex),
    parentStageResult: MdStageResultSchema.safeParse(input.parentStageResult),
    parentStageAssessment: MdStageAssessmentSchema.safeParse(input.parentStageAssessment),
  };
  const invalid = Object.entries(parsed).filter(([, result]) => !result.success);
  if (invalid.length > 0) {
    fail("INVALID_INPUT", "MD production-segment input failed schema validation", {
      invalid: invalid.map(([field, result]) => ({
        field,
        issues: result.success ? [] : result.error.issues,
      })),
    });
  }
}

function parseNextStageInput(input: MdNextStageCompilationInput): void {
  parseInput(input);
  const parsed = {
    nextStageId: z.string().min(1).safeParse(input.nextStageId),
    parentStageResult: MdStageResultSchema.safeParse(input.parentStageResult),
    parentStageAssessment: MdStageAssessmentSchema.safeParse(input.parentStageAssessment),
  };
  const invalid = Object.entries(parsed).filter(([, result]) => !result.success);
  if (invalid.length > 0) {
    fail("INVALID_INPUT", "MD next-stage input failed schema validation", {
      invalid: invalid.map(([field, result]) => ({
        field,
        issues: result.success ? [] : result.error.issues,
      })),
    });
  }
}

function assertDigests(input: MdProtocolCompilationInput): void {
  try {
    assertPublishedBiomolecularSystemManifestDigest(input.system);
    for (const stage of input.protocol.stages) assertMdStageSpecDigest(stage);
    assertMdWorkflowProtocolDigest(input.protocol);
  } catch (error) {
    fail("DIGEST_MISMATCH", "System, stage, or protocol content does not match its self-digest", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (computeMdCompilerPolicyDigest(input.policy) !== input.policy.policyDigest) {
    fail("POLICY_DIGEST_MISMATCH", "MD compiler policy does not match its digest");
  }
  if (computeMdEnvironmentDigest(input.environment) !== input.environment.environmentDigest) {
    fail(
      "ENVIRONMENT_DIGEST_MISMATCH",
      "MD environment capability snapshot does not match its digest",
    );
  }
}

function assertExactApproval(
  approval: ApprovalRequest,
  expected: {
    missionId: string;
    subjectType: ApprovalRequest["subjectType"];
    subjectId: string;
    subjectVersion: number;
    subjectRevision: number;
    payloadDigest: string;
    policyDigest: string;
  },
): void {
  if (
    approval.state !== "approved" ||
    approval.response?.decision !== "approved" ||
    approval.response.approvalRequestId !== approval.id ||
    approval.response.subjectVersion !== approval.subjectVersion ||
    approval.response.subjectRevision !== approval.subjectRevision ||
    approval.response.payloadDigest !== approval.payloadDigest ||
    approval.response.policyDigest !== approval.policyDigest ||
    approval.missionId !== expected.missionId ||
    approval.subjectType !== expected.subjectType ||
    approval.subjectId !== expected.subjectId ||
    approval.subjectVersion !== expected.subjectVersion ||
    approval.subjectRevision !== expected.subjectRevision ||
    approval.payloadDigest !== expected.payloadDigest ||
    approval.policyDigest !== expected.policyDigest
  ) {
    fail("APPROVAL_MISMATCH", `Approval ${approval.id} does not bind the exact subject`, {
      expected,
      observed: {
        state: approval.state,
        decision: approval.response?.decision,
        missionId: approval.missionId,
        subjectType: approval.subjectType,
        subjectId: approval.subjectId,
        subjectVersion: approval.subjectVersion,
        subjectRevision: approval.subjectRevision,
        payloadDigest: approval.payloadDigest,
        policyDigest: approval.policyDigest,
      },
    });
  }
  if (
    approval.expiresAt !== undefined &&
    approval.response !== undefined &&
    Date.parse(approval.response.decidedAt) > Date.parse(approval.expiresAt)
  ) {
    fail("APPROVAL_MISMATCH", `Approval ${approval.id} was decided after its expiry`);
  }
}

function assertOwnershipAndApprovals(input: MdProtocolCompilationInput): void {
  const missionIds = [input.plan.missionId, input.system.missionId, input.protocol.missionId];
  if (new Set(missionIds).size !== 1) {
    fail("MISSION_MISMATCH", "Plan, system manifest, and MD protocol must share one mission", {
      missionIds,
    });
  }
  assertExactApproval(input.planApproval, {
    missionId: input.plan.missionId,
    subjectType: "plan",
    subjectId: input.plan.id,
    subjectVersion: input.plan.version,
    subjectRevision: input.plan.revision,
    payloadDigest: input.plan.planDigest,
    policyDigest: input.policy.policyDigest,
  });
  assertExactApproval(input.systemApproval, {
    missionId: input.plan.missionId,
    subjectType: "biomolecular_system_manifest",
    subjectId: input.system.id,
    subjectVersion: input.system.revision,
    subjectRevision: input.system.revision,
    payloadDigest: input.system.manifestDigest,
    policyDigest: input.policy.policyDigest,
  });
  assertExactApproval(input.protocolApproval, {
    missionId: input.plan.missionId,
    subjectType: "md_protocol",
    subjectId: input.protocol.id,
    subjectVersion: input.protocol.revision,
    subjectRevision: input.protocol.revision,
    payloadDigest: input.protocol.protocolDigest,
    policyDigest: input.policy.policyDigest,
  });
  if (input.protocol.approvedByRef !== input.protocolApproval.id) {
    fail("APPROVAL_MISMATCH", "Protocol approval reference is not the supplied exact approval");
  }
}

function assertSystemAndDecisions(input: MdProtocolCompilationInput): void {
  const reference = input.protocol.system;
  if (
    reference.id !== input.system.id ||
    reference.revision !== input.system.revision ||
    reference.systemClass !== (input.system.membrane === null ? "soluble" : "membrane") ||
    reference.manifestDigest !== input.system.manifestDigest ||
    reference.topologyDigest !== input.system.topologyDigest ||
    reference.coordinateDigest !== input.system.coordinateDigest ||
    reference.atomMapDigest !== input.system.atomMapDigest
  ) {
    fail("SYSTEM_MISMATCH", "MD protocol does not bind the exact system-manifest revision");
  }
  if (
    input.protocol.forceFieldStack.id !== input.system.forceFieldStack.id ||
    input.protocol.forceFieldStack.revision !== input.system.forceFieldStack.revision ||
    input.protocol.forceFieldStack.digest !== input.system.forceFieldStack.digest
  ) {
    fail("SYSTEM_MISMATCH", "MD protocol changes the system force-field stack");
  }

  const decisions = new Map<string, BiomolecularDecisionReference>();
  for (const decision of input.decisionRefs) {
    if (decisions.has(decision.id)) {
      fail("DECISION_MISMATCH", `Duplicate exact decision reference ${decision.id}`);
    }
    decisions.set(decision.id, decision);
  }
  const approvals = new Map(input.decisionApprovals.map((approval) => [approval.id, approval]));
  for (const materialDecision of input.system.decisionRefs) {
    const supplied = decisions.get(materialDecision.id);
    if (
      supplied === undefined ||
      decisionIdentity(supplied) !== decisionIdentity(materialDecision)
    ) {
      fail(
        "DECISION_MISMATCH",
        `System decision ${materialDecision.id} is absent or differs from its exact reference`,
      );
    }
  }
  if (decisions.size !== input.system.decisionRefs.length) {
    fail(
      "DECISION_MISMATCH",
      "Every compiler decision must be an exact reference embedded in the system manifest",
      {
        suppliedDecisionIds: [...decisions.keys()].sort(),
        systemDecisionIds: input.system.decisionRefs.map((decision) => decision.id).sort(),
      },
    );
  }
  for (const decisionId of new Set([
    ...input.protocol.decisionRefs,
    ...input.protocol.stages.flatMap((stage) => stage.sourceDecisionRefs),
  ])) {
    if (!decisions.has(decisionId)) {
      fail(
        "DECISION_MISMATCH",
        `Protocol decision ${decisionId} lacks an exact approved reference`,
      );
    }
  }
  for (const decision of decisions.values()) {
    const approval = approvals.get(decision.approvalRef);
    if (approval === undefined) {
      fail(
        "DECISION_MISMATCH",
        `Decision ${decision.id} lacks its durable exact approval ${decision.approvalRef}`,
      );
    }
    assertExactApproval(approval, {
      missionId: input.plan.missionId,
      subjectType: "decision",
      subjectId: decision.id,
      subjectVersion: decision.revision,
      subjectRevision: decision.revision,
      payloadDigest: decision.decisionDigest,
      policyDigest: input.protocol.preparationPolicyDigest ?? input.policy.policyDigest,
    });
  }
  if (approvals.size !== input.decisionApprovals.length) {
    fail("DECISION_MISMATCH", "Decision approval identifiers must be unique");
  }
}

function assertEnvironmentAndCapabilities(input: MdProtocolCompilationInput): void {
  if (
    input.protocol.forceFieldEngineAdmission !== undefined &&
    digestCanonical(input.protocol.forceFieldEngineAdmission.admission.engine) !==
      digestCanonical(input.environment.engine)
  )
    fail(
      "ENGINE_INCOMPATIBLE",
      "Technical force-field admission targets a different exact engine build or environment",
    );
  if (
    input.environment.targetCompatibility.family !== input.protocol.targetEngine.family ||
    input.environment.targetCompatibility.versionRange !== input.protocol.targetEngine.versionRange
  ) {
    fail("ENGINE_INCOMPATIBLE", "Compatibility evidence targets a different engine constraint");
  }
  if (input.environment.engine.engine.toLowerCase() !== input.protocol.targetEngine.family) {
    fail("ENGINE_INCOMPATIBLE", "Discovered engine family differs from the MD protocol target");
  }
  const declared = new Set(input.protocol.capabilityRefs.map(capabilityIdentity));
  const available = new Set(input.environment.capabilities.map(capabilityIdentity));
  for (const stage of input.protocol.stages) {
    const capability = input.policy.capabilityByStageKind[stage.kind];
    const identity = capabilityIdentity(capability);
    if (!declared.has(identity) || !available.has(identity)) {
      fail(
        "CAPABILITY_UNAVAILABLE",
        `Stage ${stage.id} lacks its exact declared and observed capability`,
        { stageId: stage.id, capability },
      );
    }
  }
}

function stageSkillBindings(
  input: MdProtocolCompilationInput,
): Map<string, SkillFragmentReference[]> {
  const protocolSkills = new Set(input.protocol.skillRefs.map(skillVersionIdentity));
  const stageIds = new Set(input.protocol.stages.map((stage) => stage.id));
  const result = new Map<string, SkillFragmentReference[]>();
  for (const binding of input.stageSkillBindings) {
    if (!stageIds.has(binding.stageId) || result.has(binding.stageId)) {
      fail("SKILL_BINDING_MISMATCH", `Invalid or duplicate skill binding for ${binding.stageId}`);
    }
    const identities = binding.fragments.map(skillFragmentIdentity);
    if (new Set(identities).size !== identities.length) {
      fail("SKILL_BINDING_MISMATCH", `Stage ${binding.stageId} repeats a skill fragment`);
    }
    for (const fragment of binding.fragments) {
      if (!protocolSkills.has(skillVersionIdentity(fragment))) {
        fail(
          "SKILL_BINDING_MISMATCH",
          `Stage ${binding.stageId} cites a fragment outside the protocol skill set`,
        );
      }
    }
    result.set(
      binding.stageId,
      [...binding.fragments].sort((left, right) =>
        compareProtocolText(skillFragmentIdentity(left), skillFragmentIdentity(right)),
      ),
    );
  }
  for (const stageId of stageIds) {
    if (!result.has(stageId)) {
      fail("SKILL_BINDING_MISMATCH", `Stage ${stageId} has no exact skill-fragment binding`);
    }
  }
  return result;
}

const evidenceKindByArtifactRole: Record<MdArtifactRole, string> = {
  topology: "topology",
  coordinates: "coordinates",
  parent_restart: "restart",
  restart: "restart",
  trajectory: "trajectory",
  mdout: "mdout",
  mdinfo: "mdinfo",
  energy_series: "normalized_metrics",
  normalized_metrics: "normalized_metrics",
  analysis_plan: "analysis_result",
  analysis_result: "analysis_result",
  atom_map: "atom_map",
};

function observationsFor(stageKind: MdStageKind, sequence: number): string[] {
  const observations = ["artifact_integrity", "stage_completion"];
  if (sequence > 1) observations.push("restart_continuity");
  if (stageKind !== "minimization") observations.push("temperature");
  if (stageKind === "equilibration" || stageKind === "production") {
    observations.push("density", "volume");
  }
  return observations;
}

function deterministicWorkUnitId(
  input: MdProtocolCompilationInput,
  stageId: string,
  parentRestartDigest?: string,
): string {
  return `wu-md-${digestCanonical({
    missionId: input.plan.missionId,
    planId: input.plan.id,
    planVersion: input.plan.version,
    planRevision: input.plan.revision,
    systemManifestDigest: input.system.manifestDigest,
    protocolId: input.protocol.id,
    protocolRevision: input.protocol.revision,
    protocolDigest: input.protocol.protocolDigest,
    stageId,
    parentRestartDigest: parentRestartDigest ?? null,
  }).slice(0, 32)}`;
}

function deterministicProductionSegmentWorkUnitId(
  input: MdProductionSegmentCompilationInput,
  replicaSetDigest: string,
  parentRestartDigest: string,
): string {
  return `wu-md-${digestCanonical({
    missionId: input.plan.missionId,
    planId: input.plan.id,
    planVersion: input.plan.version,
    planRevision: input.plan.revision,
    systemManifestDigest: input.system.manifestDigest,
    protocolId: input.protocol.id,
    protocolRevision: input.protocol.revision,
    protocolDigest: input.protocol.protocolDigest,
    productionStageId: input.productionStageId,
    replicaSetDigest,
    replicaId: input.replicaId,
    segmentIndex: input.segmentIndex,
    parentRestartDigest,
  }).slice(0, 32)}`;
}

function exactDecisionReferences(
  input: MdProtocolCompilationInput,
  stage: MdStageSpec,
): BiomolecularDecisionReference[] {
  return [...new Set([...input.protocol.decisionRefs, ...stage.sourceDecisionRefs])]
    .map((decisionId) => input.decisionRefs.find((decision) => decision.id === decisionId)!)
    .sort((left, right) => compareProtocolText(decisionIdentity(left), decisionIdentity(right)));
}

function executionBinding(
  input: MdProtocolCompilationInput,
  stage: MdStageSpec,
  options: {
    parentRestart?: MdArtifactReference;
    replicaSegment?: MdExecutionBindingParameters["replicaSegment"];
  } = {},
): MdExecutionBindingParameters {
  return MdExecutionBindingParametersSchema.parse({
    schemaVersion: MdExecutionBindingParametersSchemaVersion,
    plan: {
      id: input.plan.id,
      version: input.plan.version,
      revision: input.plan.revision,
      digest: input.plan.planDigest,
      approvalRef: input.planApproval.id,
    },
    system: {
      id: input.system.id,
      revision: input.system.revision,
      digest: input.system.manifestDigest,
      approvalRef: input.systemApproval.id,
    },
    protocol: {
      id: input.protocol.id,
      revision: input.protocol.revision,
      digest: input.protocol.protocolDigest,
      approvalRef: input.protocolApproval.id,
    },
    stage: {
      id: stage.id,
      revision: stage.revision,
      sequence: stage.sequence,
      kind: stage.kind,
      digest: stage.stageDigest,
    },
    decisions: exactDecisionReferences(input, stage),
    ...(options.parentRestart === undefined ? {} : { parentRestart: options.parentRestart }),
    ...(options.replicaSegment === undefined ? {} : { replicaSegment: options.replicaSegment }),
  });
}

function acceptedParentRestart(
  input: MdProtocolCompilationInput,
  expectedParentStage: MdStageSpec,
  resultValue: MdStageResult,
  assessmentValue: MdStageAssessment,
): {
  result: MdStageResult;
  assessment: MdStageAssessment;
  restart: MdArtifactReference;
} {
  let result: MdStageResult;
  let assessment: MdStageAssessment;
  try {
    result = assertMdStageResultDigest(resultValue);
    assessment = assertMdStageAssessmentDigest(assessmentValue);
  } catch (error) {
    fail("STAGE_GATE_MISMATCH", "Parent result or assessment digest is invalid", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (
    result.missionId !== input.plan.missionId ||
    result.protocolId !== input.protocol.id ||
    result.protocolRevision !== input.protocol.revision ||
    result.protocolDigest !== input.protocol.protocolDigest ||
    result.stageId !== expectedParentStage.id ||
    result.stageRevision !== expectedParentStage.revision ||
    result.stageDigest !== expectedParentStage.stageDigest ||
    result.stageKind !== expectedParentStage.kind ||
    result.terminalReason !== "completed" ||
    result.validationStatus !== "passed"
  ) {
    fail(
      "STAGE_GATE_MISMATCH",
      "Downstream compilation requires the completed, validated result of the exact parent stage",
    );
  }
  if (
    assessment.missionId !== input.plan.missionId ||
    assessment.stageResultId !== result.id ||
    assessment.stageResultRevision !== result.revision ||
    assessment.stageResultDigest !== result.resultDigest ||
    assessment.status !== "accepted" ||
    !assessment.nextStageEligible
  ) {
    fail(
      "STAGE_GATE_MISMATCH",
      "Downstream compilation requires an accepted, next-stage-eligible exact assessment",
    );
  }
  // A valid self-digest proves bytes, not that this result belongs to the approved engine
  // or covers the complete parent interval. Site receipt/byte verification is still the mission runtime's job.
  if (digestCanonical(result.engine) !== digestCanonical(input.environment.engine)) {
    fail("STAGE_GATE_MISMATCH", "Parent result engine differs from the exact approved build");
  }
  if (result.errors.length || result.validationRefs.length === 0) {
    fail("STAGE_GATE_MISMATCH", "Passed parent needs validation evidence and no error diagnostics");
  }
  const steps = result.endStep - result.startStep;
  const elapsed = result.endTimePs - result.startTimePs;
  if (expectedParentStage.kind === "minimization") {
    if (steps > expectedParentStage.steps || elapsed !== 0) {
      fail(
        "STAGE_GATE_MISMATCH",
        "Minimization result exceeds its cycle budget or invents MD time",
      );
    }
  } else {
    const duration = expectedParentStage.simulatedTimePs!;
    const tolerance = Math.max(1e-9, duration * 1e-9);
    if (steps !== expectedParentStage.steps || Math.abs(elapsed - duration) > tolerance) {
      fail("STAGE_GATE_MISMATCH", "Parent result does not cover the approved step/time interval");
    }
  }
  for (const output of expectedParentStage.outputs.filter((output) => output.required)) {
    const artifact = result.artifacts.find((artifact) => artifact.role === output.role);
    if (!artifact || artifact.mediaType !== output.mediaType) {
      fail("STAGE_GATE_MISMATCH", `Missing or incompatible required parent output ${output.role}`);
    }
  }
  const criteria = new Map(
    expectedParentStage.acceptanceCriteria.map((criterion) => [criterion.id, criterion]),
  );
  if (assessment.evaluations.length !== criteria.size) {
    fail("STAGE_GATE_MISMATCH", "Parent assessment does not cover every stage criterion exactly");
  }
  for (const evaluation of assessment.evaluations) {
    const criterion = criteria.get(evaluation.criterionId);
    if (
      criterion === undefined ||
      evaluation.criterionDigest !== criterion.criterionDigest ||
      evaluation.required !== criterion.required ||
      (criterion.required && evaluation.status !== "passed")
    ) {
      fail(
        "STAGE_GATE_MISMATCH",
        `Parent assessment does not satisfy exact criterion ${evaluation.criterionId}`,
      );
    }
  }
  const restart = result.artifacts.find((artifact) => artifact.role === "restart");
  if (restart === undefined) {
    fail("STAGE_GATE_MISMATCH", "Accepted parent result has no canonical restart artifact");
  }
  return { result, assessment, restart };
}

function buildStageWorkUnit(input: {
  compilation: MdProtocolCompilationInput;
  stage: MdStageSpec;
  sourceFragments: SkillFragmentReference[];
  workUnitId: string;
  dependencies: string[];
  binding: MdExecutionBindingParameters;
  inputRefs?: string[];
  fragmentId?: string;
  reason?: string;
}): WorkUnit {
  const { compilation, stage } = input;
  const capability = compilation.policy.capabilityByStageKind[stage.kind];
  const stageInputRefs = input.inputRefs ?? [
    ...compilation.system.sourceEvidenceRefs,
    ...stage.inputs.map((artifact) => artifact.evidenceRef),
  ];
  const requiredEvidenceKinds = stage.outputs
    .filter((output) => output.required)
    .map((output) => evidenceKindByArtifactRole[output.role]);
  const reason = input.reason ?? `Execute approved MD stage ${stage.sequence}: ${stage.name}`;
  return {
    id: input.workUnitId,
    missionId: compilation.plan.missionId,
    planId: compilation.plan.id,
    planVersion: compilation.plan.version,
    kind: "scientific_capability",
    state: "created",
    reason,
    dependencies: input.dependencies,
    inputRefs: [...new Set(stageInputRefs)].sort(),
    outputContract: {
      requiredEvidenceKinds: [...new Set(requiredEvidenceKinds)].sort(),
      requiredObservationKinds: observationsFor(stage.kind, stage.sequence),
    },
    skillRefs: input.sourceFragments,
    protocolFragment: {
      schemaVersion: "eigengrid.scientific-capability-fragment/v1",
      id: input.fragmentId ?? `md-fragment-${stage.id}`,
      kind: "scientific_capability",
      capability,
      reason,
      parameters: input.binding,
      sourceFragments: input.sourceFragments,
      riskClass: compilation.policy.riskByStageKind[stage.kind],
    },
    retryPolicy: compilation.policy.retryPolicy,
    approvalPolicy: {
      required: true,
      minimumRole: compilation.policy.minimumApprovalRole,
    },
    executionPolicy: {
      capability: capability.id,
      riskClass: compilation.policy.riskByStageKind[stage.kind],
    },
    revision: 1,
    claimOwner: null,
    claimExpiresAt: null,
    jobId: null,
    attemptId: null,
    createdAt: compilation.protocol.updatedAt,
    updatedAt: compilation.protocol.updatedAt,
  };
}

function assertCompilationPreconditions(input: MdProtocolCompilationInput): void {
  parseInput(input);
  if (
    !(SupportedMdProtocolCompilerVersions as readonly string[]).includes(
      input.protocol.compilerVersion,
    )
  ) {
    fail(
      "COMPILER_VERSION_UNSUPPORTED",
      "Unknown protocol producer version requires explicit compatibility review",
    );
  }
  assertDigests(input);
  assertOwnershipAndApprovals(input);
  assertSystemAndDecisions(input);
  assertEnvironmentAndCapabilities(input);
}

/**
 * Compiles approved, content-bound MD stages into canonical WorkUnits. It is a pure
 * transformation: it never renders engine input, resolves paths, or performs effects.
 */
export function compileMdWorkflowProtocol(
  input: MdProtocolCompilationInput,
): CompiledMdWorkUnitDag {
  input = snapshotMdInput(input);
  assertCompilationPreconditions(input);
  const skillsByStage = stageSkillBindings(input);

  const initialStage = input.protocol.stages[0]!;
  if (initialStage.parentStageId !== null || initialStage.requiredParentOutputRole !== null) {
    fail(
      "INVALID_INPUT",
      "The initial compiler may materialize only an independently eligible stage",
    );
  }
  const initialWorkUnit = buildStageWorkUnit({
    compilation: input,
    stage: initialStage,
    sourceFragments: skillsByStage.get(initialStage.id)!,
    workUnitId: deterministicWorkUnitId(input, initialStage.id),
    dependencies: [],
    binding: executionBinding(input, initialStage),
  });
  const workUnits = [initialWorkUnit];
  const dependencies: WorkUnitDependency[] = [];
  const deferredStages = input.protocol.stages.slice(1).map(
    (stage): DeferredMdStage => ({
      stageId: stage.id,
      stageRevision: stage.revision,
      stageSequence: stage.sequence,
      stageDigest: stage.stageDigest,
      kind: stage.kind,
      parentStageId: stage.parentStageId,
      capability: input.policy.capabilityByStageKind[stage.kind],
      riskClass: input.policy.riskByStageKind[stage.kind],
      sourceFragments: skillsByStage.get(stage.id)!,
    }),
  );
  const deferredProductionStages = deferredStages.filter(
    (stage): stage is DeferredMdProductionStage => stage.kind === "production",
  );
  const payload = {
    schemaVersion: MdWorkUnitDagVersion,
    compilerVersion: MdProtocolCompilerVersion,
    missionId: input.plan.missionId,
    planId: input.plan.id,
    planVersion: input.plan.version,
    planRevision: input.plan.revision,
    systemManifestId: input.system.id,
    systemManifestRevision: input.system.revision,
    systemManifestDigest: input.system.manifestDigest,
    protocolId: input.protocol.id,
    protocolRevision: input.protocol.revision,
    protocolDigest: input.protocol.protocolDigest,
    policyDigest: input.policy.policyDigest,
    environmentDigest: input.environment.environmentDigest,
    workUnits,
    dependencies,
    deferredStages,
    deferredProductionStages,
  };
  return { ...payload, graphDigest: digestCanonical(payload) };
}

/**
 * Materializes one non-production stage only after the exact upstream result has passed
 * every required criterion and its assessment explicitly authorizes progression.
 */
export function compileMdNextStage(input: MdNextStageCompilationInput): CompiledMdNextStage {
  input = snapshotMdInput(input);
  parseNextStageInput(input);
  assertCompilationPreconditions(input);
  const skillsByStage = stageSkillBindings(input);
  const stage = input.protocol.stages.find((candidate) => candidate.id === input.nextStageId);
  if (stage === undefined || stage.sequence === 1) {
    fail("INVALID_INPUT", "Requested downstream stage is absent or is the initial stage");
  }
  if (stage.kind === "production") {
    fail(
      "INVALID_INPUT",
      "Production requires an approved ReplicaSet and compileMdProductionSegment",
    );
  }
  if (stage.requiredParentOutputRole !== "restart" || stage.parentStageId === null) {
    fail("INVALID_INPUT", "Downstream stage does not declare its required parent restart output");
  }
  const expectedParentStage = input.protocol.stages.find(
    (candidate) => candidate.id === stage.parentStageId,
  );
  if (expectedParentStage === undefined) {
    fail("INVALID_INPUT", "Downstream stage parent is absent from the exact protocol");
  }
  const parent = acceptedParentRestart(
    input,
    expectedParentStage,
    input.parentStageResult,
    input.parentStageAssessment,
  );
  const workUnitId = deterministicWorkUnitId(input, stage.id, parent.restart.contentDigest);
  const workUnit = buildStageWorkUnit({
    compilation: input,
    stage,
    sourceFragments: skillsByStage.get(stage.id)!,
    workUnitId,
    dependencies: [parent.result.workUnitId],
    binding: executionBinding(input, stage, { parentRestart: parent.restart }),
    inputRefs: [
      ...input.system.sourceEvidenceRefs,
      ...stage.inputs.map((artifact) => artifact.evidenceRef),
      parent.restart.evidenceRef,
    ],
  });
  const dependency = {
    workUnitId,
    dependsOnWorkUnitId: parent.result.workUnitId,
  };
  const payload = {
    schemaVersion: MdNextStageCompilationVersion,
    compilerVersion: MdProtocolCompilerVersion,
    workUnit,
    dependency,
    parentResultDigest: parent.result.resultDigest,
    parentAssessmentDigest: parent.assessment.assessmentDigest,
  };
  return { ...payload, compilationDigest: digestCanonical(payload) };
}

/**
 * Compiles one approved replica segment. Production cannot be emitted by the initial
 * workflow compiler because replica identity, seed, parent restart, and segment index
 * do not exist until the durable ReplicaSet revision has been approved.
 */
export function compileMdProductionSegment(
  input: MdProductionSegmentCompilationInput,
): CompiledMdProductionSegment {
  input = snapshotMdInput(input);
  parseProductionSegmentInput(input);
  assertCompilationPreconditions(input);
  const skillsByStage = stageSkillBindings(input);

  const stage = input.protocol.stages.find((candidate) => candidate.id === input.productionStageId);
  if (stage === undefined || stage.kind !== "production") {
    fail("REPLICA_SET_MISMATCH", "Requested production stage is absent or not production");
  }
  if (stage.requiredParentOutputRole !== "restart" || stage.parentStageId === null) {
    fail("REPLICA_SET_MISMATCH", "Production stage lacks its required upstream restart contract");
  }
  const replicaSetDigest = computeMdReplicaSetDigest(input.replicaSet);
  if (
    input.replicaSet.missionId !== input.plan.missionId ||
    input.replicaSet.protocolId !== input.protocol.id ||
    input.replicaSet.protocolRevision !== input.protocol.revision ||
    input.replicaSet.protocolDigest !== input.protocol.protocolDigest ||
    input.replicaSet.systemManifestDigest !== input.system.manifestDigest
  ) {
    fail(
      "REPLICA_SET_MISMATCH",
      "Replica set does not bind the exact mission, protocol, and system revision",
    );
  }
  assertExactApproval(input.replicaSetApproval, {
    missionId: input.plan.missionId,
    subjectType: "replica_set",
    subjectId: input.replicaSet.id,
    subjectVersion: input.replicaSet.revision,
    subjectRevision: input.replicaSet.revision,
    payloadDigest: replicaSetDigest,
    policyDigest: input.policy.policyDigest,
  });
  const replica = input.replicaSet.replicas.find((candidate) => candidate.id === input.replicaId);
  if (replica === undefined) {
    fail("REPLICA_SET_MISMATCH", `Replica ${input.replicaId} is absent from the approved set`);
  }
  let segmentSeed: number | undefined;
  try {
    segmentSeed = resolveMdReplicaSegmentSeed(
      stage,
      input.replicaSet,
      replica.id,
      input.segmentIndex,
    );
  } catch (error) {
    fail("REPLICA_SET_MISMATCH", String(error));
  }
  const expectedParentStage =
    input.segmentIndex === 0
      ? input.protocol.stages.find((candidate) => candidate.id === stage.parentStageId)
      : stage;
  if (expectedParentStage === undefined) {
    fail("SEGMENT_CONTINUITY_MISMATCH", "Production parent stage is absent from the protocol");
  }
  const parent = acceptedParentRestart(
    input,
    expectedParentStage,
    input.parentStageResult,
    input.parentStageAssessment,
  );
  const parentStageResult = parent.result;
  const parentRestart = parent.restart;
  if (input.segmentIndex === 0) {
    if (digestCanonical(parentRestart) !== digestCanonical(replica.initialRestart)) {
      fail(
        "SEGMENT_CONTINUITY_MISMATCH",
        "First replica segment must start from its exact validated parent-stage restart",
      );
    }
  } else if (
    parentStageResult.stageId !== stage.id ||
    parentStageResult.stageRevision !== stage.revision ||
    parentStageResult.stageDigest !== stage.stageDigest ||
    parentStageResult.stageKind !== "production" ||
    parentStageResult.replicaSetId !== input.replicaSet.id ||
    parentStageResult.replicaSetRevision !== input.replicaSet.revision ||
    parentStageResult.replicaSetDigest !== replicaSetDigest ||
    parentStageResult.replicaId !== replica.id ||
    parentStageResult.segmentIndex !== input.segmentIndex - 1
  ) {
    fail(
      "SEGMENT_CONTINUITY_MISMATCH",
      "Later replica segments must continue the immediately preceding exact segment",
    );
  }

  const workUnitId = deterministicProductionSegmentWorkUnitId(
    input,
    replicaSetDigest,
    parentRestart.contentDigest,
  );
  const reason = `Execute approved production replica ${replica.index}, segment ${input.segmentIndex}`;
  const workUnit = buildStageWorkUnit({
    compilation: input,
    stage,
    sourceFragments: skillsByStage.get(stage.id)!,
    workUnitId,
    dependencies: [parentStageResult.workUnitId],
    binding: executionBinding(input, stage, {
      parentRestart,
      replicaSegment: {
        replicaSetId: input.replicaSet.id,
        replicaSetRevision: input.replicaSet.revision,
        replicaSetDigest,
        replicaId: replica.id,
        replicaIndex: replica.index,
        replicaSeed: replica.seed,
        segmentIndex: input.segmentIndex,
        ...(segmentSeed === undefined ? {} : { segmentSeed }),
      },
    }),
    inputRefs: [
      ...input.system.sourceEvidenceRefs,
      ...stage.inputs
        .filter((artifact) => artifact.role !== "parent_restart")
        .map((artifact) => artifact.evidenceRef),
      parentRestart.evidenceRef,
    ],
    fragmentId: `md-fragment-${stage.id}-${replica.id}-${input.segmentIndex}`,
    reason,
  });
  const dependency = {
    workUnitId,
    dependsOnWorkUnitId: parentStageResult.workUnitId,
  };
  const payload = {
    schemaVersion: MdProductionSegmentCompilationVersion,
    compilerVersion: MdProtocolCompilerVersion,
    replicaSetDigest,
    parentResultDigest: parentStageResult.resultDigest,
    parentAssessmentDigest: parent.assessment.assessmentDigest,
    workUnit,
    dependency,
  };
  return { ...payload, compilationDigest: digestCanonical(payload) };
}

/** Enumerated for policy authors and tests; no capability is inferred from arbitrary text. */
export const MdCompilerStageKinds: readonly MdStageKind[] = stageKinds;
