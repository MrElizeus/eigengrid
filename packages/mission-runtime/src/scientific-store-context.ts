/** Internal transaction and row primitives shared by mission repositories. Domain code passes the same transaction through every dependent write. */
import { BudgetReservationSchema, canonicalJson } from "@eigengrid/scientific-schema";
import {
  ScientificConstraintError,
  ScientificEntityConflictError,
  ScientificEntityNotFoundError,
  ScientificIllegalTransitionError,
  ScientificStoreError,
  ScientificStoreUnsupportedDatabaseError,
} from "./errors";
import { BudgetReservation, JsonRow } from "./scientific-store-validation";
import type { ScientificDatabase, ScientificTransaction } from "./types";
export class ScientificStoreContext {
  constructor(readonly database: ScientificDatabase) {}

  async inTransaction<T>(
    operation: string,
    work: (tx: ScientificTransaction) => Promise<T>,
  ): Promise<T> {
    const raw = await this.database.beginTransaction();
    if (!raw.queryRows) {
      await raw.rollback();
      throw new ScientificStoreUnsupportedDatabaseError(this.database._provider);
    }
    const tx = raw as ScientificTransaction;
    try {
      const result = await work(tx);
      await tx.commit();
      return result;
    } catch (error) {
      try {
        await tx.rollback();
      } catch {
        // Preserve the authoritative domain error; rollback is best-effort here.
      }
      if (error instanceof ScientificStoreError) throw error;
      if (error instanceof Error && error.name === "IllegalScientificTransitionError") {
        throw new ScientificIllegalTransitionError("aggregate", "unknown", "unknown", "unknown");
      }
      throw new ScientificConstraintError(operation);
    }
  }

  async one<T extends Record<string, unknown>>(
    tx: ScientificTransaction,
    sql: string,
    params: unknown[],
  ): Promise<T | null> {
    const rows = await tx.queryRows<T>(sql, params);
    return rows[0] ?? null;
  }

  async requiredRow<T extends Record<string, unknown>>(
    tx: ScientificTransaction,
    entity: string,
    id: string,
    table: string,
    lock = false,
  ): Promise<T> {
    const lockClause = lock && this.database._provider === "postgres" ? " FOR UPDATE" : "";
    const row = await this.one<T>(tx, `SELECT * FROM ${table} WHERE id = $1${lockClause}`, [id]);
    if (!row) throw new ScientificEntityNotFoundError(entity, id);
    return row;
  }

  async insertIdempotent(
    tx: ScientificTransaction,
    input: {
      entity: string;
      table: string;
      id: string;
      payload: string;
      columns: string[];
      values: unknown[];
    },
  ): Promise<boolean> {
    const placeholders = input.values.map((_, index) => `$${index + 1}`).join(", ");
    const inserted = await tx.queryRows<{ id: string }>(
      `INSERT INTO ${input.table} (${input.columns.join(", ")}) VALUES (${placeholders})
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      input.values,
    );
    if (inserted.length > 0) return true;

    const existing = await this.one<JsonRow>(
      tx,
      `SELECT id, payload_json FROM ${input.table} WHERE id = $1`,
      [input.id],
    );
    if (!existing) {
      throw new ScientificEntityConflictError(
        input.entity,
        input.id,
        "a different unique key already exists",
      );
    }
    if (String(existing.payload_json) !== input.payload) {
      throw new ScientificEntityConflictError(input.entity, input.id);
    }
    return false;
  }

  async insertBudgetReservation(
    tx: ScientificTransaction,
    budgetId: string,
    reservationInput: BudgetReservation,
  ): Promise<boolean> {
    const reservation = BudgetReservationSchema.parse(reservationInput);
    return this.insertIdempotent(tx, {
      entity: "budget reservation",
      table: "scientific_budget_reservations",
      id: reservation.id,
      payload: canonicalJson(reservation),
      columns: [
        "id",
        "budget_id",
        "work_unit_id",
        "operation_id",
        "kind",
        "amount",
        "state",
        "payload_json",
        "created_at",
        "updated_at",
      ],
      values: [
        reservation.id,
        budgetId,
        reservation.workUnitId ?? null,
        reservation.operationId ?? null,
        reservation.kind,
        reservation.amount,
        reservation.state,
        canonicalJson(reservation),
        reservation.createdAt,
        reservation.updatedAt,
      ],
    });
  }
}
