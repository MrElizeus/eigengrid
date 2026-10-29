import type { LanguageModel } from "ai";
import { isReasoningEffort, type ReasoningEffort } from "./reasoning";
import { randomUUID } from "node:crypto";
import {
  ModelConversationResponseLimitError,
  ModelConversationPricingUnavailableError,
  ModelGateway,
  ModelProviderIdentitySchema,
  type ModelConversationBudget,
  type ModelProviderIdentity,
  type ModelConversationPricing,
} from "./model-gateway";

export interface ModelCatalogModel {
  npm?: string;
  api?: string;
  temperature?: boolean;
  cost?: ModelCatalogCost;
}

/** Catalog prices are per million tokens; all context/cache tiers are bounded. */
export interface ModelCatalogCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  tiers?: ModelCatalogCost[];
}

export interface ModelCatalogProvider {
  npm?: string;
  api?: string;
  env?: string[];
  models: Record<string, ModelCatalogModel>;
}

export type ModelCatalogLoader = () => Promise<Record<string, ModelCatalogProvider>>;

export interface ConfiguredModelOptions {
  reasoningEffort?: ReasoningEffort;
  baseUrl: string;
  model: string;
  apiKey?: string;
  providerName?: string;
  providerVersion?: string;
  modelRevision?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMilliseconds?: number;
  maximumRawResponseBytes?: number;
  maximumInputTokens?: number;
  maximumOutputTokens?: number;
  maximumTotalTokens?: number;
  maximumCost?: number;
  costPerInputToken?: number;
  costPerOutputToken?: number;
  /** Stable identifier used by providers that route and cache per conversation. */
  sessionId?: string;
  /** Explicit client identity for providers that reject generic SDK user agents. */
  clientUserAgent?: string;
  /** Authenticated transports can require streaming even for a collected response. */
  streamOnly?: boolean;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export interface ConfiguredModelResolution {
  gateway: ModelGateway;
  model: LanguageModel;
  identity: ModelProviderIdentity;
  temperature: number;
  maxTokens: number;
  timeoutMilliseconds: number;
  maximumRawResponseBytes: number;
  budget: ModelConversationBudget;
  pricing: ModelConversationPricing;
}

interface ProviderMetadata {
  npm: string;
  env?: string[];
  api?: string;
  providerApi?: string;
  supportsTemperature?: boolean;
  cost?: ModelCatalogCost;
}

function catalogPricing(cost: ModelCatalogCost | undefined): Partial<ModelConversationPricing> {
  if (cost === undefined) return {};
  const inputs: number[] = [],
    outputs: number[] = [];
  const visit = (value: ModelCatalogCost, depth: number) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || depth > 4)
      throw new Error("Invalid model catalog pricing");
    for (const name of ["input", "output", "cache_read", "cache_write"] as const) {
      const rate = value[name];
      if (rate !== undefined) {
        if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0)
          throw new Error("Invalid model catalog pricing");
        (name === "output" ? outputs : inputs).push(rate);
      }
    }
    if (value.tiers !== undefined) {
      if (!Array.isArray(value.tiers) || value.tiers.length > 32)
        throw new Error("Invalid model catalog pricing tiers");
      for (const tier of value.tiers) visit(tier, depth + 1);
    }
  };
  visit(cost, 0);
  if (cost.input === undefined || cost.output === undefined) return {};
  // Charge the highest declared input/cache/context rate: this is a conservative
  // accounting estimate, not a provider invoice or a subscription quota measure.
  return {
    costPerInputToken: Math.max(...inputs) / 1_000_000,
    costPerOutputToken: Math.max(...outputs) / 1_000_000,
  };
}

type ModelFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type ProviderFactory = (options: {
  name: string;
  baseURL: string;
  apiKey?: string;
  fetch?: ModelFetch;
}) => (model: string) => LanguageModel;

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;
const DEFAULT_MAXIMUM_RAW_RESPONSE_BYTES = 1_000_000;
const DEFAULT_MAXIMUM_INPUT_TOKENS = 1_000_000;
const DEFAULT_MAXIMUM_STEPS = 5;

