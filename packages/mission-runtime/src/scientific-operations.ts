/** Internal domain repository; callers use the public store facade. */
import {
  BudgetReservationSchema,
  ExternalOperationSchema,
  OperationReceiptSchema,
  WorkUnitSchema,
  assertScientificTransition,
  canonicalJson,
  digestCanonical,
  type ExternalOperation,
  type ExternalOperationState,
  type OperationReceipt,
} from "@eigengrid/scientific-schema";
import {
  ScientificDigestMismatchError,
  ScientificEntityConflictError,
  ScientificEntityNotFoundError,
  ScientificIdempotencyConflictError,
  ScientificIllegalTransitionError,
  ScientificIntegrityError,
  ScientificReconciliationRequiredError,
  ScientificRevisionConflictError,
} from "./errors";
import {
  insertOperationIntentOutbox,
  readOperationIntentOutbox,
  readScientificEffectAdmission,
  type OperationIntentOutbox,
  type ScientificEffectAdmission,
} from "./operation-outbox";
import { ScientificStoreContext } from "./scientific-store-context";
import {
  CLAIM_HOLDING_STATES,
  JsonRow,
  legacyOperationKind,
  parsePayload,
} from "./scientific-store-validation";
import type { OperationIntentContext } from "./types";
export class ScientificOperations {
  constructor(private readonly context: ScientificStoreContext) {}

  // ── Intent-before-effect operations and receipts ─────────

  async createOperationIntent(
    operationInput: ExternalOperation,
    context: OperationIntentContext,
  ): Promise<ExternalOperation> {
    const operation = ExternalOperationSchema.parse(operationInput);
    if (operation.state !== "intent" || operation.revision !== 1) {
      throw new ScientificIntegrityError(
        "A new external operation must begin at intent revision 1",
      );
    }
    if (operation.receiptId || operation.externalIdentity) {
      throw new ScientificIntegrityError(
        "An operation intent cannot already contain an effect identity or receipt",
      );
    }
    const expectedRequestDigest = digestCanonical(operation.request);
    if (operation.requestDigest !== expectedRequestDigest) {
      throw new ScientificDigestMismatchError(
        "external operation request",
        expectedRequestDigest,
        operation.requestDigest,
      );
    }

    return this.context.inTransaction("create external operation intent", async (tx) => {
      const existing = await this.context.one<
        JsonRow & {
          id: string;
          mission_id: string;
          work_unit_id: string;
          kind: string;
          request_digest: string;
          policy_digest: string;
          budget_reservation_id: string | null;
        }
      >(tx, "SELECT * FROM scientific_external_operations WHERE idempotency_key = $1", [
        operation.idempotencyKey,
      ]);
      if (existing) {
        const sameEffect =
          String(existing.mission_id) === operation.missionId &&
          String(existing.work_unit_id) === operation.workUnitId &&
          parsePayload(
            ExternalOperationSchema,
            existing,
            `external operation ${String(existing.id)}`,
          ).kind === operation.kind &&
          String(existing.request_digest) === operation.requestDigest &&
          String(existing.policy_digest) === operation.policyDigest &&
          (existing.budget_reservation_id == null
            ? operation.budgetReservationId == null
            : String(existing.budget_reservation_id) === operation.budgetReservationId);
        if (!sameEffect) {
          throw new ScientificIdempotencyConflictError(
            operation.idempotencyKey,
            String(existing.id),
          );
        }
        return parsePayload(
          ExternalOperationSchema,
          existing,
          `external operation ${String(existing.id)}`,
        );
      }

      const workRow = await this.context.requiredRow<JsonRow & { mission_id: string }>(
        tx,
        "work unit",
        operation.workUnitId,
        "scientific_work_units",
      );
      const workUnit = parsePayload(WorkUnitSchema, workRow, `work unit ${operation.workUnitId}`);
      if (String(workRow.mission_id) !== operation.missionId) {
        throw new ScientificIntegrityError(
          "External operation work unit belongs to another mission",
        );
      }
      if (!CLAIM_HOLDING_STATES.has(workUnit.state)) {
        throw new ScientificIntegrityError(
          "External operation intent requires a claimed work unit",
          {
            workUnitId: workUnit.id,
            workUnitState: workUnit.state,
          },
        );
      }
      if (
        workUnit.claimOwner !== context.claimOwner ||
        !workUnit.claimExpiresAt ||
        Date.parse(workUnit.claimExpiresAt) <= Date.parse(context.now)
      ) {
        throw new ScientificReconciliationRequiredError(operation.id, workUnit.state);
      }
      if (operation.budgetReservationId) {
        const reservationRow = await this.context.requiredRow<
          JsonRow & {
            budget_id: string;
            work_unit_id: string | null;
            operation_id: string | null;
            state: string;
          }
        >(
          tx,
          "budget reservation",
          operation.budgetReservationId,
          "scientific_budget_reservations",
        );
        if (
          String(reservationRow.state) !== "reserved" ||
          (reservationRow.work_unit_id &&
            String(reservationRow.work_unit_id) !== operation.workUnitId) ||
          (reservationRow.operation_id && String(reservationRow.operation_id) !== operation.id)
        ) {
          throw new ScientificIntegrityError("Operation budget reservation is not compatible");
        }
        const reservation = parsePayload(
          BudgetReservationSchema,
          reservationRow,
          `budget reservation ${operation.budgetReservationId}`,
        );
        if (reservation.operationId !== operation.id) {
          throw new ScientificIntegrityError(
            "Budget reservation must bind the operation identifier before effect intent",
            { reservationId: reservation.id, operationId: operation.id },
          );
        }
      }

      await this.context.insertIdempotent(tx, {
        entity: "external operation",
        table: "scientific_external_operations",
        id: operation.id,
        payload: canonicalJson(operation),
        columns: [
          "id",
          "mission_id",
          "work_unit_id",
          "idempotency_key",
          "kind",
          "operation_kind_id",
          "state",
          "request_digest",
          "policy_digest",
          "budget_reservation_id",
          "receipt_id",
          "revision",
          "payload_json",
          "created_at",
          "updated_at",
        ],
        values: [
          operation.id,
          operation.missionId,
          operation.workUnitId,
          operation.idempotencyKey,
          legacyOperationKind(operation.kind),
          operation.kind,
          operation.state,
          operation.requestDigest,
          operation.policyDigest,
          operation.budgetReservationId ?? null,
          null,
          operation.revision,
          canonicalJson(operation),
          operation.createdAt,
          operation.updatedAt,
        ],
      });
      await insertOperationIntentOutbox(tx, operation);
      return operation;
    });
  }

