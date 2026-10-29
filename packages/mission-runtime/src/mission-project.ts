import { z } from "zod";
import {
  DigestSchema,
  TimestampSchema,
  canonicalJson,
  digestCanonical,
  type ScientificMission,
} from "@eigengrid/scientific-schema";
import { ScientificIntegrityError } from "./errors";
import type { ScientificTransaction } from "./types";

/**
 * IDs carried across the mission/project and submitter boundary. Keep this
 * deliberately narrower than a free-form database string: the same project
 * must later be representable in the frozen per-UID submitter capability.
 */
export const MissionProjectIdentitySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u);

export const ScientificMissionProjectAssociationSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.scientific-mission-project/v1"),
    missionId: MissionProjectIdentitySchema,
    projectId: MissionProjectIdentitySchema,
    ownerUserId: MissionProjectIdentitySchema,
    createdAt: TimestampSchema,
    associationDigest: DigestSchema,
  })
  .strict();
export type ScientificMissionProjectAssociation = z.infer<
  typeof ScientificMissionProjectAssociationSchema
>;

export interface MissionProjectCreationAuthorityInput {
  mission: ScientificMission;
  projectId: string;
  ownerUserId: string;
}

type AssociationRow = Record<string, unknown> & { payload_json: string };

function assertIndexedColumns(row: AssociationRow, expected: Record<string, unknown>): void {
  if (Object.entries(expected).some(([key, value]) => row[key] !== value)) {
    throw new ScientificIntegrityError(
      "Scientific mission-project index differs from its immutable payload",
    );
  }
}

/**
 * Build the append-only association payload. Database authority is deliberately
 * checked separately, while the payload remains derived entirely from the
 * immutable mission aggregate and the exact selected project/owner.
 */
export function createScientificMissionProjectAssociation(
  input: MissionProjectCreationAuthorityInput,
): ScientificMissionProjectAssociation {
  const missionId = MissionProjectIdentitySchema.parse(input.mission.id);
  const projectId = MissionProjectIdentitySchema.parse(input.projectId);
  const ownerUserId = MissionProjectIdentitySchema.parse(input.ownerUserId);
  if (input.mission.requestedBy.kind !== "human" || input.mission.requestedBy.id !== ownerUserId) {
    throw new ScientificIntegrityError(
      "A production mission-project association requires its requesting human owner",
    );
  }
  const unsigned = {
    schemaVersion: "eigengrid.scientific-mission-project/v1" as const,
    missionId,
    projectId,
    ownerUserId,
    createdAt: input.mission.createdAt,
  };
  return ScientificMissionProjectAssociationSchema.parse({
    ...unsigned,
    associationDigest: digestCanonical(unsigned),
  });
}

export function assertScientificMissionProjectAssociation(
  value: unknown,
): ScientificMissionProjectAssociation {
  const association = ScientificMissionProjectAssociationSchema.parse(value);
  const { associationDigest, ...unsigned } = association;
  if (associationDigest !== digestCanonical(unsigned)) {
    throw new ScientificIntegrityError("Scientific mission-project association digest is invalid");
  }
  return association;
}

/**
 * Resolve the current database authority that permits a human to create a
 * production mission inside an existing project. The caller must keep this
 * transaction open until mission, budget and association are all persisted.
 */
export async function assertMissionProjectCreationAuthority(
  tx: ScientificTransaction,
  input: MissionProjectCreationAuthorityInput,
  provider: string,
): Promise<{ projectId: string; ownerUserId: string }> {
  const projectId = MissionProjectIdentitySchema.parse(input.projectId);
  const ownerUserId = MissionProjectIdentitySchema.parse(input.ownerUserId);
  if (input.mission.requestedBy.kind !== "human" || input.mission.requestedBy.id !== ownerUserId) {
    throw new ScientificIntegrityError(
      "A production mission-project association requires its requesting human owner",
    );
  }
  return assertProjectPlanningAuthority(tx, { projectId, ownerUserId }, provider);
}

/** Same live membership rule for staging inputs before a mission exists. */
export async function assertProjectPlanningAuthority(
  tx: ScientificTransaction,
  input: { projectId: string; ownerUserId: string },
  provider: string,
): Promise<{ projectId: string; ownerUserId: string }> {
  const projectId = MissionProjectIdentitySchema.parse(input.projectId);
  const ownerUserId = MissionProjectIdentitySchema.parse(input.ownerUserId);
  const lock = provider === "postgres" ? " FOR UPDATE" : "";
  const users = await tx.queryRows<Record<string, unknown>>(
    `SELECT * FROM users WHERE id = $1${lock}`,
    [ownerUserId],
  );
  const projects = await tx.queryRows<Record<string, unknown>>(
    `SELECT * FROM projects WHERE id = $1${lock}`,
    [projectId],
  );
  const memberships = await tx.queryRows<Record<string, unknown>>(
    `SELECT * FROM project_memberships WHERE project_id = $1 AND user_id = $2 ORDER BY id${lock}`,
    [projectId, ownerUserId],
  );
  if (
    users.length !== 1 ||
    users[0]!.status !== "active" ||
    projects.length !== 1 ||
    projects[0]!.status !== "active" ||
    memberships.length !== 1 ||
    !["owner", "admin", "member"].includes(String(memberships[0]!.role))
  ) {
    throw new ScientificIntegrityError(
      "Production mission project membership is missing, revoked, ambiguous or insufficient",
    );
  }
  return { projectId, ownerUserId };
}

/** Read and verify the immutable association. A missing row is intentionally
 * distinguishable from a malformed row so callers can fail closed by purpose.
 */
export async function readScientificMissionProjectAssociation(
  tx: ScientificTransaction,
  missionIdValue: string,
  provider?: string,
  lock = false,
): Promise<ScientificMissionProjectAssociation | null> {
  const missionId = MissionProjectIdentitySchema.parse(missionIdValue);
  const lockClause = lock && provider === "postgres" ? " FOR UPDATE" : "";
  const [row] = await tx.queryRows<AssociationRow>(
    `SELECT * FROM scientific_mission_projects WHERE mission_id = $1${lockClause}`,
    [missionId],
  );
  if (!row) return null;
  let association: ScientificMissionProjectAssociation;
  try {
    association = assertScientificMissionProjectAssociation(JSON.parse(row.payload_json));
  } catch (error) {
    if (error instanceof ScientificIntegrityError) throw error;
    throw new ScientificIntegrityError("Scientific mission-project payload is invalid");
  }
  if (association.missionId !== missionId) {
    throw new ScientificIntegrityError(
      "Scientific mission-project association belongs to another mission",
    );
  }
  assertIndexedColumns(row, {
    mission_id: association.missionId,
    project_id: association.projectId,
    owner_user_id: association.ownerUserId,
    association_digest: association.associationDigest,
    created_at: association.createdAt,
  });
  return association;
}

/** SQL values are exported only so the store can insert the verified, immutable
 * payload in the same transaction as the mission aggregate. */
export function scientificMissionProjectAssociationValues(
  association: ScientificMissionProjectAssociation,
): readonly unknown[] {
  return [
    association.missionId,
    association.projectId,
    association.ownerUserId,
    association.associationDigest,
    canonicalJson(association),
    association.createdAt,
  ];
}
