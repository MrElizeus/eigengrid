import { Box, Text } from "ink";
import type { DashboardView } from "../dashboard/dashboard-controller";
import { consoleTheme as t } from "../../presentation/console-theme";
import { terminalText } from "../terminal";
import { Panel } from "./Panel";

import { inspectorLines, type InspectorTab } from "../dashboard/inspector-content";

export function LogViewer({
  view,
  focused,
  height,
  tab,
  offset,
  horizontalOffset,
}: {
  view: DashboardView;
  focused: boolean;
  height: number;
  tab: InspectorTab;
  offset: number;
  horizontalOffset: number;
}) {
  const selected = view.selectedJobId;
  const job = view.snapshot?.jobs.find((j) => j.id === selected);
  const events = view.snapshot?.events ?? [];
  const lines = inspectorLines(view, tab);
  const capacity = Math.max(1, height - 8);
  const maxOffset = Math.max(0, lines.length - capacity);
  const position = Math.min(offset, maxOffset);
  // Logs start at the tail; events and details start at the beginning.
  const start = tab === "logs" ? maxOffset - position : position;
  const visible = lines.slice(start, start + capacity);
  return (
    <Panel title="Logs / Inspector" index="3" focused={focused} height={height} meta="EVIDENCE">
      <Text color={t.dim} wrap="truncate-end">
        <Text color={tab === "logs" ? t.accent : t.dim}>[l] Logs</Text>
        {"  "}
        <Text color={tab === "events" ? t.accent : t.dim}>[e] Events</Text>
        {"  "}
        <Text color={tab === "details" ? t.accent : t.dim}>[i] Details</Text>
      </Text>
      <Text bold color={t.secondary} wrap="truncate-middle">
        {selected ? `job ${terminalText(selected)}` : "No job selected"}
      </Text>
      <Text color={t.dim} wrap="truncate-end">
        {job
          ? `${terminalText(job.name)} · ${terminalText(job.software)} · ${terminalText(job.status)}`
          : "↑↓ choose a job in pane 1"}
      </Text>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {!selected ? (
          <Text color={t.muted}>Select a job to inspect its execution evidence.</Text>
        ) : !job ? (
          <Text color={t.warn}>
            Selected job is absent from this snapshot. Refresh or select another job.
          </Text>
        ) : lines.length === 0 ? (
          <Text color={t.muted}>
            {view.isRefreshing
              ? "Loading selected job…"
              : view.error
                ? "Evidence unavailable. Press r to retry."
                : `No ${tab} recorded for this job.`}
          </Text>
        ) : (
          visible.map((line, i) => (
            <Text key={start + i} color={line.color} wrap="truncate-end">
              {Array.from(terminalText(line.text)).slice(horizontalOffset).join("")}
            </Text>
          ))
        )}
      </Box>
      <Text color={t.dim} wrap="truncate-end">
        {tab === "logs" && events.length
          ? `Latest event · ${terminalText(events.at(-1)?.type)}`
          : tab === "logs"
            ? "stderr is a stream, not a failure verdict"
            : "Recorded evidence · read only"}
      </Text>
      <Text color={t.dim} wrap="truncate-end">
        {lines.length
          ? `${start + 1}–${start + visible.length}/${lines.length} · ${tab === "logs" ? (position === 0 ? "TAIL" : "SCROLLED") : tab.toUpperCase()} · ↑↓ scroll · ←→ pan${horizontalOffset ? ` +${horizontalOffset}` : ""}`
          : "l logs · e events · i details"}
      </Text>
    </Panel>
  );
}
