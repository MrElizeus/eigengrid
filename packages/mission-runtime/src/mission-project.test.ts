import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PostgresDatabase } from "@eigengrid/db";
import {
  MissionBudgetSchema,
  SchemaVersion,
  ScientificMissionSchema,
  type ActorIdentity,
  type MissionBudget,
  type ScientificMission,
} from "@eigengrid/scientific-schema";
import {
  ScientificEntityConflictError,
  ScientificIntegrityError,
  ScientificStore,
  assertMdDeliveryProjectAccess,
  freezeMdEffectDelivery,
  type MdSubmissionAuthority,
  type ScientificTransaction,
} from "./index";
import {
  canRunPostgres,
  startEphemeralPostgres,
  type EphemeralPostgresCluster,
} from "../../../tests/ts/helpers/postgres";

const T0 = "2026-09-20T00:00:00.000Z";
const D = (character: string): string => character.repeat(64);
const owner: ActorIdentity = {
  id: "scientist-project-owner",
  kind: "human" as const,
  role: "member",
};

function missionFixture(
  id = "mission-project-fixture",
  requestedBy: ActorIdentity = owner,
): ScientificMission {
  return ScientificMissionSchema.parse({
    schemaVersion: SchemaVersion,
    id,
    revision: 1,
    state: "created",
    objective: {
      schemaVersion: SchemaVersion,
      id: `${id}-objective`,
      statement: "Verify the immutable production mission/project association fixture",
      system: {
        evidenceId: `${id}-evidence`,
        format: "xyz",
        contentDigest: D("a"),
        atomCount: 3,
        charge: 0,
        multiplicity: 1,
      },
      targetProperties: ["association integrity"],
      requiredConfidence: "screening",
    },
    constraints: {
      allowedEngines: ["fixture"],
      deniedEngines: [],
      offlineRequired: true,
      materialChangesRequireApproval: true,
      immutableScientificFields: ["objective", "charge", "multiplicity"],
    },
    assumptions: [],
    acceptanceCriteria: [
      {
        id: `${id}-criterion`,
        kind: "normal_termination",
        description: "Fixture completes its authority checks without an external effect.",
        required: true,
      },
    ],
    activePlanId: null,
    budgetId: `${id}-budget`,
    policyProfile: "production-v1-fixture",
    requestedBy,
    createdAt: T0,
    updatedAt: T0,
  });
}

function budgetFixture(mission: ScientificMission): MissionBudget {
  return MissionBudgetSchema.parse({
    id: mission.budgetId,
    missionId: mission.id,
    revision: 1,
    limits: { externalOperations: 1, modelTokens: 1, wallTimeSeconds: 60, cost: 0 },
    consumed: { externalOperations: 0, modelTokens: 0, wallTimeSeconds: 0, cost: 0 },
    reservations: [],
  });
}

