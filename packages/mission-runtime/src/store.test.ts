import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDatabase } from "@eigengrid/db";
import {
  ApprovalRequestSchema,
  ApprovalResponseSchema,
  EvidenceReferenceSchema,
  ExternalOperationSchema,
  MissionBudgetSchema,
  ModelInvocationIntentSchema,
  OperationReceiptSchema,
  ScientificAssessmentSchema,
  ScientificDecisionSchema,
  ScientificMissionSchema,
  ScientificObservationSchema,
  ScientificPlanSchema,
  SchemaVersion,
  ValidationResultSchema,
  WorkUnitSchema,
  digestCanonical,
} from "@eigengrid/scientific-schema";
import {
  ScientificApprovalExpiredError,
  ScientificApprovalMissingDecisionError,
  ScientificApprovalModifiedError,
  ScientificApprovalPolicyMismatchError,
  ScientificApprovalStaleError,
  ScientificApprovalUnauthorizedError,
  ScientificEntityConflictError,
  ScientificIllegalTransitionError,
  ScientificIntegrityError,
  ScientificReconciliationRequiredError,
  ScientificRevisionConflictError,
  ScientificStore,
  computePlanDigest,
  computeProtocolDigest,
  computeSkillGraphDigest,
} from "./index";

const T0 = "2026-08-06T00:00:00.000Z";
const T1 = "2026-08-06T00:01:00.000Z";
const T2 = "2026-08-06T00:02:00.000Z";
const T3 = "2026-08-06T00:03:00.000Z";
const T4 = "2026-08-06T00:04:00.000Z";
const T5 = "2026-08-06T00:05:00.000Z";
const T6 = "2026-08-06T00:06:00.000Z";
const T7 = "2026-08-06T00:07:00.000Z";
const T8 = "2026-08-06T00:08:00.000Z";
const T9 = "2026-08-06T00:09:00.000Z";
const D = (character: string): string => character.repeat(64);
const policyDigest = D("e");
const owner = { id: "head-1", kind: "service" as const, role: "mission_owner" };
const reviewer = { id: "chemist-1", kind: "human" as const, role: "scientific_reviewer" };

function approvalContext(now: string, currentPolicyDigest = policyDigest) {
  return {
    now,
    currentPolicyDigest,
    authenticatedActor: reviewer,
    authorizedRoles: [reviewer.role],
  };
}

function missionFixture() {
  return ScientificMissionSchema.parse({
    schemaVersion: SchemaVersion,
    id: "mission-1",
    revision: 1,
    state: "created",
    objective: {
      schemaVersion: SchemaVersion,
      id: "objective-1",
      statement: "Optimize water and establish that the fixture is a minimum",
      system: {
        evidenceId: "evidence-objective",
        format: "xyz",
        contentDigest: D("a"),
        atomCount: 3,
        charge: 0,
        multiplicity: 1,
      },
      targetProperties: ["minimum geometry"],
      requiredConfidence: "screening",
    },
    constraints: {
      allowedEngines: ["fixture"],
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
        id: "criterion-normal",
        kind: "normal_termination",
        description: "The deterministic fixture terminates normally",
        required: true,
      },
    ],
    activePlanId: null,
    budgetId: "budget-1",
    policyProfile: "bounded-local",
    requestedBy: reviewer,
    createdAt: T0,
    updatedAt: T0,
  });
}

function budgetFixture() {
  return MissionBudgetSchema.parse({
    id: "budget-1",
    missionId: "mission-1",
    revision: 1,
    limits: { externalOperations: 3, modelTokens: 1000, wallTimeSeconds: 60, cost: 0 },
    consumed: { externalOperations: 0, modelTokens: 0, wallTimeSeconds: 0, cost: 0 },
    reservations: [],
  });
}

const fragment = {
  skillId: "methods.fixture",
  version: "1.0.0",
  contentDigest: D("b"),
  fragmentId: "fixture.optimize",
  fragmentDigest: D("c"),
  relativePath: "skills/methods.fixture/fragments/optimize.md",
  selector: "optimization",
};

