import type { DbTransaction as DbTransactionInterface } from "../client";
export interface SqliteStatement {
  run(params?: Record<string, unknown>): unknown;
  get(params?: Record<string, unknown>): Record<string, unknown> | undefined;
  all(params?: Record<string, unknown>): Record<string, unknown>[];
}

export interface SqliteConnection {
  query(sql: string): SqliteStatement;
}

export class SqliteTransaction implements DbTransactionInterface {
  private finalized = false;

  constructor(
    private db: SqliteConnection,
    private onEnd: () => void,
  ) {
    db.query("BEGIN IMMEDIATE").run();
  }

  async commit(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.db.query("COMMIT").run();
    this.onEnd();
  }

  async rollback(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.db.query("ROLLBACK").run();
    this.onEnd();
  }

  async query(sql: string, params?: Record<string, unknown> | unknown[]): Promise<unknown> {
    const stmt = this.db.query(sql);
    if (params) {
      if (Array.isArray(params)) {
        // Convert positional to named for SQLite compatibility
        const named: Record<string, unknown> = {};
        params.forEach((p, i) => {
          named[`$${i + 1}`] = p;
        });
        return stmt.run(named);
      }
      return stmt.run(params);
    }
    return stmt.run();
  }

  async queryRows<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: Record<string, unknown> | unknown[],
  ): Promise<T[]> {
    const stmt = this.db.query(sql);
    if (Array.isArray(params)) {
      const named: Record<string, unknown> = {};
      params.forEach((param, index) => {
        named[`$${index + 1}`] = param;
      });
      return stmt.all(named) as T[];
    }
    return stmt.all(params) as T[];
  }
}
