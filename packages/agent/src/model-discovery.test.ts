import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { discoverConfiguredModels, ModelConnectionRequiredError } from "./model-discovery";
import type { LlmConfig } from "./llm-client";
import type { ChatGptAuth } from "./chatgpt-auth";
import type { CatalogProvider } from "./model-catalog";

const config: LlmConfig = {
  authMode: "api-key",
  providerName: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "fixture-api-credential",
  model: "catalog-only",
};
const catalog: Record<string, CatalogProvider> = {
  openai: {
    id: "openai",
    name: "OpenAI",
    api: config.baseUrl,
    npm: "@ai-sdk/openai",
    env: ["OPENAI_API_KEY"],
    models: {
      "available-chat": { id: "available-chat", name: "Available Chat", toolCall: true },
      "catalog-only": { id: "catalog-only", name: "Stale Directory Entry" },
      "no-tools": { id: "no-tools", toolCall: false },
      "deprecated-chat": { id: "deprecated-chat", status: "deprecated" },
    },
  },
};
const fakeFetch = (fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  fn as unknown as typeof fetch;

describe("live credential-scoped model discovery", () => {
  const names = ["LLM_API_KEY", "OPENAI_API_KEY", "OPENCODE_API_KEY", "ANTHROPIC_API_KEY"];
  let saved: (string | undefined)[];
  beforeEach(() => {
    saved = names.map((name) => process.env[name]);
    names.forEach((name) => delete process.env[name]);
  });
  afterEach(() =>
    names.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    }),
  );

  test("uses the API provider response, excluding shutdown, deprecated and non-conversational models", async () => {
    const result = await discoverConfiguredModels(config, {
      catalog: async () => catalog,
      fetch: fakeFetch(async (input, init) => {
        expect(String(input)).toBe("https://api.openai.com/v1/models");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer fixture-api-credential",
        );
        expect(init?.redirect).toBe("error");
        return Response.json({
          data: [
            { id: "available-chat" },
            { id: "newly-released-chat", name: "Fresh From Provider" },
            { id: "retired-chat", shutdown_date: "2000-01-01" },
            { id: "deprecated-chat" },
            { id: "no-tools" },
            { id: "text-embedding-3-large" },
            { id: "gpt-image-2" },
            { id: "gpt-realtime-2.1" },
          ],
        });
      }),
    });
    expect(result.models.map((model) => model.id)).toEqual([
      "available-chat",
      "newly-released-chat",
    ]);
    expect(result.excluded).toBe(6);
    expect(result.authMode).toBe("api-key");
    expect(result.models.map((model) => model.id)).not.toContain("catalog-only");
  });

  test("ChatGPT account selection never uses the public API directory or an API key", async () => {
    const ids: string[] = [];
    const chatGpt = {
      accounts: () => [
        { id: "account-a", label: "Account A", connected: true, sharing: true },
        { id: "account-b", label: "Account B", connected: true, sharing: true },
      ],
      models: async (id: string) => {
        ids.push(id);
        return [{ id: "account-only", name: "Account Model" }];
      },
    } as unknown as ChatGptAuth;
    const result = await discoverConfiguredModels(
      { ...config, authMode: "chatgpt", chatGptProfileId: "account-b" },
      {
        chatGpt,
        catalog: async () => {
          throw new Error("Public directory must not be used");
        },
        fetch: fakeFetch(async () => {
          throw new Error("API credential path must not be used");
        }),
      },
    );
    expect(ids).toEqual(["account-b"]);
    expect(result.models).toEqual([{ id: "account-only", name: "Account Model" }]);
    expect(result.account).toBe("Account B");
    expect(result.authMode).toBe("chatgpt");
  });

  test("a saved ChatGPT account cannot silently authenticate API mode when no key is configured", async () => {
    let calls = 0;
    await expect(
      discoverConfiguredModels(
        { ...config, apiKey: undefined },
        {
          catalog: async () => catalog,
          fetch: fakeFetch(async () => {
            calls++;
            return Response.json({ data: [] });
          }),
        },
      ),
    ).rejects.toBeInstanceOf(ModelConnectionRequiredError);
    expect(calls).toBe(0);
  });

  test("uses this provider's environment key instead of another provider's key", async () => {
    process.env.OPENCODE_API_KEY = "wrong-provider-fixture";
    process.env.OPENAI_API_KEY = "right-provider-fixture";
    await discoverConfiguredModels(
      { ...config, apiKey: undefined },
      {
        catalog: async () => catalog,
        fetch: fakeFetch(async (_input, init) => {
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer right-provider-fixture",
          );
          return Response.json({ data: [] });
        }),
      },
    );
  });

  test("Anthropic discovery follows pagination with native headers and filters lifecycle", async () => {
    const requests: URL[] = [];
    const result = await discoverConfiguredModels(
      { ...config, providerName: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
      {
        catalog: async () => ({}),
        fetch: fakeFetch(async (input, init) => {
          const url = new URL(String(input));
          requests.push(url);
          expect(new Headers(init?.headers).get("x-api-key")).toBe("fixture-api-credential");
          expect(new Headers(init?.headers).has("authorization")).toBe(false);
          return requests.length === 1
            ? Response.json({
                data: [
                  { id: "claude-current", display_name: "Claude Current", lifecycle: "active" },
                  { id: "claude-old", lifecycle: "deprecated" },
                ],
                has_more: true,
                last_id: "claude-old",
              })
            : Response.json({
                data: [{ id: "claude-current-next", lifecycle: "active" }],
                has_more: false,
              });
        }),
      },
    );
    expect(requests[1].searchParams.get("after_id")).toBe("claude-old");
    expect(result.models.map((model) => model.id)).toEqual([
      "claude-current",
      "claude-current-next",
    ]);
  });

  test("unsupported live listing fails explicitly instead of displaying cached directory models", async () => {
    await expect(
      discoverConfiguredModels(config, {
        catalog: async () => catalog,
        fetch: fakeFetch(async () => new Response(null, { status: 404 })),
      }),
    ).rejects.toThrow("does not expose a live model list");
    await expect(
      discoverConfiguredModels(config, {
        catalog: async () => catalog,
        fetch: fakeFetch(async () => Response.json({ models: [{ slug: "account-model" }] })),
      }),
    ).rejects.toThrow("authentication method");
  });

  test("loopback model servers can be listed without an API key", async () => {
    const result = await discoverConfiguredModels(
      { ...config, providerName: "local", baseUrl: "http://127.0.0.1:11434/v1", apiKey: undefined },
      {
        catalog: async () => ({}),
        fetch: fakeFetch(async (_input, init) => {
          expect(new Headers(init?.headers).has("authorization")).toBe(false);
          return Response.json({ data: [{ id: "local-chat" }] });
        }),
      },
    );
    expect(result.models[0].id).toBe("local-chat");
  });
});
