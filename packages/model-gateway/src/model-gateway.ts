import {
  ModelInvocationIntentSchema,
  ModelInvocationRecordSchema,
  SemverSchema,
  digestCanonical,
  type ModelInvocationIntent,
  type ModelInvocationRecord,
} from "@eigengrid/scientific-schema";
import {
  generateText,
  stepCountIs,
  streamText,
  type GenerateTextResult,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type StreamTextResult,
  type ToolSet,
} from "ai";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { redactModelSecrets, type ModelRedactionReportEntry } from "./redaction";

export const ModelGatewayRequestVersion = "eigengrid.model-request/v1" as const;

export const ModelRoleSchema = z.enum([
  "planner",
  "critic",
  "diagnostician",
  "assessment_composer",
]);
export type ModelRole = z.infer<typeof ModelRoleSchema>;

export const ModelProviderIdentitySchema = z
  .object({
    providerId: z.string().min(1),
    providerVersion: SemverSchema,
    modelId: z.string().min(1),
    modelRevision: z.string().min(1),
  })
  .strict();
export type ModelProviderIdentity = z.infer<typeof ModelProviderIdentitySchema>;

export const ModelCapabilityDescriptorSchema = z
  .object({
    identity: ModelProviderIdentitySchema,
    supportedRoles: z.array(ModelRoleSchema).min(1),
    structuredOutput: z.literal(true),
    supportsAbort: z.boolean(),
    /**
     * Provider-side transport/parser enforcement for maximumRawResponseBytes.
     * This guarantee is mandatory because a post-hoc gateway check cannot bound
     * bytes that the provider has already buffered or parsed.
     */
    enforcesRawResponseByteLimit: z.literal(true),
    maximumContextBytes: z.number().int().positive(),
    maximumInputTokens: z.number().int().positive(),
    maximumOutputTokens: z.number().int().positive(),
    capabilityVersion: SemverSchema,
  })
  .strict();
export type ModelCapabilityDescriptor = z.infer<typeof ModelCapabilityDescriptorSchema>;

export interface ModelInvocationBudget {
  maximumCalls: number;
  maximumInputTokens: number;
  maximumOutputTokens: number;
  maximumTotalTokens: number;
  maximumCost: number;
}

export interface GatewayProviderRequest {
  schemaVersion: typeof ModelGatewayRequestVersion;
  role: ModelRole;
  task: string;
  instruction: string;
  contextDigest: string;
  context: unknown;
  input: unknown;
  outputContract: {
    name: string;
    version: string;
    jsonSchema?: Readonly<Record<string, unknown>>;
  };
  budget: {
    maximumOutputTokens: number;
    maximumRawResponseBytes: number;
    remainingInputTokens: number;
    remainingTotalTokens: number;
    remainingCost: number;
  };
  attempt: {
    kind: "generate" | "repair";
    repairNumber: number;
    validationIssues?: string[];
    previousInvalidOutput?: unknown;
  };
}

const ModelProviderUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    cost: z.number().finite().nonnegative(),
  })
  .strict();

const ModelProviderResponseSchema = z
  .object({
    output: z.record(z.unknown()),
    usage: ModelProviderUsageSchema.optional(),
    conciseRationale: z.string().min(1).max(2_000).optional(),
  })
  .strict();
export type ModelProviderResponse = z.infer<typeof ModelProviderResponseSchema>;

export interface ModelProvider {
  readonly capabilities: ModelCapabilityDescriptor;
  /**
   * Implementations must enforce request.budget.maximumRawResponseBytes before
   * buffering or parsing an upstream response. The gateway repeats the check
   * on the returned JSON envelope as defense in depth.
   */
  invoke(request: GatewayProviderRequest, signal: AbortSignal): Promise<unknown>;
}

/** A language-model candidate used by the same gateway for operator chat. */
export interface ConversationModelProvider {
  readonly providerOptions?: Readonly<Record<string, Readonly<Record<string, string | boolean>>>>;
  readonly requiresStreaming?: boolean;
  readonly identity: ModelProviderIdentity;
  readonly model: LanguageModel;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly supportsTemperature?: boolean;
  readonly costPerInputToken?: number;
  readonly costPerOutputToken?: number;
}

export interface ModelConversationPricing {
  readonly costPerInputToken: number;
  readonly costPerOutputToken: number;
}

export class ModelConversationPricingUnavailableError extends Error {
  readonly name = "ModelConversationPricingUnavailableError";
  constructor() {
    super(
      "Model pricing is unavailable; configure explicit input/output token rates (zero for a free local model)",
    );
  }
}

export interface ModelConversationBudget extends ModelInvocationBudget {
  /** Maximum number of model-loop steps admitted before the provider effect. */
  maximumSteps: number;
}

export interface ModelConversationRequest<TOOLS extends ToolSet = ToolSet> {
  /** The explicit model is a test seam; production resolves candidates in the gateway. */
  model?: LanguageModel;
  providerIdentity?: ModelProviderIdentity;
  system?: string;
  messages: ModelMessage[];
  tools?: TOOLS;
  maximumSteps: number;
  temperature: number;
  maxOutputTokens: number;
  timeoutMilliseconds: number;
  budget: ModelConversationBudget;
  signal?: AbortSignal;
  maximumRawResponseBytes?: number;
  context?: unknown;
}

export interface ModelConversationMetadata {
  provider: ModelProviderIdentity;
  requestDigest: string;
  responseDigest?: string;
  redactions: ModelRedactionReportEntry[];
  usage: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
    costPerInputToken: number;
    costPerOutputToken: number;
  };
}

export interface ModelConversationGeneration<TOOLS extends ToolSet = ToolSet> {
  result: GenerateTextResult<TOOLS, never>;
  metadata: ModelConversationMetadata;
}

