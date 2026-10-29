import { describe, expect, test } from "bun:test";
import { materializePlanMode } from "./plan-mode";
import { ToolRegistry, makeTool } from "./index";
import { z } from "zod";

function tool(name: string) {
  return makeTool({
    description: name,
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    execute: async () => ({ ok: true, data: { ok: true } }),
  });
}

describe("hard Plan Mode tool materialization", () => {
  test("publishes only explicitly read-only tools", async () => {
    const registry = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
    registry.registerDefinition("list-jobs", tool("list-jobs"));
    registry.registerDefinition("submit-job", tool("submit-job"));
    const mode = materializePlanMode(registry, ["list-jobs"]);
    expect(mode.definitions.map((definition) => definition.name)).toEqual(["list-jobs"]);
    const denied = await mode.settle({ id: "1", name: "submit-job", input: {} }, {} as never);
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("PLAN_MODE_DENIED");
  });
});
