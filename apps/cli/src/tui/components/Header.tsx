import { Box, Text } from "ink";
import { consoleTheme as t } from "../../presentation/console-theme";
import { EIGENGRID_VERSION } from "../../version";

export function Header({
  mode = "OPERATIONS",
  compact = false,
}: {
  mode?: string;
  compact?: boolean;
}) {
  return (
    <Box flexDirection="column" paddingX={1} height={3} flexShrink={0}>
      <Box justifyContent="space-between">
        <Text bold color={t.accent}>
          ◈ EIGENGRID <Text color={t.dim}>/ {mode}</Text>
        </Text>
        <Text color={t.muted}>
          {compact ? `v${EIGENGRID_VERSION}` : `SCIENTIFIC COMPUTING  ·  v${EIGENGRID_VERSION}`}
        </Text>
      </Box>
      <Text color={t.dim} wrap="truncate-end">
        {mode === "OPERATIONS"
          ? "READ ONLY  /  Jobs · compute nodes · execution evidence"
          : "OPERATOR  /  Scientific workflows, tools and conversation"}
      </Text>
    </Box>
  );
}
