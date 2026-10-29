/** Internal domain repository; callers use the public store facade. */
import {
  assertScientificTransition,
  canonicalJson,
  digestCanonical,
  MissionBudgetSchema,
  ScientificMissionSchema,
  type ActorIdentity,
  type MissionBudget,
  type MissionState,
  type ScientificMission,
} from "@eigengrid/scientific-schema";
import {
  ScientificApprovalIncompatibleStateError,
  ScientificEntityConflictError,
  ScientificEntityNotFoundError,
  ScientificIllegalTransitionError,
  ScientificIntegrityError,
  ScientificRevisionConflictError,
} from "./errors";
import {
  assertMissionProjectCreationAuthority,
  assertProjectPlanningAuthority,
  createScientificMissionProjectAssociation,
  readScientificMissionProjectAssociation,
  scientificMissionProjectAssociationValues,
  type MissionProjectCreationAuthorityInput,
  type ScientificMissionProjectAssociation,
} from "./mission-project";
import { ScientificStoreContext } from "./scientific-store-context";
import {
  CreateMissionInProjectInput,
  JsonRow,
  parsePayload,
  TERMINAL_MISSION_STATES,
} from "./scientific-store-validation";
import type { MissionTransitionRecord, ScientificTransaction } from "./types";
export class ScientificMissions {
  constructor(private readonly context: ScientificStoreContext) {}

  // ── Missions and budgets ─────────────────────────────────

  async createMission(
    missionInput: ScientificMission,
    budgetInput: MissionBudget,
  ): Promise<ScientificMission> {
    const aggregate = this.validateNewMissionAggregate(missionInput, budgetInput);
    const result = await this.context.inTransaction("create mission", async (tx) =>
      this.insertNewMissionAggregate(tx, aggregate.mission, aggregate.budget),
    );
    return result.mission;
  }

  /**
   * Production V1 multi-user creation path. Unlike the legacy createMission
   * helper, this binds a human-owned mission to its selected project before it
   * can enter the production planning/effect route. The association is created
   * in the same PostgreSQL transaction as mission and budget; it is not a
   * mutable request field or a later delivery-time inference.
   */
  async createMissionInProject(input: CreateMissionInProjectInput): Promise<ScientificMission> {
    const aggregate = this.validateNewMissionAggregate(input.mission, input.budget);
    const authorityInput: MissionProjectCreationAuthorityInput = {
      mission: aggregate.mission,
      projectId: input.projectId,
      ownerUserId: input.ownerUserId,
    };
    const association = createScientificMissionProjectAssociation(authorityInput);
    return this.context.inTransaction("create mission in project", async (tx) => {
      await assertMissionProjectCreationAuthority(
        tx,
        authorityInput,
        this.context.database._provider,
      );
      const persisted = await this.insertNewMissionAggregate(
        tx,
        aggregate.mission,
        aggregate.budget,
      );
      if (persisted.created) {
        await this.insertMissionProjectAssociation(tx, association);
        return persisted.mission;
      }
      const existing = await readScientificMissionProjectAssociation(
        tx,
        association.missionId,
        this.context.database._provider,
        true,
      );
      if (!existing) {
        throw new ScientificIntegrityError(
          "A historical unbound mission cannot be retroactively bound to a production project",
        );
      }
      if (canonicalJson(existing) !== canonicalJson(association)) {
        throw new ScientificEntityConflictError(
          "scientific mission project association",
          association.missionId,
        );
      }
      return persisted.mission;
    });
  }

  /**
   * Explicit guard for the production planning façade. Legacy historical
   * missions intentionally keep their old createMission semantics; they cannot
   * use this route until an administrator performs a separately reviewed
   * migration. New external effects revalidate again at their own boundary.
   */
  async assertProductionProjectPlanningAccess(input: {
    projectId: string;
    ownerUserId: string;
  }): Promise<void> {
    await this.context.inTransaction("assert production project planning access", async (tx) => {
      await assertProjectPlanningAuthority(tx, input, this.context.database._provider);
    });
  }

