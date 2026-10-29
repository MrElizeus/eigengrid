import { Box, Text } from "ink";
import type { DashboardView } from "../dashboard/dashboard-controller";
import { consoleTheme as t } from "../../presentation/console-theme";
import { terminalText, windowStart } from "../terminal";
import { Panel } from "./Panel";

export function NodeList({
  view,
  focused,
  height,
  selectedIndex,
}: {
  view: DashboardView;
  focused: boolean;
  height: number;
  selectedIndex: number;
}) {
  const nodes = view.snapshot?.nodes ?? [];
  const capacity = Math.max(1, height - 6);
  const index = Math.max(0, Math.min(selectedIndex, nodes.length - 1));
  const start = windowStart(index, nodes.length, capacity);
  const node = nodes[index];
  return (
    <Panel
      title="Compute Nodes"
      index="2"
      focused={focused}
      height={height}
      meta={`${nodes.length} registered`}
    >
      <Box flexShrink={0}>
        <Box width="43%">
          <Text color={t.dim}> NODE</Text>
        </Box>
        <Box width="30%">
          <Text color={t.dim}>STATE</Text>
        </Box>
        <Text color={t.dim}>RUNNER</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {nodes.length === 0 ? (
          <Text color={t.muted}>
            {view.status === "loading"
              ? "Loading nodes…"
              : view.status === "error"
                ? "Nodes unavailable. Press r to retry."
                : "No nodes. See eigengrid node --help."}
          </Text>
        ) : (
          nodes.slice(start, start + capacity).map((n, i) => {
            const warning =
              n.draining ||
              (n.thermalState && !["ok", "normal", "unknown"].includes(n.thermalState));
            const label = n.draining ? "draining" : n.status;
            const color =
              n.status === "error"
                ? t.error
                : warning || n.status === "offline"
                  ? t.warn
                  : ["online", "busy"].includes(n.status)
                    ? t.success
                    : t.muted;
            return (
              <Box key={n.id} flexShrink={0}>
                <Box width="43%">
                  <Text
                    color={focused && start + i === index ? t.accent : t.text}
                    wrap="truncate-end"
                  >
                    {focused && start + i === index ? "▸ " : "  "}
                    {terminalText(n.name)}
                  </Text>
                </Box>
                <Box width="30%">
                  <Text color={color} wrap="truncate-end">
                    {warning ? "! " : ""}
                    {terminalText(label)}
                  </Text>
                </Box>
                <Text color={t.muted} wrap="truncate-end">
                  {terminalText(n.runner)}
                </Text>
              </Box>
            );
          })
        )}
      </Box>
      <Text color={t.muted} wrap="truncate-end">
        {node
          ? `${terminalText(node.name)} · ${node.cpuThreadsTotal} threads · ${Math.round(node.memoryMbTotal / 1024)} GiB capacity`
          : "Capacity is reported by registered nodes"}
      </Text>
      <Text color={node?.draining ? t.warn : t.dim} wrap="truncate-end">
        {node
          ? node.draining
            ? "! Draining · no new work should be assigned"
            : `Thermal: ${terminalText(node.thermalState || "unknown")} · seen ${node.lastSeenAt ? new Date(node.lastSeenAt).toLocaleTimeString() : "unknown"} · ${index + 1}/${nodes.length}`
          : "Node state does not certify execution readiness"}
      </Text>
    </Panel>
  );
}
