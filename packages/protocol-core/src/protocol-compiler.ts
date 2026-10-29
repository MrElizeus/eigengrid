import {
  CapabilityMaturitySchema,
  ScientificObjectiveSchema,
  ScientificProtocolSchema,
  ProtocolFragmentSchema,
  ScientificPlanSchema,
  ScientificDecisionSchema,
  MissionConstraintsSchema,
  DigestSchema,
  KnowledgeMaturitySchema,
  ScientificRiskClassSchema,
  SemverSchema,
  digestCanonical,
  type MissionConstraints,
  type ProtocolFragment,
  type ScientificDecision,
  type ScientificObjective,
  type ScientificPlan,
  type ScientificProtocol,
  type SkillFragmentReference,
  type WorkUnit,
  type WorkUnitDependency,
} from "@eigengrid/scientific-schema";
import { z } from "zod";
import { snapshotProtocolData, compareProtocolText, assertNoEffectParameters } from "./data";

export const ProtocolCompilerVersion = "1.0.1" as const;
export const SupportedScientificProtocolCompilerVersions = ["1.0.0", "1.0.1"] as const;
export const WorkUnitDagVersion = "eigengrid.work-unit-dag/v1" as const;

const workUnitKinds = [
  "structure_validation",
  "optimization",
  "frequency",
  "collection",
  "parsing",
  "validation",
  "assessment",
  "diagnosis",
] as const;
type WorkUnitKind = (typeof workUnitKinds)[number];

export const CompilerPolicyProfileSchema = z
  .object({
    id: z.string().min(1),
    version: SemverSchema,
    policyDigest: DigestSchema,
    minimumKnowledgeMaturity: KnowledgeMaturitySchema,
    minimumCapabilityMaturity: CapabilityMaturitySchema,
    automaticApprovalRiskCeiling: ScientificRiskClassSchema,
    materialDecisionApproval: z.enum(["covered_by_plan", "separate"]),
    minimumApprovalRole: z.string().min(1),
    requiredDecisionCategories: z
      .array(z.enum(["charge", "multiplicity", "method", "basis", "physical_model"]))
      .min(1),
    defaultRetryPolicy: z.object({
      maximumAttempts: z.number().int().safe().positive(),
      ambiguityRequiresReconciliation: z.literal(true),
    }),
    retryOverrides: z
      .record(
        z.enum(workUnitKinds),
        z.object({
          maximumAttempts: z.number().int().safe().positive(),
          ambiguityRequiresReconciliation: z.literal(true),
        }),
      )
      .default({}),
    capabilityByKind: z.record(z.enum(workUnitKinds), z.string().min(1)),
    dependencyMap: z.record(z.string().min(1), z.array(z.string().min(1))).default({}),
  })
  .strict();
export type CompilerPolicyProfile = z.infer<typeof CompilerPolicyProfileSchema>;

export const EnvironmentCapabilityProfileSchema = z
  .object({
    id: z.string().min(1),
    environmentDigest: DigestSchema,
    selectedEngine: z.object({
      id: z.string().min(1),
      version: z.string().min(1),
      adapterVersion: SemverSchema,
    }),
    capabilities: z.array(z.string().min(1)),
    skillCompatibility: z.array(
      z
        .object({
          skillId: z.string().min(1),
          version: SemverSchema,
          contentDigest: DigestSchema,
          compatible: z.boolean(),
          reasons: z.array(z.string().min(1)).default([]),
          knowledgeMaturity: KnowledgeMaturitySchema,
          capabilityMaturity: CapabilityMaturitySchema,
          engineNeutral: z.boolean().default(false),
          compatibleEngines: z
            .array(
              z.object({
                id: z.string().min(1),
                versions: z.array(z.string().min(1)).min(1),
                adapterVersions: z.array(SemverSchema).min(1),
              }),
            )
            .default([]),
        })
        .strict(),
    ),
  })
  .strict();
