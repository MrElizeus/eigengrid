import { describe, expect, test } from "bun:test";
import { type ScientificMission } from "@eigengrid/scientific-schema";
import { assembleScientificContext } from "./context-assembler";
import { ScientificCritic } from "./critic";
import {
  DeterministicFakeModelProvider,
  ModelGateway,
  type ModelCapabilityDescriptor,
} from "./model-gateway";
import {
  computeScientificPlanDigest,
  ScientificPlanner,
  ScientificPlannerOutputVersion,
  type ScientificPlannerOutput,
} from "./planner";
import { withScientificProtocolDigest } from "./protocol-compiler";
import {
  budget,
  makeDecisions,
  makeEnvironment,
  makePlan,
  makeProtocol,
  mission,
  skillFragment,
  skillGraph,
  structureEvidence,
  validationSkillFragment,
} from "./test-fixtures";

function descriptor(): ModelCapabilityDescriptor {
  return {
    identity: {
      providerId: "fake-scientist",
      providerVersion: "1.0.0",
      modelId: "fixture-model",
      modelRevision: "r1",
    },
    supportedRoles: ["planner", "critic"],
    structuredOutput: true,
    supportsAbort: true,
    enforcesRawResponseByteLimit: true,
    maximumContextBytes: 1_000_000,
    maximumInputTokens: 100_000,
    maximumOutputTokens: 10_000,
    capabilityVersion: "1.0.0",
  };
}

function makeGateway(provider: DeterministicFakeModelProvider): ModelGateway {
  let id = 0;
  return new ModelGateway({
    providers: [provider],
    clock: () => new Date("2026-08-06T12:00:00.000Z"),
    idFactory: () => `invocation-${++id}`,
  });
}

function invocationBudget() {
  return {
    maximumCalls: 8,
    maximumInputTokens: 100_000,
    maximumOutputTokens: 10_000,
    maximumTotalTokens: 110_000,
    maximumCost: 1,
  };
}

function assembledContext() {
  const result = assembleScientificContext({
    mission,
    plan: makePlan(),
    policyProfile: { id: mission.policyProfile },
    budget,
    scope: "ci",
    skillFragments: [
      { reference: skillFragment, content: "Optimization guidance" },
      { reference: validationSkillFragment, content: "Validation guidance" },
    ],
    evidence: [{ reference: structureEvidence, summary: "Water structure fixture" }],
    maximumBytes: 1_000_000,
  });
  if (result.status !== "assembled") throw new Error("Fixture context did not assemble");
  return result;
}

function plannerOutput(overrides: Partial<ScientificPlannerOutput> = {}): ScientificPlannerOutput {
  const decisions = makeDecisions().map((decision) => ({
    id: decision.id,
    category: decision.category,
    question: decision.question,
    selectedOption: decision.selectedOption,
    alternatives: decision.alternatives,
    rationale: decision.rationale,
    skillRefs: decision.skillRefs,
    evidenceRefs: decision.evidenceRefs,
    riskClass: decision.riskClass,
    requiresApproval: decision.requiresApproval,
  }));
  return {
    schemaVersion: ScientificPlannerOutputVersion,
    normalizedObjective: mission.objective.statement,
    missingInputs: [],
    assumptions: [],
    candidateProtocol: makeProtocol(),
    skillReferences: [skillFragment, validationSkillFragment],
    scientificDecisions: decisions,
    alternatives: [
      { id: "alternative-1", description: "Defer execution", tradeoffs: ["No result"] },
    ],
    resourceEstimate: {
      wallTimeSeconds: 60,
      cpuCoreHours: 0.1,
      cost: 0,
      basis: "Deterministic fixture estimate",
    },
    riskClassification: {
      highestRiskClass: 3,
      reasons: ["Charge and multiplicity are material decisions"],
    },
    requiredApprovals: ["scientific_reviewer"],
    validationGates: [
      {
        criterionId: "criterion-normal",
        description: "Normal termination",
        requiredEvidenceKinds: ["operation_receipt"],
      },
      {
        criterionId: "criterion-minimum",
        description: "Minimum validation",
        requiredEvidenceKinds: ["parser_output", "skill_fragment"],
      },
    ],
    limitations: ["Fixture execution is not real-engine validation"],
    ...overrides,
  };
}

