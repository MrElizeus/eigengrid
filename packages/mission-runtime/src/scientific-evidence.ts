/** Internal domain repository; callers use the public store facade. */
import {
  CriticFindingSchema,
  EvidenceReferenceSchema,
  MissionCheckpointSchema,
  ModelInvocationRecordSchema,
  ResolvedSkillGraphSchema,
  ScientificAssessmentSchema,
  ScientificDecisionSchema,
  ScientificObservationSchema,
  ScientificPlanSchema,
  ValidationResultSchema,
  canonicalJson,
  digestCanonical,
  type CriticFinding,
  type EvidenceReference,
  type MissionCheckpoint,
  type ModelInvocationRecord,
  type ScientificAssessment,
  type ScientificDecision,
  type ScientificObservation,
  type ValidationResult,
} from "@eigengrid/scientific-schema";
import { ScientificIntegrityError } from "./errors";
import { ScientificStoreContext } from "./scientific-store-context";
import {
  JsonRow,
  legacyEvidenceKind,
  legacyModelRole,
  legacyObservationType,
  parsePayload,
  unique,
} from "./scientific-store-validation";
import type { ScientificTransaction } from "./types";
export class ScientificEvidence {
  constructor(private readonly context: ScientificStoreContext) {}

  // ── Evidence, checkpoints, and decisions ─────────────────

  async createEvidence(referenceInput: EvidenceReference): Promise<EvidenceReference> {
    const reference = EvidenceReferenceSchema.parse(referenceInput);
    if (!reference.immutable) {
      throw new ScientificIntegrityError("Authoritative scientific evidence must be immutable", {
        evidenceId: reference.id,
      });
    }
    return this.context.inTransaction("create evidence reference", async (tx) => {
      await this.context.requiredRow(tx, "mission", reference.missionId, "scientific_missions");
      if (reference.workUnitId) {
        const work = await this.context.requiredRow<{ mission_id: string }>(
          tx,
          "work unit",
          reference.workUnitId,
          "scientific_work_units",
        );
        if (String(work.mission_id) !== reference.missionId) {
          throw new ScientificIntegrityError("Evidence work unit belongs to another mission");
        }
      }
      await this.context.insertIdempotent(tx, {
        entity: "evidence reference",
        table: "scientific_evidence",
        id: reference.id,
        payload: canonicalJson(reference),
        columns: [
          "id",
          "mission_id",
          "work_unit_id",
          "kind",
          "evidence_kind_id",
          "uri",
          "content_digest",
          "immutable",
          "source_id",
          "payload_json",
          "created_at",
        ],
        values: [
          reference.id,
          reference.missionId,
          reference.workUnitId ?? null,
          legacyEvidenceKind(reference.kind),
          reference.kind,
          reference.uri,
          reference.contentDigest,
          reference.immutable,
          reference.sourceId ?? null,
          canonicalJson(reference),
          reference.createdAt,
        ],
      });
      return reference;
    });
  }

  async createCheckpoint(checkpointInput: MissionCheckpoint): Promise<MissionCheckpoint> {
    const checkpoint = MissionCheckpointSchema.parse(checkpointInput);
    return this.context.inTransaction("create mission checkpoint", async (tx) => {
      const plan = await this.context.requiredRow<{ mission_id: string }>(
        tx,
        "plan",
        checkpoint.planId,
        "scientific_plans",
      );
      if (String(plan.mission_id) !== checkpoint.missionId) {
        throw new ScientificIntegrityError("Checkpoint plan belongs to another mission");
      }
      for (const workUnitId of unique([
        ...checkpoint.runnableWorkUnits,
        ...checkpoint.blockedWorkUnits,
      ])) {
        const work = await this.context.requiredRow<{ mission_id: string }>(
          tx,
          "checkpoint work unit",
          workUnitId,
          "scientific_work_units",
        );
        if (String(work.mission_id) !== checkpoint.missionId) {
          throw new ScientificIntegrityError("Checkpoint work unit belongs to another mission");
        }
      }
      for (const approvalId of checkpoint.pendingApprovals) {
        const approval = await this.context.requiredRow<{ mission_id: string; state: string }>(
          tx,
          "checkpoint approval",
          approvalId,
          "scientific_approval_requests",
        );
        if (
          String(approval.mission_id) !== checkpoint.missionId ||
          String(approval.state) !== "pending"
        ) {
          throw new ScientificIntegrityError("Checkpoint approval is not pending for this mission");
        }
      }
      const created = await this.context.insertIdempotent(tx, {
        entity: "mission checkpoint",
        table: "scientific_checkpoints",
        id: checkpoint.id,
        payload: canonicalJson(checkpoint),
        columns: [
          "id",
          "mission_id",
          "plan_id",
          "sequence",
          "context_digest",
          "payload_json",
          "created_at",
        ],
        values: [
          checkpoint.id,
          checkpoint.missionId,
          checkpoint.planId,
          checkpoint.sequence,
          checkpoint.contextDigest,
          canonicalJson(checkpoint),
          checkpoint.createdAt,
        ],
      });
      if (created) {
        for (const evidenceId of checkpoint.evidenceFrontier) {
          const evidence = await this.context.requiredRow<{ mission_id: string }>(
            tx,
            "checkpoint evidence",
            evidenceId,
            "scientific_evidence",
          );
          if (String(evidence.mission_id) !== checkpoint.missionId) {
            throw new ScientificIntegrityError("Checkpoint evidence belongs to another mission");
          }
          await tx.query(
            "INSERT INTO scientific_checkpoint_evidence (checkpoint_id, evidence_id) VALUES ($1, $2)",
            [checkpoint.id, evidenceId],
          );
        }
      }
      return checkpoint;
    });
  }

