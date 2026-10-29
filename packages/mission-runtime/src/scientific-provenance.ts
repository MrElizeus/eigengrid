/** Internal domain repository; callers use the public store facade. */
import {
  ActorIdentitySchema,
  ApprovalRequestSchema,
  BudgetReservationSchema,
  CriticFindingSchema,
  EvidenceReferenceSchema,
  ExternalOperationSchema,
  MissionBudgetSchema,
  MissionCheckpointSchema,
  ModelInvocationIntentSchema,
  ModelInvocationRecordSchema,
  OperationReceiptSchema,
  PlanningClaimSchema,
  ResolvedSkillGraphSchema,
  ScientificAssessmentSchema,
  ScientificDecisionSchema,
  ScientificMissionSchema,
  ScientificObservationSchema,
  ScientificPlanSchema,
  ValidationResultSchema,
  WorkUnitSchema,
  type MissionState,
} from "@eigengrid/scientific-schema";
import { ScientificIntegrityError } from "./errors";
import { ScientificStoreContext } from "./scientific-store-context";
import { JsonRow, parseBoolean, parsePayload } from "./scientific-store-validation";
import type { MissionProvenance, MissionTransitionRecord, WorkUnitClaimRecord } from "./types";
export class ScientificProvenance {
  constructor(private readonly context: ScientificStoreContext) {}

  // ── Complete objective-to-assessment provenance ──────────

