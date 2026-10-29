import { createHash } from "node:crypto";

export const AGENT_JOURNAL_VERSION = "eigengrid.agent.journal/v1" as const;
export const AGENT_GENESIS = "0".repeat(64);

export type ToolDecision = "allow" | "ask" | "deny";
/** A host-owned parent budget refused inference before a provider call. */
export class AgentInferenceBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentInferenceBudgetError";
  }
}
export type AgentPhase =
  | "ready"
  | "inference_pending"
  | "tool_pending"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "aborted"
  | "budget_exhausted"
  | "uncertain_effect";

export interface AgentToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}
export interface AgentToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}
export interface AgentInferenceRequest {
  readonly sessionId: string;
  readonly prompt: string;
  readonly observations: readonly AgentObservation[];
  readonly tools: readonly AgentToolDescriptor[];
  readonly transcript: readonly AgentEvent[];
  readonly step: number;
  /** Host-owned final response boundary; no tools may execute in this step. */
  readonly answerOnly?: boolean;
  readonly remainingBudget?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cost: number;
  };
  readonly signal?: AbortSignal;
}
export interface AgentInferenceReply {
  readonly text: string;
  readonly calls: readonly AgentToolCall[];
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cost: number;
    readonly costPerInputToken?: number;
    readonly costPerOutputToken?: number;
  };
  readonly provider: string;
}
export interface AgentInferencePort {
  infer(request: AgentInferenceRequest): Promise<AgentInferenceReply>;
}
export interface AgentObservation {
  readonly id: string;
  readonly tool: string;
  readonly result: unknown;
  readonly ok: boolean;
}
export interface AgentToolAuthority {
  describe(): readonly AgentToolDescriptor[];
  /** The result is a host-controlled current policy decision, never model content. */
  decide(call: AgentToolCall, sessionId: string): Promise<ToolDecision>;
  /** The authoritative adapter validates the effect just before invoking it. */
  execute(call: AgentToolCall, sessionId: string): Promise<AgentObservation>;
  /** Must check host-authenticated decision bound to session/call/input and expiry. */
  verifyApproval?(call: AgentToolCall, sessionId: string): Promise<boolean>;
}
export type AgentEvent =
  | { type: "started"; prompt: string; limits: AgentLimits }
  | { type: "inference_requested"; step: number }
  | { type: "inference_observed"; step: number; reply: AgentInferenceReply }
  | { type: "inference_abandoned"; step: number }
  | { type: "effect_intent"; call: AgentToolCall }
  | { type: "effect_observed"; observation: AgentObservation }
  | { type: "effect_reconciled"; observation: AgentObservation }
  | { type: "approval_pending"; call: AgentToolCall }
  | { type: "approval_granted"; callId: string }
  | { type: "completed"; text: string }
  | {
      type: "terminated";
      reason: "failed" | "aborted" | "budget_exhausted" | "uncertain_effect";
      detail: string;
    };

export interface AgentLimits {
  readonly maximumSteps: number;
  readonly maximumToolCalls: number;
  readonly maximumInputTokens: number;
  readonly maximumOutputTokens: number;
  readonly maximumCost: number;
}
export interface AgentCursor {
  readonly sequence: number;
  readonly digest: string;
}
export interface AgentRecord {
  readonly version: typeof AGENT_JOURNAL_VERSION;
  readonly sessionId: string;
  readonly sequence: number;
  readonly previousDigest: string;
  readonly digest: string;
  readonly event: AgentEvent;
}
export interface AgentSession {
  readonly sessionId: string;
  readonly phase: AgentPhase;
  readonly prompt: string;
  readonly limits: AgentLimits;
  readonly steps: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: number;
  readonly observations: readonly AgentObservation[];
  readonly reply?: AgentInferenceReply;
  readonly call?: AgentToolCall;
  readonly text?: string;
  readonly detail?: string;
  readonly cursor: AgentCursor;
}
export function canonicalAgentJson(value: unknown): string {
  const parents = new WeakSet<object>();
  function write(item: unknown, depth: number): string {
    if (depth > 48) throw new Error("agent JSON nesting limit");
    if (item === null || typeof item === "boolean" || typeof item === "string")
      return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object") throw new Error("agent JSON contains unsupported value");
    if (parents.has(item)) throw new Error("agent JSON cycle");
    const proto = Object.getPrototypeOf(item);
    if (proto !== Object.prototype && proto !== null && !Array.isArray(item))
      throw new Error("agent JSON non-plain value");
    parents.add(item);
    try {
      if (Array.isArray(item)) {
        for (let i = 0; i < item.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
          if (!descriptor || !("value" in descriptor))
            throw new Error("agent JSON array accessor or hole");
        }
        if (Object.keys(item).length !== item.length)
          throw new Error("agent JSON sparse array or extra keys");
        return `[${item.map((x) => write(x, depth + 1)).join(",")}]`;
      }
      const keys = Object.keys(item).sort();
      if (
        keys.some((k) => {
          const d = Object.getOwnPropertyDescriptor(item, k);
          return !d || !("value" in d);
        })
      )
        throw new Error("agent JSON accessor");
      return `{${keys.map((k) => `${JSON.stringify(k)}:${write((item as Record<string, unknown>)[k], depth + 1)}`).join(",")}}`;
    } finally {
      parents.delete(item);
    }
  }
  const result = write(value, 0);
  if (Buffer.byteLength(result) > 8 * 1024 * 1024) throw new Error("agent JSON size limit");
  return result;
}
export function agentDigest(value: unknown): string {
  return createHash("sha256").update(canonicalAgentJson(value)).digest("hex");
}
export function validateLimits(limits: AgentLimits): void {
  if (
    !limits ||
    Object.keys(limits).sort().join(",") !==
      "maximumCost,maximumInputTokens,maximumOutputTokens,maximumSteps,maximumToolCalls"
  )
    throw new Error("Invalid agent limits");
  for (const [key, value] of Object.entries(limits)) {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value <= 0 ||
      (key !== "maximumCost" && !Number.isSafeInteger(value))
    )
      throw new Error(`Invalid ${key}`);
  }
}
export const DEFAULT_AGENT_LIMITS: AgentLimits = Object.freeze({
  maximumSteps: 5,
  maximumToolCalls: 10,
  maximumInputTokens: 100000,
  maximumOutputTokens: 8192,
  maximumCost: 20,
});