describe.skipIf(!canRunPostgres)(
  "ScientificStore production mission-project association (real PostgreSQL)",
  () => {
    let cluster: EphemeralPostgresCluster;
    let database: PostgresDatabase;
    let store: ScientificStore;

    beforeEach(async () => {
      cluster = await startEphemeralPostgres();
      database = new PostgresDatabase(cluster.url);
      await database.init();
      store = new ScientificStore(database);
      await database.createUser({ id: owner.id, username: "scientist-project-owner" });
      await database.createProject({ id: "project-fixture", name: "Project fixture" });
      await database.addProjectMember("project-fixture", owner.id, "member");
    });

    afterEach(async () => {
      await cluster.cleanup();
    });

    async function aggregateRows(missionId: string): Promise<{
      missions: number;
      budgets: number;
      associations: number;
    }> {
      const tx = (await database.beginTransaction()) as ScientificTransaction;
      try {
        const [missions] = await tx.queryRows<{ count: string }>(
          "SELECT count(*)::text AS count FROM scientific_missions WHERE id = $1",
          [missionId],
        );
        const [budgets] = await tx.queryRows<{ count: string }>(
          "SELECT count(*)::text AS count FROM scientific_mission_budgets WHERE mission_id = $1",
          [missionId],
        );
        const [associations] = await tx.queryRows<{ count: string }>(
          "SELECT count(*)::text AS count FROM scientific_mission_projects WHERE mission_id = $1",
          [missionId],
        );
        return {
          missions: Number(missions?.count ?? 0),
          budgets: Number(budgets?.count ?? 0),
          associations: Number(associations?.count ?? 0),
        };
      } finally {
        await tx.rollback();
      }
    }

    async function createBoundMission(
      mission = missionFixture(),
      projectId = "project-fixture",
      ownerUserId = owner.id,
    ): Promise<ScientificMission> {
      return store.createMissionInProject({
        mission,
        budget: budgetFixture(mission),
        projectId,
        ownerUserId,
      });
    }

    test("commits mission, budget and immutable association atomically and is exact-idempotent", async () => {
      const mission = missionFixture();
      const input = {
        mission,
        budget: budgetFixture(mission),
        projectId: "project-fixture",
        ownerUserId: owner.id,
      };
      const [first, repeated] = await Promise.all([
        store.createMissionInProject(input),
        store.createMissionInProject(input),
      ]);
      expect(first).toEqual(mission);
      expect(repeated).toEqual(mission);
      expect(await aggregateRows(mission.id)).toEqual({ missions: 1, budgets: 1, associations: 1 });
      expect(await store.getMissionProjectAssociation(mission.id)).toMatchObject({
        missionId: mission.id,
        projectId: "project-fixture",
        ownerUserId: owner.id,
      });
    });

    test("rejects invalid authority with no partial aggregate", async () => {
      const cases: Array<{
        id: string;
        prepare: () => Promise<void>;
        projectId?: string;
        ownerUserId?: string;
      }> = [
        {
          id: "missing-membership",
          prepare: async () => {
            await database.createUser({ id: "scientist-no-membership", username: "no-membership" });
          },
          ownerUserId: "scientist-no-membership",
        },
        {
          id: "inactive-user",
          prepare: async () => database.disableUser(owner.id),
        },
        {
          id: "inactive-project",
          prepare: async () => database.archiveProject("project-fixture"),
        },
        {
          id: "viewer",
          prepare: async () => {
            await database.removeProjectMember("project-fixture", owner.id);
            await database.addProjectMember("project-fixture", owner.id, "viewer");
          },
        },
      ];
      for (const testCase of cases) {
        const actor =
          testCase.ownerUserId === undefined
            ? owner
            : { ...owner, id: testCase.ownerUserId, role: "member" };
        const mission = missionFixture(`mission-project-${testCase.id}`, actor);
        await testCase.prepare();
        await expect(
          createBoundMission(
            mission,
            testCase.projectId ?? "project-fixture",
            testCase.ownerUserId ?? owner.id,
          ),
        ).rejects.toBeInstanceOf(ScientificIntegrityError);
        expect(await aggregateRows(mission.id)).toEqual({
          missions: 0,
          budgets: 0,
          associations: 0,
        });
        if (testCase.id === "inactive-user") await database.enableUser(owner.id);
        if (testCase.id === "inactive-project") {
          const tx = await database.beginTransaction();
          try {
            await tx.query("UPDATE projects SET status = 'active' WHERE id = $1", [
              "project-fixture",
            ]);
            await tx.commit();
          } catch (error) {
            await tx.rollback();
            throw error;
          }
        }
        if (testCase.id === "viewer") {
          await database.removeProjectMember("project-fixture", owner.id);
          await database.addProjectMember("project-fixture", owner.id, "member");
        }
      }
    });

    test("rejects duplicate memberships and rolls the aggregate back", async () => {
      const mission = missionFixture("mission-project-ambiguous-membership");
      const tx = await database.beginTransaction();
      try {
        await tx.query(
          `INSERT INTO project_memberships (id, project_id, user_id, role, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          ["membership-duplicate", "project-fixture", owner.id, "member", 1, 1],
        );
        await tx.commit();
      } catch (error) {
        await tx.rollback();
        throw error;
      }
      await expect(createBoundMission(mission)).rejects.toBeInstanceOf(ScientificIntegrityError);
      expect(await aggregateRows(mission.id)).toEqual({ missions: 0, budgets: 0, associations: 0 });
    });

    test("never retro-binds a legacy mission and rejects changed owner or project", async () => {
      const legacy = missionFixture("mission-project-legacy");
      await store.createMission(legacy, budgetFixture(legacy));
      await expect(createBoundMission(legacy)).rejects.toThrow(/cannot be retroactively bound/);
      expect(await aggregateRows(legacy.id)).toEqual({ missions: 1, budgets: 1, associations: 0 });

      const bound = missionFixture("mission-project-conflict");
      await createBoundMission(bound);
      await database.createProject({ id: "project-other", name: "Project other" });
      await database.addProjectMember("project-other", owner.id, "member");
      await expect(createBoundMission(bound, "project-other")).rejects.toBeInstanceOf(
        ScientificEntityConflictError,
      );

      await database.createUser({ id: "scientist-other", username: "scientist-other" });
      await database.addProjectMember("project-fixture", "scientist-other", "member");
      const changedOwner = missionFixture(bound.id, {
        id: "scientist-other",
        kind: "human",
        role: "member",
      });
      await expect(
        createBoundMission(changedOwner, "project-fixture", "scientist-other"),
      ).rejects.toBeInstanceOf(ScientificEntityConflictError);
      expect(await store.getMissionProjectAssociation(bound.id)).toMatchObject({
        projectId: "project-fixture",
        ownerUserId: owner.id,
      });
    });

    test("planning and delivery reject unbound missions; revocation preserves history but blocks effects", async () => {
      const unbound = missionFixture("mission-project-unbound");
      await store.createMission(unbound, budgetFixture(unbound));
      await expect(
        store.assertProductionMissionPlanningAccess({
          missionId: unbound.id,
          projectId: "project-fixture",
          ownerUserId: owner.id,
        }),
      ).rejects.toThrow(/immutable project association/);

      const tx = (await database.beginTransaction()) as ScientificTransaction;
      try {
        let builderCalls = 0;
        await expect(
          freezeMdEffectDelivery(
            tx,
            { mission: unbound } as MdSubmissionAuthority,
            {
              subject: owner.id,
              projectId: "project-fixture",
              uid: 2101,
              gid: 2000,
              siteProfileDigest: D("b"),
            },
            "postgres",
            () => {
              builderCalls += 1;
              throw new Error("An unbound mission must not reach the delivery builder");
            },
          ),
        ).rejects.toThrow(/immutable mission-project association/);
        expect(builderCalls).toBe(0);
        await expect(
          assertMdDeliveryProjectAccess(
            tx,
            unbound,
            {
              subject: owner.id,
              projectId: "project-fixture",
              uid: 2101,
              gid: 2000,
              siteProfileDigest: D("b"),
            },
            "postgres",
            "submit",
          ),
        ).rejects.toThrow(/immutable mission-project association/);
      } finally {
        await tx.rollback();
      }

      const bound = missionFixture("mission-project-revoked");
      await createBoundMission(bound);
      const association = await store.getMissionProjectAssociation(bound.id);
      await database.removeProjectMember("project-fixture", owner.id);
      expect(await store.getMissionProjectAssociation(bound.id)).toEqual(association);
      const revokedTx = (await database.beginTransaction()) as ScientificTransaction;
      try {
        await expect(
          assertMdDeliveryProjectAccess(
            revokedTx,
            bound,
            {
              subject: owner.id,
              projectId: "project-fixture",
              uid: 2101,
              gid: 2000,
              siteProfileDigest: D("b"),
            },
            "postgres",
            "submit",
          ),
        ).rejects.toBeInstanceOf(ScientificIntegrityError);
      } finally {
        await revokedTx.rollback();
      }
    });

    test("rolls back after an association-write failure and PostgreSQL keeps it append-only", async () => {
      const mission = missionFixture("mission-project-rollback");
      const failingStore = new ScientificStore({
        _provider: "postgres",
        beginTransaction: async () => {
          const tx = await database.beginTransaction();
          if (!tx.queryRows) throw new Error("PostgreSQL transaction lacks row-query support");
          const queryRows = tx.queryRows.bind(tx);
          tx.queryRows = async (sql, params) => {
            if (sql.includes("INSERT INTO scientific_mission_projects")) {
              throw new Error("injected association write failure");
            }
            return queryRows(sql, params);
          };
          return tx;
        },
      });
      await expect(
        failingStore.createMissionInProject({
          mission,
          budget: budgetFixture(mission),
          projectId: "project-fixture",
          ownerUserId: owner.id,
        }),
      ).rejects.toThrow(/constraint failed during create mission in project/);
      expect(await aggregateRows(mission.id)).toEqual({ missions: 0, budgets: 0, associations: 0 });

      const bound = missionFixture("mission-project-append-only");
      await createBoundMission(bound);
      const tx = await database.beginTransaction();
      try {
        await expect(
          tx.query("UPDATE scientific_mission_projects SET project_id = $1 WHERE mission_id = $2", [
            "project-tampered",
            bound.id,
          ]),
        ).rejects.toThrow();
      } finally {
        await tx.rollback();
      }
    });
  },
);