  async getMissionProvenance(missionId: string): Promise<MissionProvenance> {
    return this.context.inTransaction("get mission provenance", async (tx) => {
      const missionRow = await this.context.requiredRow<JsonRow>(
        tx,
        "mission",
        missionId,
        "scientific_missions",
      );
      const mission = parsePayload(ScientificMissionSchema, missionRow, `mission ${missionId}`);
      const budgetRow = await this.context.one<JsonRow>(
        tx,
        "SELECT payload_json FROM scientific_mission_budgets WHERE mission_id = $1",
        [missionId],
      );
      if (!budgetRow)
        throw new ScientificIntegrityError("Mission has no authoritative budget", { missionId });
      const budget = parsePayload(MissionBudgetSchema, budgetRow, `mission budget ${missionId}`);

      const [
        reservationRows,
        skillRows,
        planRows,
        workRows,
        claimRows,
        planningClaimRows,
        checkpointRows,
        decisionRows,
        approvalRows,
        operationRows,
        receiptRows,
        evidenceRows,
        observationRows,
        validationRows,
        modelRows,
        modelIntentRows,
        criticRows,
        assessmentRows,
        transitionRows,
      ] = [
        await tx.queryRows<JsonRow>(
          `SELECT r.payload_json FROM scientific_budget_reservations r
           JOIN scientific_mission_budgets b ON b.id = r.budget_id
           WHERE b.mission_id = $1 ORDER BY r.created_at, r.id`,
          [missionId],
        ),
        await tx.queryRows<JsonRow>(
          "SELECT payload_json FROM scientific_skill_resolutions WHERE mission_id = $1 ORDER BY resolved_at, id",
          [missionId],
        ),
        await tx.queryRows<JsonRow>(
          "SELECT payload_json FROM scientific_plans WHERE mission_id = $1 ORDER BY version, id",
          [missionId],
        ),
        await tx.queryRows<JsonRow>(
          "SELECT payload_json FROM scientific_work_units WHERE mission_id = $1 ORDER BY created_at, id",
          [missionId],
        ),
        await tx.queryRows<Record<string, unknown>>(
          `SELECT c.* FROM scientific_work_unit_claims c
           JOIN scientific_work_units wu ON wu.id = c.work_unit_id
           WHERE wu.mission_id = $1 ORDER BY c.acquired_at, c.id`,
          [missionId],
        ),
        await tx.queryRows<JsonRow>(
          "SELECT payload_json FROM scientific_planning_claims WHERE mission_id = $1 ORDER BY acquired_at, id",
          [missionId],
        ),
        await tx.queryRows<JsonRow>(
          "SELECT payload_json FROM scientific_checkpoints WHERE mission_id = $1 ORDER BY sequence",
          [missionId],
        ),
        await tx.queryRows<JsonRow>(
          "SELECT payload_json FROM scientific_decisions WHERE mission_id = $1 ORDER BY created_at, id",
          [missionId],
        ),
        await tx.queryRows<JsonRow>(
          "SELECT payload_json FROM scientific_approval_requests WHERE mission_id = $1 ORDER BY requested_at, id",
          [missionId],
        ),
        await tx.queryRows<JsonRow>(
          "SELECT payload_json FROM scientific_external_operations WHERE mission_id = $1 ORDER BY created_at, id",
          [missionId],
        ),
        await tx.queryRows<JsonRow>(
          `SELECT r.payload_json FROM scientific_operation_receipts r
           JOIN scientific_external_operations op ON op.id = r.operation_id
           WHERE op.mission_id = $1 ORDER BY r.recorded_at, r.id`,
          [missionId],
        ),
        await tx.queryRows<JsonRow>(
          "SELECT payload_json FROM scientific_evidence WHERE mission_id = $1 ORDER BY created_at, id",
          [missionId],
        ),
        await tx.queryRows<JsonRow>(
          "SELECT payload_json FROM scientific_observations WHERE mission_id = $1 ORDER BY observed_at, id",
          [missionId],
        ),
        await tx.queryRows<JsonRow>(
          "SELECT payload_json FROM scientific_validation_results WHERE mission_id = $1 ORDER BY created_at, id",
          [missionId],
        ),
        await tx.queryRows<JsonRow>(
          "SELECT payload_json FROM scientific_model_invocations WHERE mission_id = $1 ORDER BY started_at, id",
          [missionId],
        ),
        await tx.queryRows<JsonRow>(
          "SELECT payload_json FROM scientific_model_invocation_intents WHERE mission_id = $1 ORDER BY created_at, id",
          [missionId],
        ),
        await tx.queryRows<JsonRow>(
          "SELECT payload_json FROM scientific_critic_findings WHERE mission_id = $1 ORDER BY id",
          [missionId],
        ),
        await tx.queryRows<JsonRow>(
          "SELECT payload_json FROM scientific_assessments WHERE mission_id = $1 ORDER BY revision, id",
          [missionId],
        ),
        await tx.queryRows<Record<string, unknown>>(
          "SELECT * FROM scientific_mission_transitions WHERE mission_id = $1 ORDER BY sequence",
          [missionId],
        ),
      ] as const;

      const budgetReservations = reservationRows.map((row) =>
        parsePayload(BudgetReservationSchema, row, "budget reservation"),
      );
      const skillResolutions = skillRows.map((row) =>
        parsePayload(ResolvedSkillGraphSchema, row, "skill resolution"),
      );
      const plans = planRows.map((row) =>
        parsePayload(ScientificPlanSchema, row, "scientific plan"),
      );
      const workUnits = workRows.map((row) => parsePayload(WorkUnitSchema, row, "work unit"));
      const planningClaims = planningClaimRows.map((row) =>
        parsePayload(PlanningClaimSchema, row, "planning claim"),
      );
      const checkpoints = checkpointRows.map((row) =>
        parsePayload(MissionCheckpointSchema, row, "mission checkpoint"),
      );
      const decisions = decisionRows.map((row) =>
        parsePayload(ScientificDecisionSchema, row, "scientific decision"),
      );
      const approvals = approvalRows.map((row) =>
        parsePayload(ApprovalRequestSchema, row, "approval request"),
      );
      const operations = operationRows.map((row) =>
        parsePayload(ExternalOperationSchema, row, "external operation"),
      );
      const receipts = receiptRows.map((row) =>
        parsePayload(OperationReceiptSchema, row, "operation receipt"),
      );
      const evidence = evidenceRows.map((row) =>
        parsePayload(EvidenceReferenceSchema, row, "evidence reference"),
      );
      const observations = observationRows.map((row) =>
        parsePayload(ScientificObservationSchema, row, "scientific observation"),
      );
      const validations = validationRows.map((row) =>
        parsePayload(ValidationResultSchema, row, "validation result"),
      );
      const modelInvocations = modelRows.map((row) =>
        parsePayload(ModelInvocationRecordSchema, row, "model invocation"),
      );
      const modelInvocationIntents = modelIntentRows.map((row) =>
        parsePayload(ModelInvocationIntentSchema, row, "model invocation intent"),
      );
      const criticFindings = criticRows.map((row) =>
        parsePayload(CriticFindingSchema, row, "critic finding"),
      );
      const assessments = assessmentRows.map((row) =>
        parsePayload(ScientificAssessmentSchema, row, "scientific assessment"),
      );
      const workUnitClaims: WorkUnitClaimRecord[] = claimRows.map((row) => ({
        id: String(row.id),
        workUnitId: String(row.work_unit_id),
        ownerId: String(row.owner_id),
        acquiredAt: String(row.acquired_at),
        expiresAt: String(row.expires_at),
        ...(row.released_at == null ? {} : { releasedAt: String(row.released_at) }),
        ...(row.release_reason == null ? {} : { releaseReason: String(row.release_reason) }),
        active: parseBoolean(row.active),
      }));
      const transitions: MissionTransitionRecord[] = transitionRows.map((row) => {
        const actorResult = ActorIdentitySchema.safeParse(JSON.parse(String(row.actor_json)));
        if (!actorResult.success) {
          throw new ScientificIntegrityError("Mission transition contains an invalid actor", {
            sequence: Number(row.sequence),
          });
        }
        return {
          missionId: String(row.mission_id),
          sequence: Number(row.sequence),
          fromState: row.from_state == null ? null : (String(row.from_state) as MissionState),
          toState: String(row.to_state) as MissionState,
          fromRevision: Number(row.from_revision),
          toRevision: Number(row.to_revision),
          reason: String(row.reason),
          actor: actorResult.data,
          occurredAt: String(row.occurred_at),
        };
      });

      const missingReferences = this.findMissingProvenanceReferences({
        mission,
        budget,
        budgetReservations,
        skillResolutions,
        plans,
        workUnits,
        workUnitClaims,
        planningClaims,
        checkpoints,
        decisions,
        approvals,
        operations,
        receipts,
        evidence,
        observations,
        validations,
        modelInvocationIntents,
        modelInvocations,
        criticFindings,
        assessments,
        transitions,
        missingReferences: [],
        complete: false,
      });
      return {
        mission,
        budget,
        budgetReservations,
        skillResolutions,
        plans,
        workUnits,
        workUnitClaims,
        planningClaims,
        checkpoints,
        decisions,
        approvals,
        operations,
        receipts,
        evidence,
        observations,
        validations,
        modelInvocationIntents,
        modelInvocations,
        criticFindings,
        assessments,
        transitions,
        missingReferences,
        complete: assessments.length > 0 && missingReferences.length === 0,
      };
    });
  }

