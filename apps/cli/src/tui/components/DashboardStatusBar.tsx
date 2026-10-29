import { Box, Text } from "ink";
import type { DashboardView } from "../dashboard/dashboard-controller";
import { consoleTheme as t } from "../../presentation/console-theme";

const STATUS_COLOR = {
  loading: t.warn,
  ready: t.success,
  empty: t.muted,
  stale: t.warn,
  error: t.error,
};

export function DashboardStatusBar({ view, compact }: { view: DashboardView; compact: boolean }) {
  return (
    <Box flexDirection="column" paddingX={1} height={2} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text bold color={STATUS_COLOR[view.status]}>
          ● {view.status.toUpperCase()}
        </Text>
        <Text color={t.muted}>
          {view.isRefreshing ? " · refreshing…" : " · snapshot"}
          {view.lastFetchedAt
            ? ` ${new Date(view.lastFetchedAt).toLocaleTimeString()}`
            : " pending"}{" "}
          · refreshes {view.refreshCount}
        </Text>
      </Text>
      <Text color={t.dim} wrap="truncate-end">
        {compact
          ? "1/2/3 panes · / search · f filter · r refresh · ? help · q quit"
          : "Tab focus  ·  ↑↓ navigate  ·  / search  ·  f filter  ·  l/e/i inspect  ·  r refresh  ·  ? help  ·  q quit"}
      </Text>
    </Box>
  );
}
