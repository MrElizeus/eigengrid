/** the mission runtime's atomic bridge from collected MD bytes to canonical projections.
 * This is an INTERNAL Head service, not a user/model/HTTP mutation capability.
 * It uses the existing WorkUnit, lease, operation, projection and observation tables.
 * It cannot submit/retry a job, select a shell command or grant scientific authority.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DigestSchema,
  IdSchema,
  TimestampSchema,
  EvidenceReferenceSchema,
  ScientificObservationSchema,
  ValidationResultSchema,
  WorkUnitSchema,
  MdExecutionBindingParametersSchema,
  assertMdStageResultDigest,
  assertMdWorkflowProtocolDigest,
  ScientificPlanSchema,
  assertPublishedBiomolecularSystemManifestDigest,
  assertMdStageAssessmentDigest,
  assertTrajectorySegmentDigest,
  canonicalJson,
  digestCanonical,
  type EvidenceReference,
  type MdStageResult,
  type MdStageAssessment,
  type TrajectorySegment,
  type ValidationResult,
  type ScientificObservation,
  type WorkUnit,
  type ApprovalRequest,
  type MdEnvironmentCapabilitySnapshot,
  OperationReceiptSchema,
  ApprovalRequestSchema,
  MdReplicaSetSchema,
  computeMdReplicaSetDigest,
} from "@eigengrid/scientific-schema";
import {
  compileMdNextStage,
  compileMdProductionSegment,
  MdCompilerPolicySchema,
  computeMdCompilerPolicyDigest,
  MdStageSkillBindingSchema,
  type MdCompilerPolicy,
  type MdProtocolCompilationInput,
} from "@eigengrid/protocol-core";
import {
  assertMdReplicaManifest,
  mdReplicaManifestDigest,
  MdReplicaReceiptSchema,
  type MdReplicaManifest,
  type MdReplicaVerifier,
} from "./md-artifact-replication";
import { ScientificIntegrityError, ScientificStoreUnsupportedDatabaseError } from "./errors";
import { ScientificStore, computePlanDigest } from "./store";
import { MdProjectionStore, createMdStageAssessmentOperationRequest } from "./md-projection-store";
import {
  MdResultCollectionStore,
  type MdResultCollectionAuthority,
  type MdResultCollection,
} from "./md-result-collection";
import {
  assertMissionProjectCreationAuthority,
  readScientificMissionProjectAssociation,
} from "./mission-project";
import type { ContentAddressedArtifactStore } from "./content-addressed-store";
import type { ScientificDatabase, ScientificTransaction } from "./types";

export const MdPostprocessingLeaseSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.md-postprocessing-lease/v1"),
    operationId: IdSchema,
    workUnitId: IdSchema,
    claimId: IdSchema,
    ownerId: IdSchema,
    acquiredAt: TimestampSchema,
  })
  .strict();
export type MdPostprocessingLease = z.infer<typeof MdPostprocessingLeaseSchema>;

/** IDs do not depend on mutable lease/retry timestamps. Content remains independently bound. */
export function mdPostprocessingIds(operationIdValue: string) {
  const operationId = IdSchema.parse(operationIdValue);
  const token = digestCanonical({
    schemaVersion: "eigengrid.md-postprocessing-identity/v1",
    operationId,
  });
  return {
    resultId: `md-result-${token}`,
    assessmentId: `md-assessment-${token}`,
    validationId: `md-validation-${token}`,
    evidenceId: `md-inspection-evidence-${token}`,
    observationId: `md-inspection-${token}`,
    analysisOperationId: `md-analysis-${token}`,
    analysisReceiptId: `md-analysis-receipt-${token}`,
    finalizationId: `md-finalization-${token}`,
    advancementId: `md-advancement-${token}`,
  };
}

export const MdFinalizationRecordSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.md-finalization/v1"),
    operationId: IdSchema,
    collectionDigest: DigestSchema,
    resultId: IdSchema,
    resultDigest: DigestSchema,
    assessmentId: IdSchema,
    assessmentDigest: DigestSchema,
    analysisOperationId: IdSchema,
    analysisReceiptId: IdSchema,
    inspectionEvidenceId: IdSchema,
    inspectionDigest: DigestSchema,
    status: z.enum(["accepted", "rejected", "indeterminate"]),
    durability: z.literal("pending_replication"),
    recordedAt: TimestampSchema,
  })
  .strict();
export type MdFinalizationRecord = z.infer<typeof MdFinalizationRecordSchema>;

export interface MdStageFinalizationInput {
  lease: MdPostprocessingLease;
  collectionDigest: string;
  result: MdStageResult;
  assessment: MdStageAssessment;
  validation: ValidationResult;
  inspectionEvidence: EvidenceReference;
  inspectionObservation: ScientificObservation;
  trajectorySegment?: TrajectorySegment;
}

type Scope = {
  tx: ScientificTransaction;
  database: ScientificDatabase;
  store: ScientificStore;
  md: MdProjectionStore;
  collection: MdResultCollectionStore;
};

export class MdStageLifecycleStore {
  constructor(
    private readonly database: ScientificDatabase,
    private readonly objects: ContentAddressedArtifactStore,
    private readonly options: { replicaVerifier?: MdReplicaVerifier } = {},
  ) {
    if (database._provider !== "postgres")
      throw new ScientificStoreUnsupportedDatabaseError(database._provider);
  }