export interface ModelConversationStream<TOOLS extends ToolSet = ToolSet> {
  result: StreamTextResult<TOOLS, never>;
  metadata: Promise<ModelConversationMetadata>;
}

export class ModelConversationBudgetExceededError extends Error {
  readonly name = "ModelConversationBudgetExceededError";
  readonly code = "MODEL_CONVERSATION_BUDGET_EXCEEDED";

  constructor(message: string) {
    super(message);
  }
}

export class ModelConversationResponseLimitError extends Error {
  readonly name = "ModelConversationResponseLimitError";
  readonly code = "MODEL_CONVERSATION_RESPONSE_TOO_LARGE";

  constructor(message: string) {
    super(message);
  }
}

export interface ModelInvocationJournal {
  begin(intent: ModelInvocationIntent): Promise<{
    admitted: boolean;
    reason?: "already_in_flight" | "already_observed" | "already_unavailable" | "already_ambiguous";
    intent: ModelInvocationIntent;
  }>;
  observe(input: {
    intentId: string;
    status: "observed" | "unavailable" | "ambiguous";
    observedAt: string;
    responseDigest?: string;
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
    errorCode?: string;
  }): Promise<ModelInvocationIntent>;
}

export class ModelProviderUnavailableError extends Error {
  readonly name = "ModelProviderUnavailableError";
  readonly code = "MODEL_PROVIDER_UNAVAILABLE";

  /**
   * Providers may use this error only before starting an upstream model request.
   * The gateway therefore records no token or cost usage and may try a fallback.
   */
  constructor(message = "Model provider is unavailable before invocation") {
    super(message);
  }
}

export class InvalidModelGatewayRequestError extends Error {
  readonly name = "InvalidModelGatewayRequestError";
  readonly code = "INVALID_MODEL_GATEWAY_REQUEST";

  constructor(message: string) {
    super(message);
  }
}

class ModelAttemptTimeoutError extends Error {
  readonly name = "ModelAttemptTimeoutError";
}

export const DefaultMaximumRawModelResponseBytes = 1_000_000;

export interface ModelGatewayRequest<T> {
  missionId: string;
  planId?: string;
  planningClaimId?: string;
  role: ModelRole;
  task: string;
  instruction: string;
  context: unknown;
  contextDigest: string;
  input: unknown;
  outputSchemaName: string;
  outputSchemaVersion: string;
  outputSchema: z.ZodType<T>;
  outputJsonSchema?: Readonly<Record<string, unknown>>;
  budget: ModelInvocationBudget;
  timeoutMilliseconds: number;
  maximumRepairAttempts?: number;
  signal?: AbortSignal;
  preferredIdentities?: ModelProviderIdentity[];
  invocationJournal?: ModelInvocationJournal;
}

interface GatewayOutcomeBase {
  records: ModelInvocationRecord[];
  attemptedProviders: ModelProviderIdentity[];
  redactions: ModelRedactionReportEntry[];
  effectiveContextDigest: string;
}

export interface ModelGatewaySuccess<T> extends GatewayOutcomeBase {
  status: "succeeded";
  output: T;
  provider: ModelProviderIdentity;
  requestDigest: string;
  responseDigest: string;
  fallbackUsed: boolean;
}

export interface ModelGatewayUnavailable extends GatewayOutcomeBase {
  status: "unavailable";
  code: "MODEL_UNAVAILABLE";
  reasons: Array<{ provider: ModelProviderIdentity; code: string }>;
}

export interface ModelGatewayInvalidOutput extends GatewayOutcomeBase {
  status: "invalid_output";
  code: "MODEL_OUTPUT_INVALID";
  validationIssues: string[];
}

export interface ModelGatewayBudgetExceeded extends GatewayOutcomeBase {
  status: "budget_exceeded";
  code: "MODEL_BUDGET_EXCEEDED";
  reason: string;
}

export interface ModelGatewayAborted extends GatewayOutcomeBase {
  status: "aborted";
  code: "MODEL_INVOCATION_ABORTED";
}

export interface ModelGatewayAmbiguous extends GatewayOutcomeBase {
  status: "ambiguous";
  code: "MODEL_INVOCATION_AMBIGUOUS";
  reason: string;
}

export type ModelGatewayOutcome<T> =
  | ModelGatewaySuccess<T>
  | ModelGatewayUnavailable
  | ModelGatewayInvalidOutput
  | ModelGatewayBudgetExceeded
  | ModelGatewayAborted
  | ModelGatewayAmbiguous;

export interface ModelGatewayOptions {
  /** Structured providers used by planner, critic, diagnosis, and synthesis. */
  providers?: ModelProvider[];
  /** Conversational providers used by the operator agent through this gateway. */
  conversationProviders?: ConversationModelProvider[];
  clock?: () => Date;
  idFactory?: () => string;
  maximumRawResponseBytes?: number;
}

function identityKey(identity: ModelProviderIdentity): string {
  return `${identity.providerId}@${identity.providerVersion}/${identity.modelId}@${identity.modelRevision}`;
}

function providerRecordIdentity(
  identity: ModelProviderIdentity,
): Pick<ModelInvocationRecord, "provider" | "model"> {
  return {
    provider: `${identity.providerId}@${identity.providerVersion}`,
    model: `${identity.modelId}@${identity.modelRevision}`,
  };
}

function serializeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function approximateTokensFromBytes(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / 4));
}

function approximateTokens(value: unknown): number {
  const serialized = serializeJson(value);
  if (serialized === undefined) {
    throw new InvalidModelGatewayRequestError("model request must be JSON serializable");
  }
  return approximateTokensFromBytes(Buffer.byteLength(serialized, "utf8"));
}

