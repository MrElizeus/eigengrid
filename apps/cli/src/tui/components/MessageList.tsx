import { useRef, type ReactNode } from "react";
import wrapAnsi from "wrap-ansi";
import { Box, Text, Static } from "ink";
import type { TuiMessage } from "../state/tui-types";
import { renderInlineMd } from "../render/markdown-lite";
import { ToolCallCard } from "./ToolCallCard";
import { consoleTheme as palette } from "../../presentation/console-theme";
import { terminalText, useTerminalSize } from "../terminal";

function SystemMsg({ message }: { message: Extract<TuiMessage, { kind: "system" }> }): ReactNode {
  const color =
    message.level === "error"
      ? palette.error
      : message.level === "warn"
        ? palette.warn
        : palette.muted;
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor={message.level === "info" ? palette.border : color}
      paddingX={1}
    >
      <Text bold color={color}>
        {message.level === "error"
          ? "! ERROR"
          : message.level === "warn"
            ? "! ATTENTION"
            : "· SYSTEM"}
      </Text>
      <Text color={color}>{terminalText(message.text, true)}</Text>
    </Box>
  );
}

function UserMsg({ message }: { message: Extract<TuiMessage, { kind: "user" }> }): ReactNode {
  return (
    <Box marginTop={1} paddingX={1}>
      <Text color={palette.accent} bold>
        YOU ›{" "}
      </Text>
      <Text color={palette.text}>{terminalText(message.text, true)}</Text>
    </Box>
  );
}

function renderMessage(message: TuiMessage): ReactNode {
  switch (message.kind) {
    case "user":
      return <UserMsg key={message.id} message={message} />;
    case "assistant":
      return null; // Expanded into append-only rows by renderBlocks.
    case "tool-call":
      return null; // Expanded into stable rows by renderBlocks.
    case "system":
      return <SystemMsg key={message.id} message={message} />;
  }
}

interface MessageBlock {
  id: string;
  node: ReactNode;
}

function assistantRows(id: string, text: string, width: number): MessageBlock[] {
  // Hard wrapping without word reflow makes every row except the last immutable
  // as tokens arrive. Old rows can enter scrollback without growing the live UI.
  let inCode = false;
  const rows = terminalText(text, true)
    .split("\n")
    .flatMap((line) => {
      const fence = line.trimStart().startsWith("```");
      const heading = !inCode && line.match(/^(#{1,3})\s+(.*)$/);
      const code = inCode && !fence;
      let content = line;
      if (fence) {
        content = inCode ? "└─" : `┌─ ${line.trimStart().slice(3)}`;
        inCode = !inCode;
      } else if (heading) content = heading[2];
      const prefix = code ? "│ " : "";
      return wrapAnsi(content, Math.max(1, width - prefix.length), {
        hard: true,
        trim: false,
        wordWrap: false,
      })
        .split("\n")
        .map((body) => ({ body, prefix, code, fence, heading: !!heading }));
    });
  return [
    {
      id: `${id}-heading`,
      node: (
        <Box marginTop={1} paddingLeft={1}>
          <Text bold color={palette.accent}>
            OPERATOR
          </Text>
        </Box>
      ),
    },
    ...rows.map((row, index) => ({
      id: `${id}-row-${index}`,
      node: (
        <Box paddingLeft={1}>
          <Text
            color={row.fence ? palette.dim : row.heading ? palette.accent : palette.text}
            bold={row.heading}
          >
            {row.prefix}
            {row.code || row.fence
              ? row.body || " "
              : row.body
                ? renderInlineMd(id, row.body, index)
                : " "}
          </Text>
        </Box>
      ),
    })),
  ];
}

function renderBlocks(
  messages: TuiMessage[],
  widthFor: (id: string) => number,
  continuesToolChain = false,
  startsInToolChain = false,
): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  for (let index = 0; index < messages.length; ) {
    const message = messages[index]!;
    if (message.kind === "assistant") {
      blocks.push(...assistantRows(message.id, message.text, widthFor(message.id)));
      index += 1;
      continue;
    }
    if (message.kind !== "tool-call") {
      blocks.push({ id: message.id, node: renderMessage(message) });
      index += 1;
      continue;
    }

    let end = index;
    while (end < messages.length && messages[end]?.kind === "tool-call") end++;
    for (; index < end; index++) {
      const tool = messages[index] as Extract<TuiMessage, { kind: "tool-call" }>;
      blocks.push({
        id: tool.id,
        node: (
          <Box
            paddingLeft={1}
            marginTop={
              (index === 0 ? !startsInToolChain : messages[index - 1]?.kind !== "tool-call") ? 1 : 0
            }
          >
            <ToolCallCard
              message={tool}
              historyDepth={end - index - 1}
              isLast={index === end - 1 && !(end === messages.length && continuesToolChain)}
            />
          </Box>
        ),
      });
    }
  }
  return blocks;
}

interface MessageListProps {
  messages: TuiMessage[];
  intro?: ReactNode;
  resetKey?: number;
  assistantDraft?: string;
  assistantDraftId?: string;
}

export function MessageList({
  messages,
  intro,
  resetKey = 0,
  assistantDraft = "",
  assistantDraftId,
}: MessageListProps): ReactNode {
  const { columns, rows } = useTerminalSize();
  const widths = useRef(new Map<string, number>());
  const widthFor = (id: string) => {
    if (!widths.current.has(id)) widths.current.set(id, Math.max(1, columns - 2));
    return widths.current.get(id)!;
  };
  // Keep the whole active tool chain live. This lets completed steps fade as
  // later steps begin, then commits the trace once the operator replies.
  const pending = messages.findIndex((m) => m.kind === "tool-call" && m.status === "running");
  let liveStart = pending;
  if (liveStart < 0 && !assistantDraft && messages.at(-1)?.kind === "tool-call")
    liveStart = messages.length - 1;
  while (liveStart > 0 && messages[liveStart - 1]?.kind === "tool-call") liveStart -= 1;

  // Retire completed tool rows before a long batch can push the composer off screen.
  if (liveStart >= 0) {
    const capacity = Math.max(1, Math.min(8, rows - 14));
    const desired = Math.max(liveStart, messages.length - capacity);
    while (liveStart < desired) {
      const message = messages[liveStart];
      if (message.kind !== "tool-call" || message.status === "running") break;
      liveStart++;
    }
  }
  const committed = liveStart < 0 ? messages : messages.slice(0, liveStart);
  const live = liveStart < 0 ? [] : messages.slice(liveStart);
  const items = [
    ...(intro ? [{ id: "intro", node: intro }] : []),
    ...renderBlocks(committed, widthFor, live[0]?.kind === "tool-call"),
  ];
  const liveBlocks = renderBlocks(live, widthFor, false, committed.at(-1)?.kind === "tool-call");
  if (assistantDraft && assistantDraftId) {
    const draft = assistantRows(assistantDraftId, assistantDraft, widthFor(assistantDraftId));
    // A running tool must remain editable until its receipt arrives.
    if (liveBlocks.length) liveBlocks.push(...draft);
    else {
      items.push(...draft.slice(0, -1));
      liveBlocks.push(draft.at(-1)!);
    }
  }
  return (
    <>
      <Static key={resetKey} items={items}>
        {(item) => (
          <Box key={item.id} flexDirection="column">
            {item.node}
          </Box>
        )}
      </Static>
      <Box flexDirection="column">
        {liveBlocks.map((item) => (
          <Box key={item.id} flexDirection="column">
            {item.node}
          </Box>
        ))}
      </Box>
    </>
  );
}
