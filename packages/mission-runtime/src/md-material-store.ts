/** Internal domain repository; callers use the public store facade. */
import {
  AtomMapPublicationRequestSchema,
  BiomolecularMaterialPublicationBindingSchema,
  BiomolecularSystemBuildRequestSchema,
  ForceFieldStackPublicationRequestSchema,
  WorkUnitSchema,
  assertAtomMapDigest,
  assertForceFieldStackDigest,
  assertPublishedBiomolecularSystemManifestDigest,
  canonicalJson,
  digestCanonical,
  type AtomMap,
  type BiomolecularSystemBuildRequest,
  type BiomolecularSystemManifest,
  type EvidenceReference,
  type ForceFieldStackManifest,
} from "@eigengrid/scientific-schema";
import {
  ScientificEntityConflictError,
  ScientificEntityNotFoundError,
  ScientificIntegrityError,
} from "./errors";
import { MdStoreContext } from "./md-store-context";
import { JsonRow, one, parseJson, queryRows } from "./md-store-queries";
import {
  ATOM_MAP_PUBLICATION_CAPABILITIES,
  BiomolecularDecision,
  BiomolecularMaterialPublicationAuthority,
  FORCE_FIELD_STACK_PUBLICATION_CAPABILITIES,
  assertAtomMapCoversSystem,
  assertBiomolecularSystemDecisionAuthority,
  assertCanonicalSetEqual,
  assertForceFieldMaterialDigests,
  assertForceFieldStackCoversSystem,
  computeBiomolecularDecisionMaterialDigest,
  exactDecisionEvidenceRequirements,
  forceFieldEvidenceRequirements,
  isOneOfCapabilities,
  isSystemManifestBuildCapability,
  parseBiomolecularDecision,
} from "./md-store-validation";
export class MdMaterialStore {
  constructor(private readonly context: MdStoreContext) {}

  async putBiomolecularDecision(input: BiomolecularDecision): Promise<BiomolecularDecision> {
    const decision = parseBiomolecularDecision(input);
    const materialDigest = computeBiomolecularDecisionMaterialDigest(decision);
    await this.context.inTransaction("persist biomolecular decision", async (tx) => {
      await this.context.assertMission(tx, decision.missionId);
      for (const requirement of exactDecisionEvidenceRequirements(decision)) {
        await this.context.assertCasEvidence(tx, {
          missionId: decision.missionId,
          evidenceRef: requirement.evidenceRef,
          ...(requirement.expectedDigest === undefined
            ? {}
            : { expectedDigest: requirement.expectedDigest }),
        });
      }
      if (decision.kind === "force_field_stack") {
        const selected = decision.candidates.find(
          (candidate) =>
            candidate.id === decision.selectedStack.id &&
            candidate.revision === decision.selectedStack.revision &&
            candidate.digest === decision.selectedStack.digest,
        )!;
        const stackRow = await one<{
          mission_id: string;
          stack_digest: string;
          artifact_evidence_id: string;
        }>(
          tx,
          `SELECT mission_id, stack_digest, artifact_evidence_id
           FROM scientific_force_field_stack_revisions WHERE id = $1 AND revision = $2`,
          [decision.selectedStack.id, decision.selectedStack.revision],
        );
        if (
          !stackRow ||
          String(stackRow.mission_id) !== decision.missionId ||
          String(stackRow.stack_digest) !== decision.selectedStack.digest ||
          String(stackRow.artifact_evidence_id) !== selected.evidenceRef
        ) {
          throw new ScientificIntegrityError(
            "Force-field decision does not select an exact durable stack revision",
            { decisionId: decision.id, stackId: decision.selectedStack.id },
          );
        }
      }
      if (decision.status === "approved") {
        const approval = await one<{
          mission_id: string;
          subject_type: string;
          subject_id: string;
          subject_version: number;
          subject_revision: number;
          state: string;
          payload_digest: string;
          response_decision: string | null;
          response_digest: string | null;
        }>(
          tx,
          `SELECT request.mission_id, request.subject_type, request.subject_id,
                  request.subject_version, request.subject_revision, request.state,
                  request.payload_digest, response.decision AS response_decision,
                  response.payload_digest AS response_digest
           FROM scientific_approval_requests AS request
           LEFT JOIN scientific_approval_responses AS response
             ON response.approval_request_id = request.id
           WHERE request.id = $1`,
          [decision.approvalRef!],
        );
        if (
          !approval ||
          String(approval.mission_id) !== decision.missionId ||
          String(approval.subject_type) !== "decision" ||
          String(approval.state) !== "approved" ||
          String(approval.subject_id) !== decision.id ||
          Number(approval.subject_version) !== decision.revision ||
          Number(approval.subject_revision) !== decision.revision ||
          String(approval.payload_digest) !== materialDigest ||
          String(approval.response_decision) !== "approved" ||
          String(approval.response_digest) !== materialDigest
        ) {
          throw new ScientificIntegrityError("Approved decision lacks its exact durable approval", {
            decisionId: decision.id,
          });
        }
      }
      await this.context.insertRevision(tx, {
        entity: "biomolecular decision",
        table: "scientific_biomolecular_decisions",
        id: decision.id,
        revision: decision.revision,
        payload: canonicalJson(decision),
        columns: [
          "id",
          "revision",
          "mission_id",
          "decision_kind",
          "review_status",
          "decision_digest",
          "material_digest",
          "approval_ref",
          "payload_json",
          "created_at",
          "updated_at",
        ],
        values: [
          decision.id,
          decision.revision,
          decision.missionId,
          decision.kind,
          decision.status,
          decision.decisionDigest,
          materialDigest,
          decision.approvalRef ?? null,
          canonicalJson(decision),
          decision.createdAt,
          decision.approvedAt ?? decision.createdAt,
        ],
      });
    });
    return decision;
  }