export type EnvironmentCapabilityProfile = z.infer<typeof EnvironmentCapabilityProfileSchema>;

export interface ProtocolCompilationInput {
  objective: ScientificObjective;
  plan: ScientificPlan;
  approvedPlanRevision: number;
  decisions: ScientificDecision[];
  approvedDecisionIds: string[];
  constraints: MissionConstraints;
  policy: CompilerPolicyProfile;
  environment: EnvironmentCapabilityProfile;
}

export interface CompiledWorkUnitDag {
  schemaVersion: typeof WorkUnitDagVersion;
  compilerVersion: typeof ProtocolCompilerVersion;
  missionId: string;
  planId: string;
  planVersion: number;
  planRevision: number;
  protocolDigest: string;
  skillGraphDigest: string;
  policyDigest: string;
  environmentDigest: string;
  workUnits: WorkUnit[];
  dependencies: WorkUnitDependency[];
  graphDigest: string;
}

export type ProtocolCompilationErrorCode =
  | "INVALID_COMPILER_INPUT"
  | "COMPILER_VERSION_UNSUPPORTED"
  | "PLAN_NOT_APPROVED"
  | "PLAN_REVISION_MISMATCH"
  | "MISSING_SCIENTIFIC_INPUT"
  | "OBJECTIVE_MISMATCH"
  | "PROTOCOL_DIGEST_MISMATCH"
  | "SKILL_GRAPH_DIGEST_MISMATCH"
  | "ENVIRONMENT_DIGEST_MISMATCH"
  | "POLICY_DIGEST_MISMATCH"
  | "APPROVAL_POLICY_MISMATCH"
  | "SKILL_ATTRIBUTION_MISMATCH"
  | "UNRESOLVED_MATERIAL_DECISION"
  | "DECISION_VALUE_MISMATCH"
  | "UNAPPROVED_MATERIAL_DECISION"
  | "INCOMPATIBLE_SKILL"
  | "INSUFFICIENT_SKILL_MATURITY"
  | "ENGINE_NOT_ALLOWED"
  | "ENGINE_INCOMPATIBLE"
  | "CAPABILITY_UNAVAILABLE"
  | "INVALID_DEPENDENCY"
  | "CYCLIC_DEPENDENCY";

export class ProtocolCompilationError extends Error {
  readonly name = "ProtocolCompilationError";

