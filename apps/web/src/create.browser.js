/** @param {{ projectId: string; missionId: string; statement: string; targetProperties: string[]; allowedEngines: string[]; criteria: string[]; limits: import('./contracts').CreateRequest['budget']['limits']; digest: string; size: number; format: import('./contracts').CreateRequest['mission']['objective']['system']['format']; confidence: 'exploratory' | 'screening' | 'defensible'; charge?: number; multiplicity?: number; environment?: string; offline: boolean }} input
 * @returns {import('./contracts').CreateRequest} */
export function createRequest(input) {
  const { missionId, digest } = input;
  const createdAt = new Date().toISOString();
  const evidenceId = `${missionId}.structure`;
  const budgetId = `${missionId}.budget`;
  return {
    projectId: input.projectId,
    mission: {
      schemaVersion: "eigengrid.scientific/v1",
      id: missionId,
      revision: 1,
      state: "created",
      objective: {
        schemaVersion: "eigengrid.scientific/v1",
        id: `${missionId}.objective`,
        statement: input.statement,
        system: {
          evidenceId,
          contentDigest: digest,
          format: input.format,
          ...(input.charge === undefined ? {} : { charge: input.charge }),
          ...(input.multiplicity === undefined ? {} : { multiplicity: input.multiplicity }),
        },
        targetProperties: input.targetProperties,
        requiredConfidence: input.confidence,
        ...(input.environment ? { environmentalModel: input.environment } : {}),
      },
      constraints: {
        allowedEngines: input.allowedEngines,
        deniedEngines: [],
        offlineRequired: input.offline,
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
      acceptanceCriteria: input.criteria.map((description, index) => ({
        id: `${missionId}.criterion-${index + 1}`,
        kind: "custom",
        description,
        required: true,
      })),
      activePlanId: null,
      budgetId,
      createdAt,
      updatedAt: createdAt,
    },
    budget: {
      id: budgetId,
      missionId,
      revision: 1,
      limits: input.limits,
      consumed: { externalOperations: 0, modelTokens: 0, wallTimeSeconds: 0, cost: 0 },
      reservations: [],
    },
    objectiveEvidence: [
      {
        id: evidenceId,
        missionId,
        kind: "structure",
        uri: `cas://sha256/${digest}`,
        contentDigest: digest,
        sizeBytes: input.size,
        immutable: true,
        createdAt,
      },
    ],
  };
}
