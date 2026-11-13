import { parseModelReasoningLevels, type ModelCatalogCost } from "@eigengrid/model-gateway";
import type { CatalogModel } from "./model-catalog";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Duration-keyed cache writes are alternate prices, not additive charges. */
function cacheWriteRate(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const values =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.values(value)
      : [value];
  if (
    values.length === 0 ||
    values.some((rate) => typeof rate !== "number" || !Number.isFinite(rate) || rate < 0)
  )
    throw new Error(
      "Invalid model catalog cache write pricing: expected nonnegative rates by duration",
    );
  return Math.max(...(values as number[]));
}

function rates(value: unknown, output = false): ModelCatalogCost {
  const rate = record(value);
  const cache = record(rate.cache);
  return output
    ? { output: rate.price as number | undefined }
    : {
        input: rate.price as number | undefined,
        cache_read: cache.read as number | undefined,
        cache_write: cacheWriteRate(cache.write),
      };
}

/** Preserve all published context/cache price tiers for conservative gateway accounting. */
function costMetadata(value: unknown): ModelCatalogCost | undefined {
  if (value === undefined) return undefined;
  const cost = record(value);
  if (!cost.text) return value as ModelCatalogCost;
  // Conditional multipliers need their own accounting contract; never underprice them.
  if (cost.multipliers !== undefined) return undefined;
  const text = record(cost.text),
    input = record(text.input),
    output = record(text.output);
  return {
    ...rates(input),
    ...rates(output, true),
    tiers: [
      ...(Array.isArray(input.overrides) ? input.overrides.map((rate) => rates(rate)) : []),
      ...(Array.isArray(output.overrides) ? output.overrides.map((rate) => rates(rate, true)) : []),
    ],
  };
}

/** Normalize both directory entries and the provider's richer live v2 model metadata. */
export function catalogModel(
  id: string,
  raw: Record<string, unknown>,
  fallback?: Partial<CatalogModel>,
): CatalogModel {
  const provider = record(raw.provider),
    capabilities = record(raw.capabilities);
  const tools = record(capabilities.tools),
    limit = record(raw.limit);
  const apis = record(raw.api);
  const supported = [
    ["responses", "@ai-sdk/openai"],
    ["messages", "@ai-sdk/anthropic"],
    ["chat-completions", "@ai-sdk/openai-compatible"],
  ] as const;
  const route = supported.find(([key, npm]) => record(record(apis[key]).sdk).aisdk === npm);
  const api = route ? record(apis[route[0]]) : undefined;
  const output = record(raw.modalities).output;
  const shutdown = typeof raw.shutdown_date === "string" ? Date.parse(raw.shutdown_date) : NaN;
  return {
    ...fallback,
    id,
    name:
      typeof raw.display_name === "string"
        ? raw.display_name
        : typeof raw.name === "string"
          ? raw.name
          : (fallback?.name ?? id),
    family: typeof raw.family === "string" ? raw.family : fallback?.family,
    description: typeof raw.description === "string" ? raw.description : fallback?.description,
    context:
      typeof limit.context === "number"
        ? limit.context
        : typeof raw.context === "number"
          ? raw.context
          : fallback?.context,
    maxOutput:
      typeof limit.output === "number"
        ? limit.output
        : typeof raw.maxOutput === "number"
          ? raw.maxOutput
          : fallback?.maxOutput,
    npm:
      route?.[1] ??
      (raw.api && typeof raw.api === "object"
        ? "unsupported"
        : typeof provider.npm === "string"
          ? provider.npm
          : fallback?.npm),
    api:
      typeof api?.base_url === "string"
        ? api.base_url
        : typeof provider.api === "string"
          ? provider.api
          : fallback?.api,
    temperature:
      typeof capabilities.temperature === "boolean"
        ? capabilities.temperature
        : typeof raw.temperature === "boolean"
          ? raw.temperature
          : fallback?.temperature,
    toolCall:
      typeof tools.supported === "boolean"
        ? tools.supported
        : typeof raw.tool_call === "boolean"
          ? raw.tool_call
          : fallback?.toolCall,
    status:
      Number.isFinite(shutdown) && shutdown <= Date.now()
        ? "retired"
        : typeof raw.lifecycle === "string"
          ? raw.lifecycle === "active"
            ? "active"
            : "disabled"
          : typeof raw.status === "string"
            ? raw.status
            : fallback?.status,
    outputModalities: Array.isArray(output)
      ? output.filter((v): v is string => typeof v === "string")
      : fallback?.outputModalities,
    reasoningLevels: parseModelReasoningLevels(raw) ?? fallback?.reasoningLevels,
    cost: raw.cost === undefined ? fallback?.cost : costMetadata(raw.cost),
  };
}
