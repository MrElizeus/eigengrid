import { describe, expect, test } from "bun:test";
import { modelVariants, assertModelVariant } from "./model-variants";
import { parseReasoningLevels } from "@eigengrid/model-gateway";
import { configureLlm, getLlmConfig } from "./llm-client";

describe("model reasoning variants", () => {
  test("uses model-specific account levels and never turns client orchestration into API effort", () => {
    const levels = parseReasoningLevels([
      { effort: "low", description: "Fast" },
      { effort: "high" },
      { effort: "ultra" },
      { effort: "high" },
    ]);
    const model = {
      id: "account-model",
      name: "Account Model",
      reasoningProtocol: "openai" as const,
      reasoningLevels: levels,
    };
    expect(
      modelVariants(model, { authMode: "chatgpt", providerName: "openai" }).map(
        (variant) => variant.id,
      ),
    ).toEqual(["default", "low", "high"]);
    expect(() =>
      assertModelVariant(model, { authMode: "chatgpt", reasoningEffort: "medium" }),
    ).toThrow("not available");
  });
  test("native OpenAI API fallback follows documented per-model capabilities", () => {
    const config = { authMode: "api-key" as const, providerName: "openai" };
    expect(
      modelVariants({ id: "gpt-6.1-sol", name: "Sol", reasoningProtocol: "openai" }, config).map(
        (v) => v.id,
      ),
    ).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
    expect(
      modelVariants({ id: "gpt-6-luna", name: "Luna", reasoningProtocol: "openai" }, config).map(
        (v) => v.id,
      ),
    ).toContain("none");
    expect(
      modelVariants(
        { id: "gpt-6.1-sol", name: "Sol", reasoningProtocol: "openai-compatible" },
        { ...config, providerName: "proxy" },
      ).map((v) => v.id),
    ).toEqual(["default"]);
    expect(
      modelVariants(
        { id: "gpt-6.1-sol", name: "Sol", reasoningProtocol: "openai", reasoningLevels: [] },
        config,
      ).map((v) => v.id),
    ).toEqual(["default"]);
  });
  test("switching model, account or API access clears the old effort", () => {
    const previous = getLlmConfig();
    try {
      configureLlm({
        model: "first",
        authMode: "chatgpt",
        chatGptProfileId: "first-account",
        reasoningEffort: "high",
      });
      configureLlm({ model: "second" });
      expect(getLlmConfig().reasoningEffort).toBeUndefined();
      configureLlm({ reasoningEffort: "high" });
      configureLlm({ chatGptProfileId: "second-account" });
      expect(getLlmConfig().reasoningEffort).toBeUndefined();
      configureLlm({ reasoningEffort: "high" });
      configureLlm({ authMode: "api-key", chatGptProfileId: undefined });
      expect(getLlmConfig().reasoningEffort).toBeUndefined();
      configureLlm({ model: "third", reasoningEffort: "low" });
      expect(getLlmConfig().reasoningEffort).toBe("low");
    } finally {
      configureLlm(previous);
    }
  });
});
