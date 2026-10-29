/** Internal transaction, CAS and publication primitives for MD domain repositories. */
import {
  EvidenceReferenceSchema,
  WorkUnitSchema,
  canonicalJson,
  digestCanonical,
  type AtomMapPublicationRequest,
  type BiomolecularMaterialPublicationBinding,
  type EvidenceReference,
  type ExternalOperation,
  type ForceFieldStackManifest,
  type ForceFieldStackPublicationRequest,
  type MdWorkflowProtocol,
  type OperationReceipt,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import type { ContentAddressedArtifactStore } from "./content-addressed-store";
import {
  ScientificConstraintError,
  ScientificEntityConflictError,
  ScientificEntityNotFoundError,
  ScientificIntegrityError,
  ScientificStoreError,
  ScientificStoreUnsupportedDatabaseError,
} from "./errors";
import { resolveLinkedLigandMaterialDigests } from "./ligand-material-source";
import {
  assertAnExactApprovalExists,
  assertBiomolecularMaterialPublicationWorkUnit,
  assertConfirmedOperationRelation,
  assertMdEngineAdmissionEvidenceRelations,
  resolveDecisionRequirements,
} from "./md-store-authority";
import { JsonRow, lockClause, one, parseJson, queryRows } from "./md-store-queries";
import { MaterialSubjectType } from "./md-store-validation";
import { assertMdWorkUnitProjectionDependencies } from "./md-work-unit-completion";
import type {
  ScientificDatabase,
  ScientificTransaction,
  SubjectDecisionRequirement,
} from "./types";
export class MdStoreContext {
  constructor(
    readonly database: ScientificDatabase,
    readonly artifactStore?: ContentAddressedArtifactStore,
  ) {}

  async inTransaction<T>(
    operation: string,
    work: (tx: ScientificTransaction) => Promise<T>,
  ): Promise<T> {
    const raw = await this.database.beginTransaction();
    if (!raw.queryRows) {
      await raw.rollback();
      throw new ScientificStoreUnsupportedDatabaseError(this.database._provider);
    }
    const tx = raw as ScientificTransaction;
    try {
      const value = await work(tx);
      await tx.commit();
      return value;
    } catch (error) {
      try {
        await tx.rollback();
      } catch {
        // Preserve the authoritative error.
      }
      if (error instanceof ScientificStoreError) throw error;
      throw new ScientificConstraintError(operation);
    }
  }

  async required<T extends Record<string, unknown>>(
    tx: ScientificTransaction,
    entity: string,
    table: string,
    id: string,
  ): Promise<T> {
    const row = await one<T>(tx, `SELECT * FROM ${table} WHERE id = $1`, [id]);
    if (!row) throw new ScientificEntityNotFoundError(entity, id);
    return row;
  }

  async insertRevision(
    tx: ScientificTransaction,
    input: {
      entity: string;
      table: string;
      id: string;
      revision: number;
      payload: string;
      columns: string[];
      values: unknown[];
    },
  ): Promise<void> {
    const placeholders = input.values.map((_, index) => `$${index + 1}`).join(", ");
    const inserted = await queryRows<{ id: string }>(
      tx,
      `INSERT INTO ${input.table} (${input.columns.join(", ")})
       VALUES (${placeholders}) ON CONFLICT DO NOTHING RETURNING id`,
      input.values,
    );
    if (inserted.length > 0) return;
    const existing = await one<JsonRow>(
      tx,
      `SELECT payload_json FROM ${input.table} WHERE id = $1 AND revision = $2`,
      [input.id, input.revision],
    );
    if (!existing || String(existing.payload_json) !== input.payload) {
      throw new ScientificEntityConflictError(input.entity, input.id);
    }
  }

  async assertMission(tx: ScientificTransaction, missionId: string): Promise<void> {
    await this.required(tx, "mission", "scientific_missions", missionId);
  }

  async linkedForceFieldDigests(
    tx: ScientificTransaction,
    missionId: string,
    stack: ForceFieldStackManifest,
    evidenceDigests: ReadonlyMap<string, string>,
  ) {
    return resolveLinkedLigandMaterialDigests({
      stack,
      evidenceDigests,
      load: async (digest) => {
        if (!this.artifactStore)
          throw new ScientificIntegrityError("Force-field CAS is unavailable");
        return (await this.artifactStore.get(digest)).bytes;
      },
      verifyEvidence: async (digest, sizeBytes) => {
        const row = await one<JsonRow>(
          tx,
          "SELECT payload_json FROM scientific_evidence WHERE mission_id = $1 AND content_digest = $2 ORDER BY id LIMIT 1",
          [missionId, digest],
        );
        if (!row) throw new ScientificEntityNotFoundError("linked force-field evidence", digest);
        const evidence = EvidenceReferenceSchema.parse(
          parseJson(row, "linked force-field evidence"),
        );
        await this.assertCasEvidence(tx, {
          missionId,
          evidenceRef: evidence.id,
          expectedDigest: digest,
          expectedSizeBytes: sizeBytes,
        });
      },
    });
  }

  async assertCasEvidence(
    tx: ScientificTransaction,
    input: {
      missionId: string;
      evidenceRef: string;
      expectedDigest?: string;
      expectedKind?: string;
      expectedMediaType?: string;
      expectedWorkUnitId?: string;
      expectedSourceId?: string;
      expectedSizeBytes?: number;
    },
  ): Promise<EvidenceReference> {
    if (!this.artifactStore) {
      throw new ScientificIntegrityError(
        "MD projections require a configured content-addressed artifact store",
        { evidenceRef: input.evidenceRef },
      );
    }
    const row = await one<
      JsonRow & {
        mission_id: string;
        work_unit_id: string | null;
        evidence_kind_id: string;
        uri: string;
        content_digest: string;
        immutable: number | boolean;
        source_id: string | null;
      }
    >(
      tx,
      `SELECT mission_id, work_unit_id, evidence_kind_id, uri, content_digest,
              immutable, source_id, payload_json
       FROM scientific_evidence WHERE id = $1`,
      [input.evidenceRef],
    );
    if (!row) {
      throw new ScientificEntityNotFoundError("MD evidence", input.evidenceRef);
    }
    const evidence = EvidenceReferenceSchema.parse(parseJson(row, "MD evidence"));
    const verified = await this.artifactStore.verifyByUri(evidence.uri);
    if (
      evidence.id !== input.evidenceRef ||
      evidence.missionId !== input.missionId ||
      String(row.mission_id) !== input.missionId ||
      evidence.immutable !== true ||
      !row.immutable ||
      evidence.uri !== String(row.uri) ||
      evidence.contentDigest !== String(row.content_digest) ||
      evidence.kind !== String(row.evidence_kind_id) ||
      verified.uri !== evidence.uri ||
      verified.digest !== evidence.contentDigest ||
      (evidence.sizeBytes !== undefined && evidence.sizeBytes !== verified.sizeBytes) ||
      (input.expectedDigest !== undefined && evidence.contentDigest !== input.expectedDigest) ||
      (input.expectedKind !== undefined && evidence.kind !== input.expectedKind) ||
      (input.expectedMediaType !== undefined && evidence.mediaType !== input.expectedMediaType) ||
      (input.expectedWorkUnitId !== undefined &&
        (evidence.workUnitId !== input.expectedWorkUnitId ||
          String(row.work_unit_id) !== input.expectedWorkUnitId)) ||
      (input.expectedSourceId !== undefined &&
        (evidence.sourceId !== input.expectedSourceId ||
          String(row.source_id) !== input.expectedSourceId)) ||
      (input.expectedSizeBytes !== undefined && verified.sizeBytes !== input.expectedSizeBytes)
    ) {
      throw new ScientificIntegrityError("MD evidence is not an exact verified CAS object", {
        evidenceRef: input.evidenceRef,
      });
    }
    return evidence;
  }

  async assertMdEngineAdmissionCas(
    tx: ScientificTransaction,
    protocol: MdWorkflowProtocol,
  ): Promise<void> {
    const binding = protocol.forceFieldEngineAdmission;
    if (binding === undefined) return;
    await assertMdEngineAdmissionEvidenceRelations(tx, protocol);
    await this.assertCasEvidence(tx, {
      missionId: protocol.missionId,
      evidenceRef: binding.evidenceRef,
      expectedDigest: binding.contentDigest,
      expectedKind: "human_review",
      expectedMediaType: "application/json",
      expectedSizeBytes: Buffer.byteLength(canonicalJson(binding.admission)),
    });
    for (const source of binding.admission.sourceEvidence)
      await this.assertCasEvidence(tx, {
        missionId: protocol.missionId,
        evidenceRef: source.evidenceRef,
        expectedDigest: source.contentDigest,
        expectedKind: source.kind,
      });
    const content = await this.artifactStore!.get(binding.contentDigest);
    if (Buffer.from(content.bytes).toString("utf8") !== canonicalJson(binding.admission))
      throw new ScientificIntegrityError(
        "Technical engine admission CAS content differs from its approved protocol",
        { protocolId: protocol.id },
      );
  }

  async assertDecisionRequirements(
    tx: ScientificTransaction,
    missionId: string,
    requirements: SubjectDecisionRequirement[],
  ): Promise<void> {
    for (const requirement of requirements) {
      if (requirement.revision !== undefined) {
        const resolved = await resolveDecisionRequirements(tx, missionId, [requirement.id]);
        const exact = resolved[0]!;
        if (
          exact.revision !== requirement.revision ||
          exact.digest !== requirement.digest ||
          exact.approvalRef !== requirement.approvalRef
        ) {
          throw new ScientificIntegrityError(
            "Required biomolecular decision is not exact and approved",
            {
              decisionId: requirement.id,
            },
          );
        }
        continue;
      }
      const resolved = await resolveDecisionRequirements(tx, missionId, [requirement.id]);
      const exact = resolved[0]!;
      const legacy = await one<{ id: string }>(
        tx,
        "SELECT id FROM scientific_decisions WHERE id = $1 AND mission_id = $2",
        [requirement.id, missionId],
      );
      if (!legacy && exact.revision === undefined) {
        throw new ScientificIntegrityError("Required scientific decision is missing", {
          decisionId: requirement.id,
        });
      }
    }
  }

  async assertConfirmedOperation(
    tx: ScientificTransaction,
    missionId: string,
    operationId: string,
    receiptId?: string,
  ): Promise<{
    workUnitId: string;
    requestDigest: string;
    receiptId: string;
    operation: ExternalOperation;
    receipt: OperationReceipt;
  }> {
    return assertConfirmedOperationRelation(tx, missionId, operationId, receiptId);
  }

  async assertMaterialRevisionProgress(
    tx: ScientificTransaction,
    input: {
      table: string;
      entity: string;
      id: string;
      revision: number;
      missionId: string;
      payload: string;
    },
  ): Promise<void> {
    const exact = await one<JsonRow & { mission_id: string }>(
      tx,
      `SELECT mission_id, payload_json FROM ${input.table} WHERE id = $1 AND revision = $2`,
      [input.id, input.revision],
    );
    if (exact) {
      if (
        String(exact.mission_id) !== input.missionId ||
        String(exact.payload_json) !== input.payload
      ) {
        throw new ScientificEntityConflictError(input.entity, input.id);
      }
      return;
    }
    const latest = await one<{ revision: number; mission_id: string }>(
      tx,
      `SELECT revision, mission_id FROM ${input.table}
       WHERE id = $1 ORDER BY revision DESC LIMIT 1${lockClause(this.database._provider, true)}`,
      [input.id],
    );
    if (
      (!latest && input.revision !== 1) ||
      (latest &&
        (String(latest.mission_id) !== input.missionId ||
          input.revision !== Number(latest.revision) + 1))
    ) {
      throw new ScientificEntityConflictError(
        input.entity,
        input.id,
        "revision is stale, cross-mission, or non-contiguous",
      );
    }
  }

  async assertMaterialOperationApproval(
    tx: ScientificTransaction,
    missionId: string,
    effect: Awaited<ReturnType<MdStoreContext["assertConfirmedOperation"]>>,
  ): Promise<void> {
    await assertAnExactApprovalExists(tx, {
      missionId,
      subjectType: "operation",
      subjectId: effect.operation.id,
      subjectVersion: 1,
      subjectRevision: 1,
      digest: effect.requestDigest,
    });
    const approvalTiming = await one<{ decided_at: string }>(
      tx,
      `SELECT response.decided_at
       FROM scientific_approval_requests AS request
       JOIN scientific_approval_responses AS response
         ON response.approval_request_id = request.id
       WHERE request.mission_id = $1 AND request.subject_type = 'operation'
         AND request.subject_id = $2 AND request.subject_version = 1
         AND request.subject_revision = 1 AND request.payload_digest = $3
         AND request.state = 'approved'`,
      [missionId, effect.operation.id, effect.requestDigest],
    );
    if (
      !approvalTiming ||
      Date.parse(String(approvalTiming.decided_at)) > Date.parse(effect.receipt.recordedAt)
    ) {
      throw new ScientificIntegrityError(
        "Material publication lacks an approval recorded before its confirmed receipt",
        { operationId: effect.operation.id },
      );
    }
  }

  async assertMaterialPublicationWorkUnit(
    tx: ScientificTransaction,
    input: {
      missionId: string;
      effect: Awaited<ReturnType<MdStoreContext["assertConfirmedOperation"]>>;
      binding: BiomolecularMaterialPublicationBinding;
      request: ForceFieldStackPublicationRequest | AtomMapPublicationRequest;
    },
  ): Promise<WorkUnit> {
    const row = await this.required<
      JsonRow & { mission_id: string; capability_id: string; state: string }
    >(tx, "material-publication WorkUnit", "scientific_work_units", input.effect.workUnitId);
    const workUnit = WorkUnitSchema.parse(parseJson(row, "material-publication WorkUnit"));
    await assertBiomolecularMaterialPublicationWorkUnit(tx, workUnit, input.binding);
    await assertMdWorkUnitProjectionDependencies(tx, workUnit);
    if (
      input.effect.operation.kind !== "system_preparation" ||
      String(row.mission_id) !== input.missionId ||
      workUnit.missionId !== input.missionId ||
      workUnit.id !== input.effect.workUnitId ||
      input.request.workUnitId !== workUnit.id ||
      !["executing", "observing", "succeeded"].includes(workUnit.state) ||
      String(row.state) !== workUnit.state ||
      workUnit.protocolFragment.kind !== "scientific_capability" ||
      String(row.capability_id) !== workUnit.protocolFragment.capability.id ||
      canonicalJson(input.request.capability) !==
        canonicalJson(workUnit.protocolFragment.capability) ||
      canonicalJson(input.binding) !== canonicalJson(workUnit.protocolFragment.parameters) ||
      input.request.parametersDigest !== digestCanonical(workUnit.protocolFragment.parameters) ||
      input.request.outputContractDigest !== digestCanonical(workUnit.outputContract)
    ) {
      throw new ScientificIntegrityError(
        "Material publication is outside its exact WorkUnit and typed operation request",
        { workUnitId: workUnit.id, operationId: input.effect.operation.id },
      );
    }
    await this.assertMaterialOperationApproval(tx, input.missionId, input.effect);
    return workUnit;
  }

  async claimMaterialEffect(
    tx: ScientificTransaction,
    input: {
      subjectType: MaterialSubjectType;
      subjectId: string;
      subjectRevision: number;
      missionId: string;
      operationId: string;
      operationReceiptId: string;
      requestDigest: string;
      contentDigest: string;
      createdAt: string;
    },
  ): Promise<void> {
    const payload = canonicalJson({
      schemaVersion: "eigengrid.biomolecular-material-effect/v1",
      ...input,
    });
    const inserted = await queryRows<{ subject_id: string }>(
      tx,
      `INSERT INTO scientific_biomolecular_material_effects
       (subject_type, subject_id, subject_revision, mission_id, operation_id,
        operation_receipt_id, request_digest, content_digest, payload_json, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING RETURNING subject_id`,
      [
        input.subjectType,
        input.subjectId,
        input.subjectRevision,
        input.missionId,
        input.operationId,
        input.operationReceiptId,
        input.requestDigest,
        input.contentDigest,
        payload,
        input.createdAt,
      ],
    );
    if (inserted.length > 0) return;
    const existing = await one<{
      subject_type: string;
      subject_id: string;
      subject_revision: number;
      mission_id: string;
      operation_id: string;
      operation_receipt_id: string;
      request_digest: string;
      content_digest: string;
    }>(
      tx,
      `SELECT subject_type, subject_id, subject_revision, mission_id, operation_id,
              operation_receipt_id, request_digest, content_digest
       FROM scientific_biomolecular_material_effects
       WHERE (subject_type = $1 AND subject_id = $2 AND subject_revision = $3)
          OR operation_id = $4 OR operation_receipt_id = $5`,
      [
        input.subjectType,
        input.subjectId,
        input.subjectRevision,
        input.operationId,
        input.operationReceiptId,
      ],
    );
    if (
      !existing ||
      String(existing.subject_type) !== input.subjectType ||
      String(existing.subject_id) !== input.subjectId ||
      Number(existing.subject_revision) !== input.subjectRevision ||
      String(existing.mission_id) !== input.missionId ||
      String(existing.operation_id) !== input.operationId ||
      String(existing.operation_receipt_id) !== input.operationReceiptId ||
      String(existing.request_digest) !== input.requestDigest ||
      String(existing.content_digest) !== input.contentDigest
    ) {
      throw new ScientificEntityConflictError(
        "biomolecular material effect",
        input.operationId,
        "operation or receipt already owns another material publication",
      );
    }
  }

  async claimMaterialArtifact(
    tx: ScientificTransaction,
    input: {
      evidence: EvidenceReference;
      subjectType: "system_manifest" | "force_field_stack";
      subjectId: string;
      subjectRevision: number;
      artifactRole: "topology" | "coordinates" | "atom_map" | "force_field_stack";
      operationReceiptId: string;
      claimedAt: string;
    },
  ): Promise<void> {
    if (!input.evidence.mediaType) {
      throw new ScientificIntegrityError("Material artifacts require an exact media type", {
        evidenceRef: input.evidence.id,
      });
    }
    const payload = canonicalJson({
      schemaVersion: "eigengrid.biomolecular-material-artifact-claim/v1",
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      subjectRevision: input.subjectRevision,
      artifactRole: input.artifactRole,
      evidenceRef: input.evidence.id,
      contentDigest: input.evidence.contentDigest,
      mediaType: input.evidence.mediaType,
      operationReceiptId: input.operationReceiptId,
    });
    const inserted = await queryRows<{ evidence_id: string }>(
      tx,
      `INSERT INTO scientific_biomolecular_material_artifact_claims
       (evidence_id, mission_id, subject_type, subject_id, subject_revision, artifact_role,
        operation_receipt_id, content_digest, media_type, size_bytes, payload_json, claimed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT DO NOTHING RETURNING evidence_id`,
      [
        input.evidence.id,
        input.evidence.missionId,
        input.subjectType,
        input.subjectId,
        input.subjectRevision,
        input.artifactRole,
        input.operationReceiptId,
        input.evidence.contentDigest,
        input.evidence.mediaType,
        input.evidence.sizeBytes ?? null,
        payload,
        input.claimedAt,
      ],
    );
    if (inserted.length > 0) return;
    const existing = await one<{
      evidence_id: string;
      mission_id: string;
      subject_type: string;
      subject_id: string;
      subject_revision: number;
      artifact_role: string;
      operation_receipt_id: string;
      content_digest: string;
      media_type: string;
    }>(
      tx,
      "SELECT * FROM scientific_biomolecular_material_artifact_claims WHERE evidence_id = $1",
      [input.evidence.id],
    );
    if (
      !existing ||
      String(existing.mission_id) !== input.evidence.missionId ||
      String(existing.subject_type) !== input.subjectType ||
      String(existing.subject_id) !== input.subjectId ||
      Number(existing.subject_revision) !== input.subjectRevision ||
      String(existing.artifact_role) !== input.artifactRole ||
      String(existing.operation_receipt_id) !== input.operationReceiptId ||
      String(existing.content_digest) !== input.evidence.contentDigest ||
      String(existing.media_type) !== input.evidence.mediaType
    ) {
      throw new ScientificEntityConflictError(
        "biomolecular material artifact",
        input.evidence.id,
        "artifact is already owned by another material revision",
      );
    }
  }
}
