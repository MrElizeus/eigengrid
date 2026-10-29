import type { ReactNode } from "react";
import { Box, Text } from "ink";
import type { TuiMessage } from "../state/tui-types";
import { renderMarkdownLite, palette } from "../render/markdown-lite";
import { terminalText } from "../terminal";

interface AssistantMessageProps {
  message: Extract<TuiMessage, { kind: "assistant" }>;
}

export function AssistantMessage({ message }: AssistantMessageProps): ReactNode {
  const nodes = renderMarkdownLite(message.id, terminalText(message.text, true));

  return (
    <Box key={message.id} flexDirection="column" marginTop={1} paddingLeft={1}>
      <Text color={palette.accent} bold>
        OPERATOR
      </Text>
      <Box flexDirection="column">{nodes}</Box>
    </Box>
  );
}

interface AssistantDraftProps {
  messageId: string;
  text: string;
}

/** Live streaming draft — same rendering as committed assistant message */
export function AssistantDraft({ messageId, text }: AssistantDraftProps): ReactNode {
  const nodes = renderMarkdownLite(messageId, text);
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text color={palette.dim} dimColor>
        ▸{" "}
      </Text>
      <Box flexDirection="column">{nodes}</Box>
    </Box>
  );
}