  async assertProductionMissionPlanningAccess(input: {
    missionId: string;
    projectId: string;
    ownerUserId: string;
  }): Promise<{
    mission: ScientificMission;
    association: ScientificMissionProjectAssociation;
  }> {
    return this.context.inTransaction("assert production mission planning access", async (tx) => {
      const missionRow = await this.context.requiredRow<JsonRow>(
        tx,
        "mission",
        input.missionId,
        "scientific_missions",
        true,
      );
      const mission = parsePayload(
        ScientificMissionSchema,
        missionRow,
        `mission ${input.missionId}`,
      );
      const authority = await assertMissionProjectCreationAuthority(
        tx,
        { mission, projectId: input.projectId, ownerUserId: input.ownerUserId },
        this.context.database._provider,
      );
      const association = await readScientificMissionProjectAssociation(
        tx,
        mission.id,
        this.context.database._provider,
        true,
      );
      if (
        !association ||
        association.projectId !== authority.projectId ||
        association.ownerUserId !== authority.ownerUserId
      ) {
        throw new ScientificIntegrityError(
          "Production mission planning requires its exact immutable project association",
        );
      }
      return { mission, association };
    });
  }

  async getMissionProjectAssociation(
    missionId: string,
  ): Promise<ScientificMissionProjectAssociation | null> {
    return this.context.inTransaction("get mission project association", async (tx) =>
      readScientificMissionProjectAssociation(tx, missionId, this.context.database._provider),
    );
  }

  private validateNewMissionAggregate(
    missionInput: ScientificMission,
    budgetInput: MissionBudget,
  ): { mission: ScientificMission; budget: MissionBudget } {
    const mission = ScientificMissionSchema.parse(missionInput);
    const budget = MissionBudgetSchema.parse(budgetInput);
    if (mission.state !== "created" || mission.revision !== 1) {
      throw new ScientificIntegrityError("A new mission must begin at created revision 1");
    }
    if (budget.revision !== 1) {
      throw new ScientificIntegrityError("A new mission budget must begin at revision 1");
    }
    if (mission.budgetId !== budget.id || mission.id !== budget.missionId) {
      throw new ScientificIntegrityError(
        "Mission and budget identifiers do not form one aggregate",
        {
          missionId: mission.id,
          missionBudgetId: mission.budgetId,
          budgetId: budget.id,
          budgetMissionId: budget.missionId,
        },
      );
    }
    for (const reservation of budget.reservations) {
      if (reservation.workUnitId || reservation.operationId) {
        throw new ScientificIntegrityError(
          "Initial budget reservations cannot reference work or operations that do not exist yet",
          { reservationId: reservation.id },
        );
      }
    }

    return { mission, budget };
  }

  private async insertNewMissionAggregate(
    tx: ScientificTransaction,
    mission: ScientificMission,
    budget: MissionBudget,
  ): Promise<{ mission: ScientificMission; created: boolean }> {
    const missionJson = canonicalJson(mission);
    const budgetJson = canonicalJson(budget);
    const created = await this.context.insertIdempotent(tx, {
      entity: "mission",
      table: "scientific_missions",
      id: mission.id,
      payload: missionJson,
      columns: [
        "id",
        "revision",
        "state",
        "budget_id",
        "active_plan_id",
        "objective_digest",
        "payload_digest",
        "payload_json",
        "created_at",
        "updated_at",
        "terminal_at",
      ],
      values: [
        mission.id,
        mission.revision,
        mission.state,
        mission.budgetId,
        mission.activePlanId,
        digestCanonical(mission.objective),
        digestCanonical(mission),
        missionJson,
        mission.createdAt,
        mission.updatedAt,
        mission.terminalAt ?? null,
      ],
    });

    await this.context.insertIdempotent(tx, {
      entity: "mission budget",
      table: "scientific_mission_budgets",
      id: budget.id,
      payload: budgetJson,
      columns: [
        "id",
        "mission_id",
        "revision",
        "limits_json",
        "consumed_json",
        "payload_digest",
        "payload_json",
      ],
      values: [
        budget.id,
        budget.missionId,
        budget.revision,
        canonicalJson(budget.limits),
        canonicalJson(budget.consumed),
        digestCanonical(budget),
        budgetJson,
      ],
    });

    for (const reservation of budget.reservations) {
      await this.context.insertBudgetReservation(tx, budget.id, reservation);
    }

    if (created) {
      await tx.query(
        `INSERT INTO scientific_mission_transitions
           (mission_id, sequence, from_state, to_state, from_revision, to_revision, reason, actor_json, occurred_at)
         VALUES ($1, 1, NULL, $2, 0, 1, $3, $4, $5)`,
        [
          mission.id,
          mission.state,
          "mission_created",
          canonicalJson(mission.requestedBy),
          mission.createdAt,
        ],
      );
    }
    return { mission, created };
  }

