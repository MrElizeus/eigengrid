import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteDatabase } from "@eigengrid/db";
import {
  ApprovalRequestSchema,
  ApprovalResponseSchema,
  EvidenceReferenceSchema,
  MissionBudgetSchema,
  ScientificDecisionSchema,
  ScientificMissionSchema,
  ScientificPlanSchema,
  SchemaVersion,
  WorkUnitSchema,
  canonicalJson,
  digestCanonical,
} from "@eigengrid/scientific-schema";
import {
  ScientificStore,
  computePlanDigest,
  computeProtocolDigest,
  computeSkillGraphDigest,
} from "@eigengrid/mission-runtime";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "../..");
const HEAD = join(REPOSITORY_ROOT, "apps", "cli", "bin", "eigengrid-head.ts");
const POLICY_DIGEST = "e".repeat(64);
const FIXED_TIME = "2026-08-06T00:00:00.000Z";
let COMPILED_HEAD = "";

const reviewer = {
  id: "compiled-head-reviewer",
  kind: "human" as const,
  role: "scientific_reviewer",
};
const owner = {
  id: "compiled-head-owner",
  kind: "service" as const,
  role: "mission_owner",
};
const skillFragment = {
  skillId: "methods.compiled-head-fixture",
  version: "1.0.0",
  contentDigest: "a".repeat(64),
  fragmentId: "compiled-head.optimization",
  fragmentDigest: "b".repeat(64),
  relativePath: "skills/methods.compiled-head-fixture/optimization.md",
  selector: "optimization",
};

interface HeadRunOptions {
  policyDigest?: string | null;
  pathPrefix?: string;
  deploymentProfile?: "development" | "production";
}

