/** Internal domain repository; callers use the public store facade. */
import {
  PlanningClaimSchema,
  ResolvedSkillGraphSchema,
  ScientificMissionSchema,
  ScientificPlanSchema,
  assertScientificTransition,
  canonicalJson,
  digestCanonical,
  type PlanStatus,
  type PlanningClaim,
  type ResolvedSkillGraph,
  type ScientificPlan,
} from "@eigengrid/scientific-schema";
import { randomUUID } from "node:crypto";
import {
  ScientificDigestMismatchError,
  ScientificEntityConflictError,
  ScientificEntityNotFoundError,
  ScientificIllegalTransitionError,
  ScientificIntegrityError,
  ScientificRevisionConflictError,
} from "./errors";
import { ScientificStoreContext } from "./scientific-store-context";
import {
  JsonRow,
  assertEmbeddedDigest,
  computeSkillGraphDigest,
  exactPlanApprovalRole,
  parsePayload,
  requireTimestampOrder,
} from "./scientific-store-validation";
import type { PlanningClaimResult, ScientificTransaction } from "./types";
export class ScientificPlans {
  constructor(private readonly context: ScientificStoreContext) {}

  private validatePlanDigests(plan: ScientificPlan): void {
    const expectedGraphDigest = computeSkillGraphDigest(plan.skillResolution);
    if (plan.skillResolution.graphDigest !== expectedGraphDigest) {
      throw new ScientificDigestMismatchError(
        "resolved skill graph",
        expectedGraphDigest,
        plan.skillResolution.graphDigest,
      );
    }
    assertEmbeddedDigest("scientific protocol", plan.protocol, "protocolDigest");
    const { planDigest, status: _status, updatedAt: _updatedAt, ...immutablePlan } = plan;
    const expectedPlanDigest = digestCanonical(immutablePlan);
    if (planDigest !== expectedPlanDigest) {
      throw new ScientificDigestMismatchError("scientific plan", expectedPlanDigest, planDigest);
    }
    if (plan.protocol.skillGraphDigest !== plan.skillResolution.graphDigest) {
      throw new ScientificDigestMismatchError(
        "protocol skill graph",
        plan.skillResolution.graphDigest,
        plan.protocol.skillGraphDigest,
      );
    }
  }

