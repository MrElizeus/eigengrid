import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptStore } from "./chatgpt-store";
import { ChatGptAuth } from "./chatgpt-auth";
import { chatGptFetch } from "./chatgpt-transport";
import { chatCompletion, configureLlm, getLlmConfig, resolveConfiguredModel } from "./llm-client";
import { tool } from "ai";
import { z } from "zod";
import { saveLlmConfig } from "./llm-config-store";

const completeEvents = [
  {
    type: "response.created",
    response: { id: "response-fixture", created_at: 1, model: "account-model" },
  },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "message", id: "message-fixture" },
  },
  {
    type: "response.content_part.added",
    output_index: 0,
    content_index: 0,
    item_id: "message-fixture",
    part: { type: "output_text", text: "", annotations: [] },
  },
  {
    type: "response.output_text.delta",
    output_index: 0,
    content_index: 0,
    item_id: "message-fixture",
    delta: "connected",
    logprobs: [],
  },
  {
    type: "response.output_text.done",
    output_index: 0,
    content_index: 0,
    item_id: "message-fixture",
    text: "connected",
    logprobs: [],
  },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "message",
      id: "message-fixture",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "connected", annotations: [] }],
    },
  },
  { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2 } } },
];
function sse(events: object[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("ChatGPT Responses transport (offline)", () => {
  let directory: string;
  let originalCwd: string;
  let originalFetch: typeof fetch;
  let originalConfig: ReturnType<typeof getLlmConfig>;
  let previousAuthDirectory: string | undefined;
  let store: ChatGptStore;
  let auth: ChatGptAuth;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalCwd = process.cwd();
    originalConfig = getLlmConfig();
    previousAuthDirectory = process.env.EIGENGRID_AUTH_DIR;
    directory = mkdtempSync(join(tmpdir(), "eigengrid-chatgpt-transport-"));
    mkdirSync(join(directory, ".eigengrid"), { mode: 0o700 });
    process.chdir(directory);
    process.env.EIGENGRID_AUTH_DIR = join(directory, "auth");
    store = new ChatGptStore();
    store.save({
      id: "profile-fixture",
      clientId: "oaiapp_fixture",
      subject: "fixture-user",
      scopes: ["chatgpt.tokens.use.direct"],
      accessToken: "fixture-access",
      refreshToken: "fixture-refresh",
      expiresAt: Date.now() + 3600_000,
    });
    auth = new ChatGptAuth({ store });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    configureLlm(originalConfig);
    process.chdir(originalCwd);
    if (previousAuthDirectory === undefined) delete process.env.EIGENGRID_AUTH_DIR;
    else process.env.EIGENGRID_AUTH_DIR = previousAuthDirectory;
    rmSync(directory, { recursive: true, force: true });
  });
  test("pins token destination and requires streaming with store disabled", async () => {
    let calls = 0;
    const transport = chatGptFetch(auth, "profile-fixture", (async (_input, init) => {
      calls++;
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-access");
      expect(JSON.parse(String(init?.body))).toMatchObject({ store: false, stream: true });
      return sse(completeEvents);
    }) as typeof fetch);
    const init = { method: "POST", body: JSON.stringify({ store: true, stream: true }) };
    await expect(transport("https://other.example/v1/responses", init)).rejects.toThrow("official");
    await expect(
      transport("https://api.openai.com/v1/responses", { ...init, body: '{"stream":false}' }),
    ).rejects.toThrow("streaming");
    const response = await transport("https://api.openai.com/v1/responses", init);
    expect(await response.text()).toContain("response.completed");
    expect(calls).toBe(1);
  });
  test("a partial stream or a plan usage failure cannot become a successful answer", async () => {
    for (const events of [
      completeEvents.slice(0, -1),
      [
        {
          type: "response.failed",
          response: { error: { code: "subscription_sharing_usage_limit_exceeded" } },
        },
      ],
    ]) {
      const transport = chatGptFetch(auth, "profile-fixture", (async () =>
        sse(events)) as unknown as typeof fetch);
      const response = await transport("https://api.openai.com/v1/responses", {
        method: "POST",
        body: '{"stream":true}',
      });
      await expect(response.text()).rejects.toThrow();
    }
  });
  test("collected chat responses still use authenticated streaming through the shared gateway", async () => {
    const requests: { url: string; body?: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: String(input),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-access");
      if (String(input).endsWith("/models"))
        return Response.json({
          models: [{ slug: "account-model", display_name: "Account Model", visibility: "list" }],
        });
      return sse(completeEvents);
    }) as typeof fetch;
    configureLlm({
      authMode: "chatgpt",
      chatGptProfileId: "profile-fixture",
      providerName: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "account-model",
      apiKey: "unrelated-api-key",
    });
    saveLlmConfig(getLlmConfig());
    const response = await chatCompletion([{ role: "user", content: "hello" }]);
    expect(response).toBe("connected");
    expect(requests.every((request) => request.url.startsWith("https://api.openai.com/v1/"))).toBe(
      true,
    );
    expect(requests.find((request) => request.body)?.body).toMatchObject({
      stream: true,
      store: false,
    });
    expect(readFileSync(join(directory, ".eigengrid/llm.json"), "utf8")).not.toContain(
      "fixture-access",
    );
  });

  test("the streaming-only account model preserves structured tool calls", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/models"))
        return Response.json({
          models: [{ slug: "account-model", display_name: "Account Model", visibility: "list" }],
        });
      return sse([
        completeEvents[0],
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            id: "tool-item",
            call_id: "tool-call",
            name: "inspect",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "tool-item",
          output_index: 0,
          delta: "{}",
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            id: "tool-item",
            call_id: "tool-call",
            name: "inspect",
            arguments: "{}",
            status: "completed",
          },
        },
        completeEvents.at(-1)!,
      ]);
    }) as unknown as typeof fetch;
    configureLlm({
      authMode: "chatgpt",
      chatGptProfileId: "profile-fixture",
      providerName: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "account-model",
      apiKey: undefined,
    });
    const resolution = await resolveConfiguredModel();
    const result = await resolution.gateway.generateConversation({
      providerIdentity: resolution.identity,
      messages: [{ role: "user", content: "inspect" }],
      tools: {
        inspect: tool({ description: "Inspect a local fixture", inputSchema: z.object({}) }),
      },
      maximumSteps: 1,
      temperature: 0,
      maxOutputTokens: 32,
      timeoutMilliseconds: 1000,
      budget: resolution.budget,
    });
    expect(result.result.toolCalls).toMatchObject([
      { toolCallId: "tool-call", toolName: "inspect", input: {} },
    ]);
  });
  test("sends and persists the selected reasoning effort for the account model", async () => {
    let inferenceCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/models"))
        return Response.json({
          models: [
            {
              slug: "account-model",
              display_name: "Account Model",
              visibility: "list",
              supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
            },
          ],
        });
      inferenceCalls++;
      expect(JSON.parse(String(init?.body))).toMatchObject({
        reasoning: { effort: "high" },
        stream: true,
        store: false,
      });
      expect(JSON.parse(String(init?.body)).temperature).toBeUndefined();
      return sse(completeEvents);
    }) as unknown as typeof fetch;
    configureLlm({
      authMode: "chatgpt",
      chatGptProfileId: "profile-fixture",
      providerName: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "account-model",
      apiKey: undefined,
      reasoningEffort: "high",
    });
    saveLlmConfig(getLlmConfig());
    expect(
      JSON.parse(readFileSync(join(directory, ".eigengrid/llm.json"), "utf8")).reasoningEffort,
    ).toBe("high");
    expect(await chatCompletion([{ role: "user", content: "hello" }])).toBe("connected");
    configureLlm({ reasoningEffort: "medium" });
    await expect(chatCompletion([{ role: "user", content: "hello" }])).rejects.toThrow(
      "not available",
    );
    expect(inferenceCalls).toBe(1);
  });
});
