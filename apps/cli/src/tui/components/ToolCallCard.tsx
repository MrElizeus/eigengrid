import { useEffect, useState, type ReactNode } from "react";
import { Box, Text } from "ink";
import type { TuiMessage } from "../state/tui-types";
import { summarizeToolResult } from "../render/tool-result-formatters";
import { terminalText } from "../terminal";

// ── Palette ─────────────────────────────────────────────────────────────────

import { consoleTheme as palette } from "../../presentation/console-theme";

// ── Status symbol and color ──────────────────────────────────────────────────

const runningFrames = ["◐", "◓", "◑", "◒"] as const;

function statusGlyph(status: "running" | "ok" | "error" | "blocked", frame = 0): string {
  switch (status) {
    case "running":
      return runningFrames[frame % runningFrames.length]!;
    case "ok":
      return "✓";
    case "error":
      return "✗";
    case "blocked":
      return "⊘";
  }
}

function statusColor(status: "running" | "ok" | "error" | "blocked", historyDepth: number): string {
  switch (status) {
    case "running":
      return palette.accent;
    case "ok":
      return historyDepth <= 0 ? palette.muted : historyDepth === 1 ? palette.dim : palette.border;
    case "error":
      return palette.error;
    case "blocked":
      return palette.warn;
  }
}

function statusLabel(status: "running" | "ok" | "error" | "blocked"): string {
  switch (status) {
    case "running":
      return "running";
    case "ok":
      return "ok";
    case "error":
      return "error";
    case "blocked":
      return "blocked";
  }
}

// ── ToolCallCard Component ───────────────────────────────────────────────────

interface ToolCallCardProps {
  message: Extract<TuiMessage, { kind: "tool-call" }>;
  historyDepth?: number;
  isLast?: boolean;
}

export function ToolCallCard({
  message,
  historyDepth = 0,
  isLast = true,
}: ToolCallCardProps): ReactNode {
  const { id, toolName, status, summary, result, error, expanded } = message;
  const [frame, setFrame] = useState(0);
  const active = status === "running";

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setFrame((value) => value + 1), 120);
    return () => clearInterval(timer);
  }, [active]);

  const color = statusColor(status, historyDepth);
  const glyph = statusGlyph(status, frame);
  const label = statusLabel(status);
  const railColor = active ? palette.accent : color;

  // Build compact summary line
  const displaySummary =
    summary ??
    (status === "ok" && result !== undefined ? summarizeToolResult(toolName, result) : undefined) ??
    (status === "error" ? (error ?? "error") : undefined) ??
    (status === "blocked" ? "action permission required" : undefined) ??
    (status === "running" ? "..." : "");

  return (
    <Box key={id} flexDirection="column">
      <Box>
        <Text color={railColor}>{isLast ? "╰─" : "├─"} </Text>
        <Text color={color} bold={active}>
          {glyph}{" "}
        </Text>
        <Text color={active ? palette.text : color} bold={active}>
          {terminalText(toolName)}
        </Text>
        <Text color={palette.dim}> · </Text>
        <Text color={color} bold={active}>
          {label}
        </Text>
        {displaySummary ? (
          <>
            <Text color={palette.dim}> · </Text>
            <Text color={active ? palette.text : color}>{terminalText(displaySummary)}</Text>
          </>
        ) : null}
      </Box>

      {expanded && status !== "running" && (
        <Box flexDirection="column" paddingLeft={3}>
          {message.args !== undefined && (
            <Box flexDirection="column">
              <Text color={palette.dim}>args:</Text>
              <Text color={palette.muted}>
                {terminalText(truncateJson(message.args, 400), true)}
              </Text>
            </Box>
          )}
          {status === "error" && error && (
            <Box>
              <Text color={palette.error}>error: {terminalText(error.slice(0, 200))}</Text>
            </Box>
          )}
          {status === "ok" && result !== undefined && (
            <Box flexDirection="column">
              <Text color={palette.dim}>result:</Text>
              <Text color={palette.muted}>{terminalText(truncateJson(result, 600), true)}</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

interface ToolCallChainProps {
  messages: Array<Extract<TuiMessage, { kind: "tool-call" }>>;
}

/** A compact execution trace. Older successful steps fade while the active step stays vivid. */
export function ToolCallChain({ messages }: ToolCallChainProps): ReactNode {
  let activeIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.status === "running") {
      activeIndex = index;
      break;
    }
  }
  const newestIndex = activeIndex >= 0 ? activeIndex : messages.length - 1;

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={1}>
      {messages.map((message, index) => (
        <ToolCallCard
          key={message.id}
          message={message}
          historyDepth={Math.max(0, newestIndex - index)}
          isLast={index === messages.length - 1}
        />
      ))}
    </Box>
  );
}

function truncateJson(value: unknown, max = 900): string {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return String(value);
  }
}
