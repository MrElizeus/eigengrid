import type { LanguageModel, ModelMessage } from "ai";
import {
  createConfiguredModelResolution,
  type ConfiguredModelResolution,
  type ModelCatalogLoader,
  type ModelConversationBudget,
  type ModelGateway,
  type ReasoningEffort,
} from "@eigengrid/model-gateway";
import { fetchCatalog } from "./model-catalog";
import { OPERATOR_SYSTEM_PROMPT } from "./prompts/system";
import { loadLlmConfig } from "./llm-config-store";
import { ChatGptAuth, CHATGPT_RESOURCE } from "./chatgpt-auth";
import { chatGptFetch } from "./chatgpt-transport";
import { assertModelVariant } from "./model-variants";

export interface LlmConfig {
  reasoningEffort?: ReasoningEffort;
  authMode?: "api-key" | "chatgpt";
  chatGptProfileId?: string;
  /** API base URL (e.g. https://api.openai.com/v1). */
  baseUrl: string;
  /** Model name (e.g. gpt-4o, deepseek-v4-flash, claude-sonnet-4). */
  model: string;
  /** API key (optional for local servers). */
  apiKey?: string;
  /** Stable provider name used in model identity and request digests. */
  providerName?: string;
  /** Provider release identity. */
  providerVersion?: string;
  /** Model release/revision identity. */
  modelRevision?: string;
  /** System prompt. Retrieved context never changes this value. */
  systemPrompt?: string;
  /** Temperature (0.0 - 2.0). */
  temperature?: number;
  /** Maximum output tokens per model-loop step. */
  maxTokens?: number;
  /** Shared provider-boundary timeout. */
  timeoutMilliseconds?: number;
  /** Shared provider-boundary raw response limit. */
  maximumRawResponseBytes?: number;
  /** Shared provider-boundary token/cost limits. */
  maximumInputTokens?: number;
  maximumOutputTokens?: number;
  maximumTotalTokens?: number;
  maximumCost?: number;
  costPerInputToken?: number;
  costPerOutputToken?: number;
}

const DEFAULT_CONFIG: LlmConfig = {
  reasoningEffort: undefined,
  authMode: "api-key",
  chatGptProfileId: undefined,
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o",
  providerName: "eigengrid-llm",
  providerVersion: "1.0.0",
  modelRevision: "configured",
  systemPrompt: OPERATOR_SYSTEM_PROMPT,
  temperature: 0.7,
  maxTokens: 2048,
  timeoutMilliseconds: 30_000,
  maximumRawResponseBytes: 1_000_000,
  maximumInputTokens: 1_000_000,
  maximumOutputTokens: 10_240,
  maximumTotalTokens: 1_010_240,
  maximumCost: Number.MAX_SAFE_INTEGER,
};

let activeConfig: LlmConfig = { ...DEFAULT_CONFIG };
let cachedResolution: ConfiguredModelResolution | null = null;

/** Update LLM configuration and invalidate the shared gateway resolution. */
export function configureLlm(config: Partial<LlmConfig>): void {
  const connectionChanged = (
    ["baseUrl", "providerName", "model", "authMode", "chatGptProfileId"] as const
  ).some((key) => Object.hasOwn(config, key) && config[key] !== activeConfig[key]);
  const identityChanged = (["baseUrl", "providerName", "model"] as const).some(
    (key) => config[key] !== undefined && config[key] !== activeConfig[key],
  );
  activeConfig = {
    ...activeConfig,
    ...(identityChanged ? { costPerInputToken: undefined, costPerOutputToken: undefined } : {}),
    ...(connectionChanged ? { reasoningEffort: undefined } : {}),
    ...config,
  };
  cachedResolution = null;
}

/** Get current LLM configuration without exposing mutable state. */
export function getLlmConfig(): LlmConfig {
  return { ...activeConfig };
}

function catalogLoader(): ModelCatalogLoader {
  return async () => fetchCatalog();
}

function configuredOptions(): Parameters<typeof createConfiguredModelResolution>[0] {
  return {
    reasoningEffort: activeConfig.reasoningEffort,
    baseUrl: activeConfig.baseUrl,
    model: activeConfig.model,
    apiKey: activeConfig.apiKey,
    providerName: activeConfig.providerName,
    providerVersion: activeConfig.providerVersion,
    modelRevision: activeConfig.modelRevision,
    temperature: activeConfig.temperature,
    maxTokens: activeConfig.maxTokens,
    timeoutMilliseconds: activeConfig.timeoutMilliseconds,
    maximumRawResponseBytes: activeConfig.maximumRawResponseBytes,
    maximumInputTokens: activeConfig.maximumInputTokens,
    maximumOutputTokens: activeConfig.maximumOutputTokens,
    maximumTotalTokens: activeConfig.maximumTotalTokens,
    maximumCost: activeConfig.maximumCost,
    costPerInputToken: activeConfig.costPerInputToken,
    costPerOutputToken: activeConfig.costPerOutputToken,
  };
}

/**
 * Resolve the canonical provider boundary used by chat, the agent loop, and
 * scientific model roles. The returned model is a boundary-owned candidate;
 * callers must use its gateway for generation.
 */
