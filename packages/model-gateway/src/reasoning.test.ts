import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createConfiguredModelResolution } from "./configured-provider";

describe("reasoning variants at the provider boundary", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("OpenAI-compatible variants reach the wire and distinguish request provenance", async () => {
    const efforts: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      efforts.push(body.reasoning_effort);
      return Response.json({
        choices: [
          { message: { role: "assistant", content: "done" }, finish_reason: "stop", index: 0 },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      });
    }) as typeof fetch;
    const digests: string[] = [];
    for (const reasoningEffort of ["low", "high"] as const) {
      const resolved = await createConfiguredModelResolution({
        baseUrl: "https://fixture.example/v1",
        model: "fixture-model",
        providerName: "fixture.provider",
        apiKey: "fixture-key",
        reasoningEffort,
        costPerInputToken: 0,
        costPerOutputToken: 0,
      });
      const result = await resolved.gateway.generateConversation({
        providerIdentity: resolved.identity,
        messages: [{ role: "user", content: "hello" }],
        maximumSteps: 1,
        maxOutputTokens: 32,
        temperature: 0.7,
        timeoutMilliseconds: 1000,
        budget: resolved.budget,
      });
      digests.push(result.metadata.requestDigest);
    }
    expect(efforts).toEqual(["low", "high"]);
    expect(digests[0]).not.toBe(digests[1]);
  });
  test("Anthropic uses its effort field and rejects unsupported wire values", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).output_config.effort).toBe("high");
      return Response.json({
        id: "fixture",
        type: "message",
        role: "assistant",
        model: "fixture-model",
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 2 },
      });
    }) as typeof fetch;
    const options = {
      baseUrl: "https://fixture.example/v1",
      model: "fixture-model",
      providerName: "fixture",
      apiKey: "fixture-key",
      costPerInputToken: 0,
      costPerOutputToken: 0,
    };
    const catalog = async () => ({
      fixture: { npm: "@ai-sdk/anthropic", models: { "fixture-model": {} } },
    });
    const resolved = await createConfiguredModelResolution(
      { ...options, reasoningEffort: "high" },
      catalog,
    );
    await resolved.gateway.generateConversation({
      providerIdentity: resolved.identity,
      messages: [{ role: "user", content: "hello" }],
      maximumSteps: 1,
      maxOutputTokens: 32,
      temperature: 0.7,
      timeoutMilliseconds: 1000,
      budget: resolved.budget,
    });
    await expect(
      createConfiguredModelResolution({ ...options, reasoningEffort: "none" }, catalog),
    ).rejects.toThrow("cannot apply");
  });
});
