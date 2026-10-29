import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Client, Pool } from "pg";
import {
  canRunPostgres,
  startEphemeralPostgres,
  type EphemeralPostgresCluster,
} from "../../../../../tests/ts/helpers/postgres";
import { MissionHttpError, type MissionHttpIdempotencyRequest } from "./routes/mission-routes";
import { PostgresMissionHttpIdempotency, type PgTransactionPool } from "./idempotency";

const mock: MissionHttpIdempotencyRequest = {
  actorId: "scientist-test",
  projectId: "project-1",
  operation: "start",
  key: "idempotent-first",
  requestDigest: "a".repeat(64),
  expectedRevision: 1,
  request: { projectId: "project-1", missionId: "mission-1" },
};
describe.skipIf(!canRunPostgres)("application PostgreSQL HTTP durable idempotency", () => {
  let ephemeral: EphemeralPostgresCluster;
  let pool: Pool;
  let validRevision = true;
  let service: PostgresMissionHttpIdempotency;
  const adapter = (): PgTransactionPool => ({
    async connect() {
      const client = await pool.connect();
      return {
        async query<T extends object>(query: string, args?: readonly unknown[]) {
          const result = await client.query(query, args as unknown[]);
          return { rows: result.rows as T[], rowCount: result.rowCount };
        },
        release() {
          client.release();
        },
      };
    },
  });
  beforeAll(async () => {
    ephemeral = await startEphemeralPostgres();
    const client = new Client({ connectionString: ephemeral.url });
    await client.connect();
    try {
      await client.query(readFileSync(new URL("./schema-v1.sql", import.meta.url), "utf8"));
    } finally {
      await client.end();
    }
    pool = new Pool({ connectionString: ephemeral.url, max: 5 });
    service = new PostgresMissionHttpIdempotency(adapter(), async () => {
      if (!validRevision) throw new MissionHttpError("REVISION_CONFLICT");
    });
  });
  afterAll(async () => {
    await pool?.end();
    await ephemeral?.cleanup();
  });
  test("exact response replay is durable across adapters, without second start", async () => {
    let effects = 0;
    const first = await service.run(mock, async () => {
      effects++;
      return { status: "admitted" };
    });
    expect(first.replayed).toBe(false);
    const secondHead = new PostgresMissionHttpIdempotency(adapter(), async () => {
      throw new Error("must not re-approve on idempotent read");
    });
    const replay = await secondHead.run(mock, async () => {
      effects++;
      return { status: "duplicate" };
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(effects).toBe(1);
  });
  test("conflicting bytes and revisions cannot steal an operation key", async () => {
    let calls = 0;
    await expect(
      service.run({ ...mock, requestDigest: "b".repeat(64) }, async () => {
        calls++;
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      service.run({ ...mock, expectedRevision: 3 }, async () => {
        calls++;
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(calls).toBe(0);
    await expect(
      service.run(
        { ...mock, request: { projectId: "project-1", missionId: "other-mission" } },
        async () => {
          calls++;
          return { ok: true };
        },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(calls).toBe(0);
  });
  test("lost ACK leaves pending durable barrier, even after a new Head begins", async () => {
    let effects = 0;
    const changed = { ...mock, key: "lost-ack" };
    await expect(
      service.run(changed, async () => {
        effects++;
        throw new Error("server disconnected after mission runtime admitted operation");
      }),
    ).rejects.toThrow();
    await expect(
      service.run(changed, async () => {
        effects++;
      }),
    ).rejects.toMatchObject({ code: "EFFECT_UNCERTAIN" });
    expect(effects).toBe(1);
  });
  test("result materialization failures also leave a non-retriable pending operation", async () => {
    let effects = 0;
    const changed = { ...mock, key: "non-json-output" };
    await expect(
      service.run(changed, async () => {
        effects++;
        return undefined;
      }),
    ).rejects.toMatchObject({ code: "EFFECT_UNCERTAIN" });
    await expect(
      service.run(changed, async () => {
        effects++;
        return { ok: true };
      }),
    ).rejects.toMatchObject({ code: "EFFECT_UNCERTAIN" });
    expect(effects).toBe(1);
  });
  test("revision guard rejects before reserving intent or invoking external effect", async () => {
    validRevision = false;
    const request = { ...mock, key: "guarded" };
    let count = 0;
    await expect(
      service.run(request, async () => {
        count++;
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    validRevision = true;
    const accepted = await service.run(request, async () => {
      count++;
      return { ok: true };
    });
    expect(accepted.replayed).toBe(false);
    expect(count).toBe(1);
  });
  test("two concurrent requests share one pending reservation", async () => {
    const request = { ...mock, key: "concurrent" };
    let start = 0;
    const [one, two] = await Promise.allSettled([
      service.run(request, async () => {
        start++;
        await Bun.sleep(50);
        return { started: true };
      }),
      service.run(request, async () => {
        start++;
        return { started: false };
      }),
    ]);
    expect(start).toBe(1);
    const success = [one, two].filter((x) => x.status === "fulfilled");
    expect(success.length).toBe(1);
    const failure = [one, two].filter((x) => x.status === "rejected");
    expect(failure.length).toBe(1);
    expect((failure[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "EFFECT_UNCERTAIN",
    });
  });
  test("unauthorized shape and malformed identity rejected before a DB reservation", async () => {
    let called = 0;
    await expect(
      service.run({ ...mock, actorId: "../../bad", key: "bad" }, async () => {
        called++;
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(called).toBe(0);
  });
});
