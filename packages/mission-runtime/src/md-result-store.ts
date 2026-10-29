/** Internal domain repository; callers use the public store facade. */
import {
  assertMdMetricSeriesDigest,
  assertMdStageResultDigest,
  assertMdStageSpecDigest,
  assertMdWorkflowProtocolDigest,
  assertPublishedBiomolecularSystemManifestDigest,
  assertTrajectorySegmentDigest,
  canonicalJson,
  MdExecutionBindingParametersSchema,
  ReplicaSetSchema,
  ValidationResultSchema,
  WorkUnitSchema,
  type MdExecutionBindingParameters,
  type MdMetricSeries,
  type MdScientificAssessment,
  type MdStageAssessment,
  type MdStageResult,
  type ReplicaConvergenceAssessment,
  type TrajectorySegment,
} from "@eigengrid/scientific-schema";
import {
  ScientificEntityConflictError,
  ScientificEntityNotFoundError,
  ScientificIntegrityError,
} from "./errors";
import { assertExactApprovedSubject, resolveDecisionRequirements } from "./md-store-authority";
import { MdStoreContext } from "./md-store-context";
import { JsonRow, one, parseJson, queryRows } from "./md-store-queries";
import {
  assertCanonicalSetEqual,
  assertMdStageOperationRequestAuthority,
  computeMdReplicaSetPayloadDigest,
  createMdStageAssessmentOperationRequest,
  MdAssessment,
  mdEvidenceKindByArtifactRole,
  parseMdAssessment,
} from "./md-store-validation";
import type { ScientificTransaction } from "./types";
export class MdResultStore {
  constructor(private readonly context: MdStoreContext) {}

  async stageResultsForWorkUnits(
    missionId: string,
    workUnitIds: string[],
  ): Promise<MdStageResult[]> {
    if (workUnitIds.length > 128)
      throw new ScientificIntegrityError("MD predecessor query exceeds its bounded DAG profile");
    const ids = await this.context.inTransaction("resolve stage predecessor", (tx) =>
      queryRows<{ id: string }>(
        tx,
        "SELECT id FROM scientific_md_stage_results WHERE mission_id=$1 AND work_unit_id=ANY($2::text[]) ORDER BY id",
        [missionId, workUnitIds],
      ),
    );
    const result: MdStageResult[] = [];
    for (const row of ids) {
      const value = await this.getStageResult(row.id);
      if (!value || value.missionId !== missionId || !workUnitIds.includes(value.workUnitId))
        throw new ScientificIntegrityError("MD predecessor identity changed");
      result.push(value);
    }
    return result;
  }

  private async assertReplicaSegment(
    tx: ScientificTransaction,
    result: MdStageResult,
    binding: MdExecutionBindingParameters,
  ): Promise<void> {
    if (result.stageKind !== "production") return;
    const replicaSetId = result.replicaSetId!;
    const replicaSetRevision = result.replicaSetRevision!;
    const replicaSetDigest = result.replicaSetDigest!;
    const replicaId = result.replicaId!;
    const segmentIndex = result.segmentIndex!;
    const parentRestartDigest = result.parentRestartDigest!;
    const row = await one<JsonRow & { mission_id: string; payload_digest: string }>(
      tx,
      `SELECT mission_id, payload_digest, payload_json
       FROM scientific_md_replica_set_revisions WHERE id = $1 AND revision = $2`,
      [replicaSetId, replicaSetRevision],
    );
    if (!row) {
      throw new ScientificEntityNotFoundError("MD replica set", replicaSetId);
    }
    const replicaSet = ReplicaSetSchema.parse(parseJson(row, "MD replica set"));
    const payloadDigest = computeMdReplicaSetPayloadDigest(replicaSet);
    const replica = replicaSet.replicas.find((candidate) => candidate.id === replicaId);
    if (
      String(row.mission_id) !== result.missionId ||
      String(row.payload_digest) !== payloadDigest ||
      payloadDigest !== replicaSetDigest ||
      replicaSet.protocolId !== result.protocolId ||
      replicaSet.protocolRevision !== result.protocolRevision ||
      replicaSet.protocolDigest !== result.protocolDigest ||
      !replica ||
      binding.replicaSegment?.replicaIndex !== replica.index ||
      binding.replicaSegment?.replicaSeed !== replica.seed
    ) {
      throw new ScientificIntegrityError("Production result replica-set identity is stale", {
        resultId: result.id,
        replicaSetId,
        replicaId,
      });
    }
    if (
      binding.replicaSegment?.segmentSeed !== replica.segmentSeeds?.[segmentIndex] ||
      (replica.segmentSeeds !== undefined && segmentIndex >= replica.segmentSeeds.length)
    ) {
      throw new ScientificIntegrityError(
        "Production result segment seed is outside its approved schedule",
        {
          resultId: result.id,
        },
      );
    }
    if (segmentIndex === 0) {
      if (replica.initialRestart.contentDigest !== parentRestartDigest) {
        throw new ScientificIntegrityError(
          "First production segment does not use the replica initial restart",
          { resultId: result.id, replicaId },
        );
      }
      return;
    }
    const previous = await one<{
      restart_digest: string;
      end_step: number;
      end_time_ps: number;
      continuity_status: string;
    }>(
      tx,
      `SELECT segment.restart_digest, segment.end_step, segment.end_time_ps,
              segment.continuity_status
       FROM scientific_md_trajectory_segments AS segment
       JOIN scientific_md_replica_segment_bindings AS binding
         ON binding.stage_binding_id = segment.stage_binding_id
       WHERE binding.mission_id = $1 AND binding.replica_set_id = $2
         AND binding.replica_set_revision = $3 AND binding.replica_id = $4
         AND binding.segment_index = $5`,
      [result.missionId, replicaSetId, replicaSetRevision, replicaId, segmentIndex - 1],
    );
    if (
      !previous ||
      String(previous.continuity_status) !== "verified" ||
      String(previous.restart_digest) !== parentRestartDigest ||
      Number(previous.end_step) !== result.startStep ||
      Number(previous.end_time_ps) !== result.startTimePs
    ) {
      throw new ScientificIntegrityError("Production segment continuity is stale or missing", {
        resultId: result.id,
        replicaId,
        segmentIndex,
      });
    }
  }

