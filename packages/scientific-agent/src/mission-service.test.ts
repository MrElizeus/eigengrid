import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDatabase } from "@eigengrid/db";
import { ScientificStore, computeSkillGraphDigest } from "@eigengrid/mission-runtime";
import {
  EvidenceReferenceSchema,
  MissionBudgetSchema,
  ScientificMissionSchema,
  SchemaVersion,
  digestBytes,
  digestCanonical,
  type ResolvedSkillGraph,
  type ScientificObjective,
  type SkillFragmentReference,
} from "@eigengrid/scientific-schema";
import {
  ScientificSkillRegistry,
  loadScientificSkillCorpus,
  repositoryScientificSkillsRoot,
  resolveScientificSkillGraph,
} from "@eigengrid/scientific-skills";
import {
  ModelCapabilityDescriptorSchema,
  ModelGateway,
  type GatewayProviderRequest,
  type ModelProvider,
} from "./model-gateway";
import { ScientificCritic } from "./critic";
import { ScientificMissionService } from "./mission-service";
import { ScientificPlanner, ScientificPlannerOutputVersion } from "./planner";
import {
  computeCompilerPolicyDigest,
  withScientificProtocolDigest,
  type CompilerPolicyProfile,
  type EnvironmentCapabilityProfile,
} from "./protocol-compiler";

const FIXED_TIME = "2026-08-06T12:00:00.000Z";
const reviewer = {
  id: "chemist-reviewer-1",
  kind: "human" as const,
  role: "scientific_reviewer",
  displayName: "Deterministic CI reviewer",
};

const requestedSkills = [
  "workflows.geometry-optimization",
  "workflows.frequencies-and-thermochemistry",
  "validation.minimum-validation",
  "validation.uncertainty-assessment",
] as const;

function pickFragment(
  graph: ResolvedSkillGraph,
  skillId: string,
  preferredAsset: string,
): SkillFragmentReference {
  const exact = graph.selectedFragments.find(
    (fragment) =>
      fragment.skillId === skillId && fragment.relativePath.startsWith(`${preferredAsset}/`),
  );
  const fallback = graph.selectedFragments.find((fragment) => fragment.skillId === skillId);
  const selected = exact ?? fallback;
  if (!selected) throw new Error(`Planner fixture did not receive a fragment for ${skillId}`);
  return selected;
}