  /** One real transaction; nested domain stores cannot commit independently. */
  private async transaction<T>(body: (scope: Scope) => Promise<T>): Promise<T> {
    const raw = await this.database.beginTransaction();
    if (!raw.queryRows) {
      await raw.rollback();
      throw new ScientificStoreUnsupportedDatabaseError(this.database._provider);
    }
    const tx = raw as ScientificTransaction;
    let poisoned = false;
    const database: ScientificDatabase = {
      _provider: "postgres",
      beginTransaction: async () => ({
        query: tx.query.bind(tx),
        queryRows: tx.queryRows.bind(tx),
        commit: async () => {
          if (poisoned)
            throw new ScientificIntegrityError("MD finalization transaction was rolled back");
        },
        rollback: async () => {
          poisoned = true;
        },
      }),
    };
    const scope = {
      tx,
      database,
      store: new ScientificStore(database),
      md: new MdProjectionStore(database, this.objects),
      collection: new MdResultCollectionStore(database, this.objects),
    };
    try {
      const value = await body(scope);
      if (poisoned)
        throw new ScientificIntegrityError("MD finalization transaction was rolled back");
      await tx.commit();
      return value;
    } catch (error) {
      await tx.rollback().catch(() => undefined);
      throw error;
    }
  }

  private async collected(scope: Scope, operationId: string) {
    // Same mission -> plan -> WorkUnit -> operation lock order as admission/adoption.
    const authority = await scope.collection.readAuthority(operationId);
    const collection = await scope.collection.get(operationId);
    if (
      !collection ||
      collection.outcome !== "completed" ||
      collection.artifactStatus !== "complete" ||
      authority.operation.state !== "confirmed"
    )
      throw new ScientificIntegrityError(
        "MD postprocessing requires a complete adopted terminal collection",
      );
    return { ...authority, collection };
  }

  /** No expired executing lease is recovered here: only the already confirmed effect is eligible. */
  async acquire(input: {
    operationId: string;
    ownerId: string;
    now: string;
    expiresAt: string;
  }): Promise<
    | { acquired: false; reason: "lease_active" | "not_observing"; workUnit: WorkUnit }
    | { acquired: true; lease: MdPostprocessingLease; workUnit: WorkUnit }
  > {
    IdSchema.parse(input.operationId);
    IdSchema.parse(input.ownerId);
    TimestampSchema.parse(input.now);
    TimestampSchema.parse(input.expiresAt);
    const duration = Date.parse(input.expiresAt) - Date.parse(input.now);
    if (duration <= 0 || duration > 600_000)
      throw new ScientificIntegrityError(
        "MD postprocessing lease must be positive and at most ten minutes",
      );
    return this.transaction(async (scope) => {
      const { workUnit } = await this.collected(scope, input.operationId);
      if (workUnit.state !== "observing")
        return { acquired: false, reason: "not_observing", workUnit };
      if (workUnit.claimExpiresAt && Date.parse(workUnit.claimExpiresAt) > Date.parse(input.now))
        return { acquired: false, reason: "lease_active", workUnit };
      const next = WorkUnitSchema.parse({
        ...workUnit,
        revision: workUnit.revision + 1,
        claimOwner: input.ownerId,
        claimExpiresAt: input.expiresAt,
        updatedAt: input.now,
      });
      await scope.tx.query(
        `UPDATE scientific_work_unit_claims SET active = false, released_at = $1,
        release_reason = 'terminal_md_postprocessing_recovery' WHERE work_unit_id = $2 AND active = true`,
        [input.now, workUnit.id],
      );
      const changed = await scope.tx.queryRows(
        `UPDATE scientific_work_units SET revision = $1, claim_owner = $2, claim_expires_at = $3,
        payload_digest = $4, payload_json = $5, updated_at = $6 WHERE id = $7 AND revision = $8 AND state = 'observing' RETURNING id`,
        [
          next.revision,
          next.claimOwner,
          next.claimExpiresAt,
          digestCanonical(next),
          canonicalJson(next),
          next.updatedAt,
          next.id,
          workUnit.revision,
        ],
      );
      if (changed.length !== 1)
        throw new ScientificIntegrityError("MD postprocessing claim lost its compare-and-swap");
      const claimId = `claim-md-postprocess-${randomUUID()}`;
      await scope.tx.query(
        `INSERT INTO scientific_work_unit_claims (id, work_unit_id, owner_id, acquired_at, expires_at, active)
        VALUES ($1,$2,$3,$4,$5,true)`,
        [claimId, next.id, input.ownerId, input.now, input.expiresAt],
      );
      return {
        acquired: true,
        lease: {
          schemaVersion: "eigengrid.md-postprocessing-lease/v1",
          operationId: input.operationId,
          workUnitId: next.id,
          claimId,
          ownerId: input.ownerId,
          acquiredAt: input.now,
        },
        workUnit: next,
      };
    });
  }

  private async fenced(scope: Scope, leaseValue: MdPostprocessingLease, nowValue: string) {
    const lease = MdPostprocessingLeaseSchema.parse(leaseValue),
      now = TimestampSchema.parse(nowValue);
    const authority = await this.collected(scope, lease.operationId);
    const work = authority.workUnit;
    const claims = await scope.tx.queryRows(
      `SELECT id, owner_id, expires_at, acquired_at FROM scientific_work_unit_claims
      WHERE work_unit_id = $1 AND active = true FOR UPDATE`,
      [lease.workUnitId],
    );
    if (
      work.id !== lease.workUnitId ||
      work.state !== "observing" ||
      work.claimOwner !== lease.ownerId ||
      !work.claimExpiresAt ||
      Date.parse(work.claimExpiresAt) <= Date.parse(now) ||
      claims.length !== 1 ||
      claims[0]!.id !== lease.claimId ||
      claims[0]!.owner_id !== lease.ownerId ||
      claims[0]!.acquired_at !== lease.acquiredAt ||
      claims[0]!.expires_at !== work.claimExpiresAt
    )
      throw new ScientificIntegrityError(
        "Stale MD postprocessing lease or changed terminal authority",
      );
    return authority;
  }

