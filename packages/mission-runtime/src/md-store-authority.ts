/** Transaction-scoped checks of exact approvals, receipts and material publication authority. */
import {
  ApprovalRequestSchema,
  ApprovalResponseSchema,
  digestCanonical,
  EvidenceReferenceSchema,
  ExternalOperationSchema,
  OperationReceiptSchema,
  type ApprovalRequest,
  type BiomolecularMaterialPublicationBinding,
  type ExternalOperation,
  type MdWorkflowProtocol,
  type OperationReceipt,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import { ScientificEntityNotFoundError, ScientificIntegrityError } from "./errors";
import { JsonRow, one, parseJson, queryRows } from "./md-store-queries";
import {
  assertCanonicalSetEqual,
  ATOM_MAP_PUBLICATION_CAPABILITIES,
  computeBiomolecularDecisionMaterialDigest,
  FORCE_FIELD_STACK_PUBLICATION_CAPABILITIES,
  isOneOfCapabilities,
  parseBiomolecularDecision,
} from "./md-store-validation";
import type { ScientificTransaction, SubjectDecisionRequirement } from "./types";

/** Approval snapshots also verify durable same-mission evidence relations. */
export async function assertMdEngineAdmissionEvidenceRelations(
  tx: ScientificTransaction,
  protocol: MdWorkflowProtocol,
): Promise<void> {
  const binding = protocol.forceFieldEngineAdmission;
  if (binding === undefined) return;
  const sources = [
    {
      evidenceRef: binding.evidenceRef,
      contentDigest: binding.contentDigest,
      kind: "human_review",
    },
    ...binding.admission.sourceEvidence,
  ];
  for (const source of sources) {
    const row = await one<JsonRow>(
      tx,
      "SELECT mission_id, evidence_kind_id, content_digest, uri, immutable, payload_json FROM scientific_evidence WHERE id = $1 AND mission_id = $2",
      [source.evidenceRef, protocol.missionId],
    );
    if (!row)
      throw new ScientificEntityNotFoundError(
        "technical engine admission evidence",
        source.evidenceRef,
      );
    const evidence = EvidenceReferenceSchema.parse(
      parseJson(row, "technical engine admission evidence"),
    );
    if (
      evidence.id !== source.evidenceRef ||
      evidence.missionId !== protocol.missionId ||
      String(row.mission_id) !== protocol.missionId ||
      evidence.contentDigest !== source.contentDigest ||
      String(row.content_digest) !== source.contentDigest ||
      evidence.kind !== source.kind ||
      String(row.evidence_kind_id) !== source.kind ||
      !evidence.immutable ||
      !row.immutable ||
      String(row.uri) !== evidence.uri ||
      evidence.uri !== `cas://sha256/${source.contentDigest}`
    )
      throw new ScientificIntegrityError(
        "Technical engine admission evidence is not exact same-mission CAS",
        { evidenceRef: source.evidenceRef },
      );
  }
}

export async function resolveDecisionRequirements(
  tx: ScientificTransaction,
  missionId: string,
  ids: readonly string[],
): Promise<SubjectDecisionRequirement[]> {
  const requirements: SubjectDecisionRequirement[] = [];
  for (const id of new Set(ids)) {
    const legacy = await one<{ id: string }>(
      tx,
      "SELECT id FROM scientific_decisions WHERE id = $1 AND mission_id = $2",
      [id, missionId],
    );
    const biomolecular = await queryRows<{
      revision: number;
      decision_digest: string;
      material_digest: string;
      approval_ref: string | null;
      payload_json: string;
      approval_mission_id: string | null;
      approval_subject_type: string | null;
      approval_subject_id: string | null;
      approval_subject_version: number | null;
      approval_subject_revision: number | null;
      approval_state: string | null;
      approval_payload_digest: string | null;
      response_decision: string | null;
      response_payload_digest: string | null;
    }>(
      tx,
      `SELECT decision.revision, decision.decision_digest, decision.material_digest,
              decision.approval_ref, decision.payload_json,
              approval.mission_id AS approval_mission_id,
              approval.subject_type AS approval_subject_type,
              approval.subject_id AS approval_subject_id,
              approval.subject_version AS approval_subject_version,
              approval.subject_revision AS approval_subject_revision,
              approval.state AS approval_state,
              approval.payload_digest AS approval_payload_digest,
              response.decision AS response_decision,
              response.payload_digest AS response_payload_digest
       FROM scientific_biomolecular_decisions AS decision
       LEFT JOIN scientific_approval_requests AS approval ON approval.id = decision.approval_ref
       LEFT JOIN scientific_approval_responses AS response
         ON response.approval_request_id = approval.id
       WHERE decision.id = $1 AND decision.mission_id = $2
         AND decision.review_status = 'approved'
       ORDER BY decision.revision DESC`,
      [id, missionId],
    );
    if ((legacy && biomolecular.length > 0) || biomolecular.length > 1) {
      throw new ScientificIntegrityError("Scientific decision identity is ambiguous", {
        decisionId: id,
        missionId,
      });
    }
    const exact = biomolecular[0];
    if (exact) {
      if (!exact.approval_ref) {
        throw new ScientificIntegrityError(
          "Approved biomolecular decision lacks approval identity",
          {
            decisionId: id,
          },
        );
      }
      const parsed = parseBiomolecularDecision(
        parseJson(exact as JsonRow, "biomolecular decision"),
      );
      const materialDigest = computeBiomolecularDecisionMaterialDigest(parsed);
      if (
        parsed.id !== id ||
        parsed.missionId !== missionId ||
        parsed.revision !== Number(exact.revision) ||
        parsed.status !== "approved" ||
        parsed.approvalRef !== String(exact.approval_ref) ||
        parsed.decisionDigest !== String(exact.decision_digest) ||
        materialDigest !== String(exact.material_digest) ||
        String(exact.approval_mission_id) !== missionId ||
        String(exact.approval_subject_type) !== "decision" ||
        String(exact.approval_subject_id) !== id ||
        Number(exact.approval_subject_version) !== parsed.revision ||
        Number(exact.approval_subject_revision) !== parsed.revision ||
        String(exact.approval_state) !== "approved" ||
        String(exact.approval_payload_digest) !== materialDigest ||
        String(exact.response_decision) !== "approved" ||
        String(exact.response_payload_digest) !== materialDigest
      ) {
        throw new ScientificIntegrityError(
          "Biomolecular decision or durable approval relation is corrupt",
          { decisionId: id, missionId },
        );
      }
      requirements.push({
        id,
        revision: Number(exact.revision),
        digest: String(exact.decision_digest),
        approvalRef: String(exact.approval_ref),
      });
    } else {
      requirements.push({ id });
    }
  }
  return requirements;
}

export async function assertConfirmedOperationRelation(
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
  const row = await one<{
    mission_id: string;
    work_unit_id: string;
    state: string;
    receipt_id: string | null;
    request_digest: string;
    receipt_operation_id: string | null;
    receipt_request_digest: string | null;
    receipt_status: string | null;
    operation_kind_id: string;
    operation_payload_json: string;
    receipt_payload_json: string | null;
  }>(
    tx,
    `SELECT operation.mission_id, operation.work_unit_id, operation.state,
            operation.receipt_id, operation.request_digest,
            receipt.operation_id AS receipt_operation_id,
            receipt.request_digest AS receipt_request_digest,
            receipt.status AS receipt_status,
            operation.operation_kind_id,
            operation.payload_json AS operation_payload_json,
            receipt.payload_json AS receipt_payload_json
     FROM scientific_external_operations AS operation
     LEFT JOIN scientific_operation_receipts AS receipt ON receipt.id = operation.receipt_id
     WHERE operation.id = $1`,
    [operationId],
  );
  if (!row) throw new ScientificEntityNotFoundError("external operation", operationId);
  const operation = ExternalOperationSchema.parse(JSON.parse(String(row.operation_payload_json)));
  const receipt = OperationReceiptSchema.parse(JSON.parse(String(row.receipt_payload_json)));
  if (
    String(row.mission_id) !== missionId ||
    String(row.state) !== "confirmed" ||
    !row.receipt_id ||
    String(row.receipt_operation_id) !== operationId ||
    String(row.receipt_request_digest) !== String(row.request_digest) ||
    String(row.receipt_status) !== "confirmed" ||
    operation.id !== operationId ||
    operation.missionId !== missionId ||
    operation.workUnitId !== String(row.work_unit_id) ||
    operation.kind !== String(row.operation_kind_id) ||
    operation.state !== "confirmed" ||
    operation.receiptId !== String(row.receipt_id) ||
    operation.requestDigest !== String(row.request_digest) ||
    digestCanonical(operation.request) !== operation.requestDigest ||
    receipt.id !== String(row.receipt_id) ||
    receipt.operationId !== operationId ||
    receipt.requestDigest !== operation.requestDigest ||
    receipt.status !== "confirmed" ||
    (receiptId !== undefined && String(row.receipt_id) !== receiptId)
  ) {
    throw new ScientificIntegrityError("Projection requires an exact confirmed operation receipt", {
      operationId,
      receiptId: receiptId ?? null,
    });
  }
  return {
    workUnitId: String(row.work_unit_id),
    requestDigest: String(row.request_digest),
    receiptId: String(row.receipt_id),
    operation,
    receipt,
  };
}

export async function assertExactApprovedSubject(
  tx: ScientificTransaction,
  expected: {
    approvalRef: string;
    missionId: string;
    subjectType: ApprovalRequest["subjectType"];
    subjectId: string;
    subjectVersion: number;
    subjectRevision: number;
    digest: string;
  },
): Promise<void> {
  const row = await one<
    JsonRow & {
      response_payload_json: string | null;
    }
  >(
    tx,
    `SELECT request.payload_json,
            response.payload_json AS response_payload_json
     FROM scientific_approval_requests AS request
     LEFT JOIN scientific_approval_responses AS response
       ON response.approval_request_id = request.id
     WHERE request.id = $1`,
    [expected.approvalRef],
  );
  if (!row?.response_payload_json) {
    throw new ScientificIntegrityError("Exact durable approval is missing", {
      approvalRef: expected.approvalRef,
    });
  }
  const request = ApprovalRequestSchema.parse(parseJson(row, "approval request"));
  const response = ApprovalResponseSchema.parse(JSON.parse(String(row.response_payload_json)));
  if (
    request.id !== expected.approvalRef ||
    request.missionId !== expected.missionId ||
    request.subjectType !== expected.subjectType ||
    request.subjectId !== expected.subjectId ||
    request.subjectVersion !== expected.subjectVersion ||
    request.subjectRevision !== expected.subjectRevision ||
    request.payloadDigest !== expected.digest ||
    request.state !== "approved" ||
    request.response?.id !== response.id ||
    response.approvalRequestId !== request.id ||
    response.decision !== "approved" ||
    response.subjectVersion !== request.subjectVersion ||
    response.subjectRevision !== request.subjectRevision ||
    response.payloadDigest !== request.payloadDigest ||
    response.policyDigest !== request.policyDigest
  ) {
    throw new ScientificIntegrityError("Exact durable approval relation is stale", {
      approvalRef: expected.approvalRef,
      subjectId: expected.subjectId,
    });
  }
}

export async function assertBiomolecularMaterialPublicationWorkUnit(
  tx: ScientificTransaction,
  workUnit: WorkUnit,
  binding: BiomolecularMaterialPublicationBinding,
): Promise<void> {
  const capability =
    workUnit.protocolFragment.kind === "scientific_capability"
      ? workUnit.protocolFragment.capability
      : null;
  const allowedCapabilities =
    binding.subjectKind === "force_field_stack"
      ? FORCE_FIELD_STACK_PUBLICATION_CAPABILITIES
      : ATOM_MAP_PUBLICATION_CAPABILITIES;
  const expectedEvidenceKinds =
    binding.subjectKind === "force_field_stack" ? ["force_field_stack"] : [];
  const expectedObservationKinds =
    binding.subjectKind === "force_field_stack"
      ? ["artifact_integrity"]
      : ["artifact_integrity", "topology_integrity"];
  if (
    !capability ||
    !isOneOfCapabilities(capability.id, allowedCapabilities) ||
    workUnit.executionPolicy.capability !== capability.id ||
    workUnit.executionPolicy.riskClass !== 3 ||
    workUnit.protocolFragment.riskClass !== 3 ||
    new Set(binding.sourceEvidenceRefs).size !== binding.sourceEvidenceRefs.length ||
    (binding.subjectKind === "force_field_stack" &&
      binding.sourceEvidenceRefs.includes(binding.artifactEvidenceRef)) ||
    (binding.subjectKind === "atom_map" &&
      binding.sourceEvidenceRefs[0] !== binding.artifactEvidenceRef)
  ) {
    throw new ScientificIntegrityError("Material-publication WorkUnit binding is unsafe", {
      workUnitId: workUnit.id,
      subjectKind: binding.subjectKind,
    });
  }
  assertCanonicalSetEqual(
    "Material-publication WorkUnit inputs",
    workUnit.inputRefs,
    binding.sourceEvidenceRefs,
  );
  assertCanonicalSetEqual(
    "Material-publication WorkUnit evidence outputs",
    workUnit.outputContract.requiredEvidenceKinds,
    expectedEvidenceKinds,
  );
  assertCanonicalSetEqual(
    "Material-publication WorkUnit observation outputs",
    workUnit.outputContract.requiredObservationKinds,
    expectedObservationKinds,
  );
  const plan = await one<{ mission_id: string; version: number; status: string }>(
    tx,
    "SELECT mission_id, version, status FROM scientific_plans WHERE id = $1",
    [workUnit.planId],
  );
  if (
    !plan ||
    String(plan.mission_id) !== workUnit.missionId ||
    Number(plan.version) !== workUnit.planVersion ||
    !["under_review", "approved"].includes(String(plan.status))
  ) {
    throw new ScientificIntegrityError("Material-publication WorkUnit plan is stale", {
      workUnitId: workUnit.id,
    });
  }
}

export async function assertAnExactApprovalExists(
  tx: ScientificTransaction,
  expected: Omit<Parameters<typeof assertExactApprovedSubject>[1], "approvalRef">,
): Promise<string> {
  const rows = await queryRows<{ id: string }>(
    tx,
    `SELECT id FROM scientific_approval_requests
     WHERE mission_id = $1 AND subject_type = $2 AND subject_id = $3
       AND subject_version = $4 AND subject_revision = $5
       AND payload_digest = $6 AND state = 'approved'
     ORDER BY id`,
    [
      expected.missionId,
      expected.subjectType,
      expected.subjectId,
      expected.subjectVersion,
      expected.subjectRevision,
      expected.digest,
    ],
  );
  if (rows.length !== 1) {
    throw new ScientificIntegrityError(
      "Projection requires one unambiguous exact durable approval",
      {
        subjectType: expected.subjectType,
        subjectId: expected.subjectId,
        approvalCount: rows.length,
      },
    );
  }
  const approvalRef = String(rows[0]!.id);
  await assertExactApprovedSubject(tx, { ...expected, approvalRef });
  return approvalRef;
}