describe("scientific planner", () => {
  test("plan digest covers scientific content but not lifecycle-only approval transition fields", () => {
    const draft = makePlan({ status: "under_review", updatedAt: "2026-08-06T12:00:00.000Z" });
    const approved = {
      ...draft,
      status: "approved" as const,
      updatedAt: "2026-08-06T12:01:00.000Z",
    };
    expect(computeScientificPlanDigest(draft)).toBe(computeScientificPlanDigest(approved));
    expect(
      computeScientificPlanDigest({ ...approved, normalizedObjective: "changed objective" }),
    ).not.toBe(computeScientificPlanDigest(approved));
  });

  test("returns a schema- and provenance-valid candidate through the provider-neutral gateway", async () => {
    const output = plannerOutput();
    const provider = new DeterministicFakeModelProvider(descriptor(), [
      {
        kind: "response",
        response: {
          output,
          usage: { inputTokens: 100, outputTokens: 200, cost: 0 },
          conciseRationale: "Fixture plan assembled from exact skills",
        },
      },
    ]);
    const context = assembledContext();
    const result = await new ScientificPlanner(makeGateway(provider)).plan({
      mission,
      resolvedSkillGraph: skillGraph,
      context: context.context,
      contextDigest: context.contextDigest,
      invocationBudget: invocationBudget(),
      timeoutMilliseconds: 1_000,
    });

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    expect(result.output).toEqual(output);
    expect(result.records[0]).toEqual(
      expect.objectContaining({ role: "planner", status: "succeeded" }),
    );
    expect(provider.requests[0].role).toBe("planner");
    expect(provider.requests[0].instruction).toContain("do not execute, approve, or mutate");
  });

  test("uses bounded repair for semantic objective or provenance defects", async () => {
    const valid = plannerOutput();
    const invalidProtocol = makeProtocol({ objectiveId: "silently-changed-objective" });
    const provider = new DeterministicFakeModelProvider(descriptor(), [
      {
        kind: "response",
        response: { output: plannerOutput({ candidateProtocol: invalidProtocol }) },
      },
      { kind: "response", response: { output: valid } },
    ]);
    const context = assembledContext();
    const result = await new ScientificPlanner(makeGateway(provider)).plan({
      mission,
      resolvedSkillGraph: skillGraph,
      context: context.context,
      contextDigest: context.contextDigest,
      invocationBudget: invocationBudget(),
      timeoutMilliseconds: 1_000,
    });
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    expect(result.records[0].repairAttempts).toBe(1);
    expect(provider.requests[1].attempt.validationIssues?.join(" ")).toContain(
      "objective identity",
    );
  });
});