  async createDecision(decisionInput: ScientificDecision): Promise<ScientificDecision> {
    const decision = ScientificDecisionSchema.parse(decisionInput);
    return this.context.inTransaction("create scientific decision", async (tx) => {
      const planRow = await this.context.requiredRow<JsonRow & { mission_id: string }>(
        tx,
        "plan",
        decision.planId,
        "scientific_plans",
      );
      const plan = parsePayload(ScientificPlanSchema, planRow, `plan ${decision.planId}`);
      if (String(planRow.mission_id) !== decision.missionId) {
        throw new ScientificIntegrityError("Decision plan belongs to another mission");
      }
      const selectedFragments = new Set(
        plan.skillResolution.selectedFragments.map((fragment) => canonicalJson(fragment)),
      );
      for (const skillRef of decision.skillRefs) {
        if (!selectedFragments.has(canonicalJson(skillRef))) {
          throw new ScientificIntegrityError(
            "Decision cites a skill fragment outside the exact resolution",
            {
              decisionId: decision.id,
              fragmentId: skillRef.fragmentId,
            },
          );
        }
      }
      const created = await this.context.insertIdempotent(tx, {
        entity: "scientific decision",
        table: "scientific_decisions",
        id: decision.id,
        payload: canonicalJson(decision),
        columns: [
          "id",
          "mission_id",
          "plan_id",
          "category",
          "risk_class",
          "requires_approval",
          "payload_digest",
          "payload_json",
          "created_at",
        ],
        values: [
          decision.id,
          decision.missionId,
          decision.planId,
          decision.category,
          decision.riskClass,
          decision.requiresApproval,
          digestCanonical(decision),
          canonicalJson(decision),
          decision.createdAt,
        ],
      });
      if (created) {
        for (const evidenceId of decision.evidenceRefs) {
          await this.assertEvidenceMission(tx, evidenceId, decision.missionId);
          await tx.query(
            "INSERT INTO scientific_decision_evidence (decision_id, evidence_id) VALUES ($1, $2)",
            [decision.id, evidenceId],
          );
        }
      }
      return decision;
    });
  }

  private async assertEvidenceMission(
    tx: ScientificTransaction,
    evidenceId: string,
    missionId: string,
  ): Promise<void> {
    const evidence = await this.context.requiredRow<{ mission_id: string }>(
      tx,
      "evidence",
      evidenceId,
      "scientific_evidence",
    );
    if (String(evidence.mission_id) !== missionId) {
      throw new ScientificIntegrityError("Evidence reference belongs to another mission", {
        evidenceId,
        missionId,
      });
    }
  }

  // ── Observations, validation, models, and assessments ─────