  async getBiomolecularDecision(
    id: string,
    revision: number,
  ): Promise<BiomolecularDecision | null> {
    return this.context.inTransaction("get biomolecular decision", async (tx) => {
      const row = await one<
        JsonRow & {
          mission_id: string;
          decision_kind: string;
          review_status: string;
          decision_digest: string;
          material_digest: string;
          approval_ref: string | null;
        }
      >(tx, "SELECT * FROM scientific_biomolecular_decisions WHERE id = $1 AND revision = $2", [
        id,
        revision,
      ]);
      if (!row) return null;
      const decision = parseBiomolecularDecision(parseJson(row, "biomolecular decision"));
      if (
        decision.id !== id ||
        decision.revision !== revision ||
        decision.missionId !== String(row.mission_id) ||
        decision.kind !== String(row.decision_kind) ||
        decision.status !== String(row.review_status) ||
        decision.decisionDigest !== String(row.decision_digest) ||
        decision.decisionDigest !== String(row.material_digest) ||
        (decision.approvalRef ?? null) !==
          (row.approval_ref === null ? null : String(row.approval_ref))
      ) {
        throw new ScientificIntegrityError("Biomolecular decision columns are corrupt", {
          id,
          revision,
        });
      }
      return decision;
    });
  }

  async putForceFieldStack(
    input: ForceFieldStackManifest,
    authority: BiomolecularMaterialPublicationAuthority,
  ): Promise<ForceFieldStackManifest> {
    const stack = assertForceFieldStackDigest(input);
    const payload = canonicalJson(stack);
    await this.context.inTransaction("persist force-field stack authority", async (tx) => {
      await this.context.assertMission(tx, authority.missionId);
      const effect = await this.context.assertConfirmedOperation(
        tx,
        authority.missionId,
        authority.operationId,
        authority.operationReceiptId,
      );
      const request = ForceFieldStackPublicationRequestSchema.parse(effect.operation.request);
      const requirements = forceFieldEvidenceRequirements(stack);
      const binding = BiomolecularMaterialPublicationBindingSchema.parse({
        schemaVersion: "eigengrid.biomolecular-material-publication-binding/v1",
        subjectKind: "force_field_stack",
        subject: { id: stack.id, revision: stack.revision, digest: stack.stackDigest },
        sourceEvidenceRefs: requirements.map((requirement) => requirement.evidenceRef),
        artifactEvidenceRef: request.outputArtifact.evidenceRef,
      });
      const workUnit = await this.context.assertMaterialPublicationWorkUnit(tx, {
        missionId: authority.missionId,
        effect,
        binding,
        request,
      });
      if (
        !isOneOfCapabilities(request.capability.id, FORCE_FIELD_STACK_PUBLICATION_CAPABILITIES) ||
        canonicalJson(request.stack) !== canonicalJson(binding.subject) ||
        request.outputArtifact.mediaType !== "application/vnd.eigengrid.force-field-stack+json"
      ) {
        throw new ScientificIntegrityError(
          "Force-field stack publication request does not bind its exact material identity",
          { stackId: stack.id },
        );
      }
      const evidenceById = new Map<string, EvidenceReference>();
      for (const requirement of requirements) {
        const evidence = await this.context.assertCasEvidence(tx, {
          missionId: authority.missionId,
          evidenceRef: requirement.evidenceRef,
        });
        if (!evidence.mediaType) {
          throw new ScientificIntegrityError("Force-field source evidence requires a media type", {
            evidenceRef: evidence.id,
          });
        }
        evidenceById.set(evidence.id, evidence);
      }
      assertCanonicalSetEqual(
        "Force-field stack source evidence request",
        request.sourceEvidence,
        [...evidenceById.values()].map((evidence) => ({
          id: evidence.id,
          contentDigest: evidence.contentDigest,
        })),
      );
      assertForceFieldMaterialDigests(
        stack,
        new Map(
          [...evidenceById.values()].map((evidence) => [evidence.id, evidence.contentDigest]),
        ),
        await this.context.linkedForceFieldDigests(
          tx,
          authority.missionId,
          stack,
          new Map(
            [...evidenceById.values()].map((evidence) => [evidence.id, evidence.contentDigest]),
          ),
        ),
      );
      const artifact = await this.context.assertCasEvidence(tx, {
        missionId: authority.missionId,
        evidenceRef: request.outputArtifact.evidenceRef,
        expectedDigest: stack.stackDigest,
        expectedKind: "force_field_stack",
        expectedMediaType: request.outputArtifact.mediaType,
        expectedWorkUnitId: workUnit.id,
        expectedSourceId: effect.receiptId,
      });
      await this.context.assertMaterialRevisionProgress(tx, {
        table: "scientific_force_field_stack_revisions",
        entity: "force-field stack",
        id: stack.id,
        revision: stack.revision,
        missionId: authority.missionId,
        payload,
      });
      await this.context.claimMaterialEffect(tx, {
        subjectType: "force_field_stack",
        subjectId: stack.id,
        subjectRevision: stack.revision,
        missionId: authority.missionId,
        operationId: effect.operation.id,
        operationReceiptId: effect.receiptId,
        requestDigest: effect.requestDigest,
        contentDigest: stack.stackDigest,
        createdAt: stack.createdAt,
      });
      await this.context.claimMaterialArtifact(tx, {
        evidence: artifact,
        subjectType: "force_field_stack",
        subjectId: stack.id,
        subjectRevision: stack.revision,
        artifactRole: "force_field_stack",
        operationReceiptId: effect.receiptId,
        claimedAt: stack.createdAt,
      });
      await this.context.insertRevision(tx, {
        entity: "force-field stack",
        table: "scientific_force_field_stack_revisions",
        id: stack.id,
        revision: stack.revision,
        payload,
        columns: [
          "id",
          "revision",
          "mission_id",
          "stack_digest",
          "artifact_evidence_id",
          "operation_id",
          "operation_receipt_id",
          "request_digest",
          "payload_json",
          "created_at",
        ],
        values: [
          stack.id,
          stack.revision,
          authority.missionId,
          stack.stackDigest,
          artifact.id,
          effect.operation.id,
          effect.receiptId,
          effect.requestDigest,
          payload,
          stack.createdAt,
        ],
      });
      for (const requirement of requirements) {
        const evidence = evidenceById.get(requirement.evidenceRef)!;
        const evidencePayload = canonicalJson({
          evidenceRef: evidence.id,
          roles: requirement.roles,
          contentDigest: evidence.contentDigest,
          mediaType: evidence.mediaType,
        });
        const inserted = await queryRows<{ evidence_id: string }>(
          tx,
          `INSERT INTO scientific_force_field_stack_evidence
           (stack_id, stack_revision, evidence_id, evidence_roles_json, content_digest,
            media_type, size_bytes, payload_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT DO NOTHING RETURNING evidence_id`,
          [
            stack.id,
            stack.revision,
            evidence.id,
            canonicalJson(requirement.roles),
            evidence.contentDigest,
            evidence.mediaType!,
            evidence.sizeBytes ?? null,
            evidencePayload,
          ],
        );
        if (inserted.length === 0) {
          const existing = await one<JsonRow>(
            tx,
            `SELECT payload_json FROM scientific_force_field_stack_evidence
             WHERE stack_id = $1 AND stack_revision = $2 AND evidence_id = $3`,
            [stack.id, stack.revision, evidence.id],
          );
          if (!existing || String(existing.payload_json) !== evidencePayload) {
            throw new ScientificEntityConflictError("force-field stack evidence", evidence.id);
          }
        }
      }
    });
    return stack;
  }

