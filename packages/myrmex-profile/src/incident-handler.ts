import type {
  MyrmexOperationRequest,
  PublicOperationContext,
  PublicOperationResult,
} from "@eigengrid/protocol";

import {
  MYRMEX_PROFILE_OPERATIONS,
  RedactedIncidentBundlePayloadSchema,
  RedactedIncidentBundleResultSchema,
  type RedactedIncidentBundlePayload,
  type RedactedIncidentBundleResult,
} from "./operations";

export interface RedactedIncidentBundleHandlerContext {
  readonly request: MyrmexOperationRequest;
  readonly payload: RedactedIncidentBundlePayload;
  readonly signal: AbortSignal;
}

export type RedactedIncidentBundleHandler = (
  context: RedactedIncidentBundleHandlerContext,
) => Promise<RedactedIncidentBundleResult> | RedactedIncidentBundleResult;

export interface MyrmexProfileOperationExecutorOptions {
  readonly incidentBundle: RedactedIncidentBundleHandler;
  readonly fallback: (context: PublicOperationContext) => Promise<PublicOperationResult>;
}

/**
 * Bind the typed incident request/result pair to a real injected EigenGrid
 * application handler while leaving every other public operation with the
 * caller-owned application composition.
 */
export function createMyrmexProfileOperationExecutor(
  options: MyrmexProfileOperationExecutorOptions,
): (context: PublicOperationContext) => Promise<PublicOperationResult> {
  return async (context) => {
    if (context.request.operation !== MYRMEX_PROFILE_OPERATIONS.incidentBundle) {
      return options.fallback(context);
    }
    const payload = RedactedIncidentBundlePayloadSchema.parse(context.request.payload);
    const result = await options.incidentBundle({
      request: context.request,
      payload,
      signal: context.signal,
    });
    return {
      state: "confirmed",
      result: RedactedIncidentBundleResultSchema.parse(result),
    };
  };
}
