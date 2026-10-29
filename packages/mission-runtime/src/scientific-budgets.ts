/** Internal domain repository; callers use the public store facade. */
import {
  BudgetReservationSchema,
  MissionBudgetSchema,
  ModelInvocationIntentSchema,
  canonicalJson,
  digestCanonical,
  type MissionBudget,
  type ModelInvocationIntent,
} from "@eigengrid/scientific-schema";
import {
  ScientificBudgetExceededError,
  ScientificEntityConflictError,
  ScientificEntityNotFoundError,
  ScientificIllegalTransitionError,
  ScientificIntegrityError,
  ScientificRevisionConflictError,
} from "./errors";
import { ScientificStoreContext } from "./scientific-store-context";
import { BudgetReservation, JsonRow, parsePayload } from "./scientific-store-validation";
export class ScientificBudgets {
  constructor(private readonly context: ScientificStoreContext) {}

  async reserveBudget(input: {
    missionId: string;
    expectedBudgetRevision: number;
    reservation: BudgetReservation;
  }): Promise<MissionBudget> {
    const reservation = BudgetReservationSchema.parse(input.reservation);
    if (reservation.state !== "reserved") {
      throw new ScientificIntegrityError("A new budget reservation must be in reserved state");
    }
    if (reservation.kind === "external_operation" && !Number.isInteger(reservation.amount)) {
      throw new ScientificIntegrityError(
        "External-operation reservations must use an integer amount",
      );
    }
    return this.context.inTransaction("reserve mission budget", async (tx) => {
      const budgetRow = await this.context.one<JsonRow>(
        tx,
        "SELECT * FROM scientific_mission_budgets WHERE mission_id = $1",
        [input.missionId],
      );
      if (!budgetRow) throw new ScientificEntityNotFoundError("mission budget", input.missionId);
      const budget = parsePayload(
        MissionBudgetSchema,
        budgetRow,
        `mission budget ${input.missionId}`,
      );
      if (budget.revision !== input.expectedBudgetRevision) {
        throw new ScientificRevisionConflictError(
          "mission budget",
          budget.id,
          input.expectedBudgetRevision,
          budget.revision,
        );
      }

      const existing = await this.context.one<JsonRow>(
        tx,
        "SELECT payload_json FROM scientific_budget_reservations WHERE id = $1",
        [reservation.id],
      );
      if (existing) {
        if (String(existing.payload_json) !== canonicalJson(reservation)) {
          throw new ScientificEntityConflictError("budget reservation", reservation.id);
        }
        if (!budget.reservations.some((item) => item.id === reservation.id)) {
          throw new ScientificIntegrityError(
            "Budget reservation row is missing from its aggregate payload",
            {
              reservationId: reservation.id,
              budgetId: budget.id,
            },
          );
        }
        return budget;
      }

      const key = this.budgetKey(reservation.kind);
      const held = budget.reservations
        .filter(
          (item) =>
            item.kind === reservation.kind &&
            (item.state === "reserved" || item.state === "ambiguous"),
        )
        .reduce((sum, item) => sum + item.amount, 0);
      const available = budget.limits[key] - budget.consumed[key] - held;
      if (reservation.amount > available) {
        throw new ScientificBudgetExceededError(reservation.kind, reservation.amount, available);
      }
      if (reservation.workUnitId) {
        const work = await this.context.requiredRow<{ mission_id: string }>(
          tx,
          "work unit",
          reservation.workUnitId,
          "scientific_work_units",
        );
        if (String(work.mission_id) !== input.missionId) {
          throw new ScientificIntegrityError(
            "Budget reservation work unit belongs to another mission",
          );
        }
      }

      await this.context.insertBudgetReservation(tx, budget.id, reservation);
      const next = MissionBudgetSchema.parse({
        ...budget,
        revision: budget.revision + 1,
        reservations: [...budget.reservations, reservation],
      });
      const updated = await tx.queryRows<{ id: string }>(
        `UPDATE scientific_mission_budgets
         SET revision = $1, payload_digest = $2, payload_json = $3
         WHERE id = $4 AND revision = $5 RETURNING id`,
        [next.revision, digestCanonical(next), canonicalJson(next), next.id, budget.revision],
      );
      if (updated.length === 0) {
        throw new ScientificRevisionConflictError(
          "mission budget",
          budget.id,
          input.expectedBudgetRevision,
          budget.revision + 1,
        );
      }
      return next;
    });
  }

