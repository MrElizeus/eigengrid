import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "@eigengrid/core";
import type { Recipe } from "@eigengrid/recipes";
import {
  ScientificEffectReconciliationStore,
  ScientificInternalWorkUnitStore,
  ScientificMissionHead,
  RestartSafeScientificMissionHeadStore,
  ScientificStore,
} from "@eigengrid/mission-runtime";
import {
  EvidenceReferenceSchema,
  MissionBudgetSchema,
  ScientificMissionSchema,
  SchemaVersion,
  digestBytes,
  digestCanonical,
} from "@eigengrid/scientific-schema";
import {
  ModelGateway,
  ScientificCritic,
  ScientificMissionService,
  ScientificPlanner,
  computeCompilerPolicyDigest,
  type CompilerPolicyProfile,
  type EnvironmentCapabilityProfile,
} from "@eigengrid/scientific-agent";
import {
  ScientificSkillRegistry,
  loadScientificSkillCorpus,
  repositoryScientificSkillsRoot,
  resolveScientificSkillGraph,
} from "@eigengrid/scientific-skills";
import { createApplicationContext, type ApplicationContext } from "../../apps/cli/src/composition";
import { ExactApprovalScientificMissionDriver } from "../../apps/cli/src/services/scientific-approval-driver";
import { CanonicalScientificExecutionDriver } from "../../apps/cli/src/services/scientific-mission-driver";
import { CanonicalScientificExecutionInspector } from "../../apps/cli/src/services/scientific-execution-inspector";
import { CanonicalScientificPostprocessor } from "../../apps/cli/src/services/scientific-postprocessor";
import { ScientificExecutionWithPostprocessingDriver } from "../../apps/cli/src/services/scientific-execution-driver";
import { ScientificMissionDriverRouter } from "../../apps/cli/src/services/scientific-internal-driver";
import { GoldenScientificPlannerProvider } from "../fixtures/scientific-provider";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "../..");
const FIXED_TIME = "2026-08-06T12:00:00.000Z";
const PARSER_VERSION = "controlled-alpha-parser-bridge/1";
const requestedSkills = [
  "workflows.geometry-optimization",
  "workflows.frequencies-and-thermochemistry",
  "validation.minimum-validation",
  "validation.uncertainty-assessment",
] as const;
const reviewer = {
  id: "golden-scientific-reviewer",
  kind: "human" as const,
  role: "scientific_reviewer",
  displayName: "Golden mission reviewer",
};

const SCIENTIFIC_FIXTURE_RECIPE: Recipe = {
  id: "scientific-golden-orca-fixture",
  software: "orca",
  description: "Deterministic ORCA-shaped execution fixture for provenance tests.",
  inputExtensions: [".xyz"],
  commands: {
    local: {
      run: 'python3 -c \'import pathlib,sys; source=pathlib.Path(sys.argv[1]); rows=source.read_text(encoding="utf-8").splitlines(); assert rows and rows[0].strip()=="3"; output=["EIGENGRID DETERMINISTIC FIXTURE","**** CONVERGENCE REACHED ****","THE OPTIMIZATION HAS CONVERGED","ENERGY = -76.400000 Eh","ORCA METHOD: B3LYP","def2-SVP","Charge = 0","Multiplicity = 1","CARTESIAN COORDINATES (ANGSTROEM)","---------------------------------","O 0.000000 0.000000 0.000000","H 0.758602 0.000000 0.504284","H -0.758602 0.000000 0.504284","","VIBRATIONAL FREQUENCIES","-----------------------","Mode Frequency","cm-1","1 1595.000","2 3657.000","3 3756.000","","TOTAL CPU TIME: 0 days 0 hours 0 minutes 0.010 seconds","TOTAL WALL TIME: 0 days 0 hours 0 minutes 0.015 seconds","****ORCA TERMINATED NORMALLY****"]; pathlib.Path(sys.argv[2]).write_text(chr(10).join(output)+chr(10),encoding="utf-8")\' {{input}} {{output}}',
    },
  },
  outputs: { mainLog: "scientific.out" },
  parser: { name: "orca" },
  resources: { defaultCores: 1, defaultMemoryGb: 1 },
};

function config(root: string, pythonCommand: string): Partial<Config> {
  return {
    databasePath: join(root, "eigengrid.db"),
    dbProvider: "sqlite",
    jobsDir: join(root, "jobs"),
    logsDir: join(root, "logs"),
    outputsDir: join(root, "outputs"),
    sessionsDir: join(root, "sessions"),
    pythonCommand,
  };
}

