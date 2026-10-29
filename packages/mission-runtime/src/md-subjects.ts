/** Resolve and transition reviewed scientific subjects in the caller-owned transaction. */
import {
  ReplicaSetSchema,
  assertForceFieldStackDigest,
  assertMdStageResultDigest,
  assertMdStageSpecDigest,
  assertMdWorkflowProtocolDigest,
  assertPublishedBiomolecularSystemManifestDigest,
  canonicalJson,
  computeMdWorkflowProtocolDigest,
  type ApprovalRequest,
  type ApprovalResponse,
  type MdScientificAssessment,
} from "@eigengrid/scientific-schema";
import {
  ScientificEntityConflictError,
  ScientificEntityNotFoundError,
  ScientificIntegrityError,
} from "./errors";
import {
  assertConfirmedOperationRelation,
  assertMdEngineAdmissionEvidenceRelations,
  resolveDecisionRequirements,
} from "./md-store-authority";
import {
  JsonRow,
  latestRevisionRow,
  lockClause,
  one,
  parseJson,
  queryRows,
} from "./md-store-queries";
import {
  assertMdProtocolForceFieldAuthority,
  computeBiomolecularDecisionMaterialDigest,
  computeMdProtocolMaterialDigest,
  computeMdReplicaSetPayloadDigest,
  parseBiomolecularDecision,
  parseMdAssessment,
} from "./md-store-validation";
import type { ScientificTransaction, SubjectSnapshot } from "./types";

