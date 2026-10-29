import { describe, expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import {
  ModelConversationBudgetExceededError,
  ModelConversationResponseLimitError,
  ModelGateway,
  type ModelConversationBudget,
  type ModelConversationRequest,
  type ModelProviderIdentity,
} from "./model-gateway";
import { createConfiguredModelResolution, createResponseBoundedFetch } from "./configured-provider";

const identity: ModelProviderIdentity = {
  providerId: "fixture-provider",
  providerVersion: "1.0.0",
  modelId: "fixture-model",
  modelRevision: "fixture-r1",
};

function usage() {
  return {
    inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 3, text: 3, reasoning: 0 },
  };
}

function budget(overrides: Partial<ModelConversationBudget> = {}): ModelConversationBudget {
  return {
    maximumCalls: 1,
    maximumSteps: 1,
    maximumInputTokens: 10_000,
    maximumOutputTokens: 100,
    maximumTotalTokens: 10_100,
    maximumCost: 1,
    ...overrides,
  };
}

function textModel(
  text: string,
  calls: { generate: number; stream: number; temperatures?: (number | undefined)[] },
): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: identity.providerId,
    modelId: identity.modelId,
    supportedUrls: {},
    doGenerate: async (options: { temperature?: number }) => {
      calls.generate += 1;
      calls.temperatures?.push(options.temperature);
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(),
        warnings: [],
      };
    },
    doStream: async (options: { temperature?: number }) => {
      calls.stream += 1;
      calls.temperatures?.push(options.temperature);
      return {
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
      };
    },
  } as LanguageModel;
}

function request(
  model: LanguageModel,
  overrides: Partial<ModelConversationRequest> = {},
): ModelConversationRequest {
  return {
    model,
    providerIdentity: identity,
    system: "Keep the system policy authoritative.",
    messages: [{ role: "user", content: "hello" }],
    maximumSteps: 1,
    temperature: 0,
    maxOutputTokens: 32,
    timeoutMilliseconds: 1_000,
    budget: budget(),
    context: { safe: "context", apiKey: "sk-test-secret-value" },
    ...overrides,
  };
}

