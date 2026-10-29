import {
  SchemaVersion,
  digestCanonical,
  type ActorIdentity,
  type EvidenceReference,
  type MissionBudget,
  type ResolvedSkillGraph,
  type ScientificDecision,
  type ScientificMission,
  type ScientificObservation,
  type ScientificPlan,
  type ScientificProtocol,
  type SkillFragmentReference,
} from "@eigengrid/scientific-schema";
import {
  computeCompilerPolicyDigest,
  withScientificProtocolDigest,
  type CompilerPolicyProfile,
  type EnvironmentCapabilityProfile,
  type ProtocolCompilationInput,
} from "./protocol-compiler";

export const fixedNow = "2026-08-06T12:00:00.000Z";
export const fixedActor: ActorIdentity = {
  id: "scientific-planner-fixture",
  kind: "service",
  role: "scientific_planner",
};

export const skillFragment: SkillFragmentReference = {
  skillId: "workflows.geometry-optimization",
  version: "1.0.0",
  contentDigest: "a".repeat(64),
  fragmentId: "geometry-optimization.protocol",
  fragmentDigest: "b".repeat(64),
  relativePath: "protocols/optimization.yaml",
  selector: "$.protocols.minimum",
};

export const validationSkillFragment: SkillFragmentReference = {
  skillId: "validation.minimum-validation",
  version: "1.0.0",
  contentDigest: "c".repeat(64),
  fragmentId: "minimum-validation.protocol",
  fragmentDigest: "d".repeat(64),
  relativePath: "protocols/minimum.yaml",
  selector: "$.protocols.minimum",
};

export const diagnosisSkillFragment: SkillFragmentReference = {
  skillId: "diagnostics.scf-nonconvergence",
  version: "1.0.0",
  contentDigest: "e".repeat(64),
  fragmentId: "scf-nonconvergence.diagnosis",
  fragmentDigest: "f".repeat(64),
  relativePath: "diagnostics/scf.yaml",
  selector: "$.diagnostics.scf",
};

export const objective = {
  schemaVersion: SchemaVersion,
  id: "objective-water-minimum",
  statement: "Optimize water and establish whether the fixture geometry is a minimum",
  system: {
    evidenceId: "evidence-water-xyz",
    format: "xyz" as const,
    contentDigest: "1".repeat(64),
    atomCount: 3,
    charge: 0,
    multiplicity: 1,
  },
  targetProperties: ["minimum geometry"],
  requiredConfidence: "screening" as const,
};

export const budget: MissionBudget = {
  id: "budget-1",
  missionId: "mission-1",
  revision: 1,
  limits: {
    externalOperations: 20,
    modelTokens: 20_000,
    wallTimeSeconds: 3_600,
    cost: 10,
  },
  consumed: { externalOperations: 0, modelTokens: 0, wallTimeSeconds: 0, cost: 0 },
  reservations: [],
};

export const mission: ScientificMission = {
  schemaVersion: SchemaVersion,
  id: "mission-1",
  revision: 1,
  state: "planning",
  objective,
  constraints: {
    allowedEngines: ["fixture-engine"],
    deniedEngines: [],
    maximumWallTimeSeconds: 3_600,
    maximumCost: 10,
    offlineRequired: true,
    materialChangesRequireApproval: true,
    immutableScientificFields: [
      "objective",
      "charge",
      "multiplicity",
      "method",
      "basis",
      "physicalModel",
    ],
  },
  assumptions: [],
  acceptanceCriteria: [
    {
      id: "criterion-normal",
      kind: "normal_termination",
      description: "Calculation terminates normally",
      required: true,
    },
    {
      id: "criterion-minimum",
      kind: "minimum_frequency",
      description: "No significant imaginary frequency",
      required: true,
    },
  ],
  activePlanId: null,
  budgetId: budget.id,
  policyProfile: "policy-safe-local",
  requestedBy: { id: "human-1", kind: "human", role: "scientist" },
  createdAt: fixedNow,
  updatedAt: fixedNow,
};

