import { z } from "zod";
import type { Tool } from "../types";

const doctorInput = z.object({}).describe("No input required");

const doctorOutput = z.object({
  ok: z.boolean(),
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["ok", "warn", "fail"]),
      detail: z.string().optional(),
    }),
  ),
  summary: z.string(),
});

export const doctorTool: Tool<z.infer<typeof doctorInput>, z.infer<typeof doctorOutput>> = {
  name: "doctor",
  description:
    "Run EigenGrid environment diagnostics to check system health (database, Python, nodes)",
  inputSchema: doctorInput,
  outputSchema: doctorOutput,
  async execute(ctx, _input) {
    const { runCommand } = await import("@eigengrid/runners");
    const checks: Array<{ name: string; status: "ok" | "warn" | "fail"; detail?: string }> = [];

    // Check Bun runtime
    const bunVersion = (
      (globalThis as Record<string, unknown>).Bun as { version: string } | undefined
    )?.version;
    checks.push({
      name: "Bun runtime",
      status: bunVersion ? "ok" : "warn",
      detail: bunVersion ?? "Not detected",
    });

    // Check Python
    try {
      const pyResult = await runCommand(ctx.config.pythonCommand, ["--version"], {
        timeout: 5000,
        maxOutputBytes: 512,
      });
      checks.push({
        name: "Python",
        status: pyResult.exitCode === 0 ? "ok" : "fail",
        detail: (pyResult.stdout || pyResult.stderr).trim() || `Exit code: ${pyResult.exitCode}`,
      });
    } catch (err) {
      checks.push({ name: "Python", status: "fail", detail: String(err) });
    }

    // Check Database
    try {
      const jobs = await ctx.db.listJobs();
      checks.push({
        name: "Database",
        status: "ok",
        detail: `Connected, ${jobs.length} jobs`,
      });
    } catch (err) {
      checks.push({ name: "Database", status: "fail", detail: String(err) });
    }

    // Check nodes
    try {
      const nodes = await ctx.db.listNodes();
      checks.push({
        name: "Compute nodes",
        status: nodes.length > 0 ? "ok" : "warn",
        detail: nodes.length > 0 ? `${nodes.length} node(s) configured` : "No nodes configured",
      });
    } catch {
      checks.push({ name: "Compute nodes", status: "warn", detail: "Could not query nodes" });
    }

    const failCount = checks.filter((c) => c.status === "fail").length;
    const warnCount = checks.filter((c) => c.status === "warn").length;
    const summary =
      failCount > 0
        ? `${failCount} check(s) failed, ${warnCount} warning(s)`
        : warnCount > 0
          ? `All critical checks passed, ${warnCount} warning(s)`
          : "All checks passed";

    return {
      ok: true,
      data: { ok: failCount === 0, checks, summary },
    };
  },
};