async function runHead(
  root: string,
  args: string[],
  options: HeadRunOptions = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const policyDigest = options.policyDigest === undefined ? POLICY_DIGEST : options.policyDigest;
  const child = Bun.spawn([COMPILED_HEAD, ...args], {
    cwd: REPOSITORY_ROOT,
    env: {
      ...Bun.env,
      DATABASE_URL: undefined,
      EIGENGRID_DATABASE_URL: undefined,
      EIGENGRID_DEPLOYMENT_PROFILE: options.deploymentProfile ?? "development",
      EIGENGRID_DATA_DIR: root,
      EIGENGRID_DB_PATH: join(root, "eigengrid.db"),
      EIGENGRID_JOBS_DIR: join(root, "jobs"),
      EIGENGRID_ARTIFACTS_DIR: join(root, "artifacts"),
      EIGENGRID_DB_PROVIDER: "sqlite",
      EIGENGRID_LOG_LEVEL: "error",
      ...(policyDigest === null
        ? { EIGENGRID_SCIENTIFIC_POLICY_DIGEST: undefined }
        : { EIGENGRID_SCIENTIFIC_POLICY_DIGEST: policyDigest }),
      ...(options.pathPrefix ? { PATH: `${options.pathPrefix}:${Bun.env.PATH ?? ""}` } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function digestBytes(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function seedExecutableMission(root: string): Promise<{ executableDirectory: string }> {
  const input = "! B3LYP def2-SVP Opt\n* xyz 0 1\nH 0 0 0\n*\n";
  const inputPath = join(root, "approved.inp");
  await writeFile(inputPath, input, "utf8");
  const inputDigest = digestBytes(input);
  const executableDirectory = join(root, "bin");
  await mkdir(executableDirectory, { recursive: true });
  const fakeOrca = join(executableDirectory, "orca");
  await writeFile(
    fakeOrca,
    "#!/bin/sh\nprintf '%s\\n' '**** CONVERGENCE REACHED ****' 'THE OPTIMIZATION HAS CONVERGED' 'ENERGY = -1.000000 Eh' '****ORCA TERMINATED NORMALLY****'\n",
    "utf8",
  );
  await chmod(fakeOrca, 0o755);

  const mission = ScientificMissionSchema.parse({
    schemaVersion: SchemaVersion,
    id: "mission-compiled-head",
    revision: 1,
    state: "created",
    objective: {
      schemaVersion: SchemaVersion,
      id: "objective-compiled-head",
      statement: "Run the exact approved compiled-head optimization fixture",
      system: {
        evidenceId: "evidence-compiled-head-input",
        format: "engine_input",
        contentDigest: inputDigest,
        atomCount: 1,
        charge: 0,
        multiplicity: 1,
      },
      targetProperties: ["compiled binary dispatch"],
      requiredConfidence: "screening",
    },
    constraints: {
      allowedEngines: ["orca"],
      deniedEngines: [],
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
        id: "criterion-compiled-head-normal",
        kind: "normal_termination",
        description: "The compiled binary fixture terminates normally",
        required: true,
      },
    ],
    activePlanId: null,
    budgetId: "budget-compiled-head",
    policyProfile: "compiled-head-policy",
    requestedBy: reviewer,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  });
  const budget = MissionBudgetSchema.parse({
    id: mission.budgetId,
    missionId: mission.id,
    revision: 1,
    limits: { externalOperations: 1, modelTokens: 0, wallTimeSeconds: 60, cost: 0 },
    consumed: { externalOperations: 0, modelTokens: 0, wallTimeSeconds: 0, cost: 0 },
    reservations: [],
  });
  const graphBase = {
    id: "graph-compiled-head",
    schemaVersion: "eigengrid.resolved-skill-graph/v1" as const,
    missionId: mission.id,
    requestedSkillIds: [skillFragment.skillId],
    nodes: [
      {
        skillId: skillFragment.skillId,
        version: skillFragment.version,
        contentDigest: skillFragment.contentDigest,
      },
    ],
    edges: [],
    selectedFragments: [skillFragment],
    resolverVersion: "1.0.0",
    environmentDigest: "c".repeat(64),
    resolvedAt: "2026-08-06T00:01:00.000Z",
  };
  const skillResolution = {
    ...graphBase,
    graphDigest: computeSkillGraphDigest(graphBase),
  };
  const protocolBase = {
    id: "protocol-compiled-head",
    schemaVersion: "eigengrid.scientific-protocol/v1" as const,
    objectiveId: mission.objective.id,
    system: mission.objective.system,
    charge: 0,
    multiplicity: 1,
    method: "B3LYP",
    basis: "def2-SVP",
    physicalModel: "gas_phase_born_oppenheimer",
    engineAgnosticSteps: [
      {
        id: "optimization-compiled-head",
        kind: "optimization" as const,
        reason: "Exercise exact approval through the compiled head binary",
        parameters: {
          execution: {
            software: "orca",
            recipeId: "orca-opt",
            inputEvidenceId: mission.objective.system.evidenceId,
          },
        },
        sourceFragments: [skillFragment],
        riskClass: 3 as const,
      },
    ],
    assumptions: [],
    decisions: ["decision-compiled-head-method"],
    acceptanceCriteria: ["criterion-compiled-head-normal"],
    skillGraphDigest: skillResolution.graphDigest,
    compilerVersion: "1.0.0",
  };
  const protocol = { ...protocolBase, protocolDigest: computeProtocolDigest(protocolBase) };
  const planBase = {
    id: "plan-compiled-head",
    missionId: mission.id,
    version: 1,
    revision: 1,
    status: "under_review" as const,
    normalizedObjective: mission.objective.statement,
    missingInputs: [],
    assumptions: [],
    skillResolution,
    protocol,
    alternatives: [],
    risks: [],
    estimatedCost: { wallTimeSeconds: 1, cpuCoreHours: 0.001, cost: 0 },
    requiredApprovals: [reviewer.role],
    validationGates: ["criterion-compiled-head-normal"],
    limitations: ["Compiled-head deterministic fixture only"],
    createdBy: owner,
    createdAt: "2026-08-06T00:02:00.000Z",
    updatedAt: "2026-08-06T00:02:00.000Z",
  };
  const plan = ScientificPlanSchema.parse({
    ...planBase,
    planDigest: computePlanDigest(planBase),
  });
  const workUnit = WorkUnitSchema.parse({
    id: "work-compiled-head",
    missionId: mission.id,
    planId: plan.id,
    planVersion: plan.version,
    kind: "optimization",
    state: "created",
    reason: "Run the approved compiled-head optimization fixture",
    dependencies: [],
    inputRefs: [mission.objective.system.evidenceId],
    outputContract: {
      requiredEvidenceKinds: ["rendered_input", "operation_receipt", "artifact"],
      requiredObservationKinds: [
        "normal_termination",
        "electronic_convergence",
        "geometry_convergence",
      ],
    },
    skillRefs: [skillFragment],
    protocolFragment: protocol.engineAgnosticSteps[0],
    retryPolicy: { maximumAttempts: 1, ambiguityRequiresReconciliation: true },
    approvalPolicy: { required: true, minimumRole: reviewer.role },
    executionPolicy: { capability: "scientific.optimization.request", riskClass: 3 },
    revision: 1,
    claimOwner: null,
    claimExpiresAt: null,
    jobId: null,
    attemptId: null,
    createdAt: "2026-08-06T00:04:00.000Z",
    updatedAt: "2026-08-06T00:04:00.000Z",
  });

  const database = new SqliteDatabase(join(root, "eigengrid.db"));
  await database.init();
  const store = new ScientificStore(database);
  await store.createMission(mission, budget);
  await store.createEvidence(
    EvidenceReferenceSchema.parse({
      id: mission.objective.system.evidenceId,
      missionId: mission.id,
      kind: "structure",
      uri: inputPath,
      contentDigest: inputDigest,
      sizeBytes: Buffer.byteLength(input),
      mediaType: "chemical/x-orca-input",
      immutable: true,
      createdAt: FIXED_TIME,
    }),
  );
  await store.transitionMission({
    missionId: mission.id,
    expectedRevision: 1,
    to: "scoping",
    reason: "compiled-head scope",
    actor: owner,
    at: "2026-08-06T00:01:00.000Z",
  });
  await store.transitionMission({
    missionId: mission.id,
    expectedRevision: 2,
    to: "planning",
    reason: "compiled-head plan",
    actor: owner,
    at: "2026-08-06T00:02:00.000Z",
  });
  await store.transitionMission({
    missionId: mission.id,
    expectedRevision: 3,
    to: "awaiting_approval",
    reason: "compiled-head approval",
    actor: owner,
    at: "2026-08-06T00:03:00.000Z",
  });
  await store.createPlan(plan);
  await store.createDecision(
    ScientificDecisionSchema.parse({
      id: protocol.decisions[0],
      missionId: mission.id,
      planId: plan.id,
      category: "method",
      question: "Which method may the compiled head execute?",
      selectedOption: protocol.method,
      alternatives: [{ option: "none", reasonNotSelected: "Fixture is exact" }],
      rationale: "The deterministic black-box fixture binds this exact method",
      skillRefs: [skillFragment],
      evidenceRefs: [mission.objective.system.evidenceId],
      confidence: { level: "high", basis: "Deterministic fixture" },
      riskClass: 3,
      requiresApproval: true,
      actor: owner,
      createdAt: "2026-08-06T00:02:00.000Z",
    }),
  );
  const approval = ApprovalRequestSchema.parse({
    id: "approval-compiled-head",
    missionId: mission.id,
    subjectType: "plan",
    subjectId: plan.id,
    subjectVersion: plan.version,
    subjectRevision: plan.revision,
    state: "pending",
    requestedFromRole: reviewer.role,
    payloadDigest: plan.planDigest,
    policyDigest: POLICY_DIGEST,
    editableFields: [],
    requestedBy: owner,
    requestedAt: "2026-08-06T00:03:00.000Z",
  });
  await store.createApprovalRequest(approval);
  await store.respondToApproval(
    approval.id,
    ApprovalResponseSchema.parse({
      id: "approval-response-compiled-head",
      approvalRequestId: approval.id,
      decision: "approved",
      actor: reviewer,
      role: reviewer.role,
      reason: "Approve the exact compiled-head fixture",
      subjectVersion: approval.subjectVersion,
      subjectRevision: approval.subjectRevision,
      payloadDigest: approval.payloadDigest,
      policyDigest: approval.policyDigest,
      decidedAt: "2026-08-06T00:04:00.000Z",
    }),
    {
      now: "2026-08-06T00:04:00.000Z",
      currentPolicyDigest: POLICY_DIGEST,
      authenticatedActor: reviewer,
      authorizedRoles: [reviewer.role],
    },
  );
  await store.createWorkUnits([workUnit]);
  await store.transitionWorkUnit({
    workUnitId: workUnit.id,
    expectedRevision: 1,
    to: "ready",
    at: "2026-08-06T00:04:00.000Z",
  });
  await store.activatePlan({
    missionId: mission.id,
    planId: plan.id,
    expectedMissionRevision: 4,
    actor: owner,
    at: "2026-08-06T00:04:00.000Z",
  });
  await store.transitionMission({
    missionId: mission.id,
    expectedRevision: 5,
    to: "ready",
    reason: "compiled-head ready",
    actor: owner,
    at: "2026-08-06T00:05:00.000Z",
  });
  await database.close();
  return { executableDirectory };
}

async function inspectMission(root: string): Promise<{
  jobs: number;
  processStarts: number;
  operations: Awaited<ReturnType<ScientificStore["getMissionProvenance"]>>["operations"];
}> {
  const database = new SqliteDatabase(join(root, "eigengrid.db"));
  await database.init();
  try {
    const jobs = (await database.listJobs()).length;
    const processStarts = (await database.listEvents()).filter(
      (event) => event.type === "process.started",
    ).length;
    const operations = (
      await new ScientificStore(database).getMissionProvenance("mission-compiled-head")
    ).operations;
    return { jobs, processStarts, operations };
  } finally {
    await database.close();
  }
}

async function persistLegacyApprovalRoleMismatch(root: string): Promise<void> {
  const database = new SqliteDatabase(join(root, "eigengrid.db"));
  await database.init();
  try {
    const store = new ScientificStore(database);
    const current = await store.getWorkUnit("work-compiled-head");
    if (!current) throw new Error("Compiled-head work unit was not seeded");
    const mismatched = WorkUnitSchema.parse({
      ...current,
      approvalPolicy: { required: true, minimumRole: "operator" },
    });
    const transaction = await database.beginTransaction();
    try {
      await transaction.query(
        `UPDATE scientific_work_units SET payload_digest = $1, payload_json = $2
         WHERE id = $3`,
        [digestCanonical(mismatched), canonicalJson(mismatched), mismatched.id],
      );
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  } finally {
    await database.close();
  }
}

function events(output: string): Array<Record<string, unknown>> {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("eigengrid-head compiled lifecycle", () => {
  const roots: string[] = [];
  let buildRoot = "";

  beforeAll(async () => {
    const candidate = process.env.EIGENGRID_TEST_HEAD_BIN;
    if (candidate) {
      COMPILED_HEAD = resolve(candidate);
      await access(COMPILED_HEAD);
      return;
    }
    buildRoot = await mkdtemp(join(tmpdir(), "eigengrid-head-build-"));
    COMPILED_HEAD = join(buildRoot, "eigengrid-head");
    const build = Bun.spawn(
      [process.execPath, "build", "--compile", `--outfile=${COMPILED_HEAD}`, HEAD],
      { cwd: REPOSITORY_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      build.exited,
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
    ]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    await access(COMPILED_HEAD);
  });

  afterAll(async () => {
    if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
  });

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("reports health after initializing the durable store", async () => {
    const root = await mkdtemp(join(tmpdir(), "eigengrid-head-health-"));
    roots.push(root);
    const result = await runHead(root, ["--health", "--owner-id", "head-health-test"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const records = events(result.stdout);
    expect(records.map((entry) => entry.event)).toEqual([
      "scientific_head_health",
      "scientific_head_stopped",
    ]);
    expect(records.every((entry) => typeof entry.timestamp === "string")).toBe(true);
    await access(join(root, "eigengrid.db"));
  });

  test("standby reports not-ready and does not claim an otherwise approved mission", async () => {
    const root = await mkdtemp(join(tmpdir(), "eigengrid-head-standby-"));
    roots.push(root);
    const fixture = await seedExecutableMission(root);
    const result = await runHead(root, ["--dispatch-disabled", "--once"], {
      pathPrefix: fixture.executableDirectory,
    });
    expect(result.exitCode).toBe(0);
    expect(
      events(result.stdout).find((entry) => entry.event === "scientific_head_standby"),
    ).toMatchObject({ readiness: false, dispatchEnabled: false, liveness: true });
    const state = await inspectMission(root);
    expect(state.jobs).toBe(0);
    expect(state.processStarts).toBe(0);
    expect(state.operations).toHaveLength(0);
    const health = await runHead(root, ["--dispatch-disabled", "--health"]);
    expect(health.exitCode, health.stderr).toBe(1);
    expect(health.stderr).toBe("");
    expect(events(health.stdout).map((entry) => entry.event)).toEqual([
      "scientific_head_health",
      "scientific_head_stopped",
    ]);
    expect(events(health.stdout)[0]).toMatchObject({
      status: "not-ready",
      readiness: false,
      dispatchEnabled: false,
    });
  });

  test("production cannot start the legacy local dispatch path", async () => {
    const root = await mkdtemp(join(tmpdir(), "eigengrid-head-prod-guard-"));
    roots.push(root);
    const result = await runHead(root, ["--once"], { deploymentProfile: "production" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Production Slurm dispatch is not yet qualified");
    await expect(access(join(root, "eigengrid.db"))).rejects.toThrow();
  });

  test("rejects trailing garbage in timing controls", async () => {
    const root = await mkdtemp(join(tmpdir(), "eigengrid-head-invalid-time-"));
    roots.push(root);
    const result = await runHead(root, ["--once", "--interval-ms", "1000suffix"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("positive integer");
  });

  test("executes one deterministic empty tick and exits cleanly", async () => {
    const root = await mkdtemp(join(tmpdir(), "eigengrid-head-once-"));
    roots.push(root);
    const result = await runHead(root, [
      "--once",
      "--owner-id",
      "head-once-test",
      "--lease-ms",
      "5000",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const records = events(result.stdout);
    expect(records.map((entry) => entry.event)).toEqual([
      "scientific_head_ready",
      "scientific_head_tick",
      "scientific_head_stopped",
    ]);
    expect(records.every((entry) => typeof entry.timestamp === "string")).toBe(true);
    expect(records[0]).toMatchObject({ policyAuthority: "configured" });
    expect(records[1]?.report).toMatchObject({
      missions: [],
      totals: {
        missions: 0,
        reconciled: 0,
        unresolvedOperations: 0,
        claimsWon: 0,
        claimsLost: 0,
        completedWorkUnits: 0,
        failedWorkUnits: 0,
      },
    });
    const reopened = await runHead(root, ["--health", "--owner-id", "head-reopen-test"]);
    expect(reopened.exitCode).toBe(0);
    expect(events(reopened.stdout).at(-1)?.event).toBe("scientific_head_stopped");
  });

  test("dispatches only the exact approved mission under the current policy", async () => {
    const authorizedRoot = await mkdtemp(join(tmpdir(), "eigengrid-head-authorized-"));
    roots.push(authorizedRoot);
    const authorized = await seedExecutableMission(authorizedRoot);
    const authorizedRun = await runHead(
      authorizedRoot,
      ["--once", "--owner-id", "head-authorized-test", "--lease-ms", "5000"],
      { pathPrefix: authorized.executableDirectory },
    );
    expect(authorizedRun.exitCode, authorizedRun.stderr).toBe(0);
    expect(authorizedRun.stderr).toBe("");
    const authorizedTick = events(authorizedRun.stdout).find(
      (event) => event.event === "scientific_head_tick",
    );
    expect(authorizedTick?.report).toMatchObject({
      totals: { claimsWon: 1, claimsLost: 0, failedWorkUnits: 0 },
    });
    const authorizedState = await inspectMission(authorizedRoot);
    expect(authorizedState.jobs).toBe(1);
    expect(authorizedState.processStarts).toBe(1);
    expect(authorizedState.operations).toHaveLength(1);
    expect(authorizedState.operations[0]).toMatchObject({
      state: "acknowledged",
      policyDigest: POLICY_DIGEST,
    });

    for (const scenario of [
      { name: "stale", policyDigest: "f".repeat(64), roleMismatch: false },
      { name: "missing", policyDigest: null, roleMismatch: false },
      { name: "role-mismatch", policyDigest: POLICY_DIGEST, roleMismatch: true },
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), `eigengrid-head-${scenario.name}-`));
      roots.push(root);
      const seeded = await seedExecutableMission(root);
      if (scenario.roleMismatch) await persistLegacyApprovalRoleMismatch(root);
      const run = await runHead(
        root,
        ["--once", "--owner-id", `head-${scenario.name}-test`, "--lease-ms", "5000"],
        { policyDigest: scenario.policyDigest, pathPrefix: seeded.executableDirectory },
      );
      expect(run.exitCode, run.stderr).toBe(0);
      expect(run.stderr).toBe("");
      const tick = events(run.stdout).find((event) => event.event === "scientific_head_tick");
      expect(tick?.report).toMatchObject({
        totals: { claimsWon: 0, claimsLost: 1, failedWorkUnits: 0 },
      });
      const state = await inspectMission(root);
      expect(state.jobs, scenario.name).toBe(0);
      expect(state.processStarts, scenario.name).toBe(0);
      expect(state.operations, scenario.name).toEqual([]);
    }
  });
});
