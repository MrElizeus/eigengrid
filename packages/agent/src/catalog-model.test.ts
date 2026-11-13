import { describe, expect, test } from "bun:test";
import { catalogModel } from "./catalog-model";
import { modelVariants } from "./model-variants";
import {
  parseModelReasoningLevels,
  createConfiguredModelResolution,
} from "@eigengrid/model-gateway";
import { openCodeGoModels } from "../../../tests/fixtures/opencode-go";

describe("provider model metadata", () => {
  test("bounds duration-specific cache writes including context overrides", async () => {
    const model = catalogModel("duration-cache", {
      cost: {
        text: {
          input: {
            price: 1,
            cache: { read: 0.1, write: { "5m": 1.25, "1h": 2 } },
            overrides: [{ price: 3, cache: { write: { "5m": 3.75, "1h": 6 } } }],
          },
          output: { price: 4 },
        },
      },
    });
    expect(model.cost?.cache_write).toBe(2);
    expect(model.cost?.tiers?.[0]?.cache_write).toBe(6);
    const resolved = await createConfiguredModelResolution(
      {
        providerName: "fixture",
        model: model.id,
        baseUrl: "https://example.test/v1",
        apiKey: "fixture",
      },
      async () => ({ fixture: { models: { [model.id]: model } } }),
    );
    expect(resolved.pricing).toEqual({
      costPerInputToken: 6 / 1_000_000,
      costPerOutputToken: 4 / 1_000_000,
    });
  });

  test("rejects malformed duration rates instead of silently underpricing", () => {
    for (const write of [{}, { "5m": -1 }, { "1h": "2" }, { "5m": Infinity }, [], null]) {
      expect(() =>
        catalogModel("bad", {
          cost: { text: { input: { price: 1, cache: { write } }, output: { price: 2 } } },
        }),
      ).toThrow("Invalid model catalog cache write pricing");
    }
  });

  test("reads models.dev effort controls and live v2 efforts without inventing toggle/budget levels", () => {
    expect(
      parseModelReasoningLevels({
        reasoning_options: [{ type: "effort", values: ["low", "high", "ultra"] }],
      }),
    ).toEqual([{ effort: "low" }, { effort: "high" }]);
    for (const raw of [
      { supported_reasoning_levels: [], reasoning_options: [{ type: "effort", values: ["high"] }] },
      { capabilities: { reasoning: { supported: false, effort: ["high"] } } },
      { capabilities: { reasoning: { supported: true, effort: [] } } },
      { capabilities: { reasoning: { supported: true, toggle: true, budget: { max: 10000 } } } },
      { reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", max: 10000 }] },
    ])
      expect(parseModelReasoningLevels(raw)).toEqual([]);
    expect(parseModelReasoningLevels({ reasoning: true })).toBeUndefined();
  });

  test("live explicit capabilities override stale directory variants and tool support", () => {
    const model = catalogModel(
      "fixture",
      {
        capabilities: { reasoning: { supported: false }, tools: { supported: false } },
      },
      { reasoningLevels: [{ effort: "high" }], toolCall: true },
    );
    expect(model.reasoningLevels).toEqual([]);
    expect(model.toolCall).toBe(false);
  });

  test("Luna exposes all advertised efforts through Go, preserving the Responses protocol and price tiers", async () => {
    const model = catalogModel("gpt-6-luna", openCodeGoModels[0]);
    expect(model.npm).toBe("@ai-sdk/openai");
    expect(model.temperature).toBe(false);
    expect(
      modelVariants(
        { ...model, name: model.name!, reasoningProtocol: "openai" },
        { providerName: "opencode-go" },
      ).map((v) => v.id),
    ).toEqual(["default", "none", "low", "medium", "high", "xhigh", "max"]);
    const resolved = await createConfiguredModelResolution(
      {
        providerName: "opencode-go",
        model: model.id,
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "fixture-key",
      },
      async () => ({ "opencode-go": { models: { [model.id]: model } } }),
    );
    expect(resolved.pricing).toEqual({
      costPerInputToken: 0.25 / 1_000_000,
      costPerOutputToken: 0.75 / 1_000_000,
    });
  });
});
