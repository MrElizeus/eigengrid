import { afterEach, describe, expect, test } from "bun:test";
import { exerciseMdDeliveryRecovery } from "../../../tests/ts/helpers/md-delivery-recovery";
import { exerciseMdPreparationPublication } from "../../../tests/ts/helpers/md-preparation-publication";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDatabase, PostgresDatabase, type DatabaseLike } from "@eigengrid/db";
import { canRunPostgres, startEphemeralPostgres } from "../../../tests/ts/helpers/postgres";
import { createSlurmSubmissionBinding, SUBMITTER_SIGNATURE_DOMAIN } from "@eigengrid/slurm";
import {
  createAmberSlurmDeliveryDraft,
  parseAmberSlurmDelivery,
} from "../../../apps/cli/src/services/amber-slurm-delivery";
import { HeadMdDeliverySigner } from "../../../apps/cli/src/services/md-delivery-signer";
import { isCompletedMaterialPhaseDependency } from "./md-projection-store";
import { CanonicalScientificExecutionDriver } from "../../../apps/cli/src/services/scientific-mission-driver";
import type { VerifiedAmberStageBundle } from "../../../apps/cli/src/services/amber-stage-bundle";
import type { HeadMdAmberDeliverySession } from "../../../apps/cli/src/services/head-md-site-authority";
import {
  ApprovalRequestSchema,
  ApprovalResponseSchema,
  AtomMapPublicationRequestSchema,
  AtomMapPublicationRequestSchemaVersion,
  AtomMapSchema,
  AtomMapSchemaVersion,
  BiomolecularMaterialPublicationBindingSchema,
  BiomolecularMaterialPublicationBindingSchemaVersion,
  BiomolecularComponentSchemaVersion,
  BiomolecularDecisionSchemaVersion,
  BiomolecularSystemManifestSchema,
  BiomolecularSystemBuildRequestSchema,
  BiomolecularSystemBuildRequestSchemaVersion,
  ConstructDecisionSchema,
  EvidenceReferenceSchema,
  ExternalOperationSchema,
  ForceFieldStackManifestSchema,
  ForceFieldStackDecisionSchema,
  ForceFieldStackPublicationRequestSchema,
  ForceFieldStackPublicationRequestSchemaVersion,
  ForceFieldStackSchemaVersion,
  MembraneModelDecisionSchema,
  MdAssessmentSchemaVersion,
  MdExecutionBindingParametersSchema,
  MdExecutionBindingParametersSchemaVersion,
  MdProtocolSchemaVersion,
  MdReplicaSetSchemaVersion,
  MdStageAssessmentSchema,
  MdStageResultSchema,
  MdStageResultSchemaVersion,
  MdStageSchemaVersion,
  MdStageOperationRequestSchema,
  MdStageOperationRequestSchemaVersion,
  MdStageSpecSchema,
  MdWorkflowProtocolSchema,
  MissionBudgetSchema,
  MicrostateDecisionSchema,
  OperationReceiptSchema,
  PoseDecisionSchema,
  PublishedBiomolecularSystemManifestSchemaVersion,
  ReceptorProtonationDecisionSchema,
  ReplicaSetSchema,
  SchemaVersion,
  ScientificPlanSchema,
  ScientificMissionSchema,
  ScientificObservationSchema,
  TrajectorySegmentSchema,
  TrajectorySegmentSchemaVersion,
  WorkUnitSchema,
  ValidationResultSchema,
  canonicalJson,
  computeBiomolecularSystemManifestDigest,
  computeAtomMapDigest,
  computeForceFieldStackDigest,
  computeMdAcceptanceCriterionDigest,
  computeMdReplicaSeedPolicyDigest,
  computeMdStageResultDigest,
  computeMdStageSpecDigest,
  computeMdWorkflowProtocolDigest,
  computeTrajectorySegmentDigest,
  digestCanonical,
  mdForceFieldParameterDigests,
  type ActorIdentity,
  type EvidenceReference,
  type MdArtifactReference,
  type MdArtifactRole,
  type MdExecutionBindingParameters,
  type ExternalOperation,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import {
  ContentAddressedArtifactStore,
  MdProjectionStore,
  ScientificApprovalModifiedError,
  ScientificApprovalStaleError,
  ScientificEntityConflictError,
  ScientificStore,
  ScientificEffectReconciliationStore,
  mdStageEffectIdentity,
  assertMdStageOperationRequestAuthority,
  assertBiomolecularSystemDecisionAuthority,
  computeBiomolecularDecisionMaterialDigest,
  computeMdProtocolMaterialDigest,
  computeMdReplicaSetPayloadDigest,
  createMdStageAssessmentOperationRequest,
  computePlanDigest,
  computeProtocolDigest,
  computeSkillGraphDigest,
  resolveMdSubjectSnapshot,
  type BeginWorkUnitEffectInput,
  type ScientificTransaction,
  type ScientificDatabase,
  type MdSubmissionAuthority,
  type MdDeliveryDraft,
  effectDeliveryBody,
} from "./index";

const T0 = "2026-08-23T00:00:00.000Z";
const T1 = "2026-08-23T00:01:00.000Z";
const T2 = "2026-08-23T00:02:00.000Z";
const T3 = "2026-08-23T00:03:00.000Z";
const T4 = "2026-08-23T00:04:00.000Z";
const T5 = "2026-08-23T00:05:00.000Z";
const D = (character: string): string => character.repeat(64);
const C = (label: string): string =>
  createHash("sha256").update(new TextEncoder().encode(label)).digest("hex");
const owner = { id: "head-1", kind: "service" as const, role: "mission_owner" };
const reviewer = {
  id: "scientist-1",
  kind: "human" as const,
  role: "scientific_reviewer",
};
const policyDigest = D("f");
const fixtureEngineIdentity = {
  engine: "amber",
  executable: "fixture-engine",
  version: "24-fixture",
  buildDigest: D("6"),
  environmentDigest: D("7"),
  compatibilityVersion: "1.0.0",
};
const databases: DatabaseLike[] = [];
const clusterCleanups: (() => void | Promise<void>)[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
  for (const cleanup of clusterCleanups.splice(0)) await cleanup();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function selfSigned<T extends Record<string, unknown>, K extends keyof T>(
  input: T,
  field: K,
): T & Record<K, string> {
  const payload = Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== String(field)),
  );
  return { ...input, [field]: digestCanonical(payload) } as T & Record<K, string>;
}

function missionFixture() {
  return ScientificMissionSchema.parse({
    schemaVersion: SchemaVersion,
    id: "mission-md-1",
    revision: 1,
    state: "created",
    objective: {
      schemaVersion: SchemaVersion,
      id: "objective-md-1",
      statement: "Validate a durable MD projection fixture",
      system: {
        evidenceId: "objective-evidence",
        format: "pdb",
        contentDigest: D("1"),
        atomCount: 4,
        charge: 0,
        multiplicity: 1,
      },
      targetProperties: ["restart continuity"],
      requiredConfidence: "screening",
    },
    constraints: {
      allowedEngines: ["fixture"],
      deniedEngines: [],
      offlineRequired: true,
      materialChangesRequireApproval: true,
      immutableScientificFields: ["objective", "construct", "protocol"],
    },
    assumptions: [],
    acceptanceCriteria: [
      {
        id: "criterion-mission",
        kind: "normal_termination",
        description: "The fixture terminates normally",
        required: true,
      },
    ],
    activePlanId: null,
    budgetId: "budget-md-1",
    policyProfile: "bounded-local",
    requestedBy: reviewer,
    createdAt: T0,
    updatedAt: T0,
  });
}

function budgetFixture() {
  return MissionBudgetSchema.parse({
    id: "budget-md-1",
    missionId: "mission-md-1",
    revision: 1,
    limits: { externalOperations: 20, modelTokens: 0, wallTimeSeconds: 3_600, cost: 0 },
    consumed: { externalOperations: 0, modelTokens: 0, wallTimeSeconds: 0, cost: 0 },
    reservations: [],
  });
}

const mdFragment = {
  skillId: "amber.production-md",
  version: "1.0.0",
  contentDigest: D("4"),
  fragmentId: "amber-production-protocol",
  fragmentDigest: D("5"),
  relativePath: "protocols/production.md",
  selector: "production",
};

const qcPlanFragment = {
  skillId: "methods.fixture",
  version: "1.0.0",
  contentDigest: D("2"),
  fragmentId: "fixture-validation",
  fragmentDigest: D("3"),
  relativePath: "protocols/validation.md",
  selector: "validation",
};

function planFixture() {
  const graphBase = {
    id: "skill-resolution-md-1",
    schemaVersion: "eigengrid.resolved-skill-graph/v1" as const,
    missionId: "mission-md-1",
    requestedSkillIds: ["methods.fixture", "amber.production-md"],
    nodes: [
      {
        skillId: qcPlanFragment.skillId,
        version: qcPlanFragment.version,
        contentDigest: qcPlanFragment.contentDigest,
      },
      {
        skillId: mdFragment.skillId,
        version: mdFragment.version,
        contentDigest: mdFragment.contentDigest,
      },
    ],
    edges: [],
    selectedFragments: [qcPlanFragment, mdFragment],
    resolverVersion: "1.0.0",
    environmentDigest: D("6"),
    resolvedAt: T1,
  };
  const skillResolution = {
    ...graphBase,
    graphDigest: computeSkillGraphDigest(graphBase),
  };
  const protocolBase = {
    id: "scientific-protocol-md-1",
    schemaVersion: "eigengrid.scientific-protocol/v1" as const,
    objectiveId: "objective-md-1",
    system: missionFixture().objective.system,
    charge: 0,
    multiplicity: 1,
    method: "fixture-md-projection",
    basis: "not-applicable",
    physicalModel: "durable-md-fixture",
    engineAgnosticSteps: [
      {
        id: "validation-placeholder",
        kind: "validation" as const,
        reason: "Retain the legacy QC contract without claiming it owns MD stages",
        parameters: { validator: "fixture" },
        sourceFragments: [qcPlanFragment],
        riskClass: 1 as const,
      },
    ],
    assumptions: [],
    decisions: [],
    acceptanceCriteria: ["criterion-mission"],
    skillGraphDigest: skillResolution.graphDigest,
    compilerVersion: "1.0.0",
  };
  const protocol = {
    ...protocolBase,
    protocolDigest: computeProtocolDigest(protocolBase),
  };
  const planBase = {
    id: "plan-md-1",
    missionId: "mission-md-1",
    version: 1,
    revision: 1,
    status: "under_review" as const,
    normalizedObjective: "Validate durable MD projection ownership",
    missingInputs: [],
    assumptions: [],
    skillResolution,
    protocol,
    alternatives: [],
    risks: [],
    estimatedCost: { wallTimeSeconds: 60, cpuCoreHours: 0.001, cost: 0 },
    requiredApprovals: [reviewer.role],
    validationGates: ["criterion-mission"],
    limitations: ["Deterministic fixture only"],
    createdBy: owner,
    planDigest: D("0"),
    createdAt: T1,
    updatedAt: T1,
  };
  return ScientificPlanSchema.parse({
    ...planBase,
    planDigest: computePlanDigest(planBase),
  });
}

