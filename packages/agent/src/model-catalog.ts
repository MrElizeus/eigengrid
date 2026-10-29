/**
 * Model Catalog — fetches and caches the opencode model registry.
 *
 * Same catalog opencode uses: https://models.dev/api.json
 * Each provider has models with metadata, API URLs, and configuration.
 */

import {
  parseReasoningLevels,
  type ReasoningLevel,
  type ModelCatalogCost,
} from "@eigengrid/model-gateway";

const CATALOG_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 5 * 60 * 1_000;
const CATALOG_TIMEOUT_MS = 5_000;

export interface CatalogProvider {
  id: string;
  name: string;
  api: string;
  env?: string[];
  npm?: string;
  models: Record<string, CatalogModel>;
}

export interface CatalogModel {
  id: string;
  name?: string;
  family?: string;
  description?: string;
  context?: number;
  maxOutput?: number;
  price?: { input?: number; output?: number };
  npm?: string;
  api?: string;
  temperature?: boolean;
  outputModalities?: string[];
  cost?: ModelCatalogCost;
  status?: string;
  toolCall?: boolean;
  reasoningLevels?: ReasoningLevel[];
}

/** Operator models must support conversation and tools, rather than other API tasks. */
export function isConversationalModel(model: CatalogModel): boolean {
  if (
    model.toolCall === false ||
    ["deprecated", "retired", "disabled", "legacy"].includes(model.status ?? "")
  )
    return false;
  if (model.outputModalities && !model.outputModalities.includes("text")) return false;
  if (model.family && /embedding|rerank/i.test(model.family)) return false;
  return !/(?:^|[/:_-])(?:embedding|embeddings|realtime|image|images|tts|whisper|moderation|transcribe|transcription|audio)(?:[/:_-]|$)/i.test(
    model.id,
  );
}

let cachedCatalog: Record<string, CatalogProvider> | null = null;
let lastFetch = 0;

/**
 * Fetch and cache the model catalog from models.dev.
 */
