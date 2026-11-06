import { digestCanonical } from "@eigengrid/scientific-schema";
import {
  generateText,
  type GenerateTextResult,
  type ModelMessage,
  stepCountIs,
  streamText,
  type StreamTextResult,
  type ToolSet,
} from "ai";
import {
  type ConversationModelProvider,
  type GatewayConversationContext,
  ModelConversationBudgetExceededError,
  type ModelConversationGeneration,
  type ModelConversationMetadata,
  type ModelConversationRequest,
  ModelConversationResponseLimitError,
  type ModelConversationStream,
  ModelProviderUnavailableError,
} from "./contracts";
import {
  assertConversationCostReservation,
  conversationPricing,
  conversationRawResponseLimit,
  conversationRequestDigest,
  conversationResponseBytes,
  digestable,
  modelIdentity,
  validateConversationBudget,
} from "./conversation-boundary";
import { type ModelRedactionReportEntry, redactModelSecrets } from "./redaction";
import { approximateTokens, identityKey } from "./request-boundary";
import { normalizeLanguageModelUsage } from "./usage";

export function conversationProvider(
  context: GatewayConversationContext,
  request: ModelConversationRequest,
): ConversationModelProvider {
  if (request.model) {
    const identity = modelIdentity(request.model, request.providerIdentity);
    return {
      identity,
      model: request.model,
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
      // An explicitly injected model is a host-owned test seam. Production
      // provider selection must carry real rates, including explicit free rates.
      costPerInputToken: 0,
      costPerOutputToken: 0,
    };
  }

  const selected = request.providerIdentity
    ? context.conversationProviders.find(
        (provider) => identityKey(provider.identity) === identityKey(request.providerIdentity!),
      )
    : context.conversationProviders[0];
  if (!selected) {
    throw new ModelProviderUnavailableError(
      "No configured conversational model is available before invocation",
    );
  }
  return selected;
}

export function sanitizedConversation(request: ModelConversationRequest): {
  system?: string;
  messages: ModelMessage[];
  context?: unknown;
  report: ModelRedactionReportEntry[];
} {
  const redacted = redactModelSecrets({
    system: request.system,
    messages: request.messages,
    context: request.context,
  });
  const value = redacted.value as {
    system?: string;
    messages: ModelMessage[];
    context?: unknown;
  };
  return { ...value, report: redacted.report };
}

/**
 * Execute the operator's free-form/tool-loop computation through the same
 * provider identity, timeout, abort, digest, redaction, and budget boundary
 * used by scientific structured calls. Tool permissions are still materialized
 * by ToolRegistry before this method is reached.
 */
