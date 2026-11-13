import {
  MissionBudgetSchema,
  SchemaVersion,
  ScientificMissionSchema,
  type EvidenceReference,
} from "@eigengrid/scientific-schema";
import type { MissionProvenance } from "@eigengrid/mission-runtime";
import type { MissionHttpIdempotencyRequest } from "./routes/mission-routes";

export function createReconciliationFixture() {
  const at = "2026-11-13T12:00:00.000Z";
  const actor = { id: "victor", kind: "human" as const, role: "scientific_reviewer" };
  const mission = ScientificMissionSchema.parse({
    schemaVersion: SchemaVersion,
    id: "mission-victor",
    revision: 1,
    state: "created",
    objective: {
      schemaVersion: SchemaVersion,
      id: "objective-victor",
      statement: "Read a public water fixture",
      system: {
        evidenceId: "public-water-connectivity",
        format: "xyz",
        contentDigest: "a".repeat(64),
        atomCount: 3,
        charge: 0,
        multiplicity: 1,
      },
      targetProperties: ["fixture connectivity"],
      requiredConfidence: "screening",
    },
    constraints: {
      allowedEngines: ["fixture"],
      deniedEngines: [],
      offlineRequired: true,
      materialChangesRequireApproval: true,
      immutableScientificFields: ["objective"],
    },
    assumptions: [],
    acceptanceCriteria: [
      {
        id: "criterion-fixture",
        kind: "normal_termination",
        description: "Fixture check",
        required: true,
      },
    ],
    activePlanId: null,
    budgetId: "budget-victor",
    policyProfile: "host-policy",
    requestedBy: actor,
    createdAt: at,
    updatedAt: at,
  });
  const budget = MissionBudgetSchema.parse({
    id: mission.budgetId,
    missionId: mission.id,
    revision: 1,
    limits: { externalOperations: 0, modelTokens: 12000, wallTimeSeconds: 300, cost: 0.02 },
    consumed: { externalOperations: 0, modelTokens: 0, wallTimeSeconds: 0, cost: 0 },
    reservations: [],
  });
  const evidence: EvidenceReference = {
    id: mission.objective.system.evidenceId,
    missionId: mission.id,
    kind: "objective",
    uri: `cas://sha256/${mission.objective.system.contentDigest}`,
    contentDigest: mission.objective.system.contentDigest,
    sizeBytes: 7,
    mediaType: "chemical/x-xyz",
    immutable: true,
    createdAt: at,
  };
  const { requestedBy: _actor, policyProfile: _policy, ...dto } = mission;
  const request = {
    projectId: "personal-victor",
    mission: structuredClone(dto),
    budget: structuredClone(budget),
    objectiveEvidence: [structuredClone(evidence)],
  };
  const record: MissionHttpIdempotencyRequest = {
    actorId: actor.id,
    projectId: request.projectId,
    operation: "create",
    key: "create-victor-1",
    requestDigest: "b".repeat(64),
    expectedRevision: 0,
    request,
  };
  const provenance: MissionProvenance = {
    mission,
    budget,
    evidence: [evidence],
    budgetReservations: [],
    skillResolutions: [],
    plans: [],
    workUnits: [],
    workUnitClaims: [],
    checkpoints: [],
    decisions: [],
    approvals: [],
    operations: [],
    receipts: [],
    observations: [],
    validations: [],
    modelInvocationIntents: [],
    modelInvocations: [],
    planningClaims: [],
    criticFindings: [],
    assessments: [],
    transitions: [],
    missingReferences: [],
    complete: true,
  };
  return { at, actor, mission, budget, evidence, request, record, provenance };
}
