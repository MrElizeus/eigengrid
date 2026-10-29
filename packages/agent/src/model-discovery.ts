import {
  isSupportedProviderAdapter,
  resolveProviderApiKey,
  parseReasoningLevels,
  isReasoningEffort,
  type ReasoningEffort,
} from "@eigengrid/model-gateway";
import { ChatGptAuth, type ChatGptModel } from "./chatgpt-auth";
import { fetchCatalog, isConversationalModel, type CatalogProvider } from "./model-catalog";
import { getLlmConfig, type LlmConfig } from "./llm-client";
import { configureLlm } from "./llm-client";
import { saveLlmConfig, loadLlmConfig } from "./llm-config-store";
import { assertModelVariant, modelVariants } from "./model-variants";

export interface DiscoveredModels {
  authMode: "api-key" | "chatgpt";
  provider: string;
  source: string;
  account?: string;
  models: ChatGptModel[];
  excluded: number;
}

export class ModelConnectionRequiredError extends Error {
  constructor(
    readonly providerId: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ModelConnectionRequiredError";
  }
}

async function readCatalog(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      response.status === 404 || response.status === 405
        ? "This provider does not expose a live model list at the configured endpoint. Reconnect or check /endpoint."
        : `The provider could not list models (HTTP ${response.status}). Check this API credential and retry.`,
    );
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader)
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Provider model catalog exceeded the 8 MiB response limit");
      }
      chunks.push(next.value);
    }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("The provider returned an invalid model catalog");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The provider returned an invalid model catalog");
  return value as Record<string, unknown>;
}

