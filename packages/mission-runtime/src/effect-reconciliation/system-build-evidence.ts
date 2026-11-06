import {
  ApprovalRequestSchema,
  ApprovalResponseSchema,
  BiomolecularSystemBuildRequestSchema,
  BiomolecularSystemBuildWorkUnitParametersSchema,
  EvidenceReferenceSchema,
  assertBiomolecularDecisionDigest,
  canonicalJson,
  computeBiomolecularDecisionDigest,
  type BiomolecularDecisionReference,
  type WorkUnit,
} from "@eigengrid/scientific-schema";
import { ScientificEntityNotFoundError, ScientificIntegrityError } from "../errors";
import type { ScientificTransaction } from "../types";
import { parsePayload, type PayloadRow } from "./payload";

export async function assertExactSystemBuildSourceEvidence(
  transaction: ScientificTransaction,
  missionId: string,
  workUnit: WorkUnit,
  request: ReturnType<typeof BiomolecularSystemBuildRequestSchema.parse>,
): Promise<void> {
  const parameters = BiomolecularSystemBuildWorkUnitParametersSchema.parse(
    workUnit.protocolFragment.kind === "scientific_capability"
      ? workUnit.protocolFragment.parameters
      : undefined,
  );
  const declared = [
    ...request.sourceEvidence.map((item) => ({
      id: item.id,
      contentDigest: item.contentDigest,
    })),
    {
      id: parameters.systemBuild.forceFieldStackEvidenceRef,
      contentDigest: request.forceFieldStack.digest,
      kind: "force_field_stack",
    },
  ];
  for (const expected of declared) {
    const rows = await transaction.queryRows<PayloadRow>(
      `SELECT payload_json FROM scientific_evidence WHERE id = $1`,
      [expected.id],
    );
    if (!rows[0]) {
      throw new ScientificEntityNotFoundError("scientific evidence", expected.id);
    }
    const evidence = parsePayload(
      EvidenceReferenceSchema,
      rows[0],
      `System-build evidence ${expected.id}`,
    );
    if (
      evidence.missionId !== missionId ||
      !evidence.immutable ||
      evidence.contentDigest !== expected.contentDigest ||
      ("kind" in expected && evidence.kind !== expected.kind)
    ) {
      throw new ScientificIntegrityError(
        "System-build source evidence is not the exact immutable same-mission CAS reference",
        { missionId, evidenceId: expected.id },
      );
    }
  }
}

export async function assertApprovedSystemBuildDecisionReferences(
  transaction: ScientificTransaction,
  missionId: string,
  references: readonly BiomolecularDecisionReference[],
  at: string,
): Promise<void> {
  for (const reference of references) {
    const rows = await transaction.queryRows<
      PayloadRow & {
        revision: number;
        decision_kind: string;
        decision_digest: string;
        approval_ref: string | null;
        approval_payload_json: unknown;
        response_payload_json: unknown;
      }
    >(
      `SELECT decision.revision, decision.decision_kind, decision.decision_digest,
              decision.approval_ref, decision.payload_json,
              approval.payload_json AS approval_payload_json,
              response.payload_json AS response_payload_json
       FROM scientific_biomolecular_decisions AS decision
       LEFT JOIN scientific_approval_requests AS approval ON approval.id = decision.approval_ref
       LEFT JOIN scientific_approval_responses AS response
         ON response.approval_request_id = approval.id
       WHERE decision.id = $1 AND decision.revision = $2 AND decision.mission_id = $3`,
      [reference.id, reference.revision, missionId],
    );
    const row = rows[0];
    if (!row) {
      throw new ScientificIntegrityError(
        "System-build request requires each exact biomolecular decision to be approved",
        { missionId, decisionId: reference.id },
      );
    }
    const decision = assertBiomolecularDecisionDigest(
      parsePayload(
        { parse: (value: unknown) => value },
        { payload_json: row.payload_json },
        `System-build decision ${reference.id}`,
      ),
    );
    const approval = ApprovalRequestSchema.parse(
      typeof row.approval_payload_json === "string"
        ? JSON.parse(row.approval_payload_json)
        : row.approval_payload_json,
    );
    const response = ApprovalResponseSchema.parse(
      typeof row.response_payload_json === "string"
        ? JSON.parse(row.response_payload_json)
        : row.response_payload_json,
    );
    const materialDigest = computeBiomolecularDecisionDigest(decision);
    const atMs = Date.parse(at);
    if (
      decision.missionId !== missionId ||
      decision.id !== reference.id ||
      decision.revision !== reference.revision ||
      decision.kind !== reference.kind ||
      decision.status !== "approved" ||
      decision.decisionDigest !== reference.decisionDigest ||
      decision.decisionDigest !== String(row.decision_digest) ||
      decision.kind !== String(row.decision_kind) ||
      decision.approvalRef !== reference.approvalRef ||
      decision.approvalRef !== String(row.approval_ref) ||
      approval.id !== reference.approvalRef ||
      approval.missionId !== missionId ||
      approval.subjectType !== "decision" ||
      approval.subjectId !== reference.id ||
      approval.subjectVersion !== reference.revision ||
      approval.subjectRevision !== reference.revision ||
      approval.state !== "approved" ||
      approval.payloadDigest !== materialDigest ||
      !approval.response ||
      response.approvalRequestId !== approval.id ||
      response.decision !== "approved" ||
      response.actor.kind !== "human" ||
      response.role !== approval.requestedFromRole ||
      response.actor.role !== approval.requestedFromRole ||
      response.subjectVersion !== reference.revision ||
      response.subjectRevision !== reference.revision ||
      response.payloadDigest !== materialDigest ||
      response.policyDigest !== approval.policyDigest ||
      canonicalJson(approval.response) !== canonicalJson(response) ||
      !Number.isFinite(atMs) ||
      (approval.expiresAt !== undefined && Date.parse(approval.expiresAt) <= atMs)
    ) {
      throw new ScientificIntegrityError(
        "System-build request requires each exact biomolecular decision to be approved",
        { missionId, decisionId: reference.id },
      );
    }
  }
}