  async getForceFieldStack(
    missionId: string,
    id: string,
    revision: number,
  ): Promise<ForceFieldStackManifest | null> {
    return this.context.inTransaction("get force-field stack authority", async (tx) => {
      const row = await one<
        JsonRow & {
          mission_id: string;
          stack_digest: string;
          artifact_evidence_id: string;
          operation_id: string;
          operation_receipt_id: string;
          request_digest: string;
        }
      >(
        tx,
        `SELECT * FROM scientific_force_field_stack_revisions
         WHERE id = $1 AND revision = $2 AND mission_id = $3`,
        [id, revision, missionId],
      );
      if (!row) return null;
      const stack = assertForceFieldStackDigest(parseJson(row, "force-field stack"));
      if (
        stack.id !== id ||
        stack.revision !== revision ||
        stack.stackDigest !== String(row.stack_digest)
      ) {
        throw new ScientificIntegrityError("Force-field stack columns are corrupt", {
          id,
          revision,
        });
      }
      const effect = await this.context.assertConfirmedOperation(
        tx,
        missionId,
        String(row.operation_id),
        String(row.operation_receipt_id),
      );
      if (effect.requestDigest !== String(row.request_digest)) {
        throw new ScientificIntegrityError("Force-field stack effect digest is corrupt", { id });
      }
      const artifact = await this.context.assertCasEvidence(tx, {
        missionId,
        evidenceRef: String(row.artifact_evidence_id),
        expectedDigest: stack.stackDigest,
        expectedKind: "force_field_stack",
        expectedWorkUnitId: effect.workUnitId,
        expectedSourceId: effect.receiptId,
      });
      const claim = await one<{
        subject_type: string;
        subject_id: string;
        subject_revision: number;
        operation_id: string;
        operation_receipt_id: string;
        content_digest: string;
      }>(
        tx,
        `SELECT subject_type, subject_id, subject_revision, operation_id,
                operation_receipt_id, content_digest
         FROM scientific_biomolecular_material_effects
         WHERE subject_type = 'force_field_stack' AND subject_id = $1 AND subject_revision = $2`,
        [id, revision],
      );
      if (
        !claim ||
        String(claim.subject_id) !== id ||
        Number(claim.subject_revision) !== revision ||
        String(claim.operation_id) !== effect.operation.id ||
        String(claim.operation_receipt_id) !== effect.receiptId ||
        String(claim.content_digest) !== stack.stackDigest
      ) {
        throw new ScientificIntegrityError("Force-field stack material-effect claim is corrupt", {
          id,
        });
      }
      const artifactClaim = await one<{
        mission_id: string;
        subject_id: string;
        subject_revision: number;
        artifact_role: string;
        operation_receipt_id: string;
        content_digest: string;
      }>(
        tx,
        `SELECT mission_id, subject_id, subject_revision, artifact_role,
                operation_receipt_id, content_digest
         FROM scientific_biomolecular_material_artifact_claims WHERE evidence_id = $1`,
        [artifact.id],
      );
      if (
        !artifactClaim ||
        String(artifactClaim.mission_id) !== missionId ||
        String(artifactClaim.subject_id) !== id ||
        Number(artifactClaim.subject_revision) !== revision ||
        String(artifactClaim.artifact_role) !== "force_field_stack" ||
        String(artifactClaim.operation_receipt_id) !== effect.receiptId ||
        String(artifactClaim.content_digest) !== stack.stackDigest
      ) {
        throw new ScientificIntegrityError("Force-field stack artifact claim is corrupt", { id });
      }
      const requirements = forceFieldEvidenceRequirements(stack);
      const rows = await queryRows<{
        evidence_id: string;
        evidence_roles_json: string;
        content_digest: string;
        media_type: string;
        size_bytes: number | null;
      }>(
        tx,
        `SELECT evidence_id, evidence_roles_json, content_digest, media_type, size_bytes
         FROM scientific_force_field_stack_evidence
         WHERE stack_id = $1 AND stack_revision = $2`,
        [id, revision],
      );
      if (rows.length !== requirements.length) {
        throw new ScientificIntegrityError("Force-field stack evidence projection is incomplete", {
          id,
        });
      }
      const digests = new Map<string, string>();
      for (const requirement of requirements) {
        const evidenceRow = rows.find(
          (candidate) => String(candidate.evidence_id) === requirement.evidenceRef,
        );
        if (
          !evidenceRow ||
          canonicalJson(JSON.parse(String(evidenceRow.evidence_roles_json))) !==
            canonicalJson(requirement.roles)
        ) {
          throw new ScientificIntegrityError("Force-field evidence roles are corrupt", {
            id,
            evidenceRef: requirement.evidenceRef,
          });
        }
        const evidence = await this.context.assertCasEvidence(tx, {
          missionId,
          evidenceRef: requirement.evidenceRef,
          expectedDigest: String(evidenceRow.content_digest),
          expectedMediaType: String(evidenceRow.media_type),
          ...(evidenceRow.size_bytes === null
            ? {}
            : { expectedSizeBytes: Number(evidenceRow.size_bytes) }),
        });
        digests.set(evidence.id, evidence.contentDigest);
      }
      assertForceFieldMaterialDigests(
        stack,
        digests,
        await this.context.linkedForceFieldDigests(tx, missionId, stack, digests),
      );
      if (!artifact.mediaType) {
        throw new ScientificIntegrityError("Force-field stack artifact lost its media type", {
          id,
        });
      }
      return stack;
    });
  }

