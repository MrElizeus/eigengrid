import {
  SemverSchema,
  type ModelInvocationIntent,
  type ModelInvocationRecord,
} from "@eigengrid/scientific-schema";
import {
  type GenerateTextResult,
  type LanguageModel,
  type ModelMessage,
  type StreamTextResult,
  type ToolSet,
} from "ai";
import { z } from "zod";
import { type ModelRedactionReportEntry } from "./redaction";

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

export const ModelProviderResponseSchema = z
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

export class ModelAttemptTimeoutError extends Error {
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

export interface GatewayInvocationContext {
  readonly providers: ModelProvider[];
  readonly clock: () => Date;
  readonly idFactory: () => string;
  readonly maximumRawResponseBytes: number;
}

export interface GatewayConversationContext {
  readonly conversationProviders: ConversationModelProvider[];
  readonly clock: () => Date;
  readonly idFactory: () => string;
  readonly maximumRawResponseBytes: number;
}
