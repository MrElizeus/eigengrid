/** Synthetic molecular inputs and completed preparation records ONLY.
 * This fixture exercises real PostgreSQL authority, publication and delivery;
 * none of its bytes or seeded preparation receipts qualify scientific execution.
 * Canonical material constructors mirror md-projection-store fixtures so every
 * schema/approval/projection is checked by production stores before MD admission.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { AMBER_CANONICAL_STAGE_MAPPING_VERSION } from "@eigengrid/amber-adapter";
import type { DatabaseLike } from "@eigengrid/db";
import {
  ContentAddressedArtifactStore,
  MdProjectionStore,
  ScientificStore,
  computeBiomolecularDecisionMaterialDigest,
  computePlanDigest,
  computeProtocolDigest,
  computeSkillGraphDigest,
} from "@eigengrid/mission-runtime";
import {
  ApprovalRequestSchema,
  ApprovalResponseSchema,
  AtomMapPublicationRequestSchema,
  AtomMapPublicationRequestSchemaVersion,
  AtomMapSchema,
  AtomMapSchemaVersion,
  BiomolecularComponentSchemaVersion,
  BiomolecularDecisionSchemaVersion,
  BiomolecularMaterialPublicationBindingSchema,
  BiomolecularMaterialPublicationBindingSchemaVersion,
  BiomolecularSystemBuildRequestSchema,
  BiomolecularSystemBuildRequestSchemaVersion,
  BiomolecularSystemManifestSchema,
  ConstructDecisionSchema,
  EvidenceReferenceSchema,
  ExternalOperationSchema,
  ForceFieldStackDecisionSchema,
  ForceFieldStackManifestSchema,
  ForceFieldStackPublicationRequestSchema,
  ForceFieldStackPublicationRequestSchemaVersion,
  ForceFieldStackSchemaVersion,
  MdAssessmentSchemaVersion,
  MdExecutionBindingParametersSchema,
  MdExecutionBindingParametersSchemaVersion,
  MdProtocolSchemaVersion,
  MdStageSchemaVersion,
  MdStageSpecSchema,
  MdWorkflowProtocolSchema,
  MembraneModelDecisionSchema,
  MissionBudgetSchema,
  OperationReceiptSchema,
  PublishedBiomolecularSystemManifestSchemaVersion,
  ReceptorProtonationDecisionSchema,
  SchemaVersion,
  ScientificMissionSchema,
  ScientificPlanSchema,
  WorkUnitSchema,
  canonicalJson,
  computeAtomMapDigest,
  computeBiomolecularSystemManifestDigest,
  computeForceFieldStackDigest,
  computeMdAcceptanceCriterionDigest,
  computeMdStageSpecDigest,
  computeMdWorkflowProtocolDigest,
  digestCanonical,
  type ActorIdentity,
  type EvidenceReference,
  type MdArtifactReference,
  type MdArtifactRole,
  type MdExecutionBindingParameters,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import { expect } from "bun:test";
import { createHash } from "node:crypto";

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
/** Test-only overrides are scoped to one seed call, including concurrent suites. */
export interface CanonicalMdFixtureOptions {
  objectiveContent?: string;
  policyDigest?: string;
  environmentDigest?: string;
  stopAfterPreparation?: boolean;
  downstreamKind?: "equilibration";
  productionSegments?: number;
  /** Test-only lease schedule, approvals keep their independently defined expiry. */
  workUnitLeaseExpiresAt?: string;
}
const fixtureOptions = new AsyncLocalStorage<CanonicalMdFixtureOptions>();
const currentFixturePolicy = () => fixtureOptions.getStore()?.policyDigest ?? policyDigest;
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
        contentDigest:
          fixtureOptions.getStore()?.objectiveContent === undefined
            ? D("1")
            : C(fixtureOptions.getStore()!.objectiveContent!),
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
    environmentDigest: fixtureOptions.getStore()?.environmentDigest ?? D("6"),
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
    policyDigest: currentFixturePolicy(),
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
    policyDigest: currentFixturePolicy(),
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
    policyDigest: currentFixturePolicy(),
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
        currentFixturePolicy(),
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
        currentFixturePolicy(),
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
        currentFixturePolicy(),
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
    policyDigest: currentFixturePolicy(),
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
    systemClass: manifest.membrane === null ? ("soluble" as const) : ("membrane" as const),
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
    id: "stage-heating-1",
    revision: 1,
    sequence: 1,
    kind: "heating" as const,
    name: "synthetic heating contract fixture",
    system,
    parentStageId: null,
    requiredParentOutputRole: null,
    inputs: [
      artifact("topology", manifest.topologyDigest, "topology-evidence"),
      artifact("coordinates", manifest.coordinateDigest, "coordinates-evidence"),
    ],
    ensemble: "nvt" as const,
    steps: 1_000,
    timeStepPs: 0.002,
    simulatedTimePs: 2,
    temperature: {
      points: [
        { step: 0, kelvin: 50 },
        { step: 1_000, kelvin: 300 },
      ],
    },
    thermostat: { kind: "langevin" as const, collisionFrequencyPerPs: 1 },
    barostat: { kind: "none" as const },
    constraints: { bondsToHydrogen: true, tolerance: 0.00001, maximumIterations: 3001 },
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
      {
        role: "restart" as const,
        required: true,
        mediaType: "application/vnd.amber.rst7",
        cadenceSteps: 500,
      },
      {
        role: "trajectory" as const,
        required: true,
        mediaType: "application/x-netcdf",
        cadenceSteps: 100,
      },
      { role: "mdout" as const, required: true, mediaType: "text/plain", cadenceSteps: 100 },
      { role: "mdinfo" as const, required: true, mediaType: "text/plain" },
    ],
    acceptanceCriteria: [criterion],
    sourceDecisionRefs: ["construct-decision-1"],
    rendererCompatibilityVersion: AMBER_CANONICAL_STAGE_MAPPING_VERSION,
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
    kind: fixtureOptions.getStore()?.downstreamKind ?? ("production" as const),
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
      coupling: manifest.membrane === null ? ("isotropic" as const) : ("semiisotropic" as const),
      targetPressureBar: 1,
      relaxationTimePs: 2,
    },
    constraints: { bondsToHydrogen: true, tolerance: 0.00001, maximumIterations: 3001 },
    restraints: [],
    nonbonded: {
      cutoffAngstrom: 9,
      electrostatics: "pme" as const,
      ewaldTolerance: 0.00001,
      periodicBoundary: true as const,
    },
    randomSeed: fixtureOptions.getStore()?.productionSegments
      ? {
          policy: "replica_segment" as const,
          segmentCount: fixtureOptions.getStore()!.productionSegments!,
        }
      : { policy: "fixed" as const, seed: 12345 },
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
      {
        role: "restart" as const,
        required: true,
        mediaType: "application/vnd.amber.rst7",
        cadenceSteps: 500,
      },
      {
        role: "trajectory" as const,
        required: true,
        mediaType: "application/x-netcdf",
        cadenceSteps: 100,
      },
      { role: "mdout" as const, required: true, mediaType: "text/plain", cadenceSteps: 100 },
      { role: "mdinfo" as const, required: true, mediaType: "text/plain" },
    ],
    acceptanceCriteria: [criterion],
    sourceDecisionRefs: ["construct-decision-1"],
    rendererCompatibilityVersion: AMBER_CANONICAL_STAGE_MAPPING_VERSION,
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
  const stages = [stage, production];
  if (production.kind !== "production") {
    const terminal = {
      ...production,
      id: "stage-terminal-production",
      sequence: 3,
      kind: "production" as const,
      parentStageId: production.id,
    };
    stages.push(
      MdStageSpecSchema.parse({ ...terminal, stageDigest: computeMdStageSpecDigest(terminal) }),
    );
  }
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
    stages,
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

