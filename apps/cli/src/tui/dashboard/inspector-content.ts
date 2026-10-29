import type { DashboardView } from "./dashboard-controller";
import { consoleTheme as t } from "../../presentation/console-theme";
import { terminalText } from "../terminal";

export type InspectorTab = "logs" | "events" | "details";

/** Exact rows used for both navigation bounds and rendering. */
export function inspectorLines(view: DashboardView, tab: InspectorTab) {
  const job = view.snapshot?.jobs.find((j) => j.id === view.selectedJobId);
  const logs = view.snapshot?.logs ?? [];
  const events = view.snapshot?.events ?? [];
  const details = job
    ? [
        `Name       ${job.name}`,
        `Job ID     ${job.id}`,
        `State      ${job.status}`,
        `Engine     ${job.software}`,
        `Backend    ${job.backend ?? "unassigned"}`,
        `Node       ${job.nodeName ?? job.nodeId ?? "unassigned"}`,
        `Resources  ${job.cpuThreads} threads · ${job.memoryMb} MiB RAM`,
        `Scratch    ${job.scratchMb} MiB`,
        `Priority   ${job.priority}`,
        `External   ${job.externalJobId ?? "none"} · ${job.externalState ?? "unknown"}`,
        `Input      ${job.inputPath}`,
        `Workdir    ${job.workdir}`,
        `Output     ${job.outputPath ?? "not collected"}`,
        `Created    ${new Date(job.createdAt).toLocaleString()}`,
        `Updated    ${new Date(job.updatedAt).toLocaleString()}`,
        "Full record: eigengrid show <job-id> --json",
      ]
    : [];
  return tab === "details"
    ? details.map((text) => ({ text, color: t.text as string }))
    : tab === "events"
      ? events.map((e) => ({
          text: `${new Date(e.createdAt).toLocaleTimeString()}  ${e.type}  · ${e.source}`,
          color: t.secondary as string,
        }))
      : logs.flatMap((log) =>
          terminalText(log.line, true)
            .split("\n")
            .map((line) => ({
              text: `${log.stream === "stderr" ? "err" : "out"} │ ${line}`,
              color: log.stream === "stderr" ? t.warn : t.text,
            })),
        );
}
