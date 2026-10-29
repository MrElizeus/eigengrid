import { describe, it, expect, mock } from "bun:test";
import { ToolRegistry, doctorTool, submitJobTool } from "@eigengrid/tool-registry";
import type { ToolContext } from "@eigengrid/tool-registry";
import { InProcessEventBus } from "@eigengrid/events";
import type { PermissionRuleset } from "@eigengrid/core";
import { z } from "zod";

function createMockContext(): ToolContext {
  return {
    db: {} as any,
    python: {} as any,
    runners: { local: {} as any },
    bus: new InProcessEventBus(),
    config: {} as any,
  };
}

describe("ToolRegistry", () => {
  it("registers and lists tools", () => {
    const reg = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
    reg.register(doctorTool);
    reg.register(submitJobTool);
    expect(reg.list()).toHaveLength(2);
  });

  it("executes doctor tool", async () => {
    const reg = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
    reg.register(doctorTool);
    const result = await reg.execute("doctor", createMockContext(), {});
    expect(result.ok).toBe(true);
  });

  it("returns error for unknown tool", async () => {
    const reg = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
    const result = await reg.execute("nonexistent", createMockContext(), {});
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TOOL_NOT_FOUND");
  });

  it("validates input schema", async () => {
    const reg = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
    reg.register(submitJobTool);
    const result = await reg.execute("submit-job", createMockContext(), { invalid: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_INPUT");
  });

  it("materializes only allowed tools and surfaces ask tools as non-executable", async () => {
    const reg = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
    reg.register(doctorTool);
    reg.register(submitJobTool);
    const rules: PermissionRuleset = [
      { action: "tool:execute", resource: "*", effect: "deny" },
      { action: "tool:execute", resource: "doctor", effect: "allow" },
      { action: "tool:execute", resource: "submit-job", effect: "ask" },
    ];

    const materialized = reg.materialize(rules);
    expect(materialized.definitions.map((definition) => definition.name)).toEqual(["doctor"]);
    expect(materialized.approvalRequiredDefinitions.map((definition) => definition.name)).toEqual([
      "submit-job",
    ]);

    const doctor = await materialized.settle(
      { name: "doctor", input: {}, id: "doctor-call" },
      createMockContext(),
    );
    expect(doctor.ok).toBe(true);
    const submit = await materialized.settle(
      { name: "submit-job", input: {}, id: "submit-call" },
      createMockContext(),
    );
    expect(submit.ok).toBe(false);
    expect(submit.error?.code).toBe("TOOL_NOT_FOUND");
  });

  it("keeps constructor-bound ask rules when snapshots receive empty or allow rules", async () => {
    const execute = mock(async () => ({ ok: true, data: { ok: true } }));
    const reg = new ToolRegistry([{ action: "tool:execute", resource: "mutate", effect: "ask" }]);
    reg.register({
      name: "mutate",
      description: "Mutates state",
      inputSchema: z.object({ required: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      execute,
    });

    const allow: PermissionRuleset = [
      { action: "tool:execute", resource: "mutate", effect: "allow" },
    ];
    for (const rules of [allow]) {
      const materialized = reg.materialize(rules);
      expect(materialized.definitions).toEqual([]);
      expect(materialized.approvalRequiredDefinitions.map((definition) => definition.name)).toEqual(
        ["mutate"],
      );

      const result = await materialized.settle(
        { name: "mutate", input: {}, id: "mutate-call" },
        createMockContext(),
      );
      expect(result.error?.code).toBe("TOOL_NOT_FOUND");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps constructor-bound deny rules when snapshots receive empty or allow rules", async () => {
    const execute = mock(async () => ({ ok: true, data: { ok: true } }));
    const reg = new ToolRegistry([{ action: "tool:execute", resource: "mutate", effect: "deny" }]);
    reg.register({
      name: "mutate",
      description: "Mutates state",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute,
    });

    const allow: PermissionRuleset = [
      { action: "tool:execute", resource: "mutate", effect: "allow" },
    ];
    for (const rules of [allow]) {
      const materialized = reg.materialize(rules);
      expect(materialized.definitions).toEqual([]);
      expect(materialized.approvalRequiredDefinitions).toEqual([]);

      const result = await materialized.settle(
        { name: "mutate", input: {}, id: "mutate-call" },
        createMockContext(),
      );
      expect(result.error?.code).toBe("TOOL_NOT_FOUND");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("allows caller rules to further restrict constructor-bound allow rules", () => {
    const reg = new ToolRegistry([{ action: "tool:execute", resource: "mutate", effect: "allow" }]);
    reg.register({
      name: "mutate",
      description: "Mutates state",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: true, data: { ok: true } }),
    });

    const ask = reg.materialize([{ action: "tool:execute", resource: "mutate", effect: "ask" }]);
    expect(ask.definitions).toEqual([]);
    expect(ask.approvalRequiredDefinitions.map((definition) => definition.name)).toEqual([
      "mutate",
    ]);

    const deny = reg.materialize([{ action: "tool:execute", resource: "mutate", effect: "deny" }]);
    expect(deny.definitions).toEqual([]);
    expect(deny.approvalRequiredDefinitions).toEqual([]);
  });
});
