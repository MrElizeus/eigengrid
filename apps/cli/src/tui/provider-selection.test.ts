import { describe, expect, it } from "bun:test";

import {
  buildProviderSelectionText,
  filterProviders,
  sortProviders,
  parseOperatorModelSetting,
  selectableProviders,
} from "./provider-selection";

describe("provider-selection helpers", () => {
  it("accepts explicit free pricing and rejects malformed or unknown settings", () => {
    expect(parseOperatorModelSetting("costPerInputToken", "0")).toEqual({ costPerInputToken: 0 });
    expect(parseOperatorModelSetting("costPerOutputToken", "0.000002")).toEqual({
      costPerOutputToken: 0.000002,
    });
    for (const value of ["NaN", "Infinity", "-1", ""])
      expect(() => parseOperatorModelSetting("costPerInputToken", value)).toThrow();
    for (const value of ["0", "1.5"])
      expect(() => parseOperatorModelSetting("maxTokens", value)).toThrow();
    expect(() => parseOperatorModelSetting("arbitraryPolicy", "allow")).toThrow();
  });
  const providers = [
    {
      id: "beta",
      name: "Beta Cloud",
      api: "https://beta.example/v1",
      models: {
        "beta-small": { id: "beta-small", name: "Small" },
      },
    },
    {
      id: "alpha",
      name: "Alpha Lab",
      api: "https://alpha.example/v1",
      models: {
        "alpha-pro": { id: "alpha-pro", name: "Pro" },
      },
    },
  ] as const;

  it("sorts providers by name then id", () => {
    const sorted = sortProviders([...providers]);
    expect(sorted.map((provider) => provider.id)).toEqual(["alpha", "beta"]);
  });

  it("puts common providers before the alphabetical directory", () => {
    const sorted = sortProviders([...providers, { ...providers[0], id: "openai", name: "OpenAI" }]);
    expect(sorted.map((provider) => provider.id)).toEqual(["openai", "alpha", "beta"]);
  });

  it("keeps official OpenAI and Anthropic entries whose native SDK supplies the endpoint", () => {
    const selected = selectableProviders([
      {
        id: "openai",
        name: "OpenAI",
        api: "",
        npm: "@ai-sdk/openai",
        models: {
          "gpt-realtime": { id: "gpt-realtime" },
          "text-embedding-3-large": { id: "text-embedding-3-large", family: "text-embedding" },
          chat: { id: "chat", api: "" },
        },
      },
      {
        id: "anthropic",
        name: "Anthropic",
        api: "",
        npm: "@ai-sdk/anthropic",
        models: { chat: { id: "chat" } },
      },
      {
        id: "other",
        name: "Other",
        api: "",
        npm: "@ai-sdk/openai",
        models: { chat: { id: "chat" } },
      },
    ]);
    expect(selected.map((p) => p.id)).toEqual(["openai", "anthropic"]);
    expect(selected[0].api).toBe("https://api.openai.com/v1");
    expect(Object.keys(selected[0].models)).toEqual(["chat"]);
    expect(selected[0].models.chat.api).toBe("https://api.openai.com/v1");
    expect(selected[1].api).toBe("https://api.anthropic.com/v1");
    expect(selected[1].models.chat.api).toBe("https://api.anthropic.com/v1");
  });

  it("lists only usable endpoints and supported models, including mixed providers", () => {
    const mixed = {
      id: "mixed",
      name: "Mixed",
      api: "",
      npm: "@ai-sdk/google",
      models: {
        unsupported: { id: "unsupported", api: "https://example.com/v1" },
        audio: {
          id: "audio",
          npm: "@ai-sdk/openai",
          api: "https://example.com/v1",
          outputModalities: ["audio"],
        },
        supported: { id: "supported", npm: "@ai-sdk/anthropic", api: "https://example.com/v1" },
        missing: { id: "missing", npm: "@ai-sdk/openai" },
        template: { id: "template", npm: "@ai-sdk/openai", api: "https://{tenant}.example.com/v1" },
        invalid: { id: "invalid", npm: "@ai-sdk/openai", api: "file:///tmp/provider" },
      },
    };
    const selected = selectableProviders([
      ...providers,
      mixed,
      { ...providers[0], id: "unsupported", npm: "@ai-sdk/google" },
      { ...providers[0], id: "empty", models: {} },
    ]);
    expect(selected.map((p) => p.id)).toEqual(["beta", "alpha", "mixed"]);
    expect(Object.keys(selected[2].models)).toEqual(["supported"]);
    expect(Object.keys(mixed.models)).toHaveLength(6);
  });

  it("filters providers by id, name, and model text", () => {
    expect(filterProviders([...providers], "alp").map((provider) => provider.id)).toEqual([
      "alpha",
    ]);
    expect(filterProviders([...providers], "beta cloud").map((provider) => provider.id)).toEqual([
      "beta",
    ]);
    expect(filterProviders([...providers], "small").map((provider) => provider.id)).toEqual([
      "beta",
    ]);
  });

  it("builds the same selection summary text used by the picker", () => {
    const text = buildProviderSelectionText(providers[0]);
    expect(text).toContain("Provider: Beta Cloud (beta)");
    expect(text).toContain("Endpoint: https://beta.example/v1");
    expect(text).toContain("Default model: beta-small");
    expect(text).toContain("beta-small");
  });
});