  private async insertMissionProjectAssociation(
    tx: ScientificTransaction,
    association: ScientificMissionProjectAssociation,
  ): Promise<void> {
    const inserted = await tx.queryRows<{ mission_id: string }>(
      `INSERT INTO scientific_mission_projects
       (mission_id, project_id, owner_user_id, association_digest, payload_json, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (mission_id) DO NOTHING RETURNING mission_id`,
      [...scientificMissionProjectAssociationValues(association)],
    );
    if (inserted.length > 0) return;
    const existing = await readScientificMissionProjectAssociation(
      tx,
      association.missionId,
      this.context.database._provider,
      true,
    );
    if (!existing || canonicalJson(existing) !== canonicalJson(association)) {
      throw new ScientificEntityConflictError(
        "scientific mission project association",
        association.missionId,
      );
    }
  }

  async getMission(missionId: string): Promise<ScientificMission | null> {
    return this.context.inTransaction("get mission", async (tx) => {
      const row = await this.context.one<JsonRow>(
        tx,
        "SELECT payload_json FROM scientific_missions WHERE id = $1",
        [missionId],
      );
      return row ? parsePayload(ScientificMissionSchema, row, `mission ${missionId}`) : null;
    });
  }

  async getMissionBudget(missionId: string): Promise<MissionBudget> {
    return this.context.inTransaction("get mission budget", async (tx) => {
      const row = await this.context.one<JsonRow>(
        tx,
        "SELECT payload_json FROM scientific_mission_budgets WHERE mission_id = $1",
        [missionId],
      );
      if (!row) throw new ScientificEntityNotFoundError("mission budget", missionId);
      return parsePayload(MissionBudgetSchema, row, `mission budget ${missionId}`);
    });
  }

  async listRecoverableMissions(): Promise<ScientificMission[]> {
    return this.context.inTransaction("list recoverable missions", async (tx) => {
      const rows = await tx.queryRows<JsonRow>(
        `SELECT payload_json FROM scientific_missions
         WHERE state NOT IN ('completed', 'failed', 'cancelled') ORDER BY created_at, id`,
      );
      return rows.map((row) => parsePayload(ScientificMissionSchema, row, "mission"));
    });
  }

  async transitionMission(input: {
    missionId: string;
    expectedRevision: number;
    to: MissionState;
    reason: string;
    actor: ActorIdentity;
    at: string;
  }): Promise<ScientificMission> {
    return this.context.inTransaction("transition mission", async (tx) => {
      const row = await this.context.requiredRow<JsonRow>(
        tx,
        "mission",
        input.missionId,
        "scientific_missions",
      );
      const current = parsePayload(ScientificMissionSchema, row, `mission ${input.missionId}`);
      if (current.revision !== input.expectedRevision) {
        throw new ScientificRevisionConflictError(
          "mission",
          current.id,
          input.expectedRevision,
          current.revision,
        );
      }
      try {
        assertScientificTransition("mission", current.state, input.to);
      } catch {
        throw new ScientificIllegalTransitionError("mission", current.id, current.state, input.to);
      }

      const next = ScientificMissionSchema.parse({
        ...current,
        revision: current.revision + 1,
        state: input.to,
        updatedAt: input.at,
        terminalAt: TERMINAL_MISSION_STATES.has(input.to) ? input.at : undefined,
      });
      const updated = await tx.queryRows<{ id: string }>(
        `UPDATE scientific_missions
         SET revision = $1, state = $2, payload_digest = $3, payload_json = $4,
             updated_at = $5, terminal_at = $6
         WHERE id = $7 AND revision = $8 AND state = $9 RETURNING id`,
        [
          next.revision,
          next.state,
          digestCanonical(next),
          canonicalJson(next),
          next.updatedAt,
          next.terminalAt ?? null,
          next.id,
          input.expectedRevision,
          current.state,
        ],
      );
      if (updated.length === 0) {
        const actual = await this.context.requiredRow<{ revision: number }>(
          tx,
          "mission",
          current.id,
          "scientific_missions",
        );
        throw new ScientificRevisionConflictError(
          "mission",
          current.id,
          input.expectedRevision,
          Number(actual.revision),
        );
      }
      await this.appendMissionTransition(tx, {
        missionId: next.id,
        fromState: current.state,
        toState: next.state,
        fromRevision: current.revision,
        toRevision: next.revision,
        reason: input.reason,
        actor: input.actor,
        occurredAt: input.at,
      });
      return next;
    });
  }

