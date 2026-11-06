import type { DbTransaction } from "../client";
import { DbError, DbErrorCode } from "../errors";
// ── PostgresDatabase ─────────────────────────────────────────

export class PostgresTransaction implements DbTransaction {
  private client: import("pg").PoolClient;
  private finalized = false;

  constructor(client: import("pg").PoolClient) {
    this.client = client;
  }

  async commit(): Promise<void> {
    if (this.finalized) return;
    try {
      await this.client.query("COMMIT");
      this.finalized = true;
      this.client.release();
    } catch (err) {
      this.client.release();
      this.finalized = true;
      throw new DbError(
        "PostgreSQL transaction commit failed",
        DbErrorCode.TRANSACTION,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async rollback(): Promise<void> {
    if (this.finalized) return;
    try {
      await this.client.query("ROLLBACK");
      this.finalized = true;
      this.client.release();
    } catch (err) {
      this.client.release();
      this.finalized = true;
      throw new DbError(
        "PostgreSQL transaction rollback failed",
        DbErrorCode.TRANSACTION,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async query(sql: string, params?: unknown[]): Promise<unknown> {
    return this.client.query(sql, params ?? []);
  }

  async queryRows<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: Record<string, unknown> | unknown[],
  ): Promise<T[]> {
    if (params && !Array.isArray(params)) {
      throw new DbError(
        "PostgreSQL transactions require positional parameters",
        DbErrorCode.QUERY_FAILED,
      );
    }
    const result = await this.client.query(sql, params ?? []);
    return (result.rows ?? []) as T[];
  }
}