function validationIssues(error: z.ZodError): string[] {
  return error.issues
    .slice(0, 20)
    .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`);
}

function validateBudget(budget: ModelInvocationBudget): void {
  for (const [key, value] of Object.entries(budget)) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${key} must be non-negative`);
  }
  if (!Number.isSafeInteger(budget.maximumCalls) || budget.maximumCalls <= 0) {
    throw new RangeError("maximumCalls must be a positive safe integer");
  }
}

function sanitizeGatewayMaterial(request: ModelGatewayRequest<unknown>): {
  task: string;
  instruction: string;
  context: unknown;
  input: unknown;
  report: ModelRedactionReportEntry[];
} {
  const redacted = redactModelSecrets({
    task: request.task,
    instruction: request.instruction,
    context: request.context,
    input: request.input,
  });
  const value = redacted.value as {
    task: string;
    instruction: string;
    context: unknown;
    input: unknown;
  };
  return { ...value, report: redacted.report };
}

function compatibleProvider(
  provider: ModelProvider,
  request: ModelGatewayRequest<unknown>,
  contextBytes: number,
): boolean {
  const capabilities = provider.capabilities;
  return (
    capabilities.supportedRoles.includes(request.role) &&
    capabilities.structuredOutput &&
    capabilities.supportsAbort &&
    capabilities.enforcesRawResponseByteLimit &&
    capabilities.maximumContextBytes >= contextBytes
  );
}

