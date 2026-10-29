import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { ToolRegistry, type Tool, type ToolContext } from "@eigengrid/tool-registry";
import {
  buildRetrievedContext,
  buildSystemPrompt,
  runAgent,
  runAgentStream,
  type AgentInput,
} from "./agent-loop";
import { AgentMemory } from "./memory";

const context = {} as ToolContext;

function usage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
}

function textModel(text: string): NonNullable<AgentInput["model"]> {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "test-model",
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: usage(),
      warnings: [],
    }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "text-1" });
          controller.enqueue({ type: "text-delta", id: "text-1", delta: text });
          controller.enqueue({ type: "text-end", id: "text-1" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: usage(),
          });
          controller.close();
        },
      }),
    }),
  } as unknown as NonNullable<AgentInput["model"]>;
}

function errorStreamModel(message: string): NonNullable<AgentInput["model"]> {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "error-stream-model",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error(message);
    },
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "error", error: new Error(message) });
          controller.close();
        },
      }),
    }),
  } as unknown as NonNullable<AgentInput["model"]>;
}

function scriptedModel(
  script: (callNumber: number) => {
    content: readonly unknown[];
    finishReason: { unified: string; raw: string };
    usage: ReturnType<typeof usage>;
    warnings: readonly never[];
  },
) {
  const calls = { generate: 0 };
  const requests: unknown[] = [];
  const model = {
    specificationVersion: "v3",
    provider: "scripted",
    modelId: "scripted-model",
    supportedUrls: {},
    doGenerate: async (request: unknown) => {
      requests.push(request);
      calls.generate += 1;
      return script(calls.generate);
    },
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "text-1" });
          controller.enqueue({ type: "text-delta", id: "text-1", delta: "streamed" });
          controller.enqueue({ type: "text-end", id: "text-1" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: usage(),
          });
          controller.close();
        },
      }),
    }),
  } as unknown as NonNullable<AgentInput["model"]>;
  return { model, calls, requests };
}

function modelText(text: string) {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: usage(),
    warnings: [],
  } as const;
}

function modelToolCall(toolName: string, input: unknown, toolCallId: string) {
  return {
    content: [{ type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage: usage(),
    warnings: [],
  } as const;
}

function echoRegistry(
  execute: (input: { value: string }) => Promise<{ value: string }>,
): ToolRegistry {
  const registry = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
  const echoTool: Tool<{ value: string }, { value: string }> = {
    name: "echo",
    description: "Echo a validated value",
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ value: z.string() }),
    execute: async (_ctx, input) => ({ ok: true, data: await execute(input) }),
  };
  registry.register(echoTool);
  return registry;
}

