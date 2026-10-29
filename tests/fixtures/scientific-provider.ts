import {
  ModelCapabilityDescriptorSchema,
  ScientificPlannerOutputVersion,
  withScientificProtocolDigest,
  type GatewayProviderRequest,
  type ModelProvider,
  type ScientificPlannerOutput,
} from "@eigengrid/scientific-agent";
import type {
  AcceptanceCriterion,
  ResolvedSkillGraph,
  ScientificObjective,
  SkillFragmentReference,
} from "@eigengrid/scientific-schema";

function fragment(
  graph: ResolvedSkillGraph,
  skillId: string,
  preferredPath: string,
): SkillFragmentReference {
  const selected =
    graph.selectedFragments.find(
      (candidate) =>
        candidate.skillId === skillId && candidate.relativePath.includes(preferredPath),
    ) ?? graph.selectedFragments.find((candidate) => candidate.skillId === skillId);
  if (!selected) throw new Error(`Deterministic planner did not receive ${skillId}`);
  return selected;
}

export class GoldenScientificPlannerProvider implements ModelProvider {
  readonly capabilities = ModelCapabilityDescriptorSchema.parse({
    identity: {
      providerId: "eigengrid-ci",
      providerVersion: "1.0.0",
      modelId: "golden-scientific-planner",
      modelRevision: "1",
    },
    supportedRoles: ["planner"],
    structuredOutput: true,
    supportsAbort: true,
    enforcesRawResponseByteLimit: true,
    maximumContextBytes: 2_000_000,
    maximumInputTokens: 500_000,
    maximumOutputTokens: 50_000,
    capabilityVersion: "1.0.0",
  });

  readonly requests: GatewayProviderRequest[] = [];

  constructor(private readonly recipeId = "scientific-golden-orca-fixture") {}

  async invoke(request: GatewayProviderRequest, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    this.requests.push(structuredClone(request));
    const input = request.input as {
      objective: ScientificObjective;
      acceptanceCriteria: AcceptanceCriterion[];
      resolvedSkillGraph: ResolvedSkillGraph;
    };
    return {
      output: buildGoldenPlannerOutput(
        input.objective,
        input.acceptanceCriteria,
        input.resolvedSkillGraph,
        this.recipeId,
      ),
      usage: { inputTokens: 256, outputTokens: 512, cost: 0 },
      conciseRationale:
        "Exact skill fragments and immutable objective evidence define a bounded fixture protocol.",
    };
  }
}

