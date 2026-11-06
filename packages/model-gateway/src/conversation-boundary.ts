import { digestCanonical } from "@eigengrid/scientific-schema";
import { type LanguageModel, type ModelMessage } from "ai";
import {
  type ConversationModelProvider,
  InvalidModelGatewayRequestError,
  ModelConversationBudgetExceededError,
  type ModelConversationPricing,
  ModelConversationPricingUnavailableError,
  type ModelConversationRequest,
  type ModelProviderIdentity,
  ModelProviderIdentitySchema,
} from "./contracts";
import { validateBudget } from "./request-boundary";

export function digestable(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function") return "[FUNCTION]";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => digestable(item, seen));
  if (typeof value === "object") {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    const objectValue = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(objectValue).sort()) {
      result[key] = digestable(objectValue[key], seen);
    }
    seen.delete(value);
    return result;
  }
  return String(value);
}

function serializeBoundary(value: unknown): string {
  const serialized = JSON.stringify(digestable(value));
  if (serialized === undefined) {
    throw new InvalidModelGatewayRequestError("model conversation is not JSON serializable");
  }
  return serialized;
}

export function conversationRequestDigest(
  request: ModelConversationRequest,
  identity: ModelProviderIdentity,
  sanitized: { system?: string; messages: ModelMessage[]; context?: unknown },
  pricing: ModelConversationPricing,
  providerOptions?: ConversationModelProvider["providerOptions"],
): string {
  return digestCanonical(
    digestable({
      schemaVersion: "eigengrid.operator-model-request/v1",
      identity,
      system: sanitized.system,
      messages: sanitized.messages,
      context: sanitized.context,
      toolNames: Object.keys(request.tools ?? {}).sort(),
      maximumSteps: request.maximumSteps,
      maxOutputTokens: request.maxOutputTokens,
      temperature: request.temperature,
      pricing,
      ...(providerOptions ? { providerOptions } : {}),
    }),
  );
}

export function modelIdentity(
  model: LanguageModel,
  supplied?: ModelProviderIdentity,
): ModelProviderIdentity {
  if (supplied) return ModelProviderIdentitySchema.parse(supplied);
  const candidate = typeof model === "object" && model !== null ? model : undefined;
  const provider = candidate && "provider" in candidate ? String(candidate.provider) : "injected";
  const modelId = candidate && "modelId" in candidate ? String(candidate.modelId) : "unknown-model";
  return ModelProviderIdentitySchema.parse({
    providerId: provider || "injected",
    providerVersion: "1.0.0",
    modelId: modelId || "unknown-model",
    modelRevision: "ai-sdk-v3",
  });
}

export function conversationPricing(provider: ConversationModelProvider): ModelConversationPricing {
  if (provider.costPerInputToken === undefined || provider.costPerOutputToken === undefined)
    throw new ModelConversationPricingUnavailableError();
  return {
    costPerInputToken: provider.costPerInputToken,
    costPerOutputToken: provider.costPerOutputToken,
  };
}

export function assertConversationCostReservation(
  request: ModelConversationRequest,
  rates: ModelConversationPricing,
): void {
  const reservedCost =
    request.budget.maximumInputTokens * rates.costPerInputToken +
    request.maxOutputTokens * request.maximumSteps * rates.costPerOutputToken;
  if (!Number.isFinite(reservedCost) || reservedCost > request.budget.maximumCost)
    throw new ModelConversationBudgetExceededError(
      "Configured token reservation exceeds the monetary budget",
    );
}

export function validateConversationBudget(
  request: ModelConversationRequest,
  estimatedInputTokens: number,
): void {
  if (!Number.isSafeInteger(request.maximumSteps) || request.maximumSteps <= 0) {
    throw new RangeError("maximumSteps must be a positive safe integer");
  }
  if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0) {
    throw new RangeError("maxOutputTokens must be a positive safe integer");
  }
  if (!Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2) {
    throw new RangeError("temperature must be finite and between 0 and 2");
  }
  if (!Number.isSafeInteger(request.timeoutMilliseconds) || request.timeoutMilliseconds <= 0) {
    throw new RangeError("timeoutMilliseconds must be a positive safe integer");
  }
  validateBudget(request.budget);
  for (const key of [
    "maximumSteps",
    "maximumInputTokens",
    "maximumOutputTokens",
    "maximumTotalTokens",
  ] as const) {
    const value = request.budget[key];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${key} must be a positive safe integer`);
    }
  }
  if (request.budget.maximumSteps < request.maximumSteps) {
    throw new ModelConversationBudgetExceededError("maximum model-loop steps exhausted");
  }
  if (request.budget.maximumCalls < request.maximumSteps) {
    throw new ModelConversationBudgetExceededError("maximum model calls exhausted");
  }
  if (estimatedInputTokens > request.budget.maximumInputTokens) {
    throw new ModelConversationBudgetExceededError("maximum input tokens exhausted");
  }
  const reservedOutputTokens = request.maxOutputTokens * request.maximumSteps;
  if (!Number.isSafeInteger(reservedOutputTokens)) {
    throw new RangeError("conversation output reservation exceeds safe integer range");
  }
  if (reservedOutputTokens > request.budget.maximumOutputTokens) {
    throw new ModelConversationBudgetExceededError("maximum output tokens exhausted");
  }
  if (estimatedInputTokens + reservedOutputTokens > request.budget.maximumTotalTokens) {
    throw new ModelConversationBudgetExceededError("maximum total tokens exhausted");
  }
}

export function conversationResponseBytes(value: unknown): number {
  return Buffer.byteLength(serializeBoundary(value), "utf8");
}

export function conversationRawResponseLimit(
  requestedLimit: number | undefined,
  gatewayLimit: number,
): number {
  const limit = requestedLimit ?? gatewayLimit;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("maximumRawResponseBytes must be a positive safe integer");
  }
  return Math.min(limit, gatewayLimit);
}