  async createObservation(observationInput: ScientificObservation): Promise<ScientificObservation> {
    const observation = ScientificObservationSchema.parse(observationInput);
    return this.context.inTransaction("create scientific observation", async (tx) => {
      const work = await this.context.requiredRow<{ mission_id: string }>(
        tx,
        "work unit",
        observation.workUnitId,
        "scientific_work_units",
      );
      if (String(work.mission_id) !== observation.missionId) {
        throw new ScientificIntegrityError("Observation work unit belongs to another mission");
      }
      const created = await this.context.insertIdempotent(tx, {
        entity: "scientific observation",
        table: "scientific_observations",
        id: observation.id,
        payload: canonicalJson(observation),
        columns: [
          "id",
          "mission_id",
          "work_unit_id",
          "type",
          "observation_type_id",
          "payload_digest",
          "payload_json",
          "observed_at",
        ],
        values: [
          observation.id,
          observation.missionId,
          observation.workUnitId,
          legacyObservationType(observation.type),
          observation.type,
          digestCanonical(observation.payload),
          canonicalJson(observation),
          observation.observedAt,
        ],
      });
      if (created) {
        for (const evidenceId of observation.evidenceRefs) {
          await this.assertEvidenceMission(tx, evidenceId, observation.missionId);
          await tx.query(
            "INSERT INTO scientific_observation_evidence (observation_id, evidence_id) VALUES ($1, $2)",
            [observation.id, evidenceId],
          );
        }
      }
      return observation;
    });
  }

  async createValidationResult(resultInput: ValidationResult): Promise<ValidationResult> {
    const result = ValidationResultSchema.parse(resultInput);
    return this.context.inTransaction("create validation result", async (tx) => {
      const work = await this.context.requiredRow<{ mission_id: string }>(
        tx,
        "work unit",
        result.workUnitId,
        "scientific_work_units",
      );
      if (String(work.mission_id) !== result.missionId) {
        throw new ScientificIntegrityError("Validation work unit belongs to another mission");
      }
      const created = await this.context.insertIdempotent(tx, {
        entity: "validation result",
        table: "scientific_validation_results",
        id: result.id,
        payload: canonicalJson(result),
        columns: [
          "id",
          "mission_id",
          "work_unit_id",
          "criterion_id",
          "status",
          "payload_digest",
          "payload_json",
          "created_at",
        ],
        values: [
          result.id,
          result.missionId,
          result.workUnitId,
          result.criterionId,
          result.status,
          digestCanonical(result),
          canonicalJson(result),
          result.createdAt,
        ],
      });
      if (created) {
        for (const observationId of result.observationRefs) {
          const observation = await this.context.requiredRow<{ mission_id: string }>(
            tx,
            "validation observation",
            observationId,
            "scientific_observations",
          );
          if (String(observation.mission_id) !== result.missionId) {
            throw new ScientificIntegrityError("Validation observation belongs to another mission");
          }
          await tx.query(
            `INSERT INTO scientific_validation_observations (validation_id, observation_id)
             VALUES ($1, $2)`,
            [result.id, observationId],
          );
        }
        for (const evidenceId of result.evidenceRefs) {
          await this.assertEvidenceMission(tx, evidenceId, result.missionId);
          await tx.query(
            "INSERT INTO scientific_validation_evidence (validation_id, evidence_id) VALUES ($1, $2)",
            [result.id, evidenceId],
          );
        }
      }
      return result;
    });
  }

  async createModelInvocation(recordInput: ModelInvocationRecord): Promise<ModelInvocationRecord> {
    const record = ModelInvocationRecordSchema.parse(recordInput);
    return this.context.inTransaction("create model invocation record", async (tx) => {
      await this.context.requiredRow(tx, "mission", record.missionId, "scientific_missions");
      if (record.planId) {
        const plan = await this.context.requiredRow<{ mission_id: string }>(
          tx,
          "plan",
          record.planId,
          "scientific_plans",
        );
        if (String(plan.mission_id) !== record.missionId) {
          throw new ScientificIntegrityError("Model invocation plan belongs to another mission");
        }
      }
      await this.context.insertIdempotent(tx, {
        entity: "model invocation record",
        table: "scientific_model_invocations",
        id: record.id,
        payload: canonicalJson(record),
        columns: [
          "id",
          "mission_id",
          "plan_id",
          "role",
          "model_role_id",
          "provider",
          "model",
          "status",
          "request_digest",
          "response_digest",
          "context_digest",
          "payload_json",
          "started_at",
          "finished_at",
        ],
        values: [
          record.id,
          record.missionId,
          record.planId ?? null,
          legacyModelRole(record.role),
          record.role,
          record.provider,
          record.model,
          record.status,
          record.requestDigest,
          record.responseDigest ?? null,
          record.contextDigest,
          canonicalJson(record),
          record.startedAt,
          record.finishedAt,
        ],
      });
      return record;
    });
  }

