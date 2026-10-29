import { describe, it, expect } from "bun:test";

describe("llm-client", () => {
  it("does not reuse free-model tariffs after changing provider, endpoint or model", async () => {
    const mod = await import("./llm-client");
    const original = mod.getLlmConfig();
    try {
      for (const change of [
        { providerName: "paid" },
        { model: "paid-model" },
        { baseUrl: "https://paid.example/v1" },
      ]) {
        mod.configureLlm({
          baseUrl: "http://localhost/v1",
          providerName: "free",
          model: "free-model",
          costPerInputToken: 0,
          costPerOutputToken: 0,
        });
        mod.configureLlm(change);
        expect(mod.getLlmConfig().costPerInputToken).toBeUndefined();
        expect(mod.getLlmConfig().costPerOutputToken).toBeUndefined();
      }
    } finally {
      mod.configureLlm({
        ...original,
        costPerInputToken: original.costPerInputToken,
        costPerOutputToken: original.costPerOutputToken,
      });
    }
  });
  it("exports configureLlm, getLlmConfig, chatCompletion, chatStream", async () => {
    const mod = await import("./llm-client");
    expect(typeof mod.configureLlm).toBe("function");
    expect(typeof mod.getLlmConfig).toBe("function");
    expect(typeof mod.chatCompletion).toBe("function");
    expect(typeof mod.chatStream).toBe("function");
  });

  it("getLlmConfig returns a systemPrompt that references EigenGrid Operator", async () => {
    const mod = await import("./llm-client");
    const config = mod.getLlmConfig();
    expect(config.systemPrompt).toBeDefined();
    // After P6-S07c, the prompt should reference the Operator identity
    expect(config.systemPrompt).toContain("EigenGrid");
  });
});
