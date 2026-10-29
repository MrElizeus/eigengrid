/** Synthetic transaction fixture. The production byte decoder is tested separately. */
import {
  type ContentAddressedArtifactStore,
  mdPostprocessingIds,
  type MdStageFinalizationInput,
  type MdPostprocessingLease,
  type MdResultCollection,
} from "@eigengrid/mission-runtime";
import {
  computeMdStageResultDigest,
  computeMdStageAssessmentDigest,
  digestCanonical,
  canonicalJson,
  MdStageResultSchema,
  MdStageAssessmentSchema,
  type MdStageSpec,
  type EngineBuildIdentity,
} from "@eigengrid/scientific-schema";

export async function finalizationFixture(input: {
  cas: ContentAddressedArtifactStore;
  collection: MdResultCollection;
  stage: MdStageSpec;
  protocol: { id: string; revision: number; protocolDigest: string };
  lease: MdPostprocessingLease;
  engine: EngineBuildIdentity;
  now: string;
}): Promise<MdStageFinalizationInput> {
  const { cas, collection, stage, protocol, lease, engine, now } = input,
    ids = mdPostprocessingIds(lease.operationId);
  const unsigned = {
    schemaVersion: "eigengrid.md-stage-result/v1" as const,
    id: ids.resultId,
    revision: 1,
    missionId: "mission-md-1",
    workUnitId: lease.workUnitId,
    operationId: lease.operationId,
    operationReceiptId: `receipt-md-${digestCanonical({ operationId: lease.operationId })}`,
    protocolId: protocol.id,
    protocolRevision: protocol.revision,
    protocolDigest: protocol.protocolDigest,
    stageId: stage.id,
    stageRevision: stage.revision,
    stageDigest: stage.stageDigest,
    stageKind: stage.kind,
    terminalReason: "completed" as const,
    exitCode: 0,
    signal: null,
    startedAt: collection.collectedAt,
    finishedAt: collection.collectedAt,
    startStep: 0,
    endStep: stage.steps,
    startTimePs: 0,
    endTimePs: stage.simulatedTimePs ?? 0,
    engine,
    artifacts: stage.outputs.map((o) => {
      const a = collection.artifacts.find((a) => a.role === `output_stage_${o.role}`)!;
      return {
        artifactId: `${ids.resultId}-${o.role}`,
        role: o.role,
        contentDigest: a.sha256,
        evidenceRef: `evidence-md-${digestCanonical({ operationId: lease.operationId, role: a.role })}`,
        mediaType: a.mediaType,
        sizeBytes: a.sizeBytes,
      };
    }),
    warnings: [],
    errors: [],
    validationStatus: "passed" as const,
    validationRefs: [ids.validationId],
  };
  const result = MdStageResultSchema.parse({
    ...unsigned,
    resultDigest: computeMdStageResultDigest(unsigned),
  });
  const assessmentUnsigned = {
    schemaVersion: "eigengrid.md-assessment/v1" as const,
    id: ids.assessmentId,
    revision: 1,
    missionId: result.missionId,
    stageResultId: result.id,
    stageResultRevision: 1,
    stageResultDigest: result.resultDigest,
    status: "accepted" as const,
    evaluations: stage.acceptanceCriteria.map((c) => ({
      criterionId: c.id,
      criterionDigest: c.criterionDigest,
      required: c.required,
      status: "passed" as const,
      summary: "Synthetic deterministic persistence fixture, not scientific qualification",
      evidenceRefs: [ids.evidenceId],
    })),
    nextStageEligible: true,
    limitations: ["synthetic metadata fixture"],
    evidenceRefs: [ids.evidenceId],
    assessor: { kind: "service" as const, id: "md-fixture", role: "deterministic_validator" },
    createdAt: now,
  };
  const assessment = MdStageAssessmentSchema.parse({
    ...assessmentUnsigned,
    assessmentDigest: computeMdStageAssessmentDigest(assessmentUnsigned),
  });
  const validation = {
    id: ids.validationId,
    missionId: result.missionId,
    workUnitId: result.workUnitId,
    criterionId: "a3-byte-integrity",
    status: "passed" as const,
    summary: "Test-only synthetic projection fixture",
    observationRefs: [ids.observationId],
    evidenceRefs: [ids.evidenceId],
    validatorVersion: "1.0.0",
    createdAt: now,
  };
  const report = {
    schemaVersion: "eigengrid.md-postprocessing-report/v1",
    source: "synthetic_test_only",
    collectionDigest: digestCanonical(collection),
    result,
    assessment,
    validation,
  };
  const stored = await cas.put(Buffer.from(canonicalJson(report)));
  return {
    lease,
    collectionDigest: digestCanonical(collection),
    result,
    assessment,
    validation,
    inspectionEvidence: {
      id: ids.evidenceId,
      missionId: result.missionId,
      workUnitId: result.workUnitId,
      kind: "analysis_result",
      uri: stored.uri,
      contentDigest: stored.digest,
      sizeBytes: stored.sizeBytes,
      mediaType: "application/vnd.eigengrid.md-postprocessing+json",
      immutable: true,
      sourceId: ids.analysisReceiptId,
      createdAt: now,
    },
    inspectionObservation: {
      id: ids.observationId,
      missionId: result.missionId,
      workUnitId: result.workUnitId,
      type: "artifact_integrity",
      payload: { reportDigest: stored.digest, collectionDigest: digestCanonical(collection) },
      source: { kind: "validator", id: ids.analysisReceiptId },
      evidenceRefs: [ids.evidenceId],
      qualityFlags: ["synthetic_test_only"],
      observedAt: now,
    },
  };
}
