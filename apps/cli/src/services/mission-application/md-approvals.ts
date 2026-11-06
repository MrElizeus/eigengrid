import {
  ScientificApprovalExpiredError,
  ScientificApprovalPolicyMismatchError,
} from "@eigengrid/mission-runtime";
import { ApprovalRequestSchema, digestCanonical } from "@eigengrid/scientific-schema";
import {
  type MissionApplicationContext,
  MissionApplicationError,
  type MissionApplicationState,
} from "./contracts";
import { missionPolicy } from "./md-validation";
import { type MissionCandidate } from "./requests";

export async function missionRequestMdApproval<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  candidate: MissionCandidate,
  context: C,
  expiresAt?: string,
) {
  const md = candidate.md!;
  const policy = missionPolicy(application, candidate, context);
  for (const subject of [
    {
      type: "biomolecular_system_manifest" as const,
      id: md.system.id,
      revision: md.system.revision,
      digest: md.system.manifestDigest,
    },
    {
      type: "md_protocol" as const,
      id: md.protocol.id,
      revision: md.protocol.revision,
      digest: md.protocol.protocolDigest,
    },
    ...md.decisionRefs.map((reference) => ({
      type: "decision" as const,
      id: reference.id,
      revision: reference.revision,
      digest: reference.decisionDigest,
      requestId: reference.approvalRef,
    })),
  ]) {
    const provenance = await application.options.store.getMissionProvenance(
      candidate.plan.missionId,
    );
    const subjectPolicy =
      subject.type === "decision"
        ? (md.protocol.preparationPolicyDigest ?? policy.policyDigest)
        : policy.policyDigest;
    const existing = provenance.approvals.find(
      (item) =>
        item.subjectType === subject.type &&
        item.subjectId === subject.id &&
        item.subjectRevision === subject.revision &&
        item.payloadDigest === subject.digest &&
        item.policyDigest === subjectPolicy &&
        (!("requestId" in subject) || item.id === subject.requestId),
    );
    if (existing) {
      if (subjectPolicy !== policy.policyDigest) {
        await application.options.store.assertApprovalValid(existing.id, {
          now: application.now().toISOString(),
          currentPolicyDigest: subjectPolicy,
        });
      }
      if (existing.expiresAt && Date.parse(existing.expiresAt) <= application.now().getTime())
        throw new ScientificApprovalExpiredError(existing.id, existing.expiresAt);
      if (
        existing.requestedFromRole !== policy.minimumApprovalRole ||
        !["pending", "approved"].includes(existing.state)
      ) {
        throw new MissionApplicationError(
          "CONFLICT",
          `MD subject ${subject.id} has an expired, rejected, or incompatible approval; submit a new reviewed material revision`,
        );
      }
      continue;
    }
    if (subjectPolicy !== policy.policyDigest)
      throw new MissionApplicationError(
        "APPROVAL_REQUIRED",
        "Preparation policy handoff requires an existing exact approved decision",
      );
    const priorDecisionApproval =
      "requestId" in subject
        ? provenance.approvals.find((item) => item.id === subject.requestId)
        : undefined;
    if (priorDecisionApproval)
      throw new ScientificApprovalPolicyMismatchError(
        priorDecisionApproval.id,
        priorDecisionApproval.policyDigest,
        policy.policyDigest,
      );
    await application.options.store.createApprovalRequest(
      ApprovalRequestSchema.parse({
        id:
          "requestId" in subject
            ? subject.requestId
            : `approval-${digestCanonical({ subject, policy: policy.policyDigest }).slice(0, 32)}`,
        missionId: candidate.plan.missionId,
        subjectType: subject.type,
        subjectId: subject.id,
        subjectVersion: subject.revision,
        subjectRevision: subject.revision,
        state: "pending",
        requestedFromRole: policy.minimumApprovalRole,
        payloadDigest: subject.digest,
        policyDigest: policy.policyDigest,
        editableFields: [],
        requestedBy: context.authenticatedActor,
        requestedAt: application.now().toISOString(),
        ...(expiresAt ? { expiresAt } : {}),
      }),
    );
  }
}
