import { DbError, DbErrorCode } from "../errors";
import { splitSqlStatements } from "../migration-utils";
import type { PostgresContext } from "./context";
import {
  POSTGRES_MIGRATIONS,
  postgresMigrationChecksum,
  type PostgresMigration,
} from "./migrations";

// `EIGE` / `MIGR` as signed 32-bit advisory-lock keys. The lock is session
// scoped and intentionally held across history validation and every migration
// transaction so separate Head pools cannot make independent apply decisions.
const POSTGRES_MIGRATION_LOCK_NAMESPACE = 0x45494745;

const POSTGRES_MIGRATION_LOCK_RESOURCE = 0x4d494752;

const POSTGRES_MIGRATION_CHECKSUM = /^sha256:[a-f0-9]{64}$/;

interface AppliedPostgresMigration {
  version: number;
  name: string;
  checksum: string | null;
}

function migrationDescriptorsByVersion(): Map<number, PostgresMigration> {
  const descriptors = new Map<number, PostgresMigration>();
  let previousVersion = 0;
  for (const migration of POSTGRES_MIGRATIONS) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= 0) {
      throw new DbError(
        `PostgreSQL migration descriptor has an invalid version: ${String(migration.version)}`,
        DbErrorCode.MIGRATION,
      );
    }
    if (migration.version <= previousVersion || descriptors.has(migration.version)) {
      throw new DbError(
        `PostgreSQL migration descriptors are not strictly ordered at v${migration.version}`,
        DbErrorCode.MIGRATION,
      );
    }
    if (!migration.name || !migration.sql) {
      throw new DbError(
        `PostgreSQL migration v${migration.version} has an empty name or SQL body`,
        DbErrorCode.MIGRATION,
      );
    }
    descriptors.set(migration.version, migration);
    previousVersion = migration.version;
  }
  return descriptors;
}
/** Read-only startup validation. Never bootstraps, adopts or repairs history. */
export async function validateMigrations(context: PostgresContext): Promise<void> {
  if (!context.pool) throw new DbError("Database not initialized", DbErrorCode.NOT_INITIALIZED);
  const descriptors = migrationDescriptorsByVersion();
  const client = await context.pool.connect();
  let failure: unknown;
  let releaseError: Error | undefined;
  try {
    await client.query("BEGIN READ ONLY");
    // A shared lock coordinates with the migrator's exclusive session lock.
    // Transaction scope guarantees release even when validation fails.
    await client.query("SELECT pg_advisory_xact_lock_shared($1::integer, $2::integer)", [
      POSTGRES_MIGRATION_LOCK_NAMESPACE,
      POSTGRES_MIGRATION_LOCK_RESOURCE,
    ]);
    const result = await client.query(
      "SELECT version, name, checksum FROM _migrations ORDER BY version",
    );
    const history = result.rows as AppliedPostgresMigration[];
    if (history.length !== descriptors.size) {
      throw new Error(
        "Migration history is incomplete or contains unsupported versions; run the matching release migrator",
      );
    }
    for (const row of history) {
      const descriptor = descriptors.get(Number(row.version));
      if (
        !descriptor ||
        row.name !== descriptor.name ||
        row.checksum !== postgresMigrationChecksum(descriptor)
      ) {
        throw new Error(`Migration history identity/checksum mismatch at v${String(row.version)}`);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    failure = error;
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      releaseError = rollbackError instanceof Error ? rollbackError : new Error("Rollback failed");
    }
  } finally {
    client.release(releaseError);
  }
  if (failure) {
    throw new DbError(
      `PostgreSQL schema validation failed: ${failure instanceof Error ? failure.message : String(failure)}`,
      DbErrorCode.MIGRATION,
    );
  }
}

export async function runMigrations(context: PostgresContext): Promise<void> {
  if (context.migrationMode !== "apply") {
    throw new DbError(
      "Runtime database cannot apply migrations; use the migration role and explicit apply mode",
      DbErrorCode.MIGRATION,
    );
  }
  if (!context.pool) throw new DbError("Database not initialized", DbErrorCode.NOT_INITIALIZED);

  const descriptors = migrationDescriptorsByVersion();
  const client = await context.pool.connect();
  let lockHeld = false;
  let failure: DbError | null = null;
  let unlockFailure: unknown;

  try {
    await client.query("SELECT pg_advisory_lock($1::integer, $2::integer) AS locked", [
      POSTGRES_MIGRATION_LOCK_NAMESPACE,
      POSTGRES_MIGRATION_LOCK_RESOURCE,
    ]);
    lockHeld = true;

    // Bootstrap and validate the migration history under the same exclusive
    // session lock as application. A legacy tracking table has no checksum;
    // its exact known name is verified before a one-time checksum adoption.
    // That explicit upgrade establishes integrity from this release onward;
    // it cannot retroactively attest historical source bytes.
    let transactionOpen = false;
    const applied = new Set<number>();
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      await client.query(`
          CREATE TABLE IF NOT EXISTS _migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            checksum TEXT,
            applied_at BIGINT NOT NULL
          )
        `);
      await client.query("ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum TEXT");

      const historyResult = await client.query(
        "SELECT version, name, checksum FROM _migrations ORDER BY version",
      );
      const history = historyResult.rows as AppliedPostgresMigration[];
      for (const row of history) {
        const version = Number(row.version);
        const migration = descriptors.get(version);
        if (!Number.isSafeInteger(version) || !migration) {
          throw new DbError(
            `PostgreSQL migration history contains unknown version ${String(row.version)}`,
            DbErrorCode.MIGRATION,
          );
        }
        if (typeof row.name !== "string" || row.name !== migration.name) {
          throw new DbError(
            `PostgreSQL migration history name mismatch at v${version}: expected ${migration.name}`,
            DbErrorCode.MIGRATION,
          );
        }

        const expectedChecksum = postgresMigrationChecksum(migration);
        if (row.checksum === null) {
          await client.query(
            "UPDATE _migrations SET checksum = $1 WHERE version = $2 AND checksum IS NULL",
            [expectedChecksum, version],
          );
        } else if (
          typeof row.checksum !== "string" ||
          !POSTGRES_MIGRATION_CHECKSUM.test(row.checksum) ||
          row.checksum !== expectedChecksum
        ) {
          throw new DbError(
            `PostgreSQL migration history checksum mismatch at v${version} (${migration.name})`,
            DbErrorCode.MIGRATION,
          );
        }
        applied.add(version);
      }

      await client.query("ALTER TABLE _migrations ALTER COLUMN checksum SET NOT NULL");
      await client.query("COMMIT");
      transactionOpen = false;
    } catch (err) {
      if (transactionOpen) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The migration authority operation already fails closed below.
        }
      }
      throw err;
    }

    for (const migration of POSTGRES_MIGRATIONS) {
      if (applied.has(migration.version)) continue;

      let transactionOpen = false;
      try {
        await client.query("BEGIN");
        transactionOpen = true;
        for (const statement of splitSqlStatements(migration.sql)) {
          await client.query(statement);
        }
        await client.query(
          "INSERT INTO _migrations (version, name, checksum, applied_at) VALUES ($1, $2, $3, $4)",
          [migration.version, migration.name, postgresMigrationChecksum(migration), Date.now()],
        );
        await client.query("COMMIT");
        transactionOpen = false;
        applied.add(migration.version);
      } catch (err) {
        if (transactionOpen) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // The authoritative outcome is ambiguous; never continue applying.
          }
        }
        throw new DbError(
          `PostgreSQL migration v${migration.version} (${migration.name}) failed: ${err instanceof Error ? err.message : String(err)}`,
          DbErrorCode.MIGRATION,
        );
      }
    }
  } catch (err) {
    failure =
      err instanceof DbError
        ? err
        : new DbError(
            `PostgreSQL migration authority failed: ${err instanceof Error ? err.message : String(err)}`,
            DbErrorCode.MIGRATION,
          );
  } finally {
    try {
      if (lockHeld) {
        const unlockResult = await client.query(
          "SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked",
          [POSTGRES_MIGRATION_LOCK_NAMESPACE, POSTGRES_MIGRATION_LOCK_RESOURCE],
        );
        if ((unlockResult.rows[0] as { unlocked?: unknown } | undefined)?.unlocked !== true) {
          unlockFailure = new Error("PostgreSQL migration advisory lock release was not confirmed");
        }
      }
    } catch (err) {
      unlockFailure = err;
    } finally {
      if (unlockFailure) {
        client.release(
          unlockFailure instanceof Error
            ? unlockFailure
            : new Error(`PostgreSQL migration lock release failed: ${String(unlockFailure)}`),
        );
      } else {
        client.release();
      }
    }
  }
  if (failure) throw failure;
  if (unlockFailure) {
    throw new DbError(
      `PostgreSQL migration advisory lock release failed: ${unlockFailure instanceof Error ? unlockFailure.message : String(unlockFailure)}`,
      DbErrorCode.MIGRATION,
    );
  }
}

export async function getMigrationVersion(context: PostgresContext): Promise<number> {
  const { rows } = await context.query("SELECT COALESCE(MAX(version), 0) AS v FROM _migrations");
  return Number(rows[0]?.v ?? 0);
}