  async getExternalOperation(operationId: string): Promise<ExternalOperation | null> {
    return this.context.inTransaction("get external operation", async (tx) => {
      const row = await this.context.one<JsonRow>(
        tx,
        "SELECT payload_json FROM scientific_external_operations WHERE id = $1",
        [operationId],
      );
      return row
        ? parsePayload(ExternalOperationSchema, row, `external operation ${operationId}`)
        : null;
    });
  }

  async getOperationIntentOutbox(operationId: string): Promise<OperationIntentOutbox | null> {
    return this.context.inTransaction("get operation intent outbox", async (tx) => {
      const row = await this.context.requiredRow<JsonRow>(
        tx,
        "external operation",
        operationId,
        "scientific_external_operations",
      );
      return readOperationIntentOutbox(
        tx,
        parsePayload(ExternalOperationSchema, row, "external operation"),
      );
    });
  }

  async getEffectAdmission(operationId: string): Promise<ScientificEffectAdmission | null> {
    return this.context.inTransaction("get scientific effect admission", async (tx) => {
      const row = await this.context.requiredRow<JsonRow>(
        tx,
        "external operation",
        operationId,
        "scientific_external_operations",
      );
      return readScientificEffectAdmission(
        tx,
        parsePayload(ExternalOperationSchema, row, "external operation"),
      );
    });
  }