  private async assertStageArtifacts(
    tx: ScientificTransaction,
    result: MdStageResult,
  ): Promise<void> {
    for (const artifact of result.artifacts) {
      const evidence = await this.context.assertCasEvidence(tx, {
        missionId: result.missionId,
        evidenceRef: artifact.evidenceRef,
        expectedDigest: artifact.contentDigest,
        expectedKind: mdEvidenceKindByArtifactRole[artifact.role],
        expectedMediaType: artifact.mediaType,
        expectedWorkUnitId: result.workUnitId,
        expectedSourceId: result.operationReceiptId,
        expectedSizeBytes: artifact.sizeBytes,
      });
      void evidence;
    }
    if (result.normalizedMetricsRef) {
      const evidence = await this.context.assertCasEvidence(tx, {
        missionId: result.missionId,
        evidenceRef: result.normalizedMetricsRef.evidenceRef,
        expectedDigest: result.normalizedMetricsRef.contentDigest,
        expectedKind: "normalized_metrics",
        expectedMediaType: result.normalizedMetricsRef.mediaType,
        expectedWorkUnitId: result.workUnitId,
        expectedSourceId: result.operationReceiptId,
        expectedSizeBytes: result.normalizedMetricsRef.sizeBytes,
      });
      void evidence;
    }
  }

  private async assertStageValidationAuthority(
    tx: ScientificTransaction,
    result: MdStageResult,
  ): Promise<void> {
    if (result.validationStatus === "not_run") {
      if (result.validationRefs.length !== 0) {
        throw new ScientificIntegrityError(
          "An unvalidated MD result cannot cite validation records",
          { resultId: result.id },
        );
      }
      return;
    }
    if (result.validationRefs.length === 0) {
      throw new ScientificIntegrityError(
        "A claimed MD validation status requires durable validation records",
        { resultId: result.id, validationStatus: result.validationStatus },
      );
    }
    const observedStatuses: string[] = [];
    for (const validationRef of result.validationRefs) {
      const row = await one<JsonRow & { mission_id: string; work_unit_id: string; status: string }>(
        tx,
        `SELECT mission_id, work_unit_id, status, payload_json
         FROM scientific_validation_results WHERE id = $1`,
        [validationRef],
      );
      if (!row) throw new ScientificEntityNotFoundError("MD validation result", validationRef);
      const validation = ValidationResultSchema.parse(parseJson(row, "MD validation result"));
      if (
        validation.id !== validationRef ||
        validation.missionId !== result.missionId ||
        validation.workUnitId !== result.workUnitId ||
        String(row.mission_id) !== result.missionId ||
        String(row.work_unit_id) !== result.workUnitId ||
        validation.status !== String(row.status)
      ) {
        throw new ScientificIntegrityError(
          "MD validation record belongs to another result authority",
          { resultId: result.id, validationRef },
        );
      }
      observedStatuses.push(validation.status);
    }
    if (
      (result.validationStatus === "passed" &&
        observedStatuses.some((status) => status !== "passed")) ||
      (result.validationStatus === "failed" &&
        !observedStatuses.some((status) => status === "failed")) ||
      (result.validationStatus === "inconclusive" &&
        !observedStatuses.some((status) => status === "inconclusive"))
    ) {
      throw new ScientificIntegrityError(
        "MD result validation status is not supported by its durable validation records",
        { resultId: result.id, validationStatus: result.validationStatus },
      );
    }
  }

