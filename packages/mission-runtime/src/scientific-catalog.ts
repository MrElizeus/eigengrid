/** Authorized, bounded discovery for the human application. Never lists legacy unbound work. */
import {
  ScientificMissionSchema,
  digestCanonical,
  type ScientificMission,
} from "@eigengrid/scientific-schema";
import { z } from "zod";
import { ScientificIntegrityError } from "./errors";
import {
  MissionProjectIdentitySchema,
  assertMissionProjectCreationAuthority,
  assertProjectPlanningAuthority,
  readScientificMissionProjectAssociation,
} from "./mission-project";
import type { ScientificStoreContext } from "./scientific-store-context";
import { parsePayload, type JsonRow } from "./scientific-store-validation";

const Page = z.object({
  ownerUserId: MissionProjectIdentitySchema,
  after: MissionProjectIdentitySchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
const Projects = Page.extend({ projectIds: z.array(MissionProjectIdentitySchema).max(1024) });
const Missions = Page.extend({ projectId: MissionProjectIdentitySchema });

export interface ScientificProjectSummary {
  id: string;
  name: string;
  description: string | null;
  role: string;
}
export interface ScientificMissionSummary {
  id: string;
  revision: number;
  state: ScientificMission["state"];
  statement: string;
  targetProperties: string[];
  activePlanId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ScientificCatalogPage<T> {
  items: T[];
  nextCursor: string | null;
}

export class ScientificCatalog {
  constructor(private readonly context: ScientificStoreContext) {}

  async listProjects(
    input: z.input<typeof Projects>,
  ): Promise<ScientificCatalogPage<ScientificProjectSummary>> {
    const value = Projects.parse(input);
    if (value.projectIds.length === 0) return { items: [], nextCursor: null };
    return this.context.inTransaction("list authorized projects", async (tx) => {
      const projectIds = [...new Set(value.projectIds)];
      const placeholders = projectIds.map((_, i) => `$${i + 4}`).join(", ");
      const rows = await tx.queryRows<Record<string, unknown>>(
        `SELECT p.id, p.name, p.description, m.role FROM projects p
         JOIN project_memberships m ON m.project_id = p.id AND m.user_id = $1
         JOIN users u ON u.id = m.user_id
         WHERE p.status = 'active' AND u.status = 'active'
         AND m.role IN ('owner', 'admin', 'member') AND p.id > $2
         AND p.id IN (${placeholders})
         AND (SELECT COUNT(*) FROM project_memberships members
              WHERE members.project_id = p.id AND members.user_id = $1) = 1
         ORDER BY p.id LIMIT $3`,
        [value.ownerUserId, value.after ?? "", value.limit + 1, ...projectIds],
      );
      const items: ScientificProjectSummary[] = [];
      for (const row of rows.slice(0, value.limit)) {
        const id = MissionProjectIdentitySchema.parse(row.id);
        await assertProjectPlanningAuthority(
          tx,
          { projectId: id, ownerUserId: value.ownerUserId },
          this.context.database._provider,
        );
        items.push({
          id,
          name: String(row.name),
          description: row.description == null ? null : String(row.description),
          role: String(row.role),
        });
      }
      return { items, nextCursor: rows.length > value.limit ? items.at(-1)!.id : null };
    });
  }

  async listMissions(
    input: z.input<typeof Missions>,
  ): Promise<ScientificCatalogPage<ScientificMissionSummary>> {
    const value = Missions.parse(input);
    return this.context.inTransaction("list authorized project missions", async (tx) => {
      await assertProjectPlanningAuthority(tx, value, this.context.database._provider);
      const rows = await tx.queryRows<JsonRow>(
        `SELECT m.* FROM scientific_missions m
         JOIN scientific_mission_projects a ON a.mission_id = m.id
         WHERE a.project_id = $1 AND a.owner_user_id = $2 AND m.id > $3
         ORDER BY m.id LIMIT $4`,
        [value.projectId, value.ownerUserId, value.after ?? "", value.limit + 1],
      );
      const items: ScientificMissionSummary[] = [];
      for (const row of rows.slice(0, value.limit)) {
        const mission = parsePayload(ScientificMissionSchema, row, "catalog mission");
        if (
          mission.id !== row.id ||
          mission.revision !== Number(row.revision) ||
          mission.state !== row.state ||
          digestCanonical(mission) !== row.payload_digest
        )
          throw new ScientificIntegrityError("Mission catalog identity differs from its payload");
        await assertMissionProjectCreationAuthority(
          tx,
          { mission, ...value },
          this.context.database._provider,
        );
        const association = await readScientificMissionProjectAssociation(
          tx,
          mission.id,
          this.context.database._provider,
        );
        if (
          !association ||
          association.projectId !== value.projectId ||
          association.ownerUserId !== value.ownerUserId
        )
          throw new ScientificIntegrityError(
            "Mission catalog association differs from its authority",
          );
        items.push({
          id: mission.id,
          revision: mission.revision,
          state: mission.state,
          statement: mission.objective.statement,
          targetProperties: mission.objective.targetProperties,
          activePlanId: mission.activePlanId,
          createdAt: mission.createdAt,
          updatedAt: mission.updatedAt,
        });
      }
      return { items, nextCursor: rows.length > value.limit ? items.at(-1)!.id : null };
    });
  }
}