/** Resolve an exact MD approval subject from its authoritative projection, never a legacy alias. */
export async function resolveMdSubjectSnapshot(
  tx: ScientificTransaction,
  provider: string,
  subjectType: Exclude<
    ApprovalRequest["subjectType"],
    "plan" | "decision" | "operation" | "result"
  >,
  subjectId: string,
  lock = false,
): Promise<SubjectSnapshot> {
  if (subjectType === "biomolecular_system_manifest") {
    const row = await latestRevisionRow<
      JsonRow & {
        id: string;
        mission_id: string;
        revision: number;
        operation_id: string;
        manifest_digest: string;
        topology_digest: string;
        coordinate_digest: string;
        atom_map_digest: string;
      }
    >(
      tx,
      provider,
      "scientific_biomolecular_system_manifests",
      "biomolecular system manifest",
      subjectId,
      lock,
    );
    const manifest = assertPublishedBiomolecularSystemManifestDigest(
      parseJson(row, "system manifest"),
    );
    if (
      String(row.id) !== manifest.id ||
      String(row.id) !== subjectId ||
      String(row.mission_id) !== manifest.missionId ||
      Number(row.revision) !== manifest.revision ||
      String(row.operation_id) !== manifest.provenance.operationId ||
      String(row.manifest_digest) !== manifest.manifestDigest ||
      String(row.topology_digest) !== manifest.topologyDigest ||
      String(row.coordinate_digest) !== manifest.coordinateDigest ||
      String(row.atom_map_digest) !== manifest.atomMapDigest
    ) {
      throw new ScientificIntegrityError("System manifest digest column diverges from payload", {
        subjectId,
      });
    }
    await assertConfirmedOperationRelation(tx, manifest.missionId, manifest.provenance.operationId);
    const requiredDecisions = manifest.decisionRefs.map((decision) => ({
      id: decision.id,
      revision: decision.revision,
      digest: decision.decisionDigest,
      approvalRef: decision.approvalRef,
    }));
    const resolvedDecisions = await resolveDecisionRequirements(
      tx,
      manifest.missionId,
      requiredDecisions.map((decision) => decision.id),
    );
    if (canonicalJson(resolvedDecisions) !== canonicalJson(requiredDecisions)) {
      throw new ScientificIntegrityError("System manifest decision references are stale", {
        subjectId,
      });
    }
    return {
      missionId: String(row.mission_id),
      version: Number(row.revision),
      revision: Number(row.revision),
      digest: manifest.manifestDigest,
      requiredDecisionIds: requiredDecisions.map((decision) => decision.id),
      requiredDecisions,
    };
  }

  if (subjectType === "md_protocol") {
    const row = await latestRevisionRow<
      JsonRow & {
        mission_id: string;
        revision: number;
        plan_id: string;
        plan_version: number;
        system_manifest_id: string;
        system_manifest_revision: number;
        material_digest: string;
        protocol_digest: string;
      }
    >(tx, provider, "scientific_md_protocols", "MD protocol", subjectId, lock);
    const protocol = assertMdWorkflowProtocolDigest(parseJson(row, "MD protocol"));
    const materialDigest = computeMdProtocolMaterialDigest(protocol);
    if (
      protocol.id !== subjectId ||
      protocol.missionId !== String(row.mission_id) ||
      protocol.revision !== Number(row.revision) ||
      protocol.system.id !== String(row.system_manifest_id) ||
      protocol.system.revision !== Number(row.system_manifest_revision) ||
      String(row.protocol_digest) !== protocol.protocolDigest ||
      String(row.material_digest) !== materialDigest ||
      materialDigest !== protocol.protocolDigest
    ) {
      throw new ScientificIntegrityError("MD protocol digest columns diverge from payload", {
        subjectId,
      });
    }
    const plan = await one<{ mission_id: string; version: number }>(
      tx,
      "SELECT mission_id, version FROM scientific_plans WHERE id = $1",
      [row.plan_id],
    );
    const system = await one<
      JsonRow & {
        mission_id: string;
        manifest_digest: string;
        topology_digest: string;
        coordinate_digest: string;
        atom_map_digest: string;
      }
    >(
      tx,
      `SELECT mission_id, manifest_digest, topology_digest, coordinate_digest, atom_map_digest,
              payload_json
       FROM scientific_biomolecular_system_manifests WHERE id = $1 AND revision = $2`,
      [protocol.system.id, protocol.system.revision],
    );
    if (
      !plan ||
      String(plan.mission_id) !== protocol.missionId ||
      Number(plan.version) !== Number(row.plan_version) ||
      !system ||
      String(system.mission_id) !== protocol.missionId ||
      String(system.manifest_digest) !== protocol.system.manifestDigest ||
      String(system.topology_digest) !== protocol.system.topologyDigest ||
      String(system.coordinate_digest) !== protocol.system.coordinateDigest ||
      String(system.atom_map_digest) !== protocol.system.atomMapDigest
    ) {
      throw new ScientificIntegrityError("MD protocol plan or system relation is stale", {
        subjectId,
      });
    }
    const manifest = assertPublishedBiomolecularSystemManifestDigest(
      parseJson(system, "MD protocol system manifest"),
    );
    const stackRow = await one<JsonRow & { mission_id: string; stack_digest: string }>(
      tx,
      `SELECT mission_id, stack_digest, payload_json
       FROM scientific_force_field_stack_revisions WHERE id = $1 AND revision = $2`,
      [manifest.forceFieldStack.id, manifest.forceFieldStack.revision],
    );
    if (!stackRow) {
      throw new ScientificIntegrityError("MD protocol force-field authority is missing", {
        subjectId,
      });
    }
    const stack = assertForceFieldStackDigest(parseJson(stackRow, "MD protocol force-field stack"));
    if (
      manifest.missionId !== protocol.missionId ||
      String(stackRow.mission_id) !== protocol.missionId ||
      String(stackRow.stack_digest) !== stack.stackDigest
    ) {
      throw new ScientificIntegrityError("MD protocol force-field relation is stale", {
        subjectId,
      });
    }
    assertMdProtocolForceFieldAuthority(protocol, manifest, stack);
    await assertMdEngineAdmissionEvidenceRelations(tx, protocol);
    const requiredDecisions = await resolveDecisionRequirements(
      tx,
      String(row.mission_id),
      protocol.decisionRefs,
    );
    return {
      missionId: String(row.mission_id),
      version: Number(row.revision),
      revision: Number(row.revision),
      digest: materialDigest,
      requiredDecisionIds: [...protocol.decisionRefs],
      requiredDecisions,
    };
  }

  if (subjectType === "md_stage") {
    const row = await latestRevisionRow<
      JsonRow & {
        mission_id: string;
        revision: number;
        protocol_id: string;
        protocol_revision: number;
        sequence: number;
        stage_kind: string;
        stage_digest: string;
      }
    >(tx, provider, "scientific_md_stage_specs", "MD stage", subjectId, lock);
    const stage = assertMdStageSpecDigest(parseJson(row, "MD stage"));
    if (
      stage.id !== subjectId ||
      stage.revision !== Number(row.revision) ||
      stage.sequence !== Number(row.sequence) ||
      stage.kind !== String(row.stage_kind) ||
      String(row.stage_digest) !== stage.stageDigest
    ) {
      throw new ScientificIntegrityError("MD stage digest column diverges from payload", {
        subjectId,
      });
    }
    const parentProtocol = await one<JsonRow & { mission_id: string }>(
      tx,
      `SELECT mission_id, payload_json FROM scientific_md_protocols
       WHERE id = $1 AND revision = $2`,
      [row.protocol_id, row.protocol_revision],
    );
    if (!parentProtocol || String(parentProtocol.mission_id) !== String(row.mission_id)) {
      throw new ScientificIntegrityError("MD stage protocol relation is missing", { subjectId });
    }
    const parsedParent = assertMdWorkflowProtocolDigest(
      parseJson(parentProtocol, "MD stage parent protocol"),
    );
    const embeddedStage = parsedParent.stages.find(
      (candidate) => candidate.id === stage.id && candidate.revision === stage.revision,
    );
    if (!embeddedStage || embeddedStage.stageDigest !== stage.stageDigest) {
      throw new ScientificIntegrityError("MD stage is not bound to its exact protocol", {
        subjectId,
      });
    }
    const requiredDecisions = await resolveDecisionRequirements(
      tx,
      String(row.mission_id),
      stage.sourceDecisionRefs,
    );
    return {
      missionId: String(row.mission_id),
      version: Number(row.revision),
      revision: Number(row.revision),
      digest: stage.stageDigest,
      requiredDecisionIds: [...stage.sourceDecisionRefs],
      requiredDecisions,
    };
  }

  if (subjectType === "replica_set") {
    const row = await latestRevisionRow<
      JsonRow & {
        mission_id: string;
        revision: number;
        protocol_id: string;
        protocol_revision: number;
        protocol_digest: string;
        replica_count: number;
        seed_policy_digest: string;
        payload_digest: string;
      }
    >(tx, provider, "scientific_md_replica_set_revisions", "MD replica set", subjectId, lock);
    const replicaSet = ReplicaSetSchema.parse(parseJson(row, "MD replica set"));
    const payloadDigest = computeMdReplicaSetPayloadDigest(replicaSet);
    if (
      replicaSet.id !== subjectId ||
      replicaSet.missionId !== String(row.mission_id) ||
      replicaSet.revision !== Number(row.revision) ||
      replicaSet.protocolId !== String(row.protocol_id) ||
      replicaSet.protocolRevision !== Number(row.protocol_revision) ||
      replicaSet.protocolDigest !== String(row.protocol_digest) ||
      replicaSet.replicaCount !== Number(row.replica_count) ||
      replicaSet.seedPolicyDigest !== String(row.seed_policy_digest) ||
      String(row.payload_digest) !== payloadDigest
    ) {
      throw new ScientificIntegrityError("Replica-set digest column diverges from payload", {
        subjectId,
      });
    }
    const replicaProtocol = await one<{ mission_id: string; protocol_digest: string }>(
      tx,
      `SELECT mission_id, protocol_digest FROM scientific_md_protocols
       WHERE id = $1 AND revision = $2`,
      [replicaSet.protocolId, replicaSet.protocolRevision],
    );
    if (
      !replicaProtocol ||
      String(replicaProtocol.mission_id) !== replicaSet.missionId ||
      String(replicaProtocol.protocol_digest) !== replicaSet.protocolDigest
    ) {
      throw new ScientificIntegrityError("Replica set protocol relation is stale", { subjectId });
    }
    const requiredDecisions = await resolveDecisionRequirements(tx, String(row.mission_id), [
      replicaSet.decisionRef,
    ]);
    return {
      missionId: String(row.mission_id),
      version: Number(row.revision),
      revision: Number(row.revision),
      digest: payloadDigest,
      requiredDecisionIds: [replicaSet.decisionRef],
      requiredDecisions,
    };
  }

  const row = await latestRevisionRow<
    JsonRow & {
      mission_id: string;
      revision: number;
      assessment_kind: string;
      subject_id: string;
      subject_revision: number;
      operation_id: string;
      operation_receipt_id: string;
      assessment_digest: string;
    }
  >(tx, provider, "scientific_md_assessments", "MD assessment", subjectId, lock);
  const assessment = parseMdAssessment(parseJson(row, "MD assessment"));
  const assessmentKind =
    "stageResultId" in assessment
      ? "stage"
      : "replicaSetId" in assessment
        ? "replica_convergence"
        : "scientific";
  const assessmentSubjectId =
    "stageResultId" in assessment
      ? assessment.stageResultId
      : "replicaSetId" in assessment
        ? assessment.replicaSetId
        : assessment.protocolId;
  if (
    assessment.id !== subjectId ||
    assessment.missionId !== String(row.mission_id) ||
    assessment.revision !== Number(row.revision) ||
    assessmentKind !== String(row.assessment_kind) ||
    assessmentSubjectId !== String(row.subject_id) ||
    String(row.assessment_digest) !== assessment.assessmentDigest
  ) {
    throw new ScientificIntegrityError("MD assessment digest column diverges from payload", {
      subjectId,
    });
  }
  await assertConfirmedOperationRelation(
    tx,
    assessment.missionId,
    String(row.operation_id),
    String(row.operation_receipt_id),
  );
  if (assessmentKind === "stage") {
    const result = await one<
      JsonRow & { mission_id: string; revision: number; result_digest: string }
    >(
      tx,
      "SELECT mission_id, revision, result_digest, payload_json FROM scientific_md_stage_results WHERE id = $1",
      [assessmentSubjectId],
    );
    if (!result || Number(result.revision) !== Number(row.subject_revision)) {
      throw new ScientificIntegrityError("Stage assessment subject revision is stale", {
        subjectId,
      });
    }
    const parsedResult = assertMdStageResultDigest(parseJson(result, "MD stage result"));
    if (
      parsedResult.missionId !== assessment.missionId ||
      parsedResult.revision !== Number(row.subject_revision) ||
      parsedResult.resultDigest !== String(result.result_digest) ||
      !("stageResultId" in assessment) ||
      assessment.stageResultRevision !== parsedResult.revision ||
      assessment.stageResultDigest !== parsedResult.resultDigest
    ) {
      throw new ScientificIntegrityError("Stage assessment result relation is corrupt", {
        subjectId,
      });
    }
  } else if (assessmentKind === "replica_convergence") {
    const replica = await one<{ mission_id: string; payload_digest: string }>(
      tx,
      `SELECT mission_id, payload_digest FROM scientific_md_replica_set_revisions
       WHERE id = $1 AND revision = $2`,
      [assessmentSubjectId, row.subject_revision],
    );
    if (!replica || String(replica.mission_id) !== assessment.missionId) {
      throw new ScientificIntegrityError("Replica assessment subject revision is stale", {
        subjectId,
      });
    }
  } else {
    const scientific = assessment as MdScientificAssessment;
    const protocol = await one<{ mission_id: string; protocol_digest: string }>(
      tx,
      `SELECT mission_id, protocol_digest FROM scientific_md_protocols
       WHERE id = $1 AND revision = $2`,
      [scientific.protocolId, row.subject_revision],
    );
    if (
      !protocol ||
      String(protocol.mission_id) !== scientific.missionId ||
      String(protocol.protocol_digest) !== scientific.protocolDigest
    ) {
      throw new ScientificIntegrityError("Scientific assessment protocol relation is stale", {
        subjectId,
      });
    }
  }
  const ids = "decisionRefs" in assessment ? assessment.decisionRefs : [];
  const requiredDecisions = await resolveDecisionRequirements(tx, String(row.mission_id), ids);
  return {
    missionId: String(row.mission_id),
    version: Number(row.revision),
    revision: Number(row.revision),
    digest: assessment.assessmentDigest,
    requiredDecisionIds: [...ids],
    requiredDecisions,
  };
}

