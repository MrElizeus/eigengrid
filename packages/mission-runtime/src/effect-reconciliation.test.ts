import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresDatabase, SqliteDatabase } from "@eigengrid/db";
import {
  ApprovalRequestSchema,
  ApprovalResponseSchema,
  BiomolecularDecisionSchemaVersion,
  EvidenceReferenceSchema,
  BiomolecularSystemBuildRequestSchemaVersion,
  BiomolecularSystemBuildRequestSchemaVersionV1,
  ForceFieldStackPublicationRequestSchemaVersion,
  ExternalOperationSchema,
  MissionBudgetSchema,
  OperationReceiptSchema,
  ScientificDecisionSchema,
  ScientificMissionSchema,
  ScientificPlanSchema,
  SchemaVersion,
  WorkUnitSchema,
  canonicalJson,
  computeBiomolecularDecisionDigest,
  digestCanonical,
} from "@eigengrid/scientific-schema";
import {
  RestartSafeScientificMissionHeadStore,
  ScientificEffectReconciliationStore,
  ScientificApprovalIncompatibleStateError,
  MdProjectionStore,
  ScientificStore,
  computePlanDigest,
  computeProtocolDigest,
  computeSkillGraphDigest,
  assertApprovedSystemPreparationOperation,
  assertApprovedSystemBuildDecisionReferences,
  assertTypedSystemPreparationIntent,
  type ScientificDatabase,
  type ScientificTransaction,
} from "./index";
import { ContentAddressedArtifactStore } from "./content-addressed-store";
import {
  canRunPostgres,
  startEphemeralPostgres,
  type EphemeralPostgresCluster,
} from "../../../tests/ts/helpers/postgres";

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
const owner = { id: "head-recovery", kind: "service" as const, role: "mission_owner" };
const reviewer = {
  id: "chemist-recovery",
  kind: "human" as const,
  role: "scientific_reviewer",
};

const fragment = {
  skillId: "methods.fixture",
  version: "1.0.0",
  contentDigest: D("b"),
  fragmentId: "fixture.optimize",
  fragmentDigest: D("c"),
  relativePath: "skills/methods.fixture/fragments/optimize.md",
  selector: "optimization",
};

function missionFixture() {
  return ScientificMissionSchema.parse({
    schemaVersion: SchemaVersion,
    id: "mission-recovery",
    revision: 1,
    state: "created",
    objective: {
      schemaVersion: SchemaVersion,
      id: "objective-recovery",
      statement: "Run a deterministic optimization and recover its exact effect",
      system: {
        evidenceId: "evidence-recovery-objective",
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
        id: "criterion-recovery-normal",
        kind: "normal_termination",
        description: "The deterministic fixture terminates normally",
        required: true,
      },
    ],
    activePlanId: null,
    budgetId: "budget-recovery",
    policyProfile: "bounded-local",
    requestedBy: reviewer,
    createdAt: T0,
    updatedAt: T0,
  });
}

function budgetFixture() {
  return MissionBudgetSchema.parse({
    id: "budget-recovery",
    missionId: "mission-recovery",
    revision: 1,
    limits: { externalOperations: 3, modelTokens: 1000, wallTimeSeconds: 60, cost: 0 },
    consumed: { externalOperations: 0, modelTokens: 0, wallTimeSeconds: 0, cost: 0 },
    reservations: [],
  });
}

function planFixture() {
  const graphBase = {
    id: "graph-recovery",
    schemaVersion: "eigengrid.resolved-skill-graph/v1" as const,
    missionId: "mission-recovery",
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
    id: "protocol-recovery",
    schemaVersion: "eigengrid.scientific-protocol/v1" as const,
    objectiveId: "objective-recovery",
    system: missionFixture().objective.system,
    charge: 0,
    multiplicity: 1,
    method: "fixture-method",
    basis: "fixture-basis",
    physicalModel: "gas-phase",
    engineAgnosticSteps: [
      {
        id: "optimization-recovery",
        kind: "optimization" as const,
        reason: "Run the deterministic optimization fixture",
        parameters: { convergence: "tight" },
        sourceFragments: [fragment],
        riskClass: 1 as const,
      },
    ],
    assumptions: [],
    decisions: ["decision-recovery"],
    acceptanceCriteria: ["criterion-recovery-normal"],
    skillGraphDigest: skillResolution.graphDigest,
    compilerVersion: "1.0.0",
  };
  const protocol = { ...protocolBase, protocolDigest: computeProtocolDigest(protocolBase) };
  const planBase = {
    id: "plan-recovery",
    missionId: "mission-recovery",
    version: 1,
    revision: 1,
    status: "under_review" as const,
    normalizedObjective: "Run and recover the deterministic optimization",
    missingInputs: [],
    assumptions: [],
    skillResolution,
    protocol,
    alternatives: [],
    risks: [],
    estimatedCost: { wallTimeSeconds: 1, cpuCoreHours: 0.001, cost: 0 },
    requiredApprovals: [reviewer.role],
    validationGates: ["criterion-recovery-normal"],
    limitations: ["Deterministic fixture evidence only"],
    createdBy: owner,
    createdAt: T1,
    updatedAt: T1,
  };
  return ScientificPlanSchema.parse({ ...planBase, planDigest: computePlanDigest(planBase) });
}