  async putStageResult(input: MdStageResult): Promise<MdStageResult> {
    const result = assertMdStageResultDigest(input);
    await this.context.inTransaction("persist MD stage result", async (tx) => {
      const operation = await this.context.assertConfirmedOperation(
        tx,
        result.missionId,
        result.operationId,
        result.operationReceiptId,
      );
      if (operation.workUnitId !== result.workUnitId) {
        throw new ScientificIntegrityError("Stage result operation belongs to another WorkUnit");
      }
      const workUnitRow = await this.context.required<
        JsonRow & {
          mission_id: string;
          plan_id: string;
          plan_version: number;
          capability_id: string;
        }
      >(tx, "work unit", "scientific_work_units", result.workUnitId);
      const workUnit = WorkUnitSchema.parse(parseJson(workUnitRow, "MD WorkUnit"));
      const binding = MdExecutionBindingParametersSchema.parse(
        workUnit.protocolFragment.parameters,
      );
      if (
        String(workUnitRow.mission_id) !== result.missionId ||
        workUnit.missionId !== result.missionId ||
        workUnit.planId !== String(workUnitRow.plan_id) ||
        workUnit.planVersion !== Number(workUnitRow.plan_version) ||
        workUnit.executionPolicy.capability !== String(workUnitRow.capability_id) ||
        workUnit.protocolFragment.kind !== "scientific_capability" ||
        binding.plan.id !== workUnit.planId ||
        binding.plan.version !== workUnit.planVersion ||
        binding.protocol.id !== result.protocolId ||
        binding.protocol.revision !== result.protocolRevision ||
        binding.protocol.digest !== result.protocolDigest ||
        binding.stage.id !== result.stageId ||
        binding.stage.revision !== result.stageRevision ||
        binding.stage.kind !== result.stageKind ||
        binding.stage.digest !== result.stageDigest ||
        binding.replicaSegment?.replicaSetId !== result.replicaSetId ||
        binding.replicaSegment?.replicaSetRevision !== result.replicaSetRevision ||
        binding.replicaSegment?.replicaSetDigest !== result.replicaSetDigest ||
        binding.replicaSegment?.replicaId !== result.replicaId ||
        binding.replicaSegment?.segmentIndex !== result.segmentIndex ||
        (binding.stage.kind === "production" &&
          binding.parentRestart?.contentDigest !== result.parentRestartDigest)
      ) {
        throw new ScientificIntegrityError("Stage result is outside its exact capability WorkUnit");
      }
      if (operation.operation.kind !== "md_stage_execution") {
        throw new ScientificIntegrityError(
          "MD stage result operation does not bind the exact approved WorkUnit request",
          { resultId: result.id, operationId: result.operationId },
        );
      }
      assertMdStageOperationRequestAuthority(workUnit, operation.operation.request, result);
      const protocol = await one<{
        mission_id: string;
        plan_id: string;
        plan_version: number;
        protocol_digest: string;
      }>(
        tx,
        `SELECT mission_id, plan_id, plan_version, protocol_digest FROM scientific_md_protocols
         WHERE id = $1 AND revision = $2`,
        [result.protocolId, result.protocolRevision],
      );
      const stage = await one<
        JsonRow & {
          mission_id: string;
          sequence: number;
          stage_digest: string;
          stage_kind: string;
        }
      >(
        tx,
        `SELECT mission_id, sequence, stage_digest, stage_kind, payload_json
         FROM scientific_md_stage_specs
         WHERE id = $1 AND revision = $2 AND protocol_id = $3 AND protocol_revision = $4`,
        [result.stageId, result.stageRevision, result.protocolId, result.protocolRevision],
      );
      if (
        !protocol ||
        String(protocol.mission_id) !== result.missionId ||
        String(protocol.plan_id) !== workUnit.planId ||
        Number(protocol.plan_version) !== workUnit.planVersion ||
        String(protocol.protocol_digest) !== result.protocolDigest ||
        !stage ||
        String(stage.mission_id) !== result.missionId ||
        Number(stage.sequence) !== binding.stage.sequence ||
        String(stage.stage_digest) !== result.stageDigest ||
        String(stage.stage_kind) !== result.stageKind
      ) {
        throw new ScientificIntegrityError("Stage result protocol or stage binding is stale");
      }
      const parsedStage = assertMdStageSpecDigest(parseJson(stage, "MD stage"));
      const declaredOutputs = new Map(parsedStage.outputs.map((output) => [output.role, output]));
      for (const artifact of result.artifacts) {
        const declared = declaredOutputs.get(artifact.role);
        if (!declared || declared.mediaType !== artifact.mediaType) {
          throw new ScientificIntegrityError(
            "Stage result artifact is outside the exact stage output contract",
            { resultId: result.id, artifactRole: artifact.role },
          );
        }
      }
      for (const output of parsedStage.outputs.filter((candidate) => candidate.required)) {
        if (!result.artifacts.some((artifact) => artifact.role === output.role)) {
          throw new ScientificIntegrityError("Stage result is missing a required output", {
            resultId: result.id,
            artifactRole: output.role,
          });
        }
      }
      if (
        result.terminalReason === "completed" &&
        (parsedStage.kind === "minimization"
          ? result.endStep - result.startStep > parsedStage.steps ||
            result.endTimePs !== result.startTimePs
          : result.endStep - result.startStep !== parsedStage.steps ||
            Math.abs(result.endTimePs - result.startTimePs - parsedStage.simulatedTimePs!) >
              Math.max(1e-9, parsedStage.simulatedTimePs! * 1e-9))
      ) {
        throw new ScientificIntegrityError(
          "Completed stage result does not cover the exact approved stage interval",
          { resultId: result.id },
        );
      }
      const plan = await one<{
        mission_id: string;
        version: number;
        revision: number;
        status: string;
        plan_digest: string;
      }>(
        tx,
        `SELECT mission_id, version, revision, status, plan_digest
         FROM scientific_plans WHERE id = $1`,
        [binding.plan.id],
      );
      const system = await one<{ mission_id: string; manifest_digest: string }>(
        tx,
        `SELECT mission_id, manifest_digest FROM scientific_biomolecular_system_manifests
         WHERE id = $1 AND revision = $2`,
        [binding.system.id, binding.system.revision],
      );
      if (
        !plan ||
        String(plan.mission_id) !== result.missionId ||
        Number(plan.version) !== binding.plan.version ||
        Number(plan.revision) !== binding.plan.revision ||
        String(plan.status) !== "approved" ||
        String(plan.plan_digest) !== binding.plan.digest ||
        !system ||
        String(system.mission_id) !== result.missionId ||
        String(system.manifest_digest) !== binding.system.digest ||
        parsedStage.system.id !== binding.system.id ||
        parsedStage.system.revision !== binding.system.revision ||
        parsedStage.system.manifestDigest !== binding.system.digest
      ) {
        throw new ScientificIntegrityError("MD execution binding plan or system is stale", {
          resultId: result.id,
        });
      }
      await assertExactApprovedSubject(tx, {
        approvalRef: binding.plan.approvalRef,
        missionId: result.missionId,
        subjectType: "plan",
        subjectId: binding.plan.id,
        subjectVersion: binding.plan.version,
        subjectRevision: binding.plan.revision,
        digest: binding.plan.digest,
      });
      await assertExactApprovedSubject(tx, {
        approvalRef: binding.system.approvalRef,
        missionId: result.missionId,
        subjectType: "biomolecular_system_manifest",
        subjectId: binding.system.id,
        subjectVersion: binding.system.revision,
        subjectRevision: binding.system.revision,
        digest: binding.system.digest,
      });
      await assertExactApprovedSubject(tx, {
        approvalRef: binding.protocol.approvalRef,
        missionId: result.missionId,
        subjectType: "md_protocol",
        subjectId: binding.protocol.id,
        subjectVersion: binding.protocol.revision,
        subjectRevision: binding.protocol.revision,
        digest: binding.protocol.digest,
      });
      const resolvedDecisions = await resolveDecisionRequirements(
        tx,
        result.missionId,
        binding.decisions.map((decision) => decision.id),
      );
      const boundDecisions = binding.decisions.map((decision) => ({
        id: decision.id,
        revision: decision.revision,
        digest: decision.decisionDigest,
        approvalRef: decision.approvalRef,
      }));
      if (canonicalJson(resolvedDecisions) !== canonicalJson(boundDecisions)) {
        throw new ScientificIntegrityError("MD execution decision binding is stale", {
          resultId: result.id,
        });
      }
      await this.assertReplicaSegment(tx, result, binding);
      await this.assertStageArtifacts(tx, result);
      await this.assertStageValidationAuthority(tx, result);
      const bindingPayload = canonicalJson({
        schemaVersion: "eigengrid.md-stage-binding/v1",
        id: result.id,
        missionId: result.missionId,
        protocolId: result.protocolId,
        protocolRevision: result.protocolRevision,
        workUnitId: result.workUnitId,
        operationId: result.operationId,
        stageId: result.stageId,
        replicaId: result.replicaId ?? null,
        replicaIndex: binding.replicaSegment?.replicaIndex ?? null,
        replicaSeed: binding.replicaSegment?.replicaSeed ?? null,
        ...(binding.replicaSegment?.segmentSeed === undefined
          ? {}
          : { segmentSeed: binding.replicaSegment.segmentSeed }),
        segmentIndex: result.segmentIndex ?? null,
        replicaSetId: result.replicaSetId ?? null,
        replicaSetRevision: result.replicaSetRevision ?? null,
        replicaSetDigest: result.replicaSetDigest ?? null,
        parentRestartDigest: result.parentRestartDigest ?? null,
        requestDigest: operation.requestDigest,
      });
      const insertedBinding = await queryRows<{ id: string }>(
        tx,
        `INSERT INTO scientific_md_stage_bindings
         (id, mission_id, protocol_id, protocol_revision, work_unit_id, operation_id,
          stage_id, replica_id, segment_index, request_digest, payload_json, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          result.id,
          result.missionId,
          result.protocolId,
          result.protocolRevision,
          result.workUnitId,
          result.operationId,
          result.stageId,
          result.replicaId ?? null,
          result.segmentIndex ?? null,
          operation.requestDigest,
          bindingPayload,
          result.startedAt,
        ],
      );
      if (insertedBinding.length === 0) {
        const existing = await one<JsonRow>(
          tx,
          "SELECT payload_json FROM scientific_md_stage_bindings WHERE id = $1",
          [result.id],
        );
        if (!existing || String(existing.payload_json) !== bindingPayload) {
          throw new ScientificEntityConflictError("MD stage binding", result.id);
        }
      }
      if (result.stageKind === "production") {
        const insertedSegmentBinding = await queryRows<{ stage_binding_id: string }>(
          tx,
          `INSERT INTO scientific_md_replica_segment_bindings
           (stage_binding_id, mission_id, replica_set_id, replica_set_revision,
            replica_set_digest, replica_id, replica_index, replica_seed, segment_index,
            parent_restart_digest, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT DO NOTHING RETURNING stage_binding_id`,
          [
            result.id,
            result.missionId,
            result.replicaSetId!,
            result.replicaSetRevision!,
            result.replicaSetDigest!,
            result.replicaId!,
            binding.replicaSegment!.replicaIndex,
            binding.replicaSegment!.replicaSeed,
            result.segmentIndex!,
            result.parentRestartDigest!,
            result.startedAt,
          ],
        );
        if (insertedSegmentBinding.length === 0) {
          const existing = await one<{
            mission_id: string;
            replica_set_id: string;
            replica_set_revision: number;
            replica_set_digest: string;
            replica_id: string;
            replica_index: number;
            replica_seed: number;
            segment_index: number;
            parent_restart_digest: string;
          }>(
            tx,
            "SELECT * FROM scientific_md_replica_segment_bindings WHERE stage_binding_id = $1",
            [result.id],
          );
          if (
            !existing ||
            String(existing.mission_id) !== result.missionId ||
            String(existing.replica_set_id) !== result.replicaSetId ||
            Number(existing.replica_set_revision) !== result.replicaSetRevision ||
            String(existing.replica_set_digest) !== result.replicaSetDigest ||
            String(existing.replica_id) !== result.replicaId ||
            Number(existing.replica_index) !== binding.replicaSegment!.replicaIndex ||
            Number(existing.replica_seed) !== binding.replicaSegment!.replicaSeed ||
            Number(existing.segment_index) !== result.segmentIndex ||
            String(existing.parent_restart_digest) !== result.parentRestartDigest
          ) {
            throw new ScientificEntityConflictError("MD replica segment binding", result.id);
          }
        }
      }
      const payload = canonicalJson(result);
      const inserted = await queryRows<{ id: string }>(
        tx,
        `INSERT INTO scientific_md_stage_results
         (id, revision, mission_id, stage_binding_id, operation_receipt_id, stage_id,
          stage_revision, stage_digest, protocol_id, protocol_revision, protocol_digest,
          replica_set_id, replica_set_revision, replica_set_digest, replica_id, segment_index,
          parent_restart_digest, result_digest, terminal_reason, exit_code, payload_json, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          result.id,
          result.revision,
          result.missionId,
          result.id,
          result.operationReceiptId,
          result.stageId,
          result.stageRevision,
          result.stageDigest,
          result.protocolId,
          result.protocolRevision,
          result.protocolDigest,
          result.replicaSetId ?? null,
          result.replicaSetRevision ?? null,
          result.replicaSetDigest ?? null,
          result.replicaId ?? null,
          result.segmentIndex ?? null,
          result.parentRestartDigest ?? null,
          result.resultDigest,
          result.terminalReason,
          result.exitCode,
          payload,
          result.finishedAt,
        ],
      );
      if (inserted.length === 0) {
        const existing = await one<JsonRow>(
          tx,
          "SELECT payload_json FROM scientific_md_stage_results WHERE id = $1",
          [result.id],
        );
        if (!existing || String(existing.payload_json) !== payload) {
          throw new ScientificEntityConflictError("MD stage result", result.id);
        }
      }
      for (const artifact of [
        ...result.artifacts,
        ...(result.normalizedMetricsRef ? [result.normalizedMetricsRef] : []),
      ]) {
        const artifactPayload = canonicalJson(artifact);
        const insertedArtifact = await queryRows<{ stage_result_id: string }>(
          tx,
          `INSERT INTO scientific_md_stage_result_artifacts
           (stage_result_id, artifact_role, evidence_id, operation_receipt_id,
            content_digest, media_type, size_bytes, payload_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT DO NOTHING RETURNING stage_result_id`,
          [
            result.id,
            artifact.role,
            artifact.evidenceRef,
            result.operationReceiptId,
            artifact.contentDigest,
            artifact.mediaType,
            artifact.sizeBytes ?? null,
            artifactPayload,
          ],
        );
        if (insertedArtifact.length === 0) {
          const existing = await one<{
            evidence_id: string;
            operation_receipt_id: string;
            content_digest: string;
            media_type: string;
            size_bytes: number | null;
            payload_json: string;
          }>(
            tx,
            `SELECT evidence_id, operation_receipt_id, content_digest, media_type,
                    size_bytes, payload_json
             FROM scientific_md_stage_result_artifacts
             WHERE stage_result_id = $1 AND artifact_role = $2`,
            [result.id, artifact.role],
          );
          if (
            !existing ||
            String(existing.evidence_id) !== artifact.evidenceRef ||
            String(existing.operation_receipt_id) !== result.operationReceiptId ||
            String(existing.content_digest) !== artifact.contentDigest ||
            String(existing.media_type) !== artifact.mediaType ||
            (existing.size_bytes === null ? undefined : Number(existing.size_bytes)) !==
              artifact.sizeBytes ||
            String(existing.payload_json) !== artifactPayload
          ) {
            throw new ScientificEntityConflictError(
              "MD stage-result artifact receipt",
              `${result.id}:${artifact.role}`,
            );
          }
        }
      }
    });
    return result;
  }

  async getStageResult(id: string): Promise<MdStageResult | null> {
    return this.context.inTransaction("get MD stage result", async (tx) => {
      const row = await one<
        JsonRow & {
          revision: number;
          mission_id: string;
          stage_id: string;
          stage_revision: number;
          stage_digest: string;
          protocol_id: string;
          protocol_revision: number;
          protocol_digest: string;
          result_digest: string;
        }
      >(
        tx,
        `SELECT revision, mission_id, stage_id, stage_revision, stage_digest,
                protocol_id, protocol_revision, protocol_digest, result_digest, payload_json
         FROM scientific_md_stage_results WHERE id = $1`,
        [id],
      );
      if (!row) return null;
      const result = assertMdStageResultDigest(parseJson(row, "MD stage result"));
      if (
        result.id !== id ||
        result.revision !== Number(row.revision) ||
        result.missionId !== String(row.mission_id) ||
        result.stageId !== String(row.stage_id) ||
        result.stageRevision !== Number(row.stage_revision) ||
        result.stageDigest !== String(row.stage_digest) ||
        result.protocolId !== String(row.protocol_id) ||
        result.protocolRevision !== Number(row.protocol_revision) ||
        result.protocolDigest !== String(row.protocol_digest) ||
        result.resultDigest !== String(row.result_digest)
      ) {
        throw new ScientificIntegrityError("MD stage-result columns are corrupt", { id });
      }
      return result;
    });
  }

  async putTrajectorySegment(input: TrajectorySegment): Promise<TrajectorySegment> {
    const segment = assertTrajectorySegmentDigest(input);
    await this.context.inTransaction("persist trajectory segment", async (tx) => {
      const result = await this.context.required<
        JsonRow & {
          mission_id: string;
          stage_binding_id: string;
          replica_set_id: string | null;
          replica_set_revision: number | null;
          replica_set_digest: string | null;
          replica_id: string | null;
          segment_index: number | null;
          parent_restart_digest: string | null;
        }
      >(tx, "MD stage result", "scientific_md_stage_results", segment.stageResultId);
      const parsedResult = assertMdStageResultDigest(parseJson(result, "trajectory stage result"));
      const protocolRow = await one<JsonRow>(
        tx,
        `SELECT payload_json FROM scientific_md_protocols
         WHERE id = $1 AND revision = $2`,
        [parsedResult.protocolId, parsedResult.protocolRevision],
      );
      if (!protocolRow) {
        throw new ScientificEntityNotFoundError("trajectory MD protocol", parsedResult.protocolId);
      }
      const protocol = assertMdWorkflowProtocolDigest(
        parseJson(protocolRow, "trajectory MD protocol"),
      );
      const systemRow = await one<JsonRow>(
        tx,
        `SELECT payload_json FROM scientific_biomolecular_system_manifests
         WHERE id = $1 AND revision = $2`,
        [protocol.system.id, protocol.system.revision],
      );
      if (!systemRow) {
        throw new ScientificEntityNotFoundError("trajectory system manifest", protocol.system.id);
      }
      const system = assertPublishedBiomolecularSystemManifestDigest(
        parseJson(systemRow, "trajectory system manifest"),
      );
      const binding = await one<{
        replica_set_id: string;
        replica_set_revision: number;
        replica_set_digest: string;
        replica_id: string;
        segment_index: number;
        parent_restart_digest: string;
      }>(
        tx,
        `SELECT replica_set_id, replica_set_revision, replica_set_digest, replica_id,
                segment_index, parent_restart_digest
         FROM scientific_md_replica_segment_bindings WHERE stage_binding_id = $1`,
        [result.stage_binding_id],
      );
      const resultRestart = parsedResult.artifacts.find((artifact) => artifact.role === "restart");
      const resultTrajectory = parsedResult.artifacts.find(
        (artifact) => artifact.role === "trajectory",
      );
      if (
        String(result.mission_id) !== segment.missionId ||
        parsedResult.missionId !== segment.missionId ||
        parsedResult.stageKind !== "production" ||
        parsedResult.replicaId !== segment.replicaId ||
        parsedResult.segmentIndex !== segment.segmentIndex ||
        parsedResult.parentRestartDigest !== segment.parentRestart.contentDigest ||
        parsedResult.startStep !== segment.startStep ||
        parsedResult.endStep !== segment.endStep ||
        parsedResult.startTimePs !== segment.startTimePs ||
        parsedResult.endTimePs !== segment.endTimePs ||
        segment.netcdf.atomCount !== system.atomCount ||
        segment.netcdf.hasPeriodicBox !== system.box.periodic ||
        !resultRestart ||
        !resultTrajectory ||
        canonicalJson(resultRestart) !== canonicalJson(segment.restart) ||
        canonicalJson(resultTrajectory) !== canonicalJson(segment.trajectory) ||
        !binding ||
        String(binding.replica_set_id) !== parsedResult.replicaSetId ||
        Number(binding.replica_set_revision) !== parsedResult.replicaSetRevision ||
        String(binding.replica_set_digest) !== parsedResult.replicaSetDigest ||
        String(binding.replica_id) !== segment.replicaId ||
        Number(binding.segment_index) !== segment.segmentIndex ||
        String(binding.parent_restart_digest) !== segment.parentRestart.contentDigest
      ) {
        throw new ScientificIntegrityError(
          "Trajectory segment is outside its exact production result binding",
          { segmentId: segment.id, stageResultId: segment.stageResultId },
        );
      }
      await this.context.assertCasEvidence(tx, {
        missionId: segment.missionId,
        evidenceRef: segment.parentRestart.evidenceRef,
        expectedDigest: segment.parentRestart.contentDigest,
        expectedKind: "restart",
        expectedMediaType: segment.parentRestart.mediaType,
        expectedSizeBytes: segment.parentRestart.sizeBytes,
      });
      for (const artifact of [segment.restart, segment.trajectory]) {
        await this.context.assertCasEvidence(tx, {
          missionId: segment.missionId,
          evidenceRef: artifact.evidenceRef,
          expectedDigest: artifact.contentDigest,
          expectedKind: mdEvidenceKindByArtifactRole[artifact.role],
          expectedMediaType: artifact.mediaType,
          expectedWorkUnitId: parsedResult.workUnitId,
          expectedSourceId: parsedResult.operationReceiptId,
          expectedSizeBytes: artifact.sizeBytes,
        });
      }
      const payload = canonicalJson(segment);
      const inserted = await queryRows<{ id: string }>(
        tx,
        `INSERT INTO scientific_md_trajectory_segments
         (id, revision, mission_id, stage_binding_id, replica_id, segment_index,
          parent_restart_digest, start_step, end_step, start_time_ps, end_time_ps,
          frame_count, trajectory_digest, restart_digest, continuity_status,
          segment_digest, payload_json, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          segment.id,
          segment.revision,
          segment.missionId,
          result.stage_binding_id,
          segment.replicaId,
          segment.segmentIndex,
          segment.parentRestart.contentDigest,
          segment.startStep,
          segment.endStep,
          segment.startTimePs,
          segment.endTimePs,
          segment.frameCount,
          segment.trajectory.contentDigest,
          segment.restart.contentDigest,
          segment.continuity.status,
          segment.segmentDigest,
          payload,
          segment.createdAt,
        ],
      );
      if (inserted.length === 0) {
        const existing = await one<JsonRow>(
          tx,
          "SELECT payload_json FROM scientific_md_trajectory_segments WHERE id = $1",
          [segment.id],
        );
        if (!existing || String(existing.payload_json) !== payload) {
          throw new ScientificEntityConflictError("trajectory segment", segment.id);
        }
      }
    });
    return segment;
  }

  async putMetricSeries(missionId: string, input: MdMetricSeries): Promise<MdMetricSeries> {
    const series = assertMdMetricSeriesDigest(input);
    await this.context.inTransaction("persist MD metric series", async (tx) => {
      const result = await this.context.required<JsonRow & { mission_id: string }>(
        tx,
        "MD stage result",
        "scientific_md_stage_results",
        series.stageResultId,
      );
      const parsedResult = assertMdStageResultDigest(parseJson(result, "metric stage result"));
      const source = [
        ...parsedResult.artifacts,
        ...(parsedResult.normalizedMetricsRef ? [parsedResult.normalizedMetricsRef] : []),
      ].find((artifact) => artifact.evidenceRef === series.sourceArtifactRef);
      if (
        String(result.mission_id) !== missionId ||
        parsedResult.missionId !== missionId ||
        !source ||
        (series.replicaId !== undefined && series.replicaId !== parsedResult.replicaId)
      ) {
        throw new ScientificIntegrityError(
          "Metric series is outside its exact stage-result artifact binding",
          { seriesId: series.id },
        );
      }
      const evidence = await this.context.assertCasEvidence(tx, {
        missionId,
        evidenceRef: source.evidenceRef,
        expectedDigest: source.contentDigest,
        expectedKind: mdEvidenceKindByArtifactRole[source.role],
        expectedMediaType: source.mediaType,
        expectedWorkUnitId: parsedResult.workUnitId,
        expectedSourceId: parsedResult.operationReceiptId,
        expectedSizeBytes: source.sizeBytes,
      });
      const payload = canonicalJson(series);
      const inserted = await queryRows<{ id: string }>(
        tx,
        `INSERT INTO scientific_md_metric_series
         (id, mission_id, stage_result_id, analysis_result_id, analysis_result_revision,
          metric_name, units, artifact_digest, series_digest, payload_json, recorded_at)
         VALUES ($1,$2,$3,NULL,NULL,$4,$5,$6,$7,$8,$9)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          series.id,
          missionId,
          series.stageResultId,
          series.metric === "custom" ? series.customMetricName! : series.metric,
          series.unit,
          evidence.contentDigest,
          series.seriesDigest,
          payload,
          new Date().toISOString(),
        ],
      );
      if (inserted.length === 0) {
        const existing = await one<JsonRow>(
          tx,
          "SELECT payload_json FROM scientific_md_metric_series WHERE id = $1",
          [series.id],
        );
        if (!existing || String(existing.payload_json) !== payload) {
          throw new ScientificEntityConflictError("MD metric series", series.id);
        }
      }
    });
    return series;
  }

