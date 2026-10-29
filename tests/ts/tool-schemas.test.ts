import { describe, expect, test } from "bun:test";
import {
  cancelJobTool,
  doctorTool,
  getJobStatusTool,
  inspectNodeTool,
  listJobsTool,
  listNodesTool,
  parseJobOutputTool,
  parseOutputTool,
  readLogTool,
  submitJobTool,
  ToolRegistry,
} from "@eigengrid/tool-registry";
import type { Tool, ToolContext } from "@eigengrid/tool-registry";

const canonicalBuiltins = [
  ["submit-job", submitJobTool, ["software", "inputPath", "name", "runner", "nodeId"]],
  ["parse-output", parseOutputTool, ["software", "outputPath"]],
  ["parse-job-output", parseJobOutputTool, ["jobId", "attemptId"]],
  ["inspect-node", inspectNodeTool, ["nodeId"]],
  ["read-log", readLogTool, ["jobId", "stream", "lines"]],
  ["doctor", doctorTool, []],
  ["list-jobs", listJobsTool, ["status", "limit"]],
  ["get-job-status", getJobStatusTool, ["jobId"]],
  ["list-nodes", listNodesTool, []],
  ["cancel-job", cancelJobTool, ["jobId", "reason"]],
] as const;

function schemaFor(name: string, tool: Tool) {
  const registry = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
  registry.register(tool);
  return registry.materialize().definitions.find((definition) => definition.name === name)!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function propertiesOf(schema: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(schema.properties)) throw new Error("Expected schema properties to be an object");
  return schema.properties;
}

function expectInlineSchema(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) expectInlineSchema(item);
    return;
  }
  if (!isRecord(value)) return;

  expect(value.$ref).toBeUndefined();
  expect(value.definitions).toBeUndefined();
  for (const nestedValue of Object.values(value)) expectInlineSchema(nestedValue);
}

describe("LLM-facing tool schemas", () => {
  test("exports inline object schemas for every canonical builtin input", () => {
    for (const [name, tool, properties] of canonicalBuiltins) {
      const schema = schemaFor(name, tool).inputSchema;
      expect(schema.type).toBe("object");
      expect(Object.keys(propertiesOf(schema))).toEqual(properties);
      expectInlineSchema(schema);
    }
  });

  test("preserves required fields, enums, and Zod descriptions", () => {
    const submit = schemaFor("submit-job", submitJobTool).inputSchema;
    expect(submit.required).toEqual(["software", "inputPath"]);
    expect(propertiesOf(submit).software).toMatchObject({
      enum: ["gaussian", "orca", "xtb", "cp2k"],
      description: "Software to run",
    });
    expect((propertiesOf(submit).runner as Record<string, unknown>).enum).toEqual(["local"]);

    const listJobs = schemaFor("list-jobs", listJobsTool).inputSchema;
    expect(listJobs.required).toBeUndefined();
    expect(propertiesOf(listJobs).status).toMatchObject({
      enum: [
        "created",
        "queued",
        "staged",
        "running",
        "completed",
        "failed",
        "cancelled",
        "parsed",
      ],
      description: "Filter by job status (optional)",
    });

    const readLog = schemaFor("read-log", readLogTool).inputSchema;
    expect(readLog.required).toEqual(["jobId"]);
    expect(propertiesOf(readLog).stream).toMatchObject({
      enum: ["stdout", "stderr"],
      description: "Which stream to read (default: stdout)",
    });
  });

  test("exports inline object schemas for every canonical builtin output", () => {
    for (const [name, tool] of canonicalBuiltins) {
      const schema = schemaFor(name, tool).outputSchema;
      expect(schema.type).toBe("object");
      expect(isRecord(schema.properties)).toBe(true);
      expectInlineSchema(schema);
    }

    const cancel = schemaFor("cancel-job", cancelJobTool).outputSchema;
    expect(propertiesOf(cancel).status).toMatchObject({
      const: "cancelled",
    });
  });

  test("keeps runtime Zod input validation in the settlement pipeline", async () => {
    const registry = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
    registry.register(submitJobTool);

    const result = await registry
      .materialize()
      .settle(
        { name: "submit-job", input: { software: "gaussian" }, id: "invalid-input" },
        {} as ToolContext,
      );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
  });
});
