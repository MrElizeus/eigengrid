import { isConversationalModel, type CatalogProvider } from "@eigengrid/agent";
import type { LlmConfig } from "@eigengrid/agent";
import type { ReasoningEffort } from "@eigengrid/agent";
import { isSupportedProviderAdapter } from "@eigengrid/model-gateway";

/** Keep model-level protocol/endpoint overrides; mixed providers may be partially supported. */
export function selectableProvider(provider: CatalogProvider): CatalogProvider | undefined {
  const models = Object.fromEntries(
    Object.entries(provider.models).flatMap(([id, model]) => {
      const adapter = model.npm ?? provider.npm;
      if (!isSupportedProviderAdapter(adapter)) return [];
      if (!isConversationalModel(model)) return [];
      // Official native SDKs omit their default endpoints from models.dev.
      const defaultEndpoint =
        provider.id === "openai" && adapter === "@ai-sdk/openai"
          ? "https://api.openai.com/v1"
          : provider.id === "anthropic" && adapter === "@ai-sdk/anthropic"
            ? "https://api.anthropic.com/v1"
            : undefined;
      const endpoint = model.api || provider.api || defaultEndpoint;
      if (!endpoint || /[{}]/.test(endpoint)) return [];
      try {
        const url = new URL(endpoint);
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return [];
        return [[id, { ...model, api: endpoint }]];
      } catch {
        return [];
      }
    }),
  );
  if (!Object.keys(models).length) return undefined;
  return { ...provider, api: provider.api || Object.values(models)[0].api!, models };
}

export function selectableProviders(providers: CatalogProvider[]): CatalogProvider[] {
  return providers.flatMap((provider) => {
    const selected = selectableProvider(provider);
    return selected ? [selected] : [];
  });
}

export function parseOperatorModelSetting(key: string, value: string): Partial<LlmConfig> {
  const keys = [
    "baseUrl",
    "model",
    "apiKey",
    "temperature",
    "maxTokens",
    "costPerInputToken",
    "costPerOutputToken",
  ];
  if (!keys.includes(key)) throw new Error(`Supported model settings: ${keys.join(", ")}`);
  if (["temperature", "maxTokens", "costPerInputToken", "costPerOutputToken"].includes(key)) {
    const numeric = Number(value);
    if (
      !value.trim() ||
      !Number.isFinite(numeric) ||
      numeric < 0 ||
      (key === "temperature" && numeric > 2) ||
      (key === "maxTokens" && (!Number.isSafeInteger(numeric) || numeric < 1))
    )
      throw new Error(`${key} requires a valid finite numeric value`);
    return { [key]: numeric };
  }
  if (!value.trim()) throw new Error(`${key} requires a value`);
  return { [key]: value };
}

export function sortProviders(providers: CatalogProvider[]): CatalogProvider[] {
  const popular = ["opencode-go", "opencode", "opencode-zen", "openai", "anthropic", "deepseek"];
  const rank = (id: string) => (popular.includes(id) ? popular.indexOf(id) : popular.length);
  return [...providers].sort(
    (a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

export function filterProviders(providers: CatalogProvider[], query: string): CatalogProvider[] {
  const search = query.trim().toLowerCase();
  if (!search) return providers;

  return providers.filter((provider) => {
    const modelText = Object.values(provider.models)
      .map((model) => `${model.id} ${model.name ?? ""}`.trim())
      .join(" ");
    const haystack = `${provider.id} ${provider.name} ${modelText}`.toLowerCase();
    return haystack.includes(search);
  });
}

export function buildProviderSelectionText(provider: CatalogProvider): string {
  const firstModel = Object.keys(provider.models)[0] ?? "none";
  return [
    `Provider: ${provider.name} (${provider.id})`,
    `Endpoint: ${provider.api}`,
    `Default model: ${firstModel}`,
    "Configuration saved; connection not tested. Use /key to set your key, then send a prompt to verify access.",
    "Use /models after authentication to query the provider's current model list.",
  ].join("\n");
}

export async function selectProvider(provider: CatalogProvider): Promise<string> {
  const selectable = selectableProvider(provider);
  if (!selectable)
    throw new Error(`Provider '${provider.id}' has no supported models with a usable endpoint.`);
  provider = selectable;
  const { configureLlm, getLlmConfig, saveLlmConfig } = await import("@eigengrid/agent");
  configureLlm({
    authMode: "api-key",
    chatGptProfileId: undefined,
    // A saved credential belongs to the selected provider, not to the next one.
    apiKey: getLlmConfig().providerName === provider.id ? getLlmConfig().apiKey : undefined,
    baseUrl: provider.api || Object.values(provider.models)[0].api!,
    providerName: provider.id,
    model: Object.keys(provider.models)[0] ?? "unknown",
  });
  saveLlmConfig(getLlmConfig());
  return buildProviderSelectionText(provider);
}

/** Activate a verified account before model discovery, so a retry never reverts to API mode. */
export async function selectChatGptAccount(
  profileId: string,
  model?: string,
  reasoningEffort?: ReasoningEffort,
): Promise<void> {
  const { ChatGptAuth, CHATGPT_RESOURCE, configureLlm, getLlmConfig, saveLlmConfig } =
    await import("@eigengrid/agent");
  const auth = new ChatGptAuth();
  const account = auth.accounts().find((value) => value.id === profileId);
  if (!account?.connected || !account.sharing)
    throw new Error("Select a connected ChatGPT account with plan permission.");
  if (model !== undefined) {
    const { assertModelVariant } = await import("@eigengrid/agent");
    const selected = (await auth.models(profileId)).find((value) => value.id === model);
    if (!selected) throw new Error("Choose a model from the selected ChatGPT account.");
    assertModelVariant(selected, { authMode: "chatgpt", providerName: "openai", reasoningEffort });
  }
  const previous = getLlmConfig();
  try {
    configureLlm({
      authMode: "chatgpt",
      chatGptProfileId: profileId,
      providerName: "openai",
      baseUrl: CHATGPT_RESOURCE,
      model: model ?? previous.model,
      ...(model !== undefined ? { reasoningEffort } : {}),
      apiKey: undefined,
      costPerInputToken: undefined,
      costPerOutputToken: undefined,
    });
    saveLlmConfig(getLlmConfig());
  } catch (error) {
    configureLlm(previous);
    throw error;
  }
}