  async putAssessment(
    input: MdAssessment,
    context: { operationId: string; operationReceiptId: string; subjectRevision: number },
  ): Promise<MdAssessment> {
    const assessment = parseMdAssessment(input);
    const kind =
      "stageResultId" in assessment
        ? "stage"
        : "replicaSetId" in assessment
          ? "replica_convergence"
          : "scientific";
    const subjectId =
      "stageResultId" in assessment
        ? assessment.stageResultId
        : "replicaSetId" in assessment
          ? assessment.replicaSetId
          : assessment.protocolId;
    await this.context.inTransaction("persist MD assessment", async (tx) => {
      const operation = await this.context.assertConfirmedOperation(
        tx,
        assessment.missionId,
        context.operationId,
        context.operationReceiptId,
      );
      if (operation.operation.kind !== "trajectory_analysis") {
        throw new ScientificIntegrityError(
          "MD assessments require a typed trajectory-analysis operation",
          { assessmentId: assessment.id, operationId: context.operationId },
        );
      }
      const assessmentEvidenceRefs = new Set<string>();
      if (kind === "stage") {
        const stageAssessment = assessment as MdStageAssessment;
        const result = await this.context.required<
          JsonRow & {
            mission_id: string;
            revision: number;
            stage_id: string;
            stage_revision: number;
            stage_digest: string;
          }
        >(tx, "MD stage result", "scientific_md_stage_results", subjectId);
        const parsedResult = assertMdStageResultDigest(
          parseJson(result, "assessment stage result"),
        );
        const stageRow = await one<JsonRow>(
          tx,
          `SELECT payload_json FROM scientific_md_stage_specs
           WHERE id = $1 AND revision = $2`,
          [parsedResult.stageId, parsedResult.stageRevision],
        );
        if (!stageRow) {
          throw new ScientificEntityNotFoundError("MD assessment stage", parsedResult.stageId);
        }
        const stage = assertMdStageSpecDigest(parseJson(stageRow, "assessment MD stage"));
        if (
          String(result.mission_id) !== assessment.missionId ||
          Number(result.revision) !== context.subjectRevision ||
          parsedResult.missionId !== assessment.missionId ||
          stageAssessment.stageResultRevision !== parsedResult.revision ||
          stageAssessment.stageResultDigest !== parsedResult.resultDigest ||
          String(result.stage_id) !== stage.id ||
          Number(result.stage_revision) !== stage.revision ||
          String(result.stage_digest) !== stage.stageDigest
        ) {
          throw new ScientificIntegrityError("Stage assessment subject revision is stale");
        }
        const expectedRequest = createMdStageAssessmentOperationRequest({
          workUnitId: parsedResult.workUnitId,
          stageResult: parsedResult,
          assessment: stageAssessment,
        });
        if (
          operation.workUnitId !== parsedResult.workUnitId ||
          canonicalJson(operation.operation.request) !== canonicalJson(expectedRequest)
        ) {
          throw new ScientificIntegrityError(
            "Stage assessment operation does not bind the exact result and assessment",
            { assessmentId: assessment.id, operationId: context.operationId },
          );
        }
        assertCanonicalSetEqual(
          "Stage assessment acceptance criteria",
          stageAssessment.evaluations.map((evaluation) => ({
            id: evaluation.criterionId,
            digest: evaluation.criterionDigest,
            required: evaluation.required,
          })),
          stage.acceptanceCriteria.map((criterion) => ({
            id: criterion.id,
            digest: criterion.criterionDigest,
            required: criterion.required,
          })),
        );
        for (const evidenceRef of stageAssessment.evidenceRefs) {
          assessmentEvidenceRefs.add(evidenceRef);
        }
        for (const evaluation of stageAssessment.evaluations) {
          for (const evidenceRef of evaluation.evidenceRefs) {
            assessmentEvidenceRefs.add(evidenceRef);
          }
        }
      } else if (kind === "replica_convergence") {
        const convergence = assessment as ReplicaConvergenceAssessment;
        const replica = await one<JsonRow & { mission_id: string }>(
          tx,
          `SELECT mission_id, payload_json FROM scientific_md_replica_set_revisions
           WHERE id = $1 AND revision = $2`,
          [subjectId, context.subjectRevision],
        );
        if (!replica || String(replica.mission_id) !== assessment.missionId) {
          throw new ScientificIntegrityError("Replica assessment subject revision is stale");
        }
        const replicaSet = ReplicaSetSchema.parse(parseJson(replica, "assessment replica set"));
        assertCanonicalSetEqual(
          "Replica convergence membership",
          convergence.replicaIds,
          replicaSet.replicas.map((candidate) => candidate.id),
        );
        for (const observable of convergence.observables) {
          for (const evidenceRef of observable.evidenceRefs) {
            assessmentEvidenceRefs.add(evidenceRef);
          }
        }
      } else {
        const scientific = assessment as MdScientificAssessment;
        const protocol = await one<{ mission_id: string; protocol_digest: string }>(
          tx,
          `SELECT mission_id, protocol_digest FROM scientific_md_protocols
           WHERE id = $1 AND revision = $2`,
          [scientific.protocolId, scientific.protocolRevision],
        );
        const system = await one<{ manifest_digest: string }>(
          tx,
          `SELECT manifest_digest FROM scientific_biomolecular_system_manifests
           WHERE id = $1 AND revision = $2`,
          [scientific.systemManifestId, scientific.systemManifestRevision],
        );
        if (
          !protocol ||
          String(protocol.mission_id) !== scientific.missionId ||
          String(protocol.protocol_digest) !== scientific.protocolDigest ||
          !system ||
          String(system.manifest_digest) !== scientific.systemManifestDigest ||
          context.subjectRevision !== scientific.protocolRevision
        ) {
          throw new ScientificIntegrityError("Scientific assessment subject is stale");
        }
        await this.context.assertDecisionRequirements(
          tx,
          scientific.missionId,
          await resolveDecisionRequirements(tx, scientific.missionId, scientific.decisionRefs),
        );
        if (
          new Set(scientific.stageAssessmentRefs).size !== scientific.stageAssessmentRefs.length
        ) {
          throw new ScientificIntegrityError("Scientific assessment repeats a stage assessment", {
            assessmentId: scientific.id,
          });
        }
        for (const stageAssessmentRef of scientific.stageAssessmentRefs) {
          const stageAssessmentRow = await one<
            JsonRow & { mission_id: string; assessment_digest: string }
          >(
            tx,
            `SELECT mission_id, assessment_digest, payload_json FROM scientific_md_assessments
             WHERE id = $1 AND assessment_kind = 'stage'
             ORDER BY revision DESC LIMIT 1`,
            [stageAssessmentRef],
          );
          if (!stageAssessmentRow) {
            throw new ScientificEntityNotFoundError("stage assessment", stageAssessmentRef);
          }
          const referencedAssessment = parseMdAssessment(
            parseJson(stageAssessmentRow, "scientific stage assessment"),
          );
          if (
            !("stageResultId" in referencedAssessment) ||
            referencedAssessment.assessmentDigest !== String(stageAssessmentRow.assessment_digest)
          ) {
            throw new ScientificIntegrityError("Scientific assessment stage reference is corrupt", {
              assessmentId: scientific.id,
              stageAssessmentRef,
            });
          }
          const stageAssessment = referencedAssessment;
          const stageResult = await one<{
            mission_id: string;
            protocol_id: string;
            protocol_revision: number;
            protocol_digest: string;
          }>(
            tx,
            `SELECT mission_id, protocol_id, protocol_revision, protocol_digest
             FROM scientific_md_stage_results WHERE id = $1`,
            [stageAssessment.stageResultId],
          );
          if (
            String(stageAssessmentRow.mission_id) !== scientific.missionId ||
            stageAssessment.missionId !== scientific.missionId ||
            !stageResult ||
            String(stageResult.mission_id) !== scientific.missionId ||
            String(stageResult.protocol_id) !== scientific.protocolId ||
            Number(stageResult.protocol_revision) !== scientific.protocolRevision ||
            String(stageResult.protocol_digest) !== scientific.protocolDigest
          ) {
            throw new ScientificIntegrityError(
              "Scientific assessment cites a stage assessment from another authority",
              { assessmentId: scientific.id, stageAssessmentRef },
            );
          }
        }
        if (scientific.convergenceAssessmentRef) {
          const convergenceRow = await one<
            JsonRow & {
              mission_id: string;
              subject_id: string;
              subject_revision: number;
              assessment_digest: string;
            }
          >(
            tx,
            `SELECT mission_id, subject_id, subject_revision, assessment_digest, payload_json
             FROM scientific_md_assessments
             WHERE id = $1 AND assessment_kind = 'replica_convergence'
             ORDER BY revision DESC LIMIT 1`,
            [scientific.convergenceAssessmentRef],
          );
          if (!convergenceRow) {
            throw new ScientificEntityNotFoundError(
              "replica convergence assessment",
              scientific.convergenceAssessmentRef,
            );
          }
          const referencedConvergence = parseMdAssessment(
            parseJson(convergenceRow, "scientific convergence assessment"),
          );
          if (
            !("replicaSetId" in referencedConvergence) ||
            referencedConvergence.assessmentDigest !== String(convergenceRow.assessment_digest)
          ) {
            throw new ScientificIntegrityError(
              "Scientific assessment convergence reference is corrupt",
              { assessmentId: scientific.id },
            );
          }
          const convergence = referencedConvergence;
          const convergenceSet = await one<{
            mission_id: string;
            protocol_id: string;
            protocol_revision: number;
            protocol_digest: string;
          }>(
            tx,
            `SELECT mission_id, protocol_id, protocol_revision, protocol_digest
             FROM scientific_md_replica_set_revisions WHERE id = $1 AND revision = $2`,
            [convergenceRow.subject_id, convergenceRow.subject_revision],
          );
          if (
            convergence.missionId !== scientific.missionId ||
            String(convergenceRow.mission_id) !== scientific.missionId ||
            !convergenceSet ||
            String(convergenceSet.mission_id) !== scientific.missionId ||
            String(convergenceSet.protocol_id) !== scientific.protocolId ||
            Number(convergenceSet.protocol_revision) !== scientific.protocolRevision ||
            String(convergenceSet.protocol_digest) !== scientific.protocolDigest
          ) {
            throw new ScientificIntegrityError(
              "Scientific assessment cites convergence from another protocol",
              { assessmentId: scientific.id },
            );
          }
        }
        for (const claim of scientific.claims) {
          for (const evidenceRef of claim.evidenceRefs) {
            assessmentEvidenceRefs.add(evidenceRef);
          }
        }
      }
      for (const evidenceRef of assessmentEvidenceRefs) {
        await this.context.assertCasEvidence(tx, {
          missionId: assessment.missionId,
          evidenceRef,
        });
      }
      await this.context.insertRevision(tx, {
        entity: "MD assessment",
        table: "scientific_md_assessments",
        id: assessment.id,
        revision: assessment.revision,
        payload: canonicalJson(assessment),
        columns: [
          "id",
          "revision",
          "mission_id",
          "assessment_kind",
          "subject_id",
          "subject_revision",
          "operation_id",
          "operation_receipt_id",
          "assessment_digest",
          "payload_json",
          "created_at",
        ],
        values: [
          assessment.id,
          assessment.revision,
          assessment.missionId,
          kind,
          subjectId,
          context.subjectRevision,
          context.operationId,
          context.operationReceiptId,
          assessment.assessmentDigest,
          canonicalJson(assessment),
          assessment.createdAt,
        ],
      });
    });
    return assessment;
  }

  async getAssessment(id: string, revision: number): Promise<MdAssessment | null> {
    return this.context.inTransaction("get MD assessment", async (tx) => {
      const row = await one<
        JsonRow & {
          mission_id: string;
          assessment_kind: string;
          assessment_digest: string;
        }
      >(
        tx,
        `SELECT mission_id, assessment_kind, assessment_digest, payload_json
         FROM scientific_md_assessments WHERE id = $1 AND revision = $2`,
        [id, revision],
      );
      if (!row) return null;
      const assessment = parseMdAssessment(parseJson(row, "MD assessment"));
      const kind =
        "stageResultId" in assessment
          ? "stage"
          : "replicaSetId" in assessment
            ? "replica_convergence"
            : "scientific";
      if (
        assessment.id !== id ||
        assessment.revision !== revision ||
        assessment.missionId !== String(row.mission_id) ||
        kind !== String(row.assessment_kind) ||
        assessment.assessmentDigest !== String(row.assessment_digest)
      ) {
        throw new ScientificIntegrityError("MD assessment columns are corrupt", {
          id,
          revision,
        });
      }
      return assessment;
    });
  }
}
