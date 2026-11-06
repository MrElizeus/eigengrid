import {
  memoryDigest,
  canonical,
  type ExperienceMemory,
  type EvidenceReference,
  type ExperienceEvidence,
  type MemoryScope,
  type RetrievalContext,
} from "@eigengrid/experience-memory";
import { verifyAgentRecords, type AgentRecord, type AgentToolCall } from "@eigengrid/agent-runtime";

export function captureToolExperience(
  memory: ExperienceMemory,
  sessionId: string,
  call: AgentToolCall,
  result: unknown,
  ok: boolean,
): EvidenceReference {
  const material = { call, result, ok };
  const sourceDigest = memoryDigest(material);
  const value = memory.observe({
    id: "tool:" + memoryDigest({ sessionId, id: call.id }),
    scope: { kind: "project" },
    origin: {
      kind: "tool_observation",
      reference: call.id,
      sessionId,
      toolName: call.name,
      sourceDigest,
    },
    outcome: ok ? "tool_succeeded" : "tool_failed",
    observation: canonical(material),
    observedAt: new Date().toISOString(),
  });
  return { id: value.id, digest: value.digest };
}

function withoutMemoryReference(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const { memoryEvidence: _memory, ...result } = value as Record<string, unknown>;
    return result;
  }
  return value;
}

/** In-memory turns and explicit durable-journal imports share the same integrity-checked capture path.
 * A journal digest proves event integrity, not an installation claim or scientific correctness.
 */
export function captureAgentExperience(
  memory: ExperienceMemory,
  sessionId: string,
  records: readonly AgentRecord[],
  context: RetrievalContext = {},
): { evidence: EvidenceReference[]; candidateId?: string } {
  const cursor = verifyAgentRecords(sessionId, records);
  if (!records.length) return { evidence: [] };
  const calls = new Map<string, AgentToolCall>();
  const evidence: EvidenceReference[] = [];
  let prompt = "",
    response = "",
    outcome: ExperienceEvidence["outcome"] = "interrupted";
  for (const { event } of records) {
    if (event.type === "started") prompt = event.prompt;
    if (event.type === "effect_intent") calls.set(event.call.id, event.call);
    if (event.type === "effect_observed" || event.type === "effect_reconciled") {
      const observation = event.observation;
      const call = calls.get(observation.id);
      if (!call || call.name !== observation.tool)
        throw new Error("Observation lacks its exact tool intent");
      calls.delete(observation.id);
      if (
        ["search-experiences", "inspect-experience", "propose-lesson", "contest-lesson"].includes(
          call.name,
        )
      )
        continue;
      evidence.push(
        captureToolExperience(
          memory,
          sessionId,
          call,
          withoutMemoryReference(observation.result),
          observation.ok,
        ),
      );
    }
    if (event.type === "completed") {
      outcome = "completed";
      response = event.text;
    }
    if (event.type === "terminated") {
      outcome = event.reason;
      response = event.detail;
    }
    if (event.type === "approval_pending") outcome = "awaiting_approval";
  }
  if (calls.size && outcome === "interrupted") outcome = "uncertain_effect";
  const scope: MemoryScope = { kind: "project" };
  const terminal = memory.observe({
    id: "session:" + memoryDigest({ sessionId, cursor }),
    scope,
    origin: { kind: "agent_session", reference: sessionId, sessionId, sourceDigest: cursor.digest },
    outcome,
    observation: canonical({
      prompt,
      outcome,
      cursor,
      toolEvidence: evidence.map((e) => e.id),
      unresolvedIntents: [...calls.values()].map((call) => ({
        id: call.id,
        tool: call.name,
        digest: memoryDigest(call),
      })),
      interpretation: response,
      interpretationSource: "model_or_runtime_message_not_independently_verified",
    }),
    observedAt: new Date().toISOString(),
  });
  evidence.push({ id: terminal.id, digest: terminal.digest });
  // Pure conversation has no operational lesson. Uncertainty is retained even without a receipt.
  if (evidence.length === 1 && outcome !== "uncertain_effect") return { evidence };
  const candidate = memory.propose(
    {
      id: "lesson:" + memoryDigest({ sessionId, cursor }),
      scope,
      domain: "operational",
      title: ("Task observation: " + prompt).slice(0, 240),
      claim:
        response ||
        "The operation has no confirmed final result. Inspect the captured observations.",
      rationale:
        "Automatically captured interpretation. Check the actual tool observations, conditions and counterexamples before proposing a general lesson. Completion is not scientific acceptance.",
      conditions: Object.entries(context.facts ?? {})
        .slice(0, 24)
        .map(([key, value]) => ({ key, value })),
      evidence: evidence.slice(-64),
      outcome,
      confidence: { level: "unknown", basis: "Automatic capture has not evaluated this claim" },
      validFrom: terminal.observedAt,
      expiresAt: new Date(Date.parse(terminal.observedAt) + 30 * 86400000).toISOString(),
    },
    { id: "operator-model", kind: "model", role: "author" },
  );
  if (candidate.current.state === "candidate")
    memory.verify(candidate.candidate.id, candidate.current.digest, {
      id: "experience-capture",
      kind: "service",
      role: "observer",
    });
  return { evidence, candidateId: candidate.candidate.id };
}