function workUnitFixture() {
  const plan = planFixture();
  return WorkUnitSchema.parse({
    id: "work-recovery",
    missionId: "mission-recovery",
    planId: plan.id,
    planVersion: plan.version,
    kind: "optimization",
    state: "created",
    reason: "Run deterministic optimization fixture",
    dependencies: [],
    inputRefs: ["evidence-recovery-objective"],
    outputContract: {
      requiredEvidenceKinds: ["artifact"],
      requiredObservationKinds: ["normal_termination"],
    },
    skillRefs: [fragment],
    protocolFragment: plan.protocol.engineAgnosticSteps[0],
    retryPolicy: { maximumAttempts: 1, ambiguityRequiresReconciliation: true },
    approvalPolicy: { required: true, minimumRole: reviewer.role },
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

function operationRequestFixture() {
  return {
    capability: "fixture.execute",
    missionId: "mission-recovery",
    planId: "plan-recovery",
    planVersion: 1,
    workUnitId: "work-recovery",
    inputEvidenceId: "evidence-recovery-objective",
    inputContentDigest: D("a"),
    intendedJobId: "job-recovery",
    intendedAttemptId: "attempt-recovery",
  };
}

function systemBuildEffectFixture() {
  const base = workUnitFixture();
  const workUnit = WorkUnitSchema.parse({
    ...base,
    id: "work-system-build",
    kind: "scientific_capability",
    inputRefs: ["evidence-system-source", "evidence-force-field-stack"],
    outputContract: {
      requiredEvidenceKinds: ["topology", "coordinates", "atom_map"],
      requiredObservationKinds: ["artifact_integrity", "topology_integrity"],
    },
    protocolFragment: {
      schemaVersion: "eigengrid.scientific-capability-fragment/v1",
      id: "fragment-system-build",
      kind: "scientific_capability",
      capability: {
        id: "biomolecular.build-system",
        version: "1.0.0",
        contractDigest: D("b"),
      },
      reason: "Build one exact system manifest revision",
      parameters: {
        manifestId: "manifest-system-1",
        manifestRevision: 1,
        manifestDigest: D("c"),
        systemBuild: {
          schemaVersion: "eigengrid.biomolecular-system-build-work-unit-binding/v1",
          primaryInputEvidenceId: "evidence-system-source",
          sourceEvidenceRefs: ["evidence-system-source"],
          forceFieldStackEvidenceRef: "evidence-force-field-stack",
          decisionRefs: [
            {
              id: "decision-system-1",
              revision: 1,
              kind: "microstate",
              decisionDigest: D("d"),
              approvalRef: "approval-decision-1",
            },
          ],
          forceFieldStack: { id: "force-field-stack-1", revision: 1, digest: D("e") },
          outputArtifacts: {
            topology: {
              evidenceRef: "topology-evidence",
              mediaType: "application/vnd.amber.prmtop",
            },
            coordinates: {
              evidenceRef: "coordinates-evidence",
              mediaType: "application/vnd.amber.rst7",
            },
            atomMap: {
              evidenceRef: "atom-map-evidence",
              mediaType: "application/vnd.eigengrid.atom-map+json",
            },
          },
        },
      },
      sourceFragments: [fragment],
      riskClass: 3,
    },
    executionPolicy: { capability: "biomolecular.build-system", riskClass: 3 },
  });
  const request = {
    schemaVersion: BiomolecularSystemBuildRequestSchemaVersion,
    missionId: workUnit.missionId,
    planId: workUnit.planId,
    planVersion: workUnit.planVersion,
    intendedJobId: "job-system-build",
    intendedAttemptId: "attempt-system-build",
    inputEvidenceId: "evidence-system-source",
    inputContentDigest: D("a"),
    workUnitId: workUnit.id,
    capability: {
      id: "biomolecular.build-system",
      version: "1.0.0",
      contractDigest: D("b"),
    },
    systemManifest: { id: "manifest-system-1", revision: 1 },
    sourceEvidence: [{ id: "evidence-system-source", contentDigest: D("a") }],
    decisionRefs: [
      {
        id: "decision-system-1",
        revision: 1,
        kind: "microstate",
        decisionDigest: D("d"),
        approvalRef: "approval-decision-1",
      },
    ],
    forceFieldStack: { id: "force-field-stack-1", revision: 1, digest: D("e") },
    outputArtifacts: {
      topology: {
        evidenceRef: "topology-evidence",
        mediaType: "application/vnd.amber.prmtop",
      },
      coordinates: {
        evidenceRef: "coordinates-evidence",
        mediaType: "application/vnd.amber.rst7",
      },
      atomMap: {
        evidenceRef: "atom-map-evidence",
        mediaType: "application/vnd.eigengrid.atom-map+json",
      },
    },
    parametersDigest: digestCanonical(workUnit.protocolFragment.parameters),
    outputContractDigest: digestCanonical(workUnit.outputContract),
  };
  const operation = ExternalOperationSchema.parse({
    id: "operation-system-build",
    missionId: workUnit.missionId,
    workUnitId: workUnit.id,
    idempotencyKey: "system-build/one",
    kind: "system_preparation",
    state: "intent",
    request,
    requestDigest: digestCanonical(request),
    policyDigest,
    revision: 1,
    createdAt: T4,
    updatedAt: T4,
  });
  return { workUnit, operation, request };
}

function forceFieldPublicationEffectFixture() {
  const base = workUnitFixture();
  const binding = {
    schemaVersion: "eigengrid.biomolecular-material-publication-binding/v1",
    subjectKind: "force_field_stack",
    subject: { id: "force-field-stack-1", revision: 1, digest: D("d") },
    sourceEvidenceRefs: ["evidence-force-field-source"],
    artifactEvidenceRef: "evidence-force-field-stack-artifact",
  };
  const workUnit = WorkUnitSchema.parse({
    ...base,
    id: "work-force-field-stack",
    kind: "scientific_capability",
    inputRefs: binding.sourceEvidenceRefs,
    outputContract: {
      requiredEvidenceKinds: ["force_field_stack"],
      requiredObservationKinds: ["artifact_integrity"],
    },
    protocolFragment: {
      schemaVersion: "eigengrid.scientific-capability-fragment/v1",
      id: "fragment-force-field-stack",
      kind: "scientific_capability",
      capability: {
        id: "amber.force-field-stack",
        version: "1.0.0",
        contractDigest: D("b"),
      },
      reason: "Publish one exact Amber force-field stack",
      parameters: binding,
      sourceFragments: [fragment],
      riskClass: 3,
    },
    executionPolicy: { capability: "amber.force-field-stack", riskClass: 3 },
  });
  const request = {
    schemaVersion: ForceFieldStackPublicationRequestSchemaVersion,
    missionId: workUnit.missionId,
    planId: workUnit.planId,
    planVersion: workUnit.planVersion,
    intendedJobId: "job-force-field-stack",
    intendedAttemptId: "attempt-force-field-stack",
    inputEvidenceId: "evidence-force-field-source",
    inputContentDigest: D("a"),
    workUnitId: workUnit.id,
    capability: {
      id: "amber.force-field-stack",
      version: "1.0.0",
      contractDigest: D("b"),
    },
    stack: binding.subject,
    sourceEvidence: [{ id: "evidence-force-field-source", contentDigest: D("a") }],
    outputArtifact: {
      evidenceRef: "evidence-force-field-stack-artifact",
      mediaType: "application/vnd.eigengrid.force-field-stack+json",
    },
    parametersDigest: digestCanonical(binding),
    outputContractDigest: digestCanonical(workUnit.outputContract),
  };
  const operation = ExternalOperationSchema.parse({
    id: "operation-force-field-stack",
    missionId: workUnit.missionId,
    workUnitId: workUnit.id,
    idempotencyKey: "force-field-stack/one",
    kind: "system_preparation",
    state: "intent",
    request,
    requestDigest: digestCanonical(request),
    policyDigest,
    revision: 1,
    createdAt: T4,
    updatedAt: T4,
  });
  return { workUnit, operation };
}

async function seedAwaitingFixture(store: ScientificStore) {
  const mission = missionFixture();
  const plan = planFixture();
  await store.createMission(mission, budgetFixture());
  await store.createEvidence(
    EvidenceReferenceSchema.parse({
      id: mission.objective.system.evidenceId,
      missionId: mission.id,
      kind: "objective",
      uri: "eigengrid://mission-recovery/objective.xyz",
      contentDigest: mission.objective.system.contentDigest,
      immutable: true,
      createdAt: T0,
    }),
  );
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
  await store.createPlan(plan);
  await store.createDecision(
    ScientificDecisionSchema.parse({
      id: "decision-recovery",
      missionId: mission.id,
      planId: plan.id,
      category: "method",
      question: "Which deterministic method is approved?",
      selectedOption: "fixture-method",
      alternatives: [{ option: "other", reasonNotSelected: "Not deterministic" }],
      rationale: "The fixture method exists only for recovery evidence",
      skillRefs: [fragment],
      evidenceRefs: [mission.objective.system.evidenceId],
      confidence: { level: "high", basis: "Versioned fixture contract" },
      riskClass: 3,
      requiresApproval: true,
      actor: owner,
      createdAt: T2,
    }),
  );
  const approval = ApprovalRequestSchema.parse({
    id: "approval-recovery",
    missionId: mission.id,
    subjectType: "plan",
    subjectId: plan.id,
    subjectVersion: plan.version,
    subjectRevision: plan.revision,
    state: "pending",
    requestedFromRole: reviewer.role,
    payloadDigest: plan.planDigest,
    policyDigest,
    editableFields: [],
    requestedBy: owner,
    requestedAt: T3,
    expiresAt: T9,
  });
  await store.createApprovalRequest(approval);
  return { mission, plan, approval };
}

async function seedApprovedFixture(store: ScientificStore): Promise<void> {
  const { mission, plan, approval } = await seedAwaitingFixture(store);
  await store.respondToApproval(
    approval.id,
    ApprovalResponseSchema.parse({
      id: "response-recovery",
      approvalRequestId: approval.id,
      decision: "approved",
      actor: reviewer,
      role: reviewer.role,
      reason: "Approve exact deterministic recovery fixture",
      subjectVersion: approval.subjectVersion,
      subjectRevision: approval.subjectRevision,
      payloadDigest: approval.payloadDigest,
      policyDigest: approval.policyDigest,
      decidedAt: T4,
    }),
    {
      now: T4,
      currentPolicyDigest: policyDigest,
      authenticatedActor: reviewer,
      authorizedRoles: [reviewer.role],
    },
  );
  await store.createWorkUnits([workUnitFixture()]);
  await store.transitionWorkUnit({
    workUnitId: "work-recovery",
    expectedRevision: 1,
    to: "ready",
    at: T4,
  });
  await store.activatePlan({
    missionId: mission.id,
    planId: plan.id,
    expectedMissionRevision: 4,
    actor: owner,
    at: T4,
  });
  await store.transitionMission({
    missionId: mission.id,
    expectedRevision: 5,
    to: "ready",
    reason: "approved",
    actor: owner,
    at: T5,
  });
}

describe("ScientificEffectReconciliationStore", () => {
  let directory: string;
  let database: SqliteDatabase;
  let store: ScientificStore;
  let effects: ScientificEffectReconciliationStore;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "eigengrid-effect-recovery-"));
    database = new SqliteDatabase(join(directory, "state.sqlite"));
    await database.init();
    store = new ScientificStore(database);
    effects = new ScientificEffectReconciliationStore(database);

    await seedApprovedFixture(store);
  });

  afterEach(async () => {
    await database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("admits only the versioned typed system-build request at its effect boundary", () => {
    const { workUnit, operation, request } = systemBuildEffectFixture();
    expect(() => assertTypedSystemPreparationIntent(operation, workUnit)).not.toThrow();

    const {
      missionId: _missionId,
      planId: _planId,
      planVersion: _planVersion,
      intendedJobId: _intendedJobId,
      intendedAttemptId: _intendedAttemptId,
      inputEvidenceId: _inputEvidenceId,
      inputContentDigest: _inputContentDigest,
      ...legacyFields
    } = request;
    const legacyRequest = {
      ...legacyFields,
      schemaVersion: BiomolecularSystemBuildRequestSchemaVersionV1,
    };
    const legacyOperation = ExternalOperationSchema.parse({
      ...operation,
      request: legacyRequest,
      requestDigest: digestCanonical(legacyRequest),
    });
    expect(() => assertTypedSystemPreparationIntent(legacyOperation, workUnit)).toThrow(
      /exact typed WorkUnit/u,
    );

    const mismatchedRequest = { ...request, planVersion: workUnit.planVersion + 1 };
    const mismatchedOperation = ExternalOperationSchema.parse({
      ...operation,
      request: mismatchedRequest,
      requestDigest: digestCanonical(mismatchedRequest),
    });
    expect(() => assertTypedSystemPreparationIntent(mismatchedOperation, workUnit)).toThrow(
      /exact typed WorkUnit/u,
    );

    const changedDecisionRequest = {
      ...request,
      decisionRefs: request.decisionRefs.map((reference) => ({
        ...reference,
        approvalRef: "approval-other-decision",
      })),
    };
    const changedDecisionOperation = ExternalOperationSchema.parse({
      ...operation,
      request: changedDecisionRequest,
      requestDigest: digestCanonical(changedDecisionRequest),
    });
    expect(() => assertTypedSystemPreparationIntent(changedDecisionOperation, workUnit)).toThrow(
      /exact typed WorkUnit/u,
    );

    const changedOutputRequest = {
      ...request,
      outputArtifacts: {
        ...request.outputArtifacts,
        topology: { ...request.outputArtifacts.topology, evidenceRef: "output-other-topology" },
      },
    };
    const changedOutputOperation = ExternalOperationSchema.parse({
      ...operation,
      request: changedOutputRequest,
      requestDigest: digestCanonical(changedOutputRequest),
    });
    expect(() => assertTypedSystemPreparationIntent(changedOutputOperation, workUnit)).toThrow(
      /exact typed WorkUnit/u,
    );

    const missingQcWorkUnit = WorkUnitSchema.parse({
      ...workUnit,
      outputContract: {
        requiredEvidenceKinds: ["topology", "coordinates", "atom_map"],
        requiredObservationKinds: ["artifact_integrity"],
      },
    });
    expect(() => assertTypedSystemPreparationIntent(operation, missingQcWorkUnit)).toThrow(
      /exact typed WorkUnit/u,
    );
  });

  test("system-build decision gate verifies exact approved biomolecular revisions and expiry", async () => {
    const cas = new ContentAddressedArtifactStore(join(directory, "decision-cas"));
    await cas.init();
    try {
      const storedEvidence = await cas.put(Buffer.from("reviewed construct source"));
      const decisionMissionId = "mission-system-build-decision";
      const decisionMission = ScientificMissionSchema.parse({
        ...missionFixture(),
        id: decisionMissionId,
        revision: 1,
        state: "created",
        budgetId: "budget-system-build-decision",
        objective: {
          ...missionFixture().objective,
          id: "objective-system-build-decision",
          system: {
            ...missionFixture().objective.system,
            evidenceId: "evidence-system-build-decision",
            contentDigest: storedEvidence.digest,
          },
        },
      });
      await store.createMission(
        decisionMission,
        MissionBudgetSchema.parse({
          ...budgetFixture(),
          id: "budget-system-build-decision",
          missionId: decisionMissionId,
        }),
      );
      await store.transitionMission({
        missionId: decisionMissionId,
        expectedRevision: 1,
        to: "scoping",
        reason: "Start biomolecular decision approval fixture",
        actor: owner,
        at: T1,
      });
      await store.transitionMission({
        missionId: decisionMissionId,
        expectedRevision: 2,
        to: "planning",
        reason: "Prepare biomolecular decision approval fixture",
        actor: owner,
        at: T2,
      });
      await store.transitionMission({
        missionId: decisionMissionId,
        expectedRevision: 3,
        to: "awaiting_approval",
        reason: "Review biomolecular decision fixture",
        actor: owner,
        at: T3,
      });
      await store.createEvidence(
        EvidenceReferenceSchema.parse({
          id: "evidence-system-build-decision",
          missionId: decisionMissionId,
          kind: "structure",
          uri: storedEvidence.uri,
          contentDigest: storedEvidence.digest,
          immutable: true,
          sourceId: "fixture-review",
          createdAt: T1,
          sizeBytes: storedEvidence.sizeBytes,
        }),
      );
      const mdStore = new MdProjectionStore(database, cas);
      const decisionMaterial = {
        schemaVersion: BiomolecularDecisionSchemaVersion,
        id: "decision-system-build-construct",
        missionId: decisionMissionId,
        revision: 1,
        status: "proposed" as const,
        rationale: "Preserve the observed fixture construct",
        evidenceRefs: ["evidence-system-build-decision"],
        decidedBy: owner,
        decisionDigest: D("0"),
        createdAt: T2,
        kind: "construct" as const,
        sourceStructureDigest: storedEvidence.digest,
        chainPolicies: [{ chainId: "A", action: "preserve" as const, reason: "Observed chain" }],
        mutationPolicies: [],
        missingRegionPolicies: [],
        terminiPolicy: "explicit fixture termini",
        fusionPolicy: "preserve observed fusion",
        disulfidePolicy: "preserve observed bonds",
        outputConstructDigest: storedEvidence.digest,
      };
      const proposedDecision = {
        ...decisionMaterial,
        decisionDigest: computeBiomolecularDecisionDigest(decisionMaterial),
      };
      await mdStore.putBiomolecularDecision(proposedDecision);
      const materialDigest = proposedDecision.decisionDigest;
      const decisionApproval = ApprovalRequestSchema.parse({
        id: "approval-system-build-construct",
        missionId: decisionMissionId,
        subjectType: "decision",
        subjectId: proposedDecision.id,
        subjectVersion: 1,
        subjectRevision: 1,
        state: "pending",
        requestedFromRole: reviewer.role,
        payloadDigest: materialDigest,
        policyDigest,
        editableFields: [],
        requestedBy: owner,
        requestedAt: T3,
        expiresAt: T9,
      });
      await store.createApprovalRequest(decisionApproval);
      await store.respondToApproval(
        decisionApproval.id,
        ApprovalResponseSchema.parse({
          id: "response-system-build-construct",
          approvalRequestId: decisionApproval.id,
          decision: "approved",
          actor: reviewer,
          role: reviewer.role,
          reason: "Approve the exact construct decision",
          subjectVersion: 1,
          subjectRevision: 1,
          payloadDigest: materialDigest,
          policyDigest,
          decidedAt: T4,
        }),
        {
          now: T4,
          currentPolicyDigest: policyDigest,
          authenticatedActor: reviewer,
          authorizedRoles: [reviewer.role],
        },
      );
      const approved = await mdStore.getBiomolecularDecision(proposedDecision.id, 1);
      if (!approved) throw new Error("Expected the approved decision revision");
      const reference = {
        id: approved.id,
        revision: approved.revision,
        kind: approved.kind,
        decisionDigest: approved.decisionDigest,
        approvalRef: approved.approvalRef!,
      };

      const transaction = (await database.beginTransaction()) as ScientificTransaction;
      try {
        await expect(
          assertApprovedSystemBuildDecisionReferences(
            transaction,
            decisionMissionId,
            [reference],
            T5,
          ),
        ).resolves.toBeUndefined();
        await expect(
          assertApprovedSystemBuildDecisionReferences(
            transaction,
            decisionMissionId,
            [{ ...reference, decisionDigest: D("f") }],
            T5,
          ),
        ).rejects.toThrow(/exact biomolecular decision to be approved/u);
        await expect(
          assertApprovedSystemBuildDecisionReferences(
            transaction,
            decisionMissionId,
            [reference],
            T9,
          ),
        ).rejects.toThrow(/exact biomolecular decision to be approved/u);
      } finally {
        await transaction.rollback();
      }
    } finally {
      await cas.close();
    }
  });

  test("requires a prior exact human approval for each material system-preparation effect", () => {
    const { operation } = systemBuildEffectFixture();
    const response = ApprovalResponseSchema.parse({
      id: "response-system-build-operation",
      approvalRequestId: "approval-system-build-operation",
      decision: "approved",
      actor: reviewer,
      role: reviewer.role,
      reason: "Approve the exact reviewed system-build effect",
      subjectVersion: 1,
      subjectRevision: 1,
      payloadDigest: operation.requestDigest,
      policyDigest,
      decidedAt: T4,
    });
    const approval = ApprovalRequestSchema.parse({
      id: response.approvalRequestId,
      missionId: operation.missionId,
      subjectType: "operation",
      subjectId: operation.id,
      subjectVersion: 1,
      subjectRevision: 1,
      state: "approved",
      requestedFromRole: reviewer.role,
      payloadDigest: operation.requestDigest,
      policyDigest,
      editableFields: [],
      requestedBy: owner,
      requestedAt: T3,
      response,
    });
    const exact = {
      operation,
      approvalValue: approval,
      responseValue: response,
      currentPolicyDigest: policyDigest,
      requiredRole: reviewer.role,
      at: T5,
    };
    expect(() => assertApprovedSystemPreparationOperation(exact)).not.toThrow();
    expect(() =>
      assertApprovedSystemPreparationOperation({
        ...exact,
        approvalValue: { ...approval, payloadDigest: D("f") },
      }),
    ).toThrow(/exact human approval/u);
    expect(() =>
      assertApprovedSystemPreparationOperation({
        ...exact,
        approvalValue: { ...approval, expiresAt: T4 },
      }),
    ).toThrow(/exact human approval/u);
  });

  test("binds force-field publication effects to the exact material WorkUnit", () => {
    const { workUnit, operation } = forceFieldPublicationEffectFixture();
    expect(() => assertTypedSystemPreparationIntent(operation, workUnit)).not.toThrow();
    const changedRequest = {
      ...(operation.request as Record<string, unknown>),
      stack: { id: "force-field-stack-other", revision: 1, digest: D("e") },
    };
    const changedOperation = ExternalOperationSchema.parse({
      ...operation,
      request: changedRequest,
      requestDigest: digestCanonical(changedRequest),
    });
    expect(() => assertTypedSystemPreparationIntent(changedOperation, workUnit)).toThrow(
      /exact typed WorkUnit/u,
    );
  });

  test("atomically starts the effect and settles an expired lease from the exact receipt", async () => {
    const claim = await store.claimWorkUnit({
      workUnitId: "work-recovery",
      ownerId: owner.id,
      now: T5,
      expiresAt: T6,
      policyDigest,
    });
    if (!claim.claimed) throw new Error(claim.message);
    const request = operationRequestFixture();
    const operation = await store.createOperationIntent(
      ExternalOperationSchema.parse({
        id: "operation-recovery",
        missionId: "mission-recovery",
        workUnitId: "work-recovery",
        idempotencyKey: "mission-recovery/work-recovery/execute",
        kind: "local_execution",
        state: "intent",
        request,
        requestDigest: digestCanonical(request),
        policyDigest,
        revision: 1,
        createdAt: T5,
        updatedAt: T5,
      }),
      { claimOwner: owner.id, now: T5 },
    );

    await expect(
      effects.beginWorkUnitEffect({
        operationId: operation.id,
        expectedOperationRevision: operation.revision,
        workUnitId: claim.workUnit.id,
        expectedWorkUnitRevision: claim.workUnit.revision + 1,
        claimOwner: owner.id,
        jobId: "job-recovery",
        attemptId: "attempt-recovery",
        currentPolicyDigest: policyDigest,
        at: T5,
      }),
    ).rejects.toThrow();
    expect((await store.getExternalOperation(operation.id))?.state).toBe("intent");
    expect((await store.getWorkUnit(claim.workUnit.id))?.state).toBe("claimed");

    const begun = await effects.beginWorkUnitEffect({
      operationId: operation.id,
      expectedOperationRevision: operation.revision,
      workUnitId: claim.workUnit.id,
      expectedWorkUnitRevision: claim.workUnit.revision,
      claimOwner: owner.id,
      jobId: "job-recovery",
      attemptId: "attempt-recovery",
      currentPolicyDigest: policyDigest,
      at: T5,
    });
    expect(begun.operation.state).toBe("effect_started");
    expect(begun.workUnit).toMatchObject({
      state: "executing",
      jobId: "job-recovery",
      attemptId: "attempt-recovery",
    });

    const acknowledged = await store.transitionExternalOperation({
      operationId: begun.operation.id,
      expectedRevision: begun.operation.revision,
      to: "acknowledged",
      at: T5,
      externalIdentity: {
        jobId: "job-recovery",
        attemptId: "attempt-recovery",
        status: "running",
      },
    });
    const receipt = OperationReceiptSchema.parse({
      id: "receipt-recovery",
      operationId: operation.id,
      requestDigest: operation.requestDigest,
      status: "confirmed",
      externalIdentity: {
        jobId: "job-recovery",
        attemptId: "attempt-recovery",
        status: "completed",
      },
      jobId: "job-recovery",
      attemptId: "attempt-recovery",
      detailDigest: D("9"),
      recordedAt: T7,
    });
    await store.finalizeOperationReceipt(operation.id, acknowledged.revision, receipt);

    const headStore = new RestartSafeScientificMissionHeadStore(store, database);
    expect((await headStore.listOperationsForReconciliation("mission-recovery"))[0]?.id).toBe(
      operation.id,
    );
    expect(await headStore.listRunnableWorkUnits("mission-recovery", T7)).toEqual([]);

    const settled = await effects.reconcileWorkUnitEffect({
      operationId: operation.id,
      workUnitId: claim.workUnit.id,
      jobId: "job-recovery",
      attemptId: "attempt-recovery",
      outcome: "completed",
      at: T7,
    });
    expect(settled.transitionedThrough).toEqual(["observing"]);
    expect(settled.workUnit.state).toBe("observing");
    expect(settled.workUnit.claimExpiresAt).toBe(T6);

    const repeated = await effects.reconcileWorkUnitEffect({
      operationId: operation.id,
      workUnitId: claim.workUnit.id,
      jobId: "job-recovery",
      attemptId: "attempt-recovery",
      outcome: "completed",
      at: T8,
    });
    expect(repeated.alreadyReconciled).toBe(true);
    expect(repeated.transitionedThrough).toEqual([]);

    await store.transitionWorkUnit({
      workUnitId: claim.workUnit.id,
      expectedRevision: settled.workUnit.revision,
      to: "succeeded",
      at: T8,
      claimOwner: owner.id,
    });
    expect(await headStore.listOperationsForReconciliation("mission-recovery")).toEqual([]);
  });

  test("revalidates current policy and approval atomically when the effect starts", async () => {
    const claim = await store.claimWorkUnit({
      workUnitId: "work-recovery",
      ownerId: owner.id,
      now: T5,
      expiresAt: T8,
      policyDigest,
    });
    if (!claim.claimed) throw new Error(claim.message);
    const request = operationRequestFixture();
    const operation = await store.createOperationIntent(
      ExternalOperationSchema.parse({
        id: "operation-recovery",
        missionId: "mission-recovery",
        workUnitId: "work-recovery",
        idempotencyKey: "mission-recovery/work-recovery/execute",
        kind: "local_execution",
        state: "intent",
        request,
        requestDigest: digestCanonical(request),
        policyDigest: D("f"),
        revision: 1,
        createdAt: T5,
        updatedAt: T5,
      }),
      { claimOwner: owner.id, now: T5 },
    );

    await expect(
      effects.beginWorkUnitEffect({
        operationId: operation.id,
        expectedOperationRevision: operation.revision,
        workUnitId: claim.workUnit.id,
        expectedWorkUnitRevision: claim.workUnit.revision,
        claimOwner: owner.id,
        jobId: "job-recovery",
        attemptId: "attempt-recovery",
        currentPolicyDigest: D("f"),
        at: T6,
      }),
    ).rejects.toThrow("No current exact-revision approval");
    expect((await store.getExternalOperation(operation.id))?.state).toBe("intent");
    expect((await store.getWorkUnit(claim.workUnit.id))?.state).toBe("claimed");

    const begun = await effects.beginWorkUnitEffect({
      operationId: operation.id,
      expectedOperationRevision: operation.revision,
      workUnitId: claim.workUnit.id,
      expectedWorkUnitRevision: claim.workUnit.revision,
      claimOwner: owner.id,
      jobId: "job-recovery",
      attemptId: "attempt-recovery",
      currentPolicyDigest: policyDigest,
      at: T6,
    });
    expect(begun.operation).toMatchObject({
      state: "effect_started",
      policyDigest,
    });
    expect((await store.getOperationIntentOutbox(operation.id))?.intent.policyDigest).toBe(D("f"));
    expect((await store.getEffectAdmission(operation.id))?.policyDigest).toBe(policyDigest);
  });

  test("rejects an approval that expires between claim and effect start", async () => {
    const claim = await store.claimWorkUnit({
      workUnitId: "work-recovery",
      ownerId: owner.id,
      now: T5,
      expiresAt: "2026-08-06T00:10:00.000Z",
      policyDigest,
    });
    if (!claim.claimed) throw new Error(claim.message);
    const request = operationRequestFixture();
    const operation = await store.createOperationIntent(
      ExternalOperationSchema.parse({
        id: "operation-recovery",
        missionId: "mission-recovery",
        workUnitId: "work-recovery",
        idempotencyKey: "mission-recovery/work-recovery/execute",
        kind: "local_execution",
        state: "intent",
        request,
        requestDigest: digestCanonical(request),
        policyDigest,
        revision: 1,
        createdAt: T5,
        updatedAt: T5,
      }),
      { claimOwner: owner.id, now: T5 },
    );

    await expect(
      effects.beginWorkUnitEffect({
        operationId: operation.id,
        expectedOperationRevision: operation.revision,
        workUnitId: claim.workUnit.id,
        expectedWorkUnitRevision: claim.workUnit.revision,
        claimOwner: owner.id,
        jobId: "job-recovery",
        attemptId: "attempt-recovery",
        currentPolicyDigest: policyDigest,
        at: T9,
      }),
    ).rejects.toThrow("expired before effect start");
    expect((await store.getExternalOperation(operation.id))?.state).toBe("intent");
  });

  test("revalidates the single approval role after claim without crossing the effect boundary", async () => {
    const claim = await store.claimWorkUnit({
      workUnitId: "work-recovery",
      ownerId: owner.id,
      now: T5,
      expiresAt: T8,
      policyDigest,
    });
    if (!claim.claimed) throw new Error(claim.message);
    const request = operationRequestFixture();
    const operation = await store.createOperationIntent(
      ExternalOperationSchema.parse({
        id: "operation-recovery",
        missionId: "mission-recovery",
        workUnitId: "work-recovery",
        idempotencyKey: "mission-recovery/work-recovery/execute",
        kind: "local_execution",
        state: "intent",
        request,
        requestDigest: digestCanonical(request),
        policyDigest,
        revision: 1,
        createdAt: T5,
        updatedAt: T5,
      }),
      { claimOwner: owner.id, now: T5 },
    );
    const mismatched = WorkUnitSchema.parse({
      ...claim.workUnit,
      approvalPolicy: { required: true, minimumRole: "operator" },
    });
    const transaction = await database.beginTransaction();
    await transaction.query(
      `UPDATE scientific_work_units SET payload_digest = $1, payload_json = $2
       WHERE id = $3`,
      [digestCanonical(mismatched), JSON.stringify(mismatched), mismatched.id],
    );
    await transaction.commit();

    await expect(
      effects.beginWorkUnitEffect({
        operationId: operation.id,
        expectedOperationRevision: operation.revision,
        workUnitId: mismatched.id,
        expectedWorkUnitRevision: mismatched.revision,
        claimOwner: owner.id,
        jobId: "job-recovery",
        attemptId: "attempt-recovery",
        currentPolicyDigest: policyDigest,
        at: T6,
      }),
    ).rejects.toThrow("single approval role");
    expect((await store.getExternalOperation(operation.id))?.state).toBe("intent");
    expect((await store.getWorkUnit(mismatched.id))?.state).toBe("claimed");
  });

  test("makes an expired pre-effect claim with an intent reclaimable after restart", async () => {
    const claim = await store.claimWorkUnit({
      workUnitId: "work-recovery",
      ownerId: owner.id,
      now: T5,
      expiresAt: T6,
      policyDigest,
    });
    if (!claim.claimed) throw new Error(claim.message);
    const request = operationRequestFixture();
    await store.createOperationIntent(
      ExternalOperationSchema.parse({
        id: "operation-recovery",
        missionId: "mission-recovery",
        workUnitId: "work-recovery",
        idempotencyKey: "mission-recovery/work-recovery/execute",
        kind: "local_execution",
        state: "intent",
        request,
        requestDigest: digestCanonical(request),
        policyDigest,
        revision: 1,
        createdAt: T5,
        updatedAt: T5,
      }),
      { claimOwner: owner.id, now: T5 },
    );

    await database.close();
    database = new SqliteDatabase(join(directory, "state.sqlite"));
    await database.init();
    store = new ScientificStore(database);
    effects = new ScientificEffectReconciliationStore(database);
    const replacementStore = new RestartSafeScientificMissionHeadStore(store, database);
    expect(
      (await replacementStore.listRunnableWorkUnits("mission-recovery", T7)).map(
        (workUnit) => workUnit.id,
      ),
    ).toEqual(["work-recovery"]);
    const replacementClaim = await replacementStore.claimWorkUnit({
      workUnitId: claim.workUnit.id,
      ownerId: "replacement-head",
      now: T7,
      expiresAt: T8,
      policyDigest,
    });
    expect(replacementClaim).toMatchObject({ claimed: true, ownerId: "replacement-head" });
    if (!replacementClaim.claimed) throw new Error(replacementClaim.message);
    const recoveredOperation = await store.getExternalOperation("operation-recovery");
    if (!recoveredOperation) throw new Error("Expected the durable intent after restart");
    expect(recoveredOperation.state).toBe("intent");
    const begun = await effects.beginWorkUnitEffect({
      operationId: recoveredOperation.id,
      expectedOperationRevision: recoveredOperation.revision,
      workUnitId: replacementClaim.workUnit.id,
      expectedWorkUnitRevision: replacementClaim.workUnit.revision,
      claimOwner: "replacement-head",
      jobId: "job-recovery",
      attemptId: "attempt-recovery",
      currentPolicyDigest: policyDigest,
      at: T7,
    });
    expect(begun).toMatchObject({
      operation: { state: "effect_started" },
      workUnit: { state: "executing", claimOwner: "replacement-head" },
    });
  });
});

// Faults target a real transaction; no in-memory database substitutes for either provider.
function faultAtTransactionBoundary(
  database: ScientificDatabase,
  fault: "outbox_insert" | "admission_insert" | "commit_ack",
): ScientificDatabase {
  return {
    _provider: database._provider,
    async beginTransaction() {
      const transaction = await database.beginTransaction();
      return {
        query: async (sql, params) => {
          if (
            (fault === "outbox_insert" &&
              sql.includes("INSERT INTO scientific_operation_outbox")) ||
            (fault === "admission_insert" &&
              sql.includes("INSERT INTO scientific_effect_admissions"))
          ) {
            throw new Error("Injected failure before durable insert");
          }
          return transaction.query(sql, params);
        },
        queryRows: transaction.queryRows?.bind(transaction),
        rollback: () => transaction.rollback(),
        async commit() {
          await transaction.commit();
          if (fault === "commit_ack") throw new Error("Injected loss of committed transaction ACK");
        },
      };
    },
  };
}

async function raceSqliteAdmissions(path: string, begin: unknown): Promise<number[]> {
  // SQLite's synchronous busy handler would block a single JS event loop while
  // its competing transaction needs that same loop to commit. Race real processes.
  const script = `
    import { SqliteDatabase } from "@eigengrid/db";
    import { ScientificEffectReconciliationStore } from "@eigengrid/mission-runtime";
    const database = new SqliteDatabase(${JSON.stringify(path)});
    await database.init();
    process.stdout.write("ready\\n");
    await Bun.stdin.text();
    try {
      await new ScientificEffectReconciliationStore(database).beginWorkUnitEffect(${JSON.stringify(begin)});
      process.exitCode = 0;
    } catch (error) {
      process.stderr.write(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    } finally { await database.close(); }
  `;
  const children = [0, 1].map(() =>
    Bun.spawn([process.execPath, "--eval", script], {
      cwd: join(import.meta.dir, "../../.."),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  try {
    await Promise.all(
      children.map(async (child) => {
        const reader = child.stdout.getReader();
        let text = "";
        try {
          while (!text.includes("\n")) {
            const chunk = await reader.read();
            if (chunk.done)
              throw new Error(
                `SQLite contender exited before ready: ${await new Response(child.stderr).text()}`,
              );
            text += new TextDecoder().decode(chunk.value);
          }
          expect(text).toBe("ready\n");
        } finally {
          reader.releaseLock();
        }
      }),
    );
    for (const child of children) child.stdin.end();
    const exits = await Promise.all(children.map((child) => child.exited));
    const errors = await Promise.all(children.map((child) => new Response(child.stderr).text()));
    expect(
      errors.filter(
        (message) =>
          message.includes("revision conflict") || message.includes("database is locked"),
      ),
    ).toHaveLength(1);
    return exits;
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
    await Promise.all(children.map((child) => child.exited));
  }
}

for (const provider of ["sqlite", "postgres"] as const) {
  describe.skipIf(provider === "postgres" && !canRunPostgres)(
    `${provider} atomic scientific outbox`,
    () => {
      let database: SqliteDatabase | PostgresDatabase;
      let cluster: EphemeralPostgresCluster | undefined;
      let directory: string | undefined;
      let store: ScientificStore;
      let effects: ScientificEffectReconciliationStore;

      function openDatabase() {
        return provider === "postgres"
          ? new PostgresDatabase(cluster!.url, { migrations: "validate" })
          : new SqliteDatabase(join(directory!, "state.sqlite"));
      }

      beforeEach(async () => {
        if (provider === "postgres") {
          cluster = await startEphemeralPostgres();
          database = new PostgresDatabase(cluster.url);
        } else {
          directory = mkdtempSync(join(tmpdir(), "eigengrid-operation-outbox-"));
          database = openDatabase();
        }
        await database.init();
        store = new ScientificStore(database);
        effects = new ScientificEffectReconciliationStore(database);
        await seedApprovedFixture(store);
      });

      afterEach(async () => {
        await database.close();
        await cluster?.cleanup();
        cluster = undefined;
        if (directory) rmSync(directory, { recursive: true, force: true });
        directory = undefined;
      });

      async function prepareIntent() {
        const claim = await store.claimWorkUnit({
          workUnitId: "work-recovery",
          ownerId: owner.id,
          now: T5,
          expiresAt: T8,
          policyDigest,
        });
        if (!claim.claimed) throw new Error(claim.message);
        const request = operationRequestFixture();
        const operation = ExternalOperationSchema.parse({
          id: "operation-recovery",
          missionId: "mission-recovery",
          workUnitId: claim.workUnit.id,
          idempotencyKey: "mission-recovery/work-recovery/execute",
          kind: "local_execution",
          state: "intent",
          request,
          requestDigest: digestCanonical(request),
          policyDigest,
          revision: 1,
          createdAt: T5,
          updatedAt: T5,
        });
        return {
          claim,
          operation,
          context: { claimOwner: owner.id, now: T5 },
          begin: {
            operationId: operation.id,
            expectedOperationRevision: 1,
            workUnitId: claim.workUnit.id,
            expectedWorkUnitRevision: claim.workUnit.revision,
            claimOwner: owner.id,
            jobId: "job-recovery",
            attemptId: "attempt-recovery",
            currentPolicyDigest: policyDigest,
            at: T5,
          },
        };
      }

      test("intent and envelope survive restart, replay once and paginate without granting execution", async () => {
        const { operation, context } = await prepareIntent();
        await store.createOperationIntent(operation, context);
        const original = await store.getOperationIntentOutbox(operation.id);
        if (!original) throw new Error("Expected the committed outbox envelope");
        expect(original?.intent).toEqual(operation);
        expect(await store.getEffectAdmission(operation.id)).toBeNull();
        await database.close();
        database = openDatabase();
        await database.init();
        store = new ScientificStore(database);
        expect(await store.getOperationIntentOutbox(operation.id)).toEqual(original);
        expect(
          await store.createOperationIntent({ ...operation, id: "different-retry-id" }, context),
        ).toEqual(operation);
        expect(
          await store.listPendingOperationOutbox({ missionId: operation.missionId, limit: 1 }),
        ).toEqual([original]);
        expect(await store.listPendingOperationOutbox({ missionId: "another-mission" })).toEqual(
          [],
        );
        expect(
          await store.listPendingOperationOutbox({
            missionId: operation.missionId,
            after: { createdAt: operation.createdAt, operationId: operation.id },
          }),
        ).toEqual([]);
        await expect(
          store.listPendingOperationOutbox({ missionId: operation.missionId, limit: 1001 }),
        ).rejects.toThrow();
        const changed = { ...operation.request, inputContentDigest: D("b") };
        await expect(
          store.createOperationIntent(
            { ...operation, request: changed, requestDigest: digestCanonical(changed) },
            context,
          ),
        ).rejects.toThrow();
        expect(await store.getOperationIntentOutbox(operation.id)).toEqual(original);
        expect((await store.getWorkUnit(operation.workUnitId))?.state).toBe("claimed");
      });

      test("an outbox write failure rolls back the operation, then the same intent can commit", async () => {
        const { operation, context } = await prepareIntent();
        const faulting = new ScientificStore(faultAtTransactionBoundary(database, "outbox_insert"));
        await expect(faulting.createOperationIntent(operation, context)).rejects.toThrow();
        expect(await store.getExternalOperation(operation.id)).toBeNull();
        expect(await store.listPendingOperationOutbox({ missionId: operation.missionId })).toEqual(
          [],
        );
        await store.createOperationIntent(operation, context);
        expect((await store.getOperationIntentOutbox(operation.id))?.intent).toEqual(operation);
      });

      test("lost commit acknowledgement recovers the existing intent without a second envelope", async () => {
        const { operation, context } = await prepareIntent();
        const faulting = new ScientificStore(faultAtTransactionBoundary(database, "commit_ack"));
        await expect(faulting.createOperationIntent(operation, context)).rejects.toThrow();
        expect(await store.getExternalOperation(operation.id)).toEqual(operation);
        expect(await store.createOperationIntent(operation, context)).toEqual(operation);
        expect(
          await store.listPendingOperationOutbox({ missionId: operation.missionId }),
        ).toHaveLength(1);
        expect(await store.getEffectAdmission(operation.id)).toBeNull();
      });

      test("admission write failure rolls back both state transitions and retains the pending envelope", async () => {
        const { operation, context, begin } = await prepareIntent();
        await store.createOperationIntent(operation, context);
        const faulting = new ScientificEffectReconciliationStore(
          faultAtTransactionBoundary(database, "admission_insert"),
        );
        await expect(faulting.beginWorkUnitEffect(begin)).rejects.toThrow();
        expect((await store.getExternalOperation(operation.id))?.state).toBe("intent");
        expect((await store.getWorkUnit(operation.workUnitId))?.state).toBe("claimed");
        expect(await store.getEffectAdmission(operation.id)).toBeNull();
        expect(
          await store.listPendingOperationOutbox({ missionId: operation.missionId }),
        ).toHaveLength(1);
        await effects.beginWorkUnitEffect(begin);
        expect((await store.getEffectAdmission(operation.id))?.requestDigest).toBe(
          operation.requestDigest,
        );
      });

      test("two independent connections consume one admission, and restart never makes it pending again", async () => {
        const { operation, context, begin, claim } = await prepareIntent();
        await store.createOperationIntent(operation, context);
        if (provider === "sqlite") {
          expect(
            (await raceSqliteAdmissions(join(directory!, "state.sqlite"), begin)).sort(),
          ).toEqual([0, 2]);
        } else {
          const other = openDatabase();
          await other.init();
          try {
            const contenders = await Promise.allSettled([
              effects.beginWorkUnitEffect(begin),
              new ScientificEffectReconciliationStore(other).beginWorkUnitEffect(begin),
            ]);
            expect(contenders.filter((result) => result.status === "fulfilled")).toHaveLength(1);
            expect(contenders.filter((result) => result.status === "rejected")).toHaveLength(1);
          } finally {
            await other.close();
          }
        }
        const admission = await store.getEffectAdmission(operation.id);
        expect(admission).toMatchObject({
          operationId: operation.id,
          claimId: claim.claimId,
          claimOwner: owner.id,
          fencingGeneration: claim.workUnit.revision,
          approvalId: "approval-recovery",
          approvalResponseId: "response-recovery",
          approvedBy: reviewer,
          requestDigest: operation.requestDigest,
          jobId: begin.jobId,
          attemptId: begin.attemptId,
        });
        expect(admission?.outboxDigest).toBe(
          (await store.getOperationIntentOutbox(operation.id))?.envelopeDigest,
        );
        await database.close();
        database = openDatabase();
        await database.init();
        store = new ScientificStore(database);
        expect(await store.getEffectAdmission(operation.id)).toEqual(admission);
        expect(await store.listPendingOperationOutbox({ missionId: operation.missionId })).toEqual(
          [],
        );
        const replacement = new ScientificEffectReconciliationStore(database);
        await expect(replacement.beginWorkUnitEffect(begin)).rejects.toThrow();
        // Post-admission uncertainty belongs to reconciliation, even without an external ACK.
        expect(
          (await store.listOperationsForReconciliation(operation.missionId)).map((op) => op.id),
        ).toEqual([operation.id]);
        expect(await store.getEffectAdmission(operation.id)).toEqual(admission);
      });

      test("lost admission commit ACK remains consumed and cannot authorize a second dispatch", async () => {
        const { operation, context, begin } = await prepareIntent();
        await store.createOperationIntent(operation, context);
        const faulting = new ScientificEffectReconciliationStore(
          faultAtTransactionBoundary(database, "commit_ack"),
        );
        await expect(faulting.beginWorkUnitEffect(begin)).rejects.toThrow();
        expect((await store.getExternalOperation(operation.id))?.state).toBe("effect_started");
        expect(await store.getEffectAdmission(operation.id)).not.toBeNull();
        expect(await store.listPendingOperationOutbox({ missionId: operation.missionId })).toEqual(
          [],
        );
        await expect(effects.beginWorkUnitEffect(begin)).rejects.toThrow();
      });

      test("an effect cannot predate its exact claim, even with a valid unexpired approval", async () => {
        const { operation, context, begin } = await prepareIntent();
        await store.createOperationIntent(operation, context);
        await expect(effects.beginWorkUnitEffect({ ...begin, at: T4 })).rejects.toThrow(
          "exact active claim record",
        );
        expect(await store.getEffectAdmission(operation.id)).toBeNull();
        expect((await store.getExternalOperation(operation.id))?.state).toBe("intent");
        expect((await store.getWorkUnit(operation.workUnitId))?.state).toBe("claimed");
        await effects.beginWorkUnitEffect(begin);
        expect((await store.getEffectAdmission(operation.id))?.admittedAt).toBe(T5);
      });

      test("a historical or damaged missing envelope cannot be regenerated or admitted implicitly", async () => {
        const { operation, context, begin } = await prepareIntent();
        await store.createOperationIntent(operation, context);
        const transaction = await database.beginTransaction();
        try {
          // Fixture-owner corruption only. Runtime roles cannot disable this PostgreSQL trigger.
          if (provider === "postgres")
            await transaction.query(
              "ALTER TABLE scientific_operation_outbox DISABLE TRIGGER scientific_operation_outbox_append_only",
            );
          await transaction.query(
            "DELETE FROM scientific_operation_outbox WHERE operation_id = $1",
            [operation.id],
          );
          if (provider === "postgres")
            await transaction.query(
              "ALTER TABLE scientific_operation_outbox ENABLE TRIGGER scientific_operation_outbox_append_only",
            );
          await transaction.commit();
        } catch (error) {
          await transaction.rollback();
          throw error;
        }
        expect(await store.getOperationIntentOutbox(operation.id)).toBeNull();
        await store.createOperationIntent(operation, context);
        expect(await store.getOperationIntentOutbox(operation.id)).toBeNull();
        await expect(effects.beginWorkUnitEffect(begin)).rejects.toThrow(
          "historical intents need explicit reconciliation",
        );
        expect((await store.getExternalOperation(operation.id))?.state).toBe("intent");
        expect((await store.getWorkUnit(operation.workUnitId))?.state).toBe("claimed");
      });

      test("upgrades a v18 database without backfilling historical operations into the outbox", async () => {
        const { operation, context, begin } = await prepareIntent();
        await store.createOperationIntent(operation, context);
        // Reconstruct v18 by removing only later additive objects, in FK order.
        // Operation/mission/plan/approval payloads remain unchanged by v19/v20.
        const transaction = await database.beginTransaction();
        try {
          await transaction.query("DROP TABLE scientific_md_preparation_publications");
          await transaction.query("DROP TABLE scientific_effect_deliveries");
          await transaction.query("DROP TABLE scientific_mission_projects");
          await transaction.query("DROP TABLE scientific_effect_admissions");
          await transaction.query("DROP TABLE scientific_operation_outbox");
          if (provider === "postgres") {
            await transaction.query("DROP FUNCTION scientific_reject_effect_history_mutation()");
            // Fixture downgrade also removes v22's provenance index and restores
            // the old uniqueness boundary before replaying later migrations.
            await transaction.query("DROP INDEX scientific_evidence_authority_identity");
            await transaction.query(
              "ALTER TABLE scientific_evidence ADD CONSTRAINT scientific_evidence_mission_id_kind_uri_content_digest_key UNIQUE (mission_id, kind, uri, content_digest)",
            );
          }
          await transaction.query("DELETE FROM _migrations WHERE version >= 19");
          await transaction.commit();
        } catch (error) {
          await transaction.rollback();
          throw error;
        }
        expect(await database.getMigrationVersion()).toBe(18);
        await database.close();
        database = provider === "postgres" ? new PostgresDatabase(cluster!.url) : openDatabase();
        await database.init();
        expect(await database.getMigrationVersion()).toBe(provider === "postgres" ? 22 : 21);
        store = new ScientificStore(database);
        effects = new ScientificEffectReconciliationStore(database);
        expect(await store.getExternalOperation(operation.id)).toEqual(operation);
        expect((await store.getPlan("plan-recovery"))?.status).toBe("approved");
        expect(await store.getOperationIntentOutbox(operation.id)).toBeNull();
        expect(await store.listPendingOperationOutbox({ missionId: operation.missionId })).toEqual(
          [],
        );
        await expect(effects.beginWorkUnitEffect(begin)).rejects.toThrow(
          "historical intents need explicit reconciliation",
        );
      });

      test("column or payload corruption cannot authorize admission even if an envelope is rehashed", async () => {
        const { operation, context, begin } = await prepareIntent();
        await store.createOperationIntent(operation, context);
        const original = await store.getOperationIntentOutbox(operation.id);
        if (!original) throw new Error("Missing fixture envelope");
        const badIntent = {
          ...original.intent,
          request: { ...original.intent.request, inputContentDigest: D("b") },
        };
        badIntent.requestDigest = digestCanonical(badIntent.request);
        const unsigned = { schemaVersion: original.schemaVersion, intent: badIntent };
        const altered = { ...unsigned, envelopeDigest: digestCanonical(unsigned) };
        const transaction = await database.beginTransaction();
        try {
          if (provider === "postgres")
            await transaction.query(
              "ALTER TABLE scientific_operation_outbox DISABLE TRIGGER scientific_operation_outbox_append_only",
            );
          await transaction.query(
            "UPDATE scientific_operation_outbox SET payload_json = $1, envelope_digest = $2 WHERE operation_id = $3",
            [canonicalJson(altered), altered.envelopeDigest, operation.id],
          );
          if (provider === "postgres")
            await transaction.query(
              "ALTER TABLE scientific_operation_outbox ENABLE TRIGGER scientific_operation_outbox_append_only",
            );
          await transaction.commit();
        } catch (error) {
          await transaction.rollback();
          throw error;
        }
        await expect(store.getOperationIntentOutbox(operation.id)).rejects.toThrow(
          "exact durable intent",
        );
        await expect(effects.beginWorkUnitEffect(begin)).rejects.toThrow("exact durable intent");
        expect(await store.getEffectAdmission(operation.id)).toBeNull();
        expect((await store.getExternalOperation(operation.id))?.state).toBe("intent");
        expect((await store.getWorkUnit(operation.workUnitId))?.state).toBe("claimed");
      });

      test("v19 to v20 preserves exact history and admissions, rolls back partial DDL, and never backfills delivery authority", async () => {
        const { operation, context, begin } = await prepareIntent();
        await store.createOperationIntent(operation, context);
        await effects.beginWorkUnitEffect(begin);
        const historicalTables = [
          "scientific_missions",
          "scientific_plans",
          "scientific_approval_requests",
          "scientific_approval_responses",
          "scientific_work_units",
          "scientific_external_operations",
          "scientific_operation_outbox",
          "scientific_effect_admissions",
        ];
        async function snapshot() {
          const tx = await database.beginTransaction();
          try {
            if (!tx.queryRows) throw new Error("Fixture requires row queries");
            const history = await tx.queryRows(
              "SELECT * FROM _migrations WHERE version <= 19 ORDER BY version",
            );
            const rows = [];
            for (const table of historicalTables)
              rows.push(await tx.queryRows(`SELECT * FROM ${table}`));
            return { history, rows };
          } finally {
            await tx.rollback();
          }
        }
        const before = await snapshot();
        const downgradeFixture = await database.beginTransaction();
        try {
          await downgradeFixture.query("DROP TABLE scientific_md_preparation_publications");
          await downgradeFixture.query("DROP TABLE scientific_effect_deliveries");
          await downgradeFixture.query("DROP TABLE scientific_mission_projects");
          if (provider === "postgres") {
            await downgradeFixture.query("DROP INDEX scientific_evidence_authority_identity");
            await downgradeFixture.query(
              "ALTER TABLE scientific_evidence ADD CONSTRAINT scientific_evidence_mission_id_kind_uri_content_digest_key UNIQUE (mission_id, kind, uri, content_digest)",
            );
          }
          await downgradeFixture.query("DELETE FROM _migrations WHERE version >= 20");
          // Deliberate collision at the SECOND CREATE TABLE. A failed migration
          // must also roll back the first table/index and its history entry.
          await downgradeFixture.query("CREATE TABLE scientific_effect_deliveries (fixture text)");
          await downgradeFixture.commit();
        } catch (error) {
          await downgradeFixture.rollback();
          throw error;
        }
        expect(await database.getMigrationVersion()).toBe(19);
        const migrator =
          provider === "postgres"
            ? new PostgresDatabase(cluster!.url)
            : new SqliteDatabase(join(directory!, "state.sqlite"));
        try {
          await expect(migrator.init()).rejects.toThrow(/already exists/);
          expect(await database.getMigrationVersion()).toBe(19);
          expect(await snapshot()).toEqual(before);
          const repairFixture = await database.beginTransaction();
          try {
            if (!repairFixture.queryRows) throw new Error("Fixture requires row queries");
            const remaining =
              provider === "postgres"
                ? await repairFixture.queryRows(
                    "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' AND tablename = 'scientific_mission_projects'",
                  )
                : await repairFixture.queryRows(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scientific_mission_projects'",
                  );
            expect(remaining).toEqual([]);
            await repairFixture.query("DROP TABLE scientific_effect_deliveries");
            await repairFixture.commit();
          } catch (error) {
            await repairFixture.rollback();
            throw error;
          }
          await migrator.init();
          expect(await migrator.getMigrationVersion()).toBe(provider === "postgres" ? 22 : 21);
          expect(await snapshot()).toEqual(before);
          const check = await database.beginTransaction();
          try {
            if (!check.queryRows) throw new Error("Fixture requires row queries");
            for (const table of ["scientific_mission_projects", "scientific_effect_deliveries"])
              expect(await check.queryRows(`SELECT * FROM ${table}`)).toEqual([]);
          } finally {
            await check.rollback();
          }
        } finally {
          await migrator.close();
        }
      });

      if (provider === "postgres") {
        test("PostgreSQL rejects update, delete and truncate of all immutable effect ledgers", async () => {
          const { operation, context, begin } = await prepareIntent();
          await store.createOperationIntent(operation, context);
          await effects.beginWorkUnitEffect(begin);
          const admission = await store.getEffectAdmission(operation.id);
          for (const table of [
            "scientific_operation_outbox",
            "scientific_effect_admissions",
            "scientific_mission_projects",
            "scientific_effect_deliveries",
          ]) {
            for (const command of [
              `UPDATE ${table} SET payload_json = '{}'`,
              `DELETE FROM ${table}`,
              `TRUNCATE ${table} CASCADE`,
            ]) {
              const transaction = await database.beginTransaction();
              await expect(transaction.query(command)).rejects.toThrow(/append-only/);
              await transaction.rollback();
            }
          }
          expect(await store.getEffectAdmission(operation.id)).toEqual(admission);
        });
      }
    },
  );
}

describe.skipIf(!canRunPostgres)("PostgreSQL scientific authority races", () => {
  let cluster: EphemeralPostgresCluster;
  let database: PostgresDatabase;

  beforeEach(async () => {
    cluster = await startEphemeralPostgres();
    database = new PostgresDatabase(cluster.url);
    await database.init();
  });

  afterEach(async () => {
    await database.close();
    await cluster.cleanup();
  });

  test("effect start waits for the mission authority lock and observes the committed stale state", async () => {
    const store = new ScientificStore(database);
    const effects = new ScientificEffectReconciliationStore(database);
    await seedApprovedFixture(store);
    const claim = await store.claimWorkUnit({
      workUnitId: "work-recovery",
      ownerId: owner.id,
      now: T5,
      expiresAt: T8,
      policyDigest,
    });
    if (!claim.claimed) throw new Error(claim.message);
    const request = operationRequestFixture();
    const operation = await store.createOperationIntent(
      ExternalOperationSchema.parse({
        id: "operation-recovery",
        missionId: "mission-recovery",
        workUnitId: "work-recovery",
        idempotencyKey: "mission-recovery/work-recovery/execute",
        kind: "local_execution",
        state: "intent",
        request,
        requestDigest: digestCanonical(request),
        policyDigest,
        revision: 1,
        createdAt: T5,
        updatedAt: T5,
      }),
      { claimOwner: owner.id, now: T5 },
    );

    const mission = await store.getMission("mission-recovery");
    if (!mission) throw new Error("Expected seeded PostgreSQL mission");
    const staleMission = ScientificMissionSchema.parse({
      ...mission,
      state: "cancel_requested",
      revision: mission.revision + 1,
      updatedAt: T6,
    });
    const authority = await database.beginTransaction();
    if (!authority.queryRows) throw new Error("PostgreSQL transaction lacks row-query support");
    await authority.queryRows("SELECT id FROM scientific_missions WHERE id = $1 FOR UPDATE", [
      mission.id,
    ]);
    await authority.query(
      `UPDATE scientific_missions
       SET state = $1, revision = $2, payload_digest = $3, payload_json = $4, updated_at = $5
       WHERE id = $6`,
      [
        staleMission.state,
        staleMission.revision,
        digestCanonical(staleMission),
        canonicalJson(staleMission),
        staleMission.updatedAt,
        staleMission.id,
      ],
    );

    const effect = effects.beginWorkUnitEffect({
      operationId: operation.id,
      expectedOperationRevision: operation.revision,
      workUnitId: claim.workUnit.id,
      expectedWorkUnitRevision: claim.workUnit.revision,
      claimOwner: owner.id,
      jobId: "job-recovery",
      attemptId: "attempt-recovery",
      currentPolicyDigest: policyDigest,
      at: T6,
    });
    const early = await Promise.race([
      effect.then(
        () => "settled",
        () => "settled",
      ),
      Bun.sleep(100).then(() => "blocked"),
    ]);
    expect(early).toBe("blocked");
    await authority.commit();

    await expect(effect).rejects.toThrow("active executable mission plan");
    expect((await store.getExternalOperation(operation.id))?.state).toBe("intent");
    expect((await store.getWorkUnit(claim.workUnit.id))?.state).toBe("claimed");
  });

  test("concurrent exact responses serialize without a partial second approval", async () => {
    const store = new ScientificStore(database);
    const { plan, approval: first } = await seedAwaitingFixture(store);
    const second = ApprovalRequestSchema.parse({
      ...first,
      id: "approval-recovery-second",
    });
    await store.createApprovalRequest(second);
    const respond = (approval: typeof first, suffix: string) =>
      store.respondToApproval(
        approval.id,
        ApprovalResponseSchema.parse({
          id: `response-recovery-${suffix}`,
          approvalRequestId: approval.id,
          decision: "approved",
          actor: reviewer,
          role: reviewer.role,
          reason: "Approve one exact concurrent response",
          subjectVersion: approval.subjectVersion,
          subjectRevision: approval.subjectRevision,
          payloadDigest: approval.payloadDigest,
          policyDigest: approval.policyDigest,
          decidedAt: T4,
        }),
        {
          now: T4,
          currentPolicyDigest: policyDigest,
          authenticatedActor: reviewer,
          authorizedRoles: [reviewer.role],
        },
      );
    const outcomes = await Promise.race([
      Promise.allSettled([respond(first, "first"), respond(second, "second")]),
      Bun.sleep(5_000).then(() => {
        throw new Error("Concurrent approval responses deadlocked");
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toBeInstanceOf(
      ScientificApprovalIncompatibleStateError,
    );
    const inspection = await database.beginTransaction();
    if (!inspection.queryRows) throw new Error("PostgreSQL transaction lacks row-query support");
    const approvalStates = await inspection.queryRows<{ state: string; count: string }>(
      `SELECT state, COUNT(*) AS count FROM scientific_approval_requests
       WHERE mission_id = $1 GROUP BY state`,
      ["mission-recovery"],
    );
    await inspection.commit();
    const counts = new Map(approvalStates.map((row) => [row.state, Number(row.count)]));
    expect(counts.get("approved")).toBe(1);
    expect(counts.get("pending")).toBe(1);
    expect((await store.getPlan(plan.id))?.status).toBe("approved");
  });
});