  /** Discovery only. Every delivery MUST still cross beginWorkUnitEffect's authority checks. */
  async listPendingOperationOutbox(input: {
    missionId: string;
    limit?: number;
    after?: { createdAt: string; operationId: string };
  }): Promise<OperationIntentOutbox[]> {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new ScientificIntegrityError("Outbox page limit must be an integer from 1 to 1000");
    }
    return this.context.inTransaction("list pending operation outbox", async (tx) => {
      const rows = await tx.queryRows<JsonRow>(
        `SELECT operation.payload_json FROM scientific_operation_outbox AS outbox
         JOIN scientific_external_operations AS operation ON operation.id = outbox.operation_id
         WHERE outbox.mission_id = $1 AND operation.state = 'intent' AND operation.revision = 1
           AND NOT EXISTS (SELECT 1 FROM scientific_effect_admissions AS admission
                           WHERE admission.operation_id = operation.id)
           ${input.after ? "AND (outbox.created_at > $2 OR (outbox.created_at = $2 AND outbox.operation_id > $3))" : ""}
         ORDER BY outbox.created_at, outbox.operation_id LIMIT ${input.after ? "$4" : "$2"}`,
        input.after
          ? [input.missionId, input.after.createdAt, input.after.operationId, limit]
          : [input.missionId, limit],
      );
      const result: OperationIntentOutbox[] = [];
      for (const row of rows) {
        const operation = parsePayload(ExternalOperationSchema, row, "pending outbox operation");
        const outbox = await readOperationIntentOutbox(tx, operation);
        if (!outbox || outbox.intent.missionId !== input.missionId) {
          throw new ScientificIntegrityError(
            "Pending outbox operation lacks its exact mission envelope",
          );
        }
        result.push(outbox);
      }
      return result;
    });
  }

  async transitionExternalOperation(input: {
    operationId: string;
    expectedRevision: number;
    to: Exclude<ExternalOperationState, "confirmed">;
    at: string;
    externalIdentity?: Record<string, unknown>;
  }): Promise<ExternalOperation> {
    return this.context.inTransaction("transition external operation", async (tx) => {
      const row = await this.context.requiredRow<JsonRow>(
        tx,
        "external operation",
        input.operationId,
        "scientific_external_operations",
      );
      const current = parsePayload(
        ExternalOperationSchema,
        row,
        `external operation ${input.operationId}`,
      );
      if (current.revision !== input.expectedRevision) {
        throw new ScientificRevisionConflictError(
          "external operation",
          current.id,
          input.expectedRevision,
          current.revision,
        );
      }
      try {
        assertScientificTransition("operation", current.state, input.to);
      } catch {
        throw new ScientificIllegalTransitionError(
          "external operation",
          current.id,
          current.state,
          input.to,
        );
      }
      const externalIdentity = input.externalIdentity ?? current.externalIdentity;
      if (input.to === "acknowledged" && !externalIdentity) {
        throw new ScientificIntegrityError(
          "Acknowledged effects require a persisted external identity",
          {
            operationId: current.id,
          },
        );
      }
      const next = ExternalOperationSchema.parse({
        ...current,
        state: input.to,
        revision: current.revision + 1,
        externalIdentity,
        updatedAt: input.at,
      });
      const changed = await tx.queryRows<{ id: string }>(
        `UPDATE scientific_external_operations
         SET state = $1, revision = $2, payload_json = $3, updated_at = $4
         WHERE id = $5 AND revision = $6 AND state = $7 RETURNING id`,
        [
          next.state,
          next.revision,
          canonicalJson(next),
          next.updatedAt,
          next.id,
          current.revision,
          current.state,
        ],
      );
      if (changed.length === 0) {
        throw new ScientificRevisionConflictError(
          "external operation",
          current.id,
          input.expectedRevision,
          current.revision + 1,
        );
      }
      return next;
    });
  }

  async finalizeOperationReceipt(
    operationId: string,
    expectedRevision: number,
    receiptInput: OperationReceipt,
  ): Promise<{ operation: ExternalOperation; receipt: OperationReceipt }> {
    const receipt = OperationReceiptSchema.parse(receiptInput);
    if (receipt.operationId !== operationId) {
      throw new ScientificIntegrityError("Operation receipt targets a different operation");
    }
    return this.context.inTransaction("finalize operation receipt", async (tx) => {
      const operationRow = await this.context.requiredRow<JsonRow>(
        tx,
        "external operation",
        operationId,
        "scientific_external_operations",
      );
      const current = parsePayload(
        ExternalOperationSchema,
        operationRow,
        `external operation ${operationId}`,
      );
      const existingReceipt = await this.context.one<JsonRow>(
        tx,
        "SELECT payload_json FROM scientific_operation_receipts WHERE operation_id = $1",
        [operationId],
      );
      if (existingReceipt) {
        const persisted = parsePayload(
          OperationReceiptSchema,
          existingReceipt,
          `operation receipt ${receipt.id}`,
        );
        if (canonicalJson(persisted) !== canonicalJson(receipt)) {
          throw new ScientificEntityConflictError("operation receipt", receipt.id);
        }
        return { operation: current, receipt: persisted };
      }
      if (current.revision !== expectedRevision) {
        throw new ScientificRevisionConflictError(
          "external operation",
          current.id,
          expectedRevision,
          current.revision,
        );
      }
      if (receipt.requestDigest !== current.requestDigest) {
        throw new ScientificDigestMismatchError(
          "operation receipt request",
          current.requestDigest,
          receipt.requestDigest,
        );
      }
      const targetState: ExternalOperationState =
        receipt.status === "confirmed"
          ? "confirmed"
          : receipt.status === "failed"
            ? "failed"
            : "ambiguous";
      try {
        assertScientificTransition("operation", current.state, targetState);
      } catch {
        throw new ScientificIllegalTransitionError(
          "external operation",
          current.id,
          current.state,
          targetState,
        );
      }
      const next = ExternalOperationSchema.parse({
        ...current,
        state: targetState,
        revision: current.revision + 1,
        receiptId: receipt.id,
        externalIdentity: receipt.externalIdentity ?? current.externalIdentity,
        updatedAt: receipt.recordedAt,
      });
      await tx.query(
        `INSERT INTO scientific_operation_receipts
           (id, operation_id, request_digest, status, detail_digest, payload_json, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          receipt.id,
          receipt.operationId,
          receipt.requestDigest,
          receipt.status,
          receipt.detailDigest,
          canonicalJson(receipt),
          receipt.recordedAt,
        ],
      );
      const changed = await tx.queryRows<{ id: string }>(
        `UPDATE scientific_external_operations
         SET state = $1, revision = $2, receipt_id = $3, payload_json = $4, updated_at = $5
         WHERE id = $6 AND revision = $7 AND state = $8 RETURNING id`,
        [
          next.state,
          next.revision,
          receipt.id,
          canonicalJson(next),
          next.updatedAt,
          next.id,
          current.revision,
          current.state,
        ],
      );
      if (changed.length === 0) {
        throw new ScientificRevisionConflictError(
          "external operation",
          current.id,
          expectedRevision,
          current.revision + 1,
        );
      }
      return { operation: next, receipt };
    });
  }

  async reconcileAmbiguousOperation(
    input:
      | {
          operationId: string;
          expectedRevision: number;
          resolution: "acknowledged" | "failed" | "abandoned";
          at: string;
          externalIdentity?: Record<string, unknown>;
        }
      | {
          operationId: string;
          expectedRevision: number;
          resolution: "receipt";
          receipt: OperationReceipt;
        },
  ): Promise<ExternalOperation> {
    const current = await this.getExternalOperation(input.operationId);
    if (!current) throw new ScientificEntityNotFoundError("external operation", input.operationId);
    if (current.state !== "ambiguous") {
      throw new ScientificIllegalTransitionError(
        "external operation",
        current.id,
        current.state,
        input.resolution,
      );
    }
    if (input.resolution === "receipt") {
      return (
        await this.finalizeOperationReceipt(
          input.operationId,
          input.expectedRevision,
          input.receipt,
        )
      ).operation;
    }
    return this.transitionExternalOperation({
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      to: input.resolution,
      at: input.at,
      externalIdentity: input.externalIdentity,
    });
  }

  async listOperationsForReconciliation(missionId: string): Promise<ExternalOperation[]> {
    return this.context.inTransaction("list operations for reconciliation", async (tx) => {
      const rows = await tx.queryRows<JsonRow>(
        `SELECT operation.payload_json FROM scientific_external_operations operation
         JOIN scientific_work_units work ON work.id = operation.work_unit_id
         WHERE operation.mission_id = $1 AND (
           operation.state IN ('effect_started','acknowledged','ambiguous')
           OR (operation.operation_kind_id = 'md_stage_execution' AND operation.state = 'confirmed'
               AND operation.receipt_id IS NOT NULL AND work.state = 'observing')
         )
         ORDER BY operation.created_at, operation.id`,
        [missionId],
      );
      return rows.map((row) => parsePayload(ExternalOperationSchema, row, "external operation"));
    });
  }
}
