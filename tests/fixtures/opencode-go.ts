/** Public Go /models v2 shapes, trimmed to transport, pricing and capabilities. */
export const openCodeGoModels = [
  {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    capabilities: {
      tools: { supported: true },
      reasoning: { supported: true, effort: ["none", "low", "medium", "high", "xhigh", "max"] },
      temperature: false,
    },
    cost: {
      text: {
        input: {
          price: 0.1,
          cache: { read: 0.01, write: 0.125 },
          overrides: [
            { when: { context: { gt: 272000 } }, price: 0.2, cache: { read: 0.02, write: 0.25 } },
          ],
        },
        output: { price: 0.5, overrides: [{ when: { context: { gt: 272000 } }, price: 0.75 }] },
      },
    },
    api: {
      responses: {
        base_url: "https://opencode.ai/inference/go/openai/v1",
        sdk: { aisdk: "@ai-sdk/openai" },
      },
    },
  },
  {
    id: "claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    capabilities: {
      tools: { supported: true },
      reasoning: {
        supported: true,
        toggle: true,
        effort: ["low", "medium", "high", "xhigh", "max"],
      },
      temperature: false,
    },
    cost: { text: { input: { price: 0.1 }, output: { price: 0.5 } } },
    api: {
      messages: {
        base_url: "https://opencode.ai/inference/go/anthropic/v1",
        sdk: { aisdk: "@ai-sdk/anthropic" },
      },
    },
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek fixture",
    capabilities: {
      tools: { supported: true },
      reasoning: { supported: true, effort: ["high", "max"] },
    },
    cost: { text: { input: { price: 0.14 }, output: { price: 0.28 } } },
    api: {
      "chat-completions": {
        base_url: "https://opencode.ai/inference/go/openai/v1",
        sdk: { aisdk: "@ai-sdk/openai-compatible" },
      },
    },
  },
  {
    id: "minimax-m2.7",
    name: "MiniMax fixture",
    capabilities: { tools: { supported: true }, reasoning: { supported: true } },
    cost: { text: { input: { price: 0.3 }, output: { price: 1.2 } } },
    api: {
      messages: {
        base_url: "https://opencode.ai/inference/go/anthropic/v1",
        sdk: { aisdk: "@ai-sdk/anthropic" },
      },
    },
  },
];
