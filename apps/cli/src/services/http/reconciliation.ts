import type { MissionApplication } from "../mission-application";
import type { AgentSessionService } from "../agent-sessions";
import { digestCanonical } from "@eigengrid/scientific-schema";
import type { MissionHttpIdempotencyRequest } from "./routes/mission-routes";

/** Read-only canonical proof. Returning null preserves the pending fence. This
 * module has no start/approve/compile/submit calls, and never retries an effect. */
export async function observeApplicationOperation(
  record: MissionHttpIdempotencyRequest,
  application: MissionApplication,
  agent: () => AgentSessionService,
): Promise<unknown | null> {
  const input = record.request as Record<string, unknown>;
  if (record.operation.startsWith("agent.")) {
    const service = agent();
    if (record.operation === "agent.open")
      return service.findOpened(
        input as { projectId: string; missionId: string; requestId: string; prompt: string },
      );
    const sessionId = String(input.sessionId);
    const state = await service.observe(sessionId);
    const principal = await service.principal(sessionId);
    if (principal.projectId !== record.projectId || principal.missionId !== input.missionId)
      return null;
    if (record.operation === "agent.cancel") return state.cancellationRequested ? state : null;
    if (record.operation === "agent.approve")
      return service.observeApproval(
        sessionId,
        input.approval as { callId: string; inputDigest: string },
      );
    if (record.operation === "agent.resume")
      return !["ready", "inference_pending", "tool_pending"].includes(state.phase) ? state : null;
    if (record.operation === "agent.reconcile")
      return service.journal
        .load(sessionId)
        .slice(record.expectedRevision)
        .some((r) => r.event.type === "effect_reconciled")
        ? state
        : null;
    return null;
  }
  const missionId = String(input.missionId ?? (input.mission as { id: string })?.id);
  const address = { projectId: record.projectId, missionId };
  if (record.operation === "start")
    return application.reconcileStart(input as Parameters<MissionApplication["reconcileStart"]>[0]);
  const provenance = await application.read(address);
  if (record.operation === "create") {
    const requested = input.mission as Record<string, unknown>;
    return ["id", "objective", "constraints", "acceptanceCriteria", "budgetId"].every(
      (key) =>
        digestCanonical(requested[key]) ===
        digestCanonical(provenance.mission[key as keyof typeof provenance.mission]),
    )
      ? provenance.mission
      : null;
  }
  if (record.operation === "cancel")
    return provenance.transitions.some(
      (t) =>
        t.fromRevision === input.expectedRevision &&
        t.toState === "cancel_requested" &&
        t.actor.id === record.actorId &&
        t.reason === input.reason,
    )
      ? provenance.mission
      : null;
  const review = await application.review({
    ...address,
    planId: String(input.planId ?? (input.candidate as { plan: { id: string } })?.plan?.id),
  });
  if (review.candidateDigest !== (input.candidateDigest ?? input.expectedCandidateDigest))
    return null;
  if (record.operation === "import") return review;
  if (record.operation === "approve")
    return (
      review.approvals.find(
        (a) =>
          a.id === input.approvalRequestId &&
          a.subjectVersion === input.subjectVersion &&
          a.subjectRevision === input.subjectRevision &&
          a.payloadDigest === input.payloadDigest &&
          a.policyDigest === input.policyDigest &&
          a.state === input.decision,
      ) ?? null
    );
  if (record.operation === "compile")
    return provenance.mission.activePlanId === input.planId &&
      ["ready", "executing", "observing", "completed"].includes(provenance.mission.state) &&
      provenance.workUnits.some((unit) => unit.planId === input.planId)
      ? application.status(address)
      : null;
  return null;
}
