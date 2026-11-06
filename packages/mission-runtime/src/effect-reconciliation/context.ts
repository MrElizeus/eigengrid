import {
  ScientificEntityConflictError,
  ScientificEntityNotFoundError,
  ScientificIntegrityError,
  ScientificStoreUnsupportedDatabaseError,
} from "../errors";
import type { ScientificDatabase, ScientificTransaction } from "../types";
import { type PayloadRow } from "./payload";

export class EffectReconciliationContext {
  constructor(
    readonly database: ScientificDatabase,
    readonly now: () => Date = () => new Date(),
  ) {
    if (!database.beginTransaction || !["sqlite", "postgres"].includes(database._provider)) {
      throw new ScientificStoreUnsupportedDatabaseError(database._provider);
    }
  }

  async inTransaction<T>(
    operation: string,
    body: (transaction: ScientificTransaction) => Promise<T>,
  ): Promise<T> {
    const transaction = (await this.database.beginTransaction()) as ScientificTransaction;
    if (!transaction.queryRows) {
      await transaction.rollback();
      throw new ScientificStoreUnsupportedDatabaseError(this.database._provider);
    }
    try {
      const result = await body(transaction);
      await transaction.commit();
      return result;
    } catch (error) {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        throw new ScientificIntegrityError(`${operation} failed and rollback also failed`, {
          cause: error instanceof Error ? error.message : String(error),
          rollback: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      }
      throw error;
    }
  }

  async requiredRow(
    transaction: ScientificTransaction,
    table: string,
    id: string,
    label: string,
    lock = false,
  ): Promise<PayloadRow> {
    if (!/^[a-z_]+$/u.test(table)) {
      throw new ScientificIntegrityError("Unsafe internal table identifier", { table });
    }
    const rows = await transaction.queryRows<PayloadRow>(
      `SELECT * FROM ${table} WHERE id = $1${lock ? this.lockClause() : ""}`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new ScientificEntityNotFoundError(label, id);
    if (rows.length > 1) {
      throw new ScientificEntityConflictError(label, id, "multiple rows share a unique identifier");
    }
    return row;
  }

  lockClause(): string {
    return this.database._provider === "postgres" ? " FOR UPDATE" : "";
  }
}