export async function generateConversation<TOOLS extends ToolSet = ToolSet>(
  context: GatewayConversationContext,
  request: ModelConversationRequest<TOOLS>,
): Promise<ModelConversationGeneration<TOOLS>> {
  const provider = conversationProvider(context, request);
  if (provider.requiresStreaming) {
    const execution = streamConversation(context, request);
    void execution.metadata.catch(() => undefined);
    for await (const part of execution.result.fullStream) {
      if (part.type === "error") throw part.error;
    }
    const [text, toolCalls, steps, totalUsage, metadata] = await Promise.all([
      execution.result.text,
      execution.result.toolCalls,
      execution.result.steps,
      execution.result.totalUsage,
      execution.metadata,
    ]);
    return {
      result: {
        ...steps.at(-1),
        text,
        toolCalls,
        steps,
        totalUsage,
      } as unknown as ModelConversationGeneration<TOOLS>["result"],
      metadata,
    };
  }
  const sanitized = sanitizedConversation(request);
  const estimatedInputTokens = approximateTokens({
    system: sanitized.system,
    messages: sanitized.messages,
    context: sanitized.context,
    toolNames: Object.keys(request.tools ?? {}).sort(),
  });
  validateConversationBudget(request, estimatedInputTokens);
  const rates = conversationPricing(provider);
  assertConversationCostReservation(request, rates);
  if (request.maxOutputTokens > provider.maxOutputTokens) {
    throw new ModelConversationBudgetExceededError(
      "maxOutputTokens exceeds the configured provider limit",
    );
  }
  if (request.signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const maximumRawResponseBytes = conversationRawResponseLimit(
    request.maximumRawResponseBytes,
    context.maximumRawResponseBytes,
  );
  const requestDigest = conversationRequestDigest(
    request,
    provider.identity,
    sanitized,
    rates,
    provider.providerOptions,
  );
  const result = await generateText({
    model: provider.model,
    providerOptions: provider.providerOptions,
    ...(sanitized.system ? { system: sanitized.system } : {}),
    messages: sanitized.messages,
    ...(request.tools ? { tools: request.tools } : {}),
    stopWhen: stepCountIs(request.maximumSteps),
    temperature: provider.supportsTemperature === false ? undefined : request.temperature,
    maxOutputTokens: request.maxOutputTokens,
    maxRetries: 0,
    abortSignal: request.signal,
    timeout: request.timeoutMilliseconds,
  } as Parameters<typeof generateText>[0]);

  const usage = normalizeLanguageModelUsage(result.totalUsage);
  const calls = Math.max(1, result.steps.length);
  if (calls > request.budget.maximumCalls) {
    throw new ModelConversationBudgetExceededError("maximum model calls exhausted");
  }
  if (
    usage.inputTokens > request.budget.maximumInputTokens ||
    usage.outputTokens > request.budget.maximumOutputTokens ||
    usage.totalTokens > request.budget.maximumTotalTokens
  ) {
    throw new ModelConversationBudgetExceededError("model usage exceeded the configured budget");
  }
  const responseDigest = digestCanonical(digestable({ text: result.text, steps: result.steps }));
  const responseBytes = conversationResponseBytes({ text: result.text, steps: result.steps });
  if (responseBytes > maximumRawResponseBytes) {
    throw new ModelConversationResponseLimitError(
      `model conversation response is ${responseBytes} bytes; maximum is ${maximumRawResponseBytes}`,
    );
  }

  const cost =
    usage.inputTokens * rates.costPerInputToken + usage.outputTokens * rates.costPerOutputToken;
  if (cost > request.budget.maximumCost) {
    throw new ModelConversationBudgetExceededError("maximum model cost exhausted");
  }
  return {
    // AI SDK's generic result is widened at this single SDK boundary; the
    // agent only consumes the stable steps/text surface below it.
    result: result as unknown as GenerateTextResult<TOOLS, never>,
    metadata: {
      provider: provider.identity,
      requestDigest,
      responseDigest,
      redactions: sanitized.report,
      usage: { ...usage, calls, cost, ...rates },
    },
  };
}

/**
 * Start a streaming operator computation through the same boundary. The
 * returned metadata promise settles only after the stream has been consumed,
 * so callers can surface final usage without bypassing the policy hooks.
 */
export function streamConversation<TOOLS extends ToolSet = ToolSet>(
  context: GatewayConversationContext,
  request: ModelConversationRequest<TOOLS>,
): ModelConversationStream<TOOLS> {
  const provider = conversationProvider(context, request);
  const sanitized = sanitizedConversation(request);
  const estimatedInputTokens = approximateTokens({
    system: sanitized.system,
    messages: sanitized.messages,
    context: sanitized.context,
    toolNames: Object.keys(request.tools ?? {}).sort(),
  });
  validateConversationBudget(request, estimatedInputTokens);
  const rates = conversationPricing(provider);
  assertConversationCostReservation(request, rates);
  if (request.maxOutputTokens > provider.maxOutputTokens) {
    throw new ModelConversationBudgetExceededError(
      "maxOutputTokens exceeds the configured provider limit",
    );
  }
  if (request.signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const requestDigest = conversationRequestDigest(
    request,
    provider.identity,
    sanitized,
    rates,
    provider.providerOptions,
  );
  const maximumRawResponseBytes = conversationRawResponseLimit(
    request.maximumRawResponseBytes,
    context.maximumRawResponseBytes,
  );
  let responseBytes = 0;
  let responseText = "";
  let responseLimitError: ModelConversationResponseLimitError | undefined;
  let resolveMetadata: (metadata: ModelConversationMetadata) => void = () => undefined;
  let rejectMetadata: (error: unknown) => void = () => undefined;
  const metadata = new Promise<ModelConversationMetadata>((resolve, reject) => {
    resolveMetadata = resolve;
    rejectMetadata = reject;
  });

  const result = streamText({
    model: provider.model,
    providerOptions: provider.providerOptions,
    ...(sanitized.system ? { system: sanitized.system } : {}),
    messages: sanitized.messages,
    ...(request.tools ? { tools: request.tools } : {}),
    stopWhen: stepCountIs(request.maximumSteps),
    temperature: provider.supportsTemperature === false ? undefined : request.temperature,
    maxOutputTokens: request.maxOutputTokens,
    maxRetries: 0,
    abortSignal: request.signal,
    timeout: request.timeoutMilliseconds,
    onChunk: async ({ chunk }) => {
      responseBytes += conversationResponseBytes(chunk);
      if (responseBytes > maximumRawResponseBytes) {
        responseLimitError ??= new ModelConversationResponseLimitError(
          `model conversation stream exceeded ${maximumRawResponseBytes} bytes`,
        );
        return;
      }
      const chunkValue = chunk as unknown as Record<string, unknown>;
      if (chunkValue.type === "text-delta" && typeof chunkValue.text === "string") {
        responseText += chunkValue.text;
      }
    },
    onFinish: async (event) => {
      try {
        if (responseLimitError) {
          rejectMetadata(responseLimitError);
          return;
        }
        const usage = normalizeLanguageModelUsage(event.totalUsage);
        const calls = Math.max(1, event.steps.length);
        const cost =
          usage.inputTokens * rates.costPerInputToken +
          usage.outputTokens * rates.costPerOutputToken;
        if (
          calls > request.budget.maximumCalls ||
          usage.inputTokens > request.budget.maximumInputTokens ||
          usage.outputTokens > request.budget.maximumOutputTokens ||
          usage.totalTokens > request.budget.maximumTotalTokens ||
          cost > request.budget.maximumCost
        ) {
          throw new ModelConversationBudgetExceededError(
            "model usage exceeded the configured budget",
          );
        }
        const responseDigest = digestCanonical(
          digestable({ text: responseText, steps: event.steps }),
        );
        resolveMetadata({
          provider: provider.identity,
          requestDigest,
          responseDigest,
          redactions: sanitized.report,
          usage: { ...usage, calls, cost, ...rates },
        });
      } catch (error) {
        rejectMetadata(error);
      }
    },
    onError: ({ error }) => {
      rejectMetadata(responseLimitError ?? error);
    },
    onAbort: () => {
      rejectMetadata(
        new DOMException(
          request.signal?.aborted
            ? "Model response interrupted. Partial text is retained; final usage could not be confirmed."
            : `Model response timed out after ${request.timeoutMilliseconds / 1000}s. Partial text is retained; final usage could not be confirmed.`,
          request.signal?.aborted ? "AbortError" : "TimeoutError",
        ),
      );
    },
  } as Parameters<typeof streamText>[0]);

  return {
    // AI SDK's generic result is widened at this single SDK boundary.
    result: result as unknown as StreamTextResult<TOOLS, never>,
    metadata,
  };
}
