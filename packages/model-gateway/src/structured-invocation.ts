import {
  type ModelInvocationIntent,
  ModelInvocationIntentSchema,
  type ModelInvocationRecord,
  ModelInvocationRecordSchema,
  digestCanonical,
} from "@eigengrid/scientific-schema";
import {
  type GatewayInvocationContext,
  type GatewayProviderRequest,
  InvalidModelGatewayRequestError,
  ModelAttemptTimeoutError,
  type ModelGatewayOutcome,
  type ModelGatewayRequest,
  ModelGatewayRequestVersion,
  type ModelGatewayUnavailable,
  type ModelProviderIdentity,
  ModelProviderResponseSchema,
  ModelProviderUnavailableError,
} from "./contracts";
import { redactModelSecrets } from "./redaction";
import {
  approximateTokens,
  approximateTokensFromBytes,
  compatibleProvider,
  identityKey,
  invokeWithTimeout,
  providerRecordIdentity,
  safeDigest,
  sanitizeGatewayMaterial,
  serializeJson,
  validateBudget,
  validationIssues,
} from "./request-boundary";
import {
  type UsageTotals,
  exceededBudget,
  reportedUsage,
  reserveUnknownInvocationUsage,
  wouldExceedBudget,
} from "./usage";

export async function invokeStructured<T>(
  context: GatewayInvocationContext,
  request: ModelGatewayRequest<T>,
): Promise<ModelGatewayOutcome<T>> {
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
  const providers = context.providers
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
    const startedAt = context.clock().toISOString();
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
          maximumRawResponseBytes: context.maximumRawResponseBytes,
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
        const finishedAt = context.clock().toISOString();
        const errorCode = "MODEL_INPUT_LIMIT";
        records.push(
          ModelInvocationRecordSchema.parse({
            id: context.idFactory(),
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
              id: context.idFactory(),
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
              finishedAt: context.clock().toISOString(),
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
        const contractuallyUnavailable = !aborted && error instanceof ModelProviderUnavailableError;
        const finishedAt = context.clock().toISOString();

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
            id: context.idFactory(),
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
          id: context.idFactory(),
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
          observedAt: context.clock().toISOString(),
          ...(observedResponseDigest ? { responseDigest: observedResponseDigest } : {}),
          inputTokens: providerInputTokens,
          outputTokens: providerOutputTokens,
          cost: providerCost,
        });
      }

      if (costUsageMissing) {
        records.push(
          ModelInvocationRecordSchema.parse({
            id: context.idFactory(),
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
            finishedAt: context.clock().toISOString(),
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
            id: context.idFactory(),
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
            finishedAt: context.clock().toISOString(),
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
        rawResponseBytes > context.maximumRawResponseBytes
      ) {
        const errorCode =
          rawResponseBytes === undefined
            ? "MODEL_RESPONSE_UNSERIALIZABLE"
            : "MODEL_RESPONSE_TOO_LARGE";
        lastValidationIssues = [
          rawResponseBytes === undefined
            ? "$: raw model response is not JSON serializable"
            : `$: raw model response is ${rawResponseBytes} bytes; maximum is ${context.maximumRawResponseBytes}`,
        ];
        records.push(
          ModelInvocationRecordSchema.parse({
            id: context.idFactory(),
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
            finishedAt: context.clock().toISOString(),
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
          const finishedAt = context.clock().toISOString();
          const responseDigest = digestCanonical(parsed.data);
          records.push(
            ModelInvocationRecordSchema.parse({
              id: context.idFactory(),
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
        const finishedAt = context.clock().toISOString();
        records.push(
          ModelInvocationRecordSchema.parse({
            id: context.idFactory(),
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