  async settleBudgetReservation(input: {
    missionId: string;
    reservationId: string;
    expectedBudgetRevision: number;
    state: "consumed" | "released" | "ambiguous";
    at: string;
  }): Promise<MissionBudget> {
    return this.context.inTransaction("settle budget reservation", async (tx) => {
      const budgetRow = await this.context.one<JsonRow>(
        tx,
        "SELECT * FROM scientific_mission_budgets WHERE mission_id = $1",
        [input.missionId],
      );
      if (!budgetRow) throw new ScientificEntityNotFoundError("mission budget", input.missionId);
      const budget = parsePayload(
        MissionBudgetSchema,
        budgetRow,
        `mission budget ${input.missionId}`,
      );
      if (budget.revision !== input.expectedBudgetRevision) {
        throw new ScientificRevisionConflictError(
          "mission budget",
          budget.id,
          input.expectedBudgetRevision,
          budget.revision,
        );
      }
      const index = budget.reservations.findIndex((item) => item.id === input.reservationId);
      if (index < 0)
        throw new ScientificEntityNotFoundError("budget reservation", input.reservationId);
      const current = budget.reservations[index]!;
      if (current.state === input.state) return budget;
      const permitted =
        current.state === "reserved" ||
        (current.state === "ambiguous" &&
          (input.state === "consumed" || input.state === "released"));
      if (!permitted) {
        throw new ScientificIllegalTransitionError(
          "budget reservation",
          current.id,
          current.state,
          input.state,
        );
      }
      const settled = BudgetReservationSchema.parse({
        ...current,
        state: input.state,
        updatedAt: input.at,
      });
      const reservations = [...budget.reservations];
      reservations[index] = settled;
      const consumed = { ...budget.consumed };
      if (input.state === "consumed") {
        const key = this.budgetKey(current.kind);
        consumed[key] += current.amount;
      }
      const next = MissionBudgetSchema.parse({
        ...budget,
        revision: budget.revision + 1,
        consumed,
        reservations,
      });
      await tx.query(
        `UPDATE scientific_budget_reservations
         SET state = $1, payload_json = $2, updated_at = $3
         WHERE id = $4 AND state = $5`,
        [settled.state, canonicalJson(settled), settled.updatedAt, settled.id, current.state],
      );
      const updated = await tx.queryRows<{ id: string }>(
        `UPDATE scientific_mission_budgets
         SET revision = $1, consumed_json = $2, payload_digest = $3, payload_json = $4
         WHERE id = $5 AND revision = $6 RETURNING id`,
        [
          next.revision,
          canonicalJson(next.consumed),
          digestCanonical(next),
          canonicalJson(next),
          next.id,
          budget.revision,
        ],
      );
      if (updated.length === 0) {
        throw new ScientificRevisionConflictError(
          "mission budget",
          budget.id,
          input.expectedBudgetRevision,
          budget.revision + 1,
        );
      }
      return next;
    });
  }

  private budgetKey(kind: BudgetReservation["kind"]): keyof MissionBudget["limits"] {
    return kind === "external_operation"
      ? "externalOperations"
      : kind === "model_tokens"
        ? "modelTokens"
        : kind === "wall_time_seconds"
          ? "wallTimeSeconds"
          : "cost";
  }