  constructor(
    public readonly code: ProtocolCompilationErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

const knowledgeMaturityOrder = [
  "draft",
  "reference_curated",
  "expert_reviewed",
  "benchmark_backed",
  "production_certified",
] as const;
const capabilityMaturityOrder = [
  "reference",
  "advisory",
  "plannable",
  "renderable",
  "executable",
  "validated",
] as const;

function atLeast(current: string, required: string, order: readonly string[]): boolean {
  return order.indexOf(current) >= order.indexOf(required);
}

function withoutDigest<T extends { protocolDigest: string }>(
  protocol: T,
): Omit<T, "protocolDigest"> {
  const { protocolDigest: _digest, ...payload } = protocol;
  return payload;
}

/** The single digest convention used by planner output and the work-unit compiler. */
export function computeScientificProtocolDigest(
  protocol: Omit<ScientificProtocol, "protocolDigest"> | ScientificProtocol,
): string {
  return digestCanonical("protocolDigest" in protocol ? withoutDigest(protocol) : protocol);
}

export function withScientificProtocolDigest(
  protocol: Omit<ScientificProtocol, "protocolDigest">,
): ScientificProtocol {
  return { ...protocol, protocolDigest: computeScientificProtocolDigest(protocol) };
}

export function computeCompilerPolicyDigest(
  policy: Omit<CompilerPolicyProfile, "policyDigest"> | CompilerPolicyProfile,
): string {
  if ("policyDigest" in policy) {
    const { policyDigest: _digest, ...payload } = policy;
    return digestCanonical(payload);
  }
  return digestCanonical(policy);
}

const outputContracts: Record<WorkUnitKind, WorkUnit["outputContract"]> = {
  structure_validation: {
    requiredEvidenceKinds: ["structure"],
    requiredObservationKinds: ["structure_validity"],
  },
  optimization: {
    requiredEvidenceKinds: ["rendered_input", "operation_receipt", "artifact"],
    requiredObservationKinds: [
      "normal_termination",
      "electronic_convergence",
      "geometry_convergence",
    ],
  },
  frequency: {
    requiredEvidenceKinds: ["rendered_input", "operation_receipt", "artifact"],
    requiredObservationKinds: [
      "normal_termination",
      "electronic_convergence",
      "imaginary_frequencies",
    ],
  },
  collection: {
    requiredEvidenceKinds: ["artifact", "operation_receipt"],
    requiredObservationKinds: ["artifact_integrity"],
  },
  parsing: {
    requiredEvidenceKinds: ["parser_output"],
    requiredObservationKinds: ["normal_termination"],
  },
  validation: {
    requiredEvidenceKinds: ["parser_output", "skill_fragment"],
    requiredObservationKinds: ["normal_termination"],
  },
  assessment: {
    requiredEvidenceKinds: ["parser_output", "skill_fragment"],
    requiredObservationKinds: ["normal_termination"],
  },
  diagnosis: {
    requiredEvidenceKinds: ["artifact", "parser_output", "skill_fragment"],
    requiredObservationKinds: ["failure_signature"],
  },
};

function fragmentIdentity(reference: SkillFragmentReference): string {
  return [
    reference.skillId,
    reference.version,
    reference.contentDigest,
    reference.fragmentId,
    reference.fragmentDigest,
    reference.relativePath,
    reference.selector,
  ].join("\u0000");
}

function deterministicWorkUnitId(input: ProtocolCompilationInput, fragmentId: string): string {
  return `wu-${digestCanonical({
    missionId: input.plan.missionId,
    planId: input.plan.id,
    planVersion: input.plan.version,
    planRevision: input.approvedPlanRevision,
    protocolDigest: input.plan.protocol.protocolDigest,
    fragmentId,
  }).slice(0, 32)}`;
}

function fail(
  code: ProtocolCompilationErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new ProtocolCompilationError(code, message, details);
}

function requiredCapability(policy: CompilerPolicyProfile, kind: WorkUnitKind): string {
  const capability = policy.capabilityByKind[kind];
  if (!capability) {
    fail("INVALID_COMPILER_INPUT", `Policy omits the typed capability for ${kind}`, { kind });
  }
  return capability;
}

const StrictCompilationPlanSchema = ScientificPlanSchema.extend({
  protocol: ScientificProtocolSchema.extend({
    engineAgnosticSteps: z.array(ProtocolFragmentSchema.strict()).min(1),
  }).strict(),
});

function assertInput(input: ProtocolCompilationInput): void {
  const fields = {
    objective: ScientificObjectiveSchema.safeParse(input.objective),
    plan: StrictCompilationPlanSchema.safeParse(input.plan),
    decisions: z.array(ScientificDecisionSchema).safeParse(input.decisions),
    approvedDecisionIds: z.array(z.string().min(1)).safeParse(input.approvedDecisionIds),
    approvedPlanRevision: z.number().int().positive().safeParse(input.approvedPlanRevision),
    constraints: MissionConstraintsSchema.safeParse(input.constraints),
  };
  if (Object.values(fields).some((field) => !field.success)) {
    fail("INVALID_COMPILER_INPUT", "Scientific compiler input failed schema validation");
  }
  if (
    !(SupportedScientificProtocolCompilerVersions as readonly string[]).includes(
      input.plan.protocol.compilerVersion,
    )
  ) {
    fail(
      "COMPILER_VERSION_UNSUPPORTED",
      "Unknown protocol producer version requires explicit compatibility review",
    );
  }
  try {
    for (const fragment of input.plan.protocol.engineAgnosticSteps)
      assertNoEffectParameters(fragment.parameters);
  } catch {
    fail("INVALID_COMPILER_INPUT", "Legacy protocol fragments cannot contain effect commands");
  }

  const policy = CompilerPolicyProfileSchema.safeParse(input.policy);
  const environment = EnvironmentCapabilityProfileSchema.safeParse(input.environment);
  if (!policy.success || !environment.success) {
    fail("INVALID_COMPILER_INPUT", "Compiler policy or environment profile is invalid", {
      policyIssues: policy.success ? [] : policy.error.issues,
      environmentIssues: environment.success ? [] : environment.error.issues,
    });
  }
  if (computeCompilerPolicyDigest(input.policy) !== input.policy.policyDigest) {
    fail("POLICY_DIGEST_MISMATCH", "Compiler policy content does not match its digest");
  }
  if (
    input.plan.requiredApprovals.length !== 1 ||
    input.plan.requiredApprovals[0] !== input.policy.minimumApprovalRole
  ) {
    fail(
      "APPROVAL_POLICY_MISMATCH",
      "Executable plans require exactly the compiler policy's single approval role",
      {
        requiredApprovals: input.plan.requiredApprovals,
        minimumApprovalRole: input.policy.minimumApprovalRole,
      },
    );
  }
  if (input.plan.status !== "approved") {
    fail("PLAN_NOT_APPROVED", `Plan ${input.plan.id} is ${input.plan.status}, not approved`);
  }
  if (input.approvedPlanRevision !== input.plan.revision) {
    fail("PLAN_REVISION_MISMATCH", "The compiled revision is not the approved plan revision", {
      approvedPlanRevision: input.approvedPlanRevision,
      currentPlanRevision: input.plan.revision,
    });
  }
  if (input.plan.missingInputs.length > 0) {
    fail("MISSING_SCIENTIFIC_INPUT", "The approved plan still declares missing scientific inputs", {
      missingInputs: input.plan.missingInputs,
    });
  }
  if (
    input.plan.protocol.objectiveId !== input.objective.id ||
    input.plan.protocol.system.evidenceId !== input.objective.system.evidenceId ||
    input.plan.protocol.system.contentDigest !== input.objective.system.contentDigest
  ) {
    fail("OBJECTIVE_MISMATCH", "The protocol does not preserve the approved objective and system");
  }
  if (
    input.objective.system.charge !== undefined &&
    input.objective.system.charge !== input.plan.protocol.charge
  ) {
    fail("OBJECTIVE_MISMATCH", "The protocol silently changes the objective charge");
  }
  if (
    input.objective.system.multiplicity !== undefined &&
    input.objective.system.multiplicity !== input.plan.protocol.multiplicity
  ) {
    fail("OBJECTIVE_MISMATCH", "The protocol silently changes the objective multiplicity");
  }
  if (computeScientificProtocolDigest(input.plan.protocol) !== input.plan.protocol.protocolDigest) {
    fail("PROTOCOL_DIGEST_MISMATCH", "The protocol content does not match its digest");
  }
  if (input.plan.protocol.skillGraphDigest !== input.plan.skillResolution.graphDigest) {
    fail("SKILL_GRAPH_DIGEST_MISMATCH", "Protocol and resolved skill graph digests differ");
  }
  if (input.environment.environmentDigest !== input.plan.skillResolution.environmentDigest) {
    fail(
      "ENVIRONMENT_DIGEST_MISMATCH",
      "Compilation environment differs from the exact skill-resolution environment",
    );
  }
}

function assertExactSkillAttribution(input: ProtocolCompilationInput): void {
  const selected = new Set(input.plan.skillResolution.selectedFragments.map(fragmentIdentity));
  for (const step of input.plan.protocol.engineAgnosticSteps) {
    for (const source of step.sourceFragments) {
      if (!selected.has(fragmentIdentity(source))) {
        fail(
          "SKILL_ATTRIBUTION_MISMATCH",
          `Protocol fragment ${step.id} cites a fragment outside the exact resolved graph`,
          { protocolFragmentId: step.id, skillId: source.skillId, fragmentId: source.fragmentId },
        );
      }
    }
  }
}

function expectedDecisionValue(
  category: "charge" | "multiplicity" | "method" | "basis" | "physical_model",
  protocol: ScientificProtocol,
): string {
  if (category === "charge") return String(protocol.charge);
  if (category === "multiplicity") return String(protocol.multiplicity);
  if (category === "method") return protocol.method;
  if (category === "basis") return protocol.basis;
  return protocol.physicalModel;
}

function assertDecisions(input: ProtocolCompilationInput): void {
  const referenced = new Set(input.plan.protocol.decisions);
  const byCategory = new Map(input.decisions.map((decision) => [decision.category, decision]));
  const approved = new Set(input.approvedDecisionIds);

  for (const category of input.policy.requiredDecisionCategories) {
    const decision = byCategory.get(category);
    if (!decision || !referenced.has(decision.id) || decision.planId !== input.plan.id) {
      fail(
        "UNRESOLVED_MATERIAL_DECISION",
        `Required scientific decision ${category} is not resolved by the approved plan`,
        { category },
      );
    }
    const expected = expectedDecisionValue(category, input.plan.protocol);
    if (decision.selectedOption.trim().toLowerCase() !== expected.trim().toLowerCase()) {
      fail("DECISION_VALUE_MISMATCH", `Decision ${decision.id} does not select ${expected}`, {
        category,
        expected,
        selected: decision.selectedOption,
      });
    }
    if (
      input.policy.materialDecisionApproval === "separate" &&
      decision.requiresApproval &&
      !approved.has(decision.id)
    ) {
      fail(
        "UNAPPROVED_MATERIAL_DECISION",
        `Material decision ${decision.id} lacks its separate approval`,
        { decisionId: decision.id },
      );
    }
  }
}

function evidenceInputRefs(input: ProtocolCompilationInput): string[] {
  const referencedAssumptions = new Set(input.plan.protocol.assumptions);
  const assumptionsById = new Map(
    input.plan.assumptions.map((assumption) => [assumption.id, assumption]),
  );
  const decisionsById = new Map(input.decisions.map((decision) => [decision.id, decision]));
  const refs = [input.plan.protocol.system.evidenceId];

  for (const assumptionId of referencedAssumptions) {
    const assumption = assumptionsById.get(assumptionId);
    if (!assumption) {
      fail("MISSING_SCIENTIFIC_INPUT", `Protocol references missing assumption ${assumptionId}`, {
        assumptionId,
      });
    }
    refs.push(...assumption.evidenceRefs);
  }
  for (const decisionId of input.plan.protocol.decisions) {
    const decision = decisionsById.get(decisionId);
    if (!decision) {
      fail("UNRESOLVED_MATERIAL_DECISION", `Protocol references missing decision ${decisionId}`, {
        decisionId,
      });
    }
    refs.push(...decision.evidenceRefs);
  }
  return [...new Set(refs)].sort();
}

function assertCompatibility(input: ProtocolCompilationInput): void {
  const engine = input.environment.selectedEngine;
  if (
    !input.constraints.allowedEngines.includes(engine.id) ||
    input.constraints.deniedEngines.includes(engine.id)
  ) {
    fail("ENGINE_NOT_ALLOWED", `Engine ${engine.id} is not allowed by mission constraints`);
  }

  const compatibility = new Map(
    input.environment.skillCompatibility.map((entry) => [
      `${entry.skillId}\u0000${entry.version}\u0000${entry.contentDigest}`,
      entry,
    ]),
  );
  for (const node of input.plan.skillResolution.nodes) {
    const key = `${node.skillId}\u0000${node.version}\u0000${node.contentDigest}`;
    const entry = compatibility.get(key);
    if (!entry || !entry.compatible) {
      fail("INCOMPATIBLE_SKILL", `Skill ${node.skillId}@${node.version} is incompatible`, {
        skillId: node.skillId,
        version: node.version,
        reasons: entry?.reasons ?? ["No exact compatibility record"],
      });
    }
    if (
      !atLeast(
        entry.knowledgeMaturity,
        input.policy.minimumKnowledgeMaturity,
        knowledgeMaturityOrder,
      ) ||
      !atLeast(
        entry.capabilityMaturity,
        input.policy.minimumCapabilityMaturity,
        capabilityMaturityOrder,
      )
    ) {
      fail(
        "INSUFFICIENT_SKILL_MATURITY",
        `Skill ${node.skillId}@${node.version} does not meet the compilation maturity floor`,
        {
          skillId: node.skillId,
          knowledgeMaturity: entry.knowledgeMaturity,
          capabilityMaturity: entry.capabilityMaturity,
        },
      );
    }
    if (!entry.engineNeutral) {
      const engineCompatibility = entry.compatibleEngines.find(
        (candidate) => candidate.id === engine.id,
      );
      if (
        !engineCompatibility ||
        !engineCompatibility.versions.includes(engine.version) ||
        !engineCompatibility.adapterVersions.includes(engine.adapterVersion)
      ) {
        fail(
          "ENGINE_INCOMPATIBLE",
          `Skill ${node.skillId}@${node.version} does not support the exact engine and adapter`,
          { skillId: node.skillId, engine },
        );
      }
    }
  }

  const availableCapabilities = new Set(input.environment.capabilities);
  for (const step of input.plan.protocol.engineAgnosticSteps) {
    const capability = requiredCapability(input.policy, step.kind);
    if (!availableCapabilities.has(capability)) {
      fail("CAPABILITY_UNAVAILABLE", `Required typed capability ${capability} is unavailable`, {
        fragmentId: step.id,
        capability,
      });
    }
  }
}

function dependenciesFor(
  fragment: ProtocolFragment,
  index: number,
  allFragments: readonly ProtocolFragment[],
  policy: CompilerPolicyProfile,
): string[] {
  if (Object.hasOwn(policy.dependencyMap, fragment.id)) {
    return [...new Set(policy.dependencyMap[fragment.id])].sort();
  }
  return index === 0 ? [] : [allFragments[index - 1].id];
}

function topologicalFragmentOrder(
  fragments: readonly ProtocolFragment[],
  dependencies: ReadonlyMap<string, readonly string[]>,
): ProtocolFragment[] {
  const byId = new Map<string, ProtocolFragment>();
  const originalOrder = new Map<string, number>();
  for (const [index, fragment] of fragments.entries()) {
    if (byId.has(fragment.id)) {
      fail("INVALID_DEPENDENCY", `Duplicate protocol fragment id ${fragment.id}`);
    }
    byId.set(fragment.id, fragment);
    originalOrder.set(fragment.id, index);
  }
  for (const [fragmentId, required] of dependencies) {
    for (const dependencyId of required) {
      if (!byId.has(dependencyId) || dependencyId === fragmentId) {
        fail("INVALID_DEPENDENCY", `Invalid dependency ${fragmentId} -> ${dependencyId}`);
      }
    }
  }

  const remaining = new Set(byId.keys());
  const emitted = new Set<string>();
  const result: ProtocolFragment[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) => (dependencies.get(id) ?? []).every((dependency) => emitted.has(dependency)))
      .sort((left, right) => (originalOrder.get(left) ?? 0) - (originalOrder.get(right) ?? 0));
    if (ready.length === 0) {
      fail("CYCLIC_DEPENDENCY", "Protocol fragment dependencies contain a cycle", {
        fragments: [...remaining].sort(),
      });
    }
    for (const id of ready) {
      remaining.delete(id);
      emitted.add(id);
      result.push(byId.get(id)!);
    }
  }
  return result;
}