function policy(): CompilerPolicyProfile {
  const base: Omit<CompilerPolicyProfile, "policyDigest"> = {
    id: "policy-scientific-golden-local",
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

function environment(
  registry: ScientificSkillRegistry,
  compilerPolicy: CompilerPolicyProfile,
): EnvironmentCapabilityProfile {
  const preview = resolveScientificSkillGraph(registry, {
    requested: requestedSkills,
    missionId: "environment-preview",
    engine: { id: "orca", version: "6.0.0" },
    domains: ["molecular-electronic-structure"],
    minimumKnowledgeMaturity: compilerPolicy.minimumKnowledgeMaturity,
    requiredCapability: compilerPolicy.minimumCapabilityMaturity,
    resolvedAt: FIXED_TIME,
  });
  const base = {
    id: "environment-scientific-golden-local",
    selectedEngine: { id: "orca", version: "6.0.0", adapterVersion: "1.0.0" },
    capabilities: [...new Set(Object.values(compilerPolicy.capabilityByKind))].sort(),
    skillCompatibility: preview.skills.map((skill) => {
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
    }),
  };
  return { ...base, environmentDigest: digestCanonical(base) };
}

interface Runtime {
  context: ApplicationContext;
  store: ScientificStore;
  head: ScientificMissionHead;
}

async function openRuntime(root: string, compilerPolicy: CompilerPolicyProfile): Promise<Runtime> {
  const pythonCommand = join(root, "python-with-eigengrid");
  await writeFile(
    pythonCommand,
    `#!/bin/sh\nPYTHONPATH='${join(REPOSITORY_ROOT, "python", "src")}' exec python3 "$@"\n`,
    "utf8",
  );
  await chmod(pythonCommand, 0o755);
  const context = await createApplicationContext({
    config: config(root, pythonCommand),
    recipes: [SCIENTIFIC_FIXTURE_RECIPE],
  });
  const store = new ScientificStore(context.db);
  const canonical = new CanonicalScientificExecutionDriver({
    store,
    execution: context.execution,
    effectPersistence: new ScientificEffectReconciliationStore(context.db),
    currentPolicyDigestFor: () => compilerPolicy.policyDigest,
    now: () => new Date(FIXED_TIME),
  });
  const postprocessor = new CanonicalScientificPostprocessor({
    store,
    execution: context.execution,
    inspector: new CanonicalScientificExecutionInspector(context.db),
    parserVersion: PARSER_VERSION,
  });
  const external = new ScientificExecutionWithPostprocessingDriver({
    store,
    executionDriver: canonical,
    postprocessor,
  });
  const router = new ScientificMissionDriverRouter({
    store,
    persistence: new ScientificInternalWorkUnitStore(context.db),
    externalDriver: external,
  });
  const driver = new ExactApprovalScientificMissionDriver({
    store,
    delegate: router,
    currentPolicyDigestFor: () => compilerPolicy.policyDigest,
  });
  const head = new ScientificMissionHead({
    ownerId: "eigengrid-head-golden-stable",
    store: new RestartSafeScientificMissionHeadStore(store, context.db),
    driver,
    policyDigestFor: () => compilerPolicy.policyDigest,
    leaseMilliseconds: 10_000,
    maximumClaimsPerMissionTick: 1,
    // The execution driver uses FIXED_TIME; claim acquisition must use the same
    // clock or the fixture attempts an effect before its lease was acquired.
    now: () => new Date(FIXED_TIME),
  });
  return { context, store, head };
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

describe("durable scientific golden mission", () => {
  const roots: string[] = [];

  beforeAll(() => {
    const probe = Bun.spawnSync(["python3", "-m", "eigengrid_chem", "--version"], {
      env: { ...process.env, PYTHONPATH: join(REPOSITORY_ROOT, "python", "src") },
    });
    if (!probe.success) {
      throw new Error(
        `The real parser bridge requires its Python runtime dependencies (pip install -e ./python): ${probe.stderr.toString()}`,
      );
    }
  });

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("survives process replacement and reaches an idempotent objective-to-assessment provenance graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "eigengrid-scientific-golden-"));
    roots.push(root);
    const structurePath = join(root, "water.xyz");
    const xyz =
      "3\nwater deterministic fixture\nO 0.000000 0.000000 0.000000\nH 0.758602 0.000000 0.504284\nH -0.758602 0.000000 0.504284\n";
    await writeFile(structurePath, xyz, "utf8");
    const structureDigest = digestBytes(xyz);
    const compilerPolicy = policy();
    const registry = new ScientificSkillRegistry(
      loadScientificSkillCorpus(repositoryScientificSkillsRoot()),
    );
    const capabilityProfile = environment(registry, compilerPolicy);
    const provider = new GoldenScientificPlannerProvider();

    let runtime = await openRuntime(root, compilerPolicy);
    const gateway = new ModelGateway({
      providers: [provider],
      clock: () => new Date(FIXED_TIME),
      idFactory: () => "model-invocation-golden-planner",
    });
    const service = new ScientificMissionService({
      store: runtime.store,
      skillRegistry: registry,
      planner: new ScientificPlanner(gateway),
      critic: new ScientificCritic(),
      now: () => new Date(FIXED_TIME),
    });
    const mission = ScientificMissionSchema.parse({
      schemaVersion: SchemaVersion,
      id: "mission-scientific-golden",
      revision: 1,
      state: "created",
      objective: {
        schemaVersion: SchemaVersion,
        id: "objective-scientific-golden",
        statement:
          "Optimize the water fixture, compute harmonic frequencies, and assess whether the recorded stationary point is a minimum.",
        system: {
          evidenceId: "evidence-scientific-golden-structure",
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
          id: "criterion-golden-normal",
          kind: "normal_termination",
          description: "Every executed fixture step terminates normally.",
          required: true,
        },
        {
          id: "criterion-golden-electronic",
          kind: "electronic_convergence",
          description: "Every executed fixture step reports electronic convergence.",
          required: true,
        },
        {
          id: "criterion-golden-minimum",
          kind: "minimum_frequency",
          description: "The frequency result contains no imaginary frequencies.",
          threshold: 0,
          required: true,
        },
      ],
      activePlanId: null,
      budgetId: "budget-scientific-golden",
      policyProfile: compilerPolicy.id,
      requestedBy: reviewer,
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
    });
    const budget = MissionBudgetSchema.parse({
      id: mission.budgetId,
      missionId: mission.id,
      revision: 1,
      limits: { externalOperations: 4, modelTokens: 20_000, wallTimeSeconds: 600, cost: 0 },
      consumed: { externalOperations: 0, modelTokens: 0, wallTimeSeconds: 0, cost: 0 },
      reservations: [],
    });
    const structure = EvidenceReferenceSchema.parse({
      id: mission.objective.system.evidenceId,
      missionId: mission.id,
      kind: "structure",
      uri: structurePath,
      contentDigest: structureDigest,
      sizeBytes: Buffer.byteLength(xyz),
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
        "charge multiplicity molecular DFT basis convergence geometry optimization frequency thermochemistry minimum validation uncertainty",
      skillSelectionReason: "Compile the exact bounded molecular minimum protocol",
      environment: capabilityProfile,
      compilerPolicy,
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
          statement: "The immutable XYZ evidence declares neutral singlet water.",
          contradictsAssumptionIds: [],
          kinds: ["structure"],
        },
      ],
      evidenceSummaries: [
        {
          reference: structure,
          summary: "Immutable neutral singlet water fixture with exact SHA-256 digest.",
        },
      ],
      contextMaximumBytes: 250_000,
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
    await service.decidePlanApproval({
      missionId: mission.id,
      approvalRequestId: planned.approval.id,
      decision: "approved",
      actor: reviewer,
      reason: "Approve the exact deterministic fixture plan and no scientific substitutions.",
      currentPolicyDigest: compilerPolicy.policyDigest,
      authorizedRoles: [reviewer.role],
      decidedAt: FIXED_TIME,
    });
    const compiled = await service.compileApprovedPlan({
      missionId: mission.id,
      planId: planned.plan.id,
      compilerPolicy,
      environment: capabilityProfile,
      actor: reviewer,
      at: FIXED_TIME,
    });
    expect(compiled.workUnits.map((workUnit) => workUnit.kind)).toEqual([
      "optimization",
      "frequency",
      "validation",
      "assessment",
    ]);
    await service.startExecution(mission.id, reviewer, FIXED_TIME);

    const firstTick = await runtime.head.tick();
    if (firstTick.totals.failedWorkUnits !== 0) {
      throw new Error(`First scientific effect failed: ${JSON.stringify(firstTick.missions)}`);
    }
    expect(firstTick.totals.claimsWon).toBe(1);
    expect((await runtime.context.db.listJobs()).length).toBe(1);
    await runtime.context.close();

    await sleep(600);
    runtime = await openRuntime(root, compilerPolicy);
    const restartTick = await runtime.head.tick();
    expect(restartTick.totals.reconciled).toBeGreaterThanOrEqual(1);
    expect((await runtime.context.db.listJobs()).length).toBe(2);
    await runtime.context.close();

    await sleep(600);
    runtime = await openRuntime(root, compilerPolicy);
    for (let iteration = 0; iteration < 12; iteration += 1) {
      await runtime.head.tick();
      const current = await runtime.store.getMission(mission.id);
      if (current?.state === "completed") break;
      await sleep(100);
    }

    const provenance = await runtime.store.getMissionProvenance(mission.id);
    const jobs = await runtime.context.db.listJobs();
    expect(provenance.mission.state).toBe("completed");
    expect(jobs).toHaveLength(2);
    expect(provenance.operations).toHaveLength(2);
    expect(provenance.receipts).toHaveLength(2);
    expect(provenance.workUnits.every((workUnit) => workUnit.state === "succeeded")).toBe(true);
    expect(provenance.observations.some((observation) => observation.type === "energy")).toBe(true);
    expect(
      provenance.observations.some((observation) => observation.type === "imaginary_frequencies"),
    ).toBe(true);
    expect(provenance.validations).toHaveLength(3);
    expect(provenance.validations.every((validation) => validation.status === "passed")).toBe(true);
    expect(provenance.assessments).toHaveLength(1);
    expect(provenance.assessments[0]?.status).toBe("supported");
    expect(provenance.assessments[0]?.parserVersion).toBe(PARSER_VERSION);
    expect(provenance.assessments[0]?.limitations.join(" ")).toContain("fixture");
    expect(
      provenance.evidence.filter((evidence) => evidence.kind === "artifact").length,
    ).toBeGreaterThan(0);
    expect(
      provenance.evidence.filter((evidence) => evidence.kind === "parser_output"),
    ).toHaveLength(2);
    expect(
      provenance.evidence.filter((evidence) => evidence.kind === "rendered_input"),
    ).toHaveLength(2);
    expect(
      provenance.evidence.filter((evidence) => evidence.kind === "operation_receipt"),
    ).toHaveLength(2);
    expect(
      provenance.observations
        .filter((observation) => observation.source.kind === "parser")
        .every((observation) => observation.payload.parserVersion === PARSER_VERSION),
    ).toBe(true);
    expect(provenance.complete).toBe(true);
    expect(provenance.missingReferences).toEqual([]);

    const workUnitIds = new Set(provenance.workUnits.map((workUnit) => workUnit.id));
    expect(provenance.operations.every((operation) => workUnitIds.has(operation.workUnitId))).toBe(
      true,
    );
    expect(
      provenance.receipts.every((receipt) =>
        provenance.operations.some((operation) => operation.id === receipt.operationId),
      ),
    ).toBe(true);
    expect(provenance.assessments[0]?.skillRefs).toEqual(
      planned.plan.skillResolution.selectedFragments,
    );
    expect(provenance.modelInvocations).toHaveLength(1);
    expect(provider.requests).toHaveLength(1);

    const stableCounts = {
      jobs: jobs.length,
      operations: provenance.operations.length,
      receipts: provenance.receipts.length,
      evidence: provenance.evidence.length,
      observations: provenance.observations.length,
      validations: provenance.validations.length,
      assessments: provenance.assessments.length,
    };
    await service.compileApprovedPlan({
      missionId: mission.id,
      planId: planned.plan.id,
      compilerPolicy,
      environment: capabilityProfile,
      actor: reviewer,
      at: FIXED_TIME,
    });
    await runtime.head.tick();
    const repeated = await runtime.store.getMissionProvenance(mission.id);
    expect(await runtime.context.db.listJobs()).toHaveLength(stableCounts.jobs);
    expect(repeated.operations).toHaveLength(stableCounts.operations);
    expect(repeated.receipts).toHaveLength(stableCounts.receipts);
    expect(repeated.evidence).toHaveLength(stableCounts.evidence);
    expect(repeated.observations).toHaveLength(stableCounts.observations);
    expect(repeated.validations).toHaveLength(stableCounts.validations);
    expect(repeated.assessments).toHaveLength(stableCounts.assessments);

    await runtime.context.close();
  }, 30_000);
});