  /**
   * Persists a model intent and reserves its conservative maximum budget before a provider call.
   * A caller must not invoke a provider until this method returns admitted=true.
   */
  async beginModelInvocation(input: ModelInvocationIntent): Promise<{
    admitted: boolean;
    reason?: "already_in_flight" | "already_observed" | "already_unavailable" | "already_ambiguous";
    intent: ModelInvocationIntent;
  }> {
    const intent = ModelInvocationIntentSchema.parse(input);
    return this.context.inTransaction("begin model invocation", async (tx) => {
      const existingRow = await this.context.one<JsonRow>(
        tx,
        "SELECT payload_json FROM scientific_model_invocation_intents WHERE idempotency_key = $1",
        [intent.idempotencyKey],
      );
      if (existingRow) {
        const existing = parsePayload(
          ModelInvocationIntentSchema,
          existingRow,
          `model invocation intent ${intent.idempotencyKey}`,
        );
        return {
          admitted: false,
          reason:
            existing.status === "invoking"
              ? "already_in_flight"
              : existing.status === "observed"
                ? "already_observed"
                : existing.status === "unavailable"
                  ? "already_unavailable"
                  : "already_ambiguous",
          intent: existing,
        };
      }

      await this.context.requiredRow(tx, "mission", intent.missionId, "scientific_missions");
      if (intent.planId) {
        const plan = await this.context.requiredRow<{ mission_id: string }>(
          tx,
          "plan",
          intent.planId,
          "scientific_plans",
        );
        if (String(plan.mission_id) !== intent.missionId) {
          throw new ScientificIntegrityError("Model invocation plan belongs to another mission");
        }
      }
      if (intent.planningClaimId) {
        const claim = await this.context.requiredRow<{
          mission_id: string;
          status: string;
          expires_at: string;
        }>(tx, "planning claim", intent.planningClaimId, "scientific_planning_claims");
        if (String(claim.mission_id) !== intent.missionId) {
          throw new ScientificIntegrityError("Model invocation claim belongs to another mission");
        }
        if (String(claim.status) !== "active") {
          throw new ScientificEntityConflictError(
            "planning claim",
            intent.planningClaimId,
            "model invocation requires an active planning claim",
          );
        }
        if (Date.parse(String(claim.expires_at)) <= Date.parse(intent.createdAt)) {
          throw new ScientificEntityConflictError(
            "planning claim",
            intent.planningClaimId,
            "model invocation cannot start after the planning lease expired",
          );
        }
      }

      const budgetRow = await this.context.one<JsonRow>(
        tx,
        `SELECT * FROM scientific_mission_budgets WHERE mission_id = $1${
          this.context.database._provider === "postgres" ? " FOR UPDATE" : ""
        }`,
        [intent.missionId],
      );
      if (!budgetRow) throw new ScientificEntityNotFoundError("mission budget", intent.missionId);
      const budget = parsePayload(
        MissionBudgetSchema,
        budgetRow,
        `mission budget ${intent.missionId}`,
      );
      const tokenReservation = BudgetReservationSchema.parse({
        id: intent.budgetReservationIds.modelTokens,
        kind: "model_tokens",
        amount: intent.budget.maximumTotalTokens,
        state: "reserved",
        createdAt: intent.createdAt,
        updatedAt: intent.createdAt,
      });
      const costReservation = BudgetReservationSchema.parse({
        id: intent.budgetReservationIds.cost,
        kind: "cost",
        amount: intent.budget.maximumCost,
        state: "reserved",
        createdAt: intent.createdAt,
        updatedAt: intent.createdAt,
      });
      let nextBudget = budget;
      for (const reservation of [tokenReservation, costReservation]) {
        const key = this.budgetKey(reservation.kind);
        const held = nextBudget.reservations
          .filter(
            (item) =>
              item.kind === reservation.kind &&
              (item.state === "reserved" || item.state === "ambiguous"),
          )
          .reduce((sum, item) => sum + item.amount, 0);
        const available = nextBudget.limits[key] - nextBudget.consumed[key] - held;
        if (reservation.amount > available) {
          throw new ScientificBudgetExceededError(reservation.kind, reservation.amount, available);
        }
        await this.context.insertBudgetReservation(tx, nextBudget.id, reservation);
        nextBudget = MissionBudgetSchema.parse({
          ...nextBudget,
          revision: nextBudget.revision + 1,
          reservations: [...nextBudget.reservations, reservation],
        });
      }
      const budgetUpdated = await tx.queryRows<{ id: string }>(
        `UPDATE scientific_mission_budgets
         SET revision = $1, payload_digest = $2, payload_json = $3
         WHERE id = $4 AND revision = $5 RETURNING id`,
        [
          nextBudget.revision,
          digestCanonical(nextBudget),
          canonicalJson(nextBudget),
          nextBudget.id,
          budget.revision,
        ],
      );
      if (budgetUpdated.length !== 1) {
        throw new ScientificRevisionConflictError(
          "mission budget",
          budget.id,
          budget.revision,
          budget.revision + 1,
        );
      }
      await tx.query(
        `INSERT INTO scientific_model_invocation_intents
           (id, idempotency_key, mission_id, plan_id, planning_claim_id, role, provider, model,
            capability_digest, request_digest, context_digest, status,
            budget_model_reservation_id, budget_cost_reservation_id, payload_json, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          intent.id,
          intent.idempotencyKey,
          intent.missionId,
          intent.planId ?? null,
          intent.planningClaimId ?? null,
          intent.role,
          intent.provider,
          intent.model,
          intent.capabilityDigest,
          intent.requestDigest,
          intent.contextDigest,
          intent.status,
          tokenReservation.id,
          costReservation.id,
          canonicalJson(intent),
          intent.createdAt,
          intent.updatedAt,
        ],
      );
      return { admitted: true, intent };
    });
  }

  /** Records the first durable observation after a provider promise settles. */
  async observeModelInvocation(input: {
    intentId: string;
    status: "observed" | "unavailable" | "ambiguous";
    observedAt: string;
    responseDigest?: string;
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
    errorCode?: string;
  }): Promise<ModelInvocationIntent> {
    return this.context.inTransaction("observe model invocation", async (tx) => {
      const row = await this.context.one<JsonRow>(
        tx,
        `SELECT payload_json FROM scientific_model_invocation_intents WHERE id = $1${
          this.context.database._provider === "postgres" ? " FOR UPDATE" : ""
        }`,
        [input.intentId],
      );
      if (!row) throw new ScientificEntityNotFoundError("model invocation intent", input.intentId);
      const current = parsePayload(
        ModelInvocationIntentSchema,
        row,
        `model invocation intent ${input.intentId}`,
      );
      if (current.status !== "invoking") return current;
      const budgetRow = await this.context.one<JsonRow>(
        tx,
        `SELECT * FROM scientific_mission_budgets WHERE mission_id = $1${
          this.context.database._provider === "postgres" ? " FOR UPDATE" : ""
        }`,
        [current.missionId],
      );
      if (!budgetRow) throw new ScientificEntityNotFoundError("mission budget", current.missionId);
      const budget = parsePayload(
        MissionBudgetSchema,
        budgetRow,
        `mission budget ${current.missionId}`,
      );
      const reservationState =
        input.status === "observed"
          ? "consumed"
          : input.status === "unavailable"
            ? "released"
            : "ambiguous";
      const reservations = [...budget.reservations];
      const consumed = { ...budget.consumed };
      for (const reservationId of [
        current.budgetReservationIds.modelTokens,
        current.budgetReservationIds.cost,
      ]) {
        const index = reservations.findIndex((reservation) => reservation.id === reservationId);
        if (index < 0) throw new ScientificEntityNotFoundError("budget reservation", reservationId);
        const reservation = reservations[index]!;
        if (reservation.state !== "reserved") continue;
        const observedAmount =
          input.status === "observed"
            ? reservation.kind === "model_tokens"
              ? input.inputTokens !== undefined || input.outputTokens !== undefined
                ? Math.min(reservation.amount, (input.inputTokens ?? 0) + (input.outputTokens ?? 0))
                : reservation.amount
              : input.cost !== undefined
                ? Math.min(reservation.amount, input.cost)
                : reservation.amount
            : reservation.amount;
        const settled = BudgetReservationSchema.parse({
          ...reservation,
          amount: observedAmount,
          state: reservationState,
          updatedAt: input.observedAt,
        });
        reservations[index] = settled;
        if (reservationState === "consumed") {
          const key = this.budgetKey(reservation.kind);
          consumed[key] += settled.amount;
        }
        await tx.query(
          `UPDATE scientific_budget_reservations
           SET state = $1, payload_json = $2, updated_at = $3
           WHERE id = $4 AND state = $5`,
          [settled.state, canonicalJson(settled), settled.updatedAt, settled.id, "reserved"],
        );
      }
      const nextBudget = MissionBudgetSchema.parse({
        ...budget,
        revision: budget.revision + 1,
        consumed,
        reservations,
      });
      await tx.queryRows<{ id: string }>(
        `UPDATE scientific_mission_budgets
         SET revision = $1, consumed_json = $2, payload_digest = $3, payload_json = $4
         WHERE id = $5 AND revision = $6 RETURNING id`,
        [
          nextBudget.revision,
          canonicalJson(nextBudget.consumed),
          digestCanonical(nextBudget),
          canonicalJson(nextBudget),
          nextBudget.id,
          budget.revision,
        ],
      );
      const next = ModelInvocationIntentSchema.parse({
        ...current,
        status: input.status,
        ...(input.responseDigest ? { responseDigest: input.responseDigest } : {}),
        ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
        ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
        ...(input.cost !== undefined ? { cost: input.cost } : {}),
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        updatedAt: input.observedAt,
      });
      await tx.query(
        `UPDATE scientific_model_invocation_intents
         SET status = $1, payload_json = $2, updated_at = $3
         WHERE id = $4 AND status = $5`,
        [next.status, canonicalJson(next), next.updatedAt, next.id, current.status],
      );
      return next;
    });
  }
}
