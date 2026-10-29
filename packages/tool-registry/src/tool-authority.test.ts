import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "./registry";
import { make } from "./tool";
import { executeStep, createPlanExecutor } from "./execution";
import type { ToolContext } from "./types";
const ctx = {} as ToolContext;
const allow = [{ action: "*", resource: "*", effect: "allow" as const }];
const ask = [{ action: "*", resource: "*", effect: "ask" as const }];
function inspected(cb: () => void) {
  return make({
    description: "Monitored typed effect",
    input: z.object({ value: z.string() }),
    output: z.object({ ok: z.boolean() }),
    execute: async () => {
      cb();
      return { ok: true, data: { ok: true } };
    },
  });
}
describe("native agent tool authority: fail closed on every execution route", () => {
  test("unconfigured registry denies direct execution and both snapshot levels", async () => {
    let calls = 0;
    const reg = new ToolRegistry();
    reg.registerDefinition(
      "mutate",
      inspected(() => calls++),
    );
    expect(reg.get("mutate")).toBeUndefined();
    expect(reg.list()).toHaveLength(0);
    expect(reg.materialize().definitions).toHaveLength(0);
    expect(reg.materialize(allow).definitions).toHaveLength(0);
    expect(
      (await reg.settleAuthorized({ id: "x", name: "mutate", input: { value: "test" } }, ctx)).error
        ?.code,
    ).toBe("PERMISSION_DENIED");
    expect(calls).toBe(0);
  });
  test("stale materializations cannot execute after revocation or registration changes", async () => {
    let calls = 0;
    const reg = new ToolRegistry(allow);
    reg.registerDefinition(
      "mutate",
      inspected(() => calls++),
    );
    const snap = reg.materialize();
    reg.replacePermissions([{ action: "*", resource: "*", effect: "deny" }]);
    expect(
      (await snap.settle({ id: "x", name: "mutate", input: { value: "test" } }, ctx)).error?.code,
    ).toBe("PERMISSION_DENIED");
    reg.replacePermissions(allow);
    const old = reg.materialize();
    reg.registerDefinition(
      "mutate",
      inspected(() => calls++),
    );
    expect(
      (await old.settle({ id: "y", name: "mutate", input: { value: "test" } }, ctx)).error?.code,
    ).toBe("STALE_TOOL");
    expect(calls).toBe(0);
  });
  test("an ask result never executes without a host verifier", async () => {
    let calls = 0;
    const reg = new ToolRegistry(ask);
    reg.registerDefinition(
      "mutate",
      inspected(() => calls++),
    );
    const call = { id: "ask-1", name: "mutate", input: { value: "material" } };
    expect(reg.materialize().definitions).toHaveLength(0);
    expect(reg.materialize().approvalRequiredDefinitions).toHaveLength(1);
    expect((await reg.settleAuthorized(call, ctx)).error?.code).toBe("APPROVAL_REQUIRED");
    expect((await reg.settleAuthorized(call, ctx, undefined, async () => false)).ok).toBe(false);
    expect((await reg.settleAuthorized(call, ctx, undefined, async () => true)).ok).toBe(true);
    expect(calls).toBe(1);
  });
  test("policy updates between approval checks fail closed", async () => {
    let calls = 0;
    const reg = new ToolRegistry(ask);
    reg.registerDefinition(
      "mutate",
      inspected(() => calls++),
    );
    let n = 0;
    const approved = await reg.settleAuthorized(
      { id: "z", name: "mutate", input: { value: "test" } },
      ctx,
      undefined,
      async () => {
        if (++n === 2) reg.replacePermissions([{ action: "*", resource: "*", effect: "deny" }]);
        return true;
      },
    );
    expect(approved.ok).toBe(false);
    expect(calls).toBe(0);
  });
  test("raw plan executor and raw step dispatcher require a host authorize callback", async () => {
    let calls = 0;
    const tool = inspected(() => calls++);
    const call = { id: "x", name: "mutate", input: { value: "test" } };
    expect((await executeStep({ tool, ctx, call })).settled.error?.code).toBe("PERMISSION_DENIED");
    const plan = createPlanExecutor({ ctx, tools: new Map([["mutate", tool]]) });
    const out = await plan.execute({ steps: [call], onFailure: "stop" });
    expect(out.ok).toBe(false);
    expect(calls).toBe(0);
  });
});