export async function resolveConfiguredModel(): Promise<{
  gateway: ModelGateway;
  model: LanguageModel;
  identity: ConfiguredModelResolution["identity"];
  temperature: number;
  maxTokens: number;
  timeoutMilliseconds: number;
  maximumRawResponseBytes: number;
  budget: ModelConversationBudget;
  pricing: ConfiguredModelResolution["pricing"];
}> {
  // A TUI startup error or a cached model must not bypass unsafe/corrupt private
  // configuration and silently send an environment credential to a default API.
  loadLlmConfig();
  if (activeConfig.authMode === "chatgpt") {
    if (
      !activeConfig.chatGptProfileId ||
      activeConfig.providerName !== "openai" ||
      activeConfig.baseUrl !== CHATGPT_RESOURCE
    )
      throw new Error("Invalid ChatGPT provider configuration. Reconnect through /connect.");
    const auth = new ChatGptAuth();
    const models = await auth.models(activeConfig.chatGptProfileId);
    const selectedModel = models.find((model) => model.id === activeConfig.model);
    if (!selectedModel)
      throw new Error(
        "The selected model is not in this ChatGPT account's catalog. Use /models to choose another.",
      );
    assertModelVariant(selectedModel, activeConfig);
    return createConfiguredModelResolution(
      {
        ...configuredOptions(),
        baseUrl: CHATGPT_RESOURCE,
        providerName: "openai-chatgpt",
        modelRevision: `chatgpt-plan:${activeConfig.chatGptProfileId}`,
        apiKey: await auth.accessToken(activeConfig.chatGptProfileId),
        streamOnly: true,
        fetch: chatGptFetch(auth, activeConfig.chatGptProfileId),
        costPerInputToken: 0,
        costPerOutputToken: 0,
      },
      async () => ({
        "openai-chatgpt": {
          npm: "@ai-sdk/openai",
          api: CHATGPT_RESOURCE,
          models: { [activeConfig.model]: { temperature: false } },
        },
      }),
    );
  }
  if (activeConfig.reasoningEffort !== undefined) {
    const { discoverConfiguredModels } = await import("./model-discovery");
    const catalog = await discoverConfiguredModels(activeConfig);
    const selected = catalog.models.find((model) => model.id === activeConfig.model);
    if (!selected)
      throw new Error(
        "Choose an available model through /models before using a reasoning variant.",
      );
    assertModelVariant(selected, activeConfig);
  }
  cachedResolution ??= await createConfiguredModelResolution(configuredOptions(), catalogLoader());
  return { ...cachedResolution };
}

function singleStepBudget(
  resolution: Awaited<ReturnType<typeof resolveConfiguredModel>>,
): ModelConversationBudget {
  return {
    ...resolution.budget,
    maximumCalls: 1,
    maximumSteps: 1,
    maximumOutputTokens: Math.min(resolution.budget.maximumOutputTokens, resolution.maxTokens),
  };
}

function chatMessages(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
): ModelMessage[] {
  return messages
    .filter((message): message is { role: "user" | "assistant"; content: string } => {
      return message.role !== "system";
    })
    .map((message) => ({ role: message.role, content: message.content }));
}

/** Send messages through the shared gateway and return a text response. */
export async function chatCompletion(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  opts?: { signal?: AbortSignal },
): Promise<string> {
  const resolution = await resolveConfiguredModel();
  const execution = await resolution.gateway.generateConversation({
    providerIdentity: resolution.identity,
    system: activeConfig.systemPrompt,
    messages: chatMessages(messages),
    maximumSteps: 1,
    temperature: resolution.temperature,
    maxOutputTokens: resolution.maxTokens,
    timeoutMilliseconds: resolution.timeoutMilliseconds,
    maximumRawResponseBytes: resolution.maximumRawResponseBytes,
    budget: singleStepBudget(resolution),
    signal: opts?.signal,
  });
  return execution.result.text.trim();
}

/** Start a streaming response through the shared gateway. */
export async function chatStream(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  opts?: { signal?: AbortSignal },
) {
  const resolution = await resolveConfiguredModel();
  const execution = resolution.gateway.streamConversation({
    providerIdentity: resolution.identity,
    system: activeConfig.systemPrompt,
    messages: chatMessages(messages),
    maximumSteps: 1,
    temperature: resolution.temperature,
    maxOutputTokens: resolution.maxTokens,
    timeoutMilliseconds: resolution.timeoutMilliseconds,
    maximumRawResponseBytes: resolution.maximumRawResponseBytes,
    budget: singleStepBudget(resolution),
    signal: opts?.signal,
  });
  // The stream itself carries provider errors; avoid an unhandled metadata
  // rejection when a caller intentionally consumes textStream only.
  execution.metadata.catch(() => undefined);
  return execution.result.textStream;
}

/** Quick one-shot request through the canonical gateway. */
export function askLlm(userMessage: string, opts?: { signal?: AbortSignal }): Promise<string> {
  return chatCompletion([{ role: "user", content: userMessage }], opts);
}

/** Quick one-shot stream through the canonical gateway. */
export function askLlmStream(userMessage: string, opts?: { signal?: AbortSignal }) {
  return chatStream([{ role: "user", content: userMessage }], opts);
}