const providerFactories: Record<string, () => Promise<ProviderFactory>> = {
  "@ai-sdk/openai-compatible": () =>
    import("@ai-sdk/openai-compatible").then(
      (module) => module.createOpenAICompatible as unknown as ProviderFactory,
    ),
  "@ai-sdk/openai": () =>
    import("@ai-sdk/openai").then((module) => module.createOpenAI as unknown as ProviderFactory),
  "@ai-sdk/anthropic": () =>
    import("@ai-sdk/anthropic").then(
      (module) => module.createAnthropic as unknown as ProviderFactory,
    ),
};

/** Catalog compatibility, not a live authentication or availability check. */
export function isSupportedProviderAdapter(npm: string | undefined): boolean {
  return Object.hasOwn(providerFactories, npm ?? "@ai-sdk/openai-compatible");
}

/** Keep authenticated discovery and inference on the same API credential path. */
export function resolveProviderApiKey(
  options: Pick<ConfiguredModelOptions, "apiKey" | "providerName">,
  metadata: { env?: string[]; npm?: string },
): string | undefined {
  return (
    options.apiKey ??
    process.env.LLM_API_KEY ??
    (metadata.env !== undefined
      ? metadata.env.map((name) => process.env[name]).find(Boolean)
      : options.providerName === "opencode-go" || options.providerName === "opencode-zen"
        ? process.env.OPENCODE_API_KEY
        : metadata.npm === "@ai-sdk/anthropic"
          ? process.env.ANTHROPIC_API_KEY
          : options.providerName === "openai" ||
              !options.providerName ||
              options.providerName === "eigengrid-llm"
            ? process.env.OPENAI_API_KEY
            : undefined)
  );
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be finite and non-negative`);
  }
  return value;
}

/**
 * Wraps provider fetch so an HTTP response cannot be buffered past the model
 * boundary's raw-byte limit. The gateway also checks the normalized response;
 * this transport check is the pre-parser guard required by the contract.
 */
export function createResponseBoundedFetch(
  maximumBytes: number,
  upstream: ModelFetch = globalThis.fetch,
  requestHeaders: Readonly<Record<string, string>> = {},
): ModelFetch {
  positiveSafeInteger(maximumBytes, "maximumRawResponseBytes");
  return async (input, init) => {
    const headers: Record<string, string> = {};
    if (input instanceof Request) {
      input.headers.forEach((value, name) => {
        headers[name] = value;
      });
    }
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    for (const [name, value] of Object.entries(requestHeaders)) {
      headers[name.toLowerCase()] = value;
    }
    const response = await upstream(input, { ...init, headers });
    const advertisedLength = Number(response.headers.get("content-length"));
    if (Number.isSafeInteger(advertisedLength) && advertisedLength > maximumBytes) {
      await response.body?.cancel();
      throw new ModelConversationResponseLimitError(
        `provider response advertises ${advertisedLength} bytes; maximum is ${maximumBytes}`,
      );
    }
    if (!response.body) return response;

    const reader = response.body.getReader();
    let bytesRead = 0;
    const limitedBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            return;
          }
          bytesRead += next.value.byteLength;
          if (bytesRead > maximumBytes) {
            await reader.cancel();
            controller.error(
              new ModelConversationResponseLimitError(
                `provider response exceeded ${maximumBytes} bytes`,
              ),
            );
            return;
          }
          controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    });
    return new Response(limitedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function isOfficialOpenCodeGoEndpoint(baseURL: string): boolean {
  try {
    const url = new URL(baseURL);
    return (
      url.protocol === "https:" &&
      url.hostname === "opencode.ai" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/(?:zen\/go\/v1|inference\/go\/(?:(?:openai|anthropic)\/)?v1)\/?$/u.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function openCodeGoHeaders(
  options: ConfiguredModelOptions,
  baseURL: string,
): Readonly<Record<string, string>> {
  const targetsOpenCodeGo =
    options.providerName === "opencode-go" || isOfficialOpenCodeGoEndpoint(baseURL);
  if (!targetsOpenCodeGo) return {};
  return {
    "x-opencode-session": options.sessionId ?? randomUUID(),
    "user-agent": options.clientUserAgent ?? "eigengrid-agent/0.1.0",
  };
}

async function modelMetadata(
  options: ConfiguredModelOptions,
  catalogLoader: ModelCatalogLoader | undefined,
): Promise<ProviderMetadata> {
  if (!catalogLoader) return { npm: "@ai-sdk/openai-compatible" };
  try {
    const catalog = await catalogLoader();
    const configuredProvider = options.providerName ? catalog[options.providerName] : undefined;
    if (configuredProvider) {
      const model = configuredProvider.models[options.model];
      return {
        npm: model?.npm ?? configuredProvider.npm ?? "@ai-sdk/openai-compatible",
        env: configuredProvider.env ?? [],
        api: model?.api ?? configuredProvider.api,
        providerApi: configuredProvider.api,
        supportsTemperature: model?.temperature,
        cost: model?.cost,
      };
    }
    for (const provider of Object.values(catalog)) {
      const model = provider.models[options.model];
      if (model) {
        return {
          npm: model.npm ?? provider.npm ?? "@ai-sdk/openai-compatible",
          api: model.api ?? provider.api,
          supportsTemperature: model.temperature,
          cost: model.cost,
        };
      }
    }
  } catch {
    // Catalog availability must not expose credentials or alter the policy path.
    if (options.providerName === "opencode-go")
      throw new Error("OpenCode Go model catalog is unavailable; retry model selection");
  }
  return { npm: "@ai-sdk/openai-compatible" };
}

function defaultProviderBaseUrl(npm: string): string {
  return npm === "@ai-sdk/anthropic" ? "https://api.anthropic.com/v1" : DEFAULT_BASE_URL;
}

function configuredBudget(
  options: ConfiguredModelOptions,
  maxTokens: number,
): ModelConversationBudget {
  const maximumSteps = DEFAULT_MAXIMUM_STEPS;
  const maximumInputTokens = positiveSafeInteger(
    options.maximumInputTokens ?? DEFAULT_MAXIMUM_INPUT_TOKENS,
    "maximumInputTokens",
  );
  const maximumOutputTokens = positiveSafeInteger(
    options.maximumOutputTokens ?? maxTokens * maximumSteps,
    "maximumOutputTokens",
  );
  const maximumTotalTokens = positiveSafeInteger(
    options.maximumTotalTokens ?? maximumInputTokens + maximumOutputTokens,
    "maximumTotalTokens",
  );
  const maximumCost = nonNegativeFinite(
    options.maximumCost ?? Number.MAX_SAFE_INTEGER,
    "maximumCost",
  );
  return {
    maximumCalls: maximumSteps,
    maximumSteps,
    maximumInputTokens,
    maximumOutputTokens,
    maximumTotalTokens,
    maximumCost,
  };
}

/**
 * Resolves a configured AI SDK model and constructs the canonical gateway that
 * owns all subsequent operator and scientific provider-boundary calls.
 */
export async function createConfiguredModelResolution(
  options: ConfiguredModelOptions,
  catalogLoader?: ModelCatalogLoader,
): Promise<ConfiguredModelResolution> {
  const metadata = await modelMetadata(options, catalogLoader);
  const maximumRawResponseBytes = positiveSafeInteger(
    options.maximumRawResponseBytes ?? DEFAULT_MAXIMUM_RAW_RESPONSE_BYTES,
    "maximumRawResponseBytes",
  );
  // A provider's default endpoint is a selection, not an explicit proxy override.
  // Mixed-protocol providers must follow the selected model's API family. Also
  // migrate saved official Go endpoints as its catalog evolves; custom URLs stay exact.
  const useCatalogEndpoint =
    options.baseUrl === DEFAULT_BASE_URL ||
    options.baseUrl.replace(/\/+$/u, "") === metadata.providerApi?.replace(/\/+$/u, "") ||
    (options.providerName === "opencode-go" && isOfficialOpenCodeGoEndpoint(options.baseUrl));
  if (
    useCatalogEndpoint &&
    options.providerName === "opencode-go" &&
    isOfficialOpenCodeGoEndpoint(options.baseUrl) &&
    metadata.api &&
    !isOfficialOpenCodeGoEndpoint(metadata.api)
  )
    throw new Error("OpenCode Go catalog endpoint is outside the configured provider");
  const baseURL = (
    (useCatalogEndpoint ? metadata.api : undefined) ??
    (options.baseUrl === DEFAULT_BASE_URL ? defaultProviderBaseUrl(metadata.npm) : options.baseUrl)
  ).replace(/\/+$/u, "");
  const apiKey = resolveProviderApiKey(options, metadata);
  const factoryLoader =
    providerFactories[metadata.npm] ?? providerFactories["@ai-sdk/openai-compatible"];
  const factory = await factoryLoader();
  const providerName = options.providerName ?? "eigengrid-llm";
  const providerVersion = options.providerVersion ?? "1.0.0";
  const modelRevision = options.modelRevision ?? `ai-sdk-${metadata.npm}`;
  const identity = ModelProviderIdentitySchema.parse({
    providerId: providerName,
    providerVersion,
    modelId: options.model,
    modelRevision,
  });
  const model = factory({
    name: providerName,
    baseURL,
    apiKey,
    fetch: createResponseBoundedFetch(
      maximumRawResponseBytes,
      options.fetch ?? globalThis.fetch,
      openCodeGoHeaders(options, baseURL),
    ),
  })(options.model);
  let providerOptions: Record<string, Record<string, string | boolean>> | undefined;
  if (options.reasoningEffort !== undefined) {
    if (!isReasoningEffort(options.reasoningEffort)) throw new Error("Invalid reasoning effort");
    if (metadata.npm === "@ai-sdk/openai")
      providerOptions = {
        openai: { reasoningEffort: options.reasoningEffort, forceReasoning: true },
      };
    else if (metadata.npm === "@ai-sdk/openai-compatible")
      providerOptions = {
        [providerName.split(".")[0].trim()]: { reasoningEffort: options.reasoningEffort },
      };
    else if (
      metadata.npm === "@ai-sdk/anthropic" &&
      ["low", "medium", "high", "xhigh", "max"].includes(options.reasoningEffort)
    )
      providerOptions = { anthropic: { effort: options.reasoningEffort } };
    else throw new Error("This provider cannot apply the selected reasoning variant");
  }
  const temperature = nonNegativeFinite(options.temperature ?? 0.7, "temperature");
  const maxTokens = positiveSafeInteger(options.maxTokens ?? 2_048, "maxTokens");
  const timeoutMilliseconds = positiveSafeInteger(
    options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS,
    "timeoutMilliseconds",
  );
  const budget = configuredBudget(options, maxTokens);
  const catalogRates =
    options.costPerInputToken !== undefined && options.costPerOutputToken !== undefined
      ? {}
      : catalogPricing(metadata.cost);
  const inputRate = options.costPerInputToken ?? catalogRates.costPerInputToken;
  const outputRate = options.costPerOutputToken ?? catalogRates.costPerOutputToken;
  if (inputRate === undefined || outputRate === undefined)
    throw new ModelConversationPricingUnavailableError();
  const pricing: ModelConversationPricing = {
    costPerInputToken: nonNegativeFinite(inputRate, "costPerInputToken"),
    costPerOutputToken: nonNegativeFinite(outputRate, "costPerOutputToken"),
  };
  const gateway = new ModelGateway({
    conversationProviders: [
      {
        identity,
        model,
        temperature,
        maxOutputTokens: maxTokens,
        supportsTemperature:
          options.reasoningEffort && options.reasoningEffort !== "none"
            ? false
            : metadata.supportsTemperature,
        providerOptions,
        requiresStreaming: options.streamOnly,
        ...pricing,
      },
    ],
    maximumRawResponseBytes,
  });
  return {
    gateway,
    model,
    identity,
    temperature,
    maxTokens,
    timeoutMilliseconds,
    maximumRawResponseBytes,
    budget,
    pricing,
  };
}
