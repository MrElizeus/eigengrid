import { MissionCreateRequestSchema, type MissionApplication } from "../mission-application";
import type { MissionProvenance } from "@eigengrid/mission-runtime";
import type { AgentSessionService } from "../agent-sessions";
import { digestCanonical } from "@eigengrid/scientific-schema";
import type { MissionHttpIdempotencyRequest } from "./routes/mission-routes";

/** Creation is complete only if the whole original immutable baseline exists.
 * Lifecycle and accounting may advance after creation; observing them never resets
 * counters or reservations. An initial reservation whose original payload can no
 * longer be proved exactly remains fenced rather than inventing its history.
 * Current project/owner authority is enforced by application.read; requester and
 * policy are host-normalized at creation, never accepted from request JSON.
 * The read checks current membership; it does not hold a membership lock through
 * the separate HTTP idempotency commit, and grants no new scientific effect.
 */
function completeCreatedMission(
  record: MissionHttpIdempotencyRequest,
  provenance: MissionProvenance,
) {
  const parsed = MissionCreateRequestSchema.safeParse(record.request);
  if (!parsed.success || record.expectedRevision !== 0) return null;
  const input = parsed.data;
  const mission = provenance.mission;
  if (
    input.projectId !== record.projectId ||
    mission.requestedBy.kind !== "human" ||
    mission.requestedBy.id !== record.actorId ||
    input.mission.state !== "created" ||
    input.mission.revision !== 1 ||
    input.budget.revision !== 1
  )
    return null;
  const immutable = [
    "schemaVersion",
    "id",
    "objective",
    "constraints",
    "assumptions",
    "acceptanceCriteria",
    "budgetId",
    "createdAt",
  ] as const;
  if (
    !immutable.every((key) => digestCanonical(input.mission[key]) === digestCanonical(mission[key]))
  )
    return null;
  const budget = provenance.budget;
  if (
    !budget ||
    input.budget.id !== mission.budgetId ||
    input.budget.missionId !== mission.id ||
    budget.id !== input.budget.id ||
    budget.missionId !== mission.id ||
    budget.revision < input.budget.revision ||
    digestCanonical(budget.limits) !== digestCanonical(input.budget.limits)
  )
    return null;
  if (
    !(Object.keys(input.budget.consumed) as (keyof typeof budget.consumed)[]).every(
      (key) => budget.consumed[key] >= input.budget.consumed[key],
    )
  )
    return null;
  if (
    !input.budget.reservations.every((requested) =>
      provenance.budgetReservations.some(
        (actual) =>
          actual.id === requested.id && digestCanonical(actual) === digestCanonical(requested),
      ),
    )
  )
    return null;
  const ids = new Set<string>();
  for (const evidence of input.objectiveEvidence) {
    if (
      ids.has(evidence.id) ||
      evidence.missionId !== mission.id ||
      !evidence.immutable ||
      evidence.uri !== `cas://sha256/${evidence.contentDigest}`
    )
      return null;
    ids.add(evidence.id);
    const actual = provenance.evidence.find((item) => item.id === evidence.id);
    if (
      !actual ||
      actual.missionId !== mission.id ||
      !actual.immutable ||
      digestCanonical(actual) !== digestCanonical(evidence)
    )
      return null;
  }
  const system = input.objectiveEvidence.find(
    (item) => item.id === mission.objective.system.evidenceId,
  );
  if (!system || system.contentDigest !== mission.objective.system.contentDigest) return null;
  return mission;
}

/** Read-only canonical proof. Returning null preserves the pending fence. This
 * module has no start/approve/compile/submit calls, and never retries an effect. */
export async function observeApplicationOperation(
  record: MissionHttpIdempotencyRequest,
  application: MissionApplication,
  agent: () => AgentSessionService,
): Promise<unknown | null> {
  // Material execution recovery requires the composition's closed, policy-bound
  // confirmed-projection finalizer. Generic readback never authorizes it.
  if (record.operation === "material.apply" || record.operation === "md.publish-stage") return null;
  if (record.operation === "create") {
    const parsed = MissionCreateRequestSchema.safeParse(record.request);
    if (
      !parsed.success ||
      parsed.data.projectId !== record.projectId ||
      record.expectedRevision !== 0
    )
      return null;
  }
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
  if (record.operation === "create") return completeCreatedMission(record, provenance);
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
