import { mkdirSync } from "fs";
import { dirname } from "path";
import type { DbTransaction as DbTransactionInterface } from "../client";
import { DbError, DbErrorCode } from "../errors";

import { runPendingMigrations } from "./migration-runner";
import { SqliteTransaction, type SqliteConnection } from "./transaction";
/** Internal connection state shared by domain operations; never exported from the package. */
export class SqliteContext {
  db: SqliteConnection | null = null;

  private lastTimestamp = 0;

  private transactionCount = 0;

  private transactionTail: Promise<void> = Promise.resolve();

  constructor(private dbPath: string) {}

  async init(): Promise<void> {
    const { Database } = await import("bun:sqlite");
    mkdirSync(dirname(this.dbPath), { recursive: true });
    const d = new Database(this.dbPath);
    this.db = d as SqliteConnection;
    // Opening WAL can itself contend with another connection or a checkpoint.
    d.query("PRAGMA busy_timeout = 5000").run();
    d.query("PRAGMA journal_mode = WAL").run();
    d.query("PRAGMA foreign_keys = ON").run();
    runPendingMigrations(this);
  }

  ensureDb(): SqliteConnection {
    if (!this.db)
      throw new DbError(
        "Database not initialized. Call init() first.",
        DbErrorCode.NOT_INITIALIZED,
      );
    return this.db;
  }

  nextTimestamp(): number {
    const now = Date.now();
    this.lastTimestamp = Math.max(now, this.lastTimestamp + 1);
    return this.lastTimestamp;
  }

  // ── Transaction support ──────────────────────────────────

  async beginTransaction(): Promise<DbTransactionInterface> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.transactionCount++;
    try {
      // Resolve the connection after waiting: the previous transaction may
      // have discarded it because rollback failed.
      const db = this.ensureDb();
      return new SqliteTransaction(db, (unusable) => {
        if (unusable) {
          this.db = null;
          try {
            db.close?.();
          } catch {
            // Preserve the rollback error; this connection is never reused.
          }
        }
        this.transactionCount--;
        release();
      });
    } catch (error) {
      this.transactionCount--;
      release();
      throw error;
    }
  }

  // ── Extended interface methods ─────────────────────────────

  async close(): Promise<void> {
    // No-op: SQLite connection is managed by bun's garbage collector.
    // Do NOT null this.db - background completion callbacks from spawned
    // processes may still call ensureDb() after ApplicationContext.close().
    // Nulling the connection caused the WU-05 regression where
    // finalizeAttempt → updateJobStatus → ensureDb() would throw
    // "Database not initialized", silently swallowed by the coordinator.
  }
}
