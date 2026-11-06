import { ScientificApprovalPolicyMismatchError } from "@eigengrid/mission-runtime";
import { ApprovalResponseSchema, digestCanonical } from "@eigengrid/scientific-schema";
import { z } from "zod";
import { missionBelongsToCandidate } from "./approval-binding";
import { currentMissionContext, missionAccess } from "./authority";
import { missionExactCandidate } from "./candidates";
import {
  type MissionApplicationContext,
  MissionApplicationError,
  type MissionApplicationState,
} from "./contracts";
import { missionVerifyInputs, missionVerifySystemBuildApprovalInputs } from "./inputs";
import { missionPolicy } from "./md-validation";
import { Approve } from "./requests";

export async function missionApprove<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  value: z.input<typeof Approve>,
) {
  const input = Approve.parse(value);
  const context = await currentMissionContext(application);
  await missionAccess(application, input, context);
  const candidate = await missionExactCandidate(application, input);
  const policy = missionPolicy(application, candidate, context);
  await missionVerifyInputs(application, candidate, context);
  const provenance = await application.options.store.getMissionProvenance(input.missionId);
  const request = provenance.approvals.find((item) => item.id === input.approvalRequestId);
  if (request && request.policyDigest !== policy.policyDigest)
    throw new ScientificApprovalPolicyMismatchError(
      request.id,
      request.policyDigest,
      policy.policyDigest,
    );
  if (
    !request ||
    !missionBelongsToCandidate(request, candidate, provenance) ||
    request.subjectVersion !== input.subjectVersion ||
    request.subjectRevision !== input.subjectRevision ||
    request.payloadDigest !== input.payloadDigest ||
    request.policyDigest !== input.policyDigest ||
    input.policyDigest !== policy.policyDigest
  )
    throw new MissionApplicationError(
      "CANDIDATE_CHANGED",
      "Approval does not match the reviewed candidate revision and current policy",
    );
  await missionVerifySystemBuildApprovalInputs(application, request, candidate, provenance);
  await missionAccess(application, input, context);
  if (!context.authorizedRoles.includes(request.requestedFromRole))
    throw new MissionApplicationError(
      "FORBIDDEN",
      "Authenticated human lacks the requested approval role",
    );
  const reviewer = { ...context.authenticatedActor, role: request.requestedFromRole };
  const at = application.now().toISOString();
  if (request.subjectType === "plan")
    return application.options.service.decidePlanApprovalInProject({
      missionId: input.missionId,
      projectId: input.projectId,
      authenticatedActor: reviewer,
      actor: reviewer,
      authorizedRoles: [...context.authorizedRoles],
      approvalRequestId: request.id,
      decision: input.decision,
      reason: input.reason,
      currentPolicyDigest: policy.policyDigest,
      expectedSubjectVersion: input.subjectVersion,
      expectedSubjectRevision: input.subjectRevision,
      expectedPayloadDigest: input.payloadDigest,
      expectedPolicyDigest: input.policyDigest,
      decidedAt: at,
    });
  return application.options.store.respondToApproval(
    request.id,
    ApprovalResponseSchema.parse({
      id: `response-${digestCanonical({ requestId: request.id, actor: context.authenticatedActor.id, at, decision: input.decision }).slice(0, 32)}`,
      approvalRequestId: request.id,
      decision: input.decision,
      actor: reviewer,
      role: reviewer.role,
      reason: input.reason,
      subjectVersion: input.subjectVersion,
      subjectRevision: input.subjectRevision,
      payloadDigest: input.payloadDigest,
      policyDigest: input.policyDigest,
      decidedAt: at,
    }),
    {
      now: at,
      currentPolicyDigest: policy.policyDigest,
      authenticatedActor: reviewer,
      authorizedRoles: [...context.authorizedRoles],
    },
  );
}