async function invokeWithTimeout(
  provider: ModelProvider,
  request: GatewayProviderRequest,
  externalSignal: AbortSignal | undefined,
  timeoutMilliseconds: number,
): Promise<unknown> {
  const controller = new AbortController();
  let rejectExternalAbort: ((reason: Error) => void) | undefined;
  const externalAbort = new Promise<never>((_resolve, reject) => {
    rejectExternalAbort = reject;
  });
  const abortFromCaller = (): void => {
    rejectExternalAbort?.(new DOMException("Aborted", "AbortError"));
    controller.abort(externalSignal?.reason);
  };
  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      const error = new ModelAttemptTimeoutError("Model invocation timed out");
      reject(error);
      controller.abort(error);
    }, timeoutMilliseconds);
  });
  try {
    const invocation = provider.invoke(request, controller.signal);
    const result = await Promise.race(
      externalSignal ? [invocation, timeout, externalAbort] : [invocation, timeout],
    );
    if (externalSignal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    return result;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
}

interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

function reserveUnknownInvocationUsage(
  totals: UsageTotals,
  budget: ModelInvocationBudget,
): { inputTokens: number; outputTokens: number; cost: number } {
  // The single total-token budget cannot independently reserve every remaining
  // input and output token when their maxima overlap. Allocate it deterministically
  // to input first: the upstream may consume the complete request before producing
  // any observable result. Output receives only the remaining total-token capacity.
  const remainingInputTokens = Math.max(
    0,
    Math.floor(budget.maximumInputTokens - totals.inputTokens),
  );
  const remainingTotalBeforeInput = Math.max(
    0,
    Math.floor(budget.maximumTotalTokens - totals.inputTokens - totals.outputTokens),
  );
  const inputTokens = Math.min(remainingInputTokens, remainingTotalBeforeInput);
  totals.inputTokens += inputTokens;

  const remainingOutputTokens = Math.max(
    0,
    Math.floor(budget.maximumOutputTokens - totals.outputTokens),
  );
  const remainingTotalTokens = Math.max(
    0,
    Math.floor(budget.maximumTotalTokens - totals.inputTokens - totals.outputTokens),
  );
  const outputTokens = Math.min(remainingOutputTokens, remainingTotalTokens);
  const cost = Math.max(0, budget.maximumCost - totals.cost);
  totals.outputTokens += outputTokens;
  totals.cost += cost;
  return { inputTokens, outputTokens, cost };
}

function digestable(value: unknown, seen = new WeakSet<object>()): unknown {
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

function conversationRequestDigest(
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

function modelIdentity(
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

function normalizeLanguageModelUsage(usage: LanguageModelUsage | undefined): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  const inputTokens = usage?.inputTokens;
  const outputTokens = usage?.outputTokens;
  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    inputTokens! < 0 ||
    outputTokens! < 0 ||
    !Number.isSafeInteger(inputTokens! + outputTokens!)
  )
    throw new Error("Model token usage is unknown or invalid; retain the invocation reservation");
  const totalTokens = usage?.totalTokens ?? inputTokens! + outputTokens!;
  if (!Number.isSafeInteger(totalTokens) || totalTokens < inputTokens! + outputTokens!)
    throw new Error("Model total token usage is invalid; retain the invocation reservation");
  return {
    inputTokens: inputTokens!,
    outputTokens: outputTokens!,
    totalTokens,
  };
}

function conversationPricing(provider: ConversationModelProvider): ModelConversationPricing {
  if (provider.costPerInputToken === undefined || provider.costPerOutputToken === undefined)
    throw new ModelConversationPricingUnavailableError();
  return {
    costPerInputToken: provider.costPerInputToken,
    costPerOutputToken: provider.costPerOutputToken,
  };
}

function assertConversationCostReservation(
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

function validateConversationBudget(
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

function conversationResponseBytes(value: unknown): number {
  return Buffer.byteLength(serializeBoundary(value), "utf8");
}

function conversationRawResponseLimit(
  requestedLimit: number | undefined,
  gatewayLimit: number,
): number {
  const limit = requestedLimit ?? gatewayLimit;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("maximumRawResponseBytes must be a positive safe integer");
  }
  return Math.min(limit, gatewayLimit);
}

function wouldExceedBudget(
  totals: UsageTotals,
  budget: ModelInvocationBudget,
  nextInputTokens = 0,
): string | undefined {
  if (totals.calls >= budget.maximumCalls) return "maximum model calls exhausted";
  if (totals.inputTokens + nextInputTokens > budget.maximumInputTokens) {
    return "maximum input tokens exhausted";
  }
  if (totals.inputTokens + totals.outputTokens + nextInputTokens > budget.maximumTotalTokens) {
    return "maximum total tokens exhausted";
  }
  if (totals.outputTokens >= budget.maximumOutputTokens) return "maximum output tokens exhausted";
  if (totals.cost > budget.maximumCost) return "maximum model cost exhausted";
  return undefined;
}

function exceededBudget(totals: UsageTotals, budget: ModelInvocationBudget): string | undefined {
  if (totals.calls > budget.maximumCalls) return "maximum model calls exceeded";
  if (totals.inputTokens > budget.maximumInputTokens) return "maximum input tokens exceeded";
  if (totals.outputTokens > budget.maximumOutputTokens) return "maximum output tokens exceeded";
  if (totals.inputTokens + totals.outputTokens > budget.maximumTotalTokens) {
    return "maximum total tokens exceeded";
  }
  if (totals.cost > budget.maximumCost) return "maximum model cost exceeded";
  return undefined;
}

interface ReportedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}

function readProperty(value: unknown, property: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    return Reflect.get(value, property);
  } catch {
    return undefined;
  }
}

function reportedUsage(value: unknown): ReportedUsage {
  const usage = readProperty(value, "usage");
  const inputTokens = z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .safeParse(readProperty(usage, "inputTokens"));
  const outputTokens = z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .safeParse(readProperty(usage, "outputTokens"));
  const cost = z.number().finite().nonnegative().safeParse(readProperty(usage, "cost"));
  return {
    ...(inputTokens.success ? { inputTokens: inputTokens.data } : {}),
    ...(outputTokens.success ? { outputTokens: outputTokens.data } : {}),
    ...(cost.success ? { cost: cost.data } : {}),
  };
}

function safeDigest(value: unknown): string | undefined {
  try {
    return digestCanonical(value);
  } catch {
    return undefined;
  }
}

/**
 * Provider-neutral structured model boundary. It returns invocation records to the durable
 * mission owner; it never owns, mutates, checkpoints, or silently reconstructs mission state.
 */
export class ModelGateway {
  readonly #providers: ModelProvider[];
  readonly #conversationProviders: ConversationModelProvider[];
  readonly #clock: () => Date;
  readonly #idFactory: () => string;
  readonly #maximumRawResponseBytes: number;

  constructor(options: ModelGatewayOptions = {}) {
    this.#providers = (options.providers ?? []).map((provider) => {
      ModelCapabilityDescriptorSchema.parse(provider.capabilities);
      return provider;
    });
    this.#conversationProviders = (options.conversationProviders ?? []).map((provider) => {
      ModelProviderIdentitySchema.parse(provider.identity);
      if (!Number.isFinite(provider.temperature) || provider.temperature < 0) {
        throw new RangeError("conversation provider temperature must be non-negative");
      }
      if (!Number.isSafeInteger(provider.maxOutputTokens) || provider.maxOutputTokens <= 0) {
        throw new RangeError(
          "conversation provider maxOutputTokens must be a positive safe integer",
        );
      }
      for (const [name, rate] of [
        ["costPerInputToken", provider.costPerInputToken],
        ["costPerOutputToken", provider.costPerOutputToken],
      ] as const) {
        if (rate !== undefined && (!Number.isFinite(rate) || rate < 0)) {
          throw new RangeError(`${name} must be finite and non-negative`);
        }
      }
      return {
        ...provider,
        identity: ModelProviderIdentitySchema.parse(provider.identity),
        providerOptions: provider.providerOptions
          ? Object.freeze(
              Object.fromEntries(
                Object.entries(provider.providerOptions).map(([name, options]) => [
                  name,
                  Object.freeze({ ...options }),
                ]),
              ),
            )
          : undefined,
      };
    });
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#maximumRawResponseBytes =
      options.maximumRawResponseBytes ?? DefaultMaximumRawModelResponseBytes;
    if (
      !Number.isSafeInteger(this.#maximumRawResponseBytes) ||
      this.#maximumRawResponseBytes <= 0
    ) {
      throw new RangeError("maximumRawResponseBytes must be a positive safe integer");
    }
  }

  async invoke<T>(request: ModelGatewayRequest<T>): Promise<ModelGatewayOutcome<T>> {
    validateBudget(request.budget);
    if (!Number.isSafeInteger(request.timeoutMilliseconds) || request.timeoutMilliseconds <= 0) {
      throw new RangeError("timeoutMilliseconds must be a positive safe integer");
    }
    const maximumRepairs = request.maximumRepairAttempts ?? 2;
    if (!Number.isSafeInteger(maximumRepairs) || maximumRepairs < 0 || maximumRepairs > 2) {
      throw new RangeError("maximumRepairAttempts must be between 0 and 2");
    }

    const suppliedContextDigest = digestCanonical(request.context);
    if (suppliedContextDigest !== request.contextDigest) {
      throw new InvalidModelGatewayRequestError(
        "contextDigest does not match the supplied authoritative context",
      );
    }

    const sanitized = sanitizeGatewayMaterial(request as ModelGatewayRequest<unknown>);
    const effectiveContextDigest = digestCanonical(sanitized.context);
    const contextBytes = Buffer.byteLength(JSON.stringify(sanitized.context), "utf8");
    const preferred = request.preferredIdentities?.map(identityKey);
    const providers = this.#providers
      .filter((provider) => compatibleProvider(provider, request, contextBytes))
      .filter(
        (provider) => !preferred || preferred.includes(identityKey(provider.capabilities.identity)),
      )
      .sort((left, right) => {
        if (!preferred) return 0;
        return (
          preferred.indexOf(identityKey(left.capabilities.identity)) -
          preferred.indexOf(identityKey(right.capabilities.identity))
        );
      });

    const records: ModelInvocationRecord[] = [];
    const attemptedProviders: ModelProviderIdentity[] = [];
    const unavailableReasons: ModelGatewayUnavailable["reasons"] = [];
    const totals: UsageTotals = { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
    let lastValidationIssues: string[] = [];

    const base = {
      schemaVersion: ModelGatewayRequestVersion,
      role: request.role,
      task: sanitized.task,
      instruction: sanitized.instruction,
      contextDigest: effectiveContextDigest,
      context: sanitized.context,
      input: sanitized.input,
      outputContract: {
        name: request.outputSchemaName,
        version: request.outputSchemaVersion,
        ...(request.outputJsonSchema ? { jsonSchema: request.outputJsonSchema } : {}),
      },
    } as const;

    if (request.signal?.aborted) {
      return {
        status: "aborted",
        code: "MODEL_INVOCATION_ABORTED",
        records,
        attemptedProviders,
        redactions: sanitized.report,
        effectiveContextDigest,
      };
    }

    for (const provider of providers) {
      const identity = provider.capabilities.identity;
      attemptedProviders.push(identity);
      const startedAt = this.#clock().toISOString();
      const capabilityDigest = digestCanonical(provider.capabilities);
      let repairAttempts = 0;
      let previousInvalidOutput: unknown;
      let providerRequestDigest = "";
      let initialRequestDigest = "";
      let finalRawResponseDigest: string | undefined;
      let providerInputTokens = 0;
      let providerOutputTokens = 0;
      let providerCost = 0;

      while (repairAttempts <= maximumRepairs) {
        const providerRequest: GatewayProviderRequest = {
          ...base,
          budget: {
            maximumOutputTokens: Math.min(
              provider.capabilities.maximumOutputTokens,
              request.budget.maximumOutputTokens - totals.outputTokens,
            ),
            maximumRawResponseBytes: this.#maximumRawResponseBytes,
            remainingInputTokens: request.budget.maximumInputTokens - totals.inputTokens,
            remainingTotalTokens:
              request.budget.maximumTotalTokens - totals.inputTokens - totals.outputTokens,
            remainingCost: request.budget.maximumCost - totals.cost,
          },
          attempt:
            repairAttempts === 0
              ? { kind: "generate", repairNumber: 0 }
              : {
                  kind: "repair",
                  repairNumber: repairAttempts,
                  validationIssues: lastValidationIssues,
                  previousInvalidOutput,
                },
        };
        providerRequestDigest = digestCanonical({ identity, request: providerRequest });
        if (repairAttempts === 0) initialRequestDigest = providerRequestDigest;
        const estimatedInputTokens = approximateTokens(providerRequest);
        if (estimatedInputTokens > provider.capabilities.maximumInputTokens) {
          const finishedAt = this.#clock().toISOString();
          const errorCode = "MODEL_INPUT_LIMIT";
          records.push(
            ModelInvocationRecordSchema.parse({
              id: this.#idFactory(),
              missionId: request.missionId,
              ...(request.planId ? { planId: request.planId } : {}),
              role: request.role,
              ...providerRecordIdentity(identity),
              capabilityDigest,
              requestDigest: initialRequestDigest || providerRequestDigest,
              ...(finalRawResponseDigest ? { responseDigest: finalRawResponseDigest } : {}),
              contextDigest: effectiveContextDigest,
              status: "unavailable",
              repairAttempts,
              inputTokens: providerInputTokens,
              outputTokens: providerOutputTokens,
              cost: providerCost,
              errorCode,
              startedAt,
              finishedAt,
            }),
          );
          unavailableReasons.push({ provider: identity, code: errorCode });
          break;
        }
        const budgetReason = wouldExceedBudget(totals, request.budget, estimatedInputTokens);
        if (budgetReason) {
          if (repairAttempts > 0 || providerInputTokens > 0 || providerOutputTokens > 0) {
            records.push(
              ModelInvocationRecordSchema.parse({
                id: this.#idFactory(),
                missionId: request.missionId,
                ...(request.planId ? { planId: request.planId } : {}),
                role: request.role,
                ...providerRecordIdentity(identity),
                capabilityDigest,
                requestDigest: initialRequestDigest || providerRequestDigest,
                ...(finalRawResponseDigest ? { responseDigest: finalRawResponseDigest } : {}),
                contextDigest: effectiveContextDigest,
                status: "failed",
                repairAttempts,
                ...(providerInputTokens > 0 ? { inputTokens: providerInputTokens } : {}),
                ...(providerOutputTokens > 0 ? { outputTokens: providerOutputTokens } : {}),
                ...(providerCost > 0 ? { cost: providerCost } : {}),
                errorCode: "MODEL_BUDGET_EXCEEDED",
                startedAt,
                finishedAt: this.#clock().toISOString(),
              }),
            );
          }
          return {
            status: "budget_exceeded",
            code: "MODEL_BUDGET_EXCEEDED",
            reason: budgetReason,
            records,
            attemptedProviders,
            redactions: sanitized.report,
            effectiveContextDigest,
          };
        }

        let raw: unknown;
        totals.calls += 1;
        totals.inputTokens += estimatedInputTokens;
        providerInputTokens += estimatedInputTokens;
        let activeIntent: ModelInvocationIntent | undefined;
        if (request.invocationJournal) {
          const intentDigest = digestCanonical({
            missionId: request.missionId,
            planId: request.planId,
            planningClaimId: request.planningClaimId,
            role: request.role,
            provider: identity,
            requestDigest: providerRequestDigest,
            repairNumber: repairAttempts,
          });
          const intent = ModelInvocationIntentSchema.parse({
            id: `model-intent-${intentDigest.slice(0, 48)}`,
            idempotencyKey: intentDigest,
            missionId: request.missionId,
            ...(request.planId ? { planId: request.planId } : {}),
            ...(request.planningClaimId ? { planningClaimId: request.planningClaimId } : {}),
            role: request.role,
            provider: identity.providerId,
            model: identity.modelId,
            capabilityDigest,
            requestDigest: providerRequestDigest,
            contextDigest: effectiveContextDigest,
            budget: {
              ...request.budget,
              maximumTotalTokens: Math.max(
                1,
                Math.ceil(request.budget.maximumTotalTokens / request.budget.maximumCalls),
              ),
              maximumCost: request.budget.maximumCost / request.budget.maximumCalls,
            },
            budgetReservationIds: {
              modelTokens: `model-reservation-${intentDigest.slice(0, 48)}-tokens`,
              cost: `model-reservation-${intentDigest.slice(0, 48)}-cost`,
            },
            timeoutMilliseconds: request.timeoutMilliseconds,
            maximumRepairAttempts: maximumRepairs,
            status: "invoking",
            createdAt: startedAt,
            updatedAt: startedAt,
          });
          const admission = await request.invocationJournal.begin(intent);
          if (!admission.admitted) {
            if (admission.reason === "already_unavailable") {
              totals.calls -= 1;
              totals.inputTokens -= estimatedInputTokens;
              providerInputTokens -= estimatedInputTokens;
              unavailableReasons.push({
                provider: identity,
                code: admission.intent.errorCode ?? "MODEL_PROVIDER_UNAVAILABLE",
              });
              break;
            }
            return {
              status: "ambiguous",
              code: "MODEL_INVOCATION_AMBIGUOUS",
              reason: `Durable invocation ${admission.intent.id} is ${admission.reason ?? "not admissible"}; no provider replay was attempted`,
              records,
              attemptedProviders,
              redactions: sanitized.report,
              effectiveContextDigest,
            };
          }
          activeIntent = admission.intent;
        }
        try {
          raw = await invokeWithTimeout(
            provider,
            providerRequest,
            request.signal,
            request.timeoutMilliseconds,
          );
        } catch (error) {
          const aborted = request.signal?.aborted === true;
          const timedOut = error instanceof ModelAttemptTimeoutError;
          const contractuallyUnavailable =
            !aborted && error instanceof ModelProviderUnavailableError;
          const finishedAt = this.#clock().toISOString();

          if (request.invocationJournal && activeIntent) {
            await request.invocationJournal.observe({
              intentId: activeIntent.id,
              status: contractuallyUnavailable ? "unavailable" : "ambiguous",
              observedAt: finishedAt,
              inputTokens: providerInputTokens,
              outputTokens: providerOutputTokens,
              cost: providerCost,
              errorCode: aborted
                ? "MODEL_INVOCATION_ABORTED"
                : timedOut
                  ? "MODEL_TIMEOUT"
                  : contractuallyUnavailable
                    ? error.code
                    : "MODEL_PROVIDER_FAILURE",
            });
          }

          if (contractuallyUnavailable) {
            // ModelProviderUnavailableError is contractually pre-upstream-invocation:
            // undo this attempt's estimated input reservation and permit fallback.
            totals.inputTokens -= estimatedInputTokens;
            providerInputTokens -= estimatedInputTokens;
            const record = ModelInvocationRecordSchema.parse({
              id: this.#idFactory(),
              missionId: request.missionId,
              ...(request.planId ? { planId: request.planId } : {}),
              role: request.role,
              ...providerRecordIdentity(identity),
              capabilityDigest,
              requestDigest: initialRequestDigest,
              contextDigest: effectiveContextDigest,
              status: "unavailable",
              repairAttempts,
              inputTokens: providerInputTokens,
              outputTokens: providerOutputTokens,
              cost: providerCost,
              errorCode: error.code,
              startedAt,
              finishedAt,
            });
            records.push(record);
            unavailableReasons.push({ provider: identity, code: error.code });
            break;
          }

          // Once an upstream invocation may have started, timeout, caller abort,
          // and generic failure all leave final usage unknowable. Reserve every
          // remaining input/output/total-token and cost unit instead of under-reporting.
          const reserved = reserveUnknownInvocationUsage(totals, request.budget);
          providerInputTokens += reserved.inputTokens;
          providerOutputTokens += reserved.outputTokens;
          providerCost += reserved.cost;
          const record = ModelInvocationRecordSchema.parse({
            id: this.#idFactory(),
            missionId: request.missionId,
            ...(request.planId ? { planId: request.planId } : {}),
            role: request.role,
            ...providerRecordIdentity(identity),
            capabilityDigest,
            requestDigest: initialRequestDigest,
            contextDigest: effectiveContextDigest,
            status: "failed",
            repairAttempts,
            inputTokens: providerInputTokens,
            outputTokens: providerOutputTokens,
            cost: providerCost,
            errorCode: aborted
              ? "MODEL_INVOCATION_ABORTED"
              : timedOut
                ? "MODEL_TIMEOUT"
                : "MODEL_PROVIDER_FAILURE",
            startedAt,
            finishedAt,
          });
          records.push(record);
          if (aborted) {
            return {
              status: "aborted",
              code: "MODEL_INVOCATION_ABORTED",
              records,
              attemptedProviders,
              redactions: sanitized.report,
              effectiveContextDigest,
            };
          }
          return {
            status: "budget_exceeded",
            code: "MODEL_BUDGET_EXCEEDED",
            reason: timedOut
              ? "model invocation timed out with unknown usage; remaining budget reserved"
              : "model invocation failed with unknown usage; remaining budget reserved",
            records,
            attemptedProviders,
            redactions: sanitized.report,
            effectiveContextDigest,
          };
        }

        const serializedRaw = serializeJson(raw);
        const rawResponseBytes =
          serializedRaw === undefined ? undefined : Buffer.byteLength(serializedRaw, "utf8");
        const usage = reportedUsage(raw);
        const chargedInputTokens = Math.max(estimatedInputTokens, usage.inputTokens ?? 0);
        const chargedOutputTokens = Math.max(
          usage.outputTokens ?? 0,
          rawResponseBytes === undefined
            ? Math.max(1, providerRequest.budget.maximumOutputTokens)
            : approximateTokensFromBytes(rawResponseBytes),
        );
        totals.inputTokens += chargedInputTokens - estimatedInputTokens;
        providerInputTokens += chargedInputTokens - estimatedInputTokens;
        totals.outputTokens += chargedOutputTokens;
        providerOutputTokens += chargedOutputTokens;
        const costUsageMissing = usage.cost === undefined;
        const chargedCost = usage.cost ?? Math.max(0, request.budget.maximumCost - totals.cost);
        totals.cost += chargedCost;
        providerCost += chargedCost;

        if (request.invocationJournal && activeIntent) {
          let observedResponseDigest: string | undefined;
          if (serializedRaw !== undefined) {
            try {
              observedResponseDigest = safeDigest(
                redactModelSecrets(JSON.parse(serializedRaw) as unknown).value,
              );
            } catch {
              observedResponseDigest = undefined;
            }
          }
          await request.invocationJournal.observe({
            intentId: activeIntent.id,
            status: "observed",
            observedAt: this.#clock().toISOString(),
            ...(observedResponseDigest ? { responseDigest: observedResponseDigest } : {}),
            inputTokens: providerInputTokens,
            outputTokens: providerOutputTokens,
            cost: providerCost,
          });
        }

        if (costUsageMissing) {
          records.push(
            ModelInvocationRecordSchema.parse({
              id: this.#idFactory(),
              missionId: request.missionId,
              ...(request.planId ? { planId: request.planId } : {}),
              role: request.role,
              ...providerRecordIdentity(identity),
              capabilityDigest,
              requestDigest: initialRequestDigest,
              contextDigest: effectiveContextDigest,
              status: "failed",
              repairAttempts,
              inputTokens: providerInputTokens,
              outputTokens: providerOutputTokens,
              cost: providerCost,
              errorCode: "MODEL_COST_USAGE_MISSING",
              startedAt,
              finishedAt: this.#clock().toISOString(),
            }),
          );
          return {
            status: "budget_exceeded",
            code: "MODEL_BUDGET_EXCEEDED",
            reason: "provider omitted required model cost usage",
            records,
            attemptedProviders,
            redactions: sanitized.report,
            effectiveContextDigest,
          };
        }

        const postResponseBudgetReason = exceededBudget(totals, request.budget);
        if (postResponseBudgetReason) {
          records.push(
            ModelInvocationRecordSchema.parse({
              id: this.#idFactory(),
              missionId: request.missionId,
              ...(request.planId ? { planId: request.planId } : {}),
              role: request.role,
              ...providerRecordIdentity(identity),
              capabilityDigest,
              requestDigest: initialRequestDigest,
              contextDigest: effectiveContextDigest,
              status: "failed",
              repairAttempts,
              inputTokens: providerInputTokens,
              outputTokens: providerOutputTokens,
              cost: providerCost,
              errorCode: "MODEL_BUDGET_EXCEEDED",
              startedAt,
              finishedAt: this.#clock().toISOString(),
            }),
          );
          return {
            status: "budget_exceeded",
            code: "MODEL_BUDGET_EXCEEDED",
            reason: postResponseBudgetReason,
            records,
            attemptedProviders,
            redactions: sanitized.report,
            effectiveContextDigest,
          };
        }

        if (
          serializedRaw === undefined ||
          rawResponseBytes === undefined ||
          rawResponseBytes > this.#maximumRawResponseBytes
        ) {
          const errorCode =
            rawResponseBytes === undefined
              ? "MODEL_RESPONSE_UNSERIALIZABLE"
              : "MODEL_RESPONSE_TOO_LARGE";
          lastValidationIssues = [
            rawResponseBytes === undefined
              ? "$: raw model response is not JSON serializable"
              : `$: raw model response is ${rawResponseBytes} bytes; maximum is ${this.#maximumRawResponseBytes}`,
          ];
          records.push(
            ModelInvocationRecordSchema.parse({
              id: this.#idFactory(),
              missionId: request.missionId,
              ...(request.planId ? { planId: request.planId } : {}),
              role: request.role,
              ...providerRecordIdentity(identity),
              capabilityDigest,
              requestDigest: initialRequestDigest,
              contextDigest: effectiveContextDigest,
              status: "invalid_output",
              repairAttempts,
              inputTokens: providerInputTokens,
              outputTokens: providerOutputTokens,
              cost: providerCost,
              errorCode,
              startedAt,
              finishedAt: this.#clock().toISOString(),
            }),
          );
          break;
        }

        const jsonRaw: unknown = JSON.parse(serializedRaw);
        const redactedRaw = redactModelSecrets(jsonRaw).value;
        finalRawResponseDigest = safeDigest(redactedRaw);
        const boundary = ModelProviderResponseSchema.safeParse(redactedRaw);
        if (!boundary.success) {
          lastValidationIssues = validationIssues(boundary.error);
          previousInvalidOutput = redactedRaw;
        } else {
          const parsed = request.outputSchema.safeParse(boundary.data.output);
          if (parsed.success) {
            const finishedAt = this.#clock().toISOString();
            const responseDigest = digestCanonical(parsed.data);
            records.push(
              ModelInvocationRecordSchema.parse({
                id: this.#idFactory(),
                missionId: request.missionId,
                ...(request.planId ? { planId: request.planId } : {}),
                role: request.role,
                ...providerRecordIdentity(identity),
                capabilityDigest,
                requestDigest: initialRequestDigest,
                responseDigest,
                contextDigest: effectiveContextDigest,
                status: "succeeded",
                repairAttempts,
                inputTokens: providerInputTokens,
                outputTokens: providerOutputTokens,
                cost: providerCost,
                ...(boundary.data.conciseRationale
                  ? { conciseRationale: boundary.data.conciseRationale }
                  : {}),
                startedAt,
                finishedAt,
              }),
            );
            return {
              status: "succeeded",
              output: parsed.data,
              provider: identity,
              requestDigest: initialRequestDigest,
              responseDigest,
              fallbackUsed: attemptedProviders.length > 1,
              records,
              attemptedProviders,
              redactions: sanitized.report,
              effectiveContextDigest,
            };
          }
          lastValidationIssues = validationIssues(parsed.error);
          previousInvalidOutput = boundary.data.output;
        }

        if (repairAttempts === maximumRepairs) {
          const finishedAt = this.#clock().toISOString();
          records.push(
            ModelInvocationRecordSchema.parse({
              id: this.#idFactory(),
              missionId: request.missionId,
              ...(request.planId ? { planId: request.planId } : {}),
              role: request.role,
              ...providerRecordIdentity(identity),
              capabilityDigest,
              requestDigest: initialRequestDigest,
              ...(finalRawResponseDigest ? { responseDigest: finalRawResponseDigest } : {}),
              contextDigest: effectiveContextDigest,
              status: "invalid_output",
              repairAttempts,
              ...(providerInputTokens > 0 ? { inputTokens: providerInputTokens } : {}),
              ...(providerOutputTokens > 0 ? { outputTokens: providerOutputTokens } : {}),
              ...(providerCost > 0 ? { cost: providerCost } : {}),
              errorCode: "MODEL_OUTPUT_INVALID",
              startedAt,
              finishedAt,
            }),
          );
          break;
        }
        repairAttempts += 1;
      }
    }

    if (records.some((record) => record.status === "invalid_output")) {
      return {
        status: "invalid_output",
        code: "MODEL_OUTPUT_INVALID",
        validationIssues: lastValidationIssues,
        records,
        attemptedProviders,
        redactions: sanitized.report,
        effectiveContextDigest,
      };
    }
    return {
      status: "unavailable",
      code: "MODEL_UNAVAILABLE",
      reasons:
        unavailableReasons.length > 0
          ? unavailableReasons
          : [
              {
                provider: {
                  providerId: "none",
                  providerVersion: "0.0.0",
                  modelId: "none",
                  modelRevision: "none",
                },
                code: "NO_COMPATIBLE_PROVIDER",
              },
            ],
      records,
      attemptedProviders,
      redactions: sanitized.report,
      effectiveContextDigest,
    };
  }

  private conversationProvider(request: ModelConversationRequest): ConversationModelProvider {
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
      ? this.#conversationProviders.find(
          (provider) => identityKey(provider.identity) === identityKey(request.providerIdentity!),
        )
      : this.#conversationProviders[0];
    if (!selected) {
      throw new ModelProviderUnavailableError(
        "No configured conversational model is available before invocation",
      );
    }
    return selected;
  }

  private sanitizedConversation(request: ModelConversationRequest): {
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
  async generateConversation<TOOLS extends ToolSet = ToolSet>(
    request: ModelConversationRequest<TOOLS>,
  ): Promise<ModelConversationGeneration<TOOLS>> {
    const provider = this.conversationProvider(request);
    if (provider.requiresStreaming) {
      const execution = this.streamConversation(request);
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
    const sanitized = this.sanitizedConversation(request);
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
      this.#maximumRawResponseBytes,
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
  streamConversation<TOOLS extends ToolSet = ToolSet>(
    request: ModelConversationRequest<TOOLS>,
  ): ModelConversationStream<TOOLS> {
    const provider = this.conversationProvider(request);
    const sanitized = this.sanitizedConversation(request);
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
      this.#maximumRawResponseBytes,
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
          new DOMException("Model conversation aborted with unconfirmed usage", "AbortError"),
        );
      },
    } as Parameters<typeof streamText>[0]);

    return {
      // AI SDK's generic result is widened at this single SDK boundary.
      result: result as unknown as StreamTextResult<TOOLS, never>,
      metadata,
    };
  }
}