function planFixture(
  options: {
    decisionIds?: string[];
    id?: string;
    version?: number;
    requiredApprovals?: string[];
  } = {},
) {
  const planId = options.id ?? "plan-1";
  const version = options.version ?? 1;
  const graphBase = {
    id: `graph-${version}`,
    schemaVersion: "eigengrid.resolved-skill-graph/v1" as const,
    missionId: "mission-1",
    requestedSkillIds: ["methods.fixture"],
    nodes: [
      {
        skillId: fragment.skillId,
        version: fragment.version,
        contentDigest: fragment.contentDigest,
      },
    ],
    edges: [],
    selectedFragments: [fragment],
    resolverVersion: "1.0.0",
    environmentDigest: D("d"),
    resolvedAt: T1,
  };
  const skillResolution = { ...graphBase, graphDigest: computeSkillGraphDigest(graphBase) };
  const protocolBase = {
    id: `protocol-${version}`,
    schemaVersion: "eigengrid.scientific-protocol/v1" as const,
    objectiveId: "objective-1",
    system: missionFixture().objective.system,
    charge: 0,
    multiplicity: 1,
    method: "fixture-method",
    basis: "fixture-basis",
    physicalModel: "gas-phase",
    engineAgnosticSteps: [
      {
        id: "optimization",
        kind: "optimization" as const,
        reason: "Optimize the fixture geometry",
        parameters: { convergence: "tight" },
        sourceFragments: [fragment],
        riskClass: 1 as const,
      },
    ],
    assumptions: [],
    decisions: options.decisionIds ?? ["decision-1"],
    acceptanceCriteria: ["criterion-normal"],
    skillGraphDigest: skillResolution.graphDigest,
    compilerVersion: "1.0.0",
  };
  const protocol = { ...protocolBase, protocolDigest: computeProtocolDigest(protocolBase) };
  const planBase = {
    id: planId,
    missionId: "mission-1",
    version,
    revision: 1,
    status: "under_review" as const,
    normalizedObjective: "Optimize water and verify normal termination",
    missingInputs: [],
    assumptions: [],
    skillResolution,
    protocol,
    alternatives: [],
    risks: [],
    estimatedCost: { wallTimeSeconds: 1, cpuCoreHours: 0.001, cost: 0 },
    requiredApprovals: options.requiredApprovals ?? ["scientific_reviewer"],
    validationGates: ["criterion-normal"],
    limitations: ["Deterministic fixture evidence only"],
    createdBy: owner,
    createdAt: T1,
    updatedAt: T1,
  };
  return ScientificPlanSchema.parse({ ...planBase, planDigest: computePlanDigest(planBase) });
}

function decisionFixture(planId = "plan-1") {
  return ScientificDecisionSchema.parse({
    id: "decision-1",
    missionId: "mission-1",
    planId,
    category: "method",
    question: "Which fixture method preserves the objective?",
    selectedOption: "fixture-method",
    alternatives: [{ option: "other", reasonNotSelected: "Not deterministic" }],
    rationale: "The fixture method is deterministic and does not claim real-engine validity",
    skillRefs: [fragment],
    evidenceRefs: ["evidence-objective"],
    confidence: { level: "high", basis: "Versioned fixture contract" },
    riskClass: 3,
    requiresApproval: true,
    actor: owner,
    createdAt: T2,
  });
}

function approvalFixture(plan = planFixture(), overrides: Record<string, unknown> = {}) {
  return ApprovalRequestSchema.parse({
    id: "approval-1",
    missionId: "mission-1",
    subjectType: "plan",
    subjectId: plan.id,
    subjectVersion: plan.version,
    subjectRevision: plan.revision,
    state: "pending",
    requestedFromRole: "scientific_reviewer",
    payloadDigest: plan.planDigest,
    policyDigest,
    editableFields: [],
    requestedBy: owner,
    requestedAt: T3,
    expiresAt: T9,
    ...overrides,
  });
}

