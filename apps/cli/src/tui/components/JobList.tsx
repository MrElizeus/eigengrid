import { Box, Text } from "ink";
import type { DashboardView } from "../dashboard/dashboard-controller";
import { consoleTheme as t, jobPresentation } from "../../presentation/console-theme";
import { terminalText, windowStart } from "../terminal";
import { Panel } from "./Panel";

export function JobList({
  view,
  jobs,
  focused,
  height,
}: {
  view: DashboardView;
  jobs: NonNullable<DashboardView["snapshot"]>["jobs"];
  focused: boolean;
  height: number;
}) {
  const capacity = Math.max(1, height - 5);
  const index = jobs.findIndex((job) => job.id === view.selectedJobId);
  const start = windowStart(index, jobs.length, capacity);
  const visible = jobs.slice(start, start + capacity);
  return (
    <Panel title="Jobs" index="1" focused={focused} height={height} meta={`${jobs.length} visible`}>
      <Box flexShrink={0}>
        <Box width={16}>
          <Text color={t.dim}> JOB</Text>
        </Box>
        <Box width={13}>
          <Text color={t.dim}>STATE</Text>
        </Box>
        <Box width={10}>
          <Text color={t.dim}>ENGINE</Text>
        </Box>
        <Text color={t.dim}>NAME</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {visible.length === 0 ? (
          <Text color={t.muted}>
            {view.status === "loading"
              ? "Loading jobs…"
              : view.status === "error"
                ? "Jobs unavailable. Press r to retry."
                : (view.snapshot?.jobs.length ?? 0) > 0
                  ? "No matches. Esc clears the filters."
                  : "No jobs yet. Start with eigengrid submit --help."}
          </Text>
        ) : (
          visible.map((job) => {
            const selected = job.id === view.selectedJobId;
            const state = jobPresentation(job.status);
            return (
              <Box key={job.id} flexShrink={0}>
                <Box width={16}>
                  <Text color={selected ? t.accent : t.text} bold={selected} wrap="truncate-end">
                    {selected ? "▸ " : "  "}
                    {terminalText(job.id)}
                  </Text>
                </Box>
                <Box width={13}>
                  <Text color={t[state.tone]} wrap="truncate-end">
                    {state.glyph} {terminalText(job.status)}
                  </Text>
                </Box>
                <Box width={10}>
                  <Text color={t.secondary} wrap="truncate-end">
                    {terminalText(job.software)}
                  </Text>
                </Box>
                <Box flexGrow={1} flexBasis={0}>
                  <Text color={selected ? t.text : t.muted} wrap="truncate-end">
                    {terminalText(job.name)}
                  </Text>
                </Box>
              </Box>
            );
          })
        )}
      </Box>
      <Text color={t.dim} wrap="truncate-end">
        {jobs.length
          ? `${start + 1}–${start + visible.length} of ${jobs.length}  ·  ↑↓ select  ·  Enter inspect`
          : "Submission remains available from the CLI"}
      </Text>
    </Panel>
  );
}
