import {
  ApprovalRequestSchema,
  OperationReceiptSchema,
  assertMdStageResultDigest,
  assertQmmmProtocolDigest,
  digestCanonical,
  type ApprovalRequest,
  type OperationReceipt,
} from "@eigengrid/scientific-schema";
import { AmberQmmmParseRequestSchema, type AmberQmmmParseRequest } from "./request";

export interface AmberQmmmAuthorityValidation {
  approval: ApprovalRequest;
  operationReceipt: OperationReceipt;
}

export interface AmberQmmmAuthorityValidator {
  /** Application-owned lookup/validation; model output is never a valid implementation. */
  verify(
    evidence: AmberQmmmAuthorityValidation,
    bindingDigest: string,
  ): Promise<{ approvalRecordDigest: string; operationReceiptRecordDigest: string }>;
}

export interface AmberQmmmParseAuthority {
  readonly bindingDigest: string;
  readonly authorityDigest: string;
}

const issuedParseAuthorities = new WeakSet<object>();

function authorityBindingDigest(request: AmberQmmmParseRequest): string {
  return digestCanonical({
    schemaVersion: "eigengrid.amber-qmmm-parse-authority/v1",
    missionId: request.missionId,
    protocol: {
      id: request.protocol.id,
      revision: request.protocol.revision,
      digest: request.protocol.protocolDigest,
      approvalRef: request.protocol.approvedByRef,
    },
    stageResult: {
      id: request.stageResult.id,
      revision: request.stageResult.revision,
      digest: request.stageResult.resultDigest,
      operationId: request.stageResult.operationId,
      operationReceiptId: request.stageResult.operationReceiptId,
    },
    source: {
      artifactId: request.source.artifactId,
      contentDigest: request.source.contentDigest,
    },
    parserVersion: request.parserVersion,
    executionCompletion: request.executionCompletion,
    operationReceiptRef: request.operationReceiptRef,
  });
}

/**
 * Create a process-local capability only after the host has verified the exact
 * durable approval and operation receipt records. The parser rejects lookalike
 * plain objects, even when their self-described digests match.
 */
export async function authorizeAmberQmmmParse(
  requestValue: unknown,
  evidenceValue: AmberQmmmAuthorityValidation,
  validator: AmberQmmmAuthorityValidator,
): Promise<AmberQmmmParseAuthority> {
  const request = AmberQmmmParseRequestSchema.parse(requestValue);
  assertMdStageResultDigest(request.stageResult);
  assertQmmmProtocolDigest(request.protocol);
  const approval = ApprovalRequestSchema.parse(evidenceValue.approval);
  const operationReceipt = OperationReceiptSchema.parse(evidenceValue.operationReceipt);
  if (
    approval.id !== request.protocol.approvedByRef ||
    approval.missionId !== request.missionId ||
    approval.subjectType !== "qmmm_protocol" ||
    approval.subjectId !== request.protocol.id ||
    approval.subjectVersion !== 1 ||
    approval.subjectRevision !== request.protocol.revision ||
    approval.payloadDigest !== request.protocol.protocolDigest ||
    approval.state !== "approved" ||
    approval.response?.decision !== "approved" ||
    approval.response.approvalRequestId !== approval.id ||
    approval.response.subjectVersion !== approval.subjectVersion ||
    approval.response.subjectRevision !== approval.subjectRevision ||
    approval.response.payloadDigest !== approval.payloadDigest ||
    approval.response.policyDigest !== approval.policyDigest
  ) {
    throw new Error("QM/MM parse approval does not bind the exact approved protocol");
  }
  const receiptIdentity = operationReceipt.externalIdentity;
  const requiredReceiptStatus =
    request.executionCompletion === "unconfirmed"
      ? "ambiguous"
      : request.stageResult.terminalReason === "completed"
        ? "confirmed"
        : "failed";
  if (
    operationReceipt.id !== request.stageResult.operationReceiptId ||
    operationReceipt.operationId !== request.stageResult.operationId ||
    operationReceipt.status !== requiredReceiptStatus ||
    receiptIdentity?.stageResultId !== request.stageResult.id ||
    receiptIdentity.stageResultDigest !== request.stageResult.resultDigest ||
    receiptIdentity.sourceArtifactId !== request.source.artifactId ||
    receiptIdentity.sourceContentDigest !== request.source.contentDigest ||
    operationReceipt.detailDigest !== digestCanonical(receiptIdentity)
  ) {
    throw new Error("QM/MM operation receipt does not bind the exact stage result and mdout");
  }
  const bindingDigest = authorityBindingDigest(request);
  const validated = await validator.verify({ approval, operationReceipt }, bindingDigest);
  const recordDigestPattern = /^[a-f0-9]{64}$/u;
  if (
    !recordDigestPattern.test(validated.approvalRecordDigest) ||
    !recordDigestPattern.test(validated.operationReceiptRecordDigest)
  ) {
    throw new Error("QM/MM authority validator returned invalid durable record evidence");
  }
  const authority = Object.freeze({
    bindingDigest,
    authorityDigest: digestCanonical({ bindingDigest, ...validated }),
  });
  issuedParseAuthorities.add(authority);
  return authority;
}

export function assertIssuedParseAuthority(
  request: AmberQmmmParseRequest,
  authority: AmberQmmmParseAuthority,
): void {
  if (
    !issuedParseAuthorities.has(authority as object) ||
    authority.bindingDigest !== authorityBindingDigest(request)
  ) {
    throw new Error("QM/MM parsing requires genuine host-validated exact authority");
  }
}
