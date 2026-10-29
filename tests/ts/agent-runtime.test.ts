/**
 * agent-runtime.test.ts
 *
 * Ticket 13, coverage items 6, 7:
 *   6. runtime registers canonical tools only
 *   7. submitGaussianTool is NOT registered in runtime/TUI
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { createAgentRuntime } from "../../apps/cli/src/agent/create-agent-runtime";
import type { AgentRuntime } from "../../apps/cli/src/agent/create-agent-runtime";

// ── Snapshot the default executable tools ────────────────────────────────────

const EXECUTABLE_TOOLS = [
  "doctor",
  "list-jobs",
  "get-job-status",
  "read-log",
  "read-file",
  "validate-md-protocol",
  "list-nodes",
  "inspect-node",
  "list-artifacts",
  "list-results",
  "list-events",
  "list-recipes",
  "list-protocols",
  "inspect-protocol",
  "operator-info",
];

const APPROVAL_REQUIRED_TOOLS = [
  "submit-job",
  "parse-job-output",
  "cancel-job",
  "write-file",
  "run-command",
];

describe("createAgentRuntime", () => {
  let runtime: AgentRuntime;

  beforeAll(async () => {
    runtime = await createAgentRuntime();
  });

  it("exposes only default executable tools through raw lookup and list", () => {
    const tools = runtime.registry.list();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXECUTABLE_TOOLS].sort());
    for (const tool of EXECUTABLE_TOOLS) {
      expect(runtime.registry.get(tool)).toBeDefined();
    }
    for (const tool of APPROVAL_REQUIRED_TOOLS) {
      expect(runtime.registry.get(tool)).toBeUndefined();
    }
  });

  it("does NOT register submitGaussianTool", () => {
    const tools = runtime.registry.list();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("submit-gaussian");
    expect(names).not.toContain("submitGaussian");
    // Also verify no tool name contains "gaussian" (case-insensitive)
    const gaussianTools = names.filter((n) => n.toLowerCase().includes("gaussian"));
    expect(gaussianTools).toHaveLength(0);
  });

  it("applies default permission rules when allowActions=false", () => {
    expect(runtime.permissionRules).toBeDefined();
  });

  it("materializes approval-required tools as metadata and keeps doctor executable", async () => {
    const materialized = runtime.registry.materialize();
    expect(materialized.definitions.map((definition) => definition.name).sort()).toEqual(
      [...EXECUTABLE_TOOLS].sort(),
    );
    expect(
      materialized.approvalRequiredDefinitions.map((definition) => definition.name).sort(),
    ).toEqual([...APPROVAL_REQUIRED_TOOLS].sort());

    const expectedInputProperties: Record<string, string[]> = {
      doctor: [],
      "list-jobs": ["status", "limit"],
      "get-job-status": ["jobId"],
      "read-log": ["jobId", "stream", "lines"],
      "read-file": ["path"],
      "write-file": ["path", "content"],
      "run-command": ["command", "args", "timeoutMs"],
      "list-nodes": [],
      "inspect-node": ["nodeId"],
      "list-artifacts": ["jobId"],
      "list-results": ["jobId", "attemptId", "limit"],
      "list-events": ["jobId", "type", "limit"],
      "list-recipes": ["software"],
      "list-protocols": ["query", "domain", "engine", "limit"],
      "inspect-protocol": ["id", "version", "assetKinds"],
      "validate-md-protocol": ["protocol"],
      "operator-info": [],
      "submit-job": ["software", "inputPath", "name", "runner", "nodeId"],
      "parse-job-output": ["jobId", "attemptId"],
      "cancel-job": ["jobId", "reason"],
    };
    for (const definition of [
      ...materialized.definitions,
      ...materialized.approvalRequiredDefinitions,
    ]) {
      expect(definition.inputSchema.type).toBe("object");
      expect(Object.keys(definition.inputSchema.properties as Record<string, unknown>)).toEqual(
        expectedInputProperties[definition.name],
      );
      expect(definition.inputSchema.$ref).toBeUndefined();
    }

    const result = await materialized.settle(
      { name: "doctor", input: {}, id: "doctor-call" },
      runtime.ctx,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects approval-required direct execution before validating input", async () => {
    const result = await runtime.registry.execute("submit-job", runtime.ctx, {});
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("APPROVAL_REQUIRED");
  });

  it("keeps doctor directly executable", async () => {
    const result = await runtime.registry.execute("doctor", runtime.ctx, {});
    expect(result.ok).toBe(true);
  });

  it("fails closed instead of promoting ask tools with allowActions", async () => {
    await expect(createAgentRuntime({ allowActions: true })).rejects.toThrow(
      "durable per-call approval",
    );
  });

  it("provides a valid close() function", () => {
    expect(typeof runtime.close).toBe("function");
    // Should not throw
    expect(() => runtime.close()).not.toThrow();
  });
});
