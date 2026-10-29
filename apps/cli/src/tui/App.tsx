import { useEffect, useReducer, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { Header } from "./components/Header";
import { JobList } from "./components/JobList";
import { NodeList } from "./components/NodeList";
import { LogViewer } from "./components/LogViewer";
import { inspectorLines, type InspectorTab } from "./dashboard/inspector-content";
import { DashboardStatusBar } from "./components/DashboardStatusBar";
import { DashboardSummary } from "./components/DashboardSummary";
import { Panel } from "./components/Panel";
import type { DashboardController } from "./dashboard/dashboard-controller";
import {
  consoleTheme as t,
  jobFilters,
  matchesJobFilter,
  type JobFilter,
} from "../presentation/console-theme";
import { terminalText, useTerminalSize } from "./terminal";

export interface AppProps {
  controller: DashboardController;
}

/** Read-only operational workspace. All data and selection come from the controller. */
export function App({ controller }: AppProps) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [, forceRender] = useReducer((count: number) => count + 1, 0);
  const [focus, setFocus] = useState(0);
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [filter, setFilter] = useState<JobFilter>("all");
  const [help, setHelp] = useState(false);
  const [nodeIndex, setNodeIndex] = useState(0);
  const [tab, setTab] = useState<InspectorTab>("logs");
  const [offset, setOffset] = useState(0);
  const [horizontalOffset, setHorizontalOffset] = useState(0);
  useEffect(() => controller.subscribe(forceRender), [controller]);

  const view = controller.getView();
  const allJobs = view.snapshot?.jobs ?? [];
  const jobs = allJobs.filter(
    (job) =>
      matchesJobFilter(job.status, filter) &&
      terminalText([job.id, job.name, job.software, job.status, job.nodeName].join(" "))
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const height = Math.max(1, rows - 1);
  const compact = columns < 110 || rows < 32;
  const tooSmall = columns < 64 || rows < 22;
  const bodyHeight = Math.max(1, height - 12);
  const nodeHeight = compact ? bodyHeight : Math.max(8, Math.floor(bodyHeight * 0.38));
  const jobHeight = compact ? bodyHeight : bodyHeight - nodeHeight;
  useEffect(() => {
    setOffset(0);
    setHorizontalOffset(0);
  }, [view.selectedJobId, tab]);

  useInput((input, key) => {
    if (searching) {
      if (key.escape) {
        setSearch("");
        setSearching(false);
      }
      if (key.return) setSearching(false);
      return;
    }
    if (help) {
      if (key.escape || input === "?" || input === "q") setHelp(false);
      return;
    }
    if (key.escape && (search || filter !== "all")) {
      setSearch("");
      setFilter("all");
      return;
    }
    if (input === "q" || key.escape) {
      exit();
      return;
    }
    if (input === "r") {
      void controller.refresh();
      return;
    }
    if (input === "?") {
      setHelp(true);
      return;
    }
    if (tooSmall) return;
    if (input === "/") {
      setSearching(true);
      setFocus(0);
      return;
    }
    if (input === "f") {
      setFilter(jobFilters[(jobFilters.indexOf(filter) + 1) % jobFilters.length]);
      return;
    }
    if (key.tab) {
      setFocus((current) => (current + (key.shift ? 2 : 1)) % 3);
      return;
    }
    if (["1", "2", "3"].includes(input)) {
      setFocus(Number(input) - 1);
      return;
    }
    if (["l", "e", "i"].includes(input)) {
      setFocus(2);
      setTab(input === "l" ? "logs" : input === "e" ? "events" : "details");
      setOffset(0);
      return;
    }
    if (key.return && focus === 0 && view.selectedJobId) {
      setFocus(2);
      setTab("details");
      return;
    }
    if (focus === 2 && (key.leftArrow || key.rightArrow || input === "0")) {
      const max = Math.max(
        0,
        ...inspectorLines(view, tab).map((line) => Array.from(terminalText(line.text)).length - 1),
      );
      setHorizontalOffset((value) =>
        input === "0" ? 0 : Math.max(0, Math.min(max, value + (key.leftArrow ? -16 : 16))),
      );
      return;
    }
    if (
      !(
        key.upArrow ||
        key.downArrow ||
        key.pageUp ||
        key.pageDown ||
        input === "g" ||
        input === "G"
      )
    )
      return;
    if (focus === 0 && jobs.length) {
      const current = jobs.findIndex((job) => job.id === view.selectedJobId);
      const step = key.pageUp || key.pageDown ? Math.max(1, jobHeight - 5) : 1;
      const next =
        input === "g"
          ? 0
          : input === "G"
            ? jobs.length - 1
            : current < 0
              ? key.upArrow
                ? jobs.length - 1
                : 0
              : Math.max(
                  0,
                  Math.min(jobs.length - 1, current + (key.upArrow || key.pageUp ? -step : step)),
                );
      controller.selectJob(jobs[next].id);
    } else if (focus === 1) {
      const max = Math.max(0, (view.snapshot?.nodes.length ?? 0) - 1);
      const step = key.pageUp || key.pageDown ? Math.max(1, nodeHeight - 6) : 1;
      setNodeIndex((current) =>
        input === "g"
          ? 0
          : input === "G"
            ? max
            : Math.max(
                0,
                Math.min(max, Math.min(current, max) + (key.upArrow || key.pageUp ? -step : step)),
              ),
      );
    } else if (focus === 2) {
      const count = inspectorLines(view, tab).length;
      const capacity = Math.max(1, bodyHeight - 8);
      const max = Math.max(0, count - capacity);
      const step = key.pageUp || key.pageDown ? capacity : 1;
      const direction = (key.upArrow || key.pageUp ? -1 : 1) * (tab === "logs" ? -1 : 1);
      setOffset((current) =>
        input === "g"
          ? tab === "logs"
            ? max
            : 0
          : input === "G"
            ? tab === "logs"
              ? 0
              : max
            : Math.max(0, Math.min(max, Math.min(current, max) + direction * step)),
      );
    }
  });

  if (tooSmall)
    return (
      <Box flexDirection="column" width={columns} height={height} overflow="hidden">
        <Text bold color={t.accent}>
          ◈ EIGENGRID / OPERATIONS
        </Text>
        <Text color={t.warn}>
          Resize to at least 64 × 22 (now {columns} × {rows}).
        </Text>
        <Text color={t.muted}>Data refresh continues. q quit · r retry</Text>
      </Box>
    );

  const failures = allJobs.filter((job) => job.status === "failed").length;
  const hiddenSelection = view.selectedJobId && !jobs.some((job) => job.id === view.selectedJobId);
  const notice = view.error
    ? {
        color: view.status === "stale" ? t.warn : t.error,
        title:
          view.status === "stale"
            ? "! STALE DATA · last successful snapshot retained"
            : "! DATA UNAVAILABLE",
        detail: `${terminalText(view.error)} · r retries`,
      }
    : hiddenSelection
      ? {
          color: t.warn,
          title: "! Selected job is outside the current filter",
          detail: "Inspector keeps that selection. Esc clears filters; ↑↓ selects a visible job.",
        }
      : failures
        ? {
            color: t.warn,
            title: `! ATTENTION · ${failures} failed job${failures === 1 ? "" : "s"} in this snapshot`,
            detail: "f → attention filters failures; select a job and inspect logs or events.",
          }
        : {
            color: t.dim,
            title:
              view.status === "loading"
                ? "Connecting to the configured data source…"
                : view.status === "empty"
                  ? "Workspace empty · register a node and submit your first calculation"
                  : `${allJobs.length} jobs · ${view.snapshot?.nodes.length ?? 0} nodes · database snapshot`,
            detail: "↑↓ select a job · Enter opens its record · Tab moves between panes.",
          };

  return (
    <Box flexDirection="column" width={columns} height={height} overflow="hidden">
      <Header compact={compact} />
      <DashboardSummary view={view} />
      <Box height={2} flexShrink={0} flexDirection="column" paddingX={1}>
        <Text color={notice.color} bold={Boolean(view.error || failures)} wrap="truncate-end">
          {notice.title}
        </Text>
        <Text color={notice.color} wrap="truncate-end">
          {notice.detail}
        </Text>
      </Box>
      <Box height={1} paddingX={1} flexShrink={0}>
        {searching ? (
          <>
            <Text color={t.accent}>Search / </Text>
            <TextInput
              value={search}
              onChange={setSearch}
              placeholder="ID, name, engine, state… · Enter done"
            />
          </>
        ) : (
          <Text color={t.muted} wrap="truncate-end">
            <Text color={t.accent}>{["1 Jobs", "2 Nodes", "3 Inspector"][focus]}</Text>
            {`  ·  filter: ${filter}  ·  ${jobs.length}/${allJobs.length} jobs`}
            {search ? `  ·  /${terminalText(search)}` : "  ·  / search"}
          </Text>
        )}
      </Box>
      {help ? (
        <Panel title="Keyboard / Help" focused height={bodyHeight} meta="Esc close">
          {[
            "Tab / Shift+Tab   Next / previous pane     1/2/3   Jump to pane",
            "↑↓ / PgUp PgDn    Scroll    ←→ Pan text    g/G     First / last",
            "/                Search jobs by ID, name, engine or state",
            "f                Cycle all → active → attention → finished",
            "Enter            Inspect selected job    l/e/i   Logs / events / details",
            "r                Refresh data            Esc     Close search / clear filters / exit",
            "?                Toggle this help        q       Exit (close help first)",
            "Read only. Closing this view does not cancel jobs.",
            "Log tail: latest 50 records. Full history: eigengrid logs <job-id>.",
          ]
            .slice(0, bodyHeight - 3)
            .map((line) => (
              <Text key={line} color={t.muted} wrap="truncate-end">
                {line}
              </Text>
            ))}
        </Panel>
      ) : compact ? (
        focus === 0 ? (
          <JobList view={view} jobs={jobs} focused={!searching} height={bodyHeight} />
        ) : focus === 1 ? (
          <NodeList view={view} focused height={bodyHeight} selectedIndex={nodeIndex} />
        ) : (
          <LogViewer
            view={view}
            focused
            height={bodyHeight}
            tab={tab}
            offset={offset}
            horizontalOffset={horizontalOffset}
          />
        )
      ) : (
        <Box height={bodyHeight} flexShrink={0}>
          <Box width="55%" flexDirection="column">
            <JobList
              view={view}
              jobs={jobs}
              focused={focus === 0 && !searching}
              height={jobHeight}
            />
            <NodeList
              view={view}
              focused={focus === 1 && !searching}
              height={nodeHeight}
              selectedIndex={nodeIndex}
            />
          </Box>
          <Box width="45%" flexDirection="column">
            <LogViewer
              view={view}
              focused={focus === 2 && !searching}
              height={bodyHeight}
              tab={tab}
              offset={offset}
              horizontalOffset={horizontalOffset}
            />
          </Box>
        </Box>
      )}
      <DashboardStatusBar view={view} compact={compact} />
    </Box>
  );
}
