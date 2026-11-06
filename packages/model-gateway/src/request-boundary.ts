import { digestCanonical, type ModelInvocationRecord } from "@eigengrid/scientific-schema";
import { z } from "zod";
import {
  InvalidModelGatewayRequestError,
  ModelAttemptTimeoutError,
  type GatewayProviderRequest,
  type ModelGatewayRequest,
  type ModelInvocationBudget,
  type ModelProvider,
  type ModelProviderIdentity,
} from "./contracts";
import { redactModelSecrets, type ModelRedactionReportEntry } from "./redaction";

export function identityKey(identity: ModelProviderIdentity): string {
  return `${identity.providerId}@${identity.providerVersion}/${identity.modelId}@${identity.modelRevision}`;
}

export function providerRecordIdentity(
  identity: ModelProviderIdentity,
): Pick<ModelInvocationRecord, "provider" | "model"> {
  return {
    provider: `${identity.providerId}@${identity.providerVersion}`,
    model: `${identity.modelId}@${identity.modelRevision}`,
  };
}

export function serializeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export function approximateTokensFromBytes(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / 4));
}

export function approximateTokens(value: unknown): number {
  const serialized = serializeJson(value);
  if (serialized === undefined) {
    throw new InvalidModelGatewayRequestError("model request must be JSON serializable");
  }
  return approximateTokensFromBytes(Buffer.byteLength(serialized, "utf8"));
}

export function validationIssues(error: z.ZodError): string[] {
  return error.issues
    .slice(0, 20)
    .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`);
}

export function validateBudget(budget: ModelInvocationBudget): void {
  for (const [key, value] of Object.entries(budget)) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${key} must be non-negative`);
  }
  if (!Number.isSafeInteger(budget.maximumCalls) || budget.maximumCalls <= 0) {
    throw new RangeError("maximumCalls must be a positive safe integer");
  }
}

export function sanitizeGatewayMaterial(request: ModelGatewayRequest<unknown>): {
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

export function compatibleProvider(
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

export async function invokeWithTimeout(
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

export function safeDigest(value: unknown): string | undefined {
  try {
    return digestCanonical(value);
  } catch {
    return undefined;
  }
}
