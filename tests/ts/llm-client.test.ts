import { expect, test, describe, beforeEach, afterEach, mock } from "bun:test";
import { configureLlm, chatCompletion, getLlmConfig } from "../../packages/agent/src/llm-client";
import { fetchCatalog } from "../../packages/agent/src/model-catalog";

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("LLM Client & Catalog Integration", () => {
  let originalFetch: typeof fetch;

  let originalCwd: string;
  let directory: string;
  let originalConfig: ReturnType<typeof getLlmConfig>;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalConfig = getLlmConfig();
    originalCwd = process.cwd();
    directory = mkdtempSync(join(tmpdir(), "eigengrid-model-client-"));
    mkdirSync(join(directory, ".eigengrid"), { mode: 0o700 });
    process.chdir(directory);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    configureLlm(originalConfig);
    process.chdir(originalCwd);
    rmSync(directory, { recursive: true, force: true });
  });

  test("fetchCatalog parses provider and model level npm/api fields", async () => {
    globalThis.fetch = mock(() => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            "opencode-go": {
              id: "opencode-go",
              name: "OpenCode Go",
              api: "https://opencode.ai/zen/go/v1",
              npm: "@ai-sdk/openai-compatible",
              models: {
                "deepseek-v4-flash": {
                  id: "deepseek-v4-flash",
                  name: "DeepSeek V4 Flash",
                  cost: { input: 0.2, output: 0.5 },
                },
                "minimax-m2.7": {
                  id: "minimax-m2.7",
                  name: "MiniMax M2.7",
                  cost: { input: 0.3, output: 0.7 },
                  provider: {
                    npm: "@ai-sdk/anthropic",
                  },
                },
              },
            },
          }),
          { status: 200 },
        ),
      );
    });

    const catalog = await fetchCatalog({ force: true });

    expect(catalog["opencode-go"]).toBeDefined();
    expect(catalog["opencode-go"].npm).toBe("@ai-sdk/openai-compatible");

    const deepseek = catalog["opencode-go"].models["deepseek-v4-flash"];
    expect(deepseek).toBeDefined();
    expect(deepseek.npm).toBe("@ai-sdk/openai-compatible");
    expect(deepseek.api).toBe("https://opencode.ai/zen/go/v1");

    const minimax = catalog["opencode-go"].models["minimax-m2.7"];
    expect(minimax).toBeDefined();
    expect(minimax.npm).toBe("@ai-sdk/anthropic");
    expect(minimax.api).toBe("https://opencode.ai/zen/go/v1");
  });

  test("uses the selected provider's environment key without borrowing another provider's key", async () => {
    const names = ["LLM_API_KEY", "OPENCODE_API_KEY", "OPENAI_API_KEY", "FIXTURE_PROVIDER_KEY"];
    const saved = names.map((name) => process.env[name]);
    let authorization: string | undefined;
    try {
      delete process.env.LLM_API_KEY;
      process.env.OPENCODE_API_KEY = "wrong-provider-fixture";
      process.env.OPENAI_API_KEY = "wrong-provider-fixture";
      delete process.env.FIXTURE_PROVIDER_KEY;
      globalThis.fetch = mock(async (input: string | Request | URL, init?: RequestInit) => {
        if (String(input).includes("models.dev/api.json"))
          return Response.json({
            fixture: {
              name: "Fixture",
              api: "https://fixture.example/v1",
              npm: "@ai-sdk/openai-compatible",
              env: ["FIXTURE_PROVIDER_KEY"],
              models: { chat: { cost: { input: 0, output: 0 } } },
            },
          });
        authorization = new Headers(init?.headers).get("authorization") ?? undefined;
        return Response.json({
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      });
      await fetchCatalog({ force: true });
      configureLlm({
        providerName: "fixture",
        model: "chat",
        baseUrl: "https://fixture.example/v1",
        apiKey: undefined,
      });
      await chatCompletion([{ role: "user", content: "test" }]);
      expect(authorization).toBeUndefined();
      process.env.FIXTURE_PROVIDER_KEY = "correct-provider-fixture";
      configureLlm({ apiKey: undefined });
      await chatCompletion([{ role: "user", content: "test" }]);
      expect(authorization).toBe("Bearer correct-provider-fixture");
    } finally {
      names.forEach((name, index) => {
        if (saved[index] === undefined) delete process.env[name];
        else process.env[name] = saved[index];
      });
    }
  });

  test("chatCompletion routes deepseek-v4-flash to OpenAI-compatible endpoint", async () => {
    let lastUrl = "";
    let lastHeaders: Record<string, string> = {};
    let lastBody: any = null;

    globalThis.fetch = mock((url: string | Request | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("models.dev/api.json")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              "opencode-go": {
                id: "opencode-go",
                name: "OpenCode Go",
                api: "https://opencode.ai/zen/go/v1",
                npm: "@ai-sdk/openai-compatible",
                models: {
                  "deepseek-v4-flash": {
                    id: "deepseek-v4-flash",
                    name: "DeepSeek V4 Flash",
                  },
                },
              },
            }),
            { status: 200 },
          ),
        );
      }

      lastUrl = urlStr;
      lastHeaders = (init?.headers as Record<string, string>) ?? {};
      lastBody = init?.body ? JSON.parse(init.body as string) : null;

      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "Test response from DeepSeek" } }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    });

    await fetchCatalog({ force: true });
    configureLlm({
      costPerInputToken: 0,
      costPerOutputToken: 0,
      providerName: "opencode-go",
      model: "deepseek-v4-flash",
      apiKey: "sk-mock-key",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });

    const response = await chatCompletion([{ role: "user", content: "Hello" }]);
    expect(response).toBe("Test response from DeepSeek");
    expect(lastUrl).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(lastHeaders["authorization"]).toBe("Bearer sk-mock-key");
    expect(lastBody.model).toBe("deepseek-v4-flash");
  });

  test("chatCompletion routes minimax-m2.7 to Anthropic messages endpoint", async () => {
    let lastUrl = "";
    let lastHeaders: Record<string, string> = {};
    let lastBody: any = null;

    globalThis.fetch = mock((url: string | Request | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("models.dev/api.json")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              "opencode-go": {
                id: "opencode-go",
                name: "OpenCode Go",
                api: "https://opencode.ai/zen/go/v1",
                npm: "@ai-sdk/openai-compatible",
                models: {
                  "minimax-m2.7": {
                    id: "minimax-m2.7",
                    name: "MiniMax M2.7",
                    provider: {
                      npm: "@ai-sdk/anthropic",
                    },
                  },
                },
              },
            }),
            { status: 200 },
          ),
        );
      }

      lastUrl = urlStr;
      lastHeaders = (init?.headers as Record<string, string>) ?? {};
      lastBody = init?.body ? JSON.parse(init.body as string) : null;

      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "msg_123",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Test response from MiniMax" }],
            model: "minimax-m2.7",
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 10 },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    });

    await fetchCatalog({ force: true });
    configureLlm({
      costPerInputToken: 0,
      costPerOutputToken: 0,
      providerName: "opencode-go",
      model: "minimax-m2.7",
      apiKey: "sk-mock-key",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });

    const response = await chatCompletion([{ role: "user", content: "Hello" }]);
    expect(response).toBe("Test response from MiniMax");
    expect(lastUrl).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(lastHeaders["x-api-key"]).toBe("sk-mock-key");
    expect(lastBody.model).toBe("minimax-m2.7");
  });

  test("OpenCode Go sends one stable session and an EigenGrid user agent", async () => {
    const providerHeaders: Headers[] = [];
    globalThis.fetch = mock((url: string | Request | URL, init?: RequestInit) => {
      if (String(url).includes("models.dev/api.json")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              "opencode-go": {
                id: "opencode-go",
                name: "OpenCode Go",
                api: "https://opencode.ai/zen/go/v1",
                npm: "@ai-sdk/openai-compatible",
                models: {
                  "deepseek-v4-flash": {
                    id: "deepseek-v4-flash",
                    name: "DeepSeek V4 Flash",
                  },
                },
              },
            }),
            { status: 200 },
          ),
        );
      }
      providerHeaders.push(new Headers(init?.headers));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    });

    await fetchCatalog({ force: true });
    configureLlm({
      costPerInputToken: 0,
      costPerOutputToken: 0,
      providerName: "opencode-go",
      model: "deepseek-v4-flash",
      apiKey: "sk-mock-key",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });

    expect(await chatCompletion([{ role: "user", content: "first" }])).toBe("ok");
    expect(await chatCompletion([{ role: "user", content: "second" }])).toBe("ok");

    expect(providerHeaders).toHaveLength(2);
    const sessions = providerHeaders.map((headers) => headers.get("x-opencode-session"));
    expect(sessions[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(sessions[1]).toBe(sessions[0]);
    expect(providerHeaders[0].get("user-agent")).toBe("eigengrid-agent/0.1.0");
    expect(providerHeaders[0].get("authorization")).toBe("Bearer sk-mock-key");
  });

  test("an unresponsive catalog is aborted without waiting indefinitely", async () => {
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    await expect(fetchCatalog({ force: true })).rejects.toMatchObject({ name: "TimeoutError" });
  }, 8_000);

  test("Haiku 5.5 uses catalog capabilities instead of sending unsupported temperature", async () => {
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://models.dev/api.json")
        return Promise.resolve(
          Response.json({
            "opencode-go": {
              name: "OpenCode Go",
              api: "https://opencode.ai/inference/go/openai/v1",
              models: {
                "claude-haiku-5-5": {
                  temperature: false,
                  cost: { input: 0.1, output: 0.5 },
                  provider: {
                    npm: "@ai-sdk/anthropic",
                    api: "https://opencode.ai/inference/go/anthropic/v1",
                  },
                },
              },
            },
          }),
        );
      body = JSON.parse(String(init?.body));
      return Promise.resolve(
        Response.json({
          id: "msg_haiku_fixture",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Haiku fixture response" }],
          model: "claude-haiku-5-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
      );
    });
    await fetchCatalog({ force: true });
    await fetchCatalog({ force: true });
    configureLlm({
      costPerInputToken: 0,
      costPerOutputToken: 0,
      providerName: "opencode-go",
      model: "claude-haiku-5-5",
      apiKey: "fixture-key",
      baseUrl: "https://opencode.ai/inference/go/openai/v1",
      temperature: 0.3,
    });
    expect(await chatCompletion([{ role: "user", content: "hello" }])).toBe(
      "Haiku fixture response",
    );
    expect(body?.model).toBe("claude-haiku-5-5");
    expect(body).not.toHaveProperty("temperature");
  });
});