async function seedConfirmedOperation(
  database: DatabaseLike,
  input: {
    operationId: string;
    receiptId: string;
    workUnitId: string;
    capabilityId: string;
    operationKind?: "system_preparation" | "trajectory_analysis";
    request?: unknown;
    workUnit?: WorkUnit;
  },
): Promise<void> {
  const operationKind = input.operationKind ?? "system_preparation";
  const request = input.request ?? {
    schemaVersion: "eigengrid.fixture-operation-request/v1",
    subjectId: input.workUnitId,
  };
  const requestDigest = digestCanonical(request);
  const operation = ExternalOperationSchema.parse({
    id: input.operationId,
    missionId: "mission-md-1",
    workUnitId: input.workUnitId,
    idempotencyKey: `idem-${input.operationId}`,
    kind: operationKind,
    state: "confirmed",
    request,
    requestDigest,
    policyDigest,
    externalIdentity: { fixture: input.operationId },
    receiptId: input.receiptId,
    revision: 4,
    createdAt: T2,
    updatedAt: T2,
  });
  const receipt = OperationReceiptSchema.parse({
    id: input.receiptId,
    operationId: input.operationId,
    requestDigest,
    status: "confirmed",
    externalIdentity: { fixture: input.operationId },
    detailDigest: D("6"),
    recordedAt: T2,
  });
  const operationApprovalId = `approval-${input.operationId}`;
  const operationApprovalResponse = ApprovalResponseSchema.parse({
    id: `response-${operationApprovalId}`,
    approvalRequestId: operationApprovalId,
    decision: "approved",
    actor: reviewer,
    role: reviewer.role,
    reason: "Approve the exact command-free material publication intent",
    subjectVersion: 1,
    subjectRevision: 1,
    payloadDigest: requestDigest,
    policyDigest,
    decidedAt: T1,
  });
  const operationApproval = ApprovalRequestSchema.parse({
    id: operationApprovalId,
    missionId: "mission-md-1",
    subjectType: "operation",
    subjectId: input.operationId,
    subjectVersion: 1,
    subjectRevision: 1,
    state: "approved",
    requestedFromRole: reviewer.role,
    payloadDigest: requestDigest,
    policyDigest,
    editableFields: [],
    requestedBy: owner,
    requestedAt: T1,
    expiresAt: "2026-08-24T00:00:00.000Z",
    response: operationApprovalResponse,
  });
  const tx = await database.beginTransaction();
  try {
    if (input.workUnit) {
      await tx.query(
        `INSERT INTO scientific_work_units
         (id, mission_id, plan_id, plan_version, kind, capability_id, state, revision,
          claim_owner, claim_expires_at, job_id, attempt_id, payload_digest, payload_json,
          created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          input.workUnit.id,
          input.workUnit.missionId,
          input.workUnit.planId,
          input.workUnit.planVersion,
          "validation",
          input.capabilityId,
          input.workUnit.state,
          input.workUnit.revision,
          input.workUnit.claimOwner,
          input.workUnit.claimExpiresAt,
          input.workUnit.jobId,
          input.workUnit.attemptId,
          digestCanonical(input.workUnit),
          canonicalJson(input.workUnit),
          input.workUnit.createdAt,
          input.workUnit.updatedAt,
        ],
      );
    }
    await tx.query(
      `INSERT INTO scientific_external_operations
       (id, mission_id, work_unit_id, idempotency_key, kind, operation_kind_id, state,
        request_digest, policy_digest, budget_reservation_id, receipt_id, revision,
        payload_json, created_at, updated_at)
       VALUES ($1, 'mission-md-1', $2, $3, $4, $5, 'confirmed',
               $6, $7, NULL, $8, 4, $9, $10, $10)`,
      [
        input.operationId,
        input.workUnitId,
        operation.idempotencyKey,
        operationKind === "trajectory_analysis" ? "parse" : "local_execution",
        operationKind,
        requestDigest,
        policyDigest,
        input.receiptId,
        canonicalJson(operation),
        T2,
      ],
    );
    await tx.query(
      `INSERT INTO scientific_operation_receipts
       (id, operation_id, request_digest, status, detail_digest, payload_json, recorded_at)
       VALUES ($1, $2, $3, 'confirmed', $4, $5, $6)`,
      [
        input.receiptId,
        input.operationId,
        requestDigest,
        receipt.detailDigest,
        canonicalJson(receipt),
        T2,
      ],
    );
    // This helper seeds a canonical, already-completed external boundary. The
    // production path creates the same records through ScientificStore before
    // effect_started; raw SQL here is confined to that unavoidable fixture seam.
    await tx.query(
      `INSERT INTO scientific_approval_requests
       (id, mission_id, subject_type, subject_id, subject_version, subject_revision, state,
        requested_from_role, payload_digest, policy_digest, payload_json, requested_at, expires_at)
       VALUES ($1, 'mission-md-1', 'operation', $2, 1, 1, 'approved', $3, $4, $5, $6, $7, $8)`,
      [
        operationApproval.id,
        input.operationId,
        reviewer.role,
        requestDigest,
        policyDigest,
        canonicalJson(operationApproval),
        T1,
        operationApproval.expiresAt!,
      ],
    );
    await tx.query(
      `INSERT INTO scientific_approval_responses
       (id, approval_request_id, decision, actor_id, role, subject_version,
        subject_revision, payload_digest, policy_digest, payload_json, decided_at)
       VALUES ($1,$2,'approved',$3,$4,1,1,$5,$6,$7,$8)`,
      [
        operationApprovalResponse.id,
        operationApproval.id,
        reviewer.id,
        reviewer.role,
        requestDigest,
        policyDigest,
        canonicalJson(operationApprovalResponse),
        T1,
      ],
    );
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

function approvalRequest(input: {
  id: string;
  subjectType:
    | "plan"
    | "decision"
    | "biomolecular_system_manifest"
    | "md_protocol"
    | "md_stage"
    | "replica_set"
    | "md_assessment";
  subjectId: string;
  digest: string;
  revision?: number;
}) {
  const revision = input.revision ?? 1;
  return ApprovalRequestSchema.parse({
    id: input.id,
    missionId: "mission-md-1",
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    subjectVersion: revision,
    subjectRevision: revision,
    state: "pending",
    requestedFromRole: reviewer.role,
    payloadDigest: input.digest,
    policyDigest,
    editableFields: [],
    requestedBy: owner,
    requestedAt: T3,
    expiresAt: "2026-08-24T00:00:00.000Z",
  });
}

function approvalResponse(request: ReturnType<typeof approvalRequest>, at = T4) {
  return ApprovalResponseSchema.parse({
    id: `response-${request.id}`,
    approvalRequestId: request.id,
    decision: "approved",
    actor: reviewer,
    role: reviewer.role,
    reason: "Reviewed exact material digest",
    subjectVersion: request.subjectVersion,
    subjectRevision: request.subjectRevision,
    payloadDigest: request.payloadDigest,
    policyDigest: request.policyDigest,
    decidedAt: at,
  });
}

function artifact(
  role: MdArtifactRole,
  contentDigest: string,
  evidenceRef = `${role}-evidence-${contentDigest.slice(0, 8)}`,
): MdArtifactReference {
  return {
    artifactId: `${role}-artifact-${evidenceRef}`,
    evidenceRef,
    role,
    contentDigest,
    mediaType: ["mdout", "mdinfo"].includes(role) ? "text/plain" : "application/octet-stream",
  };
}

function evidenceKindForArtifactRole(role: MdArtifactRole): EvidenceReference["kind"] {
  if (role === "parent_restart") return "restart";
  if (role === "energy_series" || role === "normalized_metrics") {
    return "normalized_metrics";
  }
  if (role === "analysis_plan" || role === "analysis_result") return "analysis_result";
  return role;
}

async function createCasEvidence(
  cas: ContentAddressedArtifactStore,
  store: ScientificStore,
  input: {
    id: string;
    label: string;
    kind: EvidenceReference["kind"];
    mediaType?: string;
    workUnitId?: string;
    sourceId?: string;
  },
): Promise<EvidenceReference> {
  const stored = await cas.put(new TextEncoder().encode(input.label));
  expect(stored.digest).toBe(C(input.label));
  const evidence = EvidenceReferenceSchema.parse({
    id: input.id,
    missionId: "mission-md-1",
    ...(input.workUnitId ? { workUnitId: input.workUnitId } : {}),
    kind: input.kind,
    uri: stored.uri,
    contentDigest: stored.digest,
    sizeBytes: stored.sizeBytes,
    mediaType: input.mediaType ?? "application/octet-stream",
    immutable: true,
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    createdAt: T2,
  });
  await store.createEvidence(evidence);
  return evidence;
}

function constructDecision() {
  const input = {
    schemaVersion: BiomolecularDecisionSchemaVersion,
    id: "construct-decision-1",
    missionId: "mission-md-1",
    revision: 1,
    status: "proposed" as const,
    kind: "construct" as const,
    rationale: "Preserve the audited fixture construct",
    evidenceRefs: ["construct-evidence"],
    decidedBy: owner,
    decisionDigest: D("0"),
    createdAt: T1,
    sourceStructureDigest: D("7"),
    chainPolicies: [{ chainId: "A", action: "preserve" as const, reason: "fixture identity" }],
    mutationPolicies: [],
    missingRegionPolicies: [],
    terminiPolicy: "preserve",
    fusionPolicy: "none present",
    disulfidePolicy: "preserve audited connectivity",
    outputConstructDigest: C("constructed-protein"),
  };
  return ConstructDecisionSchema.parse({
    ...input,
    decisionDigest: computeBiomolecularDecisionMaterialDigest(input),
  });
}

const forceFieldEvidenceLabels = {
  "ff-protein-evidence": "ff-protein-parameters",
  "ff-lipid-evidence": "ff-lipid-parameters",
  "ff-water-evidence": "ff-water-parameters",
  "ff-ion-evidence": "ff-ion-parameters",
  "ff-compatibility-evidence": "ff-compatibility-review",
} as const;

function forceFieldParameterSet(
  id: string,
  family: string,
  evidenceRef: keyof typeof forceFieldEvidenceLabels,
) {
  return {
    id,
    family,
    version: "fixture-1",
    source: "immutable fixture",
    sourceEvidenceRefs: [evidenceRef],
    parameterDigest: C(forceFieldEvidenceLabels[evidenceRef]),
    knownLimitations: ["deterministic fixture only"],
  };
}

function forceFieldStack() {
  const unsigned = {
    schemaVersion: ForceFieldStackSchemaVersion,
    id: "force-field-1",
    revision: 1,
    protein: forceFieldParameterSet("ff-protein", "ff19SB", "ff-protein-evidence"),
    lipid: forceFieldParameterSet("ff-lipid", "lipid21", "ff-lipid-evidence"),
    ligands: [],
    water: {
      model: "TIP3P",
      parameterSet: forceFieldParameterSet("ff-water", "tip3p", "ff-water-evidence"),
    },
    ions: forceFieldParameterSet("ff-ions", "ionsjc_tip3p", "ff-ion-evidence"),
    cofactors: [],
    engineCompatibility: [{ engine: "amber", versionRange: ">=24" }],
    compatibilityEvidenceRefs: ["ff-compatibility-evidence"],
    knownLimitations: ["deterministic fixture only"],
    stackDigest: D("0"),
    createdAt: T1,
  };
  return ForceFieldStackManifestSchema.parse({
    ...unsigned,
    stackDigest: computeForceFieldStackDigest(unsigned),
  });
}

function forceFieldDecision(stack: ReturnType<typeof forceFieldStack>) {
  const input = {
    schemaVersion: BiomolecularDecisionSchemaVersion,
    id: "force-field-decision-1",
    missionId: "mission-md-1",
    revision: 1,
    status: "proposed" as const,
    kind: "force_field_stack" as const,
    rationale: "Select the exact published fixture stack",
    evidenceRefs: ["force-field-stack-evidence"],
    decidedBy: owner,
    decisionDigest: D("0"),
    createdAt: T1,
    candidates: [
      {
        id: stack.id,
        revision: stack.revision,
        digest: stack.stackDigest,
        evidenceRef: "force-field-stack-evidence",
        limitations: ["deterministic fixture only"],
      },
    ],
    selectedStack: { id: stack.id, revision: stack.revision, digest: stack.stackDigest },
    compatibilityCriteria: ["exact fixture protein/lipid/water/ion stack"],
  };
  return ForceFieldStackDecisionSchema.parse({
    ...input,
    decisionDigest: computeBiomolecularDecisionMaterialDigest(input),
  });
}

function receptorProtonationDecision(construct: ReturnType<typeof constructDecision>) {
  const input = {
    schemaVersion: BiomolecularDecisionSchemaVersion,
    id: "protonation-decision-1",
    missionId: "mission-md-1",
    revision: 1,
    status: "proposed" as const,
    kind: "protonation" as const,
    rationale: "Select an explicit receptor protonation fixture",
    evidenceRefs: ["construct-output-evidence", "protein-evidence"],
    decidedBy: owner,
    decisionDigest: D("0"),
    createdAt: T1,
    subjectKind: "protein" as const,
    subjectRole: "receptor" as const,
    subjectComponentId: "protein-1",
    targetPh: 7.4,
    temperatureKelvin: 300,
    method: "fixture-review 1.0.0",
    inputCoordinateDigest: construct.outputConstructDigest,
    inputCoordinateEvidenceRef: "construct-output-evidence",
    residueStates: [
      {
        chainId: "A",
        residueNumber: 1,
        residueName: "ALA",
        selectedState: "neutral",
        formalCharge: 0,
      },
    ],
    terminiPolicy: "explicit neutral fixture termini",
    selectedFormalCharge: 0,
    outputCoordinateDigest: C("protein-source"),
    outputCoordinateEvidenceRef: "protein-evidence",
  };
  return ReceptorProtonationDecisionSchema.parse({
    ...input,
    decisionDigest: computeBiomolecularDecisionMaterialDigest(input),
  });
}

const membraneDefinition = {
  orientationProvider: "fixture-orientation",
  orientationProviderVersion: "1.0.0",
  orientationEvidenceRef: "membrane-orientation-evidence",
  orientationDigest: C("membrane-orientation"),
  normalVector: [0, 0, 1] as [number, number, number],
  hydrophobicThicknessAngstrom: 30,
  composition: [{ lipidComponentId: "lipid-1", upperLeafletCount: 1, lowerLeafletCount: 1 }],
};

function membraneModelDecision() {
  const input = {
    schemaVersion: BiomolecularDecisionSchemaVersion,
    id: "membrane-decision-1",
    missionId: "mission-md-1",
    revision: 1,
    status: "proposed" as const,
    kind: "membrane_model" as const,
    rationale: "Bind the exact fixture orientation and composition",
    evidenceRefs: ["protein-evidence", "membrane-orientation-evidence"],
    decidedBy: owner,
    decisionDigest: D("0"),
    createdAt: T1,
    receptorComponentId: "protein-1",
    receptorCoordinateDigest: C("protein-source"),
    receptorCoordinateEvidenceRef: "protein-evidence",
    membraneDigest: digestCanonical(membraneDefinition),
    orientationDigest: membraneDefinition.orientationDigest,
    orientationEvidenceRef: membraneDefinition.orientationEvidenceRef,
    selectionCriteria: ["exact deterministic fixture orientation"],
    knownLimitations: ["deterministic fixture only"],
  };
  return MembraneModelDecisionSchema.parse({
    ...input,
    decisionDigest: computeBiomolecularDecisionMaterialDigest(input),
  });
}

function atomMapFixture(mapDigest = D("0")) {
  return {
    schemaVersion: AtomMapSchemaVersion,
    id: "atom-map-1",
    revision: 1,
    systemManifestId: "system-manifest-1",
    systemManifestRevision: 1,
    indexBase: 1 as const,
    atomCount: 6,
    topologyDigest: C("topology"),
    coordinateDigest: C("coordinates"),
    entries: [
      {
        systemAtomIndex: 1,
        componentId: "protein-1",
        componentAtomIndex: 1,
        chainId: "A",
        residueIndex: 1,
        residueName: "ALA",
        atomName: "CA",
        element: "C",
      },
      ...[1, 2].map((componentAtomIndex) => ({
        systemAtomIndex: componentAtomIndex + 1,
        componentId: "lipid-1",
        componentAtomIndex,
        residueIndex: componentAtomIndex + 1,
        residueName: "LIP",
        atomName: "C1",
        element: "C",
      })),
      ...[1, 2, 3].map((componentAtomIndex) => ({
        systemAtomIndex: componentAtomIndex + 3,
        componentId: "water-1",
        componentAtomIndex,
        residueIndex: 4,
        residueName: "WAT",
        atomName: componentAtomIndex === 1 ? "O" : `H${componentAtomIndex - 1}`,
        element: componentAtomIndex === 1 ? "O" : "H",
      })),
    ],
    mapDigest,
  };
}

function signedAtomMap() {
  const unsigned = atomMapFixture();
  return AtomMapSchema.parse({ ...unsigned, mapDigest: computeAtomMapDigest(unsigned) });
}

function systemManifest(
  decisions: {
    construct: ReturnType<typeof constructDecision> & { status: "approved"; approvalRef: string };
    forceField: ReturnType<typeof forceFieldDecision> & {
      status: "approved";
      approvalRef: string;
    };
    protonation: ReturnType<typeof receptorProtonationDecision> & {
      status: "approved";
      approvalRef: string;
    };
    membrane: ReturnType<typeof membraneModelDecision> & {
      status: "approved";
      approvalRef: string;
    };
  },
  stackDigest: string,
  atomMapDigest: string,
) {
  const input = {
    schemaVersion: PublishedBiomolecularSystemManifestSchemaVersion,
    id: "system-manifest-1",
    revision: 1,
    missionId: "mission-md-1",
    name: "membrane projection fixture",
    sourceEvidenceRefs: ["system-evidence"],
    constructDecisionId: decisions.construct.id,
    forceFieldStackDecisionId: decisions.forceField.id,
    membraneModelDecisionId: decisions.membrane.id,
    decisionRefs: Object.values(decisions).map((decision) => ({
      id: decision.id,
      revision: decision.revision,
      kind: decision.kind,
      decisionDigest: decision.decisionDigest,
      approvalRef: decision.approvalRef,
    })),
    components: {
      proteins: [
        {
          schemaVersion: BiomolecularComponentSchemaVersion,
          id: "protein-1",
          revision: 1,
          kind: "protein" as const,
          name: "fixture receptor",
          sourceEvidenceRefs: ["protein-evidence"],
          coordinateDigest: C("protein-source"),
          atomCount: 1,
          moleculeCount: 1,
          formalCharge: 0,
          role: "receptor" as const,
          chainIds: ["A"],
          residueCount: 1,
          sequenceDigest: D("a"),
          protonationDecisionId: decisions.protonation.id,
        },
      ],
      ligands: [],
      lipids: [
        {
          schemaVersion: BiomolecularComponentSchemaVersion,
          id: "lipid-1",
          revision: 1,
          kind: "lipid" as const,
          name: "fixture membrane lipid",
          sourceEvidenceRefs: ["lipid-evidence"],
          coordinateDigest: C("lipid-source"),
          atomCount: 2,
          moleculeCount: 2,
          formalCharge: 0,
          residueName: "LIP",
          lipidIdentity: "deterministic fixture lipid",
        },
      ],
      waters: [
        {
          schemaVersion: BiomolecularComponentSchemaVersion,
          id: "water-1",
          revision: 1,
          kind: "water" as const,
          name: "TIP3P fixture water",
          sourceEvidenceRefs: ["water-evidence"],
          coordinateDigest: C("water-source"),
          atomCount: 3,
          moleculeCount: 1,
          formalCharge: 0,
          waterModel: "TIP3P",
        },
      ],
      ions: [],
      cofactors: [],
    },
    membrane: membraneDefinition,
    environment: {
      targetPh: 7.4,
      targetTemperatureKelvin: 300,
      targetPressureBar: 1,
      targetIonicStrengthMolar: 0,
    },
    forceFieldStack: { id: "force-field-1", revision: 1, digest: stackDigest },
    topologyDigest: C("topology"),
    coordinateDigest: C("coordinates"),
    atomMapDigest,
    totalCharge: 0,
    atomCount: 6,
    box: {
      shape: "orthorhombic" as const,
      lengthsAngstrom: [20, 20, 20] as [number, number, number],
      anglesDegrees: [90, 90, 90] as [number, number, number],
      periodic: true as const,
    },
    provenance: {
      operationId: "operation-build-system",
      operationReceiptId: "receipt-build-system",
      builder: { name: "fixture-builder", version: "1.0.0" },
      createdBy: owner,
      createdAt: T2,
    },
    manifestDigest: D("0"),
  };
  return BiomolecularSystemManifestSchema.parse({
    ...input,
    manifestDigest: computeBiomolecularSystemManifestDigest(input),
  });
}

function systemBuildWorkUnit(manifest: ReturnType<typeof systemManifest>): WorkUnit {
  return WorkUnitSchema.parse({
    id: "work-unit-build-system",
    missionId: manifest.missionId,
    planId: "plan-md-1",
    planVersion: 1,
    kind: "scientific_capability",
    state: "observing",
    reason: "Publish the exact typed system-build effect",
    dependencies: [],
    inputRefs: [
      "system-evidence",
      "protein-evidence",
      "lipid-evidence",
      "water-evidence",
      "force-field-stack-evidence",
    ],
    outputContract: {
      requiredEvidenceKinds: ["topology", "coordinates", "atom_map"],
      requiredObservationKinds: ["artifact_integrity", "topology_integrity"],
    },
    skillRefs: [mdFragment],
    protocolFragment: {
      schemaVersion: "eigengrid.scientific-capability-fragment/v1",
      id: "fragment-build-system",
      kind: "scientific_capability",
      capability: {
        id: "biomolecular.build-system",
        version: "1.0.0",
        contractDigest: D("b"),
      },
      reason: "Build one exact biomolecular manifest revision",
      parameters: {
        manifestId: manifest.id,
        manifestRevision: manifest.revision,
        manifestDigest: manifest.manifestDigest,
      },
      sourceFragments: [mdFragment],
      riskClass: 3,
    },
    retryPolicy: { maximumAttempts: 1, ambiguityRequiresReconciliation: true },
    approvalPolicy: { required: true, minimumRole: reviewer.role },
    executionPolicy: { capability: "biomolecular.build-system", riskClass: 3 },
    revision: 1,
    claimOwner: owner.id,
    claimExpiresAt: "2026-08-24T00:00:00.000Z",
    jobId: "job-build-system",
    attemptId: "attempt-build-system",
    createdAt: T2,
    updatedAt: T2,
  });
}

function systemBuildRequest(manifest: ReturnType<typeof systemManifest>, workUnit: WorkUnit) {
  if (workUnit.protocolFragment.kind !== "scientific_capability") {
    throw new Error("System-build fixture requires a capability WorkUnit");
  }
  if (!workUnit.jobId || !workUnit.attemptId) {
    throw new Error("System-build fixture requires coordinator identity");
  }
  const sourceEvidence = [
    { id: "system-evidence", contentDigest: C("system-source") },
    { id: "protein-evidence", contentDigest: C("protein-source") },
    { id: "lipid-evidence", contentDigest: C("lipid-source") },
    { id: "water-evidence", contentDigest: C("water-source") },
  ];
  if (!workUnit.inputRefs.includes(sourceEvidence[0]!.id)) {
    throw new Error("System-build fixture lacks its exact primary source evidence");
  }
  return BiomolecularSystemBuildRequestSchema.parse({
    schemaVersion: BiomolecularSystemBuildRequestSchemaVersion,
    missionId: workUnit.missionId,
    planId: workUnit.planId,
    planVersion: workUnit.planVersion,
    intendedJobId: workUnit.jobId,
    intendedAttemptId: workUnit.attemptId,
    inputEvidenceId: sourceEvidence[0]!.id,
    inputContentDigest: sourceEvidence[0]!.contentDigest,
    workUnitId: workUnit.id,
    capability: workUnit.protocolFragment.capability,
    systemManifest: {
      id: manifest.id,
      revision: manifest.revision,
    },
    sourceEvidence,
    decisionRefs: manifest.decisionRefs,
    forceFieldStack: manifest.forceFieldStack,
    outputArtifacts: {
      topology: {
        evidenceRef: "topology-evidence",
        mediaType: "application/octet-stream",
      },
      coordinates: {
        evidenceRef: "coordinates-evidence",
        mediaType: "application/octet-stream",
      },
      atomMap: {
        evidenceRef: "atom-map-evidence",
        mediaType: "application/vnd.eigengrid.atom-map+json",
      },
    },
    parametersDigest: digestCanonical(workUnit.protocolFragment.parameters),
    outputContractDigest: digestCanonical(workUnit.outputContract),
  });
}

function materialPublicationWorkUnit(
  binding: ReturnType<typeof BiomolecularMaterialPublicationBindingSchema.parse>,
  input: {
    id: string;
    capabilityId: string;
    contractDigest: string;
    dependencies?: string[];
  },
): WorkUnit {
  return WorkUnitSchema.parse({
    id: input.id,
    missionId: "mission-md-1",
    planId: "plan-md-1",
    planVersion: 1,
    kind: "scientific_capability",
    state: "observing",
    reason: `Publish exact ${binding.subjectKind} material authority`,
    dependencies: input.dependencies ?? [],
    inputRefs: binding.sourceEvidenceRefs,
    outputContract: {
      requiredEvidenceKinds:
        binding.subjectKind === "force_field_stack" ? ["force_field_stack"] : [],
      requiredObservationKinds:
        binding.subjectKind === "force_field_stack"
          ? ["artifact_integrity"]
          : ["artifact_integrity", "topology_integrity"],
    },
    skillRefs: [mdFragment],
    protocolFragment: {
      schemaVersion: "eigengrid.scientific-capability-fragment/v1",
      id: `fragment-${input.id}`,
      kind: "scientific_capability",
      capability: {
        id: input.capabilityId,
        version: "1.0.0",
        contractDigest: input.contractDigest,
      },
      reason: `Publish exact ${binding.subjectKind} material authority`,
      parameters: binding,
      sourceFragments: [mdFragment],
      riskClass: 3,
    },
    retryPolicy: { maximumAttempts: 1, ambiguityRequiresReconciliation: true },
    approvalPolicy: { required: true, minimumRole: reviewer.role },
    executionPolicy: { capability: input.capabilityId, riskClass: 3 },
    revision: 1,
    claimOwner: owner.id,
    claimExpiresAt: "2026-08-24T00:00:00.000Z",
    jobId: `job-${input.id}`,
    attemptId: `attempt-${input.id}`,
    createdAt: T2,
    updatedAt: T2,
  });
}

function forceFieldPublicationRequest(
  stack: ReturnType<typeof forceFieldStack>,
  workUnit: WorkUnit,
) {
  if (workUnit.protocolFragment.kind !== "scientific_capability") throw new Error("bad fixture");
  if (!workUnit.jobId || !workUnit.attemptId) throw new Error("bad coordinator identity");
  const sourceEvidence = Object.entries(forceFieldEvidenceLabels).map(([id, label]) => ({
    id,
    contentDigest: C(label),
  }));
  if (!sourceEvidence[0] || !workUnit.inputRefs.includes(sourceEvidence[0].id)) {
    throw new Error("bad force-field source evidence");
  }
  return ForceFieldStackPublicationRequestSchema.parse({
    schemaVersion: ForceFieldStackPublicationRequestSchemaVersion,
    missionId: workUnit.missionId,
    planId: workUnit.planId,
    planVersion: workUnit.planVersion,
    intendedJobId: workUnit.jobId,
    intendedAttemptId: workUnit.attemptId,
    inputEvidenceId: sourceEvidence[0].id,
    inputContentDigest: sourceEvidence[0].contentDigest,
    workUnitId: workUnit.id,
    capability: workUnit.protocolFragment.capability,
    stack: { id: stack.id, revision: stack.revision, digest: stack.stackDigest },
    sourceEvidence,
    outputArtifact: {
      evidenceRef: "force-field-stack-evidence",
      mediaType: "application/vnd.eigengrid.force-field-stack+json",
    },
    parametersDigest: digestCanonical(workUnit.protocolFragment.parameters),
    outputContractDigest: digestCanonical(workUnit.outputContract),
  });
}

function atomMapPublicationRequest(
  atomMap: ReturnType<typeof signedAtomMap>,
  manifest: ReturnType<typeof systemManifest>,
  workUnit: WorkUnit,
) {
  if (workUnit.protocolFragment.kind !== "scientific_capability") throw new Error("bad fixture");
  if (!workUnit.jobId || !workUnit.attemptId) throw new Error("bad coordinator identity");
  if (!workUnit.inputRefs.includes("atom-map-evidence")) throw new Error("bad input evidence");
  return AtomMapPublicationRequestSchema.parse({
    schemaVersion: AtomMapPublicationRequestSchemaVersion,
    missionId: workUnit.missionId,
    planId: workUnit.planId,
    planVersion: workUnit.planVersion,
    intendedJobId: workUnit.jobId,
    intendedAttemptId: workUnit.attemptId,
    inputEvidenceId: "atom-map-evidence",
    inputContentDigest: atomMap.mapDigest,
    workUnitId: workUnit.id,
    capability: workUnit.protocolFragment.capability,
    atomMap: { id: atomMap.id, revision: atomMap.revision, digest: atomMap.mapDigest },
    systemManifest: {
      id: manifest.id,
      revision: manifest.revision,
      digest: manifest.manifestDigest,
    },
    sourceArtifact: {
      evidenceRef: "atom-map-evidence",
      mediaType: "application/vnd.eigengrid.atom-map+json",
    },
    parametersDigest: digestCanonical(workUnit.protocolFragment.parameters),
    outputContractDigest: digestCanonical(workUnit.outputContract),
  });
}

function stageSpec(manifest: ReturnType<typeof systemManifest>) {
  const system = {
    id: manifest.id,
    revision: manifest.revision,
    systemClass: "soluble" as const,
    manifestDigest: manifest.manifestDigest,
    topologyDigest: manifest.topologyDigest,
    coordinateDigest: manifest.coordinateDigest,
    atomMapDigest: manifest.atomMapDigest,
  };
  const criterionInput = {
    schemaVersion: MdAssessmentSchemaVersion,
    id: "stage-normal-termination",
    kind: "normal_termination" as const,
    description: "Engine terminates normally",
    required: true,
    evaluatorVersion: "1.0.0",
    criterionDigest: D("0"),
  };
  const criterion = {
    ...criterionInput,
    criterionDigest: computeMdAcceptanceCriterionDigest(criterionInput),
  };
  const input = {
    schemaVersion: MdStageSchemaVersion,
    id: "stage-equilibration-1",
    revision: 1,
    sequence: 1,
    kind: "equilibration" as const,
    name: "equilibration fixture",
    system,
    parentStageId: null,
    requiredParentOutputRole: null,
    inputs: [
      artifact("topology", manifest.topologyDigest, "topology-evidence"),
      artifact("coordinates", manifest.coordinateDigest, "coordinates-evidence"),
    ],
    ensemble: "npt" as const,
    steps: 1_000,
    timeStepPs: 0.002,
    simulatedTimePs: 2,
    temperature: { points: [{ step: 0, kelvin: 300 }] },
    thermostat: { kind: "langevin" as const, collisionFrequencyPerPs: 1 },
    barostat: {
      kind: "monte_carlo" as const,
      coupling: "isotropic" as const,
      targetPressureBar: 1,
      relaxationTimePs: 2,
    },
    constraints: { bondsToHydrogen: true, tolerance: 0.00001, maximumIterations: 1_000 },
    restraints: [],
    nonbonded: {
      cutoffAngstrom: 9,
      electrostatics: "pme" as const,
      ewaldTolerance: 0.00001,
      periodicBoundary: true as const,
    },
    randomSeed: { policy: "fixed" as const, seed: 12345 },
    resourceProfile: {
      backendCapabilityId: "fixture.cpu",
      cpuCores: 1,
      gpuCount: 0,
      memoryBytes: 128 * 1024 * 1024,
      scratchBytes: 1_000_000,
      wallTimeSeconds: 60,
    },
    checkpoint: {
      cadenceSteps: 500,
      retainCount: 2,
      stopAfterCheckpointSupported: true,
    },
    outputs: [
      { role: "restart" as const, required: true, mediaType: "application/octet-stream" },
      { role: "mdout" as const, required: true, mediaType: "text/plain" },
      { role: "mdinfo" as const, required: true, mediaType: "text/plain" },
    ],
    acceptanceCriteria: [criterion],
    sourceDecisionRefs: ["construct-decision-1"],
    rendererCompatibilityVersion: "1.0.0",
    stageDigest: D("0"),
  };
  return MdStageSpecSchema.parse({
    ...input,
    stageDigest: computeMdStageSpecDigest(input),
  });
}

function productionStageSpec(
  manifest: ReturnType<typeof systemManifest>,
  parent: ReturnType<typeof stageSpec>,
) {
  const criterionInput = {
    schemaVersion: MdAssessmentSchemaVersion,
    id: "production-normal-termination",
    kind: "normal_termination" as const,
    description: "Production engine terminates normally",
    required: true,
    evaluatorVersion: "1.0.0",
    criterionDigest: D("0"),
  };
  const criterion = {
    ...criterionInput,
    criterionDigest: computeMdAcceptanceCriterionDigest(criterionInput),
  };
  const input = {
    schemaVersion: MdStageSchemaVersion,
    id: "stage-production-1",
    revision: 1,
    sequence: 2,
    kind: "production" as const,
    name: "production fixture",
    system: parent.system,
    parentStageId: parent.id,
    requiredParentOutputRole: "restart" as const,
    inputs: [artifact("topology", manifest.topologyDigest, "topology-evidence")],
    ensemble: "npt" as const,
    steps: 1_000,
    timeStepPs: 0.002,
    simulatedTimePs: 2,
    temperature: { points: [{ step: 0, kelvin: 300 }] },
    thermostat: { kind: "langevin" as const, collisionFrequencyPerPs: 1 },
    barostat: {
      kind: "monte_carlo" as const,
      coupling: "isotropic" as const,
      targetPressureBar: 1,
      relaxationTimePs: 2,
    },
    constraints: { bondsToHydrogen: true, tolerance: 0.00001, maximumIterations: 1_000 },
    restraints: [],
    nonbonded: {
      cutoffAngstrom: 9,
      electrostatics: "pme" as const,
      ewaldTolerance: 0.00001,
      periodicBoundary: true as const,
    },
    randomSeed: { policy: "fixed" as const, seed: 12345 },
    resourceProfile: {
      backendCapabilityId: "fixture.cpu",
      cpuCores: 1,
      gpuCount: 0,
      memoryBytes: 128 * 1024 * 1024,
      scratchBytes: 1_000_000,
      wallTimeSeconds: 60,
    },
    checkpoint: {
      cadenceSteps: 500,
      retainCount: 2,
      stopAfterCheckpointSupported: true,
    },
    outputs: [
      { role: "restart" as const, required: true, mediaType: "application/octet-stream" },
      { role: "trajectory" as const, required: true, mediaType: "application/octet-stream" },
      { role: "mdout" as const, required: true, mediaType: "text/plain" },
      { role: "mdinfo" as const, required: true, mediaType: "text/plain" },
    ],
    acceptanceCriteria: [criterion],
    sourceDecisionRefs: ["construct-decision-1"],
    rendererCompatibilityVersion: "1.0.0",
    stageDigest: D("0"),
  };
  return MdStageSpecSchema.parse({
    ...input,
    stageDigest: computeMdStageSpecDigest(input),
  });
}

function workflowProtocol(
  manifest: ReturnType<typeof systemManifest>,
  stage: ReturnType<typeof stageSpec>,
  production: ReturnType<typeof productionStageSpec>,
) {
  const input = {
    schemaVersion: MdProtocolSchemaVersion,
    id: "md-protocol-1",
    missionId: "mission-md-1",
    revision: 1,
    status: "under_review" as const,
    system: stage.system,
    forceFieldStack: manifest.forceFieldStack,
    targetEngine: { family: "amber" as const, versionRange: ">=24" },
    capabilityRefs: [{ id: "amber.production-md", version: "1.0.0", contractDigest: D("3") }],
    stages: [stage, production],
    decisionRefs: ["construct-decision-1"],
    assumptions: ["deterministic fixture only"],
    skillRefs: [{ skillId: "amber.production-md", version: "1.0.0", contentDigest: D("4") }],
    compilerVersion: "1.0.0",
    protocolDigest: D("0"),
    createdAt: T2,
    updatedAt: T2,
  };
  return MdWorkflowProtocolSchema.parse({
    ...input,
    protocolDigest: computeMdWorkflowProtocolDigest(input),
  });
}

function capabilityWorkUnit(
  manifest: ReturnType<typeof systemManifest>,
  protocol: ReturnType<typeof workflowProtocol>,
  stage: ReturnType<typeof stageSpec> | ReturnType<typeof productionStageSpec>,
  decision: ReturnType<typeof constructDecision> & {
    status: "approved";
    approvalRef: string;
  },
  input: {
    id: string;
    planApprovalRef: string;
    systemApprovalRef: string;
    protocolApprovalRef: string;
    dependencies?: string[];
    inputRefs?: string[];
    parentRestart?: MdArtifactReference;
    replicaSegment?: MdExecutionBindingParameters["replicaSegment"];
  },
) {
  const binding = MdExecutionBindingParametersSchema.parse({
    schemaVersion: MdExecutionBindingParametersSchemaVersion,
    plan: {
      id: "plan-md-1",
      version: 1,
      revision: 1,
      digest: planFixture().planDigest,
      approvalRef: input.planApprovalRef,
    },
    system: {
      id: manifest.id,
      revision: manifest.revision,
      digest: manifest.manifestDigest,
      approvalRef: input.systemApprovalRef,
    },
    protocol: {
      id: protocol.id,
      revision: protocol.revision,
      digest: protocol.protocolDigest,
      approvalRef: input.protocolApprovalRef,
    },
    stage: {
      id: stage.id,
      revision: stage.revision,
      sequence: stage.sequence,
      kind: stage.kind,
      digest: stage.stageDigest,
    },
    decisions: [
      {
        id: decision.id,
        revision: decision.revision,
        kind: decision.kind,
        decisionDigest: decision.decisionDigest,
        approvalRef: decision.approvalRef,
      },
    ],
    ...(input.parentRestart ? { parentRestart: input.parentRestart } : {}),
    ...(input.replicaSegment ? { replicaSegment: input.replicaSegment } : {}),
  });
  const evidenceKind = (role: MdArtifactRole): string =>
    role === "energy_series" || role === "normalized_metrics"
      ? "normalized_metrics"
      : role === "analysis_plan" || role === "analysis_result"
        ? "analysis_result"
        : role === "parent_restart"
          ? "restart"
          : role;
  const observations = ["artifact_integrity", "stage_completion"];
  if (stage.sequence > 1) observations.push("restart_continuity");
  if (stage.kind !== "minimization") observations.push("temperature");
  if (stage.kind === "equilibration" || stage.kind === "production") {
    observations.push("density", "volume");
  }
  return WorkUnitSchema.parse({
    id: input.id,
    missionId: "mission-md-1",
    planId: "plan-md-1",
    planVersion: 1,
    kind: "scientific_capability",
    state: "created",
    reason: `Execute exact MD ${stage.kind} fixture`,
    dependencies: input.dependencies ?? [],
    inputRefs: input.inputRefs ?? [
      ...manifest.sourceEvidenceRefs,
      ...stage.inputs.map((candidate) => candidate.evidenceRef),
      ...(input.parentRestart ? [input.parentRestart.evidenceRef] : []),
    ],
    outputContract: {
      requiredEvidenceKinds: stage.outputs
        .filter((output) => output.required)
        .map((output) => evidenceKind(output.role)),
      requiredObservationKinds: observations,
    },
    skillRefs: [mdFragment],
    protocolFragment: {
      schemaVersion: "eigengrid.scientific-capability-fragment/v1",
      id: `fragment-${input.id}`,
      kind: "scientific_capability",
      capability: {
        id: "amber.production-md",
        version: "1.0.0",
        contractDigest: D("3"),
      },
      reason: `Execute the approved ${stage.kind} stage`,
      parameters: binding,
      sourceFragments: [mdFragment],
      riskClass: 3,
    },
    retryPolicy: { maximumAttempts: 1, ambiguityRequiresReconciliation: true },
    approvalPolicy: { required: true, minimumRole: reviewer.role },
    executionPolicy: { capability: "amber.production-md", riskClass: 3 },
    revision: 1,
    claimOwner: null,
    claimExpiresAt: null,
    jobId: null,
    attemptId: null,
    createdAt: T2,
    updatedAt: T2,
  });
}

function stageResult(
  protocol: ReturnType<typeof workflowProtocol>,
  stage: ReturnType<typeof stageSpec> | ReturnType<typeof productionStageSpec>,
  input: {
    id: string;
    workUnitId: string;
    operationId: string;
    operationReceiptId: string;
    artifacts: MdArtifactReference[];
    parentRestart?: MdArtifactReference;
    replicaSegment?: MdExecutionBindingParameters["replicaSegment"];
  },
) {
  const resultInput = {
    schemaVersion: MdStageResultSchemaVersion,
    id: input.id,
    revision: 1,
    missionId: "mission-md-1",
    workUnitId: input.workUnitId,
    operationId: input.operationId,
    operationReceiptId: input.operationReceiptId,
    protocolId: protocol.id,
    protocolRevision: protocol.revision,
    protocolDigest: protocol.protocolDigest,
    stageId: stage.id,
    stageRevision: stage.revision,
    stageDigest: stage.stageDigest,
    stageKind: stage.kind,
    ...(input.replicaSegment
      ? {
          replicaSetId: input.replicaSegment.replicaSetId,
          replicaSetRevision: input.replicaSegment.replicaSetRevision,
          replicaSetDigest: input.replicaSegment.replicaSetDigest,
          replicaId: input.replicaSegment.replicaId,
          segmentIndex: input.replicaSegment.segmentIndex,
          parentRestartDigest: input.parentRestart!.contentDigest,
        }
      : {}),
    terminalReason: "completed" as const,
    exitCode: 0,
    signal: null,
    startedAt: T4,
    finishedAt: T5,
    startStep: 0,
    endStep: 1_000,
    startTimePs: 0,
    endTimePs: 2,
    engine: fixtureEngineIdentity,
    artifacts: input.artifacts,
    warnings: [],
    errors: [],
    validationStatus: "passed" as const,
    validationRefs: [`validation-${input.id}`],
    resultDigest: D("0"),
  };
  return MdStageResultSchema.parse({
    ...resultInput,
    resultDigest: computeMdStageResultDigest(resultInput),
  });
}

function stageAssessment(
  result: ReturnType<typeof stageResult>,
  stage: ReturnType<typeof stageSpec> | ReturnType<typeof productionStageSpec>,
  input: { id: string; evidenceRef: string; status?: "accepted" | "rejected" },
) {
  const status = input.status ?? "accepted";
  return MdStageAssessmentSchema.parse(
    selfSigned(
      {
        schemaVersion: MdAssessmentSchemaVersion,
        id: input.id,
        revision: 1,
        missionId: "mission-md-1",
        stageResultId: result.id,
        stageResultRevision: result.revision,
        stageResultDigest: result.resultDigest,
        status,
        evaluations: [
          {
            criterionId: stage.acceptanceCriteria[0]!.id,
            criterionDigest: stage.acceptanceCriteria[0]!.criterionDigest,
            required: true,
            status: status === "accepted" ? ("passed" as const) : ("failed" as const),
            summary: "normal termination and exact receipt",
            evidenceRefs: [input.evidenceRef],
          },
        ],
        nextStageEligible: status === "accepted",
        limitations: ["fixture duration"],
        evidenceRefs: [input.evidenceRef],
        assessor: reviewer,
        assessmentDigest: D("0"),
        createdAt: T5,
      },
      "assessmentDigest",
    ),
  );
}

function approvalContext(now: string) {
  return {
    now,
    currentPolicyDigest: policyDigest,
    authenticatedActor: reviewer as ActorIdentity,
    authorizedRoles: [reviewer.role],
  };
}

async function createStageValidation(
  store: ScientificStore,
  input: {
    workUnitId: string;
    resultId: string;
    criterionId: string;
    evidenceRef: string;
  },
): Promise<void> {
  const observation = ScientificObservationSchema.parse({
    id: `observation-${input.resultId}`,
    missionId: "mission-md-1",
    workUnitId: input.workUnitId,
    type: "stage_completion",
    payload: { terminalReason: "completed", exitCode: 0 },
    source: { kind: "parser", id: "fixture-mdout-parser@1.0.0" },
    evidenceRefs: [input.evidenceRef],
    qualityFlags: ["fixture"],
    observedAt: T5,
  });
  await store.createObservation(observation);
  await store.createValidationResult(
    ValidationResultSchema.parse({
      id: `validation-${input.resultId}`,
      missionId: "mission-md-1",
      workUnitId: input.workUnitId,
      criterionId: input.criterionId,
      status: "passed",
      summary: "Exact parser observation supports normal stage completion",
      observationRefs: [observation.id],
      evidenceRefs: [input.evidenceRef],
      validatorVersion: "1.0.0",
      createdAt: T5,
    }),
  );
}

/** Corrupt only an isolated test database, commit the change so a second real
 * connection sees it, and restore the exact bytes after the rejection check. */
async function withChangedAdmissionFixture(
  database: DatabaseLike,
  table:
    | "scientific_approval_requests"
    | "scientific_approval_responses"
    | "scientific_budget_reservations"
    | "scientific_mission_budgets"
    | "scientific_evidence"
    | "scientific_operation_receipts"
    | "scientific_external_operations"
    | "scientific_missions"
    | "scientific_plans"
    | "scientific_work_units",
  id: string,
  change: (payload: Record<string, unknown>) => Record<string, unknown>,
  check: () => Promise<void>,
  columnOnlyPatch: Record<string, unknown> = {},
): Promise<void> {
  const tx = (await database.beginTransaction()) as ScientificTransaction;
  let original: Record<string, unknown> & { payload_json: string };
  let changed: Record<string, unknown>;
  let columns: string[];
  let updateSql: string;
  try {
    const rows = await tx.queryRows<Record<string, unknown> & { payload_json: string }>(
      `SELECT * FROM ${table} WHERE id = $1`,
      [id],
    );
    expect(rows.length).toBe(1);
    original = rows[0]!;
    changed = change(JSON.parse(original.payload_json));
    // Keep legitimate mutable scalar columns in sync. Corrupt foreign IDs stay
    // payload-only to avoid fixture setup failing at an unrelated FK check.
    const mirrored: Record<string, unknown> =
      table === "scientific_approval_requests"
        ? {
            state: changed.state,
            policy_digest: changed.policyDigest,
            requested_at: changed.requestedAt,
            expires_at: changed.expiresAt ?? null,
          }
        : table === "scientific_approval_responses"
          ? {
              actor_id: (changed.actor as ActorIdentity).id,
              role: changed.role,
              policy_digest: changed.policyDigest,
              decided_at: changed.decidedAt,
            }
          : table === "scientific_budget_reservations"
            ? {
                state: changed.state,
                kind: changed.kind,
                amount: changed.amount,
                operation_id: changed.operationId,
                created_at: changed.createdAt,
              }
            : table === "scientific_mission_budgets"
              ? { payload_digest: digestCanonical(changed) }
              : table === "scientific_evidence"
                ? {
                    immutable:
                      database._provider === "postgres"
                        ? changed.immutable
                        : Number(changed.immutable),
                    content_digest: changed.contentDigest,
                    uri: changed.uri,
                  }
                : table === "scientific_missions"
                  ? {
                      state: changed.state,
                      active_plan_id: changed.activePlanId,
                      payload_digest: digestCanonical(changed),
                    }
                  : table === "scientific_work_units"
                    ? {
                        state: changed.state,
                        revision: changed.revision,
                        claim_owner: changed.claimOwner,
                        claim_expires_at: changed.claimExpiresAt,
                        job_id: changed.jobId,
                        attempt_id: changed.attemptId,
                        payload_digest: digestCanonical(changed),
                      }
                    : table === "scientific_plans"
                      ? {
                          status: changed.status,
                          revision: changed.revision,
                          plan_digest: changed.planDigest,
                        }
                      : {};
    const values = { payload_json: canonicalJson(changed), ...mirrored, ...columnOnlyPatch };
    columns = Object.keys(values);
    for (const key of columns) expect(key).toMatch(/^[a-z_]+$/);
    updateSql = `UPDATE ${table} SET ${columns.map((key, index) => `${key} = $${index + 1}`).join(", ")} WHERE id = $${columns.length + 1}`;
    await tx.query(updateSql, [...Object.values(values), id]);
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
  const restoreOriginal = async () => {
    const restore = await database.beginTransaction();
    try {
      await restore.query(updateSql, [...columns.map((key) => original[key]), id]);
      await restore.commit();
    } catch (error) {
      await restore.rollback();
      throw error;
    }
  };
  try {
    if (table === "scientific_budget_reservations") {
      await withChangedAdmissionFixture(
        database,
        "scientific_mission_budgets",
        String(original.budget_id),
        (payload) => {
          const budget = MissionBudgetSchema.parse(payload);
          return {
            ...budget,
            reservations: budget.reservations.map((item) => (item.id === id ? changed : item)),
          };
        },
        check,
      );
    } else {
      await check();
    }
  } finally {
    await restoreOriginal();
  }
}

async function assertMdSubmissionAuthorityRead(
  database: DatabaseLike,
  store: ScientificStore,
  workUnit: WorkUnit,
  operation: ExternalOperation,
): Promise<void> {
  const at = Date.parse(T5);
  const reader = new ScientificEffectReconciliationStore(database, () => new Date(at));
  const input = {
    operationId: operation.id,
    claimOwner: owner.id,
    currentPolicyDigest: policyDigest,
  };
  const admission = (await store.getEffectAdmission(operation.id))!;
  const snapshot = await reader.readMdSubmissionAuthority(input);
  expect(snapshot.admission).toEqual(admission);
  expect(snapshot.operation).toEqual(operation);
  expect(snapshot.checkedAt).toBe(T5);
  expect(snapshot.expiresAt).toBe(new Date(at + 60_000).toISOString());
  expect(snapshot.stage.id).toBe(
    MdExecutionBindingParametersSchema.parse(workUnit.protocolFragment.parameters).stage.id,
  );
  const binding = MdExecutionBindingParametersSchema.parse(workUnit.protocolFragment.parameters);
  for (const id of [
    binding.plan.approvalRef,
    binding.system.approvalRef,
    binding.protocol.approvalRef,
    ...binding.decisions.map((item) => item.approvalRef),
  ])
    expect(snapshot.approvals.some((item) => item.id === id)).toBe(true);
  if (binding.replicaSegment)
    expect(snapshot.approvals.filter((item) => item.subjectType === "replica_set")).toHaveLength(1);
  const originalWorkUnit = await store.getWorkUnit(workUnit.id);
  const unchanged = async () => {
    expect(await store.getEffectAdmission(operation.id)).toEqual(admission);
    expect(await store.getExternalOperation(operation.id)).toEqual(operation);
    expect(await store.getWorkUnit(workUnit.id)).toEqual(originalWorkUnit);
  };
  await expect(
    reader.readMdSubmissionAuthority({ ...input, claimOwner: "another-head" }),
  ).rejects.toThrow();
  await expect(
    reader.readMdSubmissionAuthority({ ...input, currentPolicyDigest: D("0") }),
  ).rejects.toThrow();
  await expect(
    reader.readMdSubmissionAuthority({ ...input, operationId: "missing" }),
  ).rejects.toThrow();
  // No caller-supplied at can extend authority. Live clocks are evaluated after
  // all I/O and again after the actual DB commit, including non-monotonic clocks.
  for (const times of [
    [at, at, at + 60_000],
    [at, at, at, at + 60_000],
    [at, at - 1],
    [at, at, at - 1],
    [at, at, at, at - 1],
    [NaN],
    [Date.parse("2026-08-24T00:00:00.000Z")],
  ]) {
    let index = 0;
    const delayed = new ScientificEffectReconciliationStore(
      database,
      () => new Date(times[Math.min(index++, times.length - 1)]!),
    );
    await expect(delayed.readMdSubmissionAuthority(input)).rejects.toThrow();
    await unchanged();
  }
  const reject = async () => {
    await expect(reader.readMdSubmissionAuthority(input)).rejects.toThrow();
  };
  for (const approval of snapshot.approvals) {
    for (const patch of [{ state: "superseded" }, { expiresAt: T5 }, { policyDigest: D("0") }]) {
      await withChangedAdmissionFixture(
        database,
        "scientific_approval_requests",
        approval.id,
        (payload) => ({ ...payload, ...patch }),
        reject,
      );
    }
    // All approvals, not just the plan, determine the transport's maximum TTL.
    if (approval.id !== admission.approvalId) {
      await withChangedAdmissionFixture(
        database,
        "scientific_approval_requests",
        approval.id,
        (payload) => ({ ...payload, expiresAt: new Date(at + 7_000).toISOString() }),
        async () => {
          expect((await reader.readMdSubmissionAuthority(input)).expiresAt).toBe(
            new Date(at + 7_000).toISOString(),
          );
        },
      );
    }
  }
  for (const state of ["paused", "replanning", "cancel_requested", "completed"])
    await withChangedAdmissionFixture(
      database,
      "scientific_missions",
      operation.missionId,
      (payload) => ({ ...payload, state }),
      reject,
    );
  await withChangedAdmissionFixture(
    database,
    "scientific_missions",
    operation.missionId,
    (payload) => ({ ...payload, activePlanId: null }),
    reject,
  );
  for (const patch of [{ status: "superseded" }, { revision: admission.plan.revision + 1 }])
    await withChangedAdmissionFixture(
      database,
      "scientific_plans",
      workUnit.planId,
      (payload) => ({ ...payload, ...patch }),
      reject,
    );
  for (const patch of [
    { state: "observing" },
    { state: "cancel_requested" },
    { claimOwner: "other-head" },
    { jobId: "different-job" },
    { attemptId: "different-attempt" },
    { revision: admission.fencingGeneration },
    { claimExpiresAt: T5 },
  ])
    await withChangedAdmissionFixture(
      database,
      "scientific_work_units",
      workUnit.id,
      (payload) => ({ ...payload, ...patch }),
      reject,
    );
  for (const patch of [
    { state: "acknowledged" },
    { state: "ambiguous" },
    { externalIdentity: { jobId: "123" } },
    { requestDigest: D("0") },
  ])
    await withChangedAdmissionFixture(
      database,
      "scientific_external_operations",
      operation.id,
      (payload) => ({ ...payload, ...patch }),
      reject,
    );
  for (const [table, id, patch] of [
    ["scientific_missions", operation.missionId, { payload_digest: D("0") }],
    ["scientific_plans", workUnit.planId, { plan_digest: D("0") }],
    ["scientific_work_units", workUnit.id, { payload_digest: D("0") }],
    ["scientific_external_operations", operation.id, { request_digest: D("0") }],
  ] as const)
    await withChangedAdmissionFixture(database, table, id, (payload) => payload, reject, patch);
  await unchanged();

  if (database._provider === "postgres" && binding.stage.sequence === 1) {
    for (const mode of ["expire", "revoke"] as const) {
      // Hold a real PostgreSQL row lock, start the reader on a second connection,
      // observe its lock wait, then advance the clock and commit a revocation.
      // No mock query/result or process-local lock stands in for the database.
      const blocker = (await database.beginTransaction()) as ScientificTransaction;
      const approvalId = binding.system.approvalRef;
      const [original] = await blocker.queryRows<{ payload_json: string }>(
        "SELECT payload_json FROM scientific_approval_requests WHERE id = $1 FOR UPDATE",
        [approvalId],
      );
      let live = at;
      const waiting = new ScientificEffectReconciliationStore(database, () => new Date(live));
      const observed = waiting.readMdSubmissionAuthority(input).then(
        () => ({ rejected: false }),
        () => ({ rejected: true }),
      );
      let committed = false;
      const restoreApproval = async () => {
        const restore = await database.beginTransaction();
        try {
          await restore.query(
            "UPDATE scientific_approval_requests SET state = 'approved', payload_json = $1 WHERE id = $2",
            [original!.payload_json, approvalId],
          );
          await restore.commit();
        } catch (error) {
          await restore.rollback();
          throw error;
        }
      };
      try {
        const deadline = Date.now() + 3_000;
        let foundWait = false;
        while (Date.now() < deadline) {
          // Migration fixtures intentionally have a two-connection pool. Inspect
          // waits using the already-held blocker connection, not a third checkout.
          await blocker.query("SELECT pg_stat_clear_snapshot()");
          const rows = await blocker.queryRows<{ n: string }>(
            "SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%scientific_approval_requests%'",
          );
          foundWait = Number(rows[0]!.n) > 0;
          if (foundWait) break;
          await Bun.sleep(10);
        }
        expect(foundWait).toBe(true);
        if (mode === "revoke") {
          const revoked = { ...JSON.parse(original!.payload_json), state: "superseded" };
          await blocker.query(
            "UPDATE scientific_approval_requests SET state = $1, payload_json = $2 WHERE id = $3",
            [revoked.state, canonicalJson(revoked), approvalId],
          );
        }
        live = at + (mode === "expire" ? 60_000 : 10);
        await blocker.commit();
        committed = true;
      } finally {
        if (!committed) await blocker.rollback();
        await observed;
        // Restore the fixture only after the reader has released its own locks.
        await restoreApproval();
      }
      expect((await observed).rejected).toBe(true);
      await unchanged();
    }
  }
}

const deliveryPrincipal = {
  subject: reviewer.id,
  projectId: "project-md-fixture",
  uid: 2101,
  gid: 2000,
  siteProfileDigest: D("a"),
};
// Ephemeral fixture key only. Neither a site secret nor approval of a real run.
const deliveryKey = generateKeyPairSync("ed25519");
const deliveryPrivateKey = deliveryKey.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

async function exerciseMdDeliveryPersistence(
  database: DatabaseLike,
  store: ScientificStore,
  operation: ExternalOperation,
) {
  const reader = new ScientificEffectReconciliationStore(database, () => new Date(T5));
  const input = {
    operationId: operation.id,
    claimOwner: owner.id,
    currentPolicyDigest: policyDigest,
  };
  const original = await store.getEffectAdmission(operation.id);
  const projectRows = async () => {
    const tx = (await database.beginTransaction()) as ScientificTransaction;
    try {
      return await tx.queryRows("SELECT * FROM scientific_mission_projects WHERE mission_id = $1", [
        operation.missionId,
      ]);
    } finally {
      await tx.rollback();
    }
  };
  const originalProjectRows = await projectRows();
  // This is a typed transport fixture, NOT a verified Amber input bundle or
  // script. A signature test never starts Slurm/Amber or qualifies that backend.
  const typedBody = (authority: MdSubmissionAuthority) => ({
    schemaVersion: "eigengrid.amber-slurm-delivery/v1" as const,
    request: MdStageOperationRequestSchema.parse(authority.operation.request),
    binding: createSlurmSubmissionBinding({
      operationId: operation.id,
      requestDigest: operation.requestDigest,
      admissionDigest: authority.admission.admissionDigest,
      scriptDigest: C(`fixture-script-only:${operation.id}`),
      siteProfileDigest: deliveryPrincipal.siteProfileDigest,
      uid: deliveryPrincipal.uid,
      cluster: "fixture-cluster",
      notBefore: authority.checkedAt,
      expiresAt: authority.expiresAt,
      resources: {
        partition: "chem",
        node: "worker-01",
        account: "fixture-account",
        cpus: 1,
        memoryMiB: 128,
        walltimeSeconds: 60,
      },
    }),
    bundle: { sha256: C("fixture-bundle-NOT-REAL"), sizeBytes: 1234 },
  });
  const draft = (authority: MdSubmissionAuthority): MdDeliveryDraft =>
    createAmberSlurmDeliveryDraft(authority, deliveryPrincipal, typedBody(authority));
  const authority = await reader.readMdSubmissionAuthority(input);
  const body = effectDeliveryBody(draft(authority));
  const siteGrant = {
    principal: deliveryPrincipal,
    recoveryEpoch: "fixture-epoch-1",
    membershipGeneration: 1,
    currentPolicyDigest: policyDigest,
  };
  const signer = (db: ScientificDatabase = database, grant = siteGrant, now = T5) =>
    new HeadMdDeliverySigner(
      db,
      () => grant,
      (value) => {
        buildCount++;
        return typedBody(value);
      },
      deliveryPrivateKey,
      () => new Date(now),
    );
  const assertAbsent = async () => {
    expect(await reader.readMdSubmissionDelivery(operation.id, deliveryPrincipal)).toBeNull();
    expect(await projectRows()).toEqual(originalProjectRows);
    expect(await store.getEffectAdmission(operation.id)).toEqual(original);
    expect(await store.getExternalOperation(operation.id)).toEqual(operation);
  };
  await expect(reader.readMdDeliverySigningAuthority(input, deliveryPrincipal)).rejects.toThrow(
    "exact committed MD delivery",
  );
  const valid = typedBody(authority);
  for (const changed of [
    { ...valid, script: "arbitrary-command" },
    { ...valid, bundle: { ...valid.bundle, path: "../../other" } },
    { ...valid, request: { ...valid.request, argv: ["sh"] } },
    { ...valid, bundle: { ...valid.bundle, sizeBytes: 1024 ** 3 + 1 } },
    { ...valid, binding: { ...valid.binding, bindingDigest: D("f") } },
  ])
    expect(() => createAmberSlurmDeliveryDraft(authority, deliveryPrincipal, changed)).toThrow();
  const {
    bindingDigest: _bindingDigest,
    schemaVersion: _bindingVersion,
    ...bindingInput
  } = valid.binding;
  for (const changed of [
    { uid: 2103 },
    { siteProfileDigest: D("b") },
    { operationId: "wrong-operation" },
    { admissionDigest: D("b") },
    { requestDigest: D("b") },
    { notBefore: T4 },
    { resources: { ...bindingInput.resources, cpus: 2 } },
    { resources: { ...bindingInput.resources, memoryMiB: 256 } },
    { resources: { ...bindingInput.resources, walltimeSeconds: 120 } },
  ])
    expect(() =>
      createAmberSlurmDeliveryDraft(authority, deliveryPrincipal, {
        ...valid,
        binding: createSlurmSubmissionBinding({ ...bindingInput, ...changed }),
      }),
    ).toThrow();
  if (database._provider === "sqlite") expect(() => signer()).toThrow("requires PostgreSQL");
  for (const bad of [
    { bodyBase64: "YQ==\n" },
    { bodyBase64: "====" },
    { notBefore: T4 },
    { expiresAt: "2026-08-24T00:01:00.000Z" },
    { bodyBase64: Buffer.alloc(512 * 1024 + 1).toString("base64") },
  ]) {
    await expect(
      reader.prepareMdSubmissionDelivery(input, deliveryPrincipal, (authority) => ({
        ...draft(authority),
        ...bad,
      })),
    ).rejects.toThrow();
    await assertAbsent();
  }
  await expect(
    reader.prepareMdSubmissionDelivery(
      input,
      { ...deliveryPrincipal, subject: "not-owner" },
      draft,
    ),
  ).rejects.toThrow();
  await expect(
    reader.prepareMdSubmissionDelivery(
      input,
      { ...deliveryPrincipal, projectId: "missing-project" },
      draft,
    ),
  ).rejects.toThrow();
  // The pure builder must not be able to mutate persistence's authority snapshot.
  let slowClock = Date.parse(T5);
  const slow = new ScientificEffectReconciliationStore(database, () => new Date(slowClock));
  await expect(
    slow.prepareMdSubmissionDelivery(input, deliveryPrincipal, (authority) => {
      const value = draft(authority);
      slowClock += 60_000;
      return value;
    }),
  ).rejects.toThrow("expired during preparation");
  await assertAbsent();

  // Injected storage failure inside a REAL transaction must roll back the
  // delivery without mutating the pre-existing mission/project association.
  // Only fixture DBs are used here.
  const failingDb: ScientificDatabase = {
    _provider: database._provider,
    beginTransaction: async () => {
      const tx = await database.beginTransaction();
      const query = tx.query.bind(tx);
      tx.query = async (sql, params) => {
        if (sql.includes("INSERT INTO scientific_effect_deliveries"))
          throw new Error("injected delivery storage failure");
        return query(sql, params);
      };
      return tx;
    },
  };
  await expect(
    new ScientificEffectReconciliationStore(
      failingDb,
      () => new Date(T5),
    ).prepareMdSubmissionDelivery(input, deliveryPrincipal, draft),
  ).rejects.toThrow("injected delivery storage failure");
  await assertAbsent();

  let buildCount = 0;
  const build = (authority: MdSubmissionAuthority) => {
    buildCount++;
    return draft(authority);
  };
  const sequence = MdExecutionBindingParametersSchema.parse(
    (await store.getWorkUnit(operation.workUnitId))!.protocolFragment.parameters,
  ).stage.sequence;
  if (database._provider === "postgres" && operation.id === "operation-equilibration") {
    const changedDuringPreparation = new HeadMdDeliverySigner(
      database,
      () => siteGrant,
      (value) => {
        buildCount++;
        // Simulate root membership generation changing during durable prepare.
        // The immutable delivery remains, but no first-submit wire may escape.
        siteGrant.membershipGeneration++;
        return typedBody(value);
      },
      deliveryPrivateKey,
      () => new Date(T5),
    );
    await expect(changedDuringPreparation.prepare(input)).rejects.toThrow("Site authority changed");
    expect((await signer().prepare(input)).action).toBe("observe");
  } else if (sequence === 1) {
    expect(await projectRows()).toEqual(originalProjectRows);
    const lostAck: ScientificDatabase = {
      _provider: database._provider,
      beginTransaction: async () => {
        const tx = await database.beginTransaction();
        let insertedDelivery = false;
        const query = tx.query.bind(tx);
        tx.query = async (sql, params) => {
          const result = await query(sql, params);
          if (sql.includes("INSERT INTO scientific_effect_deliveries")) insertedDelivery = true;
          return result;
        };
        const commit = tx.commit.bind(tx);
        tx.commit = async () => {
          await commit();
          if (insertedDelivery) throw new Error("delivery COMMIT ACK lost");
        };
        return tx;
      },
    };
    await expect(
      database._provider === "postgres"
        ? signer(lostAck).prepare(input)
        : new ScientificEffectReconciliationStore(
            lostAck,
            () => new Date(T5),
          ).prepareMdSubmissionDelivery(input, deliveryPrincipal, build),
    ).rejects.toThrow("delivery COMMIT ACK lost");
  } else if (database._provider === "postgres") {
    // Real PG contenders reach the actual Head signer: only the creator receives
    // a submit capability, the other receives observe, both cover identical bytes.
    const results = await Promise.all([signer().prepare(input), signer().prepare(input)]);
    expect(results.map((item) => item.action).sort()).toEqual(["observe", "submit"]);
    expect(results[0]!.delivery).toEqual(results[1]!.delivery);
    for (const result of results) {
      const envelope = JSON.parse(Buffer.from(result.wire).toString());
      const payload = Buffer.from(envelope.payload, "base64");
      expect(
        verify(
          null,
          Buffer.concat([Buffer.from(SUBMITTER_SIGNATURE_DOMAIN), payload]),
          deliveryKey.publicKey,
          Buffer.from(envelope.signature, "base64"),
        ),
      ).toBe(true);
      expect(Buffer.from(envelope.body, "base64").equals(body)).toBe(true);
      expect(JSON.parse(payload.toString())).toEqual(result.capability);
      expect(result.capability.operationId).toBe(operation.id);
      expect(result.capability.admissionDigest).toBe(original!.admissionDigest);
      expect(result.capability.uid).toBe(2101);
      expect(result.capability.fencingGeneration).toBe(original!.fencingGeneration);
      const publicHex = (deliveryKey.publicKey.export({ type: "spki", format: "der" }) as Buffer)
        .subarray(12)
        .toString("hex");
      const script = [
        "import sys",
        `sys.path.insert(0, ${JSON.stringify(join(import.meta.dir, "../../../python/src"))})`,
        "from eigengrid_submitter.authority import SubmitterPolicy, authenticate_request, compact_json",
        `policy=SubmitterPolicy(uid=2101,gid=2000,head_uid=997,recovery_epoch='fixture-epoch-1',site_profile_digest='${deliveryPrincipal.siteProfileDigest}',public_key_hex='${publicHex}',memberships={('scientist-1','project-md-fixture'):1})`,
        `request=authenticate_request(sys.stdin.buffer.read(),policy,${Date.parse(T5)})`,
        "sys.stdout.buffer.write(compact_json(request.identity))",
      ].join("\n");
      const receiver = Bun.spawn(["python3", "-I", "-c", script], {
        stdin: result.wire,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(receiver.stdout).text(),
        new Response(receiver.stderr).text(),
        receiver.exited,
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(JSON.parse(stdout)).toMatchObject({
        operationId: operation.id,
        admissionDigest: original!.admissionDigest,
        bodyDigest: result.delivery.bodyDigest,
        bindingDigest: result.delivery.bindingDigest,
        uid: 2101,
      });
    }
  } else {
    expect(
      (await reader.prepareMdSubmissionDelivery(input, deliveryPrincipal, build)).created,
    ).toBe(true);
  }
  expect(buildCount).toBe(1);
  const persisted = (await reader.readMdSubmissionDelivery(operation.id, deliveryPrincipal))!;
  expect(effectDeliveryBody(persisted)).toEqual(body);
  expect(parseAmberSlurmDelivery(persisted)).toEqual(valid);
  for (const bytes of [
    Buffer.from(`${body.toString()} `),
    Buffer.from(`{"schemaVersion":"ignored-duplicate",${body.toString().slice(1)}`),
    Buffer.from([0xff]),
    Buffer.from(
      canonicalJson({ ...valid, bundle: { ...valid.bundle, path: "/home/another-user" } }),
    ),
  ]) {
    const { deliveryDigest: _previousDigest, ...unsigned } = persisted;
    const changed = {
      ...unsigned,
      bodyBase64: bytes.toString("base64"),
      bodyDigest: createHash("sha256").update(bytes).digest("hex"),
    };
    expect(() =>
      parseAmberSlurmDelivery({ ...changed, deliveryDigest: digestCanonical(changed) }),
    ).toThrow();
  }
  expect((await reader.readMdDeliverySigningAuthority(input, deliveryPrincipal)).delivery).toEqual(
    persisted,
  );
  const repeated = await reader.prepareMdSubmissionDelivery(input, deliveryPrincipal, () => {
    throw new Error("A duplicate must not call the builder or generate a new window");
  });
  expect(repeated).toEqual({ delivery: persisted, created: false });
  const afterExpiry = new ScientificEffectReconciliationStore(
    database,
    () => new Date("2026-08-25T00:00:00.000Z"),
  );
  expect(await afterExpiry.readMdSubmissionDelivery(operation.id, deliveryPrincipal)).toEqual(
    persisted,
  );
  await expect(
    afterExpiry.prepareMdSubmissionDelivery(input, deliveryPrincipal, draft),
  ).rejects.toThrow();
  await expect(
    afterExpiry.readMdDeliverySigningAuthority(input, deliveryPrincipal),
  ).rejects.toThrow();
  if (database._provider === "postgres") {
    const restarted = signer(
      database,
      { ...siteGrant, recoveryEpoch: "fixture-epoch-2", membershipGeneration: 2 },
      "2026-08-25T00:00:00.000Z",
    );
    const result = await restarted.prepare(input);
    expect(result.action).toBe("observe");
    expect(result.delivery).toEqual(persisted);
    expect(result.capability.recoveryEpoch).toBe("fixture-epoch-2");
    expect(result.capability.membershipGeneration).toBe(2);
    expect(result.capability.notBeforeMs).toBeGreaterThan(Date.parse(persisted.expiresAt));
    expect(result.capability.bindingDigest).toBe(persisted.bindingDigest);
    expect(result.capability.bodyDigest).toBe(persisted.bodyDigest);
    expect(buildCount).toBe(1);
    expect((await restarted.observe(operation.id)).action).toBe("observe");
    const observations = [Date.parse(T5), Date.parse(T5), Date.parse(T5) + 60_000];
    const expiresWhileSigning = new HeadMdDeliverySigner(
      database,
      () => siteGrant,
      () => {
        throw new Error("No rebuild");
      },
      deliveryPrivateKey,
      () => new Date(observations.shift() ?? Date.parse(T5) + 60_000),
    );
    await expect(expiresWhileSigning.observe(operation.id)).rejects.toThrow(
      "expired or changed while signing",
    );
    const backwards = [Date.parse(T5) + 1000, Date.parse(T5)];
    const regressesWhileReading = new HeadMdDeliverySigner(
      database,
      () => siteGrant,
      () => {
        throw new Error("No rebuild");
      },
      deliveryPrivateKey,
      () => new Date(backwards.shift() ?? Date.parse(T5)),
    );
    await expect(regressesWhileReading.observe(operation.id)).rejects.toThrow("clock regressed");
  }
  for (const principal of [
    { ...deliveryPrincipal, uid: 2103 },
    { ...deliveryPrincipal, gid: 2103 },
    { ...deliveryPrincipal, subject: "not-owner" },
    { ...deliveryPrincipal, siteProfileDigest: D("b") },
  ]) {
    await expect(reader.readMdSubmissionDelivery(operation.id, principal)).rejects.toThrow();
    await expect(reader.prepareMdSubmissionDelivery(input, principal, draft)).rejects.toThrow();
    await expect(reader.readMdDeliverySigningAuthority(input, principal)).rejects.toThrow();
    if (database._provider === "postgres")
      await expect(signer(database, { ...siteGrant, principal }).prepare(input)).rejects.toThrow();
  }
  const changeMembership = async (column: string, value: string, check: () => Promise<void>) => {
    const tx = (await database.beginTransaction()) as ScientificTransaction;
    const [member] = await tx.queryRows<Record<string, unknown>>(
      "SELECT * FROM project_memberships WHERE user_id = $1 AND project_id = $2",
      [reviewer.id, deliveryPrincipal.projectId],
    );
    if (column !== "role") throw new Error("Only role fixture mutation is supported");
    await tx.query("UPDATE project_memberships SET role = $1 WHERE id = $2", [value, member!.id]);
    await tx.commit();
    try {
      await check();
    } finally {
      const restore = await database.beginTransaction();
      await restore.query("UPDATE project_memberships SET role = $1 WHERE id = $2", [
        member!.role,
        member!.id,
      ]);
      await restore.commit();
    }
  };
  await changeMembership("role", "viewer", async () => {
    expect(await reader.readMdSubmissionDelivery(operation.id, deliveryPrincipal)).toEqual(
      persisted,
    );
    await expect(
      reader.prepareMdSubmissionDelivery(input, deliveryPrincipal, draft),
    ).rejects.toThrow();
    await expect(reader.readMdDeliverySigningAuthority(input, deliveryPrincipal)).rejects.toThrow();
    if (database._provider === "postgres")
      expect((await signer().prepare(input)).action).toBe("observe");
  });
  await changeMembership("role", "revoked", async () => {
    await expect(
      reader.readMdSubmissionDelivery(operation.id, deliveryPrincipal),
    ).rejects.toThrow();
    if (database._provider === "postgres") await expect(signer().prepare(input)).rejects.toThrow();
  });
  await database.disableUser(reviewer.id);
  await expect(reader.readMdSubmissionDelivery(operation.id, deliveryPrincipal)).rejects.toThrow();
  if (database._provider === "postgres")
    await expect(signer().observe(operation.id)).rejects.toThrow();
  await database.enableUser(reviewer.id);
  expect(await reader.readMdSubmissionDelivery(operation.id, deliveryPrincipal)).toEqual(persisted);
  expect(await store.getEffectAdmission(operation.id)).toEqual(original);
  expect(await store.getExternalOperation(operation.id)).toEqual(operation);
  return persisted;
}

async function assertMdAdmissionNegatives(
  database: DatabaseLike,
  store: ScientificStore,
  effects: ScientificEffectReconciliationStore,
  workUnit: WorkUnit,
  intent: ExternalOperation,
  begin: BeginWorkUnitEffectInput,
): Promise<void> {
  const binding = MdExecutionBindingParametersSchema.parse(workUnit.protocolFragment.parameters);
  const rejected = async (candidate = begin) => {
    await expect(effects.beginWorkUnitEffect(candidate)).rejects.toThrow();
    expect(await store.getEffectAdmission(intent.id)).toBeNull();
    expect(await store.getExternalOperation(intent.id)).toMatchObject({
      state: "intent",
      revision: 1,
    });
    expect(await store.getWorkUnit(workUnit.id)).toMatchObject({
      state: "claimed",
      revision: begin.expectedWorkUnitRevision,
      jobId: null,
      attemptId: null,
    });
  };
  await rejected({ ...begin, currentPolicyDigest: D("0") });
  await rejected({ ...begin, at: T4 }); // Future human decision/claim cannot authorize an effect.
  await rejected({ ...begin, at: "2026-08-24T00:00:00.000Z" }); // Exact expiry is expired.
  await rejected({ ...begin, jobId: "forged-job", attemptId: "forged-attempt" });

  // Historical mission ownership does not survive a current access revocation.
  // These checks run at the MD effect boundary itself: no admission, frozen
  // delivery, WorkUnit execution transition, or socket RPC can be justified
  // from an association that merely exists in history.
  await database.disableUser(reviewer.id);
  try {
    await rejected();
  } finally {
    await database.enableUser(reviewer.id);
  }
  await database.archiveProject(deliveryPrincipal.projectId);
  let archivedProjectRejection: unknown;
  try {
    await rejected();
  } catch (error) {
    archivedProjectRejection = error;
  }
  const restoreProject = await database.beginTransaction();
  try {
    await restoreProject.query("UPDATE projects SET status = 'active' WHERE id = $1", [
      deliveryPrincipal.projectId,
    ]);
    await restoreProject.commit();
  } catch (error) {
    await restoreProject.rollback();
    throw error;
  }
  if (archivedProjectRejection) throw archivedProjectRejection;
  const membershipTx = (await database.beginTransaction()) as ScientificTransaction;
  let originalMembershipRole: string;
  try {
    const [membership] = await membershipTx.queryRows<{ id: string; role: string }>(
      "SELECT id, role FROM project_memberships WHERE project_id = $1 AND user_id = $2",
      [deliveryPrincipal.projectId, reviewer.id],
    );
    if (!membership) throw new Error("Missing fixture project membership");
    originalMembershipRole = membership.role;
    await membershipTx.query("UPDATE project_memberships SET role = $1 WHERE id = $2", [
      "revoked",
      membership.id,
    ]);
    await membershipTx.commit();
  } catch (error) {
    await membershipTx.rollback();
    throw error;
  }
  let revokedMembershipRejection: unknown;
  try {
    await rejected();
  } catch (error) {
    revokedMembershipRejection = error;
  }
  const restoreMembership = await database.beginTransaction();
  try {
    await restoreMembership.query(
      "UPDATE project_memberships SET role = $1 WHERE project_id = $2 AND user_id = $3",
      [originalMembershipRole!, deliveryPrincipal.projectId, reviewer.id],
    );
    await restoreMembership.commit();
  } catch (error) {
    await restoreMembership.rollback();
    throw error;
  }
  if (revokedMembershipRejection) throw revokedMembershipRejection;

  const approvalIds = new Set([
    binding.plan.approvalRef,
    binding.system.approvalRef,
    binding.protocol.approvalRef,
    ...binding.decisions.map((decision) => decision.approvalRef),
    ...(binding.replicaSegment ? ["approval-replica-set-1"] : []),
  ]);
  const snapshot = (await database.beginTransaction()) as ScientificTransaction;
  const approvalRows = await snapshot.queryRows<{ payload_json: string }>(
    "SELECT payload_json FROM scientific_approval_requests WHERE mission_id = $1",
    [workUnit.missionId],
  );
  await snapshot.commit();
  const approvals = approvalRows.map((row) =>
    ApprovalRequestSchema.parse(JSON.parse(row.payload_json)),
  );
  for (const id of approvalIds) {
    for (const columnPatch of [{ state: "superseded" }, { policy_digest: D("0") }]) {
      await withChangedAdmissionFixture(
        database,
        "scientific_approval_requests",
        id,
        (payload) => payload,
        () => rejected(),
        columnPatch,
      );
    }
    for (const patch of [
      { expiresAt: T5 },
      { state: "superseded" },
      { policyDigest: D("0") },
      { missionId: "another-mission" },
      { requestedAt: "2026-08-23T00:06:00.000Z" },
    ]) {
      await withChangedAdmissionFixture(
        database,
        "scientific_approval_requests",
        id,
        (payload) => ({ ...payload, ...patch }),
        () => rejected(),
      );
    }
    const approval = approvals.find((approval) => approval.id === id)!;
    const responseId = approval.response!.id;
    // Change both copies: equality alone must not confer human authority.
    for (const response of [
      { ...approval.response!, actor: { ...reviewer, kind: "service" } },
      { ...approval.response!, actor: { ...reviewer, role: "unprivileged" } },
      { ...approval.response!, role: "unprivileged" },
      { ...approval.response!, decidedAt: "2026-08-23T00:06:00.000Z" },
      { ...approval.response!, approvalRequestId: "another-approval" },
    ]) {
      await withChangedAdmissionFixture(
        database,
        "scientific_approval_requests",
        id,
        (payload) => ({ ...payload, response }),
        () =>
          withChangedAdmissionFixture(
            database,
            "scientific_approval_responses",
            responseId,
            () => response,
            () => rejected(),
          ),
      );
    }
  }
  for (const patch of [
    { state: "released" },
    { state: "consumed" },
    { state: "ambiguous" },
    { amount: 0 },
    { amount: 2 },
    { kind: "wall_time_seconds" },
    { operationId: "another-operation" },
    { workUnitId: "another-work-unit" },
    { createdAt: "2026-08-23T00:06:00.000Z" },
  ]) {
    await withChangedAdmissionFixture(
      database,
      "scientific_budget_reservations",
      intent.budgetReservationId!,
      (payload) => ({ ...payload, ...patch }),
      () => rejected(),
    );
  }
  for (const id of workUnit.inputRefs) {
    for (const columnPatch of [
      { immutable: database._provider === "postgres" ? false : 0 },
      { content_digest: D("0") },
    ]) {
      await withChangedAdmissionFixture(
        database,
        "scientific_evidence",
        id,
        (payload) => payload,
        () => rejected(),
        columnPatch,
      );
    }
    for (const patch of [{ immutable: false }, { missionId: "another-mission" }]) {
      await withChangedAdmissionFixture(
        database,
        "scientific_evidence",
        id,
        (payload) => ({ ...payload, ...patch }),
        () => rejected(),
      );
    }
  }
  // Engine inputs (including a scientifically accepted parent restart) must
  // still have the exact content digests, not just immutable=true and an ID.
  const sourceOnly = "system-evidence";
  for (const id of workUnit.inputRefs.filter((id) => id !== sourceOnly)) {
    await withChangedAdmissionFixture(
      database,
      "scientific_evidence",
      id,
      (payload) => ({ ...payload, contentDigest: D("0") }),
      () => rejected(),
    );
  }
}

async function executeStageOperation(
  store: ScientificStore,
  database: DatabaseLike,
  workUnit: WorkUnit,
  operationId: string,
  receiptId: string,
) {
  await store.transitionWorkUnit({
    workUnitId: workUnit.id,
    expectedRevision: 1,
    to: "ready",
    at: T5,
  });
  const claim = await store.claimWorkUnit({
    workUnitId: workUnit.id,
    ownerId: owner.id,
    now: T5,
    expiresAt: "2026-08-24T00:00:00.000Z",
    policyDigest,
  });
  if (!claim.claimed) throw new Error(claim.message);
  const request = stageOperationRequestFor(workUnit);
  assertMdStageOperationRequestAuthority(workUnit, request);
  const intent = ExternalOperationSchema.parse({
    id: operationId,
    missionId: workUnit.missionId,
    workUnitId: workUnit.id,
    idempotencyKey: `${workUnit.missionId}/${workUnit.id}/fixture-md-stage`,
    kind: "md_stage_execution",
    state: "intent",
    request,
    requestDigest: digestCanonical(request),
    policyDigest,
    budgetReservationId: `reservation-${operationId}`,
    revision: 1,
    createdAt: T5,
    updatedAt: T5,
  });
  const budget = await store.getMissionBudget(workUnit.missionId);
  await store.reserveBudget({
    missionId: workUnit.missionId,
    expectedBudgetRevision: budget.revision,
    reservation: {
      id: intent.budgetReservationId!,
      workUnitId: workUnit.id,
      operationId,
      kind: "external_operation",
      amount: 1,
      state: "reserved",
      createdAt: T5,
      updatedAt: T5,
    },
  });
  await store.createOperationIntent(intent, { claimOwner: owner.id, now: T5 });
  const effects = new ScientificEffectReconciliationStore(database);
  const identity = mdStageEffectIdentity(intent);
  const begin = {
    operationId,
    expectedOperationRevision: 1,
    workUnitId: workUnit.id,
    expectedWorkUnitRevision: claim.workUnit.revision,
    claimOwner: owner.id,
    ...identity,
    currentPolicyDigest: policyDigest,
    at: T5,
  };
  await expect(
    effects.beginWorkUnitEffect({ ...begin, attemptId: "wrong-attempt" }),
  ).rejects.toThrow("exact coordinator identity");
  expect(await store.getEffectAdmission(operationId)).toBeNull();
  await expect(
    new ScientificEffectReconciliationStore(database, () => new Date(T5)).readMdSubmissionAuthority(
      { operationId, claimOwner: owner.id, currentPolicyDigest: policyDigest },
    ),
  ).rejects.toThrow();
  await assertMdAdmissionNegatives(database, store, effects, workUnit, intent, begin);
  let started: ExternalOperation;
  if (database._provider === "postgres") {
    // Two independent transactions contend for one exact MD admission. No
    // in-process mutex and no Slurm mock decides which caller wins.
    const contender = new ScientificEffectReconciliationStore(database);
    const outcomes = await Promise.allSettled([
      effects.beginWorkUnitEffect(begin),
      contender.beginWorkUnitEffect(begin),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const winner = outcomes.find((outcome) => outcome.status === "fulfilled")!;
    if (winner.status !== "fulfilled") throw new Error("Missing admission winner");
    started = winner.value.operation;
  } else {
    started = (await effects.beginWorkUnitEffect(begin)).operation;
  }
  expect(await store.getEffectAdmission(operationId)).toMatchObject({
    operationId,
    requestDigest: intent.requestDigest,
    ...identity,
  });
  expect(mdStageEffectIdentity(started)).toEqual(identity);
  await expect(effects.beginWorkUnitEffect(begin)).rejects.toThrow();
  expect((await store.getExternalOperation(operationId))?.revision).toBe(2);
  await assertMdSubmissionAuthorityRead(database, store, workUnit, started);
  const frozenDelivery = await exerciseMdDeliveryPersistence(database, store, started);
  const acknowledged = await store.transitionExternalOperation({
    operationId,
    expectedRevision: started.revision,
    to: "acknowledged",
    at: T5,
    externalIdentity: { fixtureProcess: operationId },
  });
  const receipt = OperationReceiptSchema.parse({
    id: receiptId,
    operationId,
    requestDigest: intent.requestDigest,
    status: "confirmed",
    externalIdentity: { fixtureProcess: operationId },
    ...identity,
    detailDigest: C(`receipt:${receiptId}`),
    recordedAt: T5,
  });
  await expect(
    new ScientificEffectReconciliationStore(database, () => new Date(T5)).readMdSubmissionAuthority(
      { operationId, claimOwner: owner.id, currentPolicyDigest: policyDigest },
    ),
  ).rejects.toThrow();
  await store.finalizeOperationReceipt(operationId, acknowledged.revision, receipt);
  expect(await effects.readMdSubmissionDelivery(operationId, deliveryPrincipal)).toEqual(
    frozenDelivery,
  );
  const reconcile = {
    operationId,
    workUnitId: workUnit.id,
    ...identity,
    outcome: "completed" as const,
    at: T5,
  };
  for (const patch of [
    { jobId: "forged-job" },
    { attemptId: "forged-attempt" },
    { externalIdentity: { jobId: "forged-job" } },
    { externalIdentity: { attemptId: 42 } },
  ]) {
    await withChangedAdmissionFixture(
      database,
      "scientific_operation_receipts",
      receipt.id,
      (payload) => ({ ...payload, ...patch }),
      async () => {
        await expect(effects.reconcileWorkUnitEffect(reconcile)).rejects.toThrow();
        expect((await store.getWorkUnit(workUnit.id))?.state).toBe("executing");
      },
    );
  }
  await withChangedAdmissionFixture(
    database,
    "scientific_external_operations",
    intent.id,
    (payload) => ({ ...payload, externalIdentity: { jobId: "forged-job" } }),
    async () => {
      await expect(effects.reconcileWorkUnitEffect(reconcile)).rejects.toThrow();
      expect((await store.getWorkUnit(workUnit.id))?.state).toBe("executing");
    },
  );
  await expect(
    effects.reconcileWorkUnitEffect({ ...reconcile, attemptId: "another-attempt" }),
  ).rejects.toThrow();
  const reconciled = await effects.reconcileWorkUnitEffect(reconcile);
  expect(reconciled.workUnit.state).toBe("observing"); // Execution is NOT scientific acceptance.
  expect(reconciled.transitionedThrough).toEqual(["observing"]);
  expect((await effects.reconcileWorkUnitEffect(reconcile)).alreadyReconciled).toBe(true);
  return receipt;
}

function stageOperationRequestFor(workUnit: WorkUnit) {
  const binding = MdExecutionBindingParametersSchema.parse(workUnit.protocolFragment.parameters);
  return MdStageOperationRequestSchema.parse({
    schemaVersion: MdStageOperationRequestSchemaVersion,
    workUnitId: workUnit.id,
    bindingDigest: digestCanonical(binding),
    outputContractDigest: digestCanonical(workUnit.outputContract),
    stage: {
      id: binding.stage.id,
      revision: binding.stage.revision,
      digest: binding.stage.digest,
      kind: binding.stage.kind,
    },
    environment: {
      canonicalSnapshotId: "fixture-environment-snapshot",
      canonicalSnapshotDigest: D("8"),
      engineEnvironmentDigest: fixtureEngineIdentity.environmentDigest,
      bindingVersion: "1.0.0",
      bindingDigest: D("9"),
      engine: fixtureEngineIdentity,
      binaryDigest: fixtureEngineIdentity.buildDigest,
    },
    render: {
      schemaVersion: "eigengrid.fixture-stage-render/v1",
      renderedStageDigest: C(`render:${workUnit.id}`),
      mapperVersion: "1.0.0",
      mapperDigest: D("a"),
      mdinDigest: D("b"),
      commandRequestDigest: D("c"),
    },
    outputs: {
      mappingVersion: "1.0.0",
      mappingDigest: D("d"),
      bindings: [
        {
          engineRole: "fixture.restart",
          canonicalRole: "restart",
          mediaType: "application/octet-stream",
          required: true,
        },
        {
          engineRole: "fixture.trajectory",
          canonicalRole: "trajectory",
          mediaType: "application/octet-stream",
          required: binding.stage.kind === "production",
        },
        {
          engineRole: "fixture.mdout",
          canonicalRole: "mdout",
          mediaType: "text/plain",
          required: true,
        },
        {
          engineRole: "fixture.mdinfo",
          canonicalRole: "mdinfo",
          mediaType: "text/plain",
          required: true,
        },
      ].filter(
        (output) => binding.stage.kind !== "minimization" || output.canonicalRole !== "trajectory",
      ),
    },
  });
}

/** Real-PG driver fixture transport body. It deliberately exercises the
 * production admission/delivery/signer rows while the submitter RPC itself is
 * a counted local boundary; root-owned Unix-socket/SO_PEERCRED qualification is
 * Level D and remains outside this test process. */
function driverTransportBody(authority: MdSubmissionAuthority) {
  const request = MdStageOperationRequestSchema.parse(authority.operation.request);
  const resources = authority.stage.resourceProfile;
  return {
    schemaVersion: "eigengrid.amber-slurm-delivery/v1" as const,
    request,
    binding: createSlurmSubmissionBinding({
      operationId: authority.operation.id,
      requestDigest: authority.operation.requestDigest,
      admissionDigest: authority.admission.admissionDigest,
      scriptDigest: C(`driver-pg-script:${authority.operation.id}`),
      siteProfileDigest: deliveryPrincipal.siteProfileDigest,
      uid: deliveryPrincipal.uid,
      cluster: "fixture-cluster",
      notBefore: authority.checkedAt,
      expiresAt: authority.expiresAt,
      resources: {
        partition: "chem",
        node: "worker-01",
        account: "fixture-account",
        cpus: resources.cpuCores,
        memoryMiB: Math.ceil(resources.memoryBytes / (1024 * 1024)),
        walltimeSeconds: resources.wallTimeSeconds,
      },
    }),
    bundle: { sha256: C(`driver-pg-bundle:${authority.operation.id}`), sizeBytes: 1234 },
  };
}

async function completeStageWorkUnit(
  store: ScientificStore,
  workUnitId: string,
  result: ReturnType<typeof stageResult>,
  assessment: ReturnType<typeof stageAssessment>,
  rejectedAssessment?: ReturnType<typeof stageAssessment>,
): Promise<void> {
  const observing = await store.getWorkUnit(workUnitId);
  if (!observing) throw new Error(`Missing WorkUnit ${workUnitId}`);
  expect(observing.state).toBe("observing");
  await expect(
    store.transitionWorkUnit({
      workUnitId,
      expectedRevision: observing.revision,
      to: "succeeded",
      at: T5,
      claimOwner: owner.id,
    }),
  ).rejects.toThrow("completeMdWorkUnit");
  if (rejectedAssessment) {
    await expect(
      store.completeMdWorkUnit({
        workUnitId,
        expectedRevision: observing.revision,
        stageResultId: result.id,
        stageResultDigest: result.resultDigest,
        assessmentId: rejectedAssessment.id,
        assessmentRevision: rejectedAssessment.revision,
        assessmentDigest: rejectedAssessment.assessmentDigest,
        at: T5,
        claimOwner: owner.id,
      }),
    ).rejects.toThrow();
  }
  await expect(
    store.completeMdWorkUnit({
      workUnitId,
      expectedRevision: observing.revision,
      stageResultId: result.id,
      stageResultDigest: D("e"),
      assessmentId: assessment.id,
      assessmentRevision: assessment.revision,
      assessmentDigest: assessment.assessmentDigest,
      at: T5,
      claimOwner: owner.id,
    }),
  ).rejects.toThrow();
  await store.completeMdWorkUnit({
    workUnitId,
    expectedRevision: observing.revision,
    stageResultId: result.id,
    stageResultDigest: result.resultDigest,
    assessmentId: assessment.id,
    assessmentRevision: assessment.revision,
    assessmentDigest: assessment.assessmentDigest,
    at: T5,
    claimOwner: owner.id,
  });
}

describe("material successor plan dependency boundaries", () => {
  test("only an approved immediate material successor can refer to its completed predecessor", () => {
    const binding = BiomolecularMaterialPublicationBindingSchema.parse({
      schemaVersion: BiomolecularMaterialPublicationBindingSchemaVersion,
      subjectKind: "force_field_stack",
      subject: { id: "unit-phase-stack", revision: 1, digest: D("a") },
      sourceEvidenceRefs: ["unit-phase-input"],
      artifactEvidenceRef: "unit-phase-output",
    });
    const previous = {
      ...materialPublicationWorkUnit(binding, {
        id: "unit-previous-phase",
        capabilityId: "amber.force-field-stack",
        contractDigest: D("b"),
      }),
      state: "succeeded" as const,
    };
    const current = {
      ...materialPublicationWorkUnit(binding, {
        id: "unit-current-phase",
        capabilityId: "biomolecular.build-system",
        contractDigest: D("c"),
        dependencies: [previous.id],
      }),
      planId: "unit-successor-plan",
      planVersion: 2,
    };
    const plan = {
      ...planFixture(),
      id: current.planId,
      version: 2,
      parentPlanId: previous.planId,
      status: "approved" as const,
    };
    // This relation does not replace the durable projection/receipt gate.
    expect(isCompletedMaterialPhaseDependency(current, previous, plan)).toBe(true);
    expect(
      isCompletedMaterialPhaseDependency(current, { ...previous, state: "observing" }, plan),
    ).toBe(false);
    expect(
      isCompletedMaterialPhaseDependency(
        current,
        { ...previous, missionId: "other-mission" },
        plan,
      ),
    ).toBe(false);
    expect(
      isCompletedMaterialPhaseDependency(current, previous, {
        ...plan,
        parentPlanId: "other-plan",
      }),
    ).toBe(false);
    expect(
      isCompletedMaterialPhaseDependency({ ...current, planVersion: 3 }, previous, {
        ...plan,
        version: 3,
      }),
    ).toBe(false);
    expect(
      isCompletedMaterialPhaseDependency(current, previous, { ...plan, status: "under_review" }),
    ).toBe(false);
    expect(
      isCompletedMaterialPhaseDependency(
        { ...current, dependencies: [previous.id, "unrelated"] },
        previous,
        plan,
      ),
    ).toBe(false);
    expect(
      isCompletedMaterialPhaseDependency(
        { ...current, approvalPolicy: { ...current.approvalPolicy, required: false } },
        previous,
        plan,
      ),
    ).toBe(false);
    expect(
      isCompletedMaterialPhaseDependency(
        {
          ...current,
          executionPolicy: { ...current.executionPolicy, capability: "amber.production-md" },
        },
        previous,
        plan,
      ),
    ).toBe(false);
  });
});

describe("MdProjectionStore durable exact projections", () => {
  test("Head signer rejects unprovisioned/non-Ed25519 keys before any DB access and hides the key from serialization", () => {
    const database: ScientificDatabase = {
      _provider: "postgres",
      beginTransaction: async () => {
        throw new Error("Constructor must not touch the database");
      },
    };
    const grant = () => {
      throw new Error("Constructor must not resolve user authority");
    };
    const builder = () => {
      throw new Error("Constructor must not prepare a delivery");
    };
    const otherKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    for (const key of ["not a key", otherKey])
      expect(() => new HeadMdDeliverySigner(database, grant, builder, key)).toThrow();
    const signer = new HeadMdDeliverySigner(database, grant, builder, deliveryPrivateKey);
    expect(JSON.stringify(signer)).not.toContain("PRIVATE KEY");
    expect(Object.keys(signer)).not.toContain("privateKeyPem");
  });

  test("rejects legacy, cross-bound, binary-drifted, and incomplete v2 stage authority", () => {
    const proposedDecision = constructDecision();
    const exactDecision = {
      ...proposedDecision,
      status: "approved" as const,
      approvalRef: "approval-construct-1",
      approvedAt: T4,
    };
    const atomMap = signedAtomMap();
    const stack = forceFieldStack();
    const exactForceField = {
      ...forceFieldDecision(stack),
      status: "approved" as const,
      approvalRef: "approval-force-field-decision-1",
      approvedAt: T4,
    };
    const exactProtonation = {
      ...receptorProtonationDecision(proposedDecision),
      status: "approved" as const,
      approvalRef: "approval-protonation-decision-1",
      approvedAt: T4,
    };
    const exactMembrane = {
      ...membraneModelDecision(),
      status: "approved" as const,
      approvalRef: "approval-membrane-decision-1",
      approvedAt: T4,
    };
    const manifest = systemManifest(
      {
        construct: exactDecision,
        forceField: exactForceField,
        protonation: exactProtonation,
        membrane: exactMembrane,
      },
      stack.stackDigest,
      atomMap.mapDigest,
    );
    const equilibration = stageSpec(manifest);
    const production = productionStageSpec(manifest, equilibration);
    const protocol = workflowProtocol(manifest, equilibration, production);
    const workUnit = capabilityWorkUnit(manifest, protocol, equilibration, exactDecision, {
      id: "work-unit-authority-negative",
      planApprovalRef: "approval-plan-1",
      systemApprovalRef: "approval-system-1",
      protocolApprovalRef: "approval-protocol-1",
    });
    const request = stageOperationRequestFor(workUnit);
    const identityIntent = ExternalOperationSchema.parse({
      id: "operation-authority-negative",
      missionId: workUnit.missionId,
      workUnitId: workUnit.id,
      idempotencyKey: "md-authority-identity",
      kind: "md_stage_execution",
      state: "intent",
      request,
      requestDigest: digestCanonical(request),
      policyDigest,
      revision: 1,
      createdAt: T5,
      updatedAt: T5,
    });
    const exactIdentity = mdStageEffectIdentity(identityIntent);
    expect(exactIdentity.jobId).toMatch(/^job-md-[a-f0-9]{64}$/);
    expect(exactIdentity.attemptId).toMatch(/^attempt-md-[a-f0-9]{64}$/);
    expect(
      mdStageEffectIdentity({ ...identityIntent, state: "acknowledged", revision: 3 }),
    ).toEqual(exactIdentity);
    expect(
      mdStageEffectIdentity({ ...identityIntent, id: "a-new-scientific-attempt" }),
    ).not.toEqual(exactIdentity);
    expect(mdStageEffectIdentity({ ...identityIntent, missionId: "another-mission" })).not.toEqual(
      exactIdentity,
    );
    const changedRequest = {
      ...request,
      environment: { ...request.environment, canonicalSnapshotId: "another-snapshot" },
    };
    expect(
      mdStageEffectIdentity({
        ...identityIntent,
        request: changedRequest,
        requestDigest: digestCanonical(changedRequest),
      }),
    ).not.toEqual(exactIdentity);
    for (const bad of [
      { ...identityIntent, request: changedRequest },
      { ...identityIntent, workUnitId: "another-work-unit" },
      { ...identityIntent, kind: "local_execution" as const },
      { ...identityIntent, request: { ...request, intendedJobId: "caller-selected-job" } },
    ]) {
      expect(() => mdStageEffectIdentity(bad)).toThrow();
    }
    const artifacts = [
      artifact("restart", C("authority-restart"), "authority-restart-evidence"),
      artifact("mdout", C("authority-mdout"), "authority-mdout-evidence"),
      artifact("mdinfo", C("authority-mdinfo"), "authority-mdinfo-evidence"),
    ];
    const result = stageResult(protocol, equilibration, {
      id: "stage-result-authority-negative",
      workUnitId: workUnit.id,
      operationId: "operation-authority-negative",
      operationReceiptId: "receipt-authority-negative",
      artifacts,
    });
    expect(assertMdStageOperationRequestAuthority(workUnit, request, result)).toEqual(request);
    // A forged minimization kind cannot remove the trajectory role of an MD WorkUnit.
    expect(() =>
      assertMdStageOperationRequestAuthority(workUnit, {
        ...request,
        stage: { ...request.stage, kind: "minimization" },
        outputs: {
          ...request.outputs,
          bindings: request.outputs.bindings.filter(
            (output) => output.canonicalRole !== "trajectory",
          ),
        },
      }),
    ).toThrow(/exact WorkUnit binding/);
    expect(() =>
      assertMdStageOperationRequestAuthority(workUnit, {
        schemaVersion: "eigengrid.md-stage-operation-request/v1",
        workUnitId: workUnit.id,
        bindingDigest: request.bindingDigest,
        outputContractDigest: request.outputContractDigest,
      }),
    ).toThrow();
    expect(() =>
      assertMdStageOperationRequestAuthority(workUnit, {
        ...request,
        bindingDigest: D("0"),
      }),
    ).toThrow(/exact WorkUnit binding/);
    expect(() =>
      assertMdStageOperationRequestAuthority(workUnit, {
        ...request,
        stage: { ...request.stage, id: production.id, digest: production.stageDigest },
      }),
    ).toThrow(/exact WorkUnit binding/);
    expect(() =>
      assertMdStageOperationRequestAuthority(workUnit, {
        ...request,
        outputs: {
          ...request.outputs,
          bindings: request.outputs.bindings.map((output) =>
            output.canonicalRole === "trajectory" ? { ...output, required: true } : output,
          ),
        },
      }),
    ).toThrow(/required evidence contract/);

    const wrongBinaryInput = {
      ...result,
      engine: { ...result.engine, buildDigest: D("1") },
      resultDigest: D("0"),
    };
    const wrongBinary = MdStageResultSchema.parse({
      ...wrongBinaryInput,
      resultDigest: computeMdStageResultDigest(wrongBinaryInput),
    });
    expect(() => assertMdStageOperationRequestAuthority(workUnit, request, wrongBinary)).toThrow(
      /engine authorization/,
    );
    const wrongEnvironmentInput = {
      ...result,
      engine: { ...result.engine, environmentDigest: D("2") },
      resultDigest: D("0"),
    };
    const wrongEnvironment = MdStageResultSchema.parse({
      ...wrongEnvironmentInput,
      resultDigest: computeMdStageResultDigest(wrongEnvironmentInput),
    });
    expect(() =>
      assertMdStageOperationRequestAuthority(workUnit, request, wrongEnvironment),
    ).toThrow(/engine authorization/);
    const unauthorizedArtifactInput = {
      ...result,
      artifacts: [
        ...result.artifacts,
        artifact(
          "normalized_metrics",
          C("authority-normalized-metrics"),
          "authority-normalized-metrics-evidence",
        ),
      ],
      resultDigest: D("0"),
    };
    const unauthorizedArtifact = MdStageResultSchema.parse({
      ...unauthorizedArtifactInput,
      resultDigest: computeMdStageResultDigest(unauthorizedArtifactInput),
    });
    expect(() =>
      assertMdStageOperationRequestAuthority(workUnit, request, unauthorizedArtifact),
    ).toThrow(/output-role authorization/);
    const incompleteInput = {
      ...result,
      artifacts: artifacts.filter((candidate) => candidate.role !== "mdinfo"),
      errors: [
        {
          code: "FIXTURE_ENGINE_FAILURE",
          severity: "error" as const,
          message: "Fixture stopped before every authorized output was collected",
          sourceEvidenceRefs: ["authority-mdout-evidence"],
        },
      ],
      resultDigest: D("0"),
    };
    const incomplete = MdStageResultSchema.parse({
      ...incompleteInput,
      terminalReason: "engine_failure",
      exitCode: 1,
      resultDigest: computeMdStageResultDigest({
        ...incompleteInput,
        terminalReason: "engine_failure",
        exitCode: 1,
      }),
    });
    expect(assertMdStageOperationRequestAuthority(workUnit, request, incomplete)).toEqual(request);
    const completedMissingInput = {
      ...result,
      artifacts: artifacts.filter((candidate) => candidate.role !== "mdout"),
      resultDigest: D("0"),
    };
    expect(() =>
      assertMdStageOperationRequestAuthority(workUnit, request, {
        ...completedMissingInput,
        resultDigest: computeMdStageResultDigest(completedMissingInput),
      }),
    ).toThrow();
    const failedMissingInput = {
      ...result,
      artifacts: artifacts.filter((candidate) => candidate.role !== "mdout"),
      terminalReason: "engine_failure" as const,
      exitCode: 1,
      errors: [
        {
          code: "FIXTURE_ENGINE_FAILURE",
          severity: "error" as const,
          message: "Fixture stopped before every authorized output was collected",
          sourceEvidenceRefs: ["authority-mdinfo-evidence"],
        },
      ],
      resultDigest: D("0"),
    };
    const failedWithoutRequired = MdStageResultSchema.parse({
      ...failedMissingInput,
      resultDigest: computeMdStageResultDigest(failedMissingInput),
    });
    expect(
      assertMdStageOperationRequestAuthority(workUnit, request, failedWithoutRequired),
    ).toEqual(request);
  });

  test("binds the selected ligand microstate structure, pH, and temperature exactly", () => {
    const proposedConstruct = constructDecision();
    const construct = {
      ...proposedConstruct,
      status: "approved" as const,
      approvalRef: "approval-construct-1",
      approvedAt: T4,
    };
    const stack = forceFieldStack();
    const forceField = {
      ...forceFieldDecision(stack),
      status: "approved" as const,
      approvalRef: "approval-force-field-decision-1",
      approvedAt: T4,
    };
    const protonation = {
      ...receptorProtonationDecision(proposedConstruct),
      status: "approved" as const,
      approvalRef: "approval-protonation-decision-1",
      approvedAt: T4,
    };
    const membrane = {
      ...membraneModelDecision(),
      status: "approved" as const,
      approvalRef: "approval-membrane-decision-1",
      approvedAt: T4,
    };
    const ligandCoordinateDigest = C("ligand-selected-microstate");
    const ligand = {
      schemaVersion: BiomolecularComponentSchemaVersion,
      id: "ligand-1",
      revision: 1,
      kind: "ligand" as const,
      name: "fixture ligand",
      sourceEvidenceRefs: ["ligand-evidence"],
      coordinateDigest: ligandCoordinateDigest,
      atomCount: 2,
      moleculeCount: 1,
      formalCharge: 1,
      inchiKey: `${"A".repeat(14)}-${"B".repeat(10)}-C`,
      stereochemistry: "achiral fixture",
      microstateDecisionId: "microstate-decision-1",
      poseDecisionId: "pose-decision-1",
    };
    const microstateBase = {
      schemaVersion: BiomolecularDecisionSchemaVersion,
      id: ligand.microstateDecisionId,
      missionId: "mission-md-1",
      revision: 1,
      status: "approved" as const,
      kind: "microstate" as const,
      rationale: "Select the exact ligand microstate fixture",
      evidenceRefs: ["ligand-microstate-evidence"],
      decidedBy: owner,
      approvalRef: "approval-microstate-1",
      approvedAt: T4,
      decisionDigest: D("0"),
      createdAt: T1,
      subjectComponentId: ligand.id,
      subjectKind: "ligand" as const,
      targetPh: 7.4,
      temperatureKelvin: 300,
      method: "fixture-enumerator 1.0.0",
      alternatives: [
        {
          id: "selected-ligand-state",
          label: "selected +1 state",
          formalCharge: 1,
          protonationDescription: "protonated fixture site",
          tautomerDescription: "selected fixture tautomer",
          structureDigest: ligandCoordinateDigest,
        },
      ],
      selectedAlternativeId: "selected-ligand-state",
      selectedFormalCharge: 1,
    };
    const microstate = MicrostateDecisionSchema.parse({
      ...microstateBase,
      decisionDigest: computeBiomolecularDecisionMaterialDigest(microstateBase),
    });
    const poseBase = {
      schemaVersion: BiomolecularDecisionSchemaVersion,
      id: ligand.poseDecisionId,
      missionId: "mission-md-1",
      revision: 1,
      status: "approved" as const,
      kind: "pose" as const,
      rationale: "Select an exact pose fixture",
      evidenceRefs: ["ligand-pose-evidence"],
      decidedBy: owner,
      approvalRef: "approval-pose-1",
      approvedAt: T4,
      decisionDigest: D("0"),
      createdAt: T1,
      receptorComponentId: "protein-1",
      ligandComponentId: ligand.id,
      pocketDefinitionDigest: D("c"),
      candidates: [
        {
          id: "selected-pose",
          method: "imported" as const,
          coordinateDigest: ligandCoordinateDigest,
          atomMapDigest: D("d"),
          generatorVersion: "fixture-1.0.0",
          validationEvidenceRefs: ["ligand-pose-evidence"],
        },
      ],
      selectedCandidateId: "selected-pose",
      selectionCriteria: ["exact fixture coordinates"],
      uncertainty: "high" as const,
    };
    const pose = PoseDecisionSchema.parse({
      ...poseBase,
      decisionDigest: computeBiomolecularDecisionMaterialDigest(poseBase),
    });
    const baseManifest = systemManifest(
      { construct, forceField, protonation, membrane },
      stack.stackDigest,
      signedAtomMap().mapDigest,
    );
    const references = [
      ...baseManifest.decisionRefs,
      ...[microstate, pose].map((decision) => ({
        id: decision.id,
        revision: decision.revision,
        kind: decision.kind,
        decisionDigest: decision.decisionDigest,
        approvalRef: decision.approvalRef!,
      })),
    ];
    const ligandManifestBase = {
      ...baseManifest,
      decisionRefs: references,
      components: {
        ...baseManifest.components,
        ligands: [ligand],
      },
      totalCharge: baseManifest.totalCharge + ligand.formalCharge,
      atomCount: baseManifest.atomCount + ligand.atomCount,
      manifestDigest: D("0"),
    };
    const ligandManifest = BiomolecularSystemManifestSchema.parse({
      ...ligandManifestBase,
      manifestDigest: computeBiomolecularSystemManifestDigest(ligandManifestBase),
    });
    const decisions = [construct, forceField, protonation, membrane, microstate, pose];

    expect(() =>
      assertBiomolecularSystemDecisionAuthority(ligandManifest, decisions),
    ).not.toThrow();
    const mismatchedMicrostates = [
      {
        ...microstate,
        alternatives: microstate.alternatives.map((alternative) => ({
          ...alternative,
          structureDigest: D("e"),
        })),
      },
      { ...microstate, targetPh: 6.5 },
      { ...microstate, temperatureKelvin: 310 },
    ];
    for (const mismatch of mismatchedMicrostates) {
      expect(() =>
        assertBiomolecularSystemDecisionAuthority(ligandManifest, [
          construct,
          forceField,
          protonation,
          membrane,
          mismatch,
          pose,
        ]),
      ).toThrow(/Ligand microstate decision/);
    }
  });

  async function exerciseDurableMdAuthority(provider: string, explicitSeeds: boolean) {
    const cluster = provider === "postgres" ? await startEphemeralPostgres() : undefined;
    if (cluster) clusterCleanups.push(cluster.cleanup);
    const database = cluster ? new PostgresDatabase(cluster.url) : new SqliteDatabase(":memory:");
    databases.push(database);
    await database.init();
    const scientificStore = new ScientificStore(database);
    const directory = mkdtempSync(join(tmpdir(), "eigengrid-md-projection-"));
    temporaryDirectories.push(directory);
    const cas = new ContentAddressedArtifactStore(directory);
    await cas.init();
    const mdStore = new MdProjectionStore(database, cas);

    await database.createUser({ id: reviewer.id, username: "scientist_fixture" });
    await database.createProject({ id: deliveryPrincipal.projectId, name: "MD fixture project" });
    await database.addProjectMember(deliveryPrincipal.projectId, reviewer.id, "member");
    await scientificStore.createMissionInProject({
      mission: missionFixture(),
      budget: budgetFixture(),
      projectId: deliveryPrincipal.projectId,
      ownerUserId: reviewer.id,
    });
    let missionRevision = 1;
    for (const [state, at] of [
      ["scoping", T1],
      ["planning", T2],
      ["awaiting_approval", T3],
    ] as const) {
      const mission = await scientificStore.transitionMission({
        missionId: "mission-md-1",
        expectedRevision: missionRevision,
        to: state,
        reason: `advance to ${state}`,
        actor: owner,
        at,
      });
      missionRevision = mission.revision;
    }
    const plan = planFixture();
    await scientificStore.createPlan(plan);

    for (const evidence of [
      { id: "system-evidence", label: "system-source", kind: "source_snapshot" as const },
      { id: "protein-evidence", label: "protein-source", kind: "structure" as const },
      { id: "lipid-evidence", label: "lipid-source", kind: "structure" as const },
      { id: "water-evidence", label: "water-source", kind: "structure" as const },
      { id: "construct-evidence", label: "construct-audit", kind: "construct_audit" as const },
      {
        id: "construct-output-evidence",
        label: "constructed-protein",
        kind: "structure" as const,
      },
      {
        id: "membrane-orientation-evidence",
        label: "membrane-orientation",
        kind: "source_snapshot" as const,
      },
      ...Object.entries(forceFieldEvidenceLabels).map(([id, label]) => ({
        id,
        label,
        kind: "source_snapshot" as const,
      })),
    ]) {
      await createCasEvidence(cas, scientificStore, evidence);
    }

    const stack = forceFieldStack();
    const stackBinding = BiomolecularMaterialPublicationBindingSchema.parse({
      schemaVersion: BiomolecularMaterialPublicationBindingSchemaVersion,
      subjectKind: "force_field_stack",
      subject: { id: stack.id, revision: stack.revision, digest: stack.stackDigest },
      sourceEvidenceRefs: Object.keys(forceFieldEvidenceLabels).sort(),
      artifactEvidenceRef: "force-field-stack-evidence",
    });
    const stackWorkUnit = materialPublicationWorkUnit(stackBinding, {
      id: "work-unit-force-field-stack",
      capabilityId: "amber.force-field-stack",
      contractDigest: D("d"),
    });
    if (stackWorkUnit.protocolFragment.kind !== "scientific_capability") {
      throw new Error("Force-field fixture requires a capability WorkUnit");
    }
    const stackProtocolFragment = stackWorkUnit.protocolFragment;
    const materialContractProbe = WorkUnitSchema.parse({
      ...stackWorkUnit,
      id: "work-unit-force-field-contract-probe",
      state: "created",
      claimOwner: null,
      claimExpiresAt: null,
      jobId: null,
      attemptId: null,
      protocolFragment: {
        ...stackProtocolFragment,
        id: "fragment-force-field-contract-probe",
      },
    });
    await scientificStore.createWorkUnits([materialContractProbe]);
    await expect(
      scientificStore.createWorkUnits([
        WorkUnitSchema.parse({
          ...materialContractProbe,
          id: "work-unit-force-field-raw-capability",
          executionPolicy: {
            ...materialContractProbe.executionPolicy,
            capability: "amber.raw",
          },
          protocolFragment: {
            ...materialContractProbe.protocolFragment,
            id: "fragment-force-field-raw-capability",
            capability: { ...stackProtocolFragment.capability, id: "amber.raw" },
          },
        }),
      ]),
    ).rejects.toThrow();
    const stackRequest = forceFieldPublicationRequest(stack, stackWorkUnit);
    await seedConfirmedOperation(database, {
      operationId: "operation-force-field-stack",
      receiptId: "receipt-force-field-stack",
      workUnitId: stackWorkUnit.id,
      capabilityId: "amber.force-field-stack",
      request: stackRequest,
      workUnit: stackWorkUnit,
    });
    const unsignedStackArtifact = canonicalJson(
      Object.fromEntries(Object.entries(stack).filter(([key]) => key !== "stackDigest")),
    );
    expect(C(unsignedStackArtifact)).toBe(stack.stackDigest);
    await createCasEvidence(cas, scientificStore, {
      id: "force-field-stack-evidence",
      label: unsignedStackArtifact,
      kind: "force_field_stack",
      mediaType: "application/vnd.eigengrid.force-field-stack+json",
      workUnitId: stackWorkUnit.id,
      sourceId: "receipt-force-field-stack",
    });
    const stackAuthority = {
      missionId: "mission-md-1",
      operationId: "operation-force-field-stack",
      operationReceiptId: "receipt-force-field-stack",
    };
    await mdStore.putForceFieldStack(stack, stackAuthority);
    await mdStore.putForceFieldStack(stack, stackAuthority);
    expect((await mdStore.getForceFieldStack("mission-md-1", stack.id, 1))?.stackDigest).toBe(
      stack.stackDigest,
    );
    expect(await mdStore.getForceFieldStack("mission-other", stack.id, 1)).toBeNull();
    await expect(
      mdStore.putForceFieldStack(
        { ...stack, knownLimitations: ["tampered without digest update"] },
        stackAuthority,
      ),
    ).rejects.toThrow();
    await expect(
      mdStore.putForceFieldStack(stack, {
        ...stackAuthority,
        operationReceiptId: "receipt-wrong",
      }),
    ).rejects.toThrow();

    const proposedDecision = constructDecision();
    const missingEvidenceDecisionInput = {
      ...proposedDecision,
      id: "construct-decision-missing-evidence",
      evidenceRefs: ["missing-cas-evidence"],
      decisionDigest: D("0"),
    };
    const missingEvidenceDecision = ConstructDecisionSchema.parse({
      ...missingEvidenceDecisionInput,
      decisionDigest: computeBiomolecularDecisionMaterialDigest(missingEvidenceDecisionInput),
    });
    await expect(mdStore.putBiomolecularDecision(missingEvidenceDecision)).rejects.toThrow();
    const poseWithMissingCandidateEvidenceInput = {
      schemaVersion: BiomolecularDecisionSchemaVersion,
      id: "pose-decision-missing-candidate-evidence",
      missionId: "mission-md-1",
      revision: 1,
      status: "proposed" as const,
      kind: "pose" as const,
      rationale: "Exercise nested pose-validation evidence authority",
      evidenceRefs: ["construct-evidence"],
      decidedBy: owner,
      decisionDigest: D("0"),
      createdAt: T1,
      receptorComponentId: "protein-1",
      ligandComponentId: "ligand-1",
      pocketDefinitionDigest: D("9"),
      candidates: [
        {
          id: "pose-candidate-1",
          method: "imported" as const,
          coordinateDigest: D("a"),
          atomMapDigest: D("b"),
          generatorVersion: "1.0.0",
          validationEvidenceRefs: ["missing-pose-validation-evidence"],
        },
      ],
      selectedCandidateId: "pose-candidate-1",
      selectionCriteria: ["fixture"],
      uncertainty: "high" as const,
    };
    const poseWithMissingCandidateEvidence = PoseDecisionSchema.parse({
      ...poseWithMissingCandidateEvidenceInput,
      decisionDigest: computeBiomolecularDecisionMaterialDigest(
        poseWithMissingCandidateEvidenceInput,
      ),
    });
    await expect(
      mdStore.putBiomolecularDecision(poseWithMissingCandidateEvidence),
    ).rejects.toThrow();
    await mdStore.putBiomolecularDecision(proposedDecision);
    await expect(
      mdStore.putBiomolecularDecision({
        ...proposedDecision,
        rationale: "tampered without a new material digest",
      }),
    ).rejects.toThrow();
    const decisionMaterialDigest = computeBiomolecularDecisionMaterialDigest(proposedDecision);
    const decisionApproval = approvalRequest({
      id: "approval-construct-1",
      subjectType: "decision",
      subjectId: proposedDecision.id,
      digest: decisionMaterialDigest,
    });
    await scientificStore.createApprovalRequest(decisionApproval);
    await scientificStore.respondToApproval(
      decisionApproval.id,
      approvalResponse(decisionApproval),
      approvalContext(T4),
    );
    const approvedDecision = await mdStore.getBiomolecularDecision(proposedDecision.id, 1);
    expect(approvedDecision?.status).toBe("approved");
    expect(approvedDecision?.approvalRef).toBe(decisionApproval.id);
    expect(computeBiomolecularDecisionMaterialDigest(approvedDecision!)).toBe(
      decisionMaterialDigest,
    );
    expect(approvedDecision?.decisionDigest).toBe(proposedDecision.decisionDigest);

    const missingProtonationEvidenceInput = {
      ...receptorProtonationDecision(proposedDecision),
      id: "protonation-decision-missing-evidence",
      evidenceRefs: ["construct-output-evidence", "missing-protonation-output"],
      outputCoordinateEvidenceRef: "missing-protonation-output",
      decisionDigest: D("0"),
    };
    const missingProtonationEvidence = ReceptorProtonationDecisionSchema.parse({
      ...missingProtonationEvidenceInput,
      decisionDigest: computeBiomolecularDecisionMaterialDigest(missingProtonationEvidenceInput),
    });
    await expect(mdStore.putBiomolecularDecision(missingProtonationEvidence)).rejects.toThrow();

    const exactForceFieldDecision = forceFieldDecision(stack);
    const nonexistentStackInput = {
      ...exactForceFieldDecision,
      id: "force-field-decision-nonexistent-stack",
      candidates: [
        {
          ...exactForceFieldDecision.candidates[0]!,
          id: "nonexistent-stack",
        },
      ],
      selectedStack: {
        ...exactForceFieldDecision.selectedStack,
        id: "nonexistent-stack",
      },
      decisionDigest: D("0"),
    };
    const nonexistentStackDecision = ForceFieldStackDecisionSchema.parse({
      ...nonexistentStackInput,
      decisionDigest: computeBiomolecularDecisionMaterialDigest(nonexistentStackInput),
    });
    await expect(mdStore.putBiomolecularDecision(nonexistentStackDecision)).rejects.toThrow();
    const fakeApprovedMembrane = MembraneModelDecisionSchema.parse({
      ...membraneModelDecision(),
      status: "approved",
      approvalRef: "approval-not-durable",
      approvedAt: T4,
    });
    await expect(mdStore.putBiomolecularDecision(fakeApprovedMembrane)).rejects.toThrow(
      /exact durable approval/,
    );

    const approveTypedDecision = async (
      proposed: Parameters<MdProjectionStore["putBiomolecularDecision"]>[0],
      approvalId: string,
    ) => {
      await mdStore.putBiomolecularDecision(proposed);
      const materialDigest = computeBiomolecularDecisionMaterialDigest(proposed);
      const approval = approvalRequest({
        id: approvalId,
        subjectType: "decision",
        subjectId: proposed.id,
        digest: materialDigest,
      });
      await scientificStore.createApprovalRequest(approval);
      await scientificStore.respondToApproval(
        approval.id,
        approvalResponse(approval),
        approvalContext(T4),
      );
      const approved = await mdStore.getBiomolecularDecision(proposed.id, proposed.revision);
      expect(approved?.status).toBe("approved");
      expect(approved?.approvalRef).toBe(approval.id);
      return approved!;
    };
    const approvedForceField = await approveTypedDecision(
      exactForceFieldDecision,
      "approval-force-field-decision-1",
    );
    const approvedProtonation = await approveTypedDecision(
      receptorProtonationDecision(proposedDecision),
      "approval-protonation-decision-1",
    );
    const approvedMembrane = await approveTypedDecision(
      membraneModelDecision(),
      "approval-membrane-decision-1",
    );

    const atomMap = signedAtomMap();
    const approvedDecisions = {
      construct: approvedDecision as ReturnType<typeof constructDecision> & {
        status: "approved";
        approvalRef: string;
      },
      forceField: approvedForceField as ReturnType<typeof forceFieldDecision> & {
        status: "approved";
        approvalRef: string;
      },
      protonation: approvedProtonation as ReturnType<typeof receptorProtonationDecision> & {
        status: "approved";
        approvalRef: string;
      },
      membrane: approvedMembrane as ReturnType<typeof membraneModelDecision> & {
        status: "approved";
        approvalRef: string;
      },
    };
    const manifest = systemManifest(approvedDecisions, stack.stackDigest, atomMap.mapDigest);
    expect(() =>
      assertBiomolecularSystemDecisionAuthority(
        { ...manifest, forceFieldStack: { ...manifest.forceFieldStack, revision: 2 } },
        Object.values(approvedDecisions),
      ),
    ).toThrow(/force-field stack differs/);
    expect(() =>
      assertBiomolecularSystemDecisionAuthority(
        { ...manifest, forceFieldStackDecisionId: approvedDecisions.construct.id },
        Object.values(approvedDecisions),
      ),
    ).toThrow(/wrong kind/);
    expect(() =>
      assertBiomolecularSystemDecisionAuthority(
        {
          ...manifest,
          decisionRefs: manifest.decisionRefs.map((reference) =>
            reference.id === approvedDecisions.forceField.id
              ? { ...reference, approvalRef: "approval-wrong" }
              : reference,
          ),
        },
        Object.values(approvedDecisions),
      ),
    ).toThrow(/not an exact approved decision/);
    expect(() =>
      assertBiomolecularSystemDecisionAuthority(
        { ...manifest, membrane: { ...manifest.membrane!, hydrophobicThicknessAngstrom: 31 } },
        Object.values(approvedDecisions),
      ),
    ).toThrow(/Membrane-model decision/);
    expect(() =>
      assertBiomolecularSystemDecisionAuthority(
        { ...manifest, membraneModelDecisionId: undefined },
        Object.values(approvedDecisions),
      ),
    ).toThrow(/lacks its membrane-model decision/);
    expect(() =>
      assertBiomolecularSystemDecisionAuthority(manifest, [
        approvedDecisions.construct,
        approvedDecisions.forceField,
        approvedDecisions.protonation,
        {
          ...approvedDecisions.membrane,
          receptorComponentId: "another-receptor",
        },
      ]),
    ).toThrow(/Membrane-model decision/);
    for (const protonationMutation of [
      { subjectComponentId: "another-receptor" },
      { inputCoordinateDigest: D("1") },
      { outputCoordinateDigest: D("2") },
      { selectedFormalCharge: 1 },
    ]) {
      expect(() =>
        assertBiomolecularSystemDecisionAuthority(manifest, [
          approvedDecisions.construct,
          approvedDecisions.forceField,
          { ...approvedDecisions.protonation, ...protonationMutation },
          approvedDecisions.membrane,
        ]),
      ).toThrow(/protonation decision/);
    }
    expect(() =>
      assertBiomolecularSystemDecisionAuthority(
        {
          ...manifest,
          components: {
            ...manifest.components,
            proteins: manifest.components.proteins.map((component) => ({
              ...component,
              protonationDecisionId: undefined,
            })),
          },
        },
        Object.values(approvedDecisions),
      ),
    ).toThrow(/lacks its receptor protonation decision/);
    const buildWorkUnit = systemBuildWorkUnit(manifest);
    const buildRequest = systemBuildRequest(manifest, buildWorkUnit);
    await seedConfirmedOperation(database, {
      operationId: "operation-build-system",
      receiptId: "receipt-build-system",
      workUnitId: "work-unit-build-system",
      capabilityId: "biomolecular.build-system",
      request: buildRequest,
      workUnit: buildWorkUnit,
    });
    const unsignedAtomMapArtifact = canonicalJson(
      Object.fromEntries(Object.entries(atomMap).filter(([key]) => key !== "mapDigest")),
    );
    expect(C(unsignedAtomMapArtifact)).toBe(atomMap.mapDigest);
    for (const evidence of [
      { id: "topology-evidence", label: "topology", kind: "topology" as const },
      { id: "coordinates-evidence", label: "coordinates", kind: "coordinates" as const },
      {
        id: "atom-map-evidence",
        label: unsignedAtomMapArtifact,
        kind: "atom_map" as const,
        mediaType: "application/vnd.eigengrid.atom-map+json",
      },
    ]) {
      await createCasEvidence(cas, scientificStore, {
        ...evidence,
        workUnitId: buildWorkUnit.id,
        sourceId: "receipt-build-system",
      });
    }
    await mdStore.putSystemManifest(manifest);
    await mdStore.putSystemManifest(manifest);
    await expect(
      mdStore.putSystemManifest({ ...manifest, name: "tampered without a new digest" }),
    ).rejects.toThrow();
    expect((await mdStore.getSystemManifest(manifest.id, 1))?.manifestDigest).toBe(
      manifest.manifestDigest,
    );
    const changedManifest = {
      ...manifest,
      name: "conflicting system revision",
      manifestDigest: D("0"),
    };
    changedManifest.manifestDigest = computeBiomolecularSystemManifestDigest(changedManifest);
    await expect(mdStore.putSystemManifest(changedManifest)).rejects.toThrow();

    const atomMapBinding = BiomolecularMaterialPublicationBindingSchema.parse({
      schemaVersion: BiomolecularMaterialPublicationBindingSchemaVersion,
      subjectKind: "atom_map",
      subject: { id: atomMap.id, revision: atomMap.revision, digest: atomMap.mapDigest },
      systemManifest: {
        id: manifest.id,
        revision: manifest.revision,
        digest: manifest.manifestDigest,
      },
      sourceEvidenceRefs: ["atom-map-evidence"],
      artifactEvidenceRef: "atom-map-evidence",
    });
    const atomMapWorkUnit = materialPublicationWorkUnit(atomMapBinding, {
      id: "work-unit-atom-map",
      capabilityId: "amber.topology-coordinate-validation",
      contractDigest: D("e"),
      dependencies: [buildWorkUnit.id],
    });
    const atomMapRequest = atomMapPublicationRequest(atomMap, manifest, atomMapWorkUnit);
    await seedConfirmedOperation(database, {
      operationId: "operation-atom-map",
      receiptId: "receipt-atom-map",
      workUnitId: atomMapWorkUnit.id,
      capabilityId: "amber.topology-coordinate-validation",
      request: atomMapRequest,
      workUnit: atomMapWorkUnit,
    });
    const atomMapAuthority = {
      missionId: "mission-md-1",
      operationId: "operation-atom-map",
      operationReceiptId: "receipt-atom-map",
    };
    await mdStore.putAtomMap(atomMap, atomMapAuthority);
    await mdStore.putAtomMap(atomMap, atomMapAuthority);
    expect((await mdStore.getAtomMap("mission-md-1", atomMap.id, 1))?.mapDigest).toBe(
      atomMap.mapDigest,
    );
    expect(await mdStore.getAtomMap("mission-other", atomMap.id, 1)).toBeNull();
    await expect(
      mdStore.putAtomMap({ ...atomMap, coordinateDigest: D("e") }, atomMapAuthority),
    ).rejects.toThrow();

    const systemApproval = approvalRequest({
      id: "approval-system-1",
      subjectType: "biomolecular_system_manifest",
      subjectId: manifest.id,
      digest: manifest.manifestDigest,
    });
    await scientificStore.createApprovalRequest(systemApproval);
    await scientificStore.respondToApproval(
      systemApproval.id,
      approvalResponse(systemApproval),
      approvalContext(T4),
    );

    const stage = stageSpec(manifest);
    const productionStage = productionStageSpec(manifest, stage);
    if (explicitSeeds) {
      productionStage.randomSeed = { policy: "replica_segment", segmentCount: 2 };
      productionStage.stageDigest = computeMdStageSpecDigest(productionStage);
    }
    const protocol = workflowProtocol(manifest, stage, productionStage);
    expect(computeMdProtocolMaterialDigest(protocol)).toBe(protocol.protocolDigest);
    const bypassedApproval = MdWorkflowProtocolSchema.parse({
      ...protocol,
      status: "approved",
      approvedByRef: "approval-that-does-not-exist",
    });
    await expect(
      mdStore.putProtocol(bypassedApproval, { planId: "plan-md-1", planVersion: 1 }),
    ).rejects.toThrow();
    const signProtocolMutation = (
      mutation: Partial<Pick<typeof protocol, "forceFieldStack" | "targetEngine">>,
    ) => {
      const changed = { ...protocol, ...mutation, protocolDigest: D("0") };
      return MdWorkflowProtocolSchema.parse({
        ...changed,
        protocolDigest: computeMdWorkflowProtocolDigest(changed),
      });
    };
    await expect(
      mdStore.putProtocol(
        signProtocolMutation({
          forceFieldStack: { ...protocol.forceFieldStack, revision: 2 },
        }),
        { planId: "plan-md-1", planVersion: 1 },
      ),
    ).rejects.toThrow(/exact system force-field stack/);
    await expect(
      mdStore.putProtocol(
        signProtocolMutation({ targetEngine: { family: "gromacs", versionRange: ">=2026" } }),
        { planId: "plan-md-1", planVersion: 1 },
      ),
    ).rejects.toThrow(/compatibility entry/);
    await expect(
      mdStore.putProtocol(
        signProtocolMutation({ targetEngine: { family: "amber", versionRange: ">=25" } }),
        { planId: "plan-md-1", planVersion: 1 },
      ),
    ).rejects.toThrow(/compatibility entry/);
    // Separate evidence permits only an explicitly reviewed technical pilot,
    // without rewriting the deposited stack or its historical compatibility.
    const admissionEnvironment = await createCasEvidence(cas, scientificStore, {
      id: "technical-engine-environment",
      label: "exact synthetic engine environment; not a pilot execution",
      kind: "environment",
    });
    const admissionRenderer = await createCasEvidence(cas, scientificStore, {
      id: "technical-engine-renderer",
      label: "exact synthetic renderer evidence; not a pilot execution",
      kind: "source_snapshot",
    });
    const pilotInitialBase = { ...stage, id: "stage-pilot-initial" };
    const pilotInitial = {
      ...pilotInitialBase,
      stageDigest: computeMdStageSpecDigest(pilotInitialBase),
    };
    const pilotStageBase = {
      ...productionStage,
      id: "stage-pilot-npt",
      parentStageId: pilotInitial.id,
      kind: "equilibration" as const,
      randomSeed: { policy: "fixed" as const, seed: 12345 },
    };
    const pilotStages = [
      pilotInitial,
      { ...pilotStageBase, stageDigest: computeMdStageSpecDigest(pilotStageBase) },
    ];
    const admission = {
      schemaVersion: "eigengrid.md-force-field-engine-admission/v1" as const,
      missionId: protocol.missionId,
      scope: "provisional_technical_pilot" as const,
      system: protocol.system,
      forceFieldStack: protocol.forceFieldStack,
      parameterDigests: mdForceFieldParameterDigests(stack),
      targetEngine: { family: "amber" as const, versionRange: "26" },
      engine: {
        engine: "amber",
        executable: "pmemd.cuda",
        version: "26",
        buildDigest: D("a"),
        environmentDigest: D("b"),
        compatibilityVersion: "1.0.0",
      },
      sourceEvidence: [admissionEnvironment, admissionRenderer].map((evidence) => ({
        evidenceRef: evidence.id,
        contentDigest: evidence.contentDigest,
        kind: evidence.kind as "environment" | "source_snapshot",
      })),
      rationale: "Synthetic exact admission fixture; existing parameter hashes are unchanged",
      limitations: ["No general GPU or biological qualification"],
      createdAt: T2,
    };
    const admissionEvidence = await createCasEvidence(cas, scientificStore, {
      id: "technical-engine-admission",
      label: canonicalJson(admission),
      kind: "human_review",
      mediaType: "application/json",
    });
    const pilotBase = {
      ...protocol,
      id: "md-protocol-technical-pilot",
      purpose: "technical_pilot" as const,
      targetEngine: admission.targetEngine,
      stages: pilotStages,
      forceFieldEngineAdmission: {
        evidenceRef: admissionEvidence.id,
        contentDigest: admissionEvidence.contentDigest,
        admission,
      },
    };
    const signPilot = (value: typeof pilotBase) => ({
      ...value,
      protocolDigest: computeMdWorkflowProtocolDigest(value),
    });
    await expect(
      mdStore.putProtocol(
        signPilot({
          ...pilotBase,
          forceFieldEngineAdmission: {
            ...pilotBase.forceFieldEngineAdmission,
            evidenceRef: "missing-admission-evidence",
          },
        }),
        { planId: "plan-md-1", planVersion: 1 },
      ),
    ).rejects.toThrow();
    for (const changedAdmission of [
      { ...admission, missionId: "other-mission" },
      { ...admission, parameterDigests: [D("e")] },
      { ...admission, system: { ...admission.system, topologyDigest: D("e") } },
      { ...admission, targetEngine: { ...admission.targetEngine, versionRange: "27" } },
      {
        ...admission,
        sourceEvidence: [
          { ...admission.sourceEvidence[0]!, contentDigest: D("e") },
          admission.sourceEvidence[1]!,
        ],
      },
    ])
      await expect(
        mdStore.putProtocol(
          signPilot({
            ...pilotBase,
            forceFieldEngineAdmission: {
              ...pilotBase.forceFieldEngineAdmission,
              admission: changedAdmission,
              contentDigest: digestCanonical(changedAdmission),
            },
          }),
          { planId: "plan-md-1", planVersion: 1 },
        ),
      ).rejects.toThrow();
    const pilotProtocol = signPilot(pilotBase);
    await mdStore.putProtocol(pilotProtocol, { planId: "plan-md-1", planVersion: 1 });
    await mdStore.putProtocol(pilotProtocol, { planId: "plan-md-1", planVersion: 1 });
    const pilotApproval = approvalRequest({
      id: "approval-technical-protocol",
      subjectType: "md_protocol",
      subjectId: pilotProtocol.id,
      digest: pilotProtocol.protocolDigest,
    });
    await scientificStore.createApprovalRequest(pilotApproval);
    await scientificStore.respondToApproval(
      pilotApproval.id,
      approvalResponse(pilotApproval, T5),
      approvalContext(T5),
    );
    expect((await mdStore.getProtocol(pilotProtocol.id, 1))?.status).toBe("approved");
    expect((await mdStore.getForceFieldStack("mission-md-1", stack.id, 1))?.stackDigest).toBe(
      stack.stackDigest,
    );

    await mdStore.putProtocol(protocol, { planId: "plan-md-1", planVersion: 1 });
    await expect(
      mdStore.putProtocol(
        { ...protocol, assumptions: ["tampered without a new digest"] },
        { planId: "plan-md-1", planVersion: 1 },
      ),
    ).rejects.toThrow();
    expect((await mdStore.getStageSpec(stage.id, 1))?.stageDigest).toBe(stage.stageDigest);
    await expect(
      scientificStore.createApprovalRequest(
        approvalRequest({
          id: "approval-protocol-stale",
          subjectType: "md_protocol",
          subjectId: protocol.id,
          digest: protocol.protocolDigest,
          revision: 2,
        }),
      ),
    ).rejects.toBeInstanceOf(ScientificApprovalStaleError);
    await expect(
      scientificStore.createApprovalRequest(
        approvalRequest({
          id: "approval-protocol-modified",
          subjectType: "md_protocol",
          subjectId: protocol.id,
          digest: D("e"),
        }),
      ),
    ).rejects.toBeInstanceOf(ScientificApprovalModifiedError);

    const protocolApproval = approvalRequest({
      id: "approval-protocol-1",
      subjectType: "md_protocol",
      subjectId: protocol.id,
      digest: computeMdProtocolMaterialDigest(protocol),
    });
    await scientificStore.createApprovalRequest(protocolApproval);
    await scientificStore.respondToApproval(
      protocolApproval.id,
      approvalResponse(protocolApproval, T5),
      approvalContext(T5),
    );
    const approvedProtocol = await mdStore.getProtocol(protocol.id, 1);
    expect(approvedProtocol?.status).toBe("approved");
    expect(approvedProtocol?.approvedByRef).toBe(protocolApproval.id);
    expect(approvedProtocol?.protocolDigest).toBe(protocol.protocolDigest);
    expect(computeMdProtocolMaterialDigest(approvedProtocol!)).toBe(
      computeMdProtocolMaterialDigest(protocol),
    );
    const incompatibleReadBase = {
      ...approvedProtocol!,
      targetEngine: { family: "gromacs" as const, versionRange: ">=2026" },
      protocolDigest: D("0"),
    };
    const incompatibleReadProtocol = MdWorkflowProtocolSchema.parse({
      ...incompatibleReadBase,
      protocolDigest: computeMdWorkflowProtocolDigest(incompatibleReadBase),
    });
    const corruptProtocol = await database.beginTransaction();
    await corruptProtocol.query(
      `UPDATE scientific_md_protocols
       SET protocol_digest = $1, material_digest = $1, payload_json = $2
       WHERE id = $3 AND revision = $4`,
      [
        incompatibleReadProtocol.protocolDigest,
        canonicalJson(incompatibleReadProtocol),
        incompatibleReadProtocol.id,
        incompatibleReadProtocol.revision,
      ],
    );
    await corruptProtocol.commit();
    await expect(mdStore.getProtocol(protocol.id, protocol.revision)).rejects.toThrow(
      /compatibility entry/,
    );
    const corruptSnapshot = await database.beginTransaction();
    try {
      await expect(
        resolveMdSubjectSnapshot(
          corruptSnapshot as Parameters<typeof resolveMdSubjectSnapshot>[0],
          "sqlite",
          "md_protocol",
          protocol.id,
        ),
      ).rejects.toThrow(/compatibility entry/);
    } finally {
      await corruptSnapshot.rollback();
    }
    const restoreProtocol = await database.beginTransaction();
    await restoreProtocol.query(
      `UPDATE scientific_md_protocols
       SET protocol_digest = $1, material_digest = $1, payload_json = $2
       WHERE id = $3 AND revision = $4`,
      [
        approvedProtocol!.protocolDigest,
        canonicalJson(approvedProtocol!),
        approvedProtocol!.id,
        approvedProtocol!.revision,
      ],
    );
    await restoreProtocol.commit();
    expect((await mdStore.getProtocol(protocol.id, protocol.revision))?.protocolDigest).toBe(
      protocol.protocolDigest,
    );

    const conflictingProtocolInput = {
      ...approvedProtocol!,
      status: "under_review" as const,
      approvedByRef: undefined,
      assumptions: [...approvedProtocol!.assumptions, "conflicting material change"],
      protocolDigest: D("0"),
    };
    const conflictingProtocol = MdWorkflowProtocolSchema.parse({
      ...conflictingProtocolInput,
      protocolDigest: computeMdWorkflowProtocolDigest(conflictingProtocolInput),
    });
    await expect(
      mdStore.putProtocol(conflictingProtocol, { planId: "plan-md-1", planVersion: 1 }),
    ).rejects.toBeInstanceOf(ScientificEntityConflictError);

    const planApproval = approvalRequest({
      id: "approval-plan-1",
      subjectType: "plan",
      subjectId: plan.id,
      digest: plan.planDigest,
    });
    await scientificStore.createApprovalRequest(planApproval);
    await scientificStore.respondToApproval(
      planApproval.id,
      approvalResponse(planApproval),
      approvalContext(T5),
    );

    const exactDecision = approvedDecision as ReturnType<typeof constructDecision> & {
      status: "approved";
      approvalRef: string;
    };
    const equilibrationWorkUnit = capabilityWorkUnit(
      manifest,
      approvedProtocol!,
      stage,
      exactDecision,
      {
        id: "work-unit-equilibration",
        planApprovalRef: planApproval.id,
        systemApprovalRef: systemApproval.id,
        protocolApprovalRef: protocolApproval.id,
      },
    );
    await scientificStore.createWorkUnits([equilibrationWorkUnit]);
    if (equilibrationWorkUnit.protocolFragment.kind !== "scientific_capability") {
      throw new Error("Fixture WorkUnit must use a scientific capability fragment");
    }
    const rogueWorkUnit = WorkUnitSchema.parse({
      ...equilibrationWorkUnit,
      id: "work-unit-rogue-capability",
      executionPolicy: { ...equilibrationWorkUnit.executionPolicy, capability: "amber.raw" },
      protocolFragment: {
        ...equilibrationWorkUnit.protocolFragment,
        id: "fragment-work-unit-rogue-capability",
        capability: {
          ...equilibrationWorkUnit.protocolFragment.capability,
          id: "amber.raw",
        },
      },
    });
    await expect(scientificStore.createWorkUnits([rogueWorkUnit])).rejects.toThrow();
    expect(await scientificStore.getWorkUnit(rogueWorkUnit.id)).toBeNull();
    const unvalidatedWorkUnit = capabilityWorkUnit(
      manifest,
      approvedProtocol!,
      stage,
      exactDecision,
      {
        id: "work-unit-equilibration-unvalidated",
        planApprovalRef: planApproval.id,
        systemApprovalRef: systemApproval.id,
        protocolApprovalRef: protocolApproval.id,
      },
    );
    await scientificStore.createWorkUnits([unvalidatedWorkUnit]);

    const equilibrationArtifacts = [
      artifact("restart", C("equil-restart"), "expected-parent-restart-evidence"),
      artifact("mdout", C("equil-mdout"), "equil-mdout-evidence"),
      artifact("mdinfo", C("equil-mdinfo"), "equil-mdinfo-evidence"),
    ];
    for (const [artifactRef, label] of [
      [equilibrationArtifacts[0]!, "equil-restart"],
      [equilibrationArtifacts[1]!, "equil-mdout"],
      [equilibrationArtifacts[2]!, "equil-mdinfo"],
    ] as const) {
      await createCasEvidence(cas, scientificStore, {
        id: artifactRef.evidenceRef,
        label,
        kind: evidenceKindForArtifactRole(artifactRef.role),
        mediaType: artifactRef.mediaType,
        workUnitId: equilibrationWorkUnit.id,
        sourceId: "receipt-equilibration",
      });
    }
    await createCasEvidence(cas, scientificStore, {
      id: "replica-2-restart-evidence",
      label: "replica-2-restart",
      kind: "restart",
    });

    const replicas = [
      {
        id: "replica-1",
        index: 1,
        seed: 101,
        initialRestart: equilibrationArtifacts[0]!,
        ...(explicitSeeds ? { segmentSeeds: [101, 103] } : {}),
      },
      {
        id: "replica-2",
        index: 2,
        seed: 102,
        initialRestart: artifact("restart", C("replica-2-restart"), "replica-2-restart-evidence"),
        ...(explicitSeeds ? { segmentSeeds: [102, 104] } : {}),
      },
    ];
    const replicaSet = ReplicaSetSchema.parse({
      schemaVersion: MdReplicaSetSchemaVersion,
      id: "replica-set-1",
      missionId: "mission-md-1",
      revision: 1,
      protocolId: approvedProtocol!.id,
      protocolRevision: approvedProtocol!.revision,
      protocolDigest: approvedProtocol!.protocolDigest,
      systemManifestDigest: manifest.manifestDigest,
      replicaCount: 2,
      replicas,
      seedPolicyDigest: explicitSeeds ? computeMdReplicaSeedPolicyDigest(replicas) : D("a"),
      decisionRef: approvedDecision!.id,
      createdAt: T5,
    });
    await mdStore.putReplicaSet(replicaSet);
    expect((await mdStore.getReplicaSet(replicaSet.id, 1))?.revision).toBe(1);
    const replicaApproval = approvalRequest({
      id: "approval-replica-set-1",
      subjectType: "replica_set",
      subjectId: replicaSet.id,
      digest: computeMdReplicaSetPayloadDigest(replicaSet),
    });
    await scientificStore.createApprovalRequest(replicaApproval);
    await scientificStore.respondToApproval(
      replicaApproval.id,
      approvalResponse(replicaApproval),
      approvalContext(T5),
    );
    const alteredReplicas = replicaSet.replicas.map((replica) => ({
      ...replica,
      seed: replica.seed + 100,
      ...(explicitSeeds ? { segmentSeeds: replica.segmentSeeds!.map((seed) => seed + 100) } : {}),
    }));
    await expect(
      mdStore.putReplicaSet({
        ...replicaSet,
        replicas: alteredReplicas,
        seedPolicyDigest: explicitSeeds
          ? computeMdReplicaSeedPolicyDigest(alteredReplicas)
          : replicaSet.seedPolicyDigest,
      }),
    ).rejects.toBeInstanceOf(ScientificEntityConflictError);

    await scientificStore.activatePlan({
      missionId: "mission-md-1",
      planId: plan.id,
      expectedMissionRevision: missionRevision,
      actor: owner,
      at: T5,
    });
    await scientificStore.transitionMission({
      missionId: "mission-md-1",
      expectedRevision: missionRevision + 1,
      to: "ready",
      reason: "all exact MD authorities approved",
      actor: owner,
      at: T5,
    });

    if (database._provider === "postgres") {
      await exerciseMdPreparationPublication({
        database,
        workUnit: equilibrationWorkUnit,
        stage,
        atomMap,
        request: stageOperationRequestFor(equilibrationWorkUnit),
        policyDigest,
        at: T5,
      });
      // TERRA-P1-03 integration: use the real schema-20 store, admission,
      // immutable delivery and Ed25519 signer. The final socket boundary is a
      // counted local test transport; real root-owned socket/SO_PEERCRED is
      // deliberately deferred to the authorized site qualification.
      const driverWorkUnit = capabilityWorkUnit(manifest, approvedProtocol!, stage, exactDecision, {
        id: "work-unit-driver-pg",
        planApprovalRef: planApproval.id,
        systemApprovalRef: systemApproval.id,
        protocolApprovalRef: protocolApproval.id,
      });
      await scientificStore.createWorkUnits([driverWorkUnit]);
      await scientificStore.transitionWorkUnit({
        workUnitId: driverWorkUnit.id,
        expectedRevision: 1,
        to: "ready",
        at: T5,
      });
      const driverClaim = await scientificStore.claimWorkUnit({
        workUnitId: driverWorkUnit.id,
        ownerId: owner.id,
        now: T5,
        expiresAt: "2026-08-24T00:00:00.000Z",
        policyDigest,
      });
      if (!driverClaim.claimed) throw new Error(driverClaim.message);
      const driverRequest = stageOperationRequestFor(driverClaim.workUnit);
      const driverBundle = {
        reference: { sha256: C("driver-pg-verified-bundle"), sizeBytes: 1234 },
        manifest: { request: driverRequest },
      } as unknown as VerifiedAmberStageBundle;
      const driverGrant = {
        principal: deliveryPrincipal,
        recoveryEpoch: "fixture-epoch-1",
        membershipGeneration: 1,
        currentPolicyDigest: policyDigest,
      };
      let latestPrepared: Awaited<ReturnType<HeadMdDeliverySigner["prepare"]>> | undefined;
      let signerBuilds = 0;
      const driverSigner = new HeadMdDeliverySigner(
        database,
        () => driverGrant,
        (authority) => {
          signerBuilds++;
          return driverTransportBody(authority);
        },
        deliveryPrivateKey,
        () => new Date(T5),
      );
      const driverSession: HeadMdAmberDeliverySession = {
        async prepare(input) {
          latestPrepared = await driverSigner.prepare(input);
          return latestPrepared;
        },
        async observe(operationId) {
          latestPrepared = await driverSigner.observe(operationId);
          return latestPrepared;
        },
        async authorizeObserveRpc(input) {
          const checked = await new ScientificEffectReconciliationStore(
            database,
            () => new Date(T5),
          ).readMdSubmissionDelivery(input.prepared.delivery.operationId, deliveryPrincipal);
          if (canonicalJson(checked) !== canonicalJson(input.prepared.delivery))
            throw new Error("Observation fixture delivery mismatch");
          return {
            socketPath: "/run/eigengrid/fixture.sock",
            wire: new Uint8Array(input.prepared.wire),
            delivery: structuredClone(input.prepared.delivery),
            capabilityRequestId: input.prepared.capability.requestId,
          };
        },
        async authorizeSubmitRpc(input) {
          const checked = await new ScientificEffectReconciliationStore(
            database,
            () => new Date(T5),
          ).readMdDeliverySigningAuthority(
            {
              operationId: input.prepared.delivery.operationId,
              claimOwner: input.claimOwner,
              currentPolicyDigest: policyDigest,
            },
            deliveryPrincipal,
          );
          if (canonicalJson(checked.delivery) !== canonicalJson(input.prepared.delivery))
            throw new Error("driver fixture delivery drifted before the local RPC boundary");
          return {
            socketPath: "/run/eigengrid/fixture.sock",
            wire: input.prepared.wire,
            delivery: input.prepared.delivery,
            capabilityRequestId: input.prepared.capability.requestId,
          };
        },
      };
      let driverRpcCalls = 0;
      const driver = new CanonicalScientificExecutionDriver({
        store: scientificStore,
        execution: {} as never,
        effectPersistence: new ScientificEffectReconciliationStore(database, () => new Date(T5)),
        currentPolicyDigestFor: () => policyDigest,
        md: {
          database,
          prepareBundle: async () => driverBundle,
          siteAuthority: {
            createAmberDeliverySession() {
              return driverSession;
            },
          },
          callSubmitter: async (socketPath, wire) => {
            driverRpcCalls++;
            if (!latestPrepared)
              throw new Error("submitter boundary did not receive a signed delivery");
            expect(socketPath).toBe("/run/eigengrid/fixture.sock");
            expect(Buffer.from(wire).equals(Buffer.from(latestPrepared.wire))).toBe(true);
            return {
              status: "consumed" as const,
              operationId: latestPrepared.delivery.operationId,
              resubmitAllowed: false as const,
              receipt: {
                status: "acknowledged" as const,
                resubmitAllowed: false as const,
                jobId: "9001",
                cluster: "fixture-cluster",
              },
              requiresReconciliation: true as const,
            };
          },
        },
        now: () => new Date(T5),
      });
      const driverRun = await driver.executeClaimedWorkUnit(driverClaim.workUnit, {
        ownerId: owner.id,
        claimOwner: owner.id,
        now: T5,
      });
      expect(driverRun.status).toBe("progressed");
      expect({ signerBuilds, driverRpcCalls }).toEqual({ signerBuilds: 1, driverRpcCalls: 1 });
      const driverOperation = (
        await scientificStore.getMissionProvenance("mission-md-1")
      ).operations.find((operation) => operation.workUnitId === driverWorkUnit.id);
      expect(driverOperation).toMatchObject({
        kind: "md_stage_execution",
        state: "acknowledged",
        requestDigest: digestCanonical(driverRequest),
        externalIdentity: { slurmJobId: "9001", slurmCluster: "fixture-cluster" },
      });
      if (!driverOperation) throw new Error("Missing real-PG MD driver operation");
      expect(await scientificStore.getWorkUnit(driverWorkUnit.id)).toMatchObject({
        state: "executing",
        jobId: mdStageEffectIdentity(driverOperation).jobId,
        attemptId: mdStageEffectIdentity(driverOperation).attemptId,
      });
      expect(
        await new ScientificEffectReconciliationStore(
          database,
          () => new Date(T5),
        ).readMdSubmissionDelivery(driverOperation.id, deliveryPrincipal),
      ).toMatchObject({
        operationId: driverOperation.id,
        workUnitId: driverWorkUnit.id,
        requestDigest: digestCanonical(driverRequest),
      });
      const deliveryCountTx = (await database.beginTransaction()) as ScientificTransaction;
      try {
        expect(
          await deliveryCountTx.queryRows<{ count: string }>(
            "SELECT COUNT(*)::text AS count FROM scientific_effect_deliveries WHERE operation_id = $1",
            [driverOperation.id],
          ),
        ).toEqual([{ count: "1" }]);
      } finally {
        await deliveryCountTx.rollback();
      }
      const driverReplay = await driver.executeClaimedWorkUnit(driverClaim.workUnit, {
        ownerId: owner.id,
        claimOwner: owner.id,
        now: T5,
      });
      expect(driverReplay.status).toBe("waiting");
      expect({ signerBuilds, driverRpcCalls }).toEqual({ signerBuilds: 1, driverRpcCalls: 1 });

      const claimDriverWorkUnit = async (id: string) => {
        const workUnit = capabilityWorkUnit(manifest, approvedProtocol!, stage, exactDecision, {
          id,
          planApprovalRef: planApproval.id,
          systemApprovalRef: systemApproval.id,
          protocolApprovalRef: protocolApproval.id,
        });
        await scientificStore.createWorkUnits([workUnit]);
        await scientificStore.transitionWorkUnit({
          workUnitId: workUnit.id,
          expectedRevision: 1,
          to: "ready",
          at: T5,
        });
        const claim = await scientificStore.claimWorkUnit({
          workUnitId: workUnit.id,
          ownerId: owner.id,
          now: T5,
          expiresAt: "2026-08-24T00:00:00.000Z",
          policyDigest,
        });
        if (!claim.claimed) throw new Error(claim.message);
        const request = stageOperationRequestFor(claim.workUnit);
        return {
          claim,
          request,
          bundle: {
            reference: { sha256: C(`driver-pg-verified-bundle:${id}`), sizeBytes: 1234 },
            manifest: { request },
          } as unknown as VerifiedAmberStageBundle,
        };
      };
      const deliveryRows = async (operationId: string): Promise<number> => {
        const tx = (await database.beginTransaction()) as ScientificTransaction;
        try {
          const [row] = await tx.queryRows<{ count: string }>(
            "SELECT COUNT(*)::text AS count FROM scientific_effect_deliveries WHERE operation_id = $1",
            [operationId],
          );
          return Number(row?.count ?? "0");
        } finally {
          await tx.rollback();
        }
      };
      type DriverCounters = {
        signerBuilds: number;
        rpcCalls: number;
        submitted?: Awaited<ReturnType<HeadMdDeliverySigner["prepare"]>>;
      };
      const makeDriver = (
        bundle: VerifiedAmberStageBundle,
        counters: DriverCounters,
        outcome: "acknowledged" | "lost",
        signingDatabase: ScientificDatabase = database,
      ) =>
        new CanonicalScientificExecutionDriver({
          store: scientificStore,
          execution: {} as never,
          effectPersistence: new ScientificEffectReconciliationStore(database, () => new Date(T5)),
          currentPolicyDigestFor: () => policyDigest,
          md: {
            database: signingDatabase,
            prepareBundle: async () => bundle,
            siteAuthority: {
              createAmberDeliverySession() {
                const signer = new HeadMdDeliverySigner(
                  signingDatabase,
                  () => driverGrant,
                  (authority) => {
                    counters.signerBuilds++;
                    return driverTransportBody(authority);
                  },
                  deliveryPrivateKey,
                  () => new Date(T5),
                );
                const session: HeadMdAmberDeliverySession = {
                  async prepare(input) {
                    const prepared = await signer.prepare(input);
                    if (prepared.action === "submit") counters.submitted = prepared;
                    return prepared;
                  },
                  async observe(operationId) {
                    return signer.observe(operationId);
                  },
                  async authorizeObserveRpc() {
                    throw new Error("Observation not configured in submit-only fixture");
                  },
                  async authorizeSubmitRpc(input) {
                    const checked = await new ScientificEffectReconciliationStore(
                      signingDatabase,
                      () => new Date(T5),
                    ).readMdDeliverySigningAuthority(
                      {
                        operationId: input.prepared.delivery.operationId,
                        claimOwner: input.claimOwner,
                        currentPolicyDigest: policyDigest,
                      },
                      deliveryPrincipal,
                    );
                    if (canonicalJson(checked.delivery) !== canonicalJson(input.prepared.delivery))
                      throw new Error(
                        "driver fixture delivery drifted before the local RPC boundary",
                      );
                    return {
                      socketPath: "/run/eigengrid/fixture.sock",
                      wire: new Uint8Array(input.prepared.wire),
                      delivery: structuredClone(input.prepared.delivery),
                      capabilityRequestId: input.prepared.capability.requestId,
                    };
                  },
                };
                return session;
              },
            },
            callSubmitter: async (socketPath, wire) => {
              counters.rpcCalls++;
              const submitted = counters.submitted;
              if (!submitted)
                throw new Error("submitter boundary did not receive a signed delivery");
              expect(socketPath).toBe("/run/eigengrid/fixture.sock");
              expect(Buffer.from(wire).equals(Buffer.from(submitted.wire))).toBe(true);
              if (outcome === "lost") throw new Error("fixture submitter ACK lost after receipt");
              return {
                status: "consumed" as const,
                operationId: submitted.delivery.operationId,
                resubmitAllowed: false as const,
                receipt: {
                  status: "acknowledged" as const,
                  resubmitAllowed: false as const,
                  jobId: "9002",
                  cluster: "fixture-cluster",
                },
                requiresReconciliation: true as const,
              };
            },
          },
          now: () => new Date(T5),
        });

      // Two independent drivers contend through PostgreSQL, not an in-process
      // mutex. Exactly one may produce a signed delivery and one RPC.
      const concurrent = await claimDriverWorkUnit("work-unit-driver-concurrent-pg");
      const concurrentCounters: DriverCounters = { signerBuilds: 0, rpcCalls: 0 };
      const concurrentResults = await Promise.all([
        makeDriver(concurrent.bundle, concurrentCounters, "acknowledged").executeClaimedWorkUnit(
          concurrent.claim.workUnit,
          { ownerId: owner.id, claimOwner: owner.id, now: T5 },
        ),
        makeDriver(concurrent.bundle, concurrentCounters, "acknowledged").executeClaimedWorkUnit(
          concurrent.claim.workUnit,
          { ownerId: owner.id, claimOwner: owner.id, now: T5 },
        ),
      ]);
      expect(concurrentResults.map((result) => result.status).sort()).toEqual([
        "progressed",
        "waiting",
      ]);
      expect({
        signerBuilds: concurrentCounters.signerBuilds,
        rpcCalls: concurrentCounters.rpcCalls,
      }).toEqual({ signerBuilds: 1, rpcCalls: 1 });
      const concurrentOperation = (
        await scientificStore.getMissionProvenance("mission-md-1")
      ).operations.find((operation) => operation.workUnitId === concurrent.claim.workUnit.id);
      if (!concurrentOperation) throw new Error("Missing concurrent MD driver operation");
      expect(await deliveryRows(concurrentOperation.id)).toBe(1);

      // A transport ACK can be lost after submitter receipt. The real PG
      // delivery remains immutable and the next call cannot send again.
      const lostAck = await claimDriverWorkUnit("work-unit-driver-lost-ack-pg");
      const lostAckCounters: DriverCounters = { signerBuilds: 0, rpcCalls: 0 };
      const lostAckDriver = makeDriver(lostAck.bundle, lostAckCounters, "lost");
      expect(
        await lostAckDriver.executeClaimedWorkUnit(lostAck.claim.workUnit, {
          ownerId: owner.id,
          claimOwner: owner.id,
          now: T5,
        }),
      ).toMatchObject({ status: "waiting" });
      const lostAckOperation = (
        await scientificStore.getMissionProvenance("mission-md-1")
      ).operations.find((operation) => operation.workUnitId === lostAck.claim.workUnit.id);
      if (!lostAckOperation) throw new Error("Missing lost-ACK MD driver operation");
      expect(lostAckOperation.state).toBe("ambiguous");
      expect(await deliveryRows(lostAckOperation.id)).toBe(1);
      expect({
        signerBuilds: lostAckCounters.signerBuilds,
        rpcCalls: lostAckCounters.rpcCalls,
      }).toEqual({ signerBuilds: 1, rpcCalls: 1 });
      expect(
        await lostAckDriver.executeClaimedWorkUnit(lostAck.claim.workUnit, {
          ownerId: owner.id,
          claimOwner: owner.id,
          now: T5,
        }),
      ).toMatchObject({ status: "waiting" });
      expect(lostAckCounters.rpcCalls).toBe(1);

      // The driver receives a delivery-commit ACK loss after PostgreSQL has
      // committed. It records ambiguity with no RPC and cannot mint a second
      // delivery on replay.
      const lostCommit = await claimDriverWorkUnit("work-unit-driver-lost-commit-pg");
      const lostCommitDatabase: ScientificDatabase = {
        _provider: "postgres",
        beginTransaction: async () => {
          const tx = await database.beginTransaction();
          let insertedDelivery = false;
          const query = tx.query.bind(tx);
          tx.query = async (sql, params) => {
            const result = await query(sql, params);
            if (sql.includes("INSERT INTO scientific_effect_deliveries")) insertedDelivery = true;
            return result;
          };
          const commit = tx.commit.bind(tx);
          tx.commit = async () => {
            await commit();
            if (insertedDelivery) throw new Error("fixture delivery COMMIT ACK lost");
          };
          return tx;
        },
      };
      const lostCommitCounters: DriverCounters = { signerBuilds: 0, rpcCalls: 0 };
      const lostCommitDriver = makeDriver(
        lostCommit.bundle,
        lostCommitCounters,
        "acknowledged",
        lostCommitDatabase,
      );
      expect(
        await lostCommitDriver.executeClaimedWorkUnit(lostCommit.claim.workUnit, {
          ownerId: owner.id,
          claimOwner: owner.id,
          now: T5,
        }),
      ).toMatchObject({ status: "waiting" });
      const lostCommitOperation = (
        await scientificStore.getMissionProvenance("mission-md-1")
      ).operations.find((operation) => operation.workUnitId === lostCommit.claim.workUnit.id);
      if (!lostCommitOperation) throw new Error("Missing lost-commit MD driver operation");
      expect(lostCommitOperation.state).toBe("ambiguous");
      expect(await deliveryRows(lostCommitOperation.id)).toBe(1);
      expect({
        signerBuilds: lostCommitCounters.signerBuilds,
        rpcCalls: lostCommitCounters.rpcCalls,
      }).toEqual({ signerBuilds: 1, rpcCalls: 0 });
      expect(
        await lostCommitDriver.executeClaimedWorkUnit(lostCommit.claim.workUnit, {
          ownerId: owner.id,
          claimOwner: owner.id,
          now: T5,
        }),
      ).toMatchObject({ status: "waiting" });
      expect(lostCommitCounters.rpcCalls).toBe(0);

      const recoveryChecks = await exerciseMdDeliveryRecovery({
        database,
        grant: driverGrant,
        privateKey: deliveryPrivateKey,
        lostAck: lostAckOperation,
        lostCommit: lostCommitOperation,
        at: T5,
      });
      expect(await deliveryRows(lostAckOperation.id)).toBe(1);
      expect(await deliveryRows(lostCommitOperation.id)).toBe(1);
      expect(lostAckCounters.rpcCalls).toBe(1);
      expect(lostCommitCounters.rpcCalls).toBe(0);

      // Current revocation prevents the MD effect boundary itself. The
      // immutable association remains historical, but no admission/delivery/
      // RPC can be created while the membership is revoked.
      const revoked = await claimDriverWorkUnit("work-unit-driver-revoked-pg");
      const revokeTx = (await database.beginTransaction()) as ScientificTransaction;
      let originalRole: string;
      try {
        const [membership] = await revokeTx.queryRows<{ id: string; role: string }>(
          "SELECT id, role FROM project_memberships WHERE project_id = $1 AND user_id = $2",
          [deliveryPrincipal.projectId, reviewer.id],
        );
        if (!membership) throw new Error("Missing driver revocation fixture membership");
        originalRole = membership.role;
        await revokeTx.query("UPDATE project_memberships SET role = $1 WHERE id = $2", [
          "revoked",
          membership.id,
        ]);
        await revokeTx.commit();
      } catch (error) {
        await revokeTx.rollback();
        throw error;
      }
      let revokedDriverError: unknown;
      try {
        await recoveryChecks.verifyRevoked();
        const revokedCounters: DriverCounters = { signerBuilds: 0, rpcCalls: 0 };
        const revokedRun = await makeDriver(
          revoked.bundle,
          revokedCounters,
          "acknowledged",
        ).executeClaimedWorkUnit(revoked.claim.workUnit, {
          ownerId: owner.id,
          claimOwner: owner.id,
          now: T5,
        });
        expect(revokedRun.status).toBe("waiting");
        const revokedOperation = (
          await scientificStore.getMissionProvenance("mission-md-1")
        ).operations.find((operation) => operation.workUnitId === revoked.claim.workUnit.id);
        if (!revokedOperation) throw new Error("Missing revoked MD driver operation");
        expect(revokedOperation.state).toBe("intent");
        expect(await scientificStore.getEffectAdmission(revokedOperation.id)).toBeNull();
        expect(await deliveryRows(revokedOperation.id)).toBe(0);
        expect({
          signerBuilds: revokedCounters.signerBuilds,
          rpcCalls: revokedCounters.rpcCalls,
        }).toEqual({ signerBuilds: 0, rpcCalls: 0 });
        expect(await scientificStore.getMissionProjectAssociation("mission-md-1")).toMatchObject({
          ownerUserId: reviewer.id,
          projectId: deliveryPrincipal.projectId,
        });
      } catch (error) {
        revokedDriverError = error;
      }
      const restoreTx = await database.beginTransaction();
      try {
        await restoreTx.query(
          "UPDATE project_memberships SET role = $1 WHERE project_id = $2 AND user_id = $3",
          [originalRole!, deliveryPrincipal.projectId, reviewer.id],
        );
        await restoreTx.commit();
      } catch (error) {
        await restoreTx.rollback();
        throw error;
      }
      if (revokedDriverError) throw revokedDriverError;
      await recoveryChecks.verifyLateReceipts();
    }

    await executeStageOperation(
      scientificStore,
      database,
      unvalidatedWorkUnit,
      "operation-equilibration-unvalidated",
      "receipt-equilibration-unvalidated",
    );
    const unvalidatedArtifacts = [
      artifact("restart", C("unvalidated-restart"), "unvalidated-restart-evidence"),
      artifact("mdout", C("unvalidated-mdout"), "unvalidated-mdout-evidence"),
      artifact("mdinfo", C("unvalidated-mdinfo"), "unvalidated-mdinfo-evidence"),
    ];
    for (const [artifactRef, label] of [
      [unvalidatedArtifacts[0]!, "unvalidated-restart"],
      [unvalidatedArtifacts[1]!, "unvalidated-mdout"],
      [unvalidatedArtifacts[2]!, "unvalidated-mdinfo"],
    ] as const) {
      await createCasEvidence(cas, scientificStore, {
        id: artifactRef.evidenceRef,
        label,
        kind: evidenceKindForArtifactRole(artifactRef.role),
        mediaType: artifactRef.mediaType,
        workUnitId: unvalidatedWorkUnit.id,
        sourceId: "receipt-equilibration-unvalidated",
      });
    }
    const nominalUnvalidatedResult = stageResult(approvedProtocol!, stage, {
      id: "stage-result-equilibration-unvalidated",
      workUnitId: unvalidatedWorkUnit.id,
      operationId: "operation-equilibration-unvalidated",
      operationReceiptId: "receipt-equilibration-unvalidated",
      artifacts: unvalidatedArtifacts,
    });
    const unvalidatedResultInput = {
      ...nominalUnvalidatedResult,
      validationStatus: "not_run" as const,
      validationRefs: [],
      resultDigest: D("0"),
    };
    const unvalidatedResult = MdStageResultSchema.parse({
      ...unvalidatedResultInput,
      resultDigest: computeMdStageResultDigest(unvalidatedResultInput),
    });
    await mdStore.putStageResult(unvalidatedResult);
    const unvalidatedAssessment = stageAssessment(unvalidatedResult, stage, {
      id: "assessment-equilibration-unvalidated",
      evidenceRef: "unvalidated-mdout-evidence",
    });
    await seedConfirmedOperation(database, {
      operationId: "operation-equilibration-unvalidated-assessment",
      receiptId: "receipt-equilibration-unvalidated-assessment",
      workUnitId: unvalidatedWorkUnit.id,
      capabilityId: "analysis.md-stage-assessment",
      operationKind: "trajectory_analysis",
      request: createMdStageAssessmentOperationRequest({
        workUnitId: unvalidatedWorkUnit.id,
        stageResult: unvalidatedResult,
        assessment: unvalidatedAssessment,
      }),
    });
    await mdStore.putAssessment(unvalidatedAssessment, {
      operationId: "operation-equilibration-unvalidated-assessment",
      operationReceiptId: "receipt-equilibration-unvalidated-assessment",
      subjectRevision: unvalidatedResult.revision,
    });
    const unvalidatedObserving = (await scientificStore.getWorkUnit(unvalidatedWorkUnit.id))!;
    expect(unvalidatedObserving.state).toBe("observing");
    await expect(
      scientificStore.completeMdWorkUnit({
        workUnitId: unvalidatedWorkUnit.id,
        expectedRevision: unvalidatedObserving.revision,
        stageResultId: unvalidatedResult.id,
        stageResultDigest: unvalidatedResult.resultDigest,
        assessmentId: unvalidatedAssessment.id,
        assessmentRevision: unvalidatedAssessment.revision,
        assessmentDigest: unvalidatedAssessment.assessmentDigest,
        at: T5,
        claimOwner: owner.id,
      }),
    ).rejects.toThrow();

    await executeStageOperation(
      scientificStore,
      database,
      equilibrationWorkUnit,
      "operation-equilibration",
      "receipt-equilibration",
    );
    const equilibrationResult = stageResult(approvedProtocol!, stage, {
      id: "stage-result-equilibration",
      workUnitId: equilibrationWorkUnit.id,
      operationId: "operation-equilibration",
      operationReceiptId: "receipt-equilibration",
      artifacts: equilibrationArtifacts,
    });
    await createStageValidation(scientificStore, {
      workUnitId: equilibrationWorkUnit.id,
      resultId: equilibrationResult.id,
      criterionId: stage.acceptanceCriteria[0]!.id,
      evidenceRef: "equil-mdout-evidence",
    });
    const unsupportedValidationInput = {
      ...equilibrationResult,
      validationStatus: "passed" as const,
      validationRefs: ["validation-that-does-not-exist"],
      resultDigest: D("0"),
    };
    const unsupportedValidationResult = MdStageResultSchema.parse({
      ...unsupportedValidationInput,
      resultDigest: computeMdStageResultDigest(unsupportedValidationInput),
    });
    await expect(mdStore.putStageResult(unsupportedValidationResult)).rejects.toThrow();
    const wrongEngineInput = {
      ...equilibrationResult,
      engine: { ...equilibrationResult.engine, buildDigest: D("1") },
      resultDigest: D("0"),
    };
    await expect(
      mdStore.putStageResult(
        MdStageResultSchema.parse({
          ...wrongEngineInput,
          resultDigest: computeMdStageResultDigest(wrongEngineInput),
        }),
      ),
    ).rejects.toThrow(/engine authorization/);
    const wrongOutputInput = {
      ...equilibrationResult,
      artifacts: equilibrationResult.artifacts.map((candidate) =>
        candidate.role === "mdout"
          ? { ...candidate, mediaType: "application/octet-stream" }
          : candidate,
      ),
      resultDigest: D("0"),
    };
    await expect(
      mdStore.putStageResult(
        MdStageResultSchema.parse({
          ...wrongOutputInput,
          resultDigest: computeMdStageResultDigest(wrongOutputInput),
        }),
      ),
    ).rejects.toThrow(/output-role authorization/);
    await mdStore.putStageResult(equilibrationResult);
    const equilibrationAssessment = stageAssessment(equilibrationResult, stage, {
      id: "assessment-equilibration-1",
      evidenceRef: "equil-mdout-evidence",
    });
    await seedConfirmedOperation(database, {
      operationId: "operation-equilibration-assessment-wrong",
      receiptId: "receipt-equilibration-assessment-wrong",
      workUnitId: equilibrationWorkUnit.id,
      capabilityId: "analysis.md-stage-assessment",
      operationKind: "trajectory_analysis",
    });
    await expect(
      mdStore.putAssessment(equilibrationAssessment, {
        operationId: "operation-equilibration-assessment-wrong",
        operationReceiptId: "receipt-equilibration-assessment-wrong",
        subjectRevision: equilibrationResult.revision,
      }),
    ).rejects.toThrow();
    const rejectedEquilibrationAssessment = stageAssessment(equilibrationResult, stage, {
      id: "assessment-equilibration-rejected",
      evidenceRef: "equil-mdout-evidence",
      status: "rejected",
    });
    await seedConfirmedOperation(database, {
      operationId: "operation-equilibration-assessment-rejected",
      receiptId: "receipt-equilibration-assessment-rejected",
      workUnitId: equilibrationWorkUnit.id,
      capabilityId: "analysis.md-stage-assessment",
      operationKind: "trajectory_analysis",
      request: createMdStageAssessmentOperationRequest({
        workUnitId: equilibrationWorkUnit.id,
        stageResult: equilibrationResult,
        assessment: rejectedEquilibrationAssessment,
      }),
    });
    await mdStore.putAssessment(rejectedEquilibrationAssessment, {
      operationId: "operation-equilibration-assessment-rejected",
      operationReceiptId: "receipt-equilibration-assessment-rejected",
      subjectRevision: equilibrationResult.revision,
    });
    await seedConfirmedOperation(database, {
      operationId: "operation-equilibration-assessment",
      receiptId: "receipt-equilibration-assessment",
      workUnitId: equilibrationWorkUnit.id,
      capabilityId: "analysis.md-stage-assessment",
      operationKind: "trajectory_analysis",
      request: createMdStageAssessmentOperationRequest({
        workUnitId: equilibrationWorkUnit.id,
        stageResult: equilibrationResult,
        assessment: equilibrationAssessment,
      }),
    });
    await mdStore.putAssessment(equilibrationAssessment, {
      operationId: "operation-equilibration-assessment",
      operationReceiptId: "receipt-equilibration-assessment",
      subjectRevision: equilibrationResult.revision,
    });
    await expect(
      mdStore.putAssessment(rejectedEquilibrationAssessment, {
        operationId: "operation-equilibration-assessment",
        operationReceiptId: "receipt-equilibration-assessment",
        subjectRevision: equilibrationResult.revision,
      }),
    ).rejects.toThrow();
    await completeStageWorkUnit(
      scientificStore,
      equilibrationWorkUnit.id,
      equilibrationResult,
      equilibrationAssessment,
      rejectedEquilibrationAssessment,
    );

    const replicaSetDigest = computeMdReplicaSetPayloadDigest(replicaSet);
    const replicaSegment = {
      replicaSetId: replicaSet.id,
      replicaSetRevision: replicaSet.revision,
      replicaSetDigest,
      replicaId: "replica-1",
      replicaIndex: 1,
      replicaSeed: 101,
      segmentIndex: 0,
      ...(explicitSeeds ? { segmentSeed: 101 } : {}),
    };
    const productionWorkUnit = capabilityWorkUnit(
      manifest,
      approvedProtocol!,
      productionStage,
      exactDecision,
      {
        id: "work-unit-production-replica-1-segment-0",
        planApprovalRef: planApproval.id,
        systemApprovalRef: systemApproval.id,
        protocolApprovalRef: protocolApproval.id,
        dependencies: [equilibrationWorkUnit.id],
        parentRestart: equilibrationArtifacts[0]!,
        inputRefs: [
          ...manifest.sourceEvidenceRefs,
          "topology-evidence",
          equilibrationArtifacts[0]!.evidenceRef,
        ],
        replicaSegment,
      },
    );
    for (const segmentSeed of explicitSeeds ? [undefined, 103, 999] : [101]) {
      const forged = structuredClone(productionWorkUnit);
      forged.id = `forged-segment-seed-${segmentSeed}`;
      forged.protocolFragment.parameters = {
        ...forged.protocolFragment.parameters,
        replicaSegment: { ...replicaSegment, segmentSeed },
      };
      await expect(scientificStore.createWorkUnits([forged])).rejects.toThrow(/segment seed/);
      expect(await scientificStore.getWorkUnit(forged.id)).toBeNull();
    }
    await scientificStore.createWorkUnits([productionWorkUnit]);
    expect(
      MdExecutionBindingParametersSchema.parse(
        (await scientificStore.getWorkUnit(productionWorkUnit.id))!.protocolFragment.parameters,
      ).replicaSegment?.segmentSeed,
    ).toBe(explicitSeeds ? 101 : undefined);

    const productionArtifacts = [
      artifact("restart", C("production-restart"), "production-restart-evidence"),
      artifact("trajectory", C("production-trajectory"), "production-trajectory-evidence"),
      artifact("mdout", C("production-mdout"), "production-mdout-evidence"),
      artifact("mdinfo", C("production-mdinfo"), "production-mdinfo-evidence"),
    ];
    for (const [artifactRef, label] of [
      [productionArtifacts[0]!, "production-restart"],
      [productionArtifacts[1]!, "production-trajectory"],
      [productionArtifacts[2]!, "production-mdout"],
      [productionArtifacts[3]!, "production-mdinfo"],
    ] as const) {
      await createCasEvidence(cas, scientificStore, {
        id: artifactRef.evidenceRef,
        label,
        kind: evidenceKindForArtifactRole(artifactRef.role),
        mediaType: artifactRef.mediaType,
        workUnitId: productionWorkUnit.id,
        sourceId: "receipt-production",
      });
    }
    await executeStageOperation(
      scientificStore,
      database,
      productionWorkUnit,
      "operation-production",
      "receipt-production",
    );
    const result = stageResult(approvedProtocol!, productionStage, {
      id: "stage-result-production",
      workUnitId: productionWorkUnit.id,
      operationId: "operation-production",
      operationReceiptId: "receipt-production",
      artifacts: productionArtifacts,
      parentRestart: equilibrationArtifacts[0]!,
      replicaSegment,
    });
    await createStageValidation(scientificStore, {
      workUnitId: productionWorkUnit.id,
      resultId: result.id,
      criterionId: productionStage.acceptanceCriteria[0]!.id,
      evidenceRef: "production-mdout-evidence",
    });
    await expect(new MdProjectionStore(database).putStageResult(result)).rejects.toThrow();
    await mdStore.putStageResult(result);
    await expect(
      mdStore.putStageResult({ ...result, validationStatus: "inconclusive" }),
    ).rejects.toThrow();
    expect((await mdStore.getStageResult(result.id))?.resultDigest).toBe(result.resultDigest);

    const segmentInput = {
      schemaVersion: TrajectorySegmentSchemaVersion,
      id: "trajectory-segment-replica-1-0",
      revision: 1,
      missionId: "mission-md-1",
      replicaId: "replica-1",
      stageResultId: result.id,
      segmentIndex: 0,
      parentRestart: equilibrationArtifacts[0]!,
      restart: productionArtifacts[0]!,
      trajectory: productionArtifacts[1]!,
      startStep: result.startStep,
      endStep: result.endStep,
      startTimePs: result.startTimePs,
      endTimePs: result.endTimePs,
      frameCount: 10,
      netcdf: {
        convention: "AMBER NetCDF",
        atomCount: manifest.atomCount,
        frameCount: 10,
        hasPeriodicBox: true,
      },
      continuity: {
        status: "verified" as const,
        expectedParentRestartDigest: equilibrationArtifacts[0]!.contentDigest,
        observedParentRestartDigest: equilibrationArtifacts[0]!.contentDigest,
        expectedStartStep: 0,
        observedStartStep: 0,
        expectedStartTimePs: 0,
        observedStartTimePs: 0,
        reason: "Exact parent restart and starting coordinates verified",
      },
      segmentDigest: D("0"),
      createdAt: T5,
    };
    const segment = TrajectorySegmentSchema.parse({
      ...segmentInput,
      segmentDigest: computeTrajectorySegmentDigest(segmentInput),
    });
    await mdStore.putTrajectorySegment(segment);

    const assessment = stageAssessment(result, productionStage, {
      id: "assessment-stage-1",
      evidenceRef: "production-mdout-evidence",
    });
    await seedConfirmedOperation(database, {
      operationId: "operation-stage-assessment",
      receiptId: "receipt-stage-assessment",
      workUnitId: productionWorkUnit.id,
      capabilityId: "analysis.md-stage-assessment",
      operationKind: "trajectory_analysis",
      request: createMdStageAssessmentOperationRequest({
        workUnitId: productionWorkUnit.id,
        stageResult: result,
        assessment,
      }),
    });
    await expect(
      mdStore.putAssessment(assessment, {
        operationId: "operation-stage-assessment",
        operationReceiptId: "receipt-stage-assessment",
        subjectRevision: result.revision + 1,
      }),
    ).rejects.toThrow();
    await mdStore.putAssessment(assessment, {
      operationId: "operation-stage-assessment",
      operationReceiptId: "receipt-stage-assessment",
      subjectRevision: result.revision,
    });
    expect((await mdStore.getAssessment(assessment.id, 1))?.assessmentDigest).toBe(
      assessment.assessmentDigest,
    );
    await completeStageWorkUnit(scientificStore, productionWorkUnit.id, result, assessment);
    let reviewMissionRevision = (await scientificStore.getMission("mission-md-1"))!.revision;
    for (const [to, reason] of [
      ["executing", "record analysis execution"],
      ["validating", "validate MD assessment"],
      ["replanning", "request assessment review"],
      ["awaiting_approval", "await assessment approval"],
    ] as const) {
      const transitioned = await scientificStore.transitionMission({
        missionId: "mission-md-1",
        expectedRevision: reviewMissionRevision,
        to,
        reason,
        actor: owner,
        at: T5,
      });
      reviewMissionRevision = transitioned.revision;
    }
    const assessmentApproval = approvalRequest({
      id: "approval-assessment-1",
      subjectType: "md_assessment",
      subjectId: assessment.id,
      digest: assessment.assessmentDigest,
    });
    expect((await scientificStore.createApprovalRequest(assessmentApproval)).subjectType).toBe(
      "md_assessment",
    );

    const tamper = await database.beginTransaction();
    await tamper.query(
      "UPDATE scientific_biomolecular_decisions SET payload_json = $1 WHERE id = $2 AND revision = 1",
      [
        canonicalJson({ ...approvedDecision!, rationale: "database payload tampering" }),
        approvedDecision!.id,
      ],
    );
    await tamper.commit();
    await expect(
      scientificStore.createApprovalRequest(
        approvalRequest({
          id: "approval-corrupt-decision",
          subjectType: "decision",
          subjectId: approvedDecision!.id,
          digest: approvedDecision!.decisionDigest,
        }),
      ),
    ).rejects.toThrow();
  }

  // This correctness fixture builds several persisted graphs; it is not a benchmark.
  const extendedCiTimeouts = process.env.EIGENGRID_CI_EXTENDED_TIMEOUTS === "1";
  for (const { provider, explicitSeeds } of [
    { provider: "sqlite", explicitSeeds: false },
    { provider: "sqlite", explicitSeeds: true },
    { provider: "postgres", explicitSeeds: true },
  ]) {
    test.skipIf(provider === "postgres" && !canRunPostgres)(
      `binds decisions, manifests, protocols, replicas, results, and assessments exactly (${provider}, explicit seeds=${explicitSeeds})`,
      () => exerciseDurableMdAuthority(provider, explicitSeeds),
      provider === "postgres"
        ? extendedCiTimeouts
          ? 180_000
          : 20_000
        : extendedCiTimeouts
          ? 20_000
          : 5_000,
    );
  }
});
