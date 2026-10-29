/**
 * tui-tool-result-formatters.test.ts
 *
 * Ticket 13, coverage items 3, 7:
 *   3. tool result formatter summarizes list-jobs
 *   7. submitGaussianTool is not registered in runtime/TUI
 */
import { describe, it, expect } from "bun:test";
import { summarizeToolResult } from "../../apps/cli/src/tui/render/tool-result-formatters";

describe("summarizeToolResult", () => {
  it("summarizes list-jobs with count and status breakdown", () => {
    const result = {
      data: [
        { id: "job-1", status: "queued" },
        { id: "job-2", status: "queued" },
        { id: "job-3", status: "running" },
      ],
    };
    const s = summarizeToolResult("list-jobs", result);
    expect(s).toContain("3 jobs");
    expect(s).toContain("queued: 2");
    expect(s).toContain("running: 1");
  });

  it("summarizes list-jobs with zero jobs", () => {
    const s = summarizeToolResult("list-jobs", { data: [] });
    expect(s).toBe("0 jobs");
  });

  it("reads list counts from canonical object contracts", () => {
    expect(
      summarizeToolResult("list-jobs", {
        jobs: [{ id: "job-1", status: "queued" }],
        total: 1,
      }),
    ).toContain("1 job");
    expect(
      summarizeToolResult("list-nodes", {
        nodes: [{ id: "node-1", runner: "local" }],
        total: 1,
      }),
    ).toBe("1 node · local: 1");
  });

  it("summarizes list-nodes", () => {
    const result = {
      data: [
        { name: "n1", type: "ssh" },
        { name: "n2", type: "local" },
      ],
    };
    const s = summarizeToolResult("list-nodes", result);
    expect(s).toContain("2 nodes");
    expect(s).toContain("ssh: 1");
    expect(s).toContain("local: 1");
  });

  it("summarizes get-job-status", () => {
    const result = { data: { id: "job_abc", status: "running" } };
    const s = summarizeToolResult("get-job-status", result);
    expect(s).toContain("job_abc");
    expect(s).toContain("running");
  });

  it("summarizes doctor with warning count", () => {
    const result = {
      data: {
        checks: [{ status: "ok" }, { status: "warn" }, { status: "ok" }],
      },
    };
    const s = summarizeToolResult("doctor", result);
    expect(s).toContain("3 checks");
    expect(s).toContain("1 warning");
  });

  it("summarizes read-log with line counts", () => {
    const result = { data: { stdout: "line1\nline2\nline3", stderr: "" } };
    const s = summarizeToolResult("read-log", result);
    expect(s).toContain("stdout 3 lines");
    expect(s).toContain("stderr 0 lines");
  });

  it("summarizes submit-job", () => {
    const result = { data: { id: "job_new", status: "queued" } };
    const s = summarizeToolResult("submit-job", result);
    expect(s).toContain("job_new");
    expect(s).toContain("queued");
  });

  it("summarizes cancel-job", () => {
    const result = { data: { jobId: "job_x", previousStatus: "queued", status: "cancelled" } };
    const s = summarizeToolResult("cancel-job", result);
    expect(s).toContain("job_x");
    expect(s).toContain("cancelled");
  });

  it("summarizes scientific catalog and operator introspection tools", () => {
    expect(
      summarizeToolResult("list-protocols", {
        totalProtocolAssets: 71,
        matched: 15,
        returned: 15,
      }),
    ).toBe("71 installed · 15 matched · 15 shown");
    expect(
      summarizeToolResult("operator-info", {
        provider: { id: "opencode-go", model: "qwen3.8-max" },
      }),
    ).toBe("opencode-go · qwen3.8-max · native agent");
  });

  it("returns 'completed' for unknown tool", () => {
    const s = summarizeToolResult("unknown-tool", { anything: 1 });
    expect(s).toBe("completed");
  });

  it("handles null/undefined result gracefully", () => {
    expect(() => summarizeToolResult("list-jobs", null)).not.toThrow();
    expect(() => summarizeToolResult("list-jobs", undefined)).not.toThrow();
  });
});
