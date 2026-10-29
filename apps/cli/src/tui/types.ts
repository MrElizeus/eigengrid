// ────────────────────────────────────────────────────────────
// TuiMessage — Discriminated Union for all TUI messages
// ────────────────────────────────────────────────────────────

export type TuiMessage =
  | { id: string; kind: "banner"; lines: string[] }
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | {
      id: string;
      kind: "tool-call";
      tool: string;
      args: unknown;
      status: "running" | "ok" | "error";
      result?: unknown;
    }
  | { id: string; kind: "system"; level: "info" | "warn" | "error"; text: string };

// ────────────────────────────────────────────────────────────
// ToolCallViewModel — Runtime tool call tracking
// ────────────────────────────────────────────────────────────

export interface ToolCallViewModel {
  id: string;
  tool: string;
  args: unknown;
  status: "running" | "ok" | "error";
  result?: unknown;
  startTime: number;
}

// ────────────────────────────────────────────────────────────
// StreamingState — Three-state streaming model
// ────────────────────────────────────────────────────────────

export interface StreamingState {
  messages: TuiMessage[];
  draftAssistant: string;
  activeToolCalls: ToolCallViewModel[];
  isProcessing: boolean;
}

// ────────────────────────────────────────────────────────────
// Type Guards
// ────────────────────────────────────────────────────────────

export function isUserMessage(m: TuiMessage): m is TuiMessage & { kind: "user" } {
  return m.kind === "user";
}

export function isAssistantMessage(m: TuiMessage): m is TuiMessage & { kind: "assistant" } {
  return m.kind === "assistant";
}

export function isToolCallMessage(m: TuiMessage): m is TuiMessage & { kind: "tool-call" } {
  return m.kind === "tool-call";
}

export function isSystemMessage(m: TuiMessage): m is TuiMessage & { kind: "system" } {
  return m.kind === "system";
}

// ────────────────────────────────────────────────────────────
// nextMessageId — Sequential ID generator
// ────────────────────────────────────────────────────────────

const counters = new Map<string, number>();

export function nextMessageId(prefix: string): string {
  const seq = (counters.get(prefix) ?? 0) + 1;
  counters.set(prefix, seq);
  return `${prefix}-${Date.now()}-${seq}`;
}