function responseFixture(request = approvalFixture(), overrides: Record<string, unknown> = {}) {
  return ApprovalResponseSchema.parse({
    id: "response-1",
    approvalRequestId: request.id,
    decision: "approved",
    actor: reviewer,
    role: "scientific_reviewer",
    reason: "Exact plan is acceptable for deterministic execution",
    subjectVersion: request.subjectVersion,
    subjectRevision: request.subjectRevision,
    payloadDigest: request.payloadDigest,
    policyDigest: request.policyDigest,
    decidedAt: T4,
    ...overrides,
  });
}

function objectiveEvidence() {
  return EvidenceReferenceSchema.parse({
    id: "evidence-objective",
    missionId: "mission-1",
    kind: "objective",
    uri: "eigengrid://mission-1/objective.xyz",
    contentDigest: D("a"),
    sizeBytes: 32,
    mediaType: "chemical/x-xyz",
    immutable: true,
    createdAt: T0,
  });
}

function workUnitFixture() {
  const plan = planFixture();
  return WorkUnitSchema.parse({
    id: "work-1",
    missionId: "mission-1",
    planId: plan.id,
    planVersion: plan.version,
    kind: "optimization",
    state: "created",
    reason: "Run deterministic optimization fixture",
    dependencies: [],
    inputRefs: ["evidence-objective"],
    outputContract: {
      requiredEvidenceKinds: ["artifact"],
      requiredObservationKinds: ["normal_termination"],
    },
    skillRefs: [fragment],
    protocolFragment: plan.protocol.engineAgnosticSteps[0],
    retryPolicy: { maximumAttempts: 1, ambiguityRequiresReconciliation: true },
    approvalPolicy: { required: true, minimumRole: "scientific_reviewer" },
    executionPolicy: { capability: "fixture.execute", riskClass: 1 },
    revision: 1,
    claimOwner: null,
    claimExpiresAt: null,
    jobId: null,
    attemptId: null,
    createdAt: T4,
    updatedAt: T4,
  });
}

