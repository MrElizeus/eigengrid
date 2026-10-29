import type { TuiMessage } from "./tui-types";
import { nextMessageId } from "./tui-types";

// ── State ───────────────────────────────────────────────────────────────────

export interface TuiState {
  /** Committed message history — rendered via <Static> */
  messages: TuiMessage[];
  /** Current assistant text delta being streamed. Not committed yet. */
  assistantDraft: string;
  /** True while an agent turn is in flight */
  processing: boolean;
}

export const initialTuiState: TuiState = {
  messages: [],
  assistantDraft: "",
  processing: false,
};

// ── Actions ─────────────────────────────────────────────────────────────────

export type TuiAction =
  | { type: "USER_SUBMIT"; text: string }
  | { type: "TEXT_DELTA"; text: string }
  | { type: "TOOL_CALL_START"; toolCallId: string; toolName: string; args?: unknown }
  | {
      type: "TOOL_CALL_UPDATE";
      toolCallId: string;
      status: "ok" | "error" | "blocked";
      summary?: string;
      result?: unknown;
      error?: string;
    }
  | { type: "STREAM_FINISH" }
  | { type: "STREAM_ERROR"; error: string }
  | {
      type: "SYSTEM_MESSAGE";
      level: "info" | "warn" | "error";
      text: string;
      coloredLines?: { text: string; color: string }[];
    }
  | { type: "CLEAR" };

// ── Reducer ─────────────────────────────────────────────────────────────────

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    // ── User submitted a message ─────────────────────────
    case "USER_SUBMIT": {
      const msg: TuiMessage = {
        id: nextMessageId("user"),
        kind: "user",
        text: action.text,
        createdAt: Date.now(),
      };
      return {
        ...state,
        messages: [...state.messages, msg],
        assistantDraft: "",
        processing: true,
      };
    }

    // ── Streaming text delta ────────────────────────────
    case "TEXT_DELTA": {
      return {
        ...state,
        assistantDraft: state.assistantDraft + action.text,
      };
    }

    // ── Tool call started ───────────────────────────────
    case "TOOL_CALL_START": {
      // Flush any pending draft as an assistant message before tool call
      const newMessages = [...state.messages];
      if (state.assistantDraft.trim()) {
        newMessages.push({
          id: nextMessageId("assistant"),
          kind: "assistant",
          text: state.assistantDraft.trim(),
          createdAt: Date.now(),
        });
      }
      newMessages.push({
        id: nextMessageId("tool"),
        kind: "tool-call",
        toolCallId: action.toolCallId,
        toolName: action.toolName,
        args: action.args,
        status: "running",
        createdAt: Date.now(),
      });
      return {
        ...state,
        messages: newMessages,
        assistantDraft: "",
      };
    }

    // ── Tool call result received ───────────────────────
    case "TOOL_CALL_UPDATE": {
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m.kind !== "tool-call" || m.toolCallId !== action.toolCallId) return m;
          return {
            ...m,
            status: action.status,
            summary: action.summary,
            result: action.result,
            error: action.error,
            finishedAt: Date.now(),
          };
        }),
      };
    }

    // ── Stream finished ─────────────────────────────────
    case "STREAM_FINISH": {
      const newMessages = settleUnfinishedTools(state.messages);
      // Commit draft only once, only if non-empty
      if (state.assistantDraft.trim()) {
        newMessages.push({
          id: nextMessageId("assistant"),
          kind: "assistant",
          text: state.assistantDraft.trim(),
          createdAt: Date.now(),
        });
      }
      return {
        ...state,
        messages: newMessages,
        assistantDraft: "",
        processing: false,
      };
    }

    // ── Stream errored ──────────────────────────────────
    case "STREAM_ERROR": {
      const newMessages = settleUnfinishedTools(state.messages);
      if (state.assistantDraft.trim()) {
        newMessages.push({
          id: nextMessageId("assistant"),
          kind: "assistant",
          text: state.assistantDraft.trim(),
          createdAt: Date.now(),
        });
      }
      newMessages.push({
        id: nextMessageId("system"),
        kind: "system",
        level: "error",
        text: action.error,
        createdAt: Date.now(),
      });
      return {
        ...state,
        messages: newMessages,
        assistantDraft: "",
        processing: false,
      };
    }

    // ── System message (info/warn/error) ────────────────
    case "SYSTEM_MESSAGE": {
      const msg: TuiMessage = {
        id: nextMessageId("system"),
        kind: "system",
        level: action.level,
        text: action.text,
        createdAt: Date.now(),
        ...(action.coloredLines ? { coloredLines: action.coloredLines } : {}),
      };
      return {
        ...state,
        messages: [...state.messages, msg],
      };
    }

    // ── Clear all messages ──────────────────────────────
    case "CLEAR": {
      return {
        ...state,
        messages: [],
        assistantDraft: "",
        processing: false,
      };
    }

    default:
      return state;
  }
}

function settleUnfinishedTools(messages: TuiMessage[]): TuiMessage[] {
  return messages.map((message) =>
    message.kind === "tool-call" && message.status === "running"
      ? {
          ...message,
          status: "error",
          summary: "Result not received. Verify the job state before retrying.",
          finishedAt: Date.now(),
        }
      : message,
  );
}