  /** Reuse the canonical claim heartbeat; it validates token, owner and expiration. */
  async renew(lease: MdPostprocessingLease, now: string, expiresAt: string): Promise<void> {
    const token = MdPostprocessingLeaseSchema.parse(lease);
    TimestampSchema.parse(now);
    TimestampSchema.parse(expiresAt);
    const duration = Date.parse(expiresAt) - Date.parse(now);
    if (duration <= 0 || duration > 600_000)
      throw new ScientificIntegrityError("Invalid MD heartbeat extension");
    await this.transaction(async (scope) => {
      await this.fenced(scope, token, now);
      await scope.store.renewWorkUnitClaim({
        workUnitId: token.workUnitId,
        claimId: token.claimId,
        ownerId: token.ownerId,
        now,
        expiresAt,
      });
    });
  }

  /** Release only this analysis lease; never cancel or alter the already completed engine effect. */
  async release(lease: MdPostprocessingLease, now: string): Promise<void> {
    await this.transaction(async (scope) => {
      const { workUnit } = await this.fenced(scope, lease, now);
      const next = WorkUnitSchema.parse({
        ...workUnit,
        revision: workUnit.revision + 1,
        claimOwner: null,
        claimExpiresAt: null,
        updatedAt: now,
      });
      await scope.tx.query(
        `UPDATE scientific_work_unit_claims SET active=false, released_at=$1, release_reason='md_postprocessing_finished'
        WHERE id=$2 AND work_unit_id=$3 AND active=true`,
        [now, lease.claimId, workUnit.id],
      );
      await scope.tx.query(
        `UPDATE scientific_work_units SET revision=$1, claim_owner=NULL, claim_expires_at=NULL,
        payload_digest=$2, payload_json=$3, updated_at=$4 WHERE id=$5 AND revision=$6`,
        [
          next.revision,
          digestCanonical(next),
          canonicalJson(next),
          now,
          next.id,
          workUnit.revision,
        ],
      );
    });
  }

  private async readFinalization(
    scope: Scope,
    authority: MdResultCollectionAuthority & { collection: MdResultCollection },
  ): Promise<MdFinalizationRecord | null> {
    const ids = mdPostprocessingIds(authority.operation.id);
    const [row] = await scope.tx.queryRows(
      `SELECT payload_json, payload_digest, work_unit_id, mission_id FROM scientific_observations WHERE id=$1`,
      [ids.finalizationId],
    );
    if (!row) return null;
    const observation = ScientificObservationSchema.parse(JSON.parse(String(row.payload_json)));
    const record = MdFinalizationRecordSchema.parse(observation.payload);
    if (
      row.payload_digest !== digestCanonical(record) ||
      row.work_unit_id !== authority.workUnit.id ||
      row.mission_id !== authority.workUnit.missionId ||
      observation.id !== ids.finalizationId ||
      observation.workUnitId !== row.work_unit_id ||
      observation.missionId !== row.mission_id ||
      record.operationId !== authority.operation.id ||
      record.collectionDigest !== digestCanonical(authority.collection) ||
      record.resultId !== ids.resultId ||
      record.assessmentId !== ids.assessmentId ||
      record.analysisOperationId !== ids.analysisOperationId ||
      record.analysisReceiptId !== ids.analysisReceiptId
    )
      throw new ScientificIntegrityError(
        "MD finalization record lost its exact collection identity",
      );
    const result = await scope.md.getStageResult(record.resultId),
      assessment = await scope.md.getAssessment(record.assessmentId, 1);
    if (
      !result ||
      !assessment ||
      !("stageResultId" in assessment) ||
      result.resultDigest !== record.resultDigest ||
      assessment.assessmentDigest !== record.assessmentDigest ||
      assessment.stageResultDigest !== result.resultDigest ||
      assessment.status !== record.status
    )
      throw new ScientificIntegrityError(
        "MD finalization record differs from persisted projections",
      );
    const operation = await scope.store.getExternalOperation(record.analysisOperationId);
    if (
      !operation ||
      operation.state !== "confirmed" ||
      operation.receiptId !== record.analysisReceiptId ||
      operation.kind !== "trajectory_analysis"
    )
      throw new ScientificIntegrityError(
        "MD finalization lost its authenticated analysis operation",
      );
    const [receiptRow] = await scope.tx.queryRows(
      "SELECT payload_json FROM scientific_operation_receipts WHERE id=$1",
      [record.analysisReceiptId],
    );
    if (!receiptRow) throw new ScientificIntegrityError("MD analysis receipt disappeared");
    const receipt = OperationReceiptSchema.parse(JSON.parse(String(receiptRow.payload_json)));
    if (
      receipt.status !== "confirmed" ||
      receipt.operationId !== operation.id ||
      receipt.requestDigest !== operation.requestDigest ||
      receipt.detailDigest !== record.inspectionDigest
    )
      throw new ScientificIntegrityError(
        "MD analysis receipt does not authenticate the exact report",
      );
    return record;
  }

  async get(operationId: string): Promise<MdFinalizationRecord | null> {
    return this.transaction(async (scope) =>
      this.readFinalization(scope, await this.collected(scope, IdSchema.parse(operationId))),
    );
  }