  async putSystemManifest(input: BiomolecularSystemManifest): Promise<BiomolecularSystemManifest> {
    const manifest = assertPublishedBiomolecularSystemManifestDigest(input);
    await this.context.inTransaction("persist biomolecular system manifest", async (tx) => {
      await this.context.assertMission(tx, manifest.missionId);
      if (!manifest.provenance.operationReceiptId) {
        throw new ScientificIntegrityError(
          "A system manifest must identify its exact operation receipt",
          { manifestId: manifest.id },
        );
      }
      const effect = await this.context.assertConfirmedOperation(
        tx,
        manifest.missionId,
        manifest.provenance.operationId,
        manifest.provenance.operationReceiptId,
      );
      await this.context.assertMaterialOperationApproval(tx, manifest.missionId, effect);
      if (effect.operation.kind !== "system_preparation") {
        throw new ScientificIntegrityError(
          "A system manifest requires a typed system-preparation operation",
          { manifestId: manifest.id, operationId: effect.operation.id },
        );
      }
      const request = BiomolecularSystemBuildRequestSchema.parse(effect.operation.request);
      const workUnitRow = await this.context.required<
        JsonRow & { mission_id: string; capability_id: string; state: string }
      >(tx, "system-build WorkUnit", "scientific_work_units", effect.workUnitId);
      const workUnit = WorkUnitSchema.parse(parseJson(workUnitRow, "system-build WorkUnit"));
      if (workUnit.protocolFragment.kind !== "scientific_capability") {
        throw new ScientificIntegrityError(
          "A system manifest requires a scientific-capability WorkUnit",
          { manifestId: manifest.id, workUnitId: workUnit.id },
        );
      }
      const capability = workUnit.protocolFragment.capability;
      if (
        String(workUnitRow.mission_id) !== manifest.missionId ||
        workUnit.missionId !== manifest.missionId ||
        workUnit.id !== effect.workUnitId ||
        !["executing", "observing", "succeeded"].includes(workUnit.state) ||
        String(workUnitRow.state) !== workUnit.state ||
        String(workUnitRow.capability_id) !== capability.id ||
        workUnit.executionPolicy.capability !== capability.id ||
        !isSystemManifestBuildCapability(capability.id) ||
        canonicalJson(request.capability) !== canonicalJson(capability) ||
        request.workUnitId !== workUnit.id ||
        request.parametersDigest !== digestCanonical(workUnit.protocolFragment.parameters) ||
        request.outputContractDigest !== digestCanonical(workUnit.outputContract) ||
        request.systemManifest.id !== manifest.id ||
        request.systemManifest.revision !== manifest.revision ||
        canonicalJson(request.forceFieldStack) !== canonicalJson(manifest.forceFieldStack)
      ) {
        throw new ScientificIntegrityError(
          "System manifest effect is outside its exact WorkUnit request",
          { manifestId: manifest.id, workUnitId: effect.workUnitId },
        );
      }
      const stackRow = await one<
        JsonRow & {
          mission_id: string;
          stack_digest: string;
          artifact_evidence_id: string;
        }
      >(
        tx,
        `SELECT mission_id, stack_digest, artifact_evidence_id, payload_json
         FROM scientific_force_field_stack_revisions WHERE id = $1 AND revision = $2`,
        [manifest.forceFieldStack.id, manifest.forceFieldStack.revision],
      );
      if (!stackRow) {
        throw new ScientificEntityNotFoundError(
          "force-field stack authority",
          manifest.forceFieldStack.id,
        );
      }
      const stack = assertForceFieldStackDigest(parseJson(stackRow, "manifest force-field stack"));
      if (
        String(stackRow.mission_id) !== manifest.missionId ||
        stack.id !== manifest.forceFieldStack.id ||
        stack.revision !== manifest.forceFieldStack.revision ||
        stack.stackDigest !== manifest.forceFieldStack.digest ||
        String(stackRow.stack_digest) !== manifest.forceFieldStack.digest
      ) {
        throw new ScientificIntegrityError(
          "System manifest force-field stack reference is stale or cross-mission",
          { manifestId: manifest.id, stackId: stack.id },
        );
      }
      assertForceFieldStackCoversSystem(stack, manifest);
      const stackArtifact = await this.context.assertCasEvidence(tx, {
        missionId: manifest.missionId,
        evidenceRef: String(stackRow.artifact_evidence_id),
        expectedDigest: stack.stackDigest,
        expectedKind: "force_field_stack",
      });
      const stackClaims = await queryRows<{ subject_id: string }>(
        tx,
        `SELECT effect.subject_id
         FROM scientific_biomolecular_material_effects AS effect
         JOIN scientific_biomolecular_material_artifact_claims AS artifact
           ON artifact.subject_type = effect.subject_type
          AND artifact.subject_id = effect.subject_id
          AND artifact.subject_revision = effect.subject_revision
         WHERE effect.subject_type = 'force_field_stack' AND effect.subject_id = $1
           AND effect.subject_revision = $2 AND effect.mission_id = $3
           AND effect.content_digest = $4 AND artifact.evidence_id = $5
           AND artifact.artifact_role = 'force_field_stack'
           AND artifact.content_digest = $4`,
        [stack.id, stack.revision, manifest.missionId, stack.stackDigest, stackArtifact.id],
      );
      if (stackClaims.length !== 1) {
        throw new ScientificIntegrityError("Force-field stack durable claims are incomplete", {
          manifestId: manifest.id,
          stackId: stack.id,
        });
      }
      assertCanonicalSetEqual(
        "System-build decision binding",
        request.decisionRefs,
        manifest.decisionRefs,
      );
      const sourceEvidenceRefs = new Set([
        ...manifest.sourceEvidenceRefs,
        ...Object.values(manifest.components).flatMap((components) =>
          components.flatMap((component) => component.sourceEvidenceRefs),
        ),
      ]);
      const verifiedSourceEvidence: Array<{ id: string; contentDigest: string }> = [];
      for (const evidenceRef of sourceEvidenceRefs) {
        const evidence = await this.context.assertCasEvidence(tx, {
          missionId: manifest.missionId,
          evidenceRef,
        });
        verifiedSourceEvidence.push({ id: evidence.id, contentDigest: evidence.contentDigest });
      }
      assertCanonicalSetEqual(
        "System-build source evidence binding",
        request.sourceEvidence,
        verifiedSourceEvidence,
      );
      assertCanonicalSetEqual("System-build WorkUnit input evidence", workUnit.inputRefs, [
        ...request.sourceEvidence.map((evidence) => evidence.id),
        stackArtifact.id,
      ]);
      for (const requiredKind of ["topology", "coordinates", "atom_map"] as const) {
        if (!workUnit.outputContract.requiredEvidenceKinds.includes(requiredKind)) {
          throw new ScientificIntegrityError(
            "System-build WorkUnit omits a required material artifact",
            { manifestId: manifest.id, evidenceKind: requiredKind },
          );
        }
      }
      await this.context.assertDecisionRequirements(
        tx,
        manifest.missionId,
        manifest.decisionRefs.map((decision) => ({
          id: decision.id,
          revision: decision.revision,
          digest: decision.decisionDigest,
          approvalRef: decision.approvalRef,
        })),
      );
      const loadExactDecision = async (
        reference: BiomolecularSystemManifest["decisionRefs"][number],
      ): Promise<BiomolecularDecision> => {
        const row = await one<
          JsonRow & {
            mission_id: string;
            decision_kind: string;
            decision_digest: string;
            approval_ref: string | null;
            review_status: string;
          }
        >(
          tx,
          `SELECT mission_id, decision_kind, decision_digest, approval_ref,
                  review_status, payload_json
           FROM scientific_biomolecular_decisions WHERE id = $1 AND revision = $2`,
          [reference.id, reference.revision],
        );
        if (!row) {
          throw new ScientificEntityNotFoundError("exact biomolecular decision", reference.id);
        }
        const decision = parseBiomolecularDecision(parseJson(row, "manifest decision"));
        if (
          decision.id !== reference.id ||
          decision.revision !== reference.revision ||
          decision.missionId !== manifest.missionId ||
          String(row.mission_id) !== manifest.missionId ||
          decision.kind !== reference.kind ||
          String(row.decision_kind) !== reference.kind ||
          decision.decisionDigest !== reference.decisionDigest ||
          String(row.decision_digest) !== reference.decisionDigest ||
          decision.status !== "approved" ||
          String(row.review_status) !== "approved" ||
          decision.approvalRef !== reference.approvalRef ||
          String(row.approval_ref) !== reference.approvalRef
        ) {
          throw new ScientificIntegrityError(
            "System manifest decision reference is not exact and approved",
            { manifestId: manifest.id, decisionId: reference.id },
          );
        }
        return decision;
      };
      const decisionById = new Map<string, BiomolecularDecision>();
      for (const reference of manifest.decisionRefs) {
        decisionById.set(reference.id, await loadExactDecision(reference));
      }
      assertBiomolecularSystemDecisionAuthority(manifest, [...decisionById.values()]);
      const outputArtifacts = [
        {
          role: "topology" as const,
          binding: request.outputArtifacts.topology,
          digest: manifest.topologyDigest,
        },
        {
          role: "coordinates" as const,
          binding: request.outputArtifacts.coordinates,
          digest: manifest.coordinateDigest,
        },
        {
          role: "atom_map" as const,
          binding: request.outputArtifacts.atomMap,
          digest: manifest.atomMapDigest,
        },
      ];
      const verifiedOutputArtifacts: Array<{
        role: "topology" | "coordinates" | "atom_map";
        binding: BiomolecularSystemBuildRequest["outputArtifacts"]["topology"];
        contentDigest: string;
        sizeBytes?: number;
      }> = [];
      for (const output of outputArtifacts) {
        const evidence = await this.context.assertCasEvidence(tx, {
          missionId: manifest.missionId,
          evidenceRef: output.binding.evidenceRef,
          expectedDigest: output.digest,
          expectedKind: output.role,
          expectedMediaType: output.binding.mediaType,
          expectedWorkUnitId: workUnit.id,
          expectedSourceId: effect.receiptId,
        });
        verifiedOutputArtifacts.push({
          role: output.role,
          binding: output.binding,
          contentDigest: output.digest,
          ...(evidence.sizeBytes === undefined ? {} : { sizeBytes: evidence.sizeBytes }),
        });
      }
      const claimedEffect = await one<{
        manifest_id: string;
        manifest_revision: number;
        operation_id: string;
        operation_receipt_id: string;
      }>(
        tx,
        `SELECT manifest_id, manifest_revision, operation_id, operation_receipt_id
         FROM scientific_biomolecular_manifest_effects
         WHERE operation_id = $1 OR operation_receipt_id = $2`,
        [effect.operation.id, effect.receiptId],
      );
      if (
        claimedEffect &&
        (String(claimedEffect.manifest_id) !== manifest.id ||
          Number(claimedEffect.manifest_revision) !== manifest.revision ||
          String(claimedEffect.operation_id) !== effect.operation.id ||
          String(claimedEffect.operation_receipt_id) !== effect.receiptId)
      ) {
        throw new ScientificEntityConflictError(
          "system-manifest external effect",
          effect.operation.id,
          "operation or receipt already published another manifest",
        );
      }
      await this.context.insertRevision(tx, {
        entity: "biomolecular system manifest",
        table: "scientific_biomolecular_system_manifests",
        id: manifest.id,
        revision: manifest.revision,
        payload: canonicalJson(manifest),
        columns: [
          "id",
          "revision",
          "mission_id",
          "operation_id",
          "manifest_digest",
          "topology_digest",
          "coordinate_digest",
          "atom_map_digest",
          "payload_json",
          "created_at",
        ],
        values: [
          manifest.id,
          manifest.revision,
          manifest.missionId,
          manifest.provenance.operationId,
          manifest.manifestDigest,
          manifest.topologyDigest,
          manifest.coordinateDigest,
          manifest.atomMapDigest,
          canonicalJson(manifest),
          manifest.provenance.createdAt,
        ],
      });
      await this.context.claimMaterialEffect(tx, {
        subjectType: "system_manifest",
        subjectId: manifest.id,
        subjectRevision: manifest.revision,
        missionId: manifest.missionId,
        operationId: effect.operation.id,
        operationReceiptId: effect.receiptId,
        requestDigest: effect.requestDigest,
        contentDigest: manifest.manifestDigest,
        createdAt: manifest.provenance.createdAt,
      });
      const effectPayload = canonicalJson({
        schemaVersion: "eigengrid.biomolecular-manifest-effect/v1",
        manifestId: manifest.id,
        manifestRevision: manifest.revision,
        operationId: effect.operation.id,
        operationReceiptId: effect.receiptId,
        requestDigest: effect.requestDigest,
        manifestDigest: manifest.manifestDigest,
      });
      const insertedEffect = await queryRows<{ manifest_id: string }>(
        tx,
        `INSERT INTO scientific_biomolecular_manifest_effects
         (manifest_id, manifest_revision, mission_id, operation_id, operation_receipt_id,
          request_digest, manifest_digest, payload_json, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT DO NOTHING RETURNING manifest_id`,
        [
          manifest.id,
          manifest.revision,
          manifest.missionId,
          effect.operation.id,
          effect.receiptId,
          effect.requestDigest,
          manifest.manifestDigest,
          effectPayload,
          manifest.provenance.createdAt,
        ],
      );
      if (insertedEffect.length === 0) {
        const existing = await one<JsonRow>(
          tx,
          `SELECT payload_json FROM scientific_biomolecular_manifest_effects
           WHERE manifest_id = $1 AND manifest_revision = $2`,
          [manifest.id, manifest.revision],
        );
        if (!existing || String(existing.payload_json) !== effectPayload) {
          throw new ScientificEntityConflictError("system-manifest effect", manifest.id);
        }
      }
      for (const artifact of verifiedOutputArtifacts) {
        const payload = canonicalJson({
          ...artifact.binding,
          contentDigest: artifact.contentDigest,
        });
        const inserted = await queryRows<{ manifest_id: string }>(
          tx,
          `INSERT INTO scientific_biomolecular_manifest_artifacts
           (manifest_id, manifest_revision, artifact_role, evidence_id, operation_receipt_id,
            content_digest, media_type, size_bytes, payload_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT DO NOTHING RETURNING manifest_id`,
          [
            manifest.id,
            manifest.revision,
            artifact.role,
            artifact.binding.evidenceRef,
            effect.receiptId,
            artifact.contentDigest,
            artifact.binding.mediaType,
            artifact.sizeBytes ?? null,
            payload,
          ],
        );
        if (inserted.length === 0) {
          const existing = await one<JsonRow>(
            tx,
            `SELECT payload_json FROM scientific_biomolecular_manifest_artifacts
             WHERE manifest_id = $1 AND manifest_revision = $2 AND artifact_role = $3`,
            [manifest.id, manifest.revision, artifact.role],
          );
          if (!existing || String(existing.payload_json) !== payload) {
            throw new ScientificEntityConflictError(
              "system-manifest artifact",
              `${manifest.id}:${artifact.role}`,
            );
          }
        }
        const evidence = await this.context.assertCasEvidence(tx, {
          missionId: manifest.missionId,
          evidenceRef: artifact.binding.evidenceRef,
          expectedDigest: artifact.contentDigest,
          expectedMediaType: artifact.binding.mediaType,
          expectedWorkUnitId: workUnit.id,
          expectedSourceId: effect.receiptId,
        });
        await this.context.claimMaterialArtifact(tx, {
          evidence,
          subjectType: "system_manifest",
          subjectId: manifest.id,
          subjectRevision: manifest.revision,
          artifactRole: artifact.role,
          operationReceiptId: effect.receiptId,
          claimedAt: manifest.provenance.createdAt,
        });
      }
    });
    return manifest;
  }