export async function fetchCatalog(opts?: {
  signal?: AbortSignal;
  force?: boolean;
}): Promise<Record<string, CatalogProvider>> {
  const now = Date.now();
  if (!opts?.force && cachedCatalog && now - lastFetch < CACHE_TTL_MS) {
    return cachedCatalog;
  }

  const deadline = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
  const signal = opts?.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  const response = await fetch(CATALOG_URL, { signal });
  if (!response.ok) {
    throw new Error(`Catalog fetch failed: ${response.status}`);
  }

  const raw = (await response.json()) as Record<string, unknown>;
  const providers: Record<string, CatalogProvider> = {};

  for (const [id, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    const p = value as Record<string, unknown>;
    if (!p.name || !p.models || typeof p.models !== "object") continue;

    const providerNpm = p.npm ? String(p.npm) : undefined;
    const providerApi = p.api ? String(p.api) : "";

    providers[id] = {
      id,
      name: String(p.name ?? id),
      api: providerApi,
      env: Array.isArray(p.env) ? p.env.map(String) : undefined,
      npm: providerNpm,
      models: {},
    };

    for (const [mid, mval] of Object.entries(p.models as Record<string, unknown>)) {
      if (!mval || typeof mval !== "object") continue;
      const m = mval as Record<string, unknown>;

      const mProvider =
        m.provider && typeof m.provider === "object"
          ? (m.provider as Record<string, unknown>)
          : null;
      const modelNpm = mProvider?.npm ? String(mProvider.npm) : providerNpm;
      const modelApi = mProvider?.api ? String(mProvider.api) : providerApi;

      providers[id].models[mid] = {
        id: mid,
        name: m.name ? String(m.name) : mid,
        family: m.family ? String(m.family) : undefined,
        description: m.description ? String(m.description) : undefined,
        context: typeof m.context === "number" ? m.context : undefined,
        maxOutput: typeof m.maxOutput === "number" ? m.maxOutput : undefined,
        npm: modelNpm,
        api: modelApi,
        temperature: typeof m.temperature === "boolean" ? m.temperature : undefined,
        status: typeof m.status === "string" ? m.status : undefined,
        toolCall: typeof m.tool_call === "boolean" ? m.tool_call : undefined,
        reasoningLevels: parseReasoningLevels(m.supported_reasoning_levels),
        outputModalities:
          m.modalities &&
          typeof m.modalities === "object" &&
          Array.isArray((m.modalities as { output?: unknown }).output)
            ? (m.modalities as { output: unknown[] }).output.filter(
                (value): value is string => typeof value === "string",
              )
            : undefined,
        cost: m.cost === undefined ? undefined : (m.cost as ModelCatalogCost),
      };
    }
  }

  cachedCatalog = providers;
  lastFetch = now;
  return providers;
}

/**
 * Get a specific provider by ID.
 */
export async function getProvider(
  providerId: string,
  opts?: { signal?: AbortSignal },
): Promise<CatalogProvider | undefined> {
  const catalog = await fetchCatalog(opts);
  return catalog[providerId];
}

/**
 * Get the default env var name for a provider's API key.
 */
export function getProviderEnvKey(provider: CatalogProvider): string | undefined {
  if (provider.env && provider.env.length > 0) {
    return provider.env[0];
  }
  return undefined;
}

/**
 * Format a provider summary for display.
 */
const PRIORITY_PROVIDERS = [
  "opencode-go",
  "opencode-zen",
  "openai",
  "anthropic",
  "deepseek",
  "google",
  "mistral",
  "cohere",
  "groq",
  "ollama",
  "perplexity",
];

export function formatProviderSummary(providers: Record<string, CatalogProvider>): string {
  const lines = ["Providers from models.dev (access not tested):"];
  const allProviders = Object.values(providers);

  const top: CatalogProvider[] = [];
  const others: CatalogProvider[] = [];

  for (const p of allProviders) {
    if (PRIORITY_PROVIDERS.includes(p.id)) {
      top.push(p);
    } else {
      others.push(p);
    }
  }

  top.sort((a, b) => PRIORITY_PROVIDERS.indexOf(a.id) - PRIORITY_PROVIDERS.indexOf(b.id));

  for (const p of top) {
    const modelCount = Object.keys(p.models).length;
    const envKey = getProviderEnvKey(p);
    const keyHint = envKey ? ` (${envKey})` : "";
    lines.push(`  ${p.id.padEnd(22)} ${p.name.padEnd(30)} ${modelCount} models${keyHint}`);
  }

  if (others.length > 0) {
    lines.push("");
    for (const p of others.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(
        `  ${p.id.padEnd(22)} ${p.name.padEnd(30)} ${Object.keys(p.models).length} models`,
      );
    }
  }

  lines.push("");
  lines.push("Use '/connect search <query>' to find others, or '/connect <id>' to select.");
  return lines.join("\n");
}

/**
 * Format model list for a provider.
 */
export function formatProviderModels(provider: CatalogProvider): string {
  const lines: string[] = [];
  lines.push(`Provider: ${provider.name} (${provider.id})`);
  lines.push(`Endpoint: ${provider.api}`);
  if (provider.env) lines.push(`API Key env: ${provider.env.join(", ")}`);
  lines.push("");

  const sorted = Object.values(provider.models).sort((a, b) =>
    (a.name ?? a.id).localeCompare(b.name ?? b.id),
  );

  for (const m of sorted) {
    const ctx = m.context ? ` | ${(m.context / 1000).toFixed(0)}K ctx` : "";
    const price = m.price
      ? ` | $${m.price.input?.toFixed(2) ?? "?"}i/$${m.price.output?.toFixed(2) ?? "?"}o`
      : "";
    lines.push(`  ${m.id.padEnd(30)} ${m.name?.padEnd(25) ?? ""}${ctx}${price}`);
  }

  lines.push("");
  lines.push("Use '/model set model <model-id>' to select one.");
  return lines.join("\n");
}