export const skillGraph: ResolvedSkillGraph = {
  id: "skill-graph-1",
  schemaVersion: "eigengrid.resolved-skill-graph/v1",
  missionId: mission.id,
  requestedSkillIds: [skillFragment.skillId, validationSkillFragment.skillId],
  nodes: [
    {
      skillId: skillFragment.skillId,
      version: skillFragment.version,
      contentDigest: skillFragment.contentDigest,
    },
    {
      skillId: validationSkillFragment.skillId,
      version: validationSkillFragment.version,
      contentDigest: validationSkillFragment.contentDigest,
    },
  ],
  edges: [
    {
      from: skillFragment.skillId,
      to: validationSkillFragment.skillId,
      kind: "hard",
    },
  ],
  selectedFragments: [skillFragment, validationSkillFragment],
  resolverVersion: "1.0.0",
  environmentDigest: "2".repeat(64),
  graphDigest: "3".repeat(64),
  resolvedAt: fixedNow,
};

export function makeProtocol(overrides: Partial<ScientificProtocol> = {}): ScientificProtocol {
  const base: Omit<ScientificProtocol, "protocolDigest"> = {
    id: "protocol-1",
    schemaVersion: "eigengrid.scientific-protocol/v1",
    objectiveId: objective.id,
    system: objective.system,
    charge: 0,
    multiplicity: 1,
    method: "B3LYP",
    basis: "def2-SVP",
    physicalModel: "gas_phase_born_oppenheimer",
    engineAgnosticSteps: [
      {
        id: "step-optimize",
        kind: "optimization",
        reason: "Optimize the molecular geometry under the approved electronic model",
        parameters: {
          numericalConvergence: { scf: "tight", geometry: "normal" },
          conformationalTreatment: "single rigid water fixture",
        },
        sourceFragments: [skillFragment],
        riskClass: 2,
      },
      {
        id: "step-validate",
        kind: "validation",
        reason: "Apply the approved minimum-validation criteria",
        parameters: { criterionIds: ["criterion-normal", "criterion-minimum"] },
        sourceFragments: [validationSkillFragment],
        riskClass: 0,
      },
    ],
    assumptions: [],
    decisions: [
      "decision-charge",
      "decision-multiplicity",
      "decision-method",
      "decision-basis",
      "decision-physical-model",
    ],
    acceptanceCriteria: ["criterion-normal", "criterion-minimum"],
    skillGraphDigest: skillGraph.graphDigest,
    compilerVersion: "1.0.0",
  };
  const merged = { ...base, ...overrides };
  const { protocolDigest: _ignored, ...withoutDigest } = merged as ScientificProtocol;
  return withScientificProtocolDigest(withoutDigest);
}

export function makePlan(overrides: Partial<ScientificPlan> = {}): ScientificPlan {
  const protocol = overrides.protocol ?? makeProtocol();
  return {
    id: "plan-1",
    missionId: mission.id,
    version: 1,
    revision: 1,
    status: "approved",
    normalizedObjective: objective.statement,
    missingInputs: [],
    assumptions: [],
    skillResolution: skillGraph,
    alternatives: [
      { id: "alternative-none", description: "No lower-cost alternative for fixture" },
    ],
    risks: [
      {
        id: "risk-numerical",
        riskClass: 2,
        description: "SCF convergence may be slow",
        mitigation: "Use only approved numerical bounds",
      },
    ],
    estimatedCost: { wallTimeSeconds: 60, cpuCoreHours: 0.1, cost: 0 },
    requiredApprovals: ["scientific_reviewer"],
    validationGates: ["criterion-normal", "criterion-minimum"],
    limitations: ["Deterministic fixture evidence is not real-engine scientific validation"],
    createdBy: fixedActor,
    planDigest: "4".repeat(64),
    createdAt: fixedNow,
    updatedAt: fixedNow,
    ...overrides,
    protocol,
  };
}

const decisionCategories = [
  ["decision-charge", "charge", "0"],
  ["decision-multiplicity", "multiplicity", "1"],
  ["decision-method", "method", "B3LYP"],
  ["decision-basis", "basis", "def2-SVP"],
  ["decision-physical-model", "physical_model", "gas_phase_born_oppenheimer"],
] as const;

export function makeDecisions(planId = "plan-1"): ScientificDecision[] {
  return decisionCategories.map(([id, category, selectedOption]) => ({
    id,
    missionId: mission.id,
    planId,
    category,
    question: `Select ${category}`,
    selectedOption,
    alternatives: [
      { option: "unresolved alternative", reasonNotSelected: "Not supported by fixture" },
    ],
    rationale: "Explicit fixture decision",
    skillRefs: [skillFragment],
    evidenceRefs: [objective.system.evidenceId],
    confidence: { level: "medium", basis: "Fixture input" },
    riskClass: category === "charge" || category === "multiplicity" ? 3 : 2,
    requiresApproval: category === "charge" || category === "multiplicity",
    actor: fixedActor,
    createdAt: fixedNow,
  }));
}

