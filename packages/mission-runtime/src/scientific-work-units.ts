/** Internal domain repository; callers use the public store facade. */
import {
  ScientificMissionSchema,
  ScientificPlanSchema,
  WorkUnitSchema,
  assertScientificTransition,
  canonicalJson,
  digestCanonical,
  type ScientificPlan,
  type WorkUnit,
  type WorkUnitState,
} from "@eigengrid/scientific-schema";
import { randomUUID } from "node:crypto";
import {
  ScientificEntityConflictError,
  ScientificIllegalTransitionError,
  ScientificIntegrityError,
  ScientificReconciliationRequiredError,
  ScientificRevisionConflictError,
} from "./errors";
import {
  assertMdWorkUnitProjectionBinding,
  assertMdWorkUnitProjectionDependencies,
  isCompletedMaterialPhaseDependency,
  persistMdWorkUnitCompletionGate,
  workUnitUsesMdExecutionBinding,
} from "./md-projection-store";
import { ScientificStoreContext } from "./scientific-store-context";
import {
  CLAIM_COMPATIBLE_MISSION_STATES,
  CLAIM_HOLDING_STATES,
  JsonRow,
  assertWorkUnitApprovalContract,
  exactPlanApprovalRole,
  legacyWorkUnitKind,
  parsePayload,
  requireTimestampOrder,
  unique,
} from "./scientific-store-validation";
import type { WorkUnitClaimResult } from "./types";
export class ScientificWorkUnits {
  constructor(private readonly context: ScientificStoreContext) {}

  // ── Work units, dependencies, and leased claims ──────────

