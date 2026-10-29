/**
 * Compact human-readable summaries for tool results.
 *
 * Raw JSON is intentionally NOT shown by default.
 * Each summarizer extracts the most operationally relevant signal.
 */

// ── Type helpers ────────────────────────────────────────────────────────────

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// ── Per-tool summarizers ─────────────────────────────────────────────────────

function summarizeListJobs(result: unknown): string {
  return safe(() => {
    const data = asRecord(result).data ?? result;
    const jobs = asArray(asRecord(data).jobs ?? data);
    if (jobs.length === 0) return "0 jobs";

    const counts: Record<string, number> = {};
    for (const j of jobs) {
      const s = asStr(asRecord(j).status) || "unknown";
      counts[s] = (counts[s] ?? 0) + 1;
    }
    const parts = Object.entries(counts).map(([k, v]) => `${k}: ${v}`);
    return `${jobs.length} job${jobs.length !== 1 ? "s" : ""} · ${parts.join(" · ")}`;
  }, "completed");
}

function summarizeListNodes(result: unknown): string {
  return safe(() => {
    const data = asRecord(result).data ?? result;
    const nodes = asArray(asRecord(data).nodes ?? data);
    if (nodes.length === 0) return "0 nodes";

    const counts: Record<string, number> = {};
    for (const n of nodes) {
      const record = asRecord(n);
      const t = asStr(record.type) || asStr(record.runner) || "unknown";
      counts[t] = (counts[t] ?? 0) + 1;
    }
    const parts = Object.entries(counts).map(([k, v]) => `${k}: ${v}`);
    return `${nodes.length} node${nodes.length !== 1 ? "s" : ""} · ${parts.join(" · ")}`;
  }, "completed");
}

function summarizeGetJobStatus(result: unknown): string {
  return safe(() => {
    const data = asRecord(result).data ?? result;
    const rec = asRecord(data);
    const id = asStr(rec.id) || asStr(rec.jobId) || "unknown";
    const status = asStr(rec.status) || "unknown";
    return `${id} · ${status}`;
  }, "completed");
}

function summarizeDoctor(result: unknown): string {
  return safe(() => {
    const data = asRecord(result).data ?? result;
    const items = asArray(asRecord(data).checks ?? data);
    const total = items.length;
    const warnings = items.filter((c) => {
      const r = asRecord(c);
      return asStr(r.status) === "warn" || asStr(r.level) === "warn";
    }).length;
    const errors = items.filter((c) => {
      const r = asRecord(c);
      return asStr(r.status) === "error" || asStr(r.level) === "error";
    }).length;

    if (errors > 0)
      return `${total} check${total !== 1 ? "s" : ""} · ${errors} error${errors !== 1 ? "s" : ""}`;
    if (warnings > 0)
      return `${total} check${total !== 1 ? "s" : ""} · ${warnings} warning${warnings !== 1 ? "s" : ""}`;
    return `${total} check${total !== 1 ? "s" : ""} · all ok`;
  }, "completed");
}

function summarizeReadLog(result: unknown): string {
  return safe(() => {
    const data = asRecord(result).data ?? result;
    const rec = asRecord(data);
    const stdout = asStr(rec.stdout);
    const stderr = asStr(rec.stderr);
    const stdoutLines = stdout ? stdout.split("\n").filter(Boolean).length : 0;
    const stderrLines = stderr ? stderr.split("\n").filter(Boolean).length : 0;
    return `stdout ${stdoutLines} line${stdoutLines !== 1 ? "s" : ""} · stderr ${stderrLines} line${stderrLines !== 1 ? "s" : ""}`;
  }, "completed");
}

function summarizeSubmitJob(result: unknown): string {
  return safe(() => {
    const data = asRecord(result).data ?? result;
    const rec = asRecord(data);
    const id = asStr(rec.id) || asStr(rec.jobId) || "unknown";
    const status = asStr(rec.status) || "queued";
    return `created ${id} · ${status}`;
  }, "created");
}