function approvalContext(now: string) {
  return {
    now,
    currentPolicyDigest: currentFixturePolicy(),
    authenticatedActor: reviewer as ActorIdentity,
    authorizedRoles: [reviewer.role],
  };
}

export const MD_FIXTURE_NOW = T5;
export const MD_FIXTURE_POLICY = policyDigest;
export const MD_FIXTURE_SUBJECT = reviewer.id;
export const MD_FIXTURE_PROJECT = "project-md-boundary";

export async function seedCanonicalMdAuthority(
  database: DatabaseLike,
  cas: ContentAddressedArtifactStore,
  workUnitIds: readonly string[],
  options: CanonicalMdFixtureOptions = {},
) {
  return fixtureOptions.run(options, async () => {
    const scientificStore = new ScientificStore(database);
    const mdStore = new MdProjectionStore(database, cas);
    await database.createUser({ id: reviewer.id, username: "scientist_fixture" });
    await database.createProject({ id: MD_FIXTURE_PROJECT, name: "Counted boundary fixture" });
    await database.addProjectMember(MD_FIXTURE_PROJECT, reviewer.id, "member");
    await scientificStore.createMissionInProject({
      mission: missionFixture(),
      budget: budgetFixture(),
      projectId: MD_FIXTURE_PROJECT,
      ownerUserId: reviewer.id,
    });
    if (options.objectiveContent !== undefined)
      await createCasEvidence(cas, scientificStore, {
        id: "objective-evidence",
        label: options.objectiveContent,
        kind: "structure",
      });
    let revision = 1;
    for (const [state, at] of [
      ["scoping", T1],
      ["planning", T2],
      ["awaiting_approval", T3],
    ] as const) {
      const mission = await scientificStore.transitionMission({
        missionId: "mission-md-1",
        expectedRevision: revision,
        to: state,
        reason: "Prepare counted integration fixture",
        actor: owner,
        at,
      });
      revision = mission.revision;
    }
    const plan = planFixture();
    await scientificStore.createPlan(plan);
    for (const evidence of [
      { id: "system-evidence", label: "system-source", kind: "source_snapshot" as const },
      { id: "protein-evidence", label: "protein-source", kind: "structure" as const },
      { id: "lipid-evidence", label: "lipid-source", kind: "structure" as const },
      { id: "water-evidence", label: "water-source", kind: "structure" as const },
      { id: "construct-evidence", label: "construct-audit", kind: "construct_audit" as const },
      { id: "construct-output-evidence", label: "constructed-protein", kind: "structure" as const },
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
    ])
      await createCasEvidence(cas, scientificStore, evidence);
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
    await seedConfirmedOperation(database, {
      operationId: "operation-force-field-stack",
      receiptId: "receipt-force-field-stack",
      workUnitId: stackWorkUnit.id,
      capabilityId: "amber.force-field-stack",
      request: forceFieldPublicationRequest(stack, stackWorkUnit),
      workUnit: stackWorkUnit,
    });
    await createCasEvidence(cas, scientificStore, {
      id: "force-field-stack-evidence",
      label: canonicalJson(
        Object.fromEntries(Object.entries(stack).filter(([key]) => key !== "stackDigest")),
      ),
      kind: "force_field_stack",
      mediaType: "application/vnd.eigengrid.force-field-stack+json",
      workUnitId: stackWorkUnit.id,
      sourceId: "receipt-force-field-stack",
    });
    await mdStore.putForceFieldStack(stack, {
      missionId: "mission-md-1",
      operationId: "operation-force-field-stack",
      operationReceiptId: "receipt-force-field-stack",
    });
    async function approve(input: Parameters<typeof approvalRequest>[0]) {
      const request = approvalRequest(input);
      await scientificStore.createApprovalRequest(request);
      await scientificStore.respondToApproval(
        request.id,
        approvalResponse(request, T5),
        approvalContext(T5),
      );
      return request;
    }
    async function approveDecision<
      T extends Parameters<MdProjectionStore["putBiomolecularDecision"]>[0],
    >(proposed: T) {
      await mdStore.putBiomolecularDecision(proposed);
      await approve({
        id: `approval-${proposed.id}`,
        subjectType: "decision",
        subjectId: proposed.id,
        digest: computeBiomolecularDecisionMaterialDigest(proposed),
      });
      return (await mdStore.getBiomolecularDecision(proposed.id, proposed.revision)) as T & {
        status: "approved";
        approvalRef: string;
      };
    }
    const construct = await approveDecision(constructDecision());
    const decisions = {
      construct,
      forceField: await approveDecision(forceFieldDecision(stack)),
      protonation: await approveDecision(receptorProtonationDecision(construct)),
      membrane: await approveDecision(membraneModelDecision()),
    };
    const atomMap = signedAtomMap();
    const manifest = systemManifest(decisions, stack.stackDigest, atomMap.mapDigest);
    const buildWorkUnit = systemBuildWorkUnit(manifest);
    await seedConfirmedOperation(database, {
      operationId: "operation-build-system",
      receiptId: "receipt-build-system",
      workUnitId: buildWorkUnit.id,
      capabilityId: "biomolecular.build-system",
      request: systemBuildRequest(manifest, buildWorkUnit),
      workUnit: buildWorkUnit,
    });
    for (const evidence of [
      { id: "topology-evidence", label: "topology", kind: "topology" as const },
      { id: "coordinates-evidence", label: "coordinates", kind: "coordinates" as const },
      {
        id: "atom-map-evidence",
        label: canonicalJson(
          Object.fromEntries(Object.entries(atomMap).filter(([key]) => key !== "mapDigest")),
        ),
        kind: "atom_map" as const,
        mediaType: "application/vnd.eigengrid.atom-map+json",
      },
    ])
      await createCasEvidence(cas, scientificStore, {
        ...evidence,
        workUnitId: buildWorkUnit.id,
        sourceId: "receipt-build-system",
      });
    await mdStore.putSystemManifest(manifest);
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
    await seedConfirmedOperation(database, {
      operationId: "operation-atom-map",
      receiptId: "receipt-atom-map",
      workUnitId: atomMapWorkUnit.id,
      capabilityId: "amber.topology-coordinate-validation",
      request: atomMapPublicationRequest(atomMap, manifest, atomMapWorkUnit),
      workUnit: atomMapWorkUnit,
    });
    await mdStore.putAtomMap(atomMap, {
      missionId: "mission-md-1",
      operationId: "operation-atom-map",
      operationReceiptId: "receipt-atom-map",
    });
    const stage = stageSpec(manifest);
    const protocol = workflowProtocol(manifest, stage, productionStageSpec(manifest, stage));
    const stageSkillBindings = protocol.stages.map((item) => ({
      stageId: item.id,
      fragments: [mdFragment],
    }));
    if (options.stopAfterPreparation)
      return {
        store: scientificStore,
        mdStore,
        stage,
        atomMap,
        workUnits: [] as WorkUnit[],
        ownerId: owner.id,
        plan,
        manifest,
        protocol,
        stageSkillBindings,
      };
    const systemApproval = await approve({
      id: "approval-system-1",
      subjectType: "biomolecular_system_manifest",
      subjectId: manifest.id,
      digest: manifest.manifestDigest,
    });
    await mdStore.putProtocol(protocol, { planId: plan.id, planVersion: 1 });
    const protocolApproval = await approve({
      id: "approval-protocol-1",
      subjectType: "md_protocol",
      subjectId: protocol.id,
      digest: protocol.protocolDigest,
    });
    const approvedProtocol = await mdStore.getProtocol(protocol.id, 1);
    if (!approvedProtocol) throw new Error("Fixture protocol missing after real approval");
    const planApproval = await approve({
      id: "approval-plan-1",
      subjectType: "plan",
      subjectId: plan.id,
      digest: plan.planDigest,
    });
    await scientificStore.activatePlan({
      missionId: "mission-md-1",
      planId: plan.id,
      expectedMissionRevision: revision,
      actor: owner,
      at: T5,
    });
    await scientificStore.transitionMission({
      missionId: "mission-md-1",
      expectedRevision: revision + 1,
      to: "ready",
      reason: "Fixture authorities approved",
      actor: owner,
      at: T5,
    });
    const workUnits: WorkUnit[] = [];
    for (const id of workUnitIds) {
      const workUnit = capabilityWorkUnit(manifest, approvedProtocol, stage, construct, {
        id,
        planApprovalRef: planApproval.id,
        systemApprovalRef: systemApproval.id,
        protocolApprovalRef: protocolApproval.id,
      });
      await scientificStore.createWorkUnits([workUnit]);
      await scientificStore.transitionWorkUnit({
        workUnitId: id,
        expectedRevision: 1,
        to: "ready",
        at: T5,
      });
      const claim = await scientificStore.claimWorkUnit({
        workUnitId: id,
        ownerId: owner.id,
        now: T5,
        expiresAt: options.workUnitLeaseExpiresAt ?? "2026-08-24T00:00:00.000Z",
        policyDigest: currentFixturePolicy(),
      });
      if (!claim.claimed) throw new Error(claim.message);
      workUnits.push(claim.workUnit);
    }
    return {
      store: scientificStore,
      mdStore,
      stage,
      atomMap,
      workUnits,
      ownerId: owner.id,
      plan,
      manifest,
      protocol,
      stageSkillBindings,
    };
  });
}
