import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import { PostgresDatabase, POSTGRES_MIGRATIONS } from "@eigengrid/db";
import { canRunPostgres, startEphemeralPostgres } from "./helpers/postgres";

describe.skipIf(!canRunPostgres)("PostgreSQL runtime schema boundary", () => {
  test("read-only schema startup permits DML but rejects DDL/history edits with real roles", async () => {
    const cluster = await startEphemeralPostgres();
    const bootstrap = new Client({ connectionString: cluster.url });
    const migrator = new PostgresDatabase(cluster.url, { migrations: "apply" });
    const role = `eg_app_${crypto.randomUUID().replaceAll("-", "")}`;
    const appUrl = new URL(cluster.url);
    appUrl.username = role;
    const fixturePassword = crypto.randomUUID();
    appUrl.password = fixturePassword;
    const app = new PostgresDatabase(appUrl.toString(), { migrations: "validate" });
    const direct = new Client({ connectionString: appUrl.toString() });
    try {
      await bootstrap.connect();
      await migrator.init();
      await bootstrap.query(
        `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${fixturePassword}'`,
      );
      await bootstrap.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
      await bootstrap.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await bootstrap.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
      );
      await bootstrap.query(`REVOKE ALL ON _migrations FROM ${role}`);
      await bootstrap.query(`GRANT SELECT ON _migrations TO ${role}`);
      await app.init();
      expect(await app.getMigrationVersion()).toBe(POSTGRES_MIGRATIONS.at(-1)!.version);
      await expect(app.runMigrations()).rejects.toThrow(/Runtime database cannot/);
      await direct.connect();
      await expect(direct.query("CREATE TABLE runtime_ddl_should_fail (id text)")).rejects.toThrow(
        /permission denied/,
      );
      await expect(direct.query("UPDATE _migrations SET name = 'forged'")).rejects.toThrow(
        /permission denied/,
      );
      await expect(direct.query(`SET ROLE ${new URL(cluster.url).username}`)).rejects.toThrow(
        /permission denied/,
      );
      for (const table of [
        "scientific_operation_outbox",
        "scientific_effect_admissions",
        "scientific_mission_projects",
        "scientific_effect_deliveries",
      ]) {
        await expect(direct.query(`UPDATE ${table} SET payload_json = '{}'`)).rejects.toThrow(
          /append-only/,
        );
        await expect(direct.query(`DELETE FROM ${table}`)).rejects.toThrow(/append-only/);
        await expect(direct.query(`TRUNCATE ${table}`)).rejects.toThrow(/permission denied/);
        await expect(direct.query(`ALTER TABLE ${table} DISABLE TRIGGER ALL`)).rejects.toThrow(
          /must be owner/,
        );
      }
      await expect(
        direct.query(
          "ALTER FUNCTION scientific_reject_effect_history_mutation() RENAME TO forged_mutation_permission",
        ),
      ).rejects.toThrow(/must be owner/);
      await app.createJob({
        id: role,
        name: "role isolation",
        software: "amber",
        inputPath: "/fixture",
        workdir: "/scratch/fixture",
      });
      expect((await app.getJob(role))?.name).toBe("role isolation");
      await app.close();
      await app.init();
      expect((await app.getJob(role))?.id).toBe(role);
    } finally {
      await direct.end();
      await app.close();
      await migrator.close();
      if (!cluster.dataDir) {
        await bootstrap.query(`DROP OWNED BY ${role}`).catch(() => {});
        await bootstrap.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
      }
      await bootstrap.end();
      await cluster.cleanup();
    }
  }, 20_000);

  test("validate cannot bootstrap a database or repair missing/altered history", async () => {
    const cluster = await startEphemeralPostgres();
    const sql = new Client({ connectionString: cluster.url });
    const app = new PostgresDatabase(cluster.url, { migrations: "validate" });
    const migrator = new PostgresDatabase(cluster.url);
    try {
      await sql.connect();
      // The helper provisions a unique database even with an external test server.
      await expect(app.init()).rejects.toThrow(/schema validation failed/);
      expect(
        (await sql.query("SELECT to_regclass('public._migrations') AS name")).rows[0].name,
      ).toBeNull();
      await migrator.init();
      await sql.query("DELETE FROM _migrations WHERE version = $1", [
        POSTGRES_MIGRATIONS.at(-1)!.version,
      ]);
      const count = (await sql.query("SELECT count(*) FROM _migrations")).rows[0].count;
      await expect(app.init()).rejects.toThrow(/incomplete/);
      expect((await sql.query("SELECT count(*) FROM _migrations")).rows[0].count).toBe(count);
      const last = POSTGRES_MIGRATIONS.at(-1)!;
      await sql.query("INSERT INTO _migrations VALUES ($1, $2, $3, $4)", [
        last.version,
        last.name,
        "sha256:" + "0".repeat(64),
        Date.now(),
      ]);
      await expect(app.init()).rejects.toThrow(/checksum mismatch/);
      // Failed starts close their pools: no accumulating idle application clients.
      expect(
        (
          await sql.query(
            "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'eigengrid-app'",
          )
        ).rows[0].count,
      ).toBe("0");
    } finally {
      await app.close();
      await migrator.close();
      await sql.end();
      await cluster.cleanup();
    }
  }, 20_000);
});