function summarizeParseJobOutput(result: unknown): string {
  return safe(() => {
    const data = asRecord(result).data ?? result;
    const rec = asRecord(data);
    const energy = rec.energy ?? rec.totalEnergy;
    const energyStr = energy !== undefined ? ` · energy: ${String(energy).slice(0, 20)}` : "";
    return `result saved${energyStr}`;
  }, "completed");
}

function summarizeCancelJob(result: unknown): string {
  return safe(() => {
    const data = asRecord(result).data ?? result;
    const rec = asRecord(data);
    const id = asStr(rec.jobId) || "unknown";
    const prev = asStr(rec.previousStatus);
    return `${id} cancelled` + (prev ? ` (was ${prev})` : "");
  }, "cancelled");
}

function summarizeInspectNode(result: unknown): string {
  return safe(() => {
    const data = asRecord(result).data ?? result;
    const rec = asRecord(data);
    const name = asStr(rec.name) || asStr(rec.id) || "unknown";
    const status = asStr(rec.status) || "";
    return status ? `${name} · ${status}` : name;
  }, "completed");
}

function summarizeCollection(result: unknown, field: string, label: string): string {
  return safe(() => {
    const data = asRecord(asRecord(result).data ?? result);
    const count = typeof data.total === "number" ? data.total : asArray(data[field]).length;
    return `${count} ${label}${count === 1 ? "" : "s"}`;
  }, "completed");
}

function summarizeProtocols(result: unknown): string {
  return safe(() => {
    const data = asRecord(asRecord(result).data ?? result);
    const total = typeof data.totalProtocolAssets === "number" ? data.totalProtocolAssets : 0;
    const matched = typeof data.matched === "number" ? data.matched : total;
    const returned =
      typeof data.returned === "number" ? data.returned : asArray(data.protocols).length;
    return `${total} installed · ${matched} matched · ${returned} shown`;
  }, "completed");
}

function summarizeInspectProtocol(result: unknown): string {
  return safe(() => {
    const data = asRecord(asRecord(result).data ?? result);
    const protocol = asRecord(data.protocol);
    const id = asStr(protocol.id) || "unknown";
    const version = asStr(protocol.version);
    return version ? `${id}@${version}` : id;
  }, "completed");
}

function summarizeOperatorInfo(result: unknown): string {
  return safe(() => {
    const data = asRecord(asRecord(result).data ?? result);
    const provider = asRecord(data.provider);
    const model = asStr(provider.model) || "unknown model";
    const id = asStr(provider.id) || "unknown provider";
    return `${id} · ${model} · native agent`;
  }, "completed");
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns a compact human-readable summary for a tool result.
 * Falls back to "completed" for unknown tools or unparseable results.
 */
export function summarizeToolResult(toolName: string, result: unknown): string {
  switch (toolName) {
    case "list-jobs":
      return summarizeListJobs(result);
    case "list-nodes":
      return summarizeListNodes(result);
    case "get-job-status":
      return summarizeGetJobStatus(result);
    case "doctor":
      return summarizeDoctor(result);
    case "read-log":
      return summarizeReadLog(result);
    case "submit-job":
      return summarizeSubmitJob(result);
    case "parse-job-output":
      return summarizeParseJobOutput(result);
    case "cancel-job":
      return summarizeCancelJob(result);
    case "inspect-node":
      return summarizeInspectNode(result);
    case "list-artifacts":
      return summarizeCollection(result, "artifacts", "artifact");
    case "list-results":
      return summarizeCollection(result, "results", "result");
    case "list-events":
      return summarizeCollection(result, "events", "event");
    case "list-recipes":
      return summarizeCollection(result, "recipes", "recipe");
    case "list-protocols":
      return summarizeProtocols(result);
    case "inspect-protocol":
      return summarizeInspectProtocol(result);
    case "operator-info":
      return summarizeOperatorInfo(result);
    default:
      return "completed";
  }
}
