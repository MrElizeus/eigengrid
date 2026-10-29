import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import { PostgresDatabase } from "./postgres/client";
import { MD_PREPARATION_POSTGRES_MIGRATION } from "./md-preparation-migration";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations";
import { canRunPostgres, startEphemeralPostgres } from "../../../tests/ts/helpers/postgres";

describe.skipIf(!canRunPostgres)("MD preparation schema21 migration (real PostgreSQL)", () => {
  test("upgrades schema20 additively, preserves history/data and rolls failed DDL back", async () => {
    const cluster = await startEphemeralPostgres();
    const first = new PostgresDatabase(cluster.url);
    const sql = new Client({ connectionString: cluster.url });
    const next = new PostgresDatabase(cluster.url);
    const validation = new PostgresDatabase(cluster.url, { migrations: "validate" });
    try {
      await first.init();
      await first.createUser({
        id: "migration-preserved-user",
        username: "migration-preserved-user",
      });
      await sql.connect();
      const before = await sql.query(
        "SELECT * FROM _migrations WHERE version <= 20 ORDER BY version",
      );
      await sql.query("DROP TABLE scientific_md_preparation_publications");
      // Restore schema20's evidence uniqueness before replaying v21 and later migrations.
      await sql.query("DROP INDEX scientific_evidence_authority_identity");
      await sql.query(`ALTER TABLE scientific_evidence
        ADD CONSTRAINT scientific_evidence_mission_id_kind_uri_content_digest_key
        UNIQUE (mission_id, kind, uri, content_digest)`);
      await sql.query("DELETE FROM _migrations WHERE version > 20");
      expect(await first.getMigrationVersion()).toBe(20);
      await expect(validation.init()).rejects.toThrow();
      // A collision at the post-table index proves table creation is rolled back.
      await sql.query("CREATE TABLE scientific_md_preparation_publications_mission (fixture text)");
      await expect(next.init()).rejects.toThrow(/already exists/);
      expect(await first.getMigrationVersion()).toBe(20);
      expect(
        (await sql.query("SELECT to_regclass('scientific_md_preparation_publications') AS name"))
          .rows,
      ).toEqual([{ name: null }]);
      expect(
        (await sql.query("SELECT * FROM _migrations WHERE version <= 20 ORDER BY version")).rows,
      ).toEqual(before.rows);
      await sql.query("DROP TABLE scientific_md_preparation_publications_mission");
      await next.init();
      expect(await next.getMigrationVersion()).toBe(POSTGRES_MIGRATIONS.at(-1)!.version);
      expect(
        (await sql.query("SELECT * FROM _migrations WHERE version <= 20 ORDER BY version")).rows,
      ).toEqual(before.rows);
      expect(
        (await sql.query("SELECT id FROM users WHERE id = 'migration-preserved-user'")).rows,
      ).toEqual([{ id: "migration-preserved-user" }]);
      expect(
        (await sql.query("SELECT * FROM scientific_md_preparation_publications")).rows,
      ).toEqual([]);
      expect(MD_PREPARATION_POSTGRES_MIGRATION.sql).not.toMatch(/INSERT\s+INTO/iu);
      for (const command of [
        "UPDATE scientific_md_preparation_publications SET created_at = 'x'",
        "DELETE FROM scientific_md_preparation_publications",
        "TRUNCATE scientific_md_preparation_publications",
      ])
        await expect(sql.query(command)).rejects.toThrow(/append.only/i);
    } finally {
      await validation.close();
      await next.close();
      await first.close();
      await sql.end();
      await cluster.cleanup();
    }
  }, 20_000);
});
