import { DbError, DbErrorCode } from "../errors";
import { splitSqlStatements } from "../migration-utils";
import type { SqliteContext } from "./context";
import { MIGRATIONS } from "./migrations";
import type { SqliteConnection } from "./transaction";

function runStatements(db: SqliteConnection, sql: string): void {
  for (const statement of splitSqlStatements(sql)) {
    db.query(statement).run();
  }
}
export function runPendingMigrations(context: SqliteContext): void {
  const db = context.ensureDb();
  db.query(
    "CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
  ).run();
  const applied = db
    .query("SELECT version FROM _migrations")
    .all()
    .map((r: Record<string, unknown>) => r.version as number);
  for (const m of MIGRATIONS) {
    if (!applied.includes(m.version)) {
      // Apply migration inside a transaction for atomicity
      db.query("BEGIN").run();
      try {
        runStatements(db, m.sql);
        db.query(
          "INSERT INTO _migrations (version, name, applied_at) VALUES ($version, $name, $appliedAt)",
        ).run({
          $version: m.version,
          $name: m.name,
          $appliedAt: Date.now(),
        });
        db.query("COMMIT").run();
      } catch (err) {
        db.query("ROLLBACK").run();
        throw new DbError(
          `Migration v${m.version} (${m.name}) failed: ${err instanceof Error ? err.message : String(err)}`,
          DbErrorCode.MIGRATION,
        );
      }
    }
  }
}

export async function runMigrations(context: SqliteContext): Promise<void> {
  runPendingMigrations(context);
}

export async function getMigrationVersion(context: SqliteContext): Promise<number> {
  const db = context.ensureDb();
  const rows = db.query("SELECT COALESCE(MAX(version), 0) AS v FROM _migrations").all();
  return Number((rows[0] as Record<string, unknown>)?.v ?? 0);
}