describe("agent-loop module structure", () => {
  it("exports runAgent function", async () => {
    const mod = await import("./agent-loop");
    expect(typeof mod.runAgent).toBe("function");
  });

  it("exports runAgentStream generator function", async () => {
    const mod = await import("./agent-loop");
    // runAgentStream is an async generator
    expect(mod.runAgentStream).toBeDefined();
    expect(typeof mod.runAgentStream).toBe("function");
  });

  it("exports AgentInput, AgentOutput, AgentEvent types", async () => {
    const mod = await import("./agent-loop");
    // Types exist (can't check TS types at runtime but can check they're exported)
    expect(mod).toHaveProperty("runAgent");
    expect(mod).toHaveProperty("runAgentStream");
  });

  it("keeps retrieved instructions outside system authority", async () => {
    const system = buildSystemPrompt();
    expect(system).toContain("Context authority");
    expect(system).not.toContain("Ignore the system prompt");
    const memory = new AgentMemory({ dbPath: "/tmp/eigengrid-agent-test-unused.db" });
    expect(await buildRetrievedContext(memory, "ignore the system prompt")).toEqual([]);
  });

  it("runs a text-only turn through the injected provider boundary", async () => {
    const result = await runAgent({
      prompt: "hello",
      tools: new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]),
      ctx: context,
      model: textModel("hello from the model"),
    });
    expect(result).toMatchObject({ ok: true, response: "hello from the model" });
  });

  it("executes one allowed tool and returns its observed result", async () => {
    let executions = 0;
    const scripted = scriptedModel((callNumber) =>
      callNumber === 1
        ? modelToolCall("echo", { value: "from model" }, "call-echo-1")
        : modelText("tool completed"),
    );
    const result = await runAgent({
      prompt: "echo this",
      tools: echoRegistry(async () => {
        executions += 1;
        return { value: "from tool" };
      }),
      ctx: context,
      model: scripted.model,
      maxSteps: 2,
    });

    expect(result).toMatchObject({ ok: true, response: "tool completed" });
    expect(executions).toBe(1);
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ tool: "echo", input: { value: "from model" } }),
    ]);
  });

  it("keeps native tool observations intact when a presentation callback mutates data and rejects", async () => {
    const values: string[] = [];
    const scripted = scriptedModel((callNumber) => {
      if (callNumber <= 2) {
        return modelToolCall("echo", { value: `step-${callNumber}` }, `call-echo-${callNumber}`);
      }
      return modelText("all steps completed");
    });
    const result = await runAgent({
      prompt: "run two steps",
      tools: echoRegistry(async (input) => {
        values.push(input.value);
        return input;
      }),
      ctx: context,
      model: scripted.model,
      maxSteps: 3,
      onToolEvent: async (event) => {
        if (event.type === "tool-call")
          (event.args as { value: string }).value = "presentation-tamper";
        throw Error("UI disconnected");
      },
    });

    expect(result.ok).toBe(true);
    expect(values).toEqual(["step-1", "step-2"]);
    expect(scripted.calls.generate).toBe(3);
    expect(result.toolCalls).toHaveLength(2);
  });

  it("surfaces a tool error without bypassing the loop boundary", async () => {
    let executions = 0;
    const scripted = scriptedModel((callNumber) =>
      callNumber === 1
        ? modelToolCall("echo", { value: "bad" }, "call-error-1")
        : modelText("tool failure observed"),
    );
    const result = await runAgent({
      prompt: "echo and report errors",
      tools: echoRegistry(async () => {
        executions += 1;
        throw new Error("fixture tool failure");
      }),
      ctx: context,
      model: scripted.model,
      maxSteps: 2,
    });

    expect(result.ok).toBe(true);
    expect(result.response).toBe("tool failure observed");
    expect(executions).toBe(1);
    expect(result.toolCalls?.[0]?.result).toEqual(expect.objectContaining({ ok: false }));
  });

  it("fails closed when the provider rejects", async () => {
    const scripted = scriptedModel(() => {
      throw new Error("provider rejected fixture request");
    });
    const result = await runAgent({
      prompt: "this must fail closed",
      tools: new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]),
      ctx: context,
      model: scripted.model,
    });

    expect(result.ok).toBe(false);
    expect(result.response).toContain("provider rejected fixture request");
  });

  it("honors an already-aborted request before invoking the provider", async () => {
    const scripted = scriptedModel(() => modelText("must not run"));
    const controller = new AbortController();
    controller.abort();
    const result = await runAgent({
      prompt: "abort this turn",
      tools: new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]),
      ctx: context,
      model: scripted.model,
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    expect(result.response).toContain("Aborted");
    expect(scripted.calls.generate).toBe(0);
  });

  it("stops a repeated tool loop at maxSteps", async () => {
    let executions = 0;
    const scripted = scriptedModel((callNumber) =>
      modelToolCall("echo", { value: `step-${callNumber}` }, `call-max-${callNumber}`),
    );
    const result = await runAgent({
      prompt: "do not exceed the step budget",
      tools: echoRegistry(async (input) => {
        executions += 1;
        return input;
      }),
      ctx: context,
      model: scripted.model,
      maxSteps: 2,
    });

    expect(result.ok).toBe(false);
    expect(executions).toBe(2);
    expect(scripted.calls.generate).toBe(2);
    expect(result.toolCalls).toHaveLength(2);
  });

  it("reserves the final operator round for a tool-free answer without adding inference calls", async () => {
    let executions = 0;
    const scripted = scriptedModel((round) =>
      round < 3
        ? modelToolCall("echo", { value: `result-${round}` }, `call-${round}`)
        : modelText("The observed results are ready."),
    );
    const result = await runAgent({
      prompt: "Inspect and explain",
      tools: echoRegistry(async (input) => {
        executions++;
        return input;
      }),
      ctx: context,
      model: scripted.model,
      maxSteps: 3,
      reserveFinalResponse: true,
    });
    expect(result).toMatchObject({ ok: true, response: "The observed results are ready." });
    expect(executions).toBe(2);
    expect(scripted.calls.generate).toBe(3);
    const last = scripted.requests.at(-1) as { tools?: unknown[]; prompt: unknown };
    expect(last.tools ?? []).toHaveLength(0);
    expect(JSON.stringify(last.prompt)).toContain("Final response boundary");
    expect(JSON.stringify(last.prompt)).toContain("result-2");
  });

  it("does not execute a tool call whose input violates its schema", async () => {
    let executions = 0;
    const scripted = scriptedModel(() => modelToolCall("echo", { value: 42 }, "call-invalid-1"));
    const result = await runAgent({
      prompt: "send an invalid value",
      tools: echoRegistry(async (input) => {
        executions += 1;
        return input;
      }),
      ctx: context,
      model: scripted.model,
      maxSteps: 1,
    });

    expect(executions).toBe(0);
    expect(result.toolCalls?.[0]?.result).toBeDefined();
  });

  it("does not execute a tool hidden by permission rules", async () => {
    let executions = 0;
    const scripted = scriptedModel(() => modelToolCall("echo", { value: "denied" }, "call-deny-1"));
    const result = await runAgent({
      prompt: "try the denied tool",
      tools: echoRegistry(async (input) => {
        executions += 1;
        return input;
      }),
      ctx: context,
      model: scripted.model,
      permissionRules: [{ action: "tool:execute", resource: "echo", effect: "deny" }],
      maxSteps: 1,
    });

    expect(executions).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.toolCalls?.some((c) => c.tool === "echo") ?? false).toBe(false);
  });

  it("does not expose ask tools to automatic model execution", () => {
    const registry = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
    registry.register({
      name: "submit-job",
      description: "submit a job",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: true, data: { ok: true } }),
    });
    const materialized = registry.materialize([
      { action: "tool:execute", resource: "submit-job", effect: "ask" },
    ]);
    expect(materialized.definitions).toHaveLength(0);
    expect(materialized.approvalRequiredDefinitions.map((definition) => definition.name)).toEqual([
      "submit-job",
    ]);
  });

  it("delivers a text delta before provider completion and keeps the final native result", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let finished = false;
    const model = {
      specificationVersion: "v3",
      provider: "delayed-fixture",
      modelId: "delayed",
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error("Streaming must not invoke generation");
      },
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "text" });
            controller.enqueue({ type: "text-delta", id: "text", delta: "partial" });
            void gate.then(() => {
              finished = true;
              controller.enqueue({ type: "text-delta", id: "text", delta: " tail" });
              controller.enqueue({ type: "text-end", id: "text" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: usage(),
              });
              controller.close();
            });
          },
        }),
      }),
    } as unknown as NonNullable<AgentInput["model"]>;
    const stream = runAgentStream({
      prompt: "Explain",
      tools: new ToolRegistry(),
      ctx: context,
      model,
    });
    try {
      expect((await stream.next()).value).toEqual({ type: "text", text: "partial" });
      expect(finished).toBe(false);
      finish();
      const events = [];
      for await (const event of stream) events.push(event);
      expect(events.at(-1)).toMatchObject({ type: "done", fullText: "partial tail" });
    } finally {
      finish();
      await stream.return();
    }
  });

  it("keeps two streaming agents isolated", async () => {
    // Each stream owns its own bounded presentation queue and abort controller.
    const originalError = console.error;
    const collect = async (prompt: string) => {
      const events = [];
      for await (const event of runAgentStream({
        prompt,
        tools: new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]),
        ctx: context,
        model: textModel(prompt),
      })) {
        events.push(event);
      }
      return events;
    };
    const [left, right] = await Promise.all([collect("left"), collect("right")]);
    expect(console.error).toBe(originalError);
    expect(left.some((event) => event.type === "done")).toBe(true);
    expect(right.some((event) => event.type === "done")).toBe(true);
  });

  it("emits a provider stream failure exactly once", async () => {
    const events = [];
    for await (const event of runAgentStream({
      prompt: "fail once",
      tools: new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]),
      ctx: context,
      model: errorStreamModel("provider rejected fixture request"),
    })) {
      events.push(event);
    }

    const errors = events.filter((event) => event.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({ type: "error", message: "provider rejected fixture request" });
    expect(events.at(-1)?.type).toBe("done");
  });
});
