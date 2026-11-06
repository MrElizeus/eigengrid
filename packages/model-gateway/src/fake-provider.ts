import {
  type GatewayProviderRequest,
  type ModelCapabilityDescriptor,
  ModelCapabilityDescriptorSchema,
  type ModelProvider,
  ModelProviderUnavailableError,
} from "./contracts";

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
