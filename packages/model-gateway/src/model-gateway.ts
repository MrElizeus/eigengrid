import { type ToolSet } from "ai";
import { randomUUID } from "node:crypto";
import {
  type ConversationModelProvider,
  DefaultMaximumRawModelResponseBytes,
  ModelCapabilityDescriptorSchema,
  type ModelConversationGeneration,
  type ModelConversationRequest,
  type ModelConversationStream,
  type ModelGatewayOptions,
  type ModelGatewayOutcome,
  type ModelGatewayRequest,
  type ModelProvider,
  ModelProviderIdentitySchema,
} from "./contracts";
import { generateConversation, streamConversation } from "./conversation";
import { invokeStructured } from "./structured-invocation";
export {
  DefaultMaximumRawModelResponseBytes,
  InvalidModelGatewayRequestError,
  ModelCapabilityDescriptorSchema,
  ModelConversationBudgetExceededError,
  ModelConversationPricingUnavailableError,
  ModelConversationResponseLimitError,
  ModelGatewayRequestVersion,
  ModelProviderIdentitySchema,
  ModelProviderUnavailableError,
  ModelRoleSchema,
} from "./contracts";
export type {
  ConversationModelProvider,
  GatewayProviderRequest,
  ModelCapabilityDescriptor,
  ModelConversationBudget,
  ModelConversationGeneration,
  ModelConversationMetadata,
  ModelConversationPricing,
  ModelConversationRequest,
  ModelConversationStream,
  ModelGatewayAborted,
  ModelGatewayAmbiguous,
  ModelGatewayBudgetExceeded,
  ModelGatewayInvalidOutput,
  ModelGatewayOptions,
  ModelGatewayOutcome,
  ModelGatewayRequest,
  ModelGatewaySuccess,
  ModelGatewayUnavailable,
  ModelInvocationBudget,
  ModelInvocationJournal,
  ModelProvider,
  ModelProviderIdentity,
  ModelProviderResponse,
  ModelRole,
} from "./contracts";
export { DeterministicFakeModelProvider } from "./fake-provider";
export type { FakeProviderStep } from "./fake-provider";

/** Validates provider configuration once, then delegates each invocation mode. */
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
    return invokeStructured(
      {
        providers: this.#providers,
        clock: this.#clock,
        idFactory: this.#idFactory,
        maximumRawResponseBytes: this.#maximumRawResponseBytes,
      },
      request,
    );
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
    return generateConversation(
      {
        conversationProviders: this.#conversationProviders,
        clock: this.#clock,
        idFactory: this.#idFactory,
        maximumRawResponseBytes: this.#maximumRawResponseBytes,
      },
      request,
    );
  }
  /**
   * Start a streaming operator computation through the same boundary. The
   * returned metadata promise settles only after the stream has been consumed,
   * so callers can surface final usage without bypassing the policy hooks.
   */
  streamConversation<TOOLS extends ToolSet = ToolSet>(
    request: ModelConversationRequest<TOOLS>,
  ): ModelConversationStream<TOOLS> {
    return streamConversation(
      {
        conversationProviders: this.#conversationProviders,
        clock: this.#clock,
        idFactory: this.#idFactory,
        maximumRawResponseBytes: this.#maximumRawResponseBytes,
      },
      request,
    );
  }
}
