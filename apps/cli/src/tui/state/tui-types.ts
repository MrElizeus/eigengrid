// ── Stable Message ID Generator ────────────────────────────────────────────

let _seq = 0;

/**
 * Generate a stable, unique message ID.
 * Format: `<prefix>-<timestamp>-<seq>`
 *
 * Never use local line indexes as React keys — always use these IDs.
 */
export function nextMessageId(prefix: string): string {
  _seq += 1;
  return `${prefix}-${Date.now()}-${_seq}`;
}

// ── Typed Message Union ─────────────────────────────────────────────────────

export type TuiMessage =
  | {
      id: string;
      kind: "user";
      text: string;
      createdAt: number;
    }
  | {
      id: string;
      kind: "assistant";
      text: string;
      createdAt: number;
    }
  | {
      id: string;
      kind: "tool-call";
      toolCallId: string;
      toolName: string;
      args?: unknown;
      status: "running" | "ok" | "error" | "blocked";
      summary?: string;
      result?: unknown;
      error?: string;
      createdAt: number;
      finishedAt?: number;
      expanded?: boolean;
    }
  | {
      id: string;
      kind: "system";
      level: "info" | "warn" | "error";
      text: string;
      createdAt: number;
      /** Optional colored lines for banners/logos. Falls back to plain text if absent. */
      coloredLines?: { text: string; color: string }[];
    };
