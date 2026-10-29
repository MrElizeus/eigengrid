import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import {
  canRunPostgres,
  startEphemeralPostgres,
  type EphemeralPostgresCluster,
} from "./helpers/postgres";

describe.skipIf(!canRunPostgres)("PostgreSQL fixture ownership", () => {
  test("separate fixtures cannot inherit drift or delete one another's database", async () => {
    const clusters: EphemeralPostgresCluster[] = [];
    const clients: Client[] = [];
    try {
      const first = await startEphemeralPostgres();
      clusters.push(first);
      const second = await startEphemeralPostgres();
      clusters.push(second);
      expect(first.url).not.toBe(second.url);
      const left = new Client({ connectionString: first.url });
      clients.push(left);
      await left.connect();
      const right = new Client({ connectionString: second.url });
      clients.push(right);
      await right.connect();
      await left.query("CREATE TABLE fixture_ownership (value INTEGER)");
      await left.query("INSERT INTO fixture_ownership VALUES (42)");
      expect(
        (await right.query("SELECT to_regclass('public.fixture_ownership') AS name")).rows[0].name,
      ).toBeNull();
      await clients.pop()!.end();
      await clusters.pop()!.cleanup();
      expect((await left.query("SELECT value FROM fixture_ownership")).rows).toEqual([
        { value: 42 },
      ]);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
      for (const cluster of clusters) await cluster.cleanup();
    }
  }, 30_000);
});
