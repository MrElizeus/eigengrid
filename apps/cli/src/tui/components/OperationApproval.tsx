import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import wrapAnsi from "wrap-ansi";
import type { OperatorApprovalRequest } from "../../services/operator-permissions";
import { consoleTheme as palette } from "../../presentation/console-theme";
import { terminalText, useTerminalSize } from "../terminal";

export function OperationApproval({
  request,
  onAnswer,
}: {
  request: OperatorApprovalRequest;
  onAnswer: (approved: boolean) => void;
}): ReactNode {
  const [index, setIndex] = useState(0);
  const [offset, setOffset] = useState(0);
  const { rows, columns } = useTerminalSize();
  const lines = useMemo(
    () =>
      wrapAnsi(terminalText(request.summary, true), Math.max(10, columns - 8), {
        hard: true,
        trim: false,
      }).split("\n"),
    [request.summary, columns],
  );
  const capacity = Math.max(2, Math.min(12, rows - 17));
  const start = Math.min(offset, Math.max(0, lines.length - capacity));
  useEffect(() => {
    const timer = setTimeout(() => onAnswer(false), Math.max(0, request.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [request, onAnswer]);
  useInput((_input, key) => {
    if (key.escape) onAnswer(false);
    else if (key.pageDown)
      setOffset((value) => Math.min(Math.max(0, lines.length - capacity), value + capacity));
    else if (key.pageUp) setOffset((value) => Math.max(0, value - capacity));
    else if (key.upArrow || key.downArrow || key.tab) setIndex((value) => 1 - value);
    else if (key.return) onAnswer(index === 1);
  });
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={palette.warn}
      paddingX={1}
      marginTop={1}
    >
      <Text bold color={palette.warn}>
        APPROVAL REQUIRED / {terminalText(request.name)}
      </Text>
      <Text>{terminalText(request.reason)}</Text>
      {lines.slice(start, start + capacity).map((line, row) => (
        <Text key={start + row} wrap="truncate-end">
          {line}
        </Text>
      ))}
      {lines.length > capacity && (
        <Text color={palette.dim}>
          Input lines {start + 1}–{Math.min(start + capacity, lines.length)} of {lines.length} ·
          PgUp / PgDn to review all arguments
        </Text>
      )}
      <Text color={palette.dim}>
        Exact input: {request.inputDigest.slice(0, 16)} · approval expires in 2 minutes
      </Text>
      {["Deny", "Approve once"].map((label, row) => (
        <Text key={label} color={index === row ? palette.accent : palette.muted}>
          {index === row ? "▸" : " "} {label}
        </Text>
      ))}
      <Text color={palette.dim}>↑↓ to move · Enter to select · Esc deny</Text>
    </Box>
  );
}