  async createWorkUnits(workUnitInputs: WorkUnit[]): Promise<WorkUnit[]> {
    const workUnits = workUnitInputs.map((input) => WorkUnitSchema.parse(input));
    if (workUnits.length === 0) return [];
    const byId = new Map(workUnits.map((workUnit) => [workUnit.id, workUnit]));
    if (byId.size !== workUnits.length) {
      throw new ScientificIntegrityError("Work-unit batch contains duplicate identifiers");
    }
    this.assertAcyclicBatch(workUnits);

    return this.context.inTransaction("create work units", async (tx) => {
      for (const workUnit of workUnits) {
        if (workUnit.state !== "created" || workUnit.revision !== 1) {
          throw new ScientificIntegrityError("A new work unit must begin at created revision 1", {
            workUnitId: workUnit.id,
          });
        }
        if (workUnit.dependencies.length !== unique(workUnit.dependencies).length) {
          throw new ScientificIntegrityError("Work-unit dependencies must be unique", {
            workUnitId: workUnit.id,
          });
        }
        const planRow = await this.context.requiredRow<
          JsonRow & { mission_id: string; version: number }
        >(tx, "plan", workUnit.planId, "scientific_plans");
        const plan = parsePayload(ScientificPlanSchema, planRow, `plan ${workUnit.planId}`);
        if (
          String(planRow.mission_id) !== workUnit.missionId ||
          Number(planRow.version) !== workUnit.planVersion
        ) {
          throw new ScientificIntegrityError("Work unit does not match its exact plan version", {
            workUnitId: workUnit.id,
          });
        }
        assertWorkUnitApprovalContract(workUnit, plan);
        if (workUnit.protocolFragment.kind === "scientific_capability") {
          await assertMdWorkUnitProjectionBinding(tx, workUnit);
        } else if (
          !plan.protocol.engineAgnosticSteps.some(
            (fragment) => canonicalJson(fragment) === canonicalJson(workUnit.protocolFragment),
          )
        ) {
          throw new ScientificIntegrityError(
            "Work unit protocol fragment is outside the exact approved plan",
            { workUnitId: workUnit.id, planId: plan.id },
          );
        }
        this.assertWorkUnitSkillAttribution(workUnit, plan);

        await this.context.insertIdempotent(tx, {
          entity: "work unit",
          table: "scientific_work_units",
          id: workUnit.id,
          payload: canonicalJson(workUnit),
          columns: [
            "id",
            "mission_id",
            "plan_id",
            "plan_version",
            "kind",
            "capability_id",
            "state",
            "revision",
            "claim_owner",
            "claim_expires_at",
            "job_id",
            "attempt_id",
            "payload_digest",
            "payload_json",
            "created_at",
            "updated_at",
          ],
          values: [
            workUnit.id,
            workUnit.missionId,
            workUnit.planId,
            workUnit.planVersion,
            legacyWorkUnitKind(workUnit.kind),
            workUnit.executionPolicy.capability,
            workUnit.state,
            workUnit.revision,
            workUnit.claimOwner,
            workUnit.claimExpiresAt,
            workUnit.jobId,
            workUnit.attemptId,
            digestCanonical(workUnit),
            canonicalJson(workUnit),
            workUnit.createdAt,
            workUnit.updatedAt,
          ],
        });
      }

      for (const workUnit of workUnits) {
        await assertMdWorkUnitProjectionDependencies(tx, workUnit);
        for (const dependencyId of workUnit.dependencies) {
          const dependency = await this.context.requiredRow<
            JsonRow & { mission_id: string; plan_id: string }
          >(tx, "work-unit dependency", dependencyId, "scientific_work_units");
          let validPhaseDependency = false;
          if (
            String(dependency.mission_id) === workUnit.missionId &&
            String(dependency.plan_id) !== workUnit.planId
          ) {
            const planRow = await this.context.requiredRow<JsonRow>(
              tx,
              "material successor plan",
              workUnit.planId,
              "scientific_plans",
            );
            validPhaseDependency = isCompletedMaterialPhaseDependency(
              workUnit,
              parsePayload(WorkUnitSchema, dependency, `material predecessor ${dependencyId}`),
              parsePayload(ScientificPlanSchema, planRow, `material successor ${workUnit.planId}`),
            );
          }
          if (
            String(dependency.mission_id) !== workUnit.missionId ||
            (String(dependency.plan_id) !== workUnit.planId && !validPhaseDependency)
          ) {
            throw new ScientificIntegrityError(
              "Work-unit dependency crosses a mission or plan boundary",
              {
                workUnitId: workUnit.id,
                dependencyId,
              },
            );
          }
          await tx.query(
            `INSERT INTO scientific_work_unit_dependencies (work_unit_id, depends_on_work_unit_id)
             VALUES ($1, $2) ON CONFLICT (work_unit_id, depends_on_work_unit_id) DO NOTHING`,
            [workUnit.id, dependencyId],
          );
        }
        for (const evidenceId of workUnit.inputRefs) {
          const evidence = await this.context.requiredRow<{ mission_id: string }>(
            tx,
            "input evidence",
            evidenceId,
            "scientific_evidence",
          );
          if (String(evidence.mission_id) !== workUnit.missionId) {
            throw new ScientificIntegrityError(
              "Work-unit input evidence belongs to another mission",
              {
                workUnitId: workUnit.id,
                evidenceId,
              },
            );
          }
          await tx.query(
            `INSERT INTO scientific_work_unit_inputs (work_unit_id, evidence_id)
             VALUES ($1, $2) ON CONFLICT (work_unit_id, evidence_id) DO NOTHING`,
            [workUnit.id, evidenceId],
          );
        }
      }
      return workUnits;
    });
  }