class GraphAwareDeterministicPlannerProvider implements ModelProvider {
  readonly capabilities = ModelCapabilityDescriptorSchema.parse({
    identity: {
      providerId: "eigengrid-ci",
      providerVersion: "1.0.0",
      modelId: "graph-aware-planner",
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

  async invoke(request: GatewayProviderRequest, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    this.requests.push(structuredClone(request));
    const input = request.input as {
      objective: ScientificObjective;
      acceptanceCriteria: Array<{ id: string; description: string }>;
      resolvedSkillGraph: ResolvedSkillGraph;
    };
    const graph = input.resolvedSkillGraph;
    const objective = input.objective;
    const optimization = pickFragment(graph, "workflows.geometry-optimization", "protocols");
    const frequencies = pickFragment(
      graph,
      "workflows.frequencies-and-thermochemistry",
      "protocols",
    );
    const minimumValidation = pickFragment(graph, "validation.minimum-validation", "validation");
    const uncertainty = pickFragment(graph, "validation.uncertainty-assessment", "validation");
    const chargeSpin = pickFragment(graph, "foundations.charge-spin-symmetry", "decision-rules");
    const method = pickFragment(graph, "methods.molecular-dft", "decision-rules");
    const basis = pickFragment(graph, "foundations.basis-ecp-relativity", "decision-rules");

    const decisions = [
      {
        id: `decision-${objective.id}-charge`,
        category: "charge" as const,
        question: "What molecular charge is authorized by the objective evidence?",
        selectedOption: String(objective.system.charge),
        alternatives: [
          { option: "1", reasonNotSelected: "Contradicts the neutral molecular fixture" },
        ],
        rationale: "The immutable structure reference declares a neutral molecule.",
        skillRefs: [chargeSpin],
        evidenceRefs: [objective.system.evidenceId],
        riskClass: 3 as const,
        requiresApproval: true,
      },
      {
        id: `decision-${objective.id}-multiplicity`,
        category: "multiplicity" as const,
        question: "Which spin multiplicity is authorized by the objective evidence?",
        selectedOption: String(objective.system.multiplicity),
        alternatives: [
          { option: "3", reasonNotSelected: "No open-shell evidence supports a triplet state" },
        ],
        rationale: "The closed-shell water fixture declares a singlet state.",
        skillRefs: [chargeSpin],
        evidenceRefs: [objective.system.evidenceId],
        riskClass: 3 as const,
        requiresApproval: true,
      },
      {
        id: `decision-${objective.id}-method`,
        category: "method" as const,
        question: "Which electronic-structure method should define the fixture protocol?",
        selectedOption: "B3LYP",
        alternatives: [
          { option: "PBE0", reasonNotSelected: "The CI fixture is standardized on B3LYP" },
        ],
        rationale:
          "This is an explicitly approved deterministic fixture choice, not a universal recommendation.",
        skillRefs: [method],
        evidenceRefs: [objective.system.evidenceId],
        riskClass: 3 as const,
        requiresApproval: true,
      },
      {
        id: `decision-${objective.id}-basis`,
        category: "basis" as const,
        question: "Which basis should define the fixture protocol?",
        selectedOption: "def2-SVP",
        alternatives: [
          { option: "def2-TZVP", reasonNotSelected: "Unnecessary for the bounded CI fixture" },
        ],
        rationale: "The basis is explicit and approval-bound for the deterministic fixture.",
        skillRefs: [basis],
        evidenceRefs: [objective.system.evidenceId],
        riskClass: 3 as const,
        requiresApproval: true,
      },
      {
        id: `decision-${objective.id}-physical-model`,
        category: "physical_model" as const,
        question: "Which physical model should define the fixture protocol?",
        selectedOption: "gas_phase_born_oppenheimer",
        alternatives: [
          {
            option: "continuum_solvation",
            reasonNotSelected: "The objective contains no solvent environment",
          },
        ],
        rationale: "The bounded objective is explicitly gas phase.",
        skillRefs: [method],
        evidenceRefs: [objective.system.evidenceId],
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
          id: "optimize-fixture-geometry",
          kind: "optimization",
          reason: "Optimize the exact molecular fixture under the approved electronic model.",
          parameters: {
            numericalConvergence: { scf: "tight", geometry: "tight" },
            conformationalTreatment: "single rigid water fixture",
            execution: {
              software: "fixture-orca",
              recipeId: "golden-optimization",
              inputEvidenceId: objective.system.evidenceId,
            },
          },
          sourceFragments: [optimization],
          riskClass: 2,
        },
        {
          id: "compute-fixture-frequencies",
          kind: "frequency",
          reason: "Compute harmonic frequencies at the approved optimized electronic model.",
          parameters: {
            numericalConvergence: { scf: "tight", frequency: "analytic-fixture" },
            execution: {
              software: "fixture-orca",
              recipeId: "golden-frequency",
              inputEvidenceId: objective.system.evidenceId,
            },
          },
          sourceFragments: [frequencies],
          riskClass: 2,
        },
        {
          id: "validate-fixture-minimum",
          kind: "validation",
          reason: "Apply exact termination, convergence, and minimum-frequency criteria.",
          parameters: {
            criterionIds: input.acceptanceCriteria.map((criterion) => criterion.id),
          },
          sourceFragments: [minimumValidation],
          riskClass: 0,
        },
        {
          id: "assess-fixture-uncertainty",
          kind: "assessment",
          reason:
            "Compose a bounded assessment that distinguishes fixture evidence from real-engine evidence.",
          parameters: { fixtureEvidenceOnly: true },
          sourceFragments: [uncertainty],
          riskClass: 0,
        },
      ],
      assumptions: [],
      decisions: decisions.map((decision) => decision.id),
      acceptanceCriteria: input.acceptanceCriteria.map((criterion) => criterion.id),
      skillGraphDigest: graph.graphDigest,
      compilerVersion: "1.0.0",
    });

    return {
      output: {
        schemaVersion: ScientificPlannerOutputVersion,
        normalizedObjective: objective.statement,
        missingInputs: [],
        assumptions: [],
        candidateProtocol: protocol,
        skillReferences: graph.selectedFragments,
        scientificDecisions: decisions,
        alternatives: [
          {
            id: "alternative-no-execution",
            description: "Retain the mission as a reviewed plan without executing the fixture.",
            tradeoffs: ["No execution evidence", "Preserves zero-effect review mode"],
          },
        ],
        resourceEstimate: {
          wallTimeSeconds: 120,
          cpuCoreHours: 0.01,
          cost: 0,
          basis: "Deterministic local fixture budget; not a real ORCA runtime estimate.",
        },
        riskClassification: {
          highestRiskClass: 3,
          reasons: ["Method, basis, charge, multiplicity, and physical model are approval-bound."],
        },
        requiredApprovals: ["scientific_reviewer"],
        validationGates: input.acceptanceCriteria.map((criterion) => ({
          criterionId: criterion.id,
          description: criterion.description,
          requiredEvidenceKinds:
            criterion.id === "criterion-minimum"
              ? ["imaginary_frequencies"]
              : ["normal_termination"],
        })),
        limitations: [
          "The executable used by CI is deterministic fixture software, not a licensed chemistry engine.",
          "Passing this path proves orchestration and provenance, not broad scientific validation.",
        ],
      },
      usage: { inputTokens: 256, outputTokens: 512, cost: 0 },
      conciseRationale:
        "The proposal preserves exact objective fields, exact skill fragments, and durable approval boundaries.",
    };
  }
}

function compilerPolicy(): CompilerPolicyProfile {
  const base: Omit<CompilerPolicyProfile, "policyDigest"> = {
    id: "policy-golden-local",
    version: "1.0.0",
    minimumKnowledgeMaturity: "draft",
    minimumCapabilityMaturity: "plannable",
    automaticApprovalRiskCeiling: 2,
    materialDecisionApproval: "covered_by_plan",
    minimumApprovalRole: reviewer.role,
    requiredDecisionCategories: ["charge", "multiplicity", "method", "basis", "physical_model"],
    defaultRetryPolicy: { maximumAttempts: 1, ambiguityRequiresReconciliation: true },
    retryOverrides: {
      validation: { maximumAttempts: 2, ambiguityRequiresReconciliation: true },
      assessment: { maximumAttempts: 2, ambiguityRequiresReconciliation: true },
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
  return { ...base, policyDigest: computeCompilerPolicyDigest(base) };
}

function environmentProfile(
  registry: ScientificSkillRegistry,
  policy: CompilerPolicyProfile,
): EnvironmentCapabilityProfile {
  const preview = resolveScientificSkillGraph(registry, {
    requested: requestedSkills,
    missionId: "preview",
    engine: { id: "orca", version: "6.0.0" },
    domains: ["molecular-electronic-structure"],
    minimumKnowledgeMaturity: policy.minimumKnowledgeMaturity,
    requiredCapability: policy.minimumCapabilityMaturity,
    resolvedAt: FIXED_TIME,
  });
  const compatibility = preview.skills.map((skill) => {
    const engineNeutral = Object.keys(skill.manifest.engine_compatibility).length === 0;
    return {
      skillId: skill.manifest.id,
      version: skill.manifest.version,
      contentDigest: skill.contentDigest,
      compatible: true,
      reasons: [] as string[],
      knowledgeMaturity: skill.manifest.knowledge_level,
      capabilityMaturity: "plannable" as const,
      engineNeutral,
      compatibleEngines: engineNeutral
        ? []
        : [{ id: "orca", versions: ["6.0.0"], adapterVersions: ["1.0.0"] }],
    };
  });
  const base = {
    id: "environment-golden-local",
    selectedEngine: { id: "orca", version: "6.0.0", adapterVersion: "1.0.0" },
    capabilities: [...new Set(Object.values(policy.capabilityByKind))].sort(),
    skillCompatibility: compatibility,
  };
  return { ...base, environmentDigest: digestCanonical(base) };
}

describe("ScientificMissionService durable vertical core", () => {
  let directory: string;
  let database: SqliteDatabase;
  let store: ScientificStore;
  let registry: ScientificSkillRegistry;
  let service: ScientificMissionService;
  let provider: GraphAwareDeterministicPlannerProvider;
  let environment: EnvironmentCapabilityProfile;
  let policy: CompilerPolicyProfile;
  let structurePath: string;
  let structureDigest: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "eigengrid-mission-service-"));
    structurePath = join(directory, "water.xyz");
    const xyz =
      "3\nwater deterministic fixture\nO 0.000000 0.000000 0.000000\nH 0.758602 0.000000 0.504284\nH -0.758602 0.000000 0.504284\n";
    writeFileSync(structurePath, xyz, "utf8");
    structureDigest = digestBytes(xyz);
    database = new SqliteDatabase(join(directory, "state.sqlite"));
    await database.init();
    store = new ScientificStore(database);
    registry = new ScientificSkillRegistry(
      loadScientificSkillCorpus(repositoryScientificSkillsRoot()),
    );
    policy = compilerPolicy();
    environment = environmentProfile(registry, policy);
    provider = new GraphAwareDeterministicPlannerProvider();
    let invocationSequence = 0;
    const gateway = new ModelGateway({
      providers: [provider],
      clock: () => new Date(FIXED_TIME),
      idFactory: () => `model-invocation-${++invocationSequence}`,
    });
    service = new ScientificMissionService({
      store,
      skillRegistry: registry,
      planner: new ScientificPlanner(gateway),
      critic: new ScientificCritic(),
      now: () => new Date(FIXED_TIME),
    });
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test("persists objective, exact skills, structured plan, critique, approval, and deterministic WorkUnits", async () => {
    const mission = ScientificMissionSchema.parse({
      schemaVersion: SchemaVersion,
      id: "mission-golden-service",
      revision: 1,
      state: "created",
      objective: {
        schemaVersion: SchemaVersion,
        id: "objective-golden-water",
        statement:
          "Optimize the water fixture, compute frequencies, and assess whether it is a minimum.",
        system: {
          evidenceId: "evidence-golden-water",
          format: "xyz",
          contentDigest: structureDigest,
          atomCount: 3,
          charge: 0,
          multiplicity: 1,
        },
        targetProperties: ["optimized geometry", "harmonic frequencies", "minimum classification"],
        requiredConfidence: "screening",
      },
      constraints: {
        allowedEngines: ["orca"],
        deniedEngines: [],
        maximumWallTimeSeconds: 600,
        maximumCost: 0,
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
          description: "The deterministic executable terminates normally.",
          required: true,
        },
        {
          id: "criterion-minimum",
          kind: "minimum_frequency",
          description: "The parsed fixture reports no significant imaginary frequency.",
          required: true,
        },
      ],
      activePlanId: null,
      budgetId: "budget-golden-service",
      policyProfile: policy.id,
      requestedBy: reviewer,
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
    });
    const budget = MissionBudgetSchema.parse({
      id: mission.budgetId,
      missionId: mission.id,
      revision: 1,
      limits: {
        externalOperations: 10,
        modelTokens: 20_000,
        wallTimeSeconds: 600,
        cost: 0,
      },
      consumed: { externalOperations: 0, modelTokens: 0, wallTimeSeconds: 0, cost: 0 },
      reservations: [],
    });
    const structure = EvidenceReferenceSchema.parse({
      id: mission.objective.system.evidenceId,
      missionId: mission.id,
      kind: "structure",
      uri: structurePath,
      contentDigest: structureDigest,
      sizeBytes: Buffer.byteLength(readFileText(structurePath), "utf8"),
      mediaType: "chemical/x-xyz",
      immutable: true,
      createdAt: FIXED_TIME,
    });
    await service.createMission({ mission, budget, objectiveEvidence: [structure] });

    const planned = await service.planMission({
      missionId: mission.id,
      requestedSkillIds: [...requestedSkills],
      includeOptionalSkills: false,
      domains: ["molecular-electronic-structure"],
      skillQuery:
        "water molecular DFT charge multiplicity basis geometry optimization frequencies minimum validation uncertainty numerical convergence",
      skillSelectionReason: "Build the exact bounded molecular optimization-frequency protocol",
      environment,
      compilerPolicy: policy,
      criticRequirements: {
        electronicStateAlternativesRequired: true,
        conformationalTreatmentRequired: false,
        numericalConvergenceRequired: true,
        allowedMethods: ["B3LYP"],
        requiredValidationKinds: ["normal_termination", "imaginary_frequencies"],
        requiredProvenanceKinds: ["structure"],
        maximumCpuCoreHours: 1,
        minimumKnowledgeMaturity: "draft",
        minimumCapabilityMaturity: "plannable",
      },
      criticEvidence: [
        {
          id: structure.id,
          statement: "The immutable XYZ fixture declares water with charge 0 and multiplicity 1.",
          contradictsAssumptionIds: [],
          kinds: ["structure"],
        },
      ],
      evidenceSummaries: [
        {
          reference: structure,
          summary: "Immutable neutral singlet water XYZ fixture used only for deterministic CI.",
        },
      ],
      contextMaximumBytes: 200_000,
      plannerBudget: {
        maximumCalls: 1,
        maximumInputTokens: 100_000,
        maximumOutputTokens: 20_000,
        maximumTotalTokens: 120_000,
        maximumCost: 0,
      },
      timeoutMilliseconds: 5_000,
      maximumRepairAttempts: 0,
      approvalRequestedBy: reviewer,
    });

    expect(planned.status).toBe("awaiting_approval");
    if (planned.status !== "awaiting_approval") throw new Error(planned.status);
    expect(planned.critique.verdict).toBe("acceptable");
    expect(planned.critique.findings).toEqual([]);
    expect(planned.plan.skillResolution.selectedFragments.length).toBeGreaterThan(0);
    expect(planned.plan.skillResolution.graphDigest).toBe(
      computeSkillGraphDigest(planned.plan.skillResolution),
    );
    expect(provider.requests).toHaveLength(1);

    const approval = await service.decidePlanApproval({
      missionId: mission.id,
      approvalRequestId: planned.approval.id,
      decision: "approved",
      actor: reviewer,
      reason: "The exact fixture plan is approved for deterministic local execution evidence.",
      currentPolicyDigest: policy.policyDigest,
      authorizedRoles: [reviewer.role],
      decidedAt: FIXED_TIME,
    });
    expect(approval.state).toBe("approved");

    const compiled = await service.compileApprovedPlan({
      missionId: mission.id,
      planId: planned.plan.id,
      compilerPolicy: policy,
      environment,
      actor: reviewer,
      at: FIXED_TIME,
    });
    expect(compiled.workUnits.map((workUnit) => workUnit.kind)).toEqual([
      "optimization",
      "frequency",
      "validation",
      "assessment",
    ]);
    expect(compiled.workUnits.every((workUnit) => workUnit.state === "created")).toBe(true);

    const provenance = await store.getMissionProvenance(mission.id);
    expect(provenance.mission.state).toBe("ready");
    expect(provenance.mission.activePlanId).toBe(planned.plan.id);
    expect(provenance.plans).toHaveLength(1);
    expect(provenance.plans[0]?.status).toBe("approved");
    expect(provenance.decisions).toHaveLength(5);
    expect(provenance.approvals).toHaveLength(1);
    expect(provenance.approvals[0]?.state).toBe("approved");
    expect(provenance.modelInvocations).toHaveLength(1);
    expect(provenance.workUnits.map((workUnit) => workUnit.state)).toEqual([
      "ready",
      "ready",
      "ready",
      "ready",
    ]);
    expect(provenance.skillResolutions[0]?.graphDigest).toBe(
      planned.plan.skillResolution.graphDigest,
    );
    expect(provenance.evidence.some((evidence) => evidence.kind === "skill_fragment")).toBe(true);
  });

  test("requires the production mission actor to match the immutable human owner", async () => {
    const mission = ScientificMissionSchema.parse({
      schemaVersion: SchemaVersion,
      id: "mission-production-actor",
      revision: 1,
      state: "created",
      objective: {
        schemaVersion: SchemaVersion,
        id: "objective-production-actor",
        statement: "Bind the deterministic fixture to one authenticated project owner.",
        system: {
          evidenceId: "evidence-production-actor",
          format: "xyz",
          contentDigest: structureDigest,
          atomCount: 3,
          charge: 0,
          multiplicity: 1,
        },
        targetProperties: ["immutable project association"],
        requiredConfidence: "screening",
      },
      constraints: {
        allowedEngines: ["orca"],
        deniedEngines: [],
        offlineRequired: true,
        materialChangesRequireApproval: true,
        immutableScientificFields: ["objective", "charge", "multiplicity"],
      },
      assumptions: [],
      acceptanceCriteria: [
        {
          id: "criterion-production-actor",
          kind: "normal_termination",
          description: "Fixture binds the exact actor before any planning.",
          required: true,
        },
      ],
      activePlanId: null,
      budgetId: "budget-production-actor",
      policyProfile: policy.id,
      requestedBy: reviewer,
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
    });
    const budget = MissionBudgetSchema.parse({
      id: mission.budgetId,
      missionId: mission.id,
      revision: 1,
      limits: { externalOperations: 1, modelTokens: 1, wallTimeSeconds: 60, cost: 0 },
      consumed: { externalOperations: 0, modelTokens: 0, wallTimeSeconds: 0, cost: 0 },
      reservations: [],
    });
    const structure = EvidenceReferenceSchema.parse({
      id: mission.objective.system.evidenceId,
      missionId: mission.id,
      kind: "structure",
      uri: structurePath,
      contentDigest: structureDigest,
      sizeBytes: Buffer.byteLength(readFileText(structurePath), "utf8"),
      mediaType: "chemical/x-xyz",
      immutable: true,
      createdAt: FIXED_TIME,
    });
    await database.createUser({ id: reviewer.id, username: "chemist-reviewer-1" });
    await database.createProject({ id: "project-production-actor", name: "Production actor" });
    await database.addProjectMember("project-production-actor", reviewer.id, "member");

    await expect(
      service.createMissionInProject({
        mission,
        budget,
        objectiveEvidence: [structure],
        authenticatedActor: { ...reviewer, id: "another-human" },
        projectId: "project-production-actor",
      }),
    ).rejects.toThrow(/requester must equal the authenticated human actor/);
    expect(await store.getMission(mission.id)).toBeNull();

    await service.createMissionInProject({
      mission,
      budget,
      objectiveEvidence: [structure],
      authenticatedActor: reviewer,
      projectId: "project-production-actor",
    });
    expect(await store.getMissionProjectAssociation(mission.id)).toMatchObject({
      ownerUserId: reviewer.id,
      projectId: "project-production-actor",
    });
  });
});

function readFileText(path: string): string {
  return requireText(path);
}

function requireText(path: string): string {
  return require("node:fs").readFileSync(path, "utf8") as string;
}
