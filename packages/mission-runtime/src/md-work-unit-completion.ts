/** Atomic completion gates and verified parent dependencies for MD continuation. */
import {
  BiomolecularMaterialPublicationBindingSchema,
  BiomolecularSystemBuildWorkUnitParametersSchema,
  MdExecutionBindingParametersSchema,
  ReplicaSetSchema,
  WorkUnitSchema,
  assertMdStageResultDigest,
  assertMdStageSpecDigest,
  assertMdWorkflowProtocolDigest,
  assertPublishedBiomolecularSystemManifestDigest,
  canonicalJson,
  type MdStageResult,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import {
  ScientificEntityConflictError,
  ScientificEntityNotFoundError,
  ScientificIntegrityError,
} from "./errors";
import { assertConfirmedOperationRelation } from "./md-store-authority";
import { JsonRow, lockClause, one, parseJson, queryRows } from "./md-store-queries";
import {
  CompleteMdWorkUnitAuthority,
  assertCanonicalSetEqual,
  assertMdStageOperationRequestAuthority,
  createMdStageAssessmentOperationRequest,
  parseMdAssessment,
  workUnitUsesMdExecutionBinding,
} from "./md-store-validation";
import type { ScientificTransaction } from "./types";

/**
 * Persist the immutable authority that permits an MD WorkUnit to become
 * succeeded. The caller must update the canonical WorkUnit in the same
 * database transaction.
 */
export async function persistMdWorkUnitCompletionGate(
  tx: ScientificTransaction,
  provider: string,
  workUnit: WorkUnit,
  authority: CompleteMdWorkUnitAuthority,
): Promise<void> {
  if (!workUnitUsesMdExecutionBinding(workUnit)) {
    throw new ScientificIntegrityError("MD completion requires an MD execution WorkUnit", {
      workUnitId: workUnit.id,
    });
  }
  const binding = MdExecutionBindingParametersSchema.parse(workUnit.protocolFragment.parameters);
  if (workUnit.state !== "observing") {
    throw new ScientificIntegrityError("MD completion requires an observing WorkUnit", {
      workUnitId: workUnit.id,
      state: workUnit.state,
    });
  }

  const resultRow = await one<
    JsonRow & {
      revision: number;
      mission_id: string;
      result_digest: string;
      binding_work_unit_id: string;
    }
  >(
    tx,
    `SELECT result.revision, result.mission_id, result.result_digest,
            binding.work_unit_id AS binding_work_unit_id, result.payload_json
     FROM scientific_md_stage_results AS result
     JOIN scientific_md_stage_bindings AS binding ON binding.id = result.stage_binding_id
     WHERE result.id = $1${lockClause(provider, true)}`,
    [authority.stageResultId],
  );
  if (!resultRow) {
    throw new ScientificEntityNotFoundError("MD stage result", authority.stageResultId);
  }
  const result = assertMdStageResultDigest(parseJson(resultRow, "MD completion stage result"));
  if (
    result.id !== authority.stageResultId ||
    result.resultDigest !== authority.stageResultDigest ||
    String(resultRow.result_digest) !== authority.stageResultDigest ||
    result.revision !== Number(resultRow.revision) ||
    result.missionId !== workUnit.missionId ||
    String(resultRow.mission_id) !== workUnit.missionId ||
    result.workUnitId !== workUnit.id ||
    String(resultRow.binding_work_unit_id) !== workUnit.id ||
    result.protocolId !== binding.protocol.id ||
    result.protocolRevision !== binding.protocol.revision ||
    result.protocolDigest !== binding.protocol.digest ||
    result.stageId !== binding.stage.id ||
    result.stageRevision !== binding.stage.revision ||
    result.stageDigest !== binding.stage.digest ||
    result.stageKind !== binding.stage.kind ||
    result.terminalReason !== "completed" ||
    result.validationStatus !== "passed" ||
    result.validationRefs.length === 0
  ) {
    throw new ScientificIntegrityError(
      "MD completion result is not the exact successful result for this WorkUnit",
      { workUnitId: workUnit.id, resultId: authority.stageResultId },
    );
  }
  const resultOperation = await assertConfirmedOperationRelation(
    tx,
    workUnit.missionId,
    result.operationId,
    result.operationReceiptId,
  );
  if (
    resultOperation.workUnitId !== workUnit.id ||
    resultOperation.operation.kind !== "md_stage_execution"
  ) {
    throw new ScientificIntegrityError(
      "MD completion result operation is outside its exact WorkUnit request",
      { workUnitId: workUnit.id, resultId: result.id },
    );
  }
  assertMdStageOperationRequestAuthority(workUnit, resultOperation.operation.request, result);

  const assessmentRow = await one<
    JsonRow & {
      mission_id: string;
      assessment_kind: string;
      subject_id: string;
      subject_revision: number;
      operation_id: string;
      operation_receipt_id: string;
      assessment_digest: string;
    }
  >(
    tx,
    `SELECT mission_id, assessment_kind, subject_id, subject_revision, operation_id,
            operation_receipt_id, assessment_digest, payload_json
     FROM scientific_md_assessments
     WHERE id = $1 AND revision = $2${lockClause(provider, true)}`,
    [authority.assessmentId, authority.assessmentRevision],
  );
  if (!assessmentRow) {
    throw new ScientificEntityNotFoundError("MD stage assessment", authority.assessmentId);
  }
  const assessment = parseMdAssessment(parseJson(assessmentRow, "MD completion assessment"));
  if (
    !("stageResultId" in assessment) ||
    assessment.id !== authority.assessmentId ||
    assessment.revision !== authority.assessmentRevision ||
    assessment.assessmentDigest !== authority.assessmentDigest ||
    String(assessmentRow.assessment_digest) !== authority.assessmentDigest ||
    assessment.missionId !== workUnit.missionId ||
    String(assessmentRow.mission_id) !== workUnit.missionId ||
    String(assessmentRow.assessment_kind) !== "stage" ||
    assessment.stageResultId !== result.id ||
    assessment.stageResultRevision !== result.revision ||
    assessment.stageResultDigest !== result.resultDigest ||
    String(assessmentRow.subject_id) !== result.id ||
    Number(assessmentRow.subject_revision) !== result.revision ||
    assessment.status !== "accepted" ||
    assessment.nextStageEligible !== true ||
    Date.parse(authority.completedAt) < Date.parse(result.finishedAt) ||
    Date.parse(authority.completedAt) < Date.parse(assessment.createdAt) ||
    assessment.evaluations.some(
      (evaluation) => evaluation.required && evaluation.status !== "passed",
    )
  ) {
    throw new ScientificIntegrityError(
      "MD completion requires the exact accepted assessment for its stage result",
      { workUnitId: workUnit.id, assessmentId: authority.assessmentId },
    );
  }
  const assessmentOperation = await assertConfirmedOperationRelation(
    tx,
    workUnit.missionId,
    String(assessmentRow.operation_id),
    String(assessmentRow.operation_receipt_id),
  );
  if (
    assessmentOperation.workUnitId !== workUnit.id ||
    assessmentOperation.operation.kind !== "trajectory_analysis" ||
    canonicalJson(assessmentOperation.operation.request) !==
      canonicalJson(
        createMdStageAssessmentOperationRequest({
          workUnitId: workUnit.id,
          stageResult: result,
          assessment,
        }),
      )
  ) {
    throw new ScientificIntegrityError(
      "MD completion assessment operation belongs to another WorkUnit or capability",
      { workUnitId: workUnit.id, assessmentId: assessment.id },
    );
  }

  const stageRow = await one<JsonRow>(
    tx,
    `SELECT payload_json FROM scientific_md_stage_specs
     WHERE id = $1 AND revision = $2 AND protocol_id = $3 AND protocol_revision = $4`,
    [result.stageId, result.stageRevision, result.protocolId, result.protocolRevision],
  );
  if (!stageRow) throw new ScientificEntityNotFoundError("MD stage", result.stageId);
  const stage = assertMdStageSpecDigest(parseJson(stageRow, "MD completion stage"));
  assertCanonicalSetEqual(
    "MD completion acceptance criteria",
    assessment.evaluations.map((evaluation) => ({
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

  const gatePayload = canonicalJson({
    schemaVersion: "eigengrid.md-work-unit-completion-gate/v1",
    workUnitId: workUnit.id,
    missionId: workUnit.missionId,
    stageResult: {
      id: result.id,
      revision: result.revision,
      digest: result.resultDigest,
    },
    assessment: {
      id: assessment.id,
      revision: assessment.revision,
      digest: assessment.assessmentDigest,
    },
    completedAt: authority.completedAt,
  });
  const inserted = await queryRows<{ work_unit_id: string }>(
    tx,
    `INSERT INTO scientific_md_work_unit_completion_gates
     (work_unit_id, mission_id, stage_result_id, stage_result_digest,
      assessment_id, assessment_revision, assessment_digest, payload_json, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT DO NOTHING RETURNING work_unit_id`,
    [
      workUnit.id,
      workUnit.missionId,
      result.id,
      result.resultDigest,
      assessment.id,
      assessment.revision,
      assessment.assessmentDigest,
      gatePayload,
      authority.completedAt,
    ],
  );
  if (inserted.length === 0) {
    const existing = await one<
      JsonRow & {
        mission_id: string;
        stage_result_id: string;
        stage_result_digest: string;
        assessment_id: string;
        assessment_revision: number;
        assessment_digest: string;
        completed_at: string;
      }
    >(
      tx,
      `SELECT mission_id, stage_result_id, stage_result_digest, assessment_id,
              assessment_revision, assessment_digest, completed_at, payload_json
       FROM scientific_md_work_unit_completion_gates WHERE work_unit_id = $1`,
      [workUnit.id],
    );
    if (
      !existing ||
      String(existing.mission_id) !== workUnit.missionId ||
      String(existing.stage_result_id) !== result.id ||
      String(existing.stage_result_digest) !== result.resultDigest ||
      String(existing.assessment_id) !== assessment.id ||
      Number(existing.assessment_revision) !== assessment.revision ||
      String(existing.assessment_digest) !== assessment.assessmentDigest ||
      String(existing.completed_at) !== authority.completedAt ||
      String(existing.payload_json) !== gatePayload
    ) {
      throw new ScientificEntityConflictError(
        "MD WorkUnit completion gate",
        workUnit.id,
        "an immutable completion authority already exists",
      );
    }
  }
}

export async function loadGatedMdStageResult(
  tx: ScientificTransaction,
  workUnitId: string,
): Promise<MdStageResult | null> {
  const row = await one<
    JsonRow & {
      gate_mission_id: string;
      gate_result_id: string;
      gate_result_digest: string;
      gate_assessment_id: string;
      gate_assessment_revision: number;
      gate_assessment_digest: string;
      completed_at: string;
      result_revision: number;
      result_mission_id: string;
      result_digest: string;
      binding_work_unit_id: string;
      gate_payload_json: string;
    }
  >(
    tx,
    `SELECT gate.mission_id AS gate_mission_id, gate.stage_result_id AS gate_result_id,
            gate.stage_result_digest AS gate_result_digest,
            gate.assessment_id AS gate_assessment_id,
            gate.assessment_revision AS gate_assessment_revision,
            gate.assessment_digest AS gate_assessment_digest, gate.completed_at,
            result.revision AS result_revision, result.mission_id AS result_mission_id,
            result.result_digest, binding.work_unit_id AS binding_work_unit_id,
            gate.payload_json AS gate_payload_json, result.payload_json
     FROM scientific_md_work_unit_completion_gates AS gate
     JOIN scientific_md_stage_results AS result ON result.id = gate.stage_result_id
     JOIN scientific_md_stage_bindings AS binding ON binding.id = result.stage_binding_id
     WHERE gate.work_unit_id = $1`,
    [workUnitId],
  );
  if (!row) return null;
  const result = assertMdStageResultDigest(parseJson(row, "gated MD parent result"));
  const expectedGatePayload = canonicalJson({
    schemaVersion: "eigengrid.md-work-unit-completion-gate/v1",
    workUnitId,
    missionId: result.missionId,
    stageResult: {
      id: result.id,
      revision: result.revision,
      digest: result.resultDigest,
    },
    assessment: {
      id: String(row.gate_assessment_id),
      revision: Number(row.gate_assessment_revision),
      digest: String(row.gate_assessment_digest),
    },
    completedAt: String(row.completed_at),
  });
  if (
    String(row.gate_mission_id) !== result.missionId ||
    String(row.result_mission_id) !== result.missionId ||
    String(row.gate_result_id) !== result.id ||
    String(row.gate_result_digest) !== result.resultDigest ||
    String(row.result_digest) !== result.resultDigest ||
    Number(row.result_revision) !== result.revision ||
    String(row.binding_work_unit_id) !== workUnitId ||
    String(row.gate_payload_json) !== expectedGatePayload
  ) {
    throw new ScientificIntegrityError("MD completion-gate projection is corrupt", {
      workUnitId,
    });
  }
  return result;
}

/** Validate dependency and input evidence identities after an atomic WorkUnit batch is inserted. */
export async function assertMdWorkUnitProjectionDependencies(
  tx: ScientificTransaction,
  workUnit: WorkUnit,
): Promise<void> {
  if (workUnit.protocolFragment.kind !== "scientific_capability") return;
  if (workUnit.protocolFragment.capability.id === "biomolecular.build-system") {
    const binding = BiomolecularSystemBuildWorkUnitParametersSchema.parse(
      workUnit.protocolFragment.parameters,
    ).systemBuild;
    const effect = await one<{ work_unit_id: string; state: string }>(
      tx,
      `SELECT operation.work_unit_id, unit.state
       FROM scientific_biomolecular_material_effects AS effect
       JOIN scientific_external_operations AS operation ON operation.id = effect.operation_id
       JOIN scientific_work_units AS unit ON unit.id = operation.work_unit_id
       WHERE effect.subject_type = 'force_field_stack' AND effect.subject_id = $1
         AND effect.subject_revision = $2 AND effect.mission_id = $3 AND effect.content_digest = $4`,
      [
        binding.forceFieldStack.id,
        binding.forceFieldStack.revision,
        workUnit.missionId,
        binding.forceFieldStack.digest,
      ],
    );
    if (
      !effect ||
      String(effect.state) !== "succeeded" ||
      workUnit.dependencies.length !== 1 ||
      workUnit.dependencies[0] !== String(effect.work_unit_id)
    )
      throw new ScientificIntegrityError(
        "System-build must depend on its exact completed stack-publication WorkUnit",
      );
    return;
  }
  const materialBinding = BiomolecularMaterialPublicationBindingSchema.safeParse(
    workUnit.protocolFragment.parameters,
  );
  if (materialBinding.success) {
    if (materialBinding.data.subjectKind === "force_field_stack") {
      if (workUnit.dependencies.length !== 0) {
        throw new ScientificIntegrityError(
          "Force-field stack publication cannot inherit an unbound WorkUnit dependency",
          { workUnitId: workUnit.id },
        );
      }
      return;
    }
    const manifestEffect = await one<{ work_unit_id: string }>(
      tx,
      `SELECT operation.work_unit_id
       FROM scientific_biomolecular_manifest_effects AS effect
       JOIN scientific_external_operations AS operation ON operation.id = effect.operation_id
       WHERE effect.manifest_id = $1 AND effect.manifest_revision = $2`,
      [materialBinding.data.systemManifest.id, materialBinding.data.systemManifest.revision],
    );
    if (
      !manifestEffect ||
      workUnit.dependencies.length !== 1 ||
      workUnit.dependencies[0] !== String(manifestEffect.work_unit_id)
    ) {
      throw new ScientificIntegrityError(
        "Atom-map publication must depend on its exact system-build WorkUnit",
        { workUnitId: workUnit.id },
      );
    }
    return;
  }
  const binding = MdExecutionBindingParametersSchema.parse(workUnit.protocolFragment.parameters);
  const protocolRow = await one<JsonRow>(
    tx,
    `SELECT payload_json FROM scientific_md_protocols
     WHERE id = $1 AND revision = $2`,
    [binding.protocol.id, binding.protocol.revision],
  );
  const systemRow = await one<JsonRow>(
    tx,
    `SELECT payload_json FROM scientific_biomolecular_system_manifests
     WHERE id = $1 AND revision = $2`,
    [binding.system.id, binding.system.revision],
  );
  if (!protocolRow || !systemRow) {
    throw new ScientificIntegrityError("MD WorkUnit dependency authority is missing", {
      workUnitId: workUnit.id,
    });
  }
  const protocol = assertMdWorkflowProtocolDigest(parseJson(protocolRow, "MD WorkUnit protocol"));
  const system = assertPublishedBiomolecularSystemManifestDigest(
    parseJson(systemRow, "MD WorkUnit system"),
  );
  const stage = protocol.stages.find(
    (candidate) =>
      candidate.id === binding.stage.id && candidate.revision === binding.stage.revision,
  );
  if (!stage || stage.stageDigest !== binding.stage.digest) {
    throw new ScientificIntegrityError("MD WorkUnit stage dependency authority is stale", {
      workUnitId: workUnit.id,
    });
  }

  if (stage.kind !== "production") {
    if (stage.parentStageId === null) {
      const expectedInputs = [
        ...system.sourceEvidenceRefs,
        ...stage.inputs.map((artifact) => artifact.evidenceRef),
      ];
      assertCanonicalSetEqual("MD WorkUnit input evidence", workUnit.inputRefs, [
        ...new Set(expectedInputs),
      ]);
      if (workUnit.dependencies.length !== 0) {
        throw new ScientificIntegrityError("First MD stage cannot depend on another WorkUnit", {
          workUnitId: workUnit.id,
        });
      }
      return;
    }
    if (workUnit.dependencies.length !== 1) {
      throw new ScientificIntegrityError("A chained MD stage requires one parent WorkUnit", {
        workUnitId: workUnit.id,
      });
    }
    const parentRow = await one<JsonRow>(
      tx,
      "SELECT payload_json FROM scientific_work_units WHERE id = $1",
      [workUnit.dependencies[0]!],
    );
    if (!parentRow) {
      throw new ScientificEntityNotFoundError("parent MD WorkUnit", workUnit.dependencies[0]!);
    }
    const parent = WorkUnitSchema.parse(parseJson(parentRow, "parent MD WorkUnit"));
    const parentResult = await loadGatedMdStageResult(tx, parent.id);
    const parentRestart = parentResult?.artifacts.find((artifact) => artifact.role === "restart");
    const parentBinding = MdExecutionBindingParametersSchema.parse(
      parent.protocolFragment.parameters,
    );
    if (
      parent.state !== "succeeded" ||
      parent.missionId !== workUnit.missionId ||
      parent.planId !== workUnit.planId ||
      parentBinding.protocol.id !== binding.protocol.id ||
      parentBinding.protocol.revision !== binding.protocol.revision ||
      parentBinding.protocol.digest !== binding.protocol.digest ||
      parentBinding.stage.id !== stage.parentStageId ||
      !parentResult ||
      parentResult.stageId !== parentBinding.stage.id ||
      parentResult.stageRevision !== parentBinding.stage.revision ||
      parentResult.stageDigest !== parentBinding.stage.digest ||
      !parentRestart ||
      !binding.parentRestart ||
      canonicalJson(parentRestart) !== canonicalJson(binding.parentRestart)
    ) {
      throw new ScientificIntegrityError(
        "MD stage dependency lacks its exact accepted parent result",
        { workUnitId: workUnit.id },
      );
    }
    const expectedInputs = [
      ...system.sourceEvidenceRefs,
      ...stage.inputs.map((artifact) => artifact.evidenceRef),
      parentRestart.evidenceRef,
    ];
    assertCanonicalSetEqual("MD WorkUnit input evidence", workUnit.inputRefs, [
      ...new Set(expectedInputs),
    ]);
    return;
  }

  if (workUnit.dependencies.length !== 1) {
    throw new ScientificIntegrityError("A production segment requires one exact parent result", {
      workUnitId: workUnit.id,
    });
  }
  const segment = binding.replicaSegment!;
  const replicaRow = await one<JsonRow>(
    tx,
    `SELECT payload_json FROM scientific_md_replica_set_revisions
     WHERE id = $1 AND revision = $2`,
    [segment.replicaSetId, segment.replicaSetRevision],
  );
  if (!replicaRow) {
    throw new ScientificEntityNotFoundError("MD replica set", segment.replicaSetId);
  }
  const replicaSet = ReplicaSetSchema.parse(parseJson(replicaRow, "MD replica set"));
  const replica = replicaSet.replicas.find((candidate) => candidate.id === segment.replicaId);
  if (!replica) {
    throw new ScientificIntegrityError("Production WorkUnit names an unknown replica", {
      workUnitId: workUnit.id,
    });
  }
  const parent = await loadGatedMdStageResult(tx, workUnit.dependencies[0]!);
  if (!parent) {
    throw new ScientificIntegrityError(
      "Production WorkUnit requires its accepted parent completion gate",
      { workUnitId: workUnit.id, parentWorkUnitId: workUnit.dependencies[0] },
    );
  }
  const parentRestart = parent.artifacts.find((artifact) => artifact.role === "restart");
  if (
    parent.missionId !== workUnit.missionId ||
    parent.protocolId !== protocol.id ||
    parent.protocolRevision !== protocol.revision ||
    parent.protocolDigest !== protocol.protocolDigest ||
    parent.terminalReason !== "completed" ||
    !parentRestart ||
    !binding.parentRestart ||
    canonicalJson(parentRestart) !== canonicalJson(binding.parentRestart)
  ) {
    throw new ScientificIntegrityError("Production WorkUnit parent result is stale", {
      workUnitId: workUnit.id,
    });
  }
  if (segment.segmentIndex === 0) {
    const parentStage = protocol.stages.find((candidate) => candidate.id === stage.parentStageId);
    if (
      !parentStage ||
      parent.stageId !== parentStage.id ||
      parent.stageRevision !== parentStage.revision ||
      parent.stageDigest !== parentStage.stageDigest ||
      parentRestart.contentDigest !== replica.initialRestart.contentDigest ||
      parentRestart.evidenceRef !== replica.initialRestart.evidenceRef
    ) {
      throw new ScientificIntegrityError(
        "First production segment does not continue its exact validated parent stage",
        { workUnitId: workUnit.id },
      );
    }
  } else if (
    parent.stageId !== stage.id ||
    parent.stageRevision !== stage.revision ||
    parent.stageDigest !== stage.stageDigest ||
    parent.replicaSetId !== replicaSet.id ||
    parent.replicaSetRevision !== replicaSet.revision ||
    parent.replicaSetDigest !== segment.replicaSetDigest ||
    parent.replicaId !== replica.id ||
    parent.segmentIndex !== segment.segmentIndex - 1
  ) {
    throw new ScientificIntegrityError(
      "Production WorkUnit does not continue the immediately preceding segment",
      { workUnitId: workUnit.id },
    );
  }
  const expectedInputs = [
    ...system.sourceEvidenceRefs,
    ...stage.inputs
      .filter((artifact) => artifact.role !== "parent_restart")
      .map((artifact) => artifact.evidenceRef),
    parentRestart.evidenceRef,
  ];
  assertCanonicalSetEqual("Production WorkUnit input evidence", workUnit.inputRefs, [
    ...new Set(expectedInputs),
  ]);
}