  private async currentApprovals(
    scope: Scope,
    authority: MdResultCollectionAuthority,
    now: string,
    policyDigest: string,
  ) {
    DigestSchema.parse(policyDigest);
    const { workUnit, operation } = authority;
    const mission = await scope.store.getMission(workUnit.missionId),
      plan = await scope.store.getPlan(workUnit.planId);
    if (
      !mission ||
      !["ready", "running", "observing"].includes(mission.state) ||
      mission.activePlanId !== workUnit.planId ||
      !plan ||
      plan.status !== "approved" ||
      operation.policyDigest !== policyDigest
    )
      throw new ScientificIntegrityError(
        "MD continuation requires the current active mission, plan and policy",
      );
    const association = await readScientificMissionProjectAssociation(
      scope.tx,
      mission.id,
      "postgres",
      true,
    );
    if (!association)
      throw new ScientificIntegrityError(
        "MD continuation requires its immutable project association",
      );
    await assertMissionProjectCreationAuthority(
      scope.tx,
      { mission, projectId: association.projectId, ownerUserId: association.ownerUserId },
      "postgres",
    );
    const binding = MdExecutionBindingParametersSchema.parse(workUnit.protocolFragment.parameters);
    const protocol = await scope.md.getProtocol(binding.protocol.id, binding.protocol.revision);
    if (!protocol) throw new ScientificIntegrityError("MD protocol is missing");
    const ids = [
      binding.plan.approvalRef,
      binding.system.approvalRef,
      binding.protocol.approvalRef,
      ...binding.decisions.map((d) => d.approvalRef),
    ];
    if (binding.replicaSegment) {
      const replica = await scope.md.getReplicaSet(
        binding.replicaSegment.replicaSetId,
        binding.replicaSegment.replicaSetRevision,
      );
      if (!replica) throw new ScientificIntegrityError("MD replica set is missing");
      const approvals = await scope.tx.queryRows<{ id: string }>(
        `SELECT id FROM scientific_approval_requests
        WHERE mission_id=$1 AND subject_type='replica_set' AND subject_id=$2 AND subject_revision=$3 AND state='approved'
        ORDER BY requested_at DESC, id`,
        [workUnit.missionId, replica.id, replica.revision],
      );
      if (approvals.length !== 1)
        throw new ScientificIntegrityError("MD replica requires one exact current approval");
      ids.push(approvals[0]!.id);
    }
    for (const id of [...new Set(ids)].sort())
      await scope.tx.queryRows(
        "SELECT id FROM scientific_approval_requests WHERE id=$1 FOR UPDATE",
        [id],
      );
    const approvals = new Map<string, ApprovalRequest>();
    for (const id of new Set(ids))
      approvals.set(
        id,
        await scope.store.assertApprovalValid(id, {
          now,
          currentPolicyDigest: binding.decisions.some((d) => d.approvalRef === id)
            ? (protocol.preparationPolicyDigest ?? policyDigest)
            : policyDigest,
        }),
      );
    return { binding, protocol, plan, mission, approvals };
  }