function sortSkillRefs(references: readonly SkillFragmentReference[]): SkillFragmentReference[] {
  return [...references].sort((left, right) =>
    compareProtocolText(fragmentIdentity(left), fragmentIdentity(right)),
  );
}

/**
 * Purely compiles an exact approved plan into durable work-unit values. Rendering, execution,
 * parsing, and validation remain distinct typed capabilities and are never invoked here.
 */
export function compileScientificProtocol(input: ProtocolCompilationInput): CompiledWorkUnitDag {
  try {
    input = snapshotProtocolData(input);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new TypeError("Expected compiler input");
  } catch {
    fail("INVALID_COMPILER_INPUT", "Scientific compiler accepts only bounded data records");
  }
  assertInput(input);
  assertExactSkillAttribution(input);
  assertDecisions(input);
  assertCompatibility(input);

  const fragments = input.plan.protocol.engineAgnosticSteps;
  const dependencyIds = new Map(
    fragments.map((fragment, index) => [
      fragment.id,
      dependenciesFor(fragment, index, fragments, input.policy),
    ]),
  );
  const orderedFragments = topologicalFragmentOrder(fragments, dependencyIds);
  const workUnitIds = new Map(
    fragments.map((fragment) => [fragment.id, deterministicWorkUnitId(input, fragment.id)]),
  );
  const inputRefs = evidenceInputRefs(input);
  const workUnits = orderedFragments.map((fragment): WorkUnit => {
    const dependencies = (dependencyIds.get(fragment.id) ?? []).map(
      (dependencyId) => workUnitIds.get(dependencyId)!,
    );
    const approvalRequired = fragment.riskClass > input.policy.automaticApprovalRiskCeiling;
    const retryPolicy =
      input.policy.retryOverrides[fragment.kind] ?? input.policy.defaultRetryPolicy;
    return {
      id: workUnitIds.get(fragment.id)!,
      missionId: input.plan.missionId,
      planId: input.plan.id,
      planVersion: input.plan.version,
      kind: fragment.kind,
      state: "created",
      reason: fragment.reason,
      dependencies,
      inputRefs,
      outputContract: snapshotProtocolData(outputContracts[fragment.kind]),
      skillRefs: sortSkillRefs(fragment.sourceFragments),
      protocolFragment: fragment,
      retryPolicy,
      approvalPolicy: approvalRequired
        ? { required: true, minimumRole: input.policy.minimumApprovalRole }
        : { required: false },
      executionPolicy: {
        capability: requiredCapability(input.policy, fragment.kind),
        riskClass: fragment.riskClass,
      },
      revision: 1,
      claimOwner: null,
      claimExpiresAt: null,
      jobId: null,
      attemptId: null,
      createdAt: input.plan.updatedAt,
      updatedAt: input.plan.updatedAt,
    };
  });

  const dependencies: WorkUnitDependency[] = workUnits.flatMap((workUnit) =>
    workUnit.dependencies.map((dependsOnWorkUnitId) => ({
      workUnitId: workUnit.id,
      dependsOnWorkUnitId,
    })),
  );
  const payload = {
    schemaVersion: WorkUnitDagVersion,
    compilerVersion: ProtocolCompilerVersion,
    missionId: input.plan.missionId,
    planId: input.plan.id,
    planVersion: input.plan.version,
    planRevision: input.plan.revision,
    protocolDigest: input.plan.protocol.protocolDigest,
    skillGraphDigest: input.plan.skillResolution.graphDigest,
    policyDigest: input.policy.policyDigest,
    environmentDigest: input.environment.environmentDigest,
    workUnits,
    dependencies,
  };
  return { ...payload, graphDigest: digestCanonical(payload) };
}
