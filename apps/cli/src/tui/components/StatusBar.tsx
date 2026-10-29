import type { ReactNode } from "react";
import { Box, Text } from "ink";
import wrapAnsi from "wrap-ansi";
import { consoleTheme as t } from "../../presentation/console-theme";
import { terminalText, useTerminalSize } from "../terminal";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
interface StatusBarProps {
  processing: boolean;
  spinnerFrame: number;
  activeTool?: string;
  assistantDraft?: string;
}

export function StatusBar({
  processing,
  spinnerFrame,
  activeTool,
  assistantDraft,
}: StatusBarProps): ReactNode {
  const { rows, columns } = useTerminalSize();
  if (!processing) return null;
  const capacity = Math.max(2, Math.min(10, rows - 12));
  // Bound live output in both axes; final text is retained in terminal scrollback.
  const draft = terminalText(assistantDraft ?? "", true);
  const chunks = wrapAnsi(draft, Math.max(1, columns - 6), { hard: true, trim: false }).split("\n");
  const visible = chunks.slice(-capacity);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.border}
      paddingX={1}
      marginTop={1}
    >
      <Text color={t.accent}>
        {SPINNER[spinnerFrame % SPINNER.length]}{" "}
        <Text bold>{activeTool ? `TOOL · ${terminalText(activeTool)}` : "OPERATOR · WORKING"}</Text>
      </Text>
      {draft ? (
        visible.map((line, i) => (
          <Text key={i} color={t.text} wrap="truncate-end">
            {line}
          </Text>
        ))
      ) : (
        <Text color={t.muted}>Waiting for a response…</Text>
      )}
      {chunks.length > capacity ? (
        <Text color={t.dim}>Latest output · full response remains in the transcript</Text>
      ) : null}
    </Box>
  );
}