describe("shared conversational model boundary", () => {
  test("an aborted provider stream rejects accounting instead of leaving metadata pending", async () => {
    const abort = new AbortController();
    const model = {
      specificationVersion: "v3",
      provider: identity.providerId,
      modelId: identity.modelId,
      supportedUrls: {},
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "partial" });
            controller.enqueue({ type: "text-delta", id: "partial", delta: "partial" });
            abort.signal.addEventListener(
              "abort",
              () => controller.error(new DOMException("Interrupted", "AbortError")),
              { once: true },
            );
          },
        }),
      }),
    } as unknown as LanguageModel;
    const execution = new ModelGateway().streamConversation(
      request(model, { signal: abort.signal }),
    );
    void execution.metadata.catch(() => {});
    for await (const part of execution.result.fullStream)
      if (part.type === "text-delta") abort.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        execution.metadata.then(
          () => "resolved",
          (error) => error.name,
        ),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("pending metadata"), 100);
        }),
      ]);
      expect(outcome).toBe("AbortError");
    } finally {
      clearTimeout(timer);
    }
  });

  test("request provenance distinguishes sampling and accounting policy changes", async () => {
    const calls = { generate: 0, stream: 0 };
    const model = textModel("bound", calls);
    const first = new ModelGateway({
      conversationProviders: [
        {
          identity,
          model,
          temperature: 0,
          maxOutputTokens: 100,
          costPerInputToken: 0,
          costPerOutputToken: 0,
        },
      ],
    });
    const second = new ModelGateway({
      conversationProviders: [
        {
          identity,
          model,
          temperature: 0,
          maxOutputTokens: 100,
          costPerInputToken: 0.000001,
          costPerOutputToken: 0.000001,
        },
      ],
    });
    const configured = { ...request(model), model: undefined };
    const a = await first.generateConversation(configured);
    const b = await second.generateConversation(configured);
    const c = await first.generateConversation({ ...configured, temperature: 0.1 });
    expect(
      new Set([a.metadata.requestDigest, b.metadata.requestDigest, c.metadata.requestDigest]).size,
    ).toBe(3);
  });

  test("catalog rates include cache writes and higher context tiers, with explicit overrides preserved", async () => {
    const catalog = async () => ({
      fixture: {
        models: {
          priced: {
            cost: {
              input: 0.1,
              output: 0.5,
              cache_read: 0.01,
              cache_write: 0.125,
              tiers: [{ input: 0.5, output: 2.5, cache_write: 0.625 }],
            },
          },
        },
      },
    });
    const options = {
      baseUrl: "https://fixture.invalid/v1",
      providerName: "fixture",
      model: "priced",
    };
    const resolved = await createConfiguredModelResolution(options, catalog);
    expect(resolved.pricing).toEqual({
      costPerInputToken: 0.625 / 1_000_000,
      costPerOutputToken: 2.5 / 1_000_000,
    });
    const free = await createConfiguredModelResolution(
      { ...options, costPerInputToken: 0, costPerOutputToken: 0 },
      catalog,
    );
    expect(free.pricing).toEqual({ costPerInputToken: 0, costPerOutputToken: 0 });
    await expect(
      createConfiguredModelResolution({ ...options, model: "unknown" }, catalog),
    ).rejects.toThrow(/pricing/i);
  });

  test("registered pricing and identity cannot be changed through a retained caller reference", async () => {
    const calls = { generate: 0, stream: 0 };
    const model = textModel("priced result", calls);
    const provider = {
      identity: { ...identity },
      model,
      temperature: 0,
      maxOutputTokens: 100,
      costPerInputToken: 0.000001,
      costPerOutputToken: 0.000002,
    };
    const gateway = new ModelGateway({ conversationProviders: [provider] });
    provider.costPerInputToken = 0;
    provider.costPerOutputToken = 0;
    provider.identity.providerId = "changed";
    const execution = await gateway.generateConversation({ ...request(model), model: undefined });
    expect(execution.metadata.provider.providerId).toBe(identity.providerId);
    expect(execution.metadata.usage.cost).toBeCloseTo(0.00001, 12);
    expect(execution.metadata.usage.costPerInputToken).toBe(0.000001);
  });

  test("missing provider prices cannot silently settle a paid call at zero", async () => {
    const calls = { generate: 0, stream: 0 };
    const model = textModel("must not run", calls);
    const gateway = new ModelGateway({
      conversationProviders: [{ identity, model, temperature: 0, maxOutputTokens: 100 }],
    });
    const configured = { ...request(model), model: undefined };
    await expect(gateway.generateConversation(configured)).rejects.toThrow(/pricing/i);
    expect(() => gateway.streamConversation(configured)).toThrow(/pricing/i);
    expect(calls).toEqual({ generate: 0, stream: 0 });
  });

  test("priced calls enforce the reserved monetary bound before invoking the SDK", async () => {
    const calls = { generate: 0, stream: 0 };
    const model = textModel("must not run", calls);
    const gateway = new ModelGateway({
      conversationProviders: [
        {
          identity,
          model,
          temperature: 0,
          maxOutputTokens: 100,
          costPerInputToken: 1,
          costPerOutputToken: 1,
        },
      ],
    });
    const configured = { ...request(model), model: undefined };
    await expect(gateway.generateConversation(configured)).rejects.toBeInstanceOf(
      ModelConversationBudgetExceededError,
    );
    expect(() => gateway.streamConversation(configured)).toThrow(
      ModelConversationBudgetExceededError,
    );
    expect(calls).toEqual({ generate: 0, stream: 0 });
  });

  test("unknown or malformed provider token usage cannot be normalized into zero consumption", async () => {
    for (const unknownUsage of [
      undefined,
      { inputTokens: { total: undefined }, outputTokens: { total: undefined } },
      { inputTokens: { total: NaN }, outputTokens: { total: 1 } },
    ]) {
      const calls = { generate: 0, stream: 0 };
      const base = textModel("not accounted", calls);
      const model = {
        ...(base as object),
        doGenerate: async () => ({
          content: [{ type: "text", text: "not accounted" }],
          finishReason: { unified: "stop", raw: "stop" },
          warnings: [],
          usage: unknownUsage,
        }),
      } as unknown as LanguageModel;
      await expect(new ModelGateway().generateConversation(request(model))).rejects.toThrow(
        /usage/i,
      );
    }
  });

  test("models without temperature support omit it in generation and streaming", async () => {
    const calls = { generate: 0, stream: 0, temperatures: [] as (number | undefined)[] };
    const model = textModel("capability-aware response", calls);
    const gateway = new ModelGateway({
      conversationProviders: [
        {
          identity,
          model,
          temperature: 0.7,
          maxOutputTokens: 100,
          supportsTemperature: false,
          costPerInputToken: 0,
          costPerOutputToken: 0,
        },
      ],
    });
    const configuredRequest = { ...request(model), model: undefined };
    expect((await gateway.generateConversation(configuredRequest)).result.text).toBe(
      "capability-aware response",
    );
    const stream = gateway.streamConversation(configuredRequest);
    for await (const _part of stream.result.fullStream) void _part;
    await stream.metadata;
    expect(calls.temperatures).toEqual([undefined, undefined]);
  });

  test("OpenCode Go follows the model endpoint when switching API families", async () => {
    const originalFetch = globalThis.fetch;
    const requests: { url: string; headers: Headers }[] = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      return Response.json({
        id: "msg_endpoint_fixture",
        type: "message",
        role: "assistant",
        model: "qwen3.8-flash",
        content: [{ type: "text", text: "observed" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 4, output_tokens: 3 },
      });
    }) as typeof fetch;
    try {
      for (const baseUrl of [
        "https://opencode.ai/inference/go/openai/v1",
        "https://opencode.ai/zen/go/v1",
        "https://private-proxy.example/go/v1",
      ]) {
        const resolution = await createConfiguredModelResolution(
          {
            providerName: "opencode-go",
            model: "qwen3.8-flash",
            apiKey: "fixture-key",
            baseUrl,
            costPerInputToken: 0,
            costPerOutputToken: 0,
          },
          async () => ({
            "opencode-go": {
              npm: "@ai-sdk/openai-compatible",
              api: "https://opencode.ai/inference/go/openai/v1",
              models: {
                "qwen3.8-flash": {
                  npm: "@ai-sdk/anthropic",
                  api: "https://opencode.ai/inference/go/anthropic/v1",
                },
              },
            },
          }),
        );
        const result = await resolution.gateway.generateConversation(
          request(resolution.model, { providerIdentity: resolution.identity }),
        );
        expect(result.result.text).toBe("observed");
      }
      expect(requests.map((r) => r.url)).toEqual([
        "https://opencode.ai/inference/go/anthropic/v1/messages",
        "https://opencode.ai/inference/go/anthropic/v1/messages",
        "https://private-proxy.example/go/v1/messages",
      ]);
      for (const r of requests) {
        expect(r.headers.get("user-agent")).toBe("eigengrid-agent/0.1.0");
        expect(r.headers.get("x-opencode-session")).toMatch(/^[a-f0-9-]{36}$/u);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("catalog routing cannot redirect an official OpenCode Go key to another host", async () => {
    await expect(
      createConfiguredModelResolution(
        {
          providerName: "opencode-go",
          model: "qwen3.8-flash",
          apiKey: "fixture-key",
          baseUrl: "https://opencode.ai/inference/go/openai/v1",
        },
        async () => ({
          "opencode-go": {
            npm: "@ai-sdk/openai-compatible",
            models: {
              "qwen3.8-flash": {
                npm: "@ai-sdk/anthropic",
                api: "https://untrusted.example/v1",
              },
            },
          },
        }),
      ),
    ).rejects.toThrow("outside the configured provider");
  });

  test("an unavailable mixed-protocol catalog stops before guessing a provider API", async () => {
    await expect(
      createConfiguredModelResolution(
        {
          providerName: "opencode-go",
          model: "claude-haiku-5-5",
          apiKey: "fixture-key",
          baseUrl: "https://opencode.ai/zen/go/v1",
        },
        async () => {
          throw new Error("private upstream failure");
        },
      ),
    ).rejects.toThrow("OpenCode Go model catalog is unavailable");
  });

  test("returns stable identity/digest metadata and redacts before invocation", async () => {
    const calls = { generate: 0, stream: 0 };
    const gateway = new ModelGateway({ maximumRawResponseBytes: 4_096 });
    const execution = await gateway.generateConversation(
      request(textModel("boundary response", calls)),
    );

    expect(execution.result.text).toBe("boundary response");
    expect(execution.metadata.provider).toEqual(identity);
    expect(execution.metadata.requestDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(execution.metadata.responseDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(execution.metadata.redactions).toEqual([
      { path: "$.context.apiKey", reason: "sensitive_key" },
    ]);
    expect(execution.metadata.usage.calls).toBe(1);
    expect(calls.generate).toBe(1);
  });

  test("rejects an over-budget request before the provider effect", async () => {
    const calls = { generate: 0, stream: 0 };
    const gateway = new ModelGateway();

    await expect(
      gateway.generateConversation(
        request(textModel("must not run", calls), {
          budget: budget({ maximumInputTokens: 1, maximumTotalTokens: 100 }),
        }),
      ),
    ).rejects.toBeInstanceOf(ModelConversationBudgetExceededError);
    expect(calls.generate).toBe(0);
  });

  test("enforces the raw response limit on streaming output", async () => {
    const calls = { generate: 0, stream: 0 };
    const gateway = new ModelGateway({ maximumRawResponseBytes: 64 });
    const execution = gateway.streamConversation(
      request(textModel("x".repeat(512), calls), { maximumRawResponseBytes: 64 }),
    );

    await (async () => {
      for await (const part of execution.result.fullStream) void part;
    })();
    await expect(execution.metadata).rejects.toBeInstanceOf(ModelConversationResponseLimitError);
    expect(calls.stream).toBe(1);
  });

  test("bounds provider response bytes before an SDK parser can buffer them", async () => {
    const boundedFetch = createResponseBoundedFetch(4, async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("12345"));
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    });
    const response = await boundedFetch("https://fixture.invalid");

    await expect(response.text()).rejects.toBeInstanceOf(ModelConversationResponseLimitError);
  });
});