/** Apply lifecycle-only approval transitions while preserving each material digest column. */
export async function transitionReviewedMdSubject(
  tx: ScientificTransaction,
  provider: string,
  request: ApprovalRequest,
  response: ApprovalResponse,
): Promise<void> {
  if (request.subjectType === "decision") {
    const rows = await queryRows<JsonRow & { material_digest: string; revision: number }>(
      tx,
      `SELECT * FROM scientific_biomolecular_decisions
       WHERE id = $1 AND revision = $2${lockClause(provider, true)}`,
      [request.subjectId, request.subjectRevision],
    );
    if (rows.length === 0) return;
    const row = rows[0]!;
    const current = parseBiomolecularDecision(parseJson(row, "biomolecular decision"));
    if (current.status !== "proposed") {
      throw new ScientificIntegrityError("Biomolecular decision is not under review", {
        decisionId: current.id,
        status: current.status,
      });
    }
    const next = parseBiomolecularDecision({
      ...current,
      status: response.decision === "approved" ? ("approved" as const) : ("rejected" as const),
      approvalRef: response.decision === "approved" ? request.id : undefined,
      approvedAt: response.decision === "approved" ? response.decidedAt : undefined,
      decisionDigest: current.decisionDigest,
    });
    if (computeBiomolecularDecisionMaterialDigest(next) !== String(row.material_digest)) {
      throw new ScientificIntegrityError("Decision approval changed material scientific content", {
        decisionId: current.id,
      });
    }
    const changed = await queryRows<{ id: string }>(
      tx,
      `UPDATE scientific_biomolecular_decisions
       SET review_status = $1, decision_digest = $2, approval_ref = $3,
           payload_json = $4, updated_at = $5
       WHERE id = $6 AND revision = $7 AND material_digest = $8
       RETURNING id`,
      [
        next.status,
        next.decisionDigest,
        next.approvalRef ?? null,
        canonicalJson(next),
        response.decidedAt,
        next.id,
        next.revision,
        row.material_digest,
      ],
    );
    if (changed.length !== 1) {
      throw new ScientificEntityConflictError(
        "biomolecular decision",
        current.id,
        "approval transition lost its exact material revision",
      );
    }
    return;
  }

  if (request.subjectType !== "md_protocol" || response.decision !== "approved") return;
  const row = await one<JsonRow & { material_digest: string; revision: number }>(
    tx,
    `SELECT * FROM scientific_md_protocols
     WHERE id = $1 AND revision = $2${lockClause(provider, true)}`,
    [request.subjectId, request.subjectRevision],
  );
  if (!row) throw new ScientificEntityNotFoundError("MD protocol", request.subjectId);
  const current = assertMdWorkflowProtocolDigest(parseJson(row, "MD protocol"));
  if (current.status !== "under_review") {
    throw new ScientificIntegrityError("MD protocol is not under review", {
      protocolId: current.id,
      status: current.status,
    });
  }
  const transitionBase = {
    ...current,
    status: "approved" as const,
    approvedByRef: request.id,
    updatedAt: response.decidedAt,
    protocolDigest: "0".repeat(64),
  };
  const next = assertMdWorkflowProtocolDigest({
    ...transitionBase,
    protocolDigest: computeMdWorkflowProtocolDigest(transitionBase),
  });
  if (computeMdProtocolMaterialDigest(next) !== String(row.material_digest)) {
    throw new ScientificIntegrityError("Protocol approval changed material scientific content", {
      protocolId: current.id,
    });
  }
  const changed = await queryRows<{ id: string }>(
    tx,
    `UPDATE scientific_md_protocols
     SET review_status = 'approved', protocol_digest = $1, payload_json = $2, updated_at = $3
     WHERE id = $4 AND revision = $5 AND material_digest = $6
     RETURNING id`,
    [
      next.protocolDigest,
      canonicalJson(next),
      next.updatedAt,
      next.id,
      next.revision,
      row.material_digest,
    ],
  );
  if (changed.length !== 1) {
    throw new ScientificEntityConflictError(
      "MD protocol",
      current.id,
      "approval transition lost its exact material revision",
    );
  }
}