export type FakeProviderStep =
  | { kind: "response"; response: unknown; delayMilliseconds?: number }
  | { kind: "unavailable"; delayMilliseconds?: number }
  | { kind: "failure"; errorCode?: string; delayMilliseconds?: number };

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** A scriptable provider with no network, randomness, wall-clock content, or hidden defaults. */
export class DeterministicFakeModelProvider implements ModelProvider {
  readonly capabilities: ModelCapabilityDescriptor;
  readonly requests: GatewayProviderRequest[] = [];
  #cursor = 0;

  constructor(
    capabilities: ModelCapabilityDescriptor,
    private readonly steps: readonly FakeProviderStep[],
  ) {
    this.capabilities = ModelCapabilityDescriptorSchema.parse(capabilities);
  }

  async invoke(request: GatewayProviderRequest, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    this.requests.push(structuredClone(request));
    const step = this.steps[this.#cursor++];
    if (!step) throw new ModelProviderUnavailableError("Fake provider script exhausted");
    await abortableDelay(step.delayMilliseconds ?? 0, signal);
    if (step.kind === "unavailable") throw new ModelProviderUnavailableError();
    if (step.kind === "failure") throw new Error(step.errorCode ?? "FAKE_PROVIDER_FAILURE");
    const response = structuredClone(step.response);
    if (
      typeof response === "object" &&
      response !== null &&
      "output" in response &&
      !("usage" in response)
    ) {
      return {
        ...response,
        usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
      };
    }
    return response;
  }

  reset(): void {
    this.#cursor = 0;
    this.requests.length = 0;
  }
}