  async getSystemManifest(
    id: string,
    revision: number,
  ): Promise<BiomolecularSystemManifest | null> {
    return this.context.inTransaction("get biomolecular system manifest", async (tx) => {
      const row = await one<
        JsonRow & {
          mission_id: string;
          manifest_digest: string;
          topology_digest: string;
          coordinate_digest: string;
          atom_map_digest: string;
        }
      >(
        tx,
        `SELECT mission_id, manifest_digest, topology_digest, coordinate_digest,
                atom_map_digest, payload_json FROM scientific_biomolecular_system_manifests
         WHERE id = $1 AND revision = $2`,
        [id, revision],
      );
      if (!row) return null;
      const manifest = assertPublishedBiomolecularSystemManifestDigest(
        parseJson(row, "system manifest"),
      );
      if (
        manifest.id !== id ||
        manifest.revision !== revision ||
        manifest.missionId !== String(row.mission_id) ||
        manifest.manifestDigest !== String(row.manifest_digest) ||
        manifest.topologyDigest !== String(row.topology_digest) ||
        manifest.coordinateDigest !== String(row.coordinate_digest) ||
        manifest.atomMapDigest !== String(row.atom_map_digest)
      ) {
        throw new ScientificIntegrityError("System manifest columns are corrupt", {
          id,
          revision,
        });
      }
      return manifest;
    });
  }