describe("ScientificStore durable SQLite kernel", () => {
  let directory: string;
  let path: string;
  let database: SqliteDatabase;
  let store: ScientificStore;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "eigengrid-scientific-store-"));
    path = join(directory, "state.sqlite");
    database = new SqliteDatabase(path);
    await database.init();
    store = new ScientificStore(database);
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  async function createAwaitingPlan(
    options: { persistDecision?: boolean; requiredApprovals?: string[] } = {},
  ) {
    const mission = missionFixture();
    await store.createMission(mission, budgetFixture());
    await store.createEvidence(objectiveEvidence());
    await store.transitionMission({
      missionId: mission.id,
      expectedRevision: 1,
      to: "scoping",
      reason: "scope",
      actor: owner,
      at: T1,
    });
    await store.transitionMission({
      missionId: mission.id,
      expectedRevision: 2,
      to: "planning",
      reason: "plan",
      actor: owner,
      at: T2,
    });
    await store.transitionMission({
      missionId: mission.id,
      expectedRevision: 3,
      to: "awaiting_approval",
      reason: "review",
      actor: owner,
      at: T3,
    });
    const plan = planFixture({ requiredApprovals: options.requiredApprovals });
    await store.createPlan(plan);
    if (options.persistDecision !== false) await store.createDecision(decisionFixture());
    return { mission, plan };
  }

  test("is idempotent, revision-safe, transition-safe, and restart-safe", async () => {
    const mission = missionFixture();
    await store.createMission(mission, budgetFixture());
    await store.createMission(mission, budgetFixture());
    await expect(
      store.createMission({ ...mission, policyProfile: "changed" }, budgetFixture()),
    ).rejects.toBeInstanceOf(ScientificEntityConflictError);

    const scoping = await store.transitionMission({
      missionId: mission.id,
      expectedRevision: 1,
      to: "scoping",
      reason: "objective accepted",
      actor: owner,
      at: T1,
    });
    expect(scoping.revision).toBe(2);
    await expect(
      store.transitionMission({
        missionId: mission.id,
        expectedRevision: 1,
        to: "planning",
        reason: "stale",
        actor: owner,
        at: T2,
      }),
    ).rejects.toBeInstanceOf(ScientificRevisionConflictError);
    await expect(
      store.transitionMission({
        missionId: mission.id,
        expectedRevision: 2,
        to: "completed",
        reason: "skip",
        actor: owner,
        at: T2,
      }),
    ).rejects.toBeInstanceOf(ScientificIllegalTransitionError);

    const restartedDb = new SqliteDatabase(path);
    await restartedDb.init();
    const restartedStore = new ScientificStore(restartedDb);
    expect((await restartedStore.getMission(mission.id))?.state).toBe("scoping");
    expect((await restartedStore.getMissionProvenance(mission.id)).transitions).toHaveLength(2);
  });

  test("provenance reads never overlap queries on one transaction connection", async () => {
    await store.createMission(missionFixture(), budgetFixture());
    let overlap = false;
    const serialOnlyStore = new ScientificStore({
      _provider: "sqlite",
      beginTransaction: async () => {
        const tx = await database.beginTransaction();
        let active = false;
        return {
          query: tx.query.bind(tx),
          commit: tx.commit.bind(tx),
          rollback: tx.rollback.bind(tx),
          queryRows: async <T extends Record<string, unknown>>(
            sql: string,
            params?: Record<string, unknown> | unknown[],
          ): Promise<T[]> => {
            if (active) {
              overlap = true;
              throw new Error("Concurrent query on one connection");
            }
            active = true;
            try {
              await Promise.resolve();
              return await tx.queryRows!<T>(sql, params);
            } finally {
              active = false;
            }
          },
        };
      },
    });
    expect((await serialOnlyStore.getMissionProvenance("mission-1")).mission.id).toBe("mission-1");
    expect(overlap).toBe(false);
  });

  test("rolls back a partially invalid work-unit batch", async () => {
    await createAwaitingPlan();
    const valid = workUnitFixture();
    const invalid = WorkUnitSchema.parse({
      ...valid,
      id: "work-2",
      dependencies: ["missing-work"],
    });
    await expect(store.createWorkUnits([valid, invalid])).rejects.toThrow();
    expect(await store.getWorkUnit(valid.id)).toBeNull();
  });

  for (const requiredApprovals of [[], ["scientific_reviewer", "safety_reviewer"]]) {
    test(`rejects plan creation when approval roles are ${JSON.stringify(requiredApprovals)}`, async () => {
      await expect(createAwaitingPlan({ requiredApprovals })).rejects.toBeInstanceOf(
        ScientificIntegrityError,
      );
      expect(await store.getPlan("plan-1")).toBeNull();
    });
  }

  test("rejects approval-role and work-unit minimum-role mismatches", async () => {
    const { plan } = await createAwaitingPlan();
    await expect(
      store.createApprovalRequest(approvalFixture(plan, { requestedFromRole: "operator" })),
    ).rejects.toBeInstanceOf(ScientificIntegrityError);

    const request = approvalFixture(plan);
    await store.createApprovalRequest(request);
    await store.respondToApproval(request.id, responseFixture(request), approvalContext(T4));
    const invalidWorkUnit = WorkUnitSchema.parse({
      ...workUnitFixture(),
      approvalPolicy: { required: true, minimumRole: "operator" },
    });
    await expect(store.createWorkUnits([invalidWorkUnit])).rejects.toBeInstanceOf(
      ScientificIntegrityError,
    );
    expect(await store.getWorkUnit(invalidWorkUnit.id)).toBeNull();
  });

  test("exact approval fails closed for stale, modified, unauthorized, policy, expiry, and missing decisions", async () => {
    const { plan } = await createAwaitingPlan();
    const request = approvalFixture(plan);
    await store.createApprovalRequest(request);

    await expect(
      store.transitionPlan({
        planId: plan.id,
        expectedRevision: plan.revision,
        from: "under_review",
        to: "approved",
        at: T4,
      }),
    ).rejects.toBeInstanceOf(ScientificIntegrityError);

    await expect(
      store.respondToApproval(
        request.id,
        responseFixture(request, { subjectRevision: 2 }),
        approvalContext(T4),
      ),
    ).rejects.toBeInstanceOf(ScientificApprovalStaleError);
    await expect(
      store.respondToApproval(
        request.id,
        responseFixture(request, { payloadDigest: D("f") }),
        approvalContext(T4),
      ),
    ).rejects.toBeInstanceOf(ScientificApprovalModifiedError);
    await expect(
      store.respondToApproval(
        request.id,
        responseFixture(request, {
          actor: { id: "model-1", kind: "model", role: "scientific_reviewer" },
        }),
        approvalContext(T4),
      ),
    ).rejects.toBeInstanceOf(ScientificApprovalUnauthorizedError);
    await expect(
      store.respondToApproval(request.id, responseFixture(request), {
        ...approvalContext(T4),
        authenticatedActor: {
          id: "impostor-1",
          kind: "human",
          role: "scientific_reviewer",
        },
      }),
    ).rejects.toBeInstanceOf(ScientificApprovalUnauthorizedError);
    await expect(
      store.respondToApproval(request.id, responseFixture(request), approvalContext(T4, D("0"))),
    ).rejects.toBeInstanceOf(ScientificApprovalPolicyMismatchError);

    const approved = await store.respondToApproval(
      request.id,
      responseFixture(request),
      approvalContext(T4),
    );
    expect(approved.state).toBe("approved");
    expect((await store.getPlan(plan.id))?.status).toBe("approved");

    await store.activatePlan({
      missionId: "mission-1",
      planId: plan.id,
      expectedMissionRevision: 4,
      actor: owner,
      at: T4,
    });
    await store.transitionMission({
      missionId: "mission-1",
      expectedRevision: 5,
      to: "ready",
      reason: "approved exact plan",
      actor: owner,
      at: T5,
    });
    expect((await store.assertApprovalValid(request.id, approvalContext(T5))).state).toBe(
      "approved",
    );
    const transaction = await database.beginTransaction();
    const modified = { ...plan, normalizedObjective: "Silently changed objective" };
    await transaction.query("UPDATE scientific_plans SET payload_json = $1 WHERE id = $2", [
      JSON.stringify(modified),
      plan.id,
    ]);
    await transaction.commit();
    await expect(store.assertApprovalValid(request.id, approvalContext(T5))).rejects.toBeInstanceOf(
      ScientificApprovalModifiedError,
    );

    const otherDir = mkdtempSync(join(tmpdir(), "eigengrid-approval-negative-"));
    try {
      const otherDb = new SqliteDatabase(join(otherDir, "state.sqlite"));
      await otherDb.init();
      const other = new ScientificStore(otherDb);
      const originalStore = store;
      store = other;
      const missing = await createAwaitingPlan({ persistDecision: false });
      const missingRequest = approvalFixture(missing.plan);
      await store.createApprovalRequest(missingRequest);
      await expect(
        store.respondToApproval(
          missingRequest.id,
          responseFixture(missingRequest),
          approvalContext(T4),
        ),
      ).rejects.toBeInstanceOf(ScientificApprovalMissingDecisionError);
      store = originalStore;
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }

    const expiredDir = mkdtempSync(join(tmpdir(), "eigengrid-approval-expired-"));
    try {
      const expiredDb = new SqliteDatabase(join(expiredDir, "state.sqlite"));
      await expiredDb.init();
      const expiredStore = new ScientificStore(expiredDb);
      const originalStore = store;
      store = expiredStore;
      const expiredSetup = await createAwaitingPlan();
      const expiredRequest = approvalFixture(expiredSetup.plan, { expiresAt: T4 });
      await store.createApprovalRequest(expiredRequest);
      await expect(
        store.respondToApproval(
          expiredRequest.id,
          responseFixture(expiredRequest),
          approvalContext(T5),
        ),
      ).rejects.toBeInstanceOf(ScientificApprovalExpiredError);
      expect((await store.getMissionProvenance("mission-1")).approvals[0]?.state).toBe("expired");
      store = originalStore;
    } finally {
      rmSync(expiredDir, { recursive: true, force: true });
    }
  });

  test("grants one leased claim winner under concurrent duplicate requests", async () => {
    const { plan } = await createAwaitingPlan();
    const request = approvalFixture(plan);
    await store.createApprovalRequest(request);
    await store.respondToApproval(request.id, responseFixture(request), approvalContext(T4));
    await store.createWorkUnits([workUnitFixture()]);
    await store.transitionWorkUnit({
      workUnitId: "work-1",
      expectedRevision: 1,
      to: "ready",
      at: T4,
    });
    await store.activatePlan({
      missionId: "mission-1",
      planId: plan.id,
      expectedMissionRevision: 4,
      actor: owner,
      at: T4,
    });
    await store.transitionMission({
      missionId: "mission-1",
      expectedRevision: 5,
      to: "ready",
      reason: "approved",
      actor: owner,
      at: T5,
    });

    const results = await Promise.all([
      store.claimWorkUnit({
        workUnitId: "work-1",
        ownerId: "head-a",
        now: T5,
        expiresAt: T8,
        policyDigest,
      }),
      store.claimWorkUnit({
        workUnitId: "work-1",
        ownerId: "head-b",
        now: T5,
        expiresAt: T8,
        policyDigest,
      }),
    ]);
    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    expect(results.filter((result) => !result.claimed)).toHaveLength(1);
    const provenance = await store.getMissionProvenance("mission-1");
    expect(provenance.workUnitClaims.filter((claim) => claim.active)).toHaveLength(1);
  });

  test("persists intent before effect, explicit ambiguity, reconciliation, receipts, and full provenance", async () => {
    const { plan } = await createAwaitingPlan();
    const request = approvalFixture(plan);
    await store.createApprovalRequest(request);
    await store.respondToApproval(request.id, responseFixture(request), approvalContext(T4));
    await store.createWorkUnits([workUnitFixture()]);
    await store.transitionWorkUnit({
      workUnitId: "work-1",
      expectedRevision: 1,
      to: "ready",
      at: T4,
    });
    await store.activatePlan({
      missionId: "mission-1",
      planId: plan.id,
      expectedMissionRevision: 4,
      actor: owner,
      at: T4,
    });
    await store.transitionMission({
      missionId: "mission-1",
      expectedRevision: 5,
      to: "ready",
      reason: "approved",
      actor: owner,
      at: T5,
    });
    const claim = await store.claimWorkUnit({
      workUnitId: "work-1",
      ownerId: "head-1",
      now: T5,
      expiresAt: T9,
      policyDigest,
    });
    if (!claim.claimed) throw new Error(claim.message);
    await expect(
      store.transitionWorkUnit({
        workUnitId: "work-1",
        expectedRevision: claim.workUnit.revision,
        to: "executing",
        at: T9,
        claimOwner: "head-1",
      }),
    ).rejects.toBeInstanceOf(ScientificReconciliationRequiredError);
    const executing = await store.transitionWorkUnit({
      workUnitId: "work-1",
      expectedRevision: claim.workUnit.revision,
      to: "executing",
      at: T5,
      claimOwner: "head-1",
      jobId: "job-1",
      attemptId: "attempt-1",
    });

    const operation = ExternalOperationSchema.parse({
      id: "operation-1",
      missionId: "mission-1",
      workUnitId: "work-1",
      idempotencyKey: "mission-1/work-1/attempt-1/execute",
      kind: "local_execution",
      state: "intent",
      request: { capability: "fixture.execute", inputEvidence: "evidence-objective" },
      requestDigest: digestCanonical({
        capability: "fixture.execute",
        inputEvidence: "evidence-objective",
      }),
      policyDigest,
      revision: 1,
      createdAt: T5,
      updatedAt: T5,
    });
    const operationContext = { claimOwner: "head-1", now: T5 };
    await expect(
      store.createOperationIntent(operation, { claimOwner: "other-head", now: T5 }),
    ).rejects.toBeInstanceOf(ScientificReconciliationRequiredError);
    await expect(
      store.createOperationIntent(operation, { claimOwner: "head-1", now: T9 }),
    ).rejects.toBeInstanceOf(ScientificReconciliationRequiredError);
    await store.createOperationIntent(operation, operationContext);
    expect(
      (
        await store.createOperationIntent(
          { ...operation, id: "duplicate-request" },
          operationContext,
        )
      ).id,
    ).toBe(operation.id);
    await expect(
      store.createOperationIntent(
        ExternalOperationSchema.parse({
          ...operation,
          id: "conflicting-request",
          request: { capability: "fixture.execute", changed: true },
          requestDigest: digestCanonical({ capability: "fixture.execute", changed: true }),
        }),
        operationContext,
      ),
    ).rejects.toThrow();

    const started = await store.transitionExternalOperation({
      operationId: operation.id,
      expectedRevision: 1,
      to: "effect_started",
      at: T6,
    });
    const ambiguous = await store.transitionExternalOperation({
      operationId: operation.id,
      expectedRevision: started.revision,
      to: "ambiguous",
      at: T6,
    });
    expect((await store.listOperationsForReconciliation("mission-1"))[0]?.state).toBe("ambiguous");
    const acknowledged = await store.reconcileAmbiguousOperation({
      operationId: operation.id,
      expectedRevision: ambiguous.revision,
      resolution: "acknowledged",
      at: T7,
      externalIdentity: { pid: 100, startToken: "fixture-1" },
    });
    const receipt = OperationReceiptSchema.parse({
      id: "receipt-1",
      operationId: operation.id,
      requestDigest: operation.requestDigest,
      status: "confirmed",
      externalIdentity: { pid: 100, startToken: "fixture-1" },
      jobId: "job-1",
      attemptId: "attempt-1",
      detailDigest: D("9"),
      recordedAt: T7,
    });
    const finalized = await store.finalizeOperationReceipt(
      operation.id,
      acknowledged.revision,
      receipt,
    );
    expect(finalized.operation.state).toBe("confirmed");
    expect(
      (await store.finalizeOperationReceipt(operation.id, finalized.operation.revision, receipt))
        .receipt.id,
    ).toBe(receipt.id);

    const artifact = EvidenceReferenceSchema.parse({
      id: "evidence-artifact",
      missionId: "mission-1",
      workUnitId: "work-1",
      kind: "artifact",
      uri: "eigengrid://mission-1/output.log",
      contentDigest: D("8"),
      immutable: true,
      sourceId: receipt.id,
      createdAt: T7,
    });
    await store.createEvidence(artifact);
    const observation = ScientificObservationSchema.parse({
      id: "observation-normal",
      missionId: "mission-1",
      workUnitId: "work-1",
      type: "normal_termination",
      payload: { normalTermination: true },
      source: { kind: "parser", id: "fixture-parser@1.0.0" },
      evidenceRefs: [artifact.id],
      qualityFlags: ["fixture"],
      observedAt: T7,
    });
    await store.createObservation(observation);
    const validation = ValidationResultSchema.parse({
      id: "validation-normal",
      missionId: "mission-1",
      workUnitId: "work-1",
      criterionId: "criterion-normal",
      status: "passed",
      summary: "Fixture terminated normally",
      observationRefs: [observation.id],
      evidenceRefs: [artifact.id],
      validatorVersion: "1.0.0",
      createdAt: T8,
    });
    await store.createValidationResult(validation);
    const observing = await store.transitionWorkUnit({
      workUnitId: "work-1",
      expectedRevision: executing.revision,
      to: "observing",
      at: T7,
      claimOwner: "head-1",
    });
    await store.transitionWorkUnit({
      workUnitId: "work-1",
      expectedRevision: observing.revision,
      to: "succeeded",
      at: T8,
      claimOwner: "head-1",
    });
    const assessment = ScientificAssessmentSchema.parse({
      id: "assessment-1",
      missionId: "mission-1",
      revision: 1,
      status: "supported",
      claims: [
        { statement: "The deterministic fixture terminated normally", support: "supported" },
      ],
      uncertainty: { level: "high", sources: ["No real chemistry engine was run"] },
      limitations: ["Fixture evidence is not scientific validation"],
      unresolvedQuestions: [],
      decisionRefs: ["decision-1"],
      evidenceRefs: [artifact.id],
      validationRefs: [validation.id],
      skillRefs: [fragment],
      protocolVersion: "1.0.0",
      parserVersion: "1.0.0",
      fixtureEvidence: true,
      generatedBy: owner,
      createdAt: T8,
    });
    await store.createAssessment(assessment);

    const provenance = await store.getMissionProvenance("mission-1");
    expect(provenance.operations).toHaveLength(1);
    expect(provenance.receipts).toHaveLength(1);
    expect(provenance.assessments).toHaveLength(1);
    expect(provenance.missingReferences).toEqual([]);
    expect(provenance.complete).toBe(true);
  });

  test("persists model intent before provider effect and refuses ambiguous replay", async () => {
    const mission = missionFixture();
    await store.createMission(mission, budgetFixture());
    const intent = ModelInvocationIntentSchema.parse({
      id: "model-intent-1",
      idempotencyKey: "model-request-1",
      missionId: mission.id,
      role: "planner",
      provider: "fixture-provider@1.0.0",
      model: "fixture-model@1",
      capabilityDigest: D("1"),
      requestDigest: D("2"),
      contextDigest: D("3"),
      budget: {
        maximumCalls: 1,
        maximumInputTokens: 100,
        maximumOutputTokens: 100,
        maximumTotalTokens: 100,
        maximumCost: 0,
      },
      budgetReservationIds: {
        modelTokens: "model-reservation-1-tokens",
        cost: "model-reservation-1-cost",
      },
      timeoutMilliseconds: 1_000,
      maximumRepairAttempts: 0,
      status: "invoking",
      createdAt: T1,
      updatedAt: T1,
    });
    const admitted = await store.beginModelInvocation(intent);
    expect(admitted.admitted).toBe(true);
    const duplicate = await store.beginModelInvocation(intent);
    expect(duplicate.admitted).toBe(false);
    expect(duplicate.reason).toBe("already_in_flight");

    const observed = await store.observeModelInvocation({
      intentId: intent.id,
      status: "ambiguous",
      observedAt: T2,
      errorCode: "MODEL_TIMEOUT",
    });
    expect(observed.status).toBe("ambiguous");
    const replay = await store.beginModelInvocation(intent);
    expect(replay.admitted).toBe(false);
    expect(replay.reason).toBe("already_ambiguous");

    const provenance = await store.getMissionProvenance(mission.id);
    expect(provenance.modelInvocationIntents[0]?.status).toBe("ambiguous");
    expect(provenance.budgetReservations.filter((item) => item.state === "ambiguous")).toHaveLength(
      2,
    );
  });

  test("allows exactly one planner for an exact mission revision", async () => {
    const mission = missionFixture();
    await store.createMission(mission, budgetFixture());
    await store.transitionMission({
      missionId: mission.id,
      expectedRevision: 1,
      to: "scoping",
      reason: "scope",
      actor: owner,
      at: T1,
    });
    const planning = await store.transitionMission({
      missionId: mission.id,
      expectedRevision: 2,
      to: "planning",
      reason: "plan",
      actor: owner,
      at: T2,
    });
    const results = await Promise.all([
      store.acquirePlanningClaim({
        missionId: mission.id,
        expectedMissionRevision: planning.revision,
        proposedNextVersion: 1,
        ownerId: "planner-a",
        now: T3,
        expiresAt: T5,
      }),
      store.acquirePlanningClaim({
        missionId: mission.id,
        expectedMissionRevision: planning.revision,
        proposedNextVersion: 1,
        ownerId: "planner-b",
        now: T3,
        expiresAt: T5,
      }),
    ]);
    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    expect(results.filter((result) => !result.claimed)[0]?.reason).toBe("active");
  });
});