  /** Persist computed observations atomically. Success here is NOT replicated-release acknowledgement. */
  async finalize(
    input: MdStageFinalizationInput,
    context: { now: string; currentPolicyDigest: string },
  ): Promise<{ record: MdFinalizationRecord; created: boolean }> {
    const result = assertMdStageResultDigest(input.result),
      assessment = assertMdStageAssessmentDigest(input.assessment);
    const validation = ValidationResultSchema.parse(input.validation),
      evidence = EvidenceReferenceSchema.parse(input.inspectionEvidence);
    const observation = ScientificObservationSchema.parse(input.inspectionObservation);
    const trajectory = input.trajectorySegment
      ? assertTrajectorySegmentDigest(input.trajectorySegment)
      : undefined;
    const ids = mdPostprocessingIds(input.lease.operationId);
    TimestampSchema.parse(context.now);
    DigestSchema.parse(input.collectionDigest);
    if (
      result.operationId !== input.lease.operationId ||
      result.workUnitId !== input.lease.workUnitId ||
      result.id !== ids.resultId ||
      result.revision !== 1 ||
      assessment.id !== ids.assessmentId ||
      assessment.revision !== 1 ||
      assessment.stageResultId !== result.id ||
      assessment.stageResultDigest !== result.resultDigest ||
      assessment.missionId !== result.missionId ||
      validation.id !== ids.validationId ||
      validation.missionId !== result.missionId ||
      validation.workUnitId !== result.workUnitId ||
      !result.validationRefs.includes(validation.id) ||
      evidence.id !== ids.evidenceId ||
      evidence.sourceId !== ids.analysisReceiptId ||
      evidence.workUnitId !== result.workUnitId ||
      evidence.missionId !== result.missionId ||
      evidence.kind !== "analysis_result" ||
      evidence.uri !== this.objects.uriForDigest(evidence.contentDigest) ||
      !evidence.immutable ||
      observation.id !== ids.observationId ||
      observation.missionId !== result.missionId ||
      observation.workUnitId !== result.workUnitId ||
      observation.source.id !== ids.analysisReceiptId ||
      !observation.evidenceRefs.includes(evidence.id) ||
      !validation.observationRefs.includes(observation.id) ||
      !validation.evidenceRefs.includes(evidence.id) ||
      !assessment.evidenceRefs.includes(evidence.id)
    )
      throw new ScientificIntegrityError(
        "MD finalization payload is outside its deterministic execution identity",
      );
    // Integrity I/O happens BEFORE locks. The CAS is immutable; re-adoption never changes its bytes.
    const verified = await this.objects.verify(evidence.contentDigest, {
      maxBytes: evidence.sizeBytes,
    });
    if (verified.sizeBytes !== evidence.sizeBytes)
      throw new ScientificIntegrityError("MD analysis evidence byte size mismatch");
    const reportObject = await this.objects.get(evidence.contentDigest);
    const report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reportObject.bytes));
    if (
      report.schemaVersion !== "eigengrid.md-postprocessing-report/v1" ||
      report.collectionDigest !== input.collectionDigest ||
      digestCanonical(report.result) !== digestCanonical(result) ||
      digestCanonical(report.assessment) !== digestCanonical(assessment) ||
      digestCanonical(report.validation) !== digestCanonical(validation)
    )
      throw new ScientificIntegrityError(
        "MD finalization projections do not match their actual report bytes",
      );
    return this.transaction(async (scope) => {
      const authority = await this.collected(scope, input.lease.operationId);
      const previous = await this.readFinalization(scope, authority);
      if (previous) {
        if (
          previous.resultDigest !== result.resultDigest ||
          previous.assessmentDigest !== assessment.assessmentDigest ||
          previous.inspectionDigest !== evidence.contentDigest ||
          previous.collectionDigest !== input.collectionDigest
        )
          throw new ScientificIntegrityError(
            "Finalized MD observations cannot be replaced on replay",
          );
        return { record: previous, created: false };
      }
      await this.fenced(scope, input.lease, context.now);
      await this.currentApprovals(scope, authority, context.now, context.currentPolicyDigest);
      if (
        input.collectionDigest !== digestCanonical(authority.collection) ||
        result.operationReceiptId !== authority.operation.receiptId
      )
        throw new ScientificIntegrityError("MD finalization collection/receipt mismatch");
      for (const artifact of result.artifacts) {
        const collected = authority.collection.artifacts.find(
          (a) => a.role === `output_stage_${artifact.role}`,
        );
        if (
          !collected ||
          collected.sha256 !== artifact.contentDigest ||
          collected.sizeBytes !== artifact.sizeBytes ||
          collected.mediaType !== artifact.mediaType ||
          collected.kind !== artifact.role ||
          artifact.evidenceRef !==
            `evidence-md-${digestCanonical({ operationId: result.operationId, role: collected.role })}`
        )
          throw new ScientificIntegrityError(
            "MD projection references bytes outside the adopted engine output inventory",
          );
      }
      const request = createMdStageAssessmentOperationRequest({
        workUnitId: result.workUnitId,
        stageResult: result,
        assessment,
      });
      let analysis = await scope.store.createOperationIntent(
        {
          id: ids.analysisOperationId,
          missionId: result.missionId,
          workUnitId: result.workUnitId,
          idempotencyKey: `md-analysis/${result.operationId}`,
          kind: "trajectory_analysis",
          state: "intent",
          request: { ...request },
          requestDigest: digestCanonical(request),
          policyDigest: context.currentPolicyDigest,
          revision: 1,
          createdAt: context.now,
          updatedAt: context.now,
        },
        { claimOwner: input.lease.ownerId, now: context.now },
      );
      analysis = await scope.store.transitionExternalOperation({
        operationId: analysis.id,
        expectedRevision: analysis.revision,
        to: "effect_started",
        at: context.now,
      });
      analysis = await scope.store.transitionExternalOperation({
        operationId: analysis.id,
        expectedRevision: analysis.revision,
        to: "acknowledged",
        at: context.now,
        externalIdentity: {
          execution: "head_deterministic_analysis",
          reportDigest: evidence.contentDigest,
        },
      });
      await scope.store.finalizeOperationReceipt(analysis.id, analysis.revision, {
        id: ids.analysisReceiptId,
        operationId: analysis.id,
        requestDigest: analysis.requestDigest,
        status: "confirmed",
        detailDigest: evidence.contentDigest,
        recordedAt: context.now,
        externalIdentity: {
          execution: "head_deterministic_analysis",
          collectionDigest: input.collectionDigest,
          scientificVerdict: "criteria_only_not_publication_qualification",
        },
      });
      await scope.store.createEvidence(evidence);
      await scope.store.createObservation(observation);
      await scope.store.createValidationResult(validation);
      await scope.md.putStageResult(result);
      if (trajectory) await scope.md.putTrajectorySegment(trajectory);
      await scope.md.putAssessment(assessment, {
        operationId: analysis.id,
        operationReceiptId: ids.analysisReceiptId,
        subjectRevision: result.revision,
      });
      const record: MdFinalizationRecord = {
        schemaVersion: "eigengrid.md-finalization/v1",
        operationId: result.operationId,
        collectionDigest: input.collectionDigest,
        resultId: result.id,
        resultDigest: result.resultDigest,
        assessmentId: assessment.id,
        assessmentDigest: assessment.assessmentDigest,
        analysisOperationId: analysis.id,
        analysisReceiptId: ids.analysisReceiptId,
        inspectionEvidenceId: evidence.id,
        inspectionDigest: evidence.contentDigest,
        status: assessment.status,
        durability: "pending_replication",
        recordedAt: context.now,
      };
      await scope.store.createObservation({
        id: ids.finalizationId,
        missionId: result.missionId,
        workUnitId: result.workUnitId,
        type: "stage_completion",
        payload: record,
        source: { kind: "runtime", id: ids.analysisReceiptId },
        evidenceRefs: [evidence.id],
        qualityFlags: ["pending_replication", "not_release_qualification"],
        observedAt: context.now,
      });
      return { record, created: true };
    });
  }

  /** Freeze the immutable replay material and exact object set for an independent
   * replica. No database or storage-redundancy claim is inferred from local CAS.
   */
  async prepareReplication(operationId: string): Promise<MdReplicaManifest> {
    const snapshot = await this.transaction(async (scope) => {
      const authority = await this.collected(scope, IdSchema.parse(operationId));
      const record = await this.readFinalization(scope, authority);
      if (!record) throw new ScientificIntegrityError("Cannot replicate an unfinalized MD result");
      const binding = MdExecutionBindingParametersSchema.parse(
        authority.workUnit.protocolFragment.parameters,
      );
      const result = (await scope.md.getStageResult(record.resultId))!;
      const assessment = (await scope.md.getAssessment(record.assessmentId, 1))!;
      const protocol = await scope.md.getProtocol(binding.protocol.id, binding.protocol.revision);
      const system = await scope.md.getSystemManifest(binding.system.id, binding.system.revision);
      if (!protocol || !system)
        throw new ScientificIntegrityError("MD replay metadata is incomplete");
      const stage = protocol.stages.find(
        (x) => x.id === binding.stage.id && x.revision === binding.stage.revision,
      );
      if (!stage) throw new ScientificIntegrityError("MD replica stage missing from its protocol");
      const metadata = {
        schemaVersion: "eigengrid.md-replay-metadata/v1",
        authority: "historical_evidence_not_restore_permission",
        record,
        result,
        assessment,
        binding,
        protocol,
        system,
        operationRequest: authority.operation.request,
        collection: authority.collection,
      };
      const digests = new Set([
        record.inspectionDigest,
        ...authority.collection.artifacts.map((a) => a.sha256),
        ...stage.inputs.map((a) => a.contentDigest),
        ...(binding.parentRestart ? [binding.parentRestart.contentDigest] : []),
      ]);
      return { record, metadata, digests };
    });
    const metadata = await this.objects.put(Buffer.from(canonicalJson(snapshot.metadata)));
    snapshot.digests.add(metadata.digest);
    const objects = [];
    for (const digest of [...snapshot.digests].sort()) {
      const verified = await this.objects.verify(digest, { maxBytes: 32 * 1024 ** 3 });
      objects.push({ digest, sizeBytes: verified.sizeBytes });
    }
    const unsigned = {
      schemaVersion: "eigengrid.md-replica-manifest/v1" as const,
      operationId,
      collectionDigest: snapshot.record.collectionDigest,
      resultDigest: snapshot.record.resultDigest,
      assessmentDigest: snapshot.record.assessmentDigest,
      metadataDigest: metadata.digest,
      objects,
    };
    const manifest = assertMdReplicaManifest({
      ...unsigned,
      manifestDigest: mdReplicaManifestDigest(unsigned),
    });
    await this.objects.put(Buffer.from(canonicalJson(manifest)));
    await this.transaction(async (scope) => {
      const authority = await this.collected(scope, operationId);
      const current = await this.readFinalization(scope, authority);
      if (digestCanonical(current) !== digestCanonical(snapshot.record))
        throw new ScientificIntegrityError(
          "MD finalization changed during replication preparation",
        );
      await scope.store.createObservation({
        id: `md-replication-request-${digestCanonical({ operationId })}`,
        missionId: authority.workUnit.missionId,
        workUnitId: authority.workUnit.id,
        type: "artifact_integrity",
        payload: manifest,
        source: { kind: "runtime", id: current!.analysisReceiptId },
        evidenceRefs: [current!.inspectionEvidenceId],
        qualityFlags: ["pending_replication", "not_restore_permission"],
        observedAt: current!.recordedAt,
      });
    });
    return manifest;
  }

  private async compilationInput(
    scope: Scope,
    authority: MdResultCollectionAuthority,
    current: Awaited<ReturnType<MdStageLifecycleStore["currentApprovals"]>>,
    policyValue: MdCompilerPolicy,
    environment: MdEnvironmentCapabilitySnapshot,
    now: string,
  ): Promise<MdProtocolCompilationInput> {
    const policy = MdCompilerPolicySchema.parse(policyValue);
    if (
      policy.policyDigest !== computeMdCompilerPolicyDigest(policy) ||
      policy.policyDigest !== authority.operation.policyDigest
    )
      throw new ScientificIntegrityError(
        "MD continuation compiler policy is not the current exact policy",
      );
    const { binding, plan, protocol, approvals } = current;
    const system = await scope.md.getSystemManifest(binding.system.id, binding.system.revision);
    if (!system) throw new ScientificIntegrityError("MD continuation system is absent");
    const evidenceId = `candidate-${digestCanonical({ planId: plan.id }).slice(0, 32)}`;
    const [row] = await scope.tx.queryRows(
      "SELECT payload_json FROM scientific_evidence WHERE id=$1",
      [evidenceId],
    );
    if (!row)
      throw new ScientificIntegrityError(
        "MD continuation requires its original reviewed candidate manifest",
      );
    const evidence = EvidenceReferenceSchema.parse(JSON.parse(String(row.payload_json)));
    if (
      evidence.missionId !== authority.workUnit.missionId ||
      evidence.sourceId !== plan.id ||
      evidence.kind !== "human_review" ||
      !evidence.immutable ||
      evidence.uri !== this.objects.uriForDigest(evidence.contentDigest)
    )
      throw new ScientificIntegrityError("Candidate evidence is outside the exact reviewed plan");
    const material = await this.objects.get(evidence.contentDigest);
    const candidate = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(material.bytes));
    if (
      digestCanonical(candidate) !== evidence.contentDigest ||
      candidate.schemaVersion !== "eigengrid.mission-candidate/v1" ||
      candidate.plan?.id !== plan.id ||
      candidate.plan?.missionId !== plan.missionId ||
      candidate.plan?.planDigest !== plan.planDigest ||
      assertMdWorkflowProtocolDigest(candidate.md?.protocol).protocolDigest !==
        protocol.protocolDigest ||
      assertPublishedBiomolecularSystemManifestDigest(candidate.md?.system).manifestDigest !==
        system.manifestDigest ||
      computePlanDigest(ScientificPlanSchema.parse(candidate.plan)) !== plan.planDigest
    )
      throw new ScientificIntegrityError(
        "Reviewed candidate bytes do not bind the current exact MD protocol/system",
      );
    const stageSkillBindings = z
      .array(MdStageSkillBindingSchema)
      .min(1)
      .max(1024)
      .parse(candidate.md.stageSkillBindings);
    const decisionRefs = system.decisionRefs;
    // Check all protocol decisions, not only the completed stage's subset.
    const decisionApprovals = [];
    for (const decision of decisionRefs) {
      await scope.tx.queryRows(
        "SELECT id FROM scientific_approval_requests WHERE id=$1 FOR UPDATE",
        [decision.approvalRef],
      );
      decisionApprovals.push(
        await scope.store.assertApprovalValid(decision.approvalRef, {
          now,
          currentPolicyDigest: protocol.preparationPolicyDigest ?? policy.policyDigest,
        }),
      );
    }
    return {
      plan: {
        id: plan.id,
        missionId: plan.missionId,
        version: plan.version,
        revision: plan.revision,
        status: "approved",
        planDigest: plan.planDigest,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
      },
      planApproval: approvals.get(binding.plan.approvalRef)!,
      system: assertPublishedBiomolecularSystemManifestDigest(system),
      systemApproval: approvals.get(binding.system.approvalRef)!,
      protocol,
      protocolApproval: approvals.get(binding.protocol.approvalRef)!,
      decisionRefs,
      decisionApprovals,
      stageSkillBindings,
      policy,
      environment,
    };
  }

  /** Complete and create the deterministic successor(s) in ONE PostgreSQL TX.
   * Missing/rejected scientific evidence or an unverified replica cannot advance.
   * This is not a release-level database RPO0 or physical-site qualification claim.
   */
  async advance(input: {
    lease: MdPostprocessingLease;
    now: string;
    policy: MdCompilerPolicy;
    environment: MdEnvironmentCapabilitySnapshot;
  }): Promise<
    | { status: "pending_replication"; manifest: MdReplicaManifest }
    | { status: "scientific_review_required"; finalization: MdFinalizationRecord }
    | {
        status: "advanced";
        workUnitIds: string[];
        created: boolean;
        artifactReplicaVerified: true;
        canonicalAcknowledged: false;
      }
  > {
    const lease = MdPostprocessingLeaseSchema.parse(input.lease);
    TimestampSchema.parse(input.now);
    const finalization = await this.get(lease.operationId);
    if (!finalization) throw new ScientificIntegrityError("MD result is not finalized");
    if (finalization.status !== "accepted")
      return { status: "scientific_review_required", finalization };
    const manifest = await this.prepareReplication(lease.operationId);
    const replica = this.options.replicaVerifier
      ? await this.options.replicaVerifier.read(manifest, input.now)
      : null;
    if (!replica) return { status: "pending_replication", manifest };
    return this.transaction(async (scope) => {
      const authority = await this.collected(scope, lease.operationId),
        ids = mdPostprocessingIds(lease.operationId);
      const [existing] = await scope.tx.queryRows(
        "SELECT payload_json, payload_digest FROM scientific_observations WHERE id=$1",
        [ids.advancementId],
      );
      if (existing) {
        const observation = ScientificObservationSchema.parse(
          JSON.parse(String(existing.payload_json)),
        );
        const record = MdAdvancementRecordSchema.parse(observation.payload);
        if (
          record.operationId !== lease.operationId ||
          record.resultDigest !== finalization.resultDigest ||
          record.assessmentDigest !== finalization.assessmentDigest ||
          record.replicaManifestDigest !== manifest.manifestDigest ||
          existing.payload_digest !== digestCanonical(record) ||
          authority.workUnit.state !== "succeeded"
        )
          throw new ScientificIntegrityError(
            "MD advancement replay differs from its durable checkpoint",
          );
        for (const child of record.children) {
          const work = await scope.store.getWorkUnit(child.id);
          if (
            !work ||
            work.missionId !== authority.workUnit.missionId ||
            work.planId !== authority.workUnit.planId ||
            digestCanonical(work.protocolFragment) !== child.fragmentDigest ||
            !work.dependencies.includes(authority.workUnit.id)
          )
            throw new ScientificIntegrityError(
              "MD advancement child no longer matches its exact lineage",
            );
        }
        return {
          status: "advanced",
          workUnitIds: record.children.map((c) => c.id),
          created: false,
          artifactReplicaVerified: true,
          canonicalAcknowledged: false,
        };
      }
      await this.fenced(scope, lease, input.now);
      const current = await this.currentApprovals(
        scope,
        authority,
        input.now,
        input.policy.policyDigest,
      );
      const result = (await scope.md.getStageResult(finalization.resultId))!,
        assessment = await scope.md.getAssessment(finalization.assessmentId, 1);
      if (!assessment || !("stageResultId" in assessment))
        throw new ScientificIntegrityError("MD advancement assessment is absent");
      const compilation = await this.compilationInput(
        scope,
        authority,
        current,
        input.policy,
        input.environment,
        input.now,
      );
      const successors: WorkUnit[] = [];
      const stage = compilation.protocol.stages.find(
        (s) => s.id === result.stageId && s.revision === result.stageRevision,
      );
      if (!stage)
        throw new ScientificIntegrityError("Completed stage is absent from exact protocol");
      const production =
        stage.kind === "production"
          ? stage
          : compilation.protocol.stages.find(
              (s) => s.parentStageId === stage.id && s.kind === "production",
            );
      if (production) {
        if (production.randomSeed?.policy !== "replica_segment")
          throw new ScientificIntegrityError(
            "Automatic production requires a finite approved segment seed schedule",
          );
        const nextIndex = stage.kind === "production" ? (result.segmentIndex ?? -2) + 1 : 0;
        if (nextIndex < 0)
          throw new ScientificIntegrityError("Production result has no exact segment identity");
        if (nextIndex < production.randomSeed.segmentCount) {
          const rows = await scope.tx.queryRows(
            "SELECT payload_json FROM scientific_md_replica_set_revisions WHERE mission_id=$1 AND protocol_id=$2 AND protocol_revision=$3 ORDER BY id, revision",
            [result.missionId, compilation.protocol.id, compilation.protocol.revision],
          );
          const all = rows.map((row) =>
            MdReplicaSetSchema.parse(JSON.parse(String(row.payload_json))),
          );
          const candidates = all.filter((r) =>
            result.replicaSetId
              ? r.id === result.replicaSetId && r.revision === result.replicaSetRevision
              : r.replicas.some(
                  (r) =>
                    r.initialRestart.contentDigest ===
                    result.artifacts.find((a) => a.role === "restart")?.contentDigest,
                ),
          );
          const approved = [];
          for (const r of candidates) {
            const requests = await scope.tx.queryRows(
              "SELECT payload_json FROM scientific_approval_requests WHERE mission_id=$1 AND subject_type='replica_set' AND subject_id=$2 AND subject_revision=$3 AND state='approved' FOR UPDATE",
              [result.missionId, r.id, r.revision],
            );
            for (const row of requests) {
              const approval = ApprovalRequestSchema.parse(JSON.parse(String(row.payload_json)));
              if (approval.payloadDigest === computeMdReplicaSetDigest(r)) {
                await scope.store.assertApprovalValid(approval.id, {
                  now: input.now,
                  currentPolicyDigest: input.policy.policyDigest,
                });
                approved.push({ replicaSet: r, replicaSetApproval: approval });
              }
            }
          }
          if (approved.length !== 1)
            throw new ScientificIntegrityError(
              "Production continuation requires one unambiguous approved replica set",
            );
          const approvedSet = approved[0]!;
          if (approvedSet.replicaSet.replicaCount > 128)
            throw new ScientificIntegrityError(
              "Production fan-out exceeds the bounded admission batch",
            );
          for (const r of approvedSet.replicaSet.replicas.filter((r) =>
            result.replicaId ? r.id === result.replicaId : true,
          ))
            successors.push(
              compileMdProductionSegment({
                ...compilation,
                ...approvedSet,
                productionStageId: production.id,
                replicaId: r.id,
                segmentIndex: nextIndex,
                parentStageResult: result,
                parentStageAssessment: assessment,
              }).workUnit,
            );
          if (!successors.length)
            throw new ScientificIntegrityError(
              "Production replica disappeared from its exact approved set",
            );
        }
      } else {
        const next = compilation.protocol.stages.filter((s) => s.parentStageId === stage.id);
        if (next.length > 1)
          throw new ScientificIntegrityError(
            "MD continuation has ambiguous non-production successors",
          );
        if (next[0])
          successors.push(
            compileMdNextStage({
              ...compilation,
              nextStageId: next[0].id,
              parentStageResult: result,
              parentStageAssessment: assessment,
            }).workUnit,
          );
      }
      await scope.store.completeMdWorkUnit({
        workUnitId: authority.workUnit.id,
        expectedRevision: authority.workUnit.revision,
        stageResultId: result.id,
        stageResultDigest: result.resultDigest,
        assessmentId: assessment.id,
        assessmentRevision: assessment.revision,
        assessmentDigest: assessment.assessmentDigest,
        at: input.now,
        claimOwner: lease.ownerId,
      });
      await scope.store.createWorkUnits(successors);
      for (const successor of successors)
        await scope.store.transitionWorkUnit({
          workUnitId: successor.id,
          expectedRevision: 1,
          to: "ready",
          at: input.now,
        });
      const record = MdAdvancementRecordSchema.parse({
        schemaVersion: "eigengrid.md-advancement/v1",
        operationId: lease.operationId,
        resultDigest: result.resultDigest,
        assessmentDigest: assessment.assessmentDigest,
        replicaManifestDigest: manifest.manifestDigest,
        replicaReceipt: replica,
        children: successors.map((w) => ({
          id: w.id,
          fragmentDigest: digestCanonical(w.protocolFragment),
        })),
        artifactReplicaVerified: true,
        canonicalAcknowledged: false,
        advancedAt: input.now,
      });
      await scope.store.createObservation({
        id: ids.advancementId,
        missionId: result.missionId,
        workUnitId: result.workUnitId,
        type: "stage_completion",
        payload: record,
        source: { kind: "runtime", id: finalization.analysisReceiptId },
        evidenceRefs: [finalization.inspectionEvidenceId],
        qualityFlags: ["artifact_replica_verified", "database_rpo0_and_site_not_qualified"],
        observedAt: input.now,
      });
      return {
        status: "advanced",
        workUnitIds: successors.map((w) => w.id),
        created: true,
        artifactReplicaVerified: true,
        canonicalAcknowledged: false,
      };
    });
  }
}

export const MdAdvancementRecordSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.md-advancement/v1"),
    operationId: IdSchema,
    resultDigest: DigestSchema,
    assessmentDigest: DigestSchema,
    replicaManifestDigest: DigestSchema,
    replicaReceipt: MdReplicaReceiptSchema,
    children: z.array(z.object({ id: IdSchema, fragmentDigest: DigestSchema }).strict()).max(128),
    artifactReplicaVerified: z.literal(true),
    canonicalAcknowledged: z.literal(false),
    advancedAt: TimestampSchema,
  })
  .strict();