  async putAtomMap(
    input: AtomMap,
    authority: BiomolecularMaterialPublicationAuthority,
  ): Promise<AtomMap> {
    const atomMap = assertAtomMapDigest(input);
    const payload = canonicalJson(atomMap);
    await this.context.inTransaction("persist atom-map authority", async (tx) => {
      await this.context.assertMission(tx, authority.missionId);
      const effect = await this.context.assertConfirmedOperation(
        tx,
        authority.missionId,
        authority.operationId,
        authority.operationReceiptId,
      );
      const request = AtomMapPublicationRequestSchema.parse(effect.operation.request);
      const manifestRow = await one<JsonRow & { mission_id: string; manifest_digest: string }>(
        tx,
        `SELECT mission_id, manifest_digest, payload_json
         FROM scientific_biomolecular_system_manifests WHERE id = $1 AND revision = $2`,
        [atomMap.systemManifestId, atomMap.systemManifestRevision],
      );
      if (!manifestRow) {
        throw new ScientificEntityNotFoundError(
          "atom-map system manifest",
          atomMap.systemManifestId,
        );
      }
      const manifest = assertPublishedBiomolecularSystemManifestDigest(
        parseJson(manifestRow, "atom-map system manifest"),
      );
      const artifactRow = await one<{
        evidence_id: string;
        operation_receipt_id: string;
        content_digest: string;
        media_type: string;
      }>(
        tx,
        `SELECT evidence_id, operation_receipt_id, content_digest, media_type
         FROM scientific_biomolecular_manifest_artifacts
         WHERE manifest_id = $1 AND manifest_revision = $2 AND artifact_role = 'atom_map'`,
        [manifest.id, manifest.revision],
      );
      if (!artifactRow) {
        throw new ScientificIntegrityError(
          "System manifest lacks its atom-map artifact authority",
          {
            manifestId: manifest.id,
          },
        );
      }
      const manifestEffect = await one<{ work_unit_id: string }>(
        tx,
        `SELECT operation.work_unit_id
         FROM scientific_biomolecular_manifest_effects AS binding
         JOIN scientific_external_operations AS operation ON operation.id = binding.operation_id
         WHERE binding.manifest_id = $1 AND binding.manifest_revision = $2`,
        [manifest.id, manifest.revision],
      );
      if (!manifestEffect) {
        throw new ScientificIntegrityError("System manifest effect authority is missing", {
          manifestId: manifest.id,
        });
      }
      const binding = BiomolecularMaterialPublicationBindingSchema.parse({
        schemaVersion: "eigengrid.biomolecular-material-publication-binding/v1",
        subjectKind: "atom_map",
        subject: { id: atomMap.id, revision: atomMap.revision, digest: atomMap.mapDigest },
        systemManifest: {
          id: manifest.id,
          revision: manifest.revision,
          digest: manifest.manifestDigest,
        },
        sourceEvidenceRefs: [String(artifactRow.evidence_id)],
        artifactEvidenceRef: String(artifactRow.evidence_id),
      });
      await this.context.assertMaterialPublicationWorkUnit(tx, {
        missionId: authority.missionId,
        effect,
        binding,
        request,
      });
      if (
        binding.subjectKind !== "atom_map" ||
        !isOneOfCapabilities(request.capability.id, ATOM_MAP_PUBLICATION_CAPABILITIES) ||
        canonicalJson(request.atomMap) !== canonicalJson(binding.subject) ||
        canonicalJson(request.systemManifest) !== canonicalJson(binding.systemManifest) ||
        request.sourceArtifact.evidenceRef !== String(artifactRow.evidence_id) ||
        request.sourceArtifact.mediaType !== String(artifactRow.media_type) ||
        request.sourceArtifact.mediaType !== "application/vnd.eigengrid.atom-map+json" ||
        String(manifestRow.mission_id) !== authority.missionId ||
        manifest.missionId !== authority.missionId ||
        atomMap.systemManifestId !== manifest.id ||
        atomMap.systemManifestRevision !== manifest.revision ||
        atomMap.atomCount !== manifest.atomCount ||
        atomMap.topologyDigest !== manifest.topologyDigest ||
        atomMap.coordinateDigest !== manifest.coordinateDigest ||
        atomMap.mapDigest !== manifest.atomMapDigest ||
        String(artifactRow.content_digest) !== atomMap.mapDigest
      ) {
        throw new ScientificIntegrityError(
          "Atom map is not the exact material identity of its system manifest",
          { atomMapId: atomMap.id, manifestId: manifest.id },
        );
      }
      assertAtomMapCoversSystem(atomMap, manifest);
      await this.context.assertCasEvidence(tx, {
        missionId: authority.missionId,
        evidenceRef: String(artifactRow.evidence_id),
        expectedDigest: atomMap.mapDigest,
        expectedKind: "atom_map",
        expectedMediaType: request.sourceArtifact.mediaType,
        expectedWorkUnitId: String(manifestEffect.work_unit_id),
        expectedSourceId: String(artifactRow.operation_receipt_id),
      });
      await this.context.assertMaterialRevisionProgress(tx, {
        table: "scientific_atom_map_revisions",
        entity: "atom map",
        id: atomMap.id,
        revision: atomMap.revision,
        missionId: authority.missionId,
        payload,
      });
      await this.context.claimMaterialEffect(tx, {
        subjectType: "atom_map",
        subjectId: atomMap.id,
        subjectRevision: atomMap.revision,
        missionId: authority.missionId,
        operationId: effect.operation.id,
        operationReceiptId: effect.receiptId,
        requestDigest: effect.requestDigest,
        contentDigest: atomMap.mapDigest,
        createdAt: effect.receipt.recordedAt,
      });
      await this.context.insertRevision(tx, {
        entity: "atom map",
        table: "scientific_atom_map_revisions",
        id: atomMap.id,
        revision: atomMap.revision,
        payload,
        columns: [
          "id",
          "revision",
          "mission_id",
          "system_manifest_id",
          "system_manifest_revision",
          "map_digest",
          "topology_digest",
          "coordinate_digest",
          "atom_count",
          "artifact_evidence_id",
          "operation_id",
          "operation_receipt_id",
          "request_digest",
          "payload_json",
          "created_at",
        ],
        values: [
          atomMap.id,
          atomMap.revision,
          authority.missionId,
          manifest.id,
          manifest.revision,
          atomMap.mapDigest,
          atomMap.topologyDigest,
          atomMap.coordinateDigest,
          atomMap.atomCount,
          artifactRow.evidence_id,
          effect.operation.id,
          effect.receiptId,
          effect.requestDigest,
          payload,
          effect.receipt.recordedAt,
        ],
      });
    });
    return atomMap;
  }