  private assertAcyclicBatch(workUnits: WorkUnit[]): void {
    const ids = new Set(workUnits.map((workUnit) => workUnit.id));
    const graph = new Map(
      workUnits.map((workUnit) => [
        workUnit.id,
        workUnit.dependencies.filter((dependencyId) => ids.has(dependencyId)),
      ]),
    );
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new ScientificIntegrityError("Work-unit dependency graph contains a cycle", {
          workUnitId: id,
        });
      }
      visiting.add(id);
      for (const dependency of graph.get(id) ?? []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of ids) visit(id);
  }

  private assertWorkUnitSkillAttribution(workUnit: WorkUnit, plan: ScientificPlan): void {
    const selected = new Set(
      plan.skillResolution.selectedFragments.map((fragment) => canonicalJson(fragment)),
    );
    for (const reference of [...workUnit.skillRefs, ...workUnit.protocolFragment.sourceFragments]) {
      if (!selected.has(canonicalJson(reference))) {
        throw new ScientificIntegrityError(
          "Work unit cites a skill fragment outside the exact resolution",
          {
            workUnitId: workUnit.id,
            fragmentId: reference.fragmentId,
            fragmentDigest: reference.fragmentDigest,
          },
        );
      }
    }
  }

  async getWorkUnit(workUnitId: string): Promise<WorkUnit | null> {
    return this.context.inTransaction("get work unit", async (tx) => {
      const row = await this.context.one<JsonRow>(
        tx,
        "SELECT payload_json FROM scientific_work_units WHERE id = $1",
        [workUnitId],
      );
      return row ? parsePayload(WorkUnitSchema, row, `work unit ${workUnitId}`) : null;
    });
  }

  async listWorkUnits(missionId: string): Promise<WorkUnit[]> {
    return this.context.inTransaction("list work units", async (tx) => {
      const rows = await tx.queryRows<JsonRow>(
        "SELECT payload_json FROM scientific_work_units WHERE mission_id = $1 ORDER BY created_at, id",
        [missionId],
      );
      return rows.map((row) => parsePayload(WorkUnitSchema, row, "work unit"));
    });
  }

  async listRunnableWorkUnits(missionId: string, now: string): Promise<WorkUnit[]> {
    return this.context.inTransaction("list runnable work units", async (tx) => {
      const rows = await tx.queryRows<JsonRow>(
        `SELECT wu.payload_json FROM scientific_work_units wu
         WHERE wu.mission_id = $1
           AND (
             wu.state = 'ready'
             OR (
               wu.state = 'claimed' AND wu.claim_expires_at IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM scientific_external_operations external_op
                 WHERE external_op.work_unit_id = wu.id AND external_op.state <> 'intent'
               )
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM scientific_work_unit_dependencies d
             JOIN scientific_work_units dependency ON dependency.id = d.depends_on_work_unit_id
             WHERE d.work_unit_id = wu.id AND dependency.state <> 'succeeded'
         )
         ORDER BY wu.created_at, wu.id`,
        [missionId],
      );
      const instant = Date.parse(now);
      if (!Number.isFinite(instant)) throw new TypeError("Runnable-work-unit clock is invalid");
      return rows
        .map((row) => parsePayload(WorkUnitSchema, row, "runnable work unit"))
        .filter(
          (workUnit) =>
            workUnit.state === "ready" ||
            (workUnit.claimExpiresAt !== null && Date.parse(workUnit.claimExpiresAt) <= instant),
        );
    });
  }

  async transitionWorkUnit(input: {
    workUnitId: string;
    expectedRevision: number;
    to: WorkUnitState;
    at: string;
    claimOwner?: string;
    jobId?: string | null;
    attemptId?: string | null;
  }): Promise<WorkUnit> {
    if (input.to === "claimed") {
      throw new ScientificIntegrityError("Work units may enter claimed only through claimWorkUnit");
    }
    return this.context.inTransaction("transition work unit", async (tx) => {
      const row = await this.context.requiredRow<JsonRow>(
        tx,
        "work unit",
        input.workUnitId,
        "scientific_work_units",
      );
      const current = parsePayload(WorkUnitSchema, row, `work unit ${input.workUnitId}`);
      if (current.revision !== input.expectedRevision) {
        throw new ScientificRevisionConflictError(
          "work unit",
          current.id,
          input.expectedRevision,
          current.revision,
        );
      }
      if (input.to === "succeeded" && workUnitUsesMdExecutionBinding(current)) {
        throw new ScientificIntegrityError(
          "MD WorkUnits may become succeeded only through completeMdWorkUnit",
          { workUnitId: current.id },
        );
      }
      if (
        CLAIM_HOLDING_STATES.has(current.state) &&
        current.claimOwner &&
        input.claimOwner !== current.claimOwner
      ) {
        throw new ScientificEntityConflictError(
          "work-unit claim",
          current.id,
          "claim owner mismatch",
        );
      }
      if (
        CLAIM_HOLDING_STATES.has(input.to) &&
        current.claimExpiresAt &&
        Date.parse(current.claimExpiresAt) <= Date.parse(input.at)
      ) {
        throw new ScientificReconciliationRequiredError(current.id, current.state);
      }
      try {
        assertScientificTransition("work_unit", current.state, input.to);
      } catch {
        throw new ScientificIllegalTransitionError(
          "work unit",
          current.id,
          current.state,
          input.to,
        );
      }
      const releasesClaim = !CLAIM_HOLDING_STATES.has(input.to);
      const next = WorkUnitSchema.parse({
        ...current,
        state: input.to,
        revision: current.revision + 1,
        claimOwner: releasesClaim ? null : current.claimOwner,
        claimExpiresAt: releasesClaim ? null : current.claimExpiresAt,
        jobId: input.jobId === undefined ? current.jobId : input.jobId,
        attemptId: input.attemptId === undefined ? current.attemptId : input.attemptId,
        updatedAt: input.at,
      });
      const updated = await tx.queryRows<{ id: string }>(
        `UPDATE scientific_work_units
         SET state = $1, revision = $2, claim_owner = $3, claim_expires_at = $4,
             job_id = $5, attempt_id = $6, payload_digest = $7, payload_json = $8, updated_at = $9
         WHERE id = $10 AND revision = $11 AND state = $12 RETURNING id`,
        [
          next.state,
          next.revision,
          next.claimOwner,
          next.claimExpiresAt,
          next.jobId,
          next.attemptId,
          digestCanonical(next),
          canonicalJson(next),
          next.updatedAt,
          next.id,
          current.revision,
          current.state,
        ],
      );
      if (updated.length === 0) {
        throw new ScientificRevisionConflictError(
          "work unit",
          current.id,
          input.expectedRevision,
          current.revision + 1,
        );
      }
      if (releasesClaim && current.claimOwner) {
        await tx.query(
          `UPDATE scientific_work_unit_claims
           SET active = $1, released_at = $2, release_reason = $3
           WHERE work_unit_id = $4 AND active = $5 AND owner_id = $6`,
          [false, input.at, `state:${input.to}`, current.id, true, current.claimOwner],
        );
      }
      return next;
    });
  }

  async completeMdWorkUnit(input: {
    workUnitId: string;
    expectedRevision: number;
    stageResultId: string;
    stageResultDigest: string;
    assessmentId: string;
    assessmentRevision: number;
    assessmentDigest: string;
    at: string;
    claimOwner?: string;
  }): Promise<WorkUnit> {
    return this.context.inTransaction("complete MD work unit", async (tx) => {
      const row = await this.context.requiredRow<JsonRow>(
        tx,
        "work unit",
        input.workUnitId,
        "scientific_work_units",
        true,
      );
      const current = parsePayload(WorkUnitSchema, row, `work unit ${input.workUnitId}`);
      if (current.revision !== input.expectedRevision) {
        throw new ScientificRevisionConflictError(
          "work unit",
          current.id,
          input.expectedRevision,
          current.revision,
        );
      }
      if (!workUnitUsesMdExecutionBinding(current)) {
        throw new ScientificIntegrityError("WorkUnit does not use the MD execution contract", {
          workUnitId: current.id,
        });
      }
      if (current.claimOwner && input.claimOwner !== current.claimOwner) {
        throw new ScientificEntityConflictError(
          "work-unit claim",
          current.id,
          "claim owner mismatch",
        );
      }
      if (
        current.claimExpiresAt === null ||
        Date.parse(current.claimExpiresAt) <= Date.parse(input.at)
      ) {
        throw new ScientificReconciliationRequiredError(current.id, current.state);
      }
      try {
        assertScientificTransition("work_unit", current.state, "succeeded");
      } catch {
        throw new ScientificIllegalTransitionError(
          "work unit",
          current.id,
          current.state,
          "succeeded",
        );
      }

      await persistMdWorkUnitCompletionGate(tx, this.context.database._provider, current, {
        stageResultId: input.stageResultId,
        stageResultDigest: input.stageResultDigest,
        assessmentId: input.assessmentId,
        assessmentRevision: input.assessmentRevision,
        assessmentDigest: input.assessmentDigest,
        completedAt: input.at,
      });

      const next = WorkUnitSchema.parse({
        ...current,
        state: "succeeded" as const,
        revision: current.revision + 1,
        claimOwner: null,
        claimExpiresAt: null,
        updatedAt: input.at,
      });
      const updated = await tx.queryRows<{ id: string }>(
        `UPDATE scientific_work_units
         SET state = $1, revision = $2, claim_owner = NULL, claim_expires_at = NULL,
             payload_digest = $3, payload_json = $4, updated_at = $5
         WHERE id = $6 AND revision = $7 AND state = $8 RETURNING id`,
        [
          next.state,
          next.revision,
          digestCanonical(next),
          canonicalJson(next),
          next.updatedAt,
          next.id,
          current.revision,
          current.state,
        ],
      );
      if (updated.length !== 1) {
        throw new ScientificRevisionConflictError(
          "work unit",
          current.id,
          input.expectedRevision,
          current.revision + 1,
        );
      }
      if (current.claimOwner) {
        await tx.query(
          `UPDATE scientific_work_unit_claims
           SET active = $1, released_at = $2, release_reason = $3
           WHERE work_unit_id = $4 AND active = $5 AND owner_id = $6`,
          [false, input.at, "state:succeeded", current.id, true, current.claimOwner],
        );
      }
      return next;
    });
  }

  async claimWorkUnit(input: {
    workUnitId: string;
    ownerId: string;
    now: string;
    expiresAt: string;
    claimId?: string;
    policyDigest?: string;
  }): Promise<WorkUnitClaimResult> {
    requireTimestampOrder(input.now, input.expiresAt, "Claim expiration");
    return this.context.inTransaction("claim work unit", async (tx) => {
      const row = await this.context.requiredRow<JsonRow>(
        tx,
        "work unit",
        input.workUnitId,
        "scientific_work_units",
      );
      let current = parsePayload(WorkUnitSchema, row, `work unit ${input.workUnitId}`);

      if (CLAIM_HOLDING_STATES.has(current.state) && current.claimExpiresAt) {
        if (Date.parse(current.claimExpiresAt) > Date.parse(input.now)) {
          return {
            claimed: false,
            reason: "lease_active",
            message: `Work unit is leased by ${current.claimOwner ?? "another owner"}`,
            workUnit: current,
          };
        }
        if (current.state !== "claimed") {
          return {
            claimed: false,
            reason: "reconciliation_required",
            message: "An expired lease after execution began requires explicit reconciliation",
            workUnit: current,
          };
        }
        const recovered = WorkUnitSchema.parse({
          ...current,
          state: "ready",
          revision: current.revision + 1,
          claimOwner: null,
          claimExpiresAt: null,
          updatedAt: input.now,
        });
        const recoveredRows = await tx.queryRows<{ id: string }>(
          `UPDATE scientific_work_units
           SET state = 'ready', revision = $1, claim_owner = NULL, claim_expires_at = NULL,
               payload_digest = $2, payload_json = $3, updated_at = $4
           WHERE id = $5 AND revision = $6 AND state = 'claimed' RETURNING id`,
          [
            recovered.revision,
            digestCanonical(recovered),
            canonicalJson(recovered),
            recovered.updatedAt,
            recovered.id,
            current.revision,
          ],
        );
        if (recoveredRows.length === 0) {
          return {
            claimed: false,
            reason: "lost_race",
            message: "Lease recovery lost a concurrent race",
          };
        }
        await tx.query(
          `UPDATE scientific_work_unit_claims SET active = $1, released_at = $2,
             release_reason = 'lease_expired_before_effect'
           WHERE work_unit_id = $3 AND active = $4`,
          [false, input.now, current.id, true],
        );
        current = recovered;
      }

      if (current.state !== "ready") {
        return {
          claimed: false,
          reason: "not_ready",
          message: `Work unit is ${current.state}, not ready`,
          workUnit: current,
        };
      }
      const missionRow = await this.context.requiredRow<JsonRow>(
        tx,
        "mission",
        current.missionId,
        "scientific_missions",
      );
      const mission = parsePayload(
        ScientificMissionSchema,
        missionRow,
        `mission ${current.missionId}`,
      );
      if (!CLAIM_COMPATIBLE_MISSION_STATES.has(mission.state)) {
        return {
          claimed: false,
          reason: "incompatible_mission",
          message: `Mission state ${mission.state} does not permit claims`,
          workUnit: current,
        };
      }
      if (mission.activePlanId !== current.planId) {
        return {
          claimed: false,
          reason: "incompatible_mission",
          message: "Work unit does not belong to the active plan",
          workUnit: current,
        };
      }
      const blocked = await this.context.one<{ dependency_id: string }>(
        tx,
        `SELECT dependency.id AS dependency_id
         FROM scientific_work_unit_dependencies edge
         JOIN scientific_work_units dependency ON dependency.id = edge.depends_on_work_unit_id
         WHERE edge.work_unit_id = $1 AND dependency.state <> 'succeeded' LIMIT 1`,
        [current.id],
      );
      if (blocked) {
        return {
          claimed: false,
          reason: "dependency_blocked",
          message: `Dependency ${String(blocked.dependency_id)} has not succeeded`,
          workUnit: current,
        };
      }

      const planRow = await this.context.requiredRow<
        JsonRow & {
          status: string;
          revision: number;
          version: number;
          plan_digest: string;
        }
      >(tx, "plan", current.planId, "scientific_plans");
      if (String(planRow.status) !== "approved") {
        return {
          claimed: false,
          reason: "approval_required",
          message: "Exact plan version is not approved",
          workUnit: current,
        };
      }
      const plan = parsePayload(ScientificPlanSchema, planRow, `plan ${current.planId}`);
      let requiredApprovalRole: string;
      try {
        requiredApprovalRole = exactPlanApprovalRole(plan);
        assertWorkUnitApprovalContract(current, plan);
      } catch (error) {
        return {
          claimed: false,
          reason: "approval_required",
          message: error instanceof Error ? error.message : String(error),
          workUnit: current,
        };
      }
      if (current.approvalPolicy.required) {
        if (!input.policyDigest) {
          return {
            claimed: false,
            reason: "approval_required",
            message: "A current policy digest is required for this work unit",
            workUnit: current,
          };
        }
        const approval = await this.context.one<{ id: string; expires_at: string | null }>(
          tx,
          `SELECT id, expires_at FROM scientific_approval_requests
           WHERE subject_type = 'plan' AND subject_id = $1 AND subject_version = $2
             AND subject_revision = $3 AND payload_digest = $4 AND policy_digest = $5
             AND requested_from_role = $6 AND state = 'approved'
           ORDER BY requested_at DESC LIMIT 1`,
          [
            current.planId,
            Number(planRow.version),
            Number(planRow.revision),
            String(planRow.plan_digest),
            input.policyDigest,
            requiredApprovalRole,
          ],
        );
        if (
          !approval ||
          (approval.expires_at && Date.parse(approval.expires_at) <= Date.parse(input.now))
        ) {
          return {
            claimed: false,
            reason: "approval_required",
            message: "No current exact-revision approval authorizes this work unit",
            workUnit: current,
          };
        }
      }

      const claimed = WorkUnitSchema.parse({
        ...current,
        state: "claimed",
        revision: current.revision + 1,
        claimOwner: input.ownerId,
        claimExpiresAt: input.expiresAt,
        updatedAt: input.now,
      });
      const won = await tx.queryRows<{ id: string }>(
        `UPDATE scientific_work_units
         SET state = 'claimed', revision = $1, claim_owner = $2, claim_expires_at = $3,
             payload_digest = $4, payload_json = $5, updated_at = $6
         WHERE id = $7 AND revision = $8 AND state = 'ready' RETURNING id`,
        [
          claimed.revision,
          claimed.claimOwner,
          claimed.claimExpiresAt,
          digestCanonical(claimed),
          canonicalJson(claimed),
          claimed.updatedAt,
          claimed.id,
          current.revision,
        ],
      );
      if (won.length === 0) {
        return {
          claimed: false,
          reason: "lost_race",
          message: "Another mission owner won the claim",
        };
      }
      const claimId = input.claimId ?? `claim-${randomUUID()}`;
      await tx.query(
        `INSERT INTO scientific_work_unit_claims
           (id, work_unit_id, owner_id, acquired_at, expires_at, active)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [claimId, claimed.id, input.ownerId, input.now, input.expiresAt, true],
      );
      return {
        claimed: true,
        claimId,
        workUnit: claimed,
        ownerId: input.ownerId,
        expiresAt: input.expiresAt,
      };
    });
  }

  async renewWorkUnitClaim(input: {
    workUnitId: string;
    claimId: string;
    ownerId: string;
    expectedRevision?: number;
    now: string;
    expiresAt: string;
  }): Promise<WorkUnit> {
    requireTimestampOrder(input.now, input.expiresAt, "Claim expiration");
    return this.context.inTransaction("renew work-unit claim", async (tx) => {
      const row = await this.context.requiredRow<JsonRow>(
        tx,
        "work unit",
        input.workUnitId,
        "scientific_work_units",
      );
      const current = parsePayload(WorkUnitSchema, row, `work unit ${input.workUnitId}`);
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
        throw new ScientificRevisionConflictError(
          "work unit",
          current.id,
          input.expectedRevision,
          current.revision,
        );
      }
      if (!CLAIM_HOLDING_STATES.has(current.state) || current.claimOwner !== input.ownerId) {
        throw new ScientificEntityConflictError(
          "work-unit claim",
          current.id,
          "claim owner mismatch",
        );
      }
      const claim = await this.context.one<{ id: string }>(
        tx,
        `SELECT id FROM scientific_work_unit_claims
         WHERE id = $1 AND work_unit_id = $2 AND owner_id = $3 AND active = $4`,
        [input.claimId, current.id, input.ownerId, true],
      );
      if (!claim) {
        throw new ScientificEntityConflictError(
          "work-unit claim",
          current.id,
          "claim identity is not active",
        );
      }
      if (!current.claimExpiresAt || Date.parse(current.claimExpiresAt) <= Date.parse(input.now)) {
        throw new ScientificEntityConflictError(
          "work-unit claim",
          current.id,
          "lease already expired",
        );
      }
      const next = WorkUnitSchema.parse({
        ...current,
        revision: current.revision + 1,
        claimExpiresAt: input.expiresAt,
        updatedAt: input.now,
      });
      const updated = await tx.queryRows<{ id: string }>(
        `UPDATE scientific_work_units SET revision = $1, claim_expires_at = $2,
           payload_digest = $3, payload_json = $4, updated_at = $5
         WHERE id = $6 AND revision = $7 AND claim_owner = $8 RETURNING id`,
        [
          next.revision,
          next.claimExpiresAt,
          digestCanonical(next),
          canonicalJson(next),
          next.updatedAt,
          next.id,
          current.revision,
          input.ownerId,
        ],
      );
      if (updated.length === 0) {
        throw new ScientificRevisionConflictError(
          "work unit",
          current.id,
          input.expectedRevision ?? current.revision,
          current.revision + 1,
        );
      }
      await tx.query(
        `UPDATE scientific_work_unit_claims SET expires_at = $1
         WHERE id = $2 AND work_unit_id = $3 AND owner_id = $4 AND active = $5`,
        [input.expiresAt, input.claimId, current.id, input.ownerId, true],
      );
      return next;
    });
  }
}