export function buildGoldenPlannerOutput(
  objective: ScientificObjective,
  criteria: readonly AcceptanceCriterion[],
  graph: ResolvedSkillGraph,
  recipeId: string,
): ScientificPlannerOutput {
  const chargeSpin = fragment(graph, "foundations.charge-spin-symmetry", "decision");
  const method = fragment(graph, "methods.molecular-dft", "decision");
  const basis = fragment(graph, "foundations.basis-ecp-relativity", "decision");
  const optimization = fragment(graph, "workflows.geometry-optimization", "protocol");
  const frequencies = fragment(graph, "workflows.frequencies-and-thermochemistry", "protocol");
  const minimumValidation = fragment(graph, "validation.minimum-validation", "validation");
  const uncertainty = fragment(graph, "validation.uncertainty-assessment", "validation");
  const evidenceRefs = [objective.system.evidenceId];
  const decisions = [
    {
      id: `decision-${objective.id}-charge`,
      category: "charge" as const,
      question: "What molecular charge is authorized?",
      selectedOption: String(objective.system.charge),
      alternatives: [{ option: "1", reasonNotSelected: "Contradicts the neutral fixture" }],
      rationale: "The immutable molecular input declares charge zero.",
      skillRefs: [chargeSpin],
      evidenceRefs,
      riskClass: 3 as const,
      requiresApproval: true,
    },
    {
      id: `decision-${objective.id}-multiplicity`,
      category: "multiplicity" as const,
      question: "What spin multiplicity is authorized?",
      selectedOption: String(objective.system.multiplicity),
      alternatives: [{ option: "3", reasonNotSelected: "No triplet evidence exists" }],
      rationale: "The immutable molecular input declares a singlet.",
      skillRefs: [chargeSpin],
      evidenceRefs,
      riskClass: 3 as const,
      requiresApproval: true,
    },
    {
      id: `decision-${objective.id}-method`,
      category: "method" as const,
      question: "Which explicit method defines the fixture?",
      selectedOption: "B3LYP",
      alternatives: [{ option: "PBE0", reasonNotSelected: "Not the approved CI fixture" }],
      rationale: "This is a fixture-bound choice, not a universal recommendation.",
      skillRefs: [method],
      evidenceRefs,
      riskClass: 3 as const,
      requiresApproval: true,
    },
    {
      id: `decision-${objective.id}-basis`,
      category: "basis" as const,
      question: "Which explicit basis defines the fixture?",
      selectedOption: "def2-SVP",
      alternatives: [{ option: "def2-TZVP", reasonNotSelected: "Outside the bounded CI fixture" }],
      rationale: "The exact basis is approval-bound.",
      skillRefs: [basis],
      evidenceRefs,
      riskClass: 3 as const,
      requiresApproval: true,
    },
    {
      id: `decision-${objective.id}-physical-model`,
      category: "physical_model" as const,
      question: "Which physical model defines the fixture?",
      selectedOption: "gas_phase_born_oppenheimer",
      alternatives: [
        { option: "continuum_solvation", reasonNotSelected: "No solvent is in the objective" },
      ],
      rationale: "The objective is explicitly gas phase.",
      skillRefs: [method],
      evidenceRefs,
      riskClass: 3 as const,
      requiresApproval: true,
    },
  ];
  const protocol = withScientificProtocolDigest({
    id: `protocol-${objective.id}`,
    schemaVersion: "eigengrid.scientific-protocol/v1",
    objectiveId: objective.id,
    system: objective.system,
    charge: objective.system.charge ?? 0,
    multiplicity: objective.system.multiplicity ?? 1,
    method: "B3LYP",
    basis: "def2-SVP",
    physicalModel: "gas_phase_born_oppenheimer",
    engineAgnosticSteps: [
      {
        id: "optimize-golden-geometry",
        kind: "optimization",
        reason: "Optimize the exact deterministic molecular fixture.",
        parameters: {
          numericalConvergence: { scf: "tight", geometry: "tight" },
          conformationalTreatment: "single rigid water fixture",
          requiredObservationKinds: [
            "normal_termination",
            "electronic_convergence",
            "geometry_convergence",
            "energy",
          ],
          execution: {
            software: "orca",
            recipeId,
            inputEvidenceId: objective.system.evidenceId,
            fixtureEvidenceOnly: true,
          },
        },
        sourceFragments: [optimization],
        riskClass: 2,
      },
      {
        id: "compute-golden-frequencies",
        kind: "frequency",
        reason: "Compute deterministic harmonic frequencies at the approved model.",
        parameters: {
          numericalConvergence: { scf: "tight", frequency: "analytic-fixture" },
          requiredObservationKinds: [
            "normal_termination",
            "electronic_convergence",
            "imaginary_frequencies",
            "energy",
          ],
          execution: {
            software: "orca",
            recipeId,
            inputEvidenceId: objective.system.evidenceId,
            fixtureEvidenceOnly: true,
          },
        },
        sourceFragments: [frequencies],
        riskClass: 2,
      },
      {
        id: "validate-golden-minimum",
        kind: "validation",
        reason: "Apply exact termination, convergence, and minimum criteria.",
        parameters: { criterionIds: criteria.map((criterion) => criterion.id) },
        sourceFragments: [minimumValidation],
        riskClass: 0,
      },
      {
        id: "assess-golden-evidence",
        kind: "assessment",
        reason: "Compose a fixture-bounded scientific assessment.",
        parameters: { fixtureEvidenceOnly: true },
        sourceFragments: [uncertainty],
        riskClass: 0,
      },
    ],
    assumptions: [],
    decisions: decisions.map((decision) => decision.id),
    acceptanceCriteria: criteria.map((criterion) => criterion.id),
    skillGraphDigest: graph.graphDigest,
    compilerVersion: "1.0.0",
  });
  return {
    schemaVersion: ScientificPlannerOutputVersion,
    normalizedObjective: objective.statement,
    missingInputs: [],
    assumptions: [],
    candidateProtocol: protocol,
    skillReferences: graph.selectedFragments,
    scientificDecisions: decisions,
    alternatives: [
      {
        id: "alternative-reviewed-plan-only",
        description: "Retain the exact reviewed plan without executing it.",
        tradeoffs: ["No execution evidence", "Zero external effects"],
      },
    ],
    resourceEstimate: {
      wallTimeSeconds: 120,
      cpuCoreHours: 0.01,
      cost: 0,
      basis: "Deterministic local fixture budget; not a real ORCA estimate.",
    },
    riskClassification: {
      highestRiskClass: 3,
      reasons: ["Charge, multiplicity, method, basis, and physical model are approval-bound."],
    },
    requiredApprovals: ["scientific_reviewer"],
    validationGates: criteria.map((criterion) => ({
      criterionId: criterion.id,
      description: criterion.description,
      requiredEvidenceKinds:
        criterion.kind === "minimum_frequency" ? ["imaginary_frequencies"] : [criterion.kind],
    })),
    limitations: [
      "The executable is a deterministic ORCA-shaped fixture, not the ORCA program.",
      "Passing this path proves lifecycle and provenance, not broad DFT accuracy.",
    ],
  };
}