  async activatePlan(input: {
    missionId: string;
    planId: string;
    expectedMissionRevision: number;
    actor: ActorIdentity;
    at: string;
  }): Promise<ScientificMission> {
    return this.context.inTransaction("activate plan", async (tx) => {
      const missionRow = await this.context.requiredRow<JsonRow>(
        tx,
        "mission",
        input.missionId,
        "scientific_missions",
      );
      const mission = parsePayload(
        ScientificMissionSchema,
        missionRow,
        `mission ${input.missionId}`,
      );
      if (mission.revision !== input.expectedMissionRevision) {
        throw new ScientificRevisionConflictError(
          "mission",
          mission.id,
          input.expectedMissionRevision,
          mission.revision,
        );
      }
      const planRow = await this.context.requiredRow<
        JsonRow & { status: string; mission_id: string }
      >(tx, "plan", input.planId, "scientific_plans");
      if (String(planRow.mission_id) !== mission.id || String(planRow.status) !== "approved") {
        throw new ScientificApprovalIncompatibleStateError(
          input.planId,
          mission.state,
          String(planRow.status),
        );
      }
      const next = ScientificMissionSchema.parse({
        ...mission,
        revision: mission.revision + 1,
        activePlanId: input.planId,
        updatedAt: input.at,
      });
      const updated = await tx.queryRows<{ id: string }>(
        `UPDATE scientific_missions SET revision = $1, active_plan_id = $2,
           payload_digest = $3, payload_json = $4, updated_at = $5
         WHERE id = $6 AND revision = $7 RETURNING id`,
        [
          next.revision,
          next.activePlanId,
          digestCanonical(next),
          canonicalJson(next),
          next.updatedAt,
          next.id,
          mission.revision,
        ],
      );
      if (updated.length === 0) {
        throw new ScientificRevisionConflictError(
          "mission",
          mission.id,
          input.expectedMissionRevision,
          mission.revision + 1,
        );
      }
      await this.appendMissionTransition(tx, {
        missionId: next.id,
        fromState: mission.state,
        toState: next.state,
        fromRevision: mission.revision,
        toRevision: next.revision,
        reason: `activate_plan:${input.planId}`,
        actor: input.actor,
        occurredAt: input.at,
      });
      return next;
    });
  }

  private async appendMissionTransition(
    tx: ScientificTransaction,
    input: Omit<MissionTransitionRecord, "sequence">,
  ): Promise<void> {
    const sequenceRow = await this.context.one<{ next_sequence: number | string }>(
      tx,
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
       FROM scientific_mission_transitions WHERE mission_id = $1`,
      [input.missionId],
    );
    const sequence = Number(sequenceRow?.next_sequence ?? 1);
    await tx.query(
      `INSERT INTO scientific_mission_transitions
         (mission_id, sequence, from_state, to_state, from_revision, to_revision, reason, actor_json, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.missionId,
        sequence,
        input.fromState,
        input.toState,
        input.fromRevision,
        input.toRevision,
        input.reason,
        canonicalJson(input.actor),
        input.occurredAt,
      ],
    );
  }
}