/** Live, credential-scoped availability. models.dev supplies metadata only. */
export async function discoverConfiguredModels(
  providedConfig: LlmConfig | undefined = undefined,
  options: {
    fetch?: typeof fetch;
    catalog?: () => Promise<Record<string, CatalogProvider>>;
    chatGpt?: ChatGptAuth;
    signal?: AbortSignal;
  } = {},
): Promise<DiscoveredModels> {
  if (!providedConfig) loadLlmConfig();
  const config = providedConfig ?? getLlmConfig();
  if (config.authMode === "chatgpt") {
    if (config.providerName !== "openai" || config.baseUrl !== "https://api.openai.com/v1")
      throw new ModelConnectionRequiredError(
        "openai",
        "Reconnect OpenAI to use the selected ChatGPT account.",
      );
    if (!config.chatGptProfileId)
      throw new ModelConnectionRequiredError(
        "openai",
        "Choose a ChatGPT account through /connect.",
      );
    const auth = options.chatGpt ?? new ChatGptAuth();
    const account = auth.accounts().find((a) => a.id === config.chatGptProfileId);
    if (!account?.connected || !account.sharing)
      throw new ModelConnectionRequiredError(
        "openai",
        "This ChatGPT account needs sign-in or plan permission. Continue with ChatGPT through /connect.",
      );
    const available = await auth.models(account.id);
    const models = available.filter((model) => isConversationalModel(model));
    return {
      authMode: "chatgpt",
      provider: "OpenAI",
      source: "ChatGPT account",
      account: account.label,
      models,
      excluded: available.length - models.length,
    };
  }

  const catalog = await (options.catalog ?? fetchCatalog)().catch(
    () => ({}) as Record<string, CatalogProvider>,
  );
  const provider = config.providerName ? catalog[config.providerName] : undefined;
  const providerId = config.providerName === "eigengrid-llm" ? "openai" : config.providerName;
  const adapter =
    provider?.npm ??
    (providerId === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible");
  if (!isSupportedProviderAdapter(adapter))
    throw new Error(
      "This provider integration is not implemented. Choose another provider through /connect.",
    );
  const key = resolveProviderApiKey(
    { ...config, providerName: providerId },
    provider ?? { npm: adapter },
  );
  let endpoint: URL;
  try {
    endpoint = new URL(config.baseUrl.replace(/\/+$/, "") + "/models");
  } catch {
    throw new Error("The configured provider endpoint is invalid");
  }
  if (
    !["https:", "http:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("The configured provider endpoint is invalid");
  if (!key && !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
    throw new ModelConnectionRequiredError(
      providerId,
      "Current access: API key. No API credential is configured. Choose an access method through /connect; a saved ChatGPT account is separate.",
    );
  const headers: Record<string, string> = !key
    ? {}
    : adapter === "@ai-sdk/anthropic"
      ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${key}` };
  const models: ChatGptModel[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let excluded = 0;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
    : AbortSignal.timeout(15_000);
  for (let page = 0; page < 100; page++) {
    const data = await readCatalog(
      await (options.fetch ?? globalThis.fetch)(endpoint, { headers, redirect: "error", signal }),
    );
    if (!Array.isArray(data.data))
      throw new Error(
        "The provider did not return an API model catalog. Check the selected authentication method.",
      );
    for (const value of data.data) {
      if (!value || typeof value !== "object") continue;
      const remote = value as Record<string, unknown>;
      if (
        typeof remote.id !== "string" ||
        !remote.id ||
        remote.id.length > 1024 ||
        seen.has(remote.id)
      )
        continue;
      seen.add(remote.id);
      if (seen.size > 10_000)
        throw new Error("Provider model catalog exceeded the permitted model count");
      const metadata = provider?.models[remote.id];
      const status =
        typeof remote.lifecycle === "string"
          ? remote.lifecycle
          : typeof remote.status === "string"
            ? remote.status
            : metadata?.status;
      const shutdown =
        typeof remote.shutdown_date === "string" ? Date.parse(remote.shutdown_date) : NaN;
      if (
        (Number.isFinite(shutdown) && shutdown <= Date.now()) ||
        (typeof remote.lifecycle === "string" && remote.lifecycle !== "active") ||
        !isConversationalModel({ ...metadata, id: remote.id, status }) ||
        (metadata?.npm && !isSupportedProviderAdapter(metadata.npm))
      ) {
        excluded++;
        continue;
      }
      models.push({
        id: remote.id,
        name:
          typeof remote.display_name === "string"
            ? remote.display_name
            : typeof remote.name === "string"
              ? remote.name
              : (metadata?.name ?? remote.id),
        reasoningLevels:
          parseReasoningLevels(remote.supported_reasoning_levels) ?? metadata?.reasoningLevels,
        reasoningProtocol:
          (metadata?.npm ?? adapter) === "@ai-sdk/openai"
            ? "openai"
            : (metadata?.npm ?? adapter) === "@ai-sdk/anthropic"
              ? "anthropic"
              : "openai-compatible",
      });
    }
    if (!data.has_more)
      return {
        authMode: "api-key",
        provider: provider?.name ?? providerId ?? "Configured provider",
        source: endpoint.origin + endpoint.pathname,
        models,
        excluded,
      };
    if (typeof data.last_id !== "string" || !data.last_id || cursors.has(data.last_id))
      throw new Error("The provider returned an invalid model pagination cursor");
    cursors.add(data.last_id);
    endpoint.searchParams.set("after_id", data.last_id);
  }
  throw new Error("Provider model catalog pagination exceeded the permitted limit");
}

export async function selectConfiguredModel(
  id: string,
  reasoningEffort?: ReasoningEffort,
): Promise<ChatGptModel> {
  const catalog = await discoverConfiguredModels();
  const selected = catalog.models.find((model) => model.id === id);
  if (!selected)
    throw new Error(
      "This model is not exposed as an active conversational model for the selected account or API credential.",
    );
  const previous = getLlmConfig();
  assertModelVariant(selected, { ...previous, reasoningEffort });
  try {
    configureLlm({ model: selected.id, reasoningEffort });
    saveLlmConfig(getLlmConfig());
  } catch (error) {
    configureLlm(previous);
    throw error;
  }
  return selected;
}

export async function configuredModelVariants(modelId?: string) {
  const catalog = await discoverConfiguredModels();
  const config = getLlmConfig();
  const model = catalog.models.find((value) => value.id === (modelId ?? config.model));
  if (!model)
    throw new Error(
      "Choose a model available to this account or API credential through /models first.",
    );
  return { model, variants: modelVariants(model, config), catalog };
}

export async function selectConfiguredVariant(id: string): Promise<ChatGptModel> {
  if (id !== "default" && !isReasoningEffort(id))
    throw new Error("Unknown reasoning variant. Use /variants to see the available options.");
  return selectConfiguredModel(getLlmConfig().model, id === "default" ? undefined : id);
}
