import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { consoleTheme as t } from "../../presentation/console-theme";

export function Panel({
  title,
  index,
  focused = false,
  meta,
  height,
  children,
}: {
  title: string;
  index?: string;
  focused?: boolean;
  meta?: string;
  height: number;
  children: ReactNode;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? t.accent : t.border}
      paddingX={1}
      height={height}
      flexShrink={0}
      overflow="hidden"
    >
      <Box justifyContent="space-between" flexShrink={0}>
        <Text color={focused ? t.accent : t.text} bold wrap="truncate-end">
          {focused ? "▸ " : "  "}
          {title}
        </Text>
        <Text color={t.dim} wrap="truncate-end">
          {meta ? `${meta}  ` : ""}
          {index}
        </Text>
      </Box>
      {children}
    </Box>
  );
}