  private findMissingProvenanceReferences(provenance: MissionProvenance): string[] {
    const missing = new Set<string>();
    const evidenceIds = new Set(provenance.evidence.map((item) => item.id));
    const decisionIds = new Set(provenance.decisions.map((item) => item.id));
    const validationIds = new Set(provenance.validations.map((item) => item.id));
    const observationIds = new Set(provenance.observations.map((item) => item.id));
    const workUnitIds = new Set(provenance.workUnits.map((item) => item.id));
    const planIds = new Set(provenance.plans.map((item) => item.id));
    const receiptIds = new Set(provenance.receipts.map((item) => item.id));

    if (!evidenceIds.has(provenance.mission.objective.system.evidenceId)) {
      missing.add(`objective.evidence:${provenance.mission.objective.system.evidenceId}`);
    }
    if (provenance.mission.activePlanId && !planIds.has(provenance.mission.activePlanId)) {
      missing.add(`mission.activePlan:${provenance.mission.activePlanId}`);
    }
    for (const plan of provenance.plans) {
      if (!provenance.skillResolutions.some((graph) => graph.id === plan.skillResolution.id)) {
        missing.add(`plan.skillResolution:${plan.id}:${plan.skillResolution.id}`);
      }
      for (const decisionId of plan.protocol.decisions) {
        if (!decisionIds.has(decisionId)) missing.add(`plan.decision:${plan.id}:${decisionId}`);
      }
    }
    for (const workUnit of provenance.workUnits) {
      if (!planIds.has(workUnit.planId))
        missing.add(`workUnit.plan:${workUnit.id}:${workUnit.planId}`);
      for (const dependencyId of workUnit.dependencies) {
        if (!workUnitIds.has(dependencyId)) {
          missing.add(`workUnit.dependency:${workUnit.id}:${dependencyId}`);
        }
      }
      for (const evidenceId of workUnit.inputRefs) {
        if (!evidenceIds.has(evidenceId))
          missing.add(`workUnit.evidence:${workUnit.id}:${evidenceId}`);
      }
    }
    for (const decision of provenance.decisions) {
      for (const evidenceId of decision.evidenceRefs) {
        if (!evidenceIds.has(evidenceId))
          missing.add(`decision.evidence:${decision.id}:${evidenceId}`);
      }
    }
    for (const operation of provenance.operations) {
      if (!workUnitIds.has(operation.workUnitId)) {
        missing.add(`operation.workUnit:${operation.id}:${operation.workUnitId}`);
      }
      if (
        operation.state === "confirmed" &&
        (!operation.receiptId || !receiptIds.has(operation.receiptId))
      ) {
        missing.add(`operation.receipt:${operation.id}:${operation.receiptId ?? "missing"}`);
      }
    }
    for (const observation of provenance.observations) {
      for (const evidenceId of observation.evidenceRefs) {
        if (!evidenceIds.has(evidenceId)) {
          missing.add(`observation.evidence:${observation.id}:${evidenceId}`);
        }
      }
    }
    for (const validation of provenance.validations) {
      for (const observationId of validation.observationRefs) {
        if (!observationIds.has(observationId)) {
          missing.add(`validation.observation:${validation.id}:${observationId}`);
        }
      }
      for (const evidenceId of validation.evidenceRefs) {
        if (!evidenceIds.has(evidenceId)) {
          missing.add(`validation.evidence:${validation.id}:${evidenceId}`);
        }
      }
    }
    for (const assessment of provenance.assessments) {
      for (const decisionId of assessment.decisionRefs) {
        if (!decisionIds.has(decisionId)) {
          missing.add(`assessment.decision:${assessment.id}:${decisionId}`);
        }
      }
      for (const evidenceId of assessment.evidenceRefs) {
        if (!evidenceIds.has(evidenceId)) {
          missing.add(`assessment.evidence:${assessment.id}:${evidenceId}`);
        }
      }
      for (const validationId of assessment.validationRefs) {
        if (!validationIds.has(validationId)) {
          missing.add(`assessment.validation:${assessment.id}:${validationId}`);
        }
      }
    }
    return [...missing].sort();
  }
}