describe("independent scientific critic", () => {
  test("detects every mandatory defect category in an adversarial plan without mutating it", async () => {
    const objectiveWithoutState = structuredClone(mission) as ScientificMission;
    delete objectiveWithoutState.objective.system.charge;
    delete objectiveWithoutState.objective.system.multiplicity;
    objectiveWithoutState.constraints.maximumWallTimeSeconds = 10;
    objectiveWithoutState.constraints.maximumCost = 1;

    const baseProtocol = makeProtocol();
    const { protocolDigest: _digest, ...protocolWithoutDigest } = baseProtocol;
    const flawedProtocol = withScientificProtocolDigest({
      ...protocolWithoutDigest,
      objectiveId: "changed-objective",
      method: "UNSUPPORTED-METHOD",
      engineAgnosticSteps: [
        {
          ...baseProtocol.engineAgnosticSteps[0],
          parameters: {},
        },
      ],
    });
    flawedProtocol.protocolDigest = "0".repeat(64);

    const flawed = plannerOutput({
      assumptions: [
        {
          id: "assumption-contradicted",
          statement: "SCF is easy",
          status: "proposed",
          riskClass: 2,
          evidenceRefs: [],
        },
      ],
      candidateProtocol: flawedProtocol,
      scientificDecisions: [
        {
          id: "unsafe-method-change",
          category: "method",
          question: "Change method?",
          selectedOption: "UNSUPPORTED-METHOD",
          alternatives: [],
          rationale: "Unreviewed remediation",
          skillRefs: [skillFragment],
          evidenceRefs: [],
          riskClass: 3,
          requiresApproval: false,
        },
      ],
      validationGates: [],
      resourceEstimate: {
        wallTimeSeconds: 1_000,
        cpuCoreHours: 100,
        cost: 100,
        basis: "unsupported estimate",
      },
    });
    const before = structuredClone(flawed);
    const environment = makeEnvironment({
      selectedEngine: { id: "denied-engine", version: "99", adapterVersion: "1.0.0" },
    });
    environment.skillCompatibility[0].knowledgeMaturity = "draft";
    environment.skillCompatibility[0].capabilityMaturity = "reference";
    const context = assembledContext();

    const review = await new ScientificCritic().review({
      mission: objectiveWithoutState,
      planId: "plan-adversarial",
      candidate: flawed,
      environment,
      requirements: {
        electronicStateAlternativesRequired: true,
        conformationalTreatmentRequired: true,
        numericalConvergenceRequired: true,
        allowedMethods: ["B3LYP"],
        requiredValidationKinds: ["operation_receipt", "parser_output", "skill_fragment"],
        requiredProvenanceKinds: ["objective", "structure", "environment", "parser_output"],
        maximumCpuCoreHours: 1,
        minimumKnowledgeMaturity: "reference_curated",
        minimumCapabilityMaturity: "plannable",
      },
      evidence: [
        {
          id: "evidence-contradiction",
          statement: "SCF failed",
          contradictsAssumptionIds: ["assumption-contradicted"],
          kinds: ["structure"],
        },
      ],
      context: context.context,
      contextDigest: context.contextDigest,
    });

    expect(review.verdict).toBe("revise");
    expect(review.requiresNewPlanRevision).toBe(true);
    const expectedCodes: Array<(typeof review.findings)[number]["code"]> = [
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
    ];
    expect(review.findings.map((finding) => finding.code).sort()).toEqual(expectedCodes.sort());
    expect(flawed).toEqual(before);
    expect(Object.isFrozen(review)).toBe(true);
  });

  test("model critic has a strict findings-only boundary and a distinct invocation role", async () => {
    const output = plannerOutput();
    const provider = new DeterministicFakeModelProvider(descriptor(), [
      {
        kind: "response",
        response: {
          output: {
            schemaVersion: "eigengrid.scientific-critic-output/v1",
            findings: [],
            limitations: [],
            approved: true,
          },
        },
      },
      {
        kind: "response",
        response: {
          output: {
            schemaVersion: "eigengrid.scientific-critic-output/v1",
            findings: [],
            limitations: ["Fixture-only model critique"],
          },
        },
      },
    ]);
    const context = assembledContext();
    const review = await new ScientificCritic(makeGateway(provider)).review({
      mission,
      planId: "plan-1",
      candidate: output,
      environment: makeEnvironment(),
      requirements: {
        electronicStateAlternativesRequired: false,
        conformationalTreatmentRequired: true,
        numericalConvergenceRequired: true,
        allowedMethods: ["B3LYP"],
        requiredValidationKinds: ["operation_receipt", "parser_output", "skill_fragment"],
        requiredProvenanceKinds: ["structure"],
        maximumCpuCoreHours: 10,
        minimumKnowledgeMaturity: "reference_curated",
        minimumCapabilityMaturity: "plannable",
      },
      evidence: [
        {
          id: structureEvidence.id,
          statement: "Water structure",
          contradictsAssumptionIds: [],
          kinds: ["structure"],
        },
      ],
      context: context.context,
      contextDigest: context.contextDigest,
      gatewayBudget: invocationBudget(),
      timeoutMilliseconds: 1_000,
    });

    expect(review.modelStatus).toBe("succeeded");
    expect(review.modelInvocations[0]).toEqual(
      expect.objectContaining({ role: "critic", repairAttempts: 1 }),
    );
    expect(provider.requests.every((request) => request.role === "critic")).toBe(true);
    expect(provider.requests[0].instruction).toContain("cannot edit the proposal, approve it");
    expect(JSON.stringify(review)).not.toContain('"approved":true');
  });

  test("planner and critic request digests and records remain logically independent", async () => {
    const provider = new DeterministicFakeModelProvider(descriptor(), [
      { kind: "response", response: { output: plannerOutput() } },
      {
        kind: "response",
        response: {
          output: {
            schemaVersion: "eigengrid.scientific-critic-output/v1",
            findings: [],
            limitations: [],
          },
        },
      },
    ]);
    const modelGateway = makeGateway(provider);
    const context = assembledContext();
    const planResult = await new ScientificPlanner(modelGateway).plan({
      mission,
      resolvedSkillGraph: skillGraph,
      context: context.context,
      contextDigest: context.contextDigest,
      invocationBudget: invocationBudget(),
      timeoutMilliseconds: 1_000,
    });
    expect(planResult.status).toBe("succeeded");
    if (planResult.status !== "succeeded") return;
    const review = await new ScientificCritic(modelGateway).review({
      mission,
      planId: "plan-1",
      candidate: planResult.output,
      environment: makeEnvironment(),
      requirements: {
        electronicStateAlternativesRequired: false,
        conformationalTreatmentRequired: false,
        numericalConvergenceRequired: false,
        allowedMethods: ["B3LYP"],
        requiredValidationKinds: [],
        requiredProvenanceKinds: [],
        minimumKnowledgeMaturity: "reference_curated",
        minimumCapabilityMaturity: "plannable",
      },
      evidence: [],
      context: context.context,
      contextDigest: context.contextDigest,
      gatewayBudget: invocationBudget(),
      timeoutMilliseconds: 1_000,
    });
    expect(planResult.records[0].role).toBe("planner");
    expect(review.modelInvocations[0].role).toBe("critic");
    expect(planResult.records[0].requestDigest).not.toBe(review.modelInvocations[0].requestDigest);
  });
});
