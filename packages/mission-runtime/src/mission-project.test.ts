import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PostgresDatabase } from "@eigengrid/db";
import { ScientificMissionService } from "@eigengrid/scientific-agent";
import {
  EvidenceReferenceSchema,
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

function objectiveEvidence(mission: ScientificMission) {
  return EvidenceReferenceSchema.parse({
    id: mission.objective.system.evidenceId,
    missionId: mission.id,
    kind: "structure",
    uri: `cas://sha256/${mission.objective.system.contentDigest}`,
    contentDigest: mission.objective.system.contentDigest,
    sizeBytes: 113,
    mediaType: "chemical/x-xyz",
    immutable: true,
    createdAt: T0,
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

    async function creationRows(missionId: string) {
      const aggregate = await aggregateRows(missionId);
      const tx = (await database.beginTransaction()) as ScientificTransaction;
      try {
        const counts = { scientific_evidence: 0, scientific_mission_transitions: 0 };
        for (const table of ["scientific_evidence", "scientific_mission_transitions"] as const) {
          const [row] = await tx.queryRows<{ count: string }>(
            `SELECT count(*)::text AS count FROM ${table} WHERE mission_id = $1`,
            [missionId],
          );
          counts[table] = Number(row!.count);
        }
        return { ...aggregate, ...counts };
      } finally {
        await tx.rollback();
      }
    }

    function applicationCreation(
      mission: ScientificMission,
      references = [objectiveEvidence(mission)],
    ) {
      return new ScientificMissionService({ store }).createMissionInProject({
        mission,
        budget: budgetFixture(mission),
        projectId: "project-fixture",
        authenticatedActor: owner,
        objectiveEvidence: references,
      });
    }

    test("atomic application creation rolls back every row after a later evidence ID collision", async () => {
      const first = missionFixture("first-objective-owner");
      await applicationCreation(first);
      const other = missionFixture("partial-create-must-not-exist");
      await expect(
        applicationCreation(other, [
          objectiveEvidence(other),
          {
            ...objectiveEvidence(first),
            missionId: other.id,
          },
        ]),
      ).rejects.toThrow(ScientificEntityConflictError);
      expect(await store.getMission(other.id)).toBeNull();
      expect(await creationRows(other.id)).toEqual({
        missions: 0,
        budgets: 0,
        associations: 0,
        scientific_evidence: 0,
        scientific_mission_transitions: 0,
      });
      expect(await creationRows(first.id)).toEqual({
        missions: 1,
        budgets: 1,
        associations: 1,
        scientific_evidence: 1,
        scientific_mission_transitions: 1,
      });
    });

    test("atomic application creation admits one complete aggregate when concurrent missions share an evidence ID", async () => {
      const a = missionFixture("concurrent-create-a"),
        b = missionFixture("concurrent-create-b");
      b.objective.system.evidenceId = a.objective.system.evidenceId;
      const outcomes = await Promise.allSettled([applicationCreation(a), applicationCreation(b)]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      for (const [index, mission] of [a, b].entries()) {
        const count = outcomes[index]!.status === "fulfilled" ? 1 : 0;
        expect(await creationRows(mission.id)).toEqual({
          missions: count,
          budgets: count,
          associations: count,
          scientific_evidence: count,
          scientific_mission_transitions: count,
        });
      }
    });

    test("atomic application creation is exact-idempotent and refuses to complete historical partial creation", async () => {
      const mission = missionFixture("complete-create");
      const values = await Promise.all([
        applicationCreation(mission),
        applicationCreation(mission),
      ]);
      expect(values).toEqual([mission, mission]);
      expect(await creationRows(mission.id)).toEqual({
        missions: 1,
        budgets: 1,
        associations: 1,
        scientific_evidence: 1,
        scientific_mission_transitions: 1,
      });
      const partial = missionFixture("historical-partial-create");
      await createBoundMission(partial);
      await expect(applicationCreation(partial)).rejects.toThrow(
        "incomplete or conflicting objective evidence",
      );
      expect(await creationRows(partial.id)).toEqual({
        missions: 1,
        budgets: 1,
        associations: 1,
        scientific_evidence: 0,
        scientific_mission_transitions: 1,
      });
    });

    test("catalog pages only expose allowed active projects and the requesting human's bound missions", async () => {
      await database.createProject({ id: "project-second", name: "Second project" });
      await database.addProjectMember("project-second", owner.id, "member");
      await database.createProject({ id: "project-unjoined", name: "Not a member" });
      const scope = {
        ownerUserId: owner.id,
        projectIds: ["project-fixture", "project-second", "project-unjoined"],
        limit: 1,
      };
      const first = await store.listProductionProjects(scope);
      expect(first.items.map((item) => item.id)).toEqual(["project-fixture"]);
      expect(first.nextCursor).toBe("project-fixture");
      const second = await store.listProductionProjects({ ...scope, after: first.nextCursor! });
      expect(second.items.map((item) => item.id)).toEqual(["project-second"]);
      expect(second.nextCursor).toBeNull();
      expect((await store.listProductionProjects({ ...scope, projectIds: [] })).items).toEqual([]);
      expect(
        (
          await store.listProductionProjects({ ...scope, projectIds: ["project-second"] })
        ).items.map((item) => item.id),
      ).toEqual(["project-second"]);
      await createBoundMission(missionFixture("mission-a"));
      await createBoundMission(missionFixture("mission-b"));
      const unbound = missionFixture("mission-unbound");
      await store.createMission(unbound, budgetFixture(unbound));
      const other = { ...owner, id: "other-catalog-human" };
      await database.createUser({ id: other.id, username: other.id });
      await database.addProjectMember("project-fixture", other.id, "member");
      await createBoundMission(missionFixture("mission-other", other), "project-fixture", other.id);
      const page = await store.listProductionMissions({
        ownerUserId: owner.id,
        projectId: "project-fixture",
        limit: 1,
      });
      expect(page.items.map((item) => item.id)).toEqual(["mission-a"]);
      expect(page.nextCursor).toBe("mission-a");
      const next = await store.listProductionMissions({
        ownerUserId: owner.id,
        projectId: "project-fixture",
        after: page.nextCursor!,
        limit: 1,
      });
      expect(next.items.map((item) => item.id)).toEqual(["mission-b"]);
      expect(next.nextCursor).toBeNull();
      expect(Object.keys(next.items[0]!).sort()).toEqual(
        [
          "activePlanId",
          "createdAt",
          "id",
          "revision",
          "state",
          "statement",
          "targetProperties",
          "updatedAt",
        ].sort(),
      );
      await database.removeProjectMember("project-fixture", owner.id);
      expect((await store.listProductionProjects(scope)).items.map((item) => item.id)).toEqual([
        "project-second",
      ]);
      await expect(
        store.listProductionMissions({ ownerUserId: owner.id, projectId: "project-fixture" }),
      ).rejects.toThrow();
    });

    test("catalog rejects malformed cursors, unbounded pages and corrupted mission payloads", async () => {
      await createBoundMission(missionFixture("mission-catalog-integrity"));
      const input = { ownerUserId: owner.id, projectId: "project-fixture" };
      await expect(store.listProductionMissions({ ...input, after: "' OR 1=1" })).rejects.toThrow();
      await expect(store.listProductionMissions({ ...input, limit: 101 })).rejects.toThrow();
      const tx = (await database.beginTransaction()) as ScientificTransaction;
      await tx.query("UPDATE scientific_missions SET payload_digest = $1 WHERE id = $2", [
        D("f"),
        "mission-catalog-integrity",
      ]);
      await tx.commit();
      await expect(store.listProductionMissions(input)).rejects.toBeInstanceOf(
        ScientificIntegrityError,
      );
    });

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