  /** Resolve the unique already-published AtomMap, never a caller-invented ID. */
  async findAtomMapForSystem(
    missionId: string,
    systemId: string,
    systemRevision: number,
    mapDigest: string,
  ): Promise<AtomMap> {
    const rows = await this.context.inTransaction("resolve exact atom map", (tx) =>
      queryRows<{ id: string; revision: number }>(
        tx,
        `SELECT id, revision FROM scientific_atom_map_revisions WHERE mission_id=$1 AND system_manifest_id=$2
       AND system_manifest_revision=$3 AND map_digest=$4 ORDER BY id, revision LIMIT 2`,
        [missionId, systemId, systemRevision, mapDigest],
      ),
    );
    if (rows.length !== 1)
      throw new ScientificIntegrityError("Exact system AtomMap is missing or ambiguous");
    const value = await this.getAtomMap(missionId, rows[0]!.id, Number(rows[0]!.revision));
    if (!value) throw new ScientificIntegrityError("Published AtomMap disappeared");
    return value;
  }

  async getAtomMap(missionId: string, id: string, revision: number): Promise<AtomMap | null> {
    return this.context.inTransaction("get atom-map authority", async (tx) => {
      const row = await one<
        JsonRow & {
          mission_id: string;
          system_manifest_id: string;
          system_manifest_revision: number;
          map_digest: string;
          topology_digest: string;
          coordinate_digest: string;
          atom_count: number;
          artifact_evidence_id: string;
          operation_id: string;
          operation_receipt_id: string;
          request_digest: string;
        }
      >(
        tx,
        `SELECT * FROM scientific_atom_map_revisions
         WHERE id = $1 AND revision = $2 AND mission_id = $3`,
        [id, revision, missionId],
      );
      if (!row) return null;
      const atomMap = assertAtomMapDigest(parseJson(row, "atom map"));
      const manifestRow = await one<JsonRow & { mission_id: string }>(
        tx,
        `SELECT mission_id, payload_json FROM scientific_biomolecular_system_manifests
         WHERE id = $1 AND revision = $2`,
        [row.system_manifest_id, row.system_manifest_revision],
      );
      if (!manifestRow) {
        throw new ScientificEntityNotFoundError(
          "atom-map system manifest",
          atomMap.systemManifestId,
        );
      }
      const manifest = assertPublishedBiomolecularSystemManifestDigest(
        parseJson(manifestRow, "atom-map system manifest"),
      );
      if (
        atomMap.id !== id ||
        atomMap.revision !== revision ||
        String(row.mission_id) !== missionId ||
        String(manifestRow.mission_id) !== missionId ||
        atomMap.systemManifestId !== String(row.system_manifest_id) ||
        atomMap.systemManifestRevision !== Number(row.system_manifest_revision) ||
        atomMap.mapDigest !== String(row.map_digest) ||
        atomMap.topologyDigest !== String(row.topology_digest) ||
        atomMap.coordinateDigest !== String(row.coordinate_digest) ||
        atomMap.atomCount !== Number(row.atom_count) ||
        atomMap.systemManifestId !== manifest.id ||
        atomMap.systemManifestRevision !== manifest.revision ||
        atomMap.mapDigest !== manifest.atomMapDigest ||
        atomMap.topologyDigest !== manifest.topologyDigest ||
        atomMap.coordinateDigest !== manifest.coordinateDigest ||
        atomMap.atomCount !== manifest.atomCount
      ) {
        throw new ScientificIntegrityError("Atom-map columns or manifest binding are corrupt", {
          id,
          revision,
        });
      }
      assertAtomMapCoversSystem(atomMap, manifest);
      const effect = await this.context.assertConfirmedOperation(
        tx,
        missionId,
        String(row.operation_id),
        String(row.operation_receipt_id),
      );
      if (effect.requestDigest !== String(row.request_digest)) {
        throw new ScientificIntegrityError("Atom-map effect digest is corrupt", { id });
      }
      const artifactBinding = await one<{
        evidence_id: string;
        operation_receipt_id: string;
        media_type: string;
      }>(
        tx,
        `SELECT evidence_id, operation_receipt_id, media_type
         FROM scientific_biomolecular_manifest_artifacts
         WHERE manifest_id = $1 AND manifest_revision = $2 AND artifact_role = 'atom_map'`,
        [manifest.id, manifest.revision],
      );
      const manifestEffect = await one<{ work_unit_id: string }>(
        tx,
        `SELECT operation.work_unit_id
         FROM scientific_biomolecular_manifest_effects AS binding
         JOIN scientific_external_operations AS operation ON operation.id = binding.operation_id
         WHERE binding.manifest_id = $1 AND binding.manifest_revision = $2`,
        [manifest.id, manifest.revision],
      );
      if (
        !artifactBinding ||
        !manifestEffect ||
        String(artifactBinding.evidence_id) !== String(row.artifact_evidence_id)
      ) {
        throw new ScientificIntegrityError("Atom-map artifact binding is corrupt", { id });
      }
      await this.context.assertCasEvidence(tx, {
        missionId,
        evidenceRef: String(row.artifact_evidence_id),
        expectedDigest: atomMap.mapDigest,
        expectedKind: "atom_map",
        expectedMediaType: String(artifactBinding.media_type),
        expectedWorkUnitId: String(manifestEffect.work_unit_id),
        expectedSourceId: String(artifactBinding.operation_receipt_id),
      });
      const claim = await one<{
        mission_id: string;
        operation_id: string;
        operation_receipt_id: string;
        request_digest: string;
        content_digest: string;
      }>(
        tx,
        `SELECT mission_id, operation_id, operation_receipt_id, request_digest, content_digest
         FROM scientific_biomolecular_material_effects
         WHERE subject_type = 'atom_map' AND subject_id = $1 AND subject_revision = $2`,
        [id, revision],
      );
      if (
        !claim ||
        String(claim.mission_id) !== missionId ||
        String(claim.operation_id) !== effect.operation.id ||
        String(claim.operation_receipt_id) !== effect.receiptId ||
        String(claim.request_digest) !== effect.requestDigest ||
        String(claim.content_digest) !== atomMap.mapDigest
      ) {
        throw new ScientificIntegrityError("Atom-map material-effect claim is corrupt", { id });
      }
      return atomMap;
    });
  }
}