export function makeCompilerPolicy(
  overrides: Partial<CompilerPolicyProfile> = {},
): CompilerPolicyProfile {
  const base: Omit<CompilerPolicyProfile, "policyDigest"> = {
    id: "policy-safe-local",
    version: "1.0.0",
    minimumKnowledgeMaturity: "reference_curated",
    minimumCapabilityMaturity: "plannable",
    automaticApprovalRiskCeiling: 2,
    materialDecisionApproval: "covered_by_plan",
    minimumApprovalRole: "scientific_reviewer",
    requiredDecisionCategories: ["charge", "multiplicity", "method", "basis", "physical_model"],
    defaultRetryPolicy: { maximumAttempts: 1, ambiguityRequiresReconciliation: true },
    retryOverrides: {
      validation: { maximumAttempts: 2, ambiguityRequiresReconciliation: true },
    },
    capabilityByKind: {
      structure_validation: "scientific.structure.validate",
      optimization: "scientific.optimization.request",
      frequency: "scientific.frequency.request",
      collection: "scientific.artifact.collect",
      parsing: "scientific.output.parse",
      validation: "scientific.result.validate",
      assessment: "scientific.assessment.compose",
      diagnosis: "scientific.failure.diagnose",
    },
    dependencyMap: {},
  };
  const merged = { ...base, ...overrides } as Omit<CompilerPolicyProfile, "policyDigest">;
  return { ...merged, policyDigest: computeCompilerPolicyDigest(merged) };
}

export function makeEnvironment(
  overrides: Partial<EnvironmentCapabilityProfile> = {},
): EnvironmentCapabilityProfile {
  const compatibleEngines = [
    { id: "fixture-engine", versions: ["1.2.3"], adapterVersions: ["1.0.0"] },
  ];
  return {
    id: "environment-ci",
    environmentDigest: skillGraph.environmentDigest,
    selectedEngine: { id: "fixture-engine", version: "1.2.3", adapterVersion: "1.0.0" },
    capabilities: Object.values(makeCompilerPolicy().capabilityByKind).filter(
      (value): value is string => value !== undefined,
    ),
    skillCompatibility: skillGraph.nodes.map((node) => ({
      ...node,
      compatible: true,
      reasons: [],
      knowledgeMaturity: "reference_curated",
      capabilityMaturity: "plannable",
      engineNeutral: false,
      compatibleEngines,
    })),
    ...overrides,
  };
}

export function makeCompilationInput(
  overrides: Partial<ProtocolCompilationInput> = {},
): ProtocolCompilationInput {
  const plan = overrides.plan ?? makePlan();
  return {
    objective,
    approvedPlanRevision: plan.revision,
    decisions: makeDecisions(plan.id),
    approvedDecisionIds: [],
    constraints: mission.constraints,
    policy: makeCompilerPolicy(),
    environment: makeEnvironment(),
    ...overrides,
    plan,
  };
}

export const structureEvidence: EvidenceReference = {
  id: objective.system.evidenceId,
  missionId: mission.id,
  kind: "structure",
  uri: "fixture://water.xyz",
  contentDigest: objective.system.contentDigest,
  sizeBytes: 96,
  mediaType: "chemical/x-xyz",
  immutable: true,
  createdAt: fixedNow,
};

export function makeScfObservation(
  payload: Record<string, unknown>,
  overrides: Partial<ScientificObservation> = {},
): ScientificObservation {
  return {
    id: "observation-scf-failure",
    missionId: mission.id,
    workUnitId: "work-unit-scf",
    type: "failure_signature",
    payload,
    source: { kind: "parser", id: "fixture-parser-1" },
    evidenceRefs: ["evidence-scf-output"],
    qualityFlags: [],
    observedAt: fixedNow,
    ...overrides,
  };
}

export const scfEvidence: EvidenceReference = {
  id: "evidence-scf-output",
  missionId: mission.id,
  workUnitId: "work-unit-scf",
  kind: "parser_output",
  uri: "fixture://scf-failure.json",
  contentDigest: digestCanonical({ fixture: "scf failure" }),
  immutable: true,
  createdAt: fixedNow,
};
