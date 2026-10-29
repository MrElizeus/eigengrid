import { describe, expect, it } from "bun:test";
import {
  DbErrorCode,
  POSTGRES_MIGRATIONS,
  PostgresDatabase,
  postgresMigrationChecksum,
  type DbTransaction,
} from "@eigengrid/db";
import { canRunPostgres, startEphemeralPostgres } from "./helpers/postgres";

type MigrationHistoryRow = {
  version: number;
  name: string;
  checksum: string;
};

async function execute(db: PostgresDatabase, sql: string, params: unknown[] = []): Promise<void> {
  const transaction = await db.beginTransaction();
  try {
    await transaction.query(sql, params);
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function rows<T extends Record<string, unknown>>(
  db: PostgresDatabase,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const transaction: DbTransaction = await db.beginTransaction();
  try {
    if (!transaction.queryRows) throw new Error("PostgreSQL migration test requires queryRows");
    const result = await transaction.queryRows<T>(sql, params);
    await transaction.commit();
    return result;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

function nextMigrationVersion(): number {
  return Math.max(...POSTGRES_MIGRATIONS.map((migration) => migration.version)) + 1;
}

describe.skipIf(!canRunPostgres)("PostgreSQL migration authority", () => {
  it("records exact checksum-bound history through normal single-process initialization", async () => {
    const cluster = await startEphemeralPostgres();
    const first = new PostgresDatabase(cluster.url);
    const restarted = new PostgresDatabase(cluster.url);
    try {
      await first.init();
      await first.runMigrations();

      const expected = POSTGRES_MIGRATIONS.map((migration) => ({
        version: migration.version,
        name: migration.name,
        checksum: postgresMigrationChecksum(migration),
      }));
      expect(
        await rows<MigrationHistoryRow>(
          first,
          "SELECT version, name, checksum FROM _migrations ORDER BY version",
        ),
      ).toEqual(expected);

      await restarted.init();
      expect(
        await rows<MigrationHistoryRow>(
          restarted,
          "SELECT version, name, checksum FROM _migrations ORDER BY version",
        ),
      ).toEqual(expected);
    } finally {
      await first.close();
      await restarted.close();
      await cluster.cleanup();
    }
  });

  it("serializes two independent pools initializing an empty database", async () => {
    const cluster = await startEphemeralPostgres();
    const first = new PostgresDatabase(cluster.url);
    const second = new PostgresDatabase(cluster.url);
    try {
      const results = await Promise.allSettled([first.init(), second.init()]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);

      const history = await rows<MigrationHistoryRow>(
        first,
        "SELECT version, name, checksum FROM _migrations ORDER BY version",
      );
      expect(history).toHaveLength(POSTGRES_MIGRATIONS.length);
      expect(history).toEqual(
        POSTGRES_MIGRATIONS.map((migration) => ({
          version: migration.version,
          name: migration.name,
          checksum: postgresMigrationChecksum(migration),
        })),
      );
    } finally {
      await first.close();
      await second.close();
      await cluster.cleanup();
    }
  });

  it("permits exactly one concurrent application of the same unapplied migration", async () => {
    const cluster = await startEphemeralPostgres();
    const first = new PostgresDatabase(cluster.url);
    const second = new PostgresDatabase(cluster.url);
    const probeMigration = {
      version: nextMigrationVersion(),
      name: "migration_authority_concurrent_probe",
      sql: `
        SELECT pg_sleep(0.2);
        INSERT INTO migration_authority_probe (value) VALUES ('once');
      `,
    };
    try {
      await first.init();
      await second.init();
      await execute(
        first,
        "CREATE TABLE migration_authority_probe (value TEXT PRIMARY KEY NOT NULL)",
      );
      POSTGRES_MIGRATIONS.push(probeMigration);

      const results = await Promise.allSettled([first.runMigrations(), second.runMigrations()]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(
        await rows<{ count: string }>(
          first,
          "SELECT COUNT(*)::text AS count FROM migration_authority_probe",
        ),
      ).toEqual([{ count: "1" }]);
      expect(
        await rows<MigrationHistoryRow>(
          first,
          "SELECT version, name, checksum FROM _migrations WHERE version = $1",
          [probeMigration.version],
        ),
      ).toEqual([
        {
          version: probeMigration.version,
          name: probeMigration.name,
          checksum: postgresMigrationChecksum(probeMigration),
        },
      ]);
    } finally {
      const index = POSTGRES_MIGRATIONS.indexOf(probeMigration);
      if (index >= 0) POSTGRES_MIGRATIONS.splice(index, 1);
      await first.close();
      await second.close();
      await cluster.cleanup();
    }
  });

  it("fails closed when applied migration SQL content drifts", async () => {
    const cluster = await startEphemeralPostgres();
    const initialized = new PostgresDatabase(cluster.url);
    const restarted = new PostgresDatabase(cluster.url);
    const migration = POSTGRES_MIGRATIONS.at(-1)!;
    const originalSql = migration.sql;
    try {
      await initialized.init();
      migration.sql = `${originalSql}\n-- intentional integrity drift`;

      const error = await restarted.init().catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: DbErrorCode.MIGRATION });
      expect(error).toHaveProperty("message", expect.stringContaining("checksum mismatch"));
    } finally {
      migration.sql = originalSql;
      await initialized.close();
      await restarted.close();
      await cluster.cleanup();
    }
  });

  it("fails closed when an applied migration name no longer matches its version", async () => {
    const cluster = await startEphemeralPostgres();
    const initialized = new PostgresDatabase(cluster.url);
    const restarted = new PostgresDatabase(cluster.url);
    const migration = POSTGRES_MIGRATIONS.at(-1)!;
    try {
      await initialized.init();
      await execute(initialized, "UPDATE _migrations SET name = $1 WHERE version = $2", [
        "renamed_migration",
        migration.version,
      ]);

      const error = await restarted.init().catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: DbErrorCode.MIGRATION });
      expect(error).toHaveProperty("message", expect.stringContaining("name mismatch"));
    } finally {
      await initialized.close();
      await restarted.close();
      await cluster.cleanup();
    }
  });

  it("fails closed when history records an unknown applied migration version", async () => {
    const cluster = await startEphemeralPostgres();
    const initialized = new PostgresDatabase(cluster.url);
    const restarted = new PostgresDatabase(cluster.url);
    try {
      await initialized.init();
      await execute(
        initialized,
        "INSERT INTO _migrations (version, name, checksum, applied_at) VALUES ($1, $2, $3, $4)",
        [nextMigrationVersion() + 100, "unknown_migration", `sha256:${"0".repeat(64)}`, Date.now()],
      );

      const error = await restarted.init().catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: DbErrorCode.MIGRATION });
      expect(error).toHaveProperty("message", expect.stringContaining("unknown version"));
    } finally {
      await initialized.close();
      await restarted.close();
      await cluster.cleanup();
    }
  });

  it("rolls back a failed migration and releases authority for a clean restart", async () => {
    const cluster = await startEphemeralPostgres();
    const initialized = new PostgresDatabase(cluster.url);
    const failedRestart = new PostgresDatabase(cluster.url);
    const recovered = new PostgresDatabase(cluster.url);
    const probeMigration = {
      version: nextMigrationVersion(),
      name: "migration_authority_failure_probe",
      sql: `
        CREATE TABLE migration_authority_failure_probe (value TEXT PRIMARY KEY NOT NULL);
        INSERT INTO migration_authority_failure_probe (value) VALUES ('before-failure');
        SELECT eigengrid_migration_failure_probe();
      `,
    };
    try {
      await initialized.init();
      POSTGRES_MIGRATIONS.push(probeMigration);

      await expect(initialized.runMigrations()).rejects.toMatchObject({
        code: DbErrorCode.MIGRATION,
      });
      expect(
        await rows<{ relation: string | null }>(
          initialized,
          "SELECT to_regclass('public.migration_authority_failure_probe') AS relation",
        ),
      ).toEqual([{ relation: null }]);
      expect(
        await rows<{ count: string }>(
          initialized,
          "SELECT COUNT(*)::text AS count FROM _migrations WHERE version = $1",
          [probeMigration.version],
        ),
      ).toEqual([{ count: "0" }]);

      await expect(failedRestart.init()).rejects.toMatchObject({ code: DbErrorCode.MIGRATION });
      probeMigration.sql = `
        CREATE TABLE migration_authority_failure_probe (value TEXT PRIMARY KEY NOT NULL);
        INSERT INTO migration_authority_failure_probe (value) VALUES ('recovered');
      `;

      await recovered.init();
      expect(
        await rows<{ value: string }>(
          recovered,
          "SELECT value FROM migration_authority_failure_probe",
        ),
      ).toEqual([{ value: "recovered" }]);
      expect(
        await rows<MigrationHistoryRow>(
          recovered,
          "SELECT version, name, checksum FROM _migrations WHERE version = $1",
          [probeMigration.version],
        ),
      ).toEqual([
        {
          version: probeMigration.version,
          name: probeMigration.name,
          checksum: postgresMigrationChecksum(probeMigration),
        },
      ]);
    } finally {
      const index = POSTGRES_MIGRATIONS.indexOf(probeMigration);
      if (index >= 0) POSTGRES_MIGRATIONS.splice(index, 1);
      await initialized.close();
      await failedRestart.close();
      await recovered.close();
      await cluster.cleanup();
    }
  });

  it("adopts checksums once for legacy matching migration history", async () => {
    const cluster = await startEphemeralPostgres();
    const initialized = new PostgresDatabase(cluster.url);
    const restarted = new PostgresDatabase(cluster.url);
    try {
      await initialized.init();
      await execute(initialized, "ALTER TABLE _migrations DROP COLUMN checksum");

      await restarted.init();
      expect(
        await rows<MigrationHistoryRow>(
          restarted,
          "SELECT version, name, checksum FROM _migrations ORDER BY version",
        ),
      ).toEqual(
        POSTGRES_MIGRATIONS.map((migration) => ({
          version: migration.version,
          name: migration.name,
          checksum: postgresMigrationChecksum(migration),
        })),
      );
      expect(
        await rows<{ is_nullable: string }>(
          restarted,
          `SELECT is_nullable
             FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = '_migrations' AND column_name = 'checksum'`,
        ),
      ).toEqual([{ is_nullable: "NO" }]);
    } finally {
      await initialized.close();
      await restarted.close();
      await cluster.cleanup();
    }
  });
});