  /** Acquires one durable planner lease for an exact mission revision. */
  async acquirePlanningClaim(input: {
    missionId: string;
    expectedMissionRevision: number;
    parentPlanId?: string;
    proposedNextVersion: number;
    ownerId: string;
    now: string;
    expiresAt: string;
    claimId?: string;
  }): Promise<PlanningClaimResult> {
    requireTimestampOrder(input.now, input.expiresAt, "Planning claim expiration");
    return this.context.inTransaction("acquire planning claim", async (tx) => {
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
      if (mission.revision !== input.expectedMissionRevision) {
        return {
          claimed: false,
          reason: "stale_revision",
          message: `Mission revision is ${mission.revision}, expected ${input.expectedMissionRevision}`,
        };
      }
      const latest = await this.context.one<{ id: string; version: number }>(
        tx,
        "SELECT id, version FROM scientific_plans WHERE mission_id = $1 ORDER BY version DESC LIMIT 1",
        [input.missionId],
      );
      if ((latest?.id ?? undefined) !== input.parentPlanId) {
        return {
          claimed: false,
          reason: "stale_parent",
          message: `Planning parent is stale; current parent is ${latest?.id ?? "none"}`,
        };
      }
      const activeRow = await this.context.one<JsonRow>(
        tx,
        `SELECT payload_json FROM scientific_planning_claims
         WHERE mission_id = $1 AND expected_mission_revision = $2 AND status = 'active'`,
        [input.missionId, input.expectedMissionRevision],
      );
      if (activeRow) {
        const active = PlanningClaimSchema.parse(JSON.parse(String(activeRow.payload_json)));
        if (Date.parse(active.expiresAt) > Date.parse(input.now)) {
          return {
            claimed: false,
            reason: "active",
            message: `Planning claim ${active.id} is active until ${active.expiresAt}`,
            claim: active,
          };
        }
        const expired = PlanningClaimSchema.parse({
          ...active,
          status: "expired" as const,
          releasedAt: input.now,
          releaseReason: "lease_expired_before_plan_persistence",
        });
        await tx.query(
          `UPDATE scientific_planning_claims
           SET status = $1, released_at = $2, release_reason = $3, payload_json = $4
           WHERE id = $5 AND status = $6`,
          [
            expired.status,
            expired.releasedAt,
            expired.releaseReason,
            JSON.stringify(expired),
            expired.id,
            "active",
          ],
        );
      }
      const claim = PlanningClaimSchema.parse({
        id: input.claimId ?? `planning-claim-${randomUUID()}`,
        missionId: input.missionId,
        expectedMissionRevision: input.expectedMissionRevision,
        ...(input.parentPlanId ? { parentPlanId: input.parentPlanId } : {}),
        proposedNextVersion: input.proposedNextVersion,
        ownerId: input.ownerId,
        acquiredAt: input.now,
        expiresAt: input.expiresAt,
        status: "active",
      });
      await tx.query(
        `INSERT INTO scientific_planning_claims
           (id, mission_id, expected_mission_revision, parent_plan_id, proposed_next_version,
            owner_id, acquired_at, expires_at, status, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          claim.id,
          claim.missionId,
          claim.expectedMissionRevision,
          claim.parentPlanId ?? null,
          claim.proposedNextVersion,
          claim.ownerId,
          claim.acquiredAt,
          claim.expiresAt,
          claim.status,
          canonicalJson(claim),
        ],
      );
      return { claimed: true, claim };
    });
  }

  /** Renews an active planner lease with an exact claim identity and expiry CAS. */
  async renewPlanningClaim(input: {
    claimId: string;
    missionId: string;
    ownerId: string;
    now: string;
    expiresAt: string;
  }): Promise<PlanningClaim> {
    requireTimestampOrder(input.now, input.expiresAt, "Planning claim expiration");
    return this.context.inTransaction("renew planning claim", async (tx) => {
      const row = await this.context.one<JsonRow>(
        tx,
        `SELECT payload_json FROM scientific_planning_claims WHERE id = $1${
          this.context.database._provider === "postgres" ? " FOR UPDATE" : ""
        }`,
        [input.claimId],
      );
      if (!row) throw new ScientificEntityNotFoundError("planning claim", input.claimId);
      const current = PlanningClaimSchema.parse(JSON.parse(String(row.payload_json)));
      if (current.missionId !== input.missionId || current.ownerId !== input.ownerId) {
        throw new ScientificEntityConflictError(
          "planning claim",
          current.id,
          "claim identity or owner mismatch",
        );
      }
      if (current.status !== "active") {
        throw new ScientificEntityConflictError(
          "planning claim",
          current.id,
          "claim is no longer active",
        );
      }
      if (Date.parse(current.expiresAt) <= Date.parse(input.now)) {
        throw new ScientificEntityConflictError(
          "planning claim",
          current.id,
          "lease already expired",
        );
      }
      const next = PlanningClaimSchema.parse({ ...current, expiresAt: input.expiresAt });
      const updated = await tx.queryRows<{ id: string }>(
        `UPDATE scientific_planning_claims
         SET expires_at = $1, payload_json = $2
         WHERE id = $3 AND mission_id = $4 AND owner_id = $5 AND status = $6 AND expires_at = $7
         RETURNING id`,
        [
          next.expiresAt,
          canonicalJson(next),
          next.id,
          next.missionId,
          next.ownerId,
          "active",
          current.expiresAt,
        ],
      );
      if (updated.length !== 1) {
        throw new ScientificRevisionConflictError(
          "planning claim",
          current.id,
          Date.parse(current.expiresAt),
          Date.parse(input.expiresAt),
        );
      }
      return next;
    });
  }

  async releasePlanningClaim(input: {
    claimId: string;
    ownerId: string;
    at: string;
    status: "completed" | "released";
    reason: string;
  }): Promise<PlanningClaim> {
    return this.context.inTransaction("release planning claim", async (tx) => {
      const row = await this.context.one<JsonRow>(
        tx,
        "SELECT payload_json FROM scientific_planning_claims WHERE id = $1",
        [input.claimId],
      );
      if (!row) throw new ScientificEntityNotFoundError("planning claim", input.claimId);
      const current = PlanningClaimSchema.parse(JSON.parse(String(row.payload_json)));
      if (current.ownerId !== input.ownerId) {
        throw new ScientificEntityConflictError("planning claim", current.id, "owner mismatch");
      }
      if (current.status !== "active") return current;
      const next = PlanningClaimSchema.parse({
        ...current,
        status: input.status,
        releasedAt: input.at,
        releaseReason: input.reason,
      });
      await tx.query(
        `UPDATE scientific_planning_claims
         SET status = $1, released_at = $2, release_reason = $3, payload_json = $4
         WHERE id = $5 AND owner_id = $6 AND status = $7`,
        [
          next.status,
          next.releasedAt,
          next.releaseReason,
          canonicalJson(next),
          next.id,
          input.ownerId,
          "active",
        ],
      );
      return next;
    });
  }

  // ── Skill resolutions and plans ──────────────────────────

  async createSkillResolution(graphInput: ResolvedSkillGraph): Promise<ResolvedSkillGraph> {
    const graph = ResolvedSkillGraphSchema.parse(graphInput);
    const expected = computeSkillGraphDigest(graph);
    if (graph.graphDigest !== expected) {
      throw new ScientificDigestMismatchError("resolved skill graph", expected, graph.graphDigest);
    }
    return this.context.inTransaction("create skill resolution", async (tx) => {
      await this.insertSkillResolution(tx, graph);
      return graph;
    });
  }

  private async insertSkillResolution(
    tx: ScientificTransaction,
    graph: ResolvedSkillGraph,
  ): Promise<boolean> {
    await this.context.requiredRow(tx, "mission", graph.missionId, "scientific_missions");
    return this.context.insertIdempotent(tx, {
      entity: "skill resolution",
      table: "scientific_skill_resolutions",
      id: graph.id,
      payload: canonicalJson(graph),
      columns: [
        "id",
        "mission_id",
        "graph_digest",
        "resolver_version",
        "environment_digest",
        "payload_json",
        "resolved_at",
      ],
      values: [
        graph.id,
        graph.missionId,
        graph.graphDigest,
        graph.resolverVersion,
        graph.environmentDigest,
        canonicalJson(graph),
        graph.resolvedAt,
      ],
    });
  }

  async createPlan(planInput: ScientificPlan): Promise<ScientificPlan> {
    const plan = ScientificPlanSchema.parse(planInput);
    this.validatePlanDigests(plan);
    exactPlanApprovalRole(plan);
    if (plan.revision !== 1 || !["draft", "under_review"].includes(plan.status)) {
      throw new ScientificIntegrityError(
        "A new scientific plan must begin at revision 1 as draft or under review",
      );
    }
    return this.context.inTransaction("create scientific plan", async (tx) => {
      await this.context.requiredRow(tx, "mission", plan.missionId, "scientific_missions");
      if (plan.skillResolution.missionId !== plan.missionId) {
        throw new ScientificIntegrityError(
          "Plan and skill resolution belong to different missions",
        );
      }
      await this.insertSkillResolution(tx, plan.skillResolution);
      if (plan.parentPlanId) {
        const parent = await this.context.requiredRow<{ mission_id: string; version: number }>(
          tx,
          "parent plan",
          plan.parentPlanId,
          "scientific_plans",
        );
        if (
          String(parent.mission_id) !== plan.missionId ||
          Number(parent.version) >= plan.version
        ) {
          throw new ScientificIntegrityError(
            "Parent plan must be an older version in the same mission",
          );
        }
      }
      await this.context.insertIdempotent(tx, {
        entity: "scientific plan",
        table: "scientific_plans",
        id: plan.id,
        payload: canonicalJson(plan),
        columns: [
          "id",
          "mission_id",
          "version",
          "revision",
          "status",
          "skill_resolution_id",
          "skill_graph_digest",
          "protocol_digest",
          "plan_digest",
          "parent_plan_id",
          "payload_json",
          "created_at",
          "updated_at",
        ],
        values: [
          plan.id,
          plan.missionId,
          plan.version,
          plan.revision,
          plan.status,
          plan.skillResolution.id,
          plan.skillResolution.graphDigest,
          plan.protocol.protocolDigest,
          plan.planDigest,
          plan.parentPlanId ?? null,
          canonicalJson(plan),
          plan.createdAt,
          plan.updatedAt,
        ],
      });
      return plan;
    });
  }

  async getPlan(planId: string): Promise<ScientificPlan | null> {
    return this.context.inTransaction("get scientific plan", async (tx) => {
      const row = await this.context.one<JsonRow>(
        tx,
        "SELECT payload_json FROM scientific_plans WHERE id = $1",
        [planId],
      );
      return row ? parsePayload(ScientificPlanSchema, row, `plan ${planId}`) : null;
    });
  }

  async listPlans(missionId: string): Promise<ScientificPlan[]> {
    return this.context.inTransaction("list scientific plans", async (tx) => {
      const rows = await tx.queryRows<JsonRow>(
        "SELECT payload_json FROM scientific_plans WHERE mission_id = $1 ORDER BY version, id",
        [missionId],
      );
      return rows.map((row) => parsePayload(ScientificPlanSchema, row, "scientific plan"));
    });
  }

  /** Plan status is lifecycle metadata; its immutable content revision and digest do not change. */
  async transitionPlan(input: {
    planId: string;
    expectedRevision: number;
    from: PlanStatus;
    to: PlanStatus;
    at: string;
  }): Promise<ScientificPlan> {
    if (input.to === "approved" || input.to === "rejected") {
      throw new ScientificIntegrityError(
        "Plans may be approved or rejected only through an exact durable approval response",
        { planId: input.planId, targetStatus: input.to },
      );
    }
    return this.context.inTransaction("transition scientific plan", async (tx) => {
      const row = await this.context.requiredRow<JsonRow>(
        tx,
        "plan",
        input.planId,
        "scientific_plans",
      );
      const current = parsePayload(ScientificPlanSchema, row, `plan ${input.planId}`);
      if (current.revision !== input.expectedRevision) {
        throw new ScientificRevisionConflictError(
          "plan",
          current.id,
          input.expectedRevision,
          current.revision,
        );
      }
      if (current.status !== input.from) {
        throw new ScientificIllegalTransitionError("plan", current.id, current.status, input.to);
      }
      try {
        assertScientificTransition("plan", current.status, input.to);
      } catch {
        throw new ScientificIllegalTransitionError("plan", current.id, current.status, input.to);
      }
      const next = ScientificPlanSchema.parse({
        ...current,
        status: input.to,
        updatedAt: input.at,
      });
      const updated = await tx.queryRows<{ id: string }>(
        `UPDATE scientific_plans SET status = $1, payload_json = $2, updated_at = $3
         WHERE id = $4 AND revision = $5 AND status = $6 RETURNING id`,
        [
          next.status,
          canonicalJson(next),
          next.updatedAt,
          next.id,
          current.revision,
          current.status,
        ],
      );
      if (updated.length === 0) {
        throw new ScientificEntityConflictError(
          "scientific plan",
          current.id,
          "status changed concurrently",
        );
      }
      return next;
    });
  }
}
