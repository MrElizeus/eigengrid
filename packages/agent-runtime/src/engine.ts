import { randomUUID } from "node:crypto";
import {
  DEFAULT_AGENT_LIMITS,
  AGENT_JOURNAL_VERSION,
  AgentInferenceBudgetError,
  agentDigest,
  canonicalAgentJson,
  validateLimits,
  type AgentEvent,
  type AgentInferencePort,
  type AgentInferenceReply,
  type AgentLimits,
  type AgentRecord,
  type AgentSession,
  type AgentToolAuthority,
  type AgentToolCall,
} from "./contracts";
import { type AgentJournal, ZERO_AGENT_CURSOR, AgentConcurrencyError } from "./journal";

function validNumber(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
function validateReply(reply: AgentInferenceReply): AgentInferenceReply {
  // Inspect descriptors before reading any provider-owned properties. Validation
  // must not invoke an accessor while trying to reject an untrusted reply.
  reply = JSON.parse(canonicalAgentJson(reply)) as AgentInferenceReply;
  if (
    typeof reply.text !== "string" ||
    reply.text.length > 1_000_000 ||
    typeof reply.provider !== "string" ||
    !reply.provider ||
    !Array.isArray(reply.calls) ||
    reply.calls.length > 32
  )
    throw Error("Malformed provider reply");
  if (
    !validNumber(reply.usage.inputTokens) ||
    !Number.isSafeInteger(reply.usage.inputTokens) ||
    !validNumber(reply.usage.outputTokens) ||
    !Number.isSafeInteger(reply.usage.outputTokens) ||
    !validNumber(reply.usage.cost)
  )
    throw Error("Malformed provider usage");
  const seen = new Set<string>();
  for (const c of reply.calls) {
    if (
      typeof c.id !== "string" ||
      !c.id ||
      c.id.length > 128 ||
      typeof c.name !== "string" ||
      !c.name ||
      c.name.length > 64 ||
      seen.has(c.id)
    )
      throw Error("Invalid or duplicate provider call ID");
    seen.add(c.id);
  }
  return reply;
}
function isPendingProposal(state: AgentSession, call: AgentToolCall): boolean {
  const proposal = state.reply?.calls.find((candidate) => candidate.id === call.id);
  return (
    proposal !== undefined &&
    agentDigest(proposal) === agentDigest(call) &&
    !state.observations.some((observation) => observation.id === call.id)
  );
}
type Mutable<T> = { -readonly [P in keyof T]: T[P] };
function empty(id: string): AgentSession {
  return {
    sessionId: id,
    phase: "ready",
    prompt: "",
    limits: DEFAULT_AGENT_LIMITS,
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    observations: [],
    cursor: ZERO_AGENT_CURSOR,
  };
}
/** Pure reduction. This is the only authority for rebuilding a session from the journal. */
export function replayAgentSession(
  sessionId: string,
  records: readonly AgentRecord[],
): AgentSession {
  let state = empty(sessionId);
  for (const record of records) {
    const event = record.event;
    if (
      record.version !== AGENT_JOURNAL_VERSION ||
      record.sessionId !== sessionId ||
      record.sequence !== state.cursor.sequence + 1 ||
      record.previousDigest !== state.cursor.digest ||
      record.digest !==
        agentDigest({
          version: record.version,
          sessionId,
          sequence: record.sequence,
          previousDigest: record.previousDigest,
          event,
        })
    )
      throw Error("Unverified agent event chain");
    if (
      state.phase === "completed" ||
      state.phase === "failed" ||
      state.phase === "aborted" ||
      state.phase === "budget_exhausted" ||
      (state.phase === "uncertain_effect" && event.type !== "effect_reconciled")
    )
      throw Error("Event after terminal agent session");
    const next = {
      ...state,
      cursor: { sequence: record.sequence, digest: record.digest },
    } as Mutable<AgentSession>;
    switch (event.type) {
      case "started":
        if (record.sequence !== 1) throw Error("Repeated agent session start");
        validateLimits(event.limits);
        next.prompt = event.prompt;
        next.limits = event.limits;
        break;
      case "inference_requested":
        if (state.phase !== "ready" || event.step !== state.steps + 1 || !state.prompt)
          throw Error("Invalid inference transition");
        next.phase = "inference_pending";
        break;
      case "inference_abandoned":
        if (state.phase !== "inference_pending" || event.step !== state.steps + 1)
          throw Error("Invalid inference recovery");
        next.phase = "ready";
        break;
      case "inference_observed": {
        if (state.phase !== "inference_pending" || event.step !== state.steps + 1)
          throw Error("Unsolicited inference observation");
        const reply = validateReply(event.reply);
        next.steps = event.step;
        next.inputTokens += reply.usage.inputTokens;
        next.outputTokens += reply.usage.outputTokens;
        next.cost += reply.usage.cost;
        next.reply = reply;
        next.phase = "ready";
        break;
      }
      case "approval_pending":
        if (state.phase !== "ready" || !isPendingProposal(state, event.call))
          throw Error("Unexpected approval barrier");
        next.call = event.call;
        next.phase = "awaiting_approval";
        break;
      case "approval_granted":
        if (state.phase !== "awaiting_approval" || state.call?.id !== event.callId)
          throw Error("Approval call mismatch");
        next.phase = "ready";
        break;
      case "effect_intent":
        if (state.phase !== "ready" || !isPendingProposal(state, event.call))
          throw Error("Invalid or duplicate tool effect");
        next.call = event.call;
        next.phase = "tool_pending";
        break;
      case "effect_observed":
      case "effect_reconciled":
        if (
          (state.phase !== "tool_pending" &&
            !(event.type === "effect_reconciled" && state.phase === "uncertain_effect")) ||
          state.call?.id !== event.observation.id ||
          state.call?.name !== event.observation.tool
        )
          throw Error("Tool result without matching intent");
        next.observations = [...state.observations, event.observation];
        next.call = undefined;
        next.detail = undefined;
        next.phase = "ready";
        break;
      case "completed":
        if (
          state.phase !== "ready" ||
          state.reply?.calls.some((c) => !state.observations.some((o) => o.id === c.id))
        )
          throw Error("Completion before all observations");
        next.text = event.text;
        next.phase = "completed";
        break;
      case "terminated":
        if (event.reason === "uncertain_effect" && state.phase !== "tool_pending")
          throw Error("Uncertain effect without intent");
        next.phase = event.reason;
        next.detail = event.detail;
        break;
      default: {
        const impossible: never = event;
        throw Error(`Unknown event ${String(impossible)}`);
      }
    }
    state = next;
  }
  return state;
}

export interface NativeAgentOptions {
  readonly journal: AgentJournal;
  readonly inference: AgentInferencePort;
  readonly authority: AgentToolAuthority;
  readonly beforeEffect?: (call: AgentToolCall, sessionId: string) => Promise<void>;
  /** Reserve the last configured inference round for an answer, within all existing budgets. */
  readonly reserveFinalResponse?: boolean;
}
/** Strictly sequential, recorded, bounded agent lifecycle. No shell, SDK or scheduler. */
export class NativeAgentEngine {
  constructor(readonly options: NativeAgentOptions) {}
  state(sessionId: string): AgentSession {
    return replayAgentSession(sessionId, this.options.journal.load(sessionId));
  }
  private append(state: AgentSession, event: AgentEvent): AgentSession {
    this.options.journal.append(state.sessionId, state.cursor, event);
    return this.state(state.sessionId);
  }
  start(input: { sessionId?: string; prompt: string; limits?: AgentLimits }): AgentSession {
    const id = input.sessionId ?? randomUUID();
    const state = this.state(id);
    if (state.cursor.sequence > 0) throw new AgentConcurrencyError("Agent session already exists");
    if (
      typeof input.prompt !== "string" ||
      input.prompt.trim().length === 0 ||
      input.prompt.length > 100_000
    )
      throw Error("Invalid agent prompt");
    const limits = input.limits ?? DEFAULT_AGENT_LIMITS;
    validateLimits(limits);
    return this.append(state, { type: "started", prompt: input.prompt, limits });
  }
  /** Only inference is safe to retry. Unknown tool effects are never retried. */
  recoverInterruptedInference(sessionId: string): AgentSession {
    const s = this.state(sessionId);
    if (s.phase !== "inference_pending")
      throw Error("Only an incomplete model request may be retried");
    return this.append(s, { type: "inference_abandoned", step: s.steps + 1 });
  }
  /** Host-only: record a matching observation recovered from the canonical effect owner. */
  reconcileEffect(
    sessionId: string,
    observation: import("./contracts").AgentObservation,
  ): AgentSession {
    const state = this.state(sessionId);
    if (
      !["tool_pending", "uncertain_effect"].includes(state.phase) ||
      state.call?.id !== observation.id ||
      state.call?.name !== observation.tool
    )
      throw Error("Reconciliation does not match pending effect");
    return this.append(state, { type: "effect_reconciled", observation });
  }
  async run(sessionId: string, signal?: AbortSignal): Promise<AgentSession> {
    const records = this.options.journal.load(sessionId);
    let s = replayAgentSession(sessionId, records);
    if (s.cursor.sequence === 0) throw Error("Unknown agent session");
    if (
      s.phase === "inference_pending" ||
      s.phase === "tool_pending" ||
      s.phase === "uncertain_effect"
    )
      return s;
    if (["completed", "failed", "aborted", "budget_exhausted"].includes(s.phase)) return s;
    // A crash may occur after persisting a reply and before checking reused IDs.
    // Reapply that check before interpreting any proposal from the restored reply.
    const replies = records.flatMap((r) =>
      r.event.type === "inference_observed" ? [r.event.reply] : [],
    );
    const previousIds = new Set(
      replies.slice(0, -1).flatMap((reply) => reply.calls.map((call) => call.id)),
    );
    if (s.reply?.calls.some((call) => previousIds.has(call.id)))
      return this.append(s, {
        type: "terminated",
        reason: "failed",
        detail: "Repeated tool call ID",
      });
    for (;;) {
      // The process may have died after persisting usage and before enforcing it.
      if (
        s.inputTokens > s.limits.maximumInputTokens ||
        s.outputTokens > s.limits.maximumOutputTokens ||
        s.cost > s.limits.maximumCost
      )
        return this.append(s, {
          type: "terminated",
          reason: "budget_exhausted",
          detail: "Model usage exceeds session budget",
        });
      if (signal?.aborted)
        return this.append(s, {
          type: "terminated",
          reason: "aborted",
          detail: "Agent operation aborted",
        });
      if (s.phase === "awaiting_approval") {
        const call = s.call;
        if (!call) throw Error("Missing approved call");
        const policy = await this.options.authority.decide(call, sessionId);
        if (policy === "deny")
          return this.append(s, {
            type: "terminated",
            reason: "failed",
            detail: "Tool was revoked",
          });
        if (
          policy !== "ask" ||
          !this.options.authority.verifyApproval ||
          !(await this.options.authority.verifyApproval(call, sessionId))
        )
          return s;
        s = this.append(s, { type: "approval_granted", callId: call.id });
      }
      const current = s.reply;
      const pending = current?.calls.find((c) => !s.observations.some((o) => o.id === c.id));
      if (pending) {
        // Reapplied on replay: a provider cannot turn the final answer round into an effect.
        if (this.options.reserveFinalResponse && s.steps >= s.limits.maximumSteps)
          return this.append(s, {
            type: "terminated",
            reason: "budget_exhausted",
            detail: "The final response step cannot execute tools",
          });
        if (s.observations.length >= s.limits.maximumToolCalls)
          return this.append(s, {
            type: "terminated",
            reason: "budget_exhausted",
            detail: "Maximum tool calls reached",
          });
        const allowedNames = new Set(this.options.authority.describe().map((d) => d.name));
        if (!allowedNames.has(pending.name))
          return this.append(s, {
            type: "terminated",
            reason: "failed",
            detail: "Unknown tool proposal",
          });
        const decision = await this.options.authority.decide(pending, sessionId);
        if (decision !== "allow" && decision !== "ask")
          return this.append(s, {
            type: "terminated",
            reason: "failed",
            detail: "Tool policy denied effect",
          });
        if (decision === "ask") {
          // Host verification is not based on model text or a boolean in tool arguments.
          if (
            !this.options.authority.verifyApproval ||
            !(await this.options.authority.verifyApproval(pending, sessionId))
          )
            return this.append(s, { type: "approval_pending", call: pending });
        }
        if (signal?.aborted)
          return this.append(s, {
            type: "terminated",
            reason: "aborted",
            detail: "Agent operation aborted before tool effect",
          });
        s = this.append(s, { type: "effect_intent", call: pending });
        try {
          // External policy checks and an idempotent service are mandatory for effects.
          await this.options.beforeEffect?.(pending, sessionId);
          if ((await this.options.authority.decide(pending, sessionId)) !== decision)
            throw Error("Tool policy changed before effect");
          if (
            decision === "ask" &&
            (!this.options.authority.verifyApproval ||
              !(await this.options.authority.verifyApproval(pending, sessionId)))
          )
            throw Error("Approval revoked before effect");
          // Authorization and host hooks may yield while cancellation arrives.
          // No effect has started, so this can safely terminate without reconciliation.
          if (signal?.aborted)
            return this.append(s, {
              type: "terminated",
              reason: "aborted",
              detail: "Agent operation aborted before tool effect",
            });
          const observation = await this.options.authority.execute(pending, sessionId);
          if (observation.id !== pending.id || observation.tool !== pending.name)
            throw Error("Tool result binding mismatch");
          s = this.append(s, { type: "effect_observed", observation });
        } catch {
          // The operation may have executed despite a lost acknowledgement. Stop, NEVER replay.
          return this.append(s, {
            type: "terminated",
            reason: "uncertain_effect",
            detail: "Tool effect needs authoritative reconciliation",
          });
        }
        continue;
      }
      if (current && current.calls.length === 0) {
        return this.append(s, { type: "completed", text: current.text });
      }
      if (s.steps >= s.limits.maximumSteps)
        return this.append(s, {
          type: "terminated",
          reason: "budget_exhausted",
          detail: "Maximum inference steps reached",
        });
      const remainingBudget = {
        inputTokens: s.limits.maximumInputTokens - s.inputTokens,
        outputTokens: s.limits.maximumOutputTokens - s.outputTokens,
        cost: s.limits.maximumCost - s.cost,
      };
      if (Object.values(remainingBudget).some((value) => value <= 0))
        return this.append(s, {
          type: "terminated",
          reason: "budget_exhausted",
          detail: "No model budget remains",
        });
      s = this.append(s, { type: "inference_requested", step: s.steps + 1 });
      try {
        const answerOnly =
          this.options.reserveFinalResponse && s.steps + 1 === s.limits.maximumSteps;
        const reply = validateReply(
          await this.options.inference.infer({
            sessionId,
            prompt: s.prompt,
            observations: s.observations,
            tools: answerOnly ? [] : this.options.authority.describe(),
            ...(answerOnly ? { answerOnly: true } : {}),
            transcript: this.options.journal.load(sessionId).map((r) => r.event),
            step: s.steps + 1,
            remainingBudget,
            signal,
          }),
        );
        s = this.append(s, { type: "inference_observed", step: s.steps + 1, reply });
        if (
          s.inputTokens > s.limits.maximumInputTokens ||
          s.outputTokens > s.limits.maximumOutputTokens ||
          s.cost > s.limits.maximumCost
        )
          return this.append(s, {
            type: "terminated",
            reason: "budget_exhausted",
            detail: "Model usage exceeds session budget",
          });
        // Prevent provider from endlessly calling the same ID across steps.
        const ids = new Set(s.observations.map((o) => o.id));
        if (reply.calls.some((c) => ids.has(c.id)))
          return this.append(s, {
            type: "terminated",
            reason: "failed",
            detail: "Repeated tool call ID",
          });
      } catch (e) {
        // A process crash leaves inference_requested pending. A caught provider
        // rejection is an observed failure and may be safely terminated.
        if (e instanceof AgentConcurrencyError) throw e;
        const message = e instanceof Error ? e.message : String(e);
        return this.append(s, {
          type: "terminated",
          reason: signal?.aborted
            ? "aborted"
            : e instanceof AgentInferenceBudgetError
              ? "budget_exhausted"
              : "failed",
          detail: message.slice(0, 512),
        });
      }
    }
  }
}
