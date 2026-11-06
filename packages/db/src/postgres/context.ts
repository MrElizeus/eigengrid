import type { DbTransaction } from "../client";
import { redactDatabaseUrl } from "../connection-url";
import { DbError, DbErrorCode, DbQueryError } from "../errors";

import { type PgRow } from "./row-helpers";

import { runMigrations, validateMigrations } from "./migration-runner";
import type { PostgresDatabaseOptions } from "./options";
import { PostgresTransaction } from "./transaction";
/** Internal connection state shared by domain operations; never exported from the package. */
export class PostgresContext {
  pool: import("pg").Pool | null = null;

  private lastTimestamp = 0;

  private dbUrl: string;

  private _pg: typeof import("pg") | null = null;

  readonly migrationMode: "apply" | "validate";

  private initialization: Promise<void> | null = null;

  constructor(dbUrl: string, options: PostgresDatabaseOptions = {}) {
    // Redact password for any logging
    this.dbUrl = dbUrl;
    this.migrationMode = options.migrations ?? "apply";
  }

  async init(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = this.initialize();
    try {
      await this.initialization;
    } finally {
      this.initialization = null;
    }
  }

  private async initialize(): Promise<void> {
    if (this.pool) return;
    try {
      this._pg = await import("pg");
    } catch {
      throw new DbError(
        "pg module not found. Install it with: bun add pg",
        DbErrorCode.CONNECTION_FAILED,
        "pg package missing",
      );
    }

    const { Pool } = this._pg;
    const safeUrl = redactDatabaseUrl(this.dbUrl);
    this.pool = new Pool({
      connectionString: this.dbUrl,
      max: this.migrationMode === "apply" ? 2 : 4,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: this.migrationMode === "apply" ? 300_000 : 30_000,
      lock_timeout: 30_000,
      application_name: `eigengrid-${this.migrationMode === "apply" ? "migrator" : "app"}`,
    });
    // pg removes failed idle clients. Handle this event so a PostgreSQL restart
    // does not terminate the Head; subsequent operations still fail/reconnect.
    this.pool.on("error", (error) => {
      console.error("EigenGrid PostgreSQL idle connection lost", {
        code: "code" in error ? error.code : "CONNECTION_LOST",
      });
    });

    // Test connection
    const pool = this.pool;
    let testClient: import("pg").PoolClient | null = null;
    try {
      testClient = await pool.connect();
      await testClient.query("SELECT 1");
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      // Never leak the full connection string
      if (testClient) {
        testClient.release();
        testClient = null;
      }
      await this.close();
      throw new DbError(
        `PostgreSQL connection failed: ${safeUrl}`,
        DbErrorCode.CONNECTION_FAILED,
        detail,
      );
    } finally {
      if (testClient) testClient.release();
    }

    try {
      if (this.migrationMode === "apply") await runMigrations(this);
      else await validateMigrations(this);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async beginTransaction(): Promise<DbTransaction> {
    if (!this.pool)
      throw new DbError(
        "Database not initialized. Call init() first.",
        DbErrorCode.NOT_INITIALIZED,
      );
    let client: import("pg").PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      return new PostgresTransaction(client);
    } catch (err: unknown) {
      client?.release(err instanceof Error ? err : true);
      throw new DbError(
        "PostgreSQL transaction begin failed",
        DbErrorCode.TRANSACTION,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // ── Query helper ──────────────────────────────────────────

  async query(text: string, params?: unknown[]): Promise<{ rows: PgRow[]; rowCount: number }> {
    if (!this.pool) {
      throw new DbError(
        "Database not initialized. Call init() first.",
        DbErrorCode.NOT_INITIALIZED,
      );
    }
    try {
      const result = await this.pool.query(text, params ?? []);
      return { rows: result.rows ?? [], rowCount: result.rowCount ?? 0 };
    } catch (err: unknown) {
      throw new DbQueryError(err instanceof Error ? err.message : String(err), err);
    }
  }

  async queryOne(text: string, params?: unknown[]): Promise<PgRow | null> {
    const { rows } = await this.query(text, params);
    return rows.length > 0 ? rows[0] : null;
  }

  // ── Timestamp ─────────────────────────────────────────────

  nextTimestamp(): number {
    const now = Date.now();
    this.lastTimestamp = Math.max(now, this.lastTimestamp + 1);
    return this.lastTimestamp;
  }
}
