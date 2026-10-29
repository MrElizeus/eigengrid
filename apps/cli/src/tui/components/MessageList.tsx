import type { ReactNode } from "react";
import { Box, Text, Static } from "ink";
import type { TuiMessage } from "../state/tui-types";
import { AssistantMessage } from "./AssistantMessage";
import { ToolCallChain } from "./ToolCallCard";
import { consoleTheme as palette } from "../../presentation/console-theme";
import { terminalText } from "../terminal";

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
      return <AssistantMessage key={message.id} message={message} />;
    case "tool-call":
      return <ToolCallChain key={message.id} messages={[message]} />;
    case "system":
      return <SystemMsg key={message.id} message={message} />;
  }
}

interface MessageBlock {
  id: string;
  node: ReactNode;
}

function renderBlocks(messages: TuiMessage[]): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  for (let index = 0; index < messages.length; ) {
    const message = messages[index]!;
    if (message.kind !== "tool-call") {
      blocks.push({ id: message.id, node: renderMessage(message) });
      index += 1;
      continue;
    }

    const chain: Array<Extract<TuiMessage, { kind: "tool-call" }>> = [];
    while (index < messages.length && messages[index]?.kind === "tool-call") {
      chain.push(messages[index] as Extract<TuiMessage, { kind: "tool-call" }>);
      index += 1;
    }
    blocks.push({
      id: `tool-chain-${chain[0]!.id}`,
      node: <ToolCallChain messages={chain} />,
    });
  }
  return blocks;
}

interface MessageListProps {
  messages: TuiMessage[];
  intro?: ReactNode;
  resetKey?: number;
}

export function MessageList({ messages, intro, resetKey = 0 }: MessageListProps): ReactNode {
  // Keep the whole active tool chain live. This lets completed steps fade as
  // later steps begin, then commits the trace once the operator replies.
  const pending = messages.findIndex((m) => m.kind === "tool-call" && m.status === "running");
  let liveStart = pending;
  if (liveStart < 0 && messages.at(-1)?.kind === "tool-call") liveStart = messages.length - 1;
  while (liveStart > 0 && messages[liveStart - 1]?.kind === "tool-call") liveStart -= 1;

  const committed = liveStart < 0 ? messages : messages.slice(0, liveStart);
  const live = liveStart < 0 ? [] : messages.slice(liveStart);
  const items = [...(intro ? [{ id: "intro", node: intro }] : []), ...renderBlocks(committed)];
  const liveBlocks = renderBlocks(live);
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