  async createCriticFinding(findingInput: CriticFinding): Promise<CriticFinding> {
    const finding = CriticFindingSchema.parse(findingInput);
    return this.context.inTransaction("create critic finding", async (tx) => {
      const planRow = await this.context.requiredRow<JsonRow & { mission_id: string }>(
        tx,
        "plan",
        finding.planId,
        "scientific_plans",
      );
      const plan = parsePayload(ScientificPlanSchema, planRow, `plan ${finding.planId}`);
      if (String(planRow.mission_id) !== finding.missionId) {
        throw new ScientificIntegrityError("Critic finding plan belongs to another mission");
      }
      const fragments = new Set(
        plan.skillResolution.selectedFragments.map((fragment) => canonicalJson(fragment)),
      );
      for (const skillRef of finding.skillRefs) {
        if (!fragments.has(canonicalJson(skillRef))) {
          throw new ScientificIntegrityError("Critic finding cites an unresolved skill fragment", {
            findingId: finding.id,
            fragmentId: skillRef.fragmentId,
          });
        }
      }
      for (const evidenceId of finding.evidenceRefs) {
        await this.assertEvidenceMission(tx, evidenceId, finding.missionId);
      }
      await this.context.insertIdempotent(tx, {
        entity: "critic finding",
        table: "scientific_critic_findings",
        id: finding.id,
        payload: canonicalJson(finding),
        columns: [
          "id",
          "mission_id",
          "plan_id",
          "severity",
          "code",
          "payload_digest",
          "payload_json",
        ],
        values: [
          finding.id,
          finding.missionId,
          finding.planId,
          finding.severity,
          finding.code,
          digestCanonical(finding),
          canonicalJson(finding),
        ],
      });
      return finding;
    });
  }

  async createAssessment(assessmentInput: ScientificAssessment): Promise<ScientificAssessment> {
    const assessment = ScientificAssessmentSchema.parse(assessmentInput);
    return this.context.inTransaction("create scientific assessment", async (tx) => {
      await this.context.requiredRow(tx, "mission", assessment.missionId, "scientific_missions");
      const skillRows = await tx.queryRows<JsonRow>(
        "SELECT payload_json FROM scientific_skill_resolutions WHERE mission_id = $1",
        [assessment.missionId],
      );
      const exactFragments = new Set(
        skillRows.flatMap((row) =>
          parsePayload(ResolvedSkillGraphSchema, row, "skill resolution").selectedFragments.map(
            (fragment) => canonicalJson(fragment),
          ),
        ),
      );
      for (const skillRef of assessment.skillRefs) {
        if (!exactFragments.has(canonicalJson(skillRef))) {
          throw new ScientificIntegrityError("Assessment cites an unresolved skill fragment", {
            assessmentId: assessment.id,
            fragmentId: skillRef.fragmentId,
          });
        }
      }
      const created = await this.context.insertIdempotent(tx, {
        entity: "scientific assessment",
        table: "scientific_assessments",
        id: assessment.id,
        payload: canonicalJson(assessment),
        columns: [
          "id",
          "mission_id",
          "revision",
          "status",
          "payload_digest",
          "payload_json",
          "created_at",
        ],
        values: [
          assessment.id,
          assessment.missionId,
          assessment.revision,
          assessment.status,
          digestCanonical(assessment),
          canonicalJson(assessment),
          assessment.createdAt,
        ],
      });
      if (created) {
        for (const decisionId of assessment.decisionRefs) {
          const decision = await this.context.requiredRow<{ mission_id: string }>(
            tx,
            "assessment decision",
            decisionId,
            "scientific_decisions",
          );
          if (String(decision.mission_id) !== assessment.missionId) {
            throw new ScientificIntegrityError("Assessment decision belongs to another mission");
          }
          await tx.query(
            "INSERT INTO scientific_assessment_decisions (assessment_id, decision_id) VALUES ($1, $2)",
            [assessment.id, decisionId],
          );
        }
        for (const evidenceId of assessment.evidenceRefs) {
          await this.assertEvidenceMission(tx, evidenceId, assessment.missionId);
          await tx.query(
            "INSERT INTO scientific_assessment_evidence (assessment_id, evidence_id) VALUES ($1, $2)",
            [assessment.id, evidenceId],
          );
        }
        for (const validationId of assessment.validationRefs) {
          const validation = await this.context.requiredRow<{ mission_id: string }>(
            tx,
            "assessment validation",
            validationId,
            "scientific_validation_results",
          );
          if (String(validation.mission_id) !== assessment.missionId) {
            throw new ScientificIntegrityError("Assessment validation belongs to another mission");
          }
          await tx.query(
            `INSERT INTO scientific_assessment_validations (assessment_id, validation_id)
             VALUES ($1, $2)`,
            [assessment.id, validationId],
          );
        }
      }
      return assessment;
    });
  }
}
