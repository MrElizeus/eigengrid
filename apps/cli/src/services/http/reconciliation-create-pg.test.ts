import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { PostgresDatabase } from "@eigengrid/db";
import { ScientificStore, ContentAddressedArtifactStore } from "@eigengrid/mission-runtime";
import { ScientificMissionService } from "@eigengrid/scientific-agent";
import { MissionApplication, type MissionApplicationContext } from "../mission-application";
import { applyApplicationHttpSchema } from "./composition";
import { PostgresMissionHttpIdempotency, type PgTransactionPool } from "./idempotency";
import { observeApplicationOperation } from "./reconciliation";
import { createReconciliationFixture } from "./reconciliation-create.fixture";
import { startEphemeralPostgres, canRunPostgres } from "../../../../../tests/ts/helpers/postgres";

async function fixture() {
  const cluster = await startEphemeralPostgres();
  const database = new PostgresDatabase(cluster.url);
  const pool = new Pool({ connectionString: cluster.url });
  const directory = await mkdtemp(join(tmpdir(), "eg-create-proof-"));
  const artifacts = new ContentAddressedArtifactStore(directory);
  try {
    await database.init();
    await artifacts.init();
    await applyApplicationHttpSchema(pool);
    const f = createReconciliationFixture();
    const store = new ScientificStore(database);
    for (const user of ["victor", "eliseo"]) {
      await database.createUser({ id: user, username: user });
      await database.createProject({ id: `personal-${user}`, name: `Isolated ${user} fixture` });
      await database.addProjectMember(`personal-${user}`, user, "member");
    }
    const object = await artifacts.put(new TextEncoder().encode("public fixture bytes"));
    f.mission.objective.system.contentDigest = object.digest;
    f.request.mission.objective.system.contentDigest = object.digest;
    for (const item of [f.evidence, f.request.objectiveEvidence[0]!]) {
      item.contentDigest = object.digest;
      item.uri = object.uri;
      item.sizeBytes = object.sizeBytes;
    }
    let actor = { ...f.actor };
    let revoked = false;
    const context = () =>
      ({
        authenticatedActor: actor,
        authorizedRoles: [actor.role],
        compilerPolicy: { id: "host-policy" },
      }) as unknown as MissionApplicationContext;
    const app = new MissionApplication({
      store,
      artifacts,
      service: new ScientificMissionService({ store, now: () => new Date(f.at) }),
      authority: {
        current: async () => context(),
        assertCurrent: async () => {
          if (revoked) throw new Error("CURRENT_AUTHORITY_REVOKED");
        },
      },
      now: () => new Date(f.at),
    });
    const idempotency = new PostgresMissionHttpIdempotency(
      pool as unknown as PgTransactionPool,
      async () => {},
    );
    return {
      f,
      store,
      app,
      pool,
      idempotency,
      setActor: (id: string) => {
        actor = { ...actor, id };
      },
      revoke: () => {
        revoked = true;
      },
      close: async () => {
        await pool.end();
        await artifacts.close();
        await database.close();
        await cluster.cleanup();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await pool.end();
    await artifacts.close();
    await database.close();
    await cluster.cleanup();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test.skipIf(!canRunPostgres)(
  "real PG historical Victor evidence collision remains pending under repeated reconciliation",
  async () => {
    const x = await fixture();
    try {
      const origin = structuredClone(x.f.request);
      origin.projectId = "personal-eliseo";
      origin.mission.id = "mission-eliseo";
      origin.mission.objective.id = "objective-eliseo";
      origin.mission.budgetId = "budget-eliseo";
      origin.budget.id = "budget-eliseo";
      origin.budget.missionId = origin.mission.id;
      origin.objectiveEvidence[0]!.missionId = origin.mission.id;
      x.setActor("eliseo");
      await x.app.create(origin);
      x.setActor("victor");
      // Reproduce the pre-fix, nontransactional historical sequence using the
      // low-level compatibility port. New application creation must be atomic.
      await expect(
        x.idempotency.run(x.f.record, async () => {
          await x.store.createMissionInProject({
            mission: x.f.mission,
            budget: x.f.budget,
            projectId: x.f.request.projectId,
            ownerUserId: x.f.actor.id,
          });
          await x.store.createEvidence(x.f.evidence);
          throw new Error("unexpected successful collision");
        }),
      ).rejects.toThrow();
      const partial = await x.store.getMissionProvenance(x.f.mission.id);
      expect(partial.evidence).toHaveLength(0);
      expect(partial.budget.id).toBe(x.f.budget.id);
      const key = {
        actorId: x.f.actor.id,
        projectId: x.f.record.projectId,
        missionId: x.f.mission.id,
        operation: "create",
        key: x.f.record.key,
      };
      const pending = await x.idempotency.lookup(key);
      expect(pending.status).toBe("pending");
      const address = {
        actorId: x.f.actor.id,
        projectId: x.f.record.projectId,
        missionId: x.f.mission.id,
        operationId: pending.operationId,
      };
      for (let i = 0; i < 2; i++)
        await expect(
          x.idempotency.reconcile(address, (record) =>
            observeApplicationOperation(record, x.app, () => {
              throw new Error("unused");
            }),
          ),
        ).rejects.toMatchObject({ code: "EFFECT_UNCERTAIN" });
      expect((await x.idempotency.lookup(key)).status).toBe("pending");
      expect((await x.store.getMissionProvenance(x.f.mission.id)).evidence).toHaveLength(0);
      expect((await x.store.getMissionProvenance(origin.mission.id)).evidence[0]!.missionId).toBe(
        origin.mission.id,
      );
      const rows = await x.pool.query(
        "SELECT status,output_json FROM eigengrid_a5_http_operations WHERE operation_id=$1",
        [pending.operationId],
      );
      expect(rows.rows[0]).toEqual({ status: "pending", output_json: null });
    } finally {
      await x.close();
    }
  },
  20000,
);

test.skipIf(!canRunPostgres)(
  "real PG lost ACK can reconcile after consumed accounting advances without resetting history",
  async () => {
    const x = await fixture();
    try {
      await expect(
        x.idempotency.run(x.f.record, async () => {
          await x.app.create(x.f.request);
          throw new Error("lost acknowledgement after committed creation");
        }),
      ).rejects.toThrow();
      const reserved = await x.store.reserveBudget({
        missionId: x.f.mission.id,
        expectedBudgetRevision: 1,
        reservation: {
          id: "proof-model-reservation",
          kind: "model_tokens",
          amount: 100,
          state: "reserved",
          createdAt: x.f.at,
          updatedAt: x.f.at,
        },
      });
      await x.store.settleBudgetReservation({
        missionId: x.f.mission.id,
        reservationId: "proof-model-reservation",
        expectedBudgetRevision: reserved.revision,
        state: "consumed",
        at: x.f.at,
      });
      const before = await x.store.getMissionProvenance(x.f.mission.id);
      expect(before.budget.consumed.modelTokens).toBe(100);
      expect(before.budgetReservations[0]!.state).toBe("consumed");
      const key = {
        actorId: x.f.actor.id,
        projectId: x.f.record.projectId,
        missionId: x.f.mission.id,
        operation: "create",
        key: x.f.record.key,
      };
      const pending = await x.idempotency.lookup(key);
      const address = {
        actorId: x.f.actor.id,
        projectId: x.f.record.projectId,
        missionId: x.f.mission.id,
        operationId: pending.operationId,
      };
      let observations = 0;
      const outcomes = await Promise.all(
        [1, 2].map(() =>
          x.idempotency.reconcile(address, (record) => {
            observations++;
            return observeApplicationOperation(record, x.app, () => {
              throw new Error("unused");
            });
          }),
        ),
      );
      expect(observations).toBe(1);
      expect(outcomes.some((outcome) => outcome.replayed)).toBe(true);
      expect((await x.idempotency.lookup(key)).status).toBe("complete");
      const after = await x.store.getMissionProvenance(x.f.mission.id);
      expect(after.budget).toEqual(before.budget);
      expect(after.budgetReservations).toEqual(before.budgetReservations);
      expect(after.evidence).toEqual(before.evidence);
    } finally {
      await x.close();
    }
  },
  20000,
);
