import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { consoleTheme as t } from "../../presentation/console-theme";
import { terminalText } from "../terminal";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
interface StatusBarProps {
  processing: boolean;
  spinnerFrame: number;
  activeTool?: string;
  queued?: readonly string[];
}

export function StatusBar({
  processing,
  spinnerFrame,
  activeTool,
  queued = [],
}: StatusBarProps): ReactNode {
  if (!processing) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={t.accent} wrap="truncate-end">
        {SPINNER[spinnerFrame % SPINNER.length]}{" "}
        {activeTool ? `Running ${terminalText(activeTool)}` : "Working…"}
      </Text>
      {queued.length > 0 && (
        <Text color={t.muted} wrap="truncate-end">
          {queued.length} queued · {terminalText(queued.at(-1))}
        </Text>
      )}
    </Box>
  );
}
