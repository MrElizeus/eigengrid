import { describe, expect, test } from "bun:test";
import { digestCanonical } from "@eigengrid/scientific-schema";
import { z } from "zod";
import {
  DeterministicFakeModelProvider,
  ModelGateway,
  type FakeProviderStep,
  type ModelCapabilityDescriptor,
  type ModelGatewayRequest,
  type ModelInvocationJournal,
  type ModelProvider,
} from "./model-gateway";

const outputSchema = z.object({ value: z.string().min(1) }).strict();

function descriptor(
  providerId: string,
  roles: ModelCapabilityDescriptor["supportedRoles"] = ["planner", "critic"],
): ModelCapabilityDescriptor {
  return {
    identity: {
      providerId,
      providerVersion: "1.0.0",
      modelId: "deterministic-ci-model",
      modelRevision: "fixture-r1",
    },
    supportedRoles: roles,
    structuredOutput: true,
    supportsAbort: true,
    enforcesRawResponseByteLimit: true,
    maximumContextBytes: 1_000_000,
    maximumInputTokens: 100_000,
    maximumOutputTokens: 10_000,
    capabilityVersion: "1.0.0",
  };
}

function steps(...values: unknown[]): FakeProviderStep[] {
  return values.map((output) => ({
    kind: "response",
    response: {
      output,
      usage: { inputTokens: 10, outputTokens: 5, cost: 0 },
      conciseRationale: "Concise fixture rationale",
    },
  }));
}

function gatewayRequest(
  overrides: Partial<ModelGatewayRequest<{ value: string }>> = {},
): ModelGatewayRequest<{ value: string }> {
  const context = {
    schemaVersion: "context/v1",
    sections: [{ kind: "objective", value: "water" }],
  };
  return {
    missionId: "mission-1",
    planId: "plan-1",
    role: "planner",
    task: "Return a fixture value",
    instruction: "Return only structured output",
    context,
    contextDigest: digestCanonical(context),
    input: { objectiveId: "objective-1" },
    outputSchemaName: "FixtureOutput",
    outputSchemaVersion: "1.0.0",
    outputSchema,
    budget: {
      maximumCalls: 8,
      maximumInputTokens: 100_000,
      maximumOutputTokens: 10_000,
      maximumTotalTokens: 110_000,
      maximumCost: 1,
    },
    timeoutMilliseconds: 1_000,
    ...overrides,
  };
}

function gateway(providers: ModelProvider[], maximumRawResponseBytes?: number): ModelGateway {
  let id = 0;
  return new ModelGateway({
    providers,
    clock: () => new Date("2026-08-06T12:00:00.000Z"),
    idFactory: () => `model-invocation-${++id}`,
    maximumRawResponseBytes,
  });
}

describe("provider-neutral model gateway", () => {
  test("records exact identity, structured digests, usage, and no hidden reasoning", async () => {
    const provider = new DeterministicFakeModelProvider(
      descriptor("fake-a"),
      steps({ value: "ok" }),
    );
    const request = gatewayRequest();
    const snapshot = structuredClone({ ...request, outputSchema: undefined });
    const result = await gateway([provider]).invoke(request);

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    expect(result.output).toEqual({ value: "ok" });
    expect(result.provider).toEqual(descriptor("fake-a").identity);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toEqual(
      expect.objectContaining({
        provider: "fake-a@1.0.0",
        model: "deterministic-ci-model@fixture-r1",
        role: "planner",
        status: "succeeded",
        repairAttempts: 0,
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
      }),
    );
    expect(result.records[0].inputTokens).toBeGreaterThan(10);
    expect(result.records[0].outputTokens).toBeGreaterThan(5);
    expect(result.responseDigest).toBe(digestCanonical({ value: "ok" }));
    expect(JSON.stringify(result.records)).not.toContain("Return only structured output");
    expect(structuredClone({ ...request, outputSchema: undefined })).toEqual(snapshot);
  });

  test("repairs malformed output once and caps repair at two attempts", async () => {
    const repairedProvider = new DeterministicFakeModelProvider(
      descriptor("repairable"),
      steps({ wrong: true }, { value: "repaired" }),
    );
    const repaired = await gateway([repairedProvider]).invoke(gatewayRequest());
    expect(repaired.status).toBe("succeeded");
    if (repaired.status !== "succeeded") return;
    expect(repaired.output.value).toBe("repaired");
    expect(repaired.records[0].repairAttempts).toBe(1);
    expect(repairedProvider.requests.map((request) => request.attempt.kind)).toEqual([
      "generate",
      "repair",
    ]);

    const invalidProvider = new DeterministicFakeModelProvider(
      descriptor("invalid"),
      steps({ wrong: 1 }, { wrong: 2 }, { wrong: 3 }, { value: "must-not-run" }),
    );
    const invalid = await gateway([invalidProvider]).invoke(gatewayRequest());
    expect(invalid.status).toBe("invalid_output");
    expect(invalidProvider.requests).toHaveLength(3);
    expect(invalid.records[0]).toEqual(
      expect.objectContaining({ status: "invalid_output", repairAttempts: 2 }),
    );
    expect(invalid.records[0].inputTokens).toBeGreaterThan(0);
    expect(invalid.records[0].outputTokens).toBeGreaterThan(0);
  });

  test("bounds oversized raw envelopes before redaction or repair", async () => {
    const provider = new DeterministicFakeModelProvider(descriptor("oversized"), [
      {
        kind: "response",
        response: {
          output: { wrong: "x".repeat(20_000) },
          usage: { inputTokens: 1, outputTokens: 1, cost: 0.25 },
        },
      },
      ...steps({ value: "must-not-repair" }),
    ]);
    const result = await gateway([provider], 512).invoke(gatewayRequest());

    expect(result.status).toBe("invalid_output");
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].budget.maximumRawResponseBytes).toBe(512);
    expect(result.records).toEqual([
      expect.objectContaining({
        status: "invalid_output",
        errorCode: "MODEL_RESPONSE_TOO_LARGE",
        cost: 0.25,
      }),
    ]);
    expect(result.records[0].outputTokens).toBeGreaterThan(1);
    expect(JSON.stringify(result.records)).not.toContain("xxxxxxxxxx");
  });

  test("charges estimated tokens when usage is subreported", async () => {
    const subreportedProvider = new DeterministicFakeModelProvider(descriptor("subreported"), [
      {
        kind: "response",
        response: {
          output: { value: "valid despite underreported usage" },
          usage: { inputTokens: 0, outputTokens: 0, cost: 0.4 },
        },
      },
    ]);
    const subreported = await gateway([subreportedProvider]).invoke(gatewayRequest());
    expect(subreported.status).toBe("succeeded");
    expect(subreported.records[0]).toEqual(
      expect.objectContaining({
        cost: 0.4,
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
      }),
    );
    expect(subreported.records[0].inputTokens).toBeGreaterThan(0);
    expect(subreported.records[0].outputTokens).toBeGreaterThan(0);
  });

  test("fails closed and reserves remaining cost when provider cost usage is absent", async () => {
    let invocationCount = 0;
    const absentProvider: ModelProvider = {
      capabilities: descriptor("absent-cost"),
      async invoke() {
        invocationCount += 1;
        return { output: { value: "must-not-succeed" } };
      },
    };
    const absent = await gateway([absentProvider]).invoke(
      gatewayRequest({
        budget: {
          maximumCalls: 1,
          maximumInputTokens: 100_000,
          maximumOutputTokens: 10_000,
          maximumTotalTokens: 110_000,
          maximumCost: 0.75,
        },
      }),
    );

    expect(absent.status).toBe("budget_exceeded");
    expect(invocationCount).toBe(1);
    expect(absent.records).toEqual([
      expect.objectContaining({
        status: "failed",
        errorCode: "MODEL_COST_USAGE_MISSING",
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
        cost: 0.75,
      }),
    ]);
    expect(absent.records[0].inputTokens).toBeGreaterThan(0);
    expect(absent.records[0].outputTokens).toBeGreaterThan(0);
  });

  test("fails closed when usage tokens are reported without cost", async () => {
    let invocationCount = 0;
    const absentCostProvider: ModelProvider = {
      capabilities: descriptor("absent-cost-field"),
      async invoke() {
        invocationCount += 1;
        return {
          output: { value: "must-not-succeed" },
          usage: { inputTokens: 12, outputTokens: 8 },
        };
      },
    };
    const result = await gateway([absentCostProvider]).invoke(
      gatewayRequest({
        budget: {
          maximumCalls: 1,
          maximumInputTokens: 100_000,
          maximumOutputTokens: 10_000,
          maximumTotalTokens: 110_000,
          maximumCost: 0.75,
        },
      }),
    );

    expect(result.status).toBe("budget_exceeded");
    expect(invocationCount).toBe(1);
    expect(result.records).toEqual([
      expect.objectContaining({
        status: "failed",
        errorCode: "MODEL_COST_USAGE_MISSING",
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
        cost: 0.75,
      }),
    ]);
    expect(result.records[0].inputTokens).toBeGreaterThanOrEqual(12);
    expect(result.records[0].outputTokens).toBeGreaterThanOrEqual(8);
  });

  test("does not let repair usage exceed output or cost budgets", async () => {
    const provider = new DeterministicFakeModelProvider(descriptor("repair-accounting"), [
      {
        kind: "response",
        response: {
          output: { wrong: 1 },
          usage: { inputTokens: 1, outputTokens: 60, cost: 0.6 },
        },
      },
      {
        kind: "response",
        response: {
          output: { value: "would otherwise succeed" },
          usage: { inputTokens: 1, outputTokens: 60, cost: 0.6 },
        },
      },
    ]);
    const result = await gateway([provider]).invoke(
      gatewayRequest({
        budget: {
          maximumCalls: 3,
          maximumInputTokens: 100_000,
          maximumOutputTokens: 100,
          maximumTotalTokens: 100_100,
          maximumCost: 1,
        },
      }),
    );

    expect(result.status).toBe("budget_exceeded");
    expect(provider.requests).toHaveLength(2);
    expect(result.records[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        errorCode: "MODEL_BUDGET_EXCEEDED",
        outputTokens: 120,
        cost: 1.2,
      }),
    );
  });

  test("preserves accumulated usage when a repair request exceeds provider input limits", async () => {
    const provider = new DeterministicFakeModelProvider(
      { ...descriptor("repair-input-limit"), maximumInputTokens: 500 },
      [
        {
          kind: "response",
          response: {
            output: { wrong: "x".repeat(5_000) },
            usage: { inputTokens: 10, outputTokens: 1_300, cost: 0.5 },
          },
        },
      ],
    );
    const result = await gateway([provider]).invoke(gatewayRequest());

    expect(result.status).toBe("unavailable");
    expect(provider.requests).toHaveLength(1);
    expect(result.records).toEqual([
      expect.objectContaining({
        status: "unavailable",
        errorCode: "MODEL_INPUT_LIMIT",
        repairAttempts: 1,
        inputTokens: expect.any(Number),
        outputTokens: 1_300,
        cost: 0.5,
      }),
    ]);
    expect(result.records[0].inputTokens).toBeGreaterThan(0);
  });

  test("counts malformed calls against budget and still emits an invocation record", async () => {
    const provider = new DeterministicFakeModelProvider(
      descriptor("repair-budget"),
      steps({ malformed: true }, { value: "must-not-run" }),
    );
    const request = gatewayRequest();
    request.budget.maximumCalls = 1;
    const result = await gateway([provider]).invoke(request);
    expect(result.status).toBe("budget_exceeded");
    expect(provider.requests).toHaveLength(1);
    expect(result.records).toEqual([
      expect.objectContaining({ status: "failed", errorCode: "MODEL_BUDGET_EXCEEDED" }),
    ]);
  });

  test("rejects response fields that could smuggle hidden reasoning, then repairs", async () => {
    const provider = new DeterministicFakeModelProvider(descriptor("strict"), [
      {
        kind: "response",
        response: {
          output: { value: "unsafe" },
          usage: { inputTokens: 10, outputTokens: 5, cost: 0 },
          hiddenReasoning: "do not persist this",
        },
      },
      ...steps({ value: "safe" }),
    ]);
    const result = await gateway([provider]).invoke(gatewayRequest());
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    expect(result.output.value).toBe("safe");
    expect(result.records[0].repairAttempts).toBe(1);
    expect(JSON.stringify(result.records)).not.toContain("do not persist this");
  });

  test("falls back only to a compatible provider without losing request context", async () => {
    const unavailable = new DeterministicFakeModelProvider(descriptor("primary"), [
      { kind: "unavailable" },
    ]);
    const fallback = new DeterministicFakeModelProvider(
      descriptor("fallback"),
      steps({ value: "fallback-value" }),
    );
    const result = await gateway([unavailable, fallback]).invoke(gatewayRequest());

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    expect(result.fallbackUsed).toBe(true);
    expect(result.attemptedProviders.map((identity) => identity.providerId)).toEqual([
      "primary",
      "fallback",
    ]);
    expect(result.records.map((record) => record.status)).toEqual(["unavailable", "succeeded"]);
    expect(result.records[0]).toEqual(
      expect.objectContaining({ inputTokens: 0, outputTokens: 0, cost: 0 }),
    );
    expect(unavailable.requests[0].contextDigest).toBe(fallback.requests[0].contextDigest);
    expect(unavailable.requests[0].input).toEqual(fallback.requests[0].input);
  });

  test("keeps call and token accounting global across fallback providers", async () => {
    const unavailable = new DeterministicFakeModelProvider(descriptor("call-primary"), [
      { kind: "unavailable" },
    ]);
    const blockedFallback = new DeterministicFakeModelProvider(
      descriptor("call-fallback"),
      steps({ value: "must-not-run" }),
    );
    const callLimited = await gateway([unavailable, blockedFallback]).invoke(
      gatewayRequest({
        budget: {
          maximumCalls: 1,
          maximumInputTokens: 100_000,
          maximumOutputTokens: 10_000,
          maximumTotalTokens: 110_000,
          maximumCost: 1,
        },
      }),
    );
    expect(callLimited.status).toBe("budget_exceeded");
    expect(unavailable.requests).toHaveLength(1);
    expect(blockedFallback.requests).toHaveLength(0);
    expect(callLimited.records[0]).toEqual(
      expect.objectContaining({ inputTokens: 0, outputTokens: 0, cost: 0 }),
    );

    const invalid = new DeterministicFakeModelProvider(descriptor("usage-primary"), [
      {
        kind: "response",
        response: {
          output: { wrong: true },
          usage: { inputTokens: 1, outputTokens: 60, cost: 0.6 },
        },
      },
    ]);
    const costlyFallback = new DeterministicFakeModelProvider(descriptor("usage-fallback"), [
      {
        kind: "response",
        response: {
          output: { value: "over budget" },
          usage: { inputTokens: 1, outputTokens: 60, cost: 0.6 },
        },
      },
    ]);
    const usageLimited = await gateway([invalid, costlyFallback]).invoke(
      gatewayRequest({
        maximumRepairAttempts: 0,
        budget: {
          maximumCalls: 2,
          maximumInputTokens: 100_000,
          maximumOutputTokens: 100,
          maximumTotalTokens: 100_100,
          maximumCost: 1,
        },
      }),
    );
    expect(usageLimited.status).toBe("budget_exceeded");
    expect(invalid.requests).toHaveLength(1);
    expect(costlyFallback.requests).toHaveLength(1);
    expect(usageLimited.records.reduce((sum, record) => sum + (record.outputTokens ?? 0), 0)).toBe(
      120,
    );
    expect(usageLimited.records.reduce((sum, record) => sum + (record.cost ?? 0), 0)).toBe(1.2);

    const totalPrimary = new DeterministicFakeModelProvider(descriptor("total-primary"), [
      {
        kind: "response",
        response: {
          output: { wrong: true },
          usage: { inputTokens: 1, outputTokens: 10, cost: 0 },
        },
      },
    ]);
    const totalFallback = new DeterministicFakeModelProvider(
      descriptor("total-fallback"),
      steps({ value: "must-not-run" }),
    );
    const totalLimited = await gateway([totalPrimary, totalFallback]).invoke(
      gatewayRequest({
        maximumRepairAttempts: 0,
        budget: {
          maximumCalls: 2,
          maximumInputTokens: 100_000,
          maximumOutputTokens: 10_000,
          maximumTotalTokens: 250,
          maximumCost: 1,
        },
      }),
    );
    expect(totalLimited).toEqual(
      expect.objectContaining({
        status: "budget_exceeded",
        reason: "maximum total tokens exhausted",
      }),
    );
    expect(totalPrimary.requests).toHaveLength(1);
    expect(totalFallback.requests).toHaveLength(0);
  });

  test("returns typed unavailable when no exact compatible provider exists", async () => {
    const criticOnly = new DeterministicFakeModelProvider(
      descriptor("critic-only", ["critic"]),
      steps({ value: "never" }),
    );
    const result = await gateway([criticOnly]).invoke(gatewayRequest({ role: "planner" }));
    expect(result).toEqual(
      expect.objectContaining({ status: "unavailable", code: "MODEL_UNAVAILABLE", records: [] }),
    );
    expect(criticOnly.requests).toHaveLength(0);
  });

  test("rejects providers that cannot guarantee cancellation before invoking them", async () => {
    const provider = new DeterministicFakeModelProvider(
      { ...descriptor("no-abort-guarantee"), supportsAbort: false },
      steps({ value: "must-not-run" }),
    );
    const result = await gateway([provider]).invoke(gatewayRequest());

    expect(result.status).toBe("unavailable");
    expect(provider.requests).toHaveLength(0);
    expect(result.attemptedProviders).toEqual([]);
  });

  test("requires an explicit true raw response byte boundary guarantee", () => {
    const { enforcesRawResponseByteLimit: _guarantee, ...missingGuarantee } =
      descriptor("missing-raw-guarantee");
    const falseGuarantee = {
      ...descriptor("false-raw-guarantee"),
      enforcesRawResponseByteLimit: false,
    };
    let invocations = 0;

    for (const capabilities of [missingGuarantee, falseGuarantee]) {
      const provider: ModelProvider = {
        capabilities: capabilities as unknown as ModelCapabilityDescriptor,
        async invoke() {
          invocations += 1;
          return { output: { value: "must-not-run" } };
        },
      };
      expect(() => gateway([provider], 512)).toThrow();
    }
    expect(invocations).toBe(0);
  });

  test("fails closed when the authoritative context digest is stale", async () => {
    const provider = new DeterministicFakeModelProvider(
      descriptor("stale-context"),
      steps({ value: "never" }),
    );
    await expect(
      gateway([provider]).invoke(gatewayRequest({ contextDigest: "0".repeat(64) })),
    ).rejects.toEqual(expect.objectContaining({ code: "INVALID_MODEL_GATEWAY_REQUEST" }));
    expect(provider.requests).toHaveLength(0);
  });

  test("redacts credentials before provider invocation and makes secret values digest-equivalent", async () => {
    const providerA = new DeterministicFakeModelProvider(
      descriptor("redaction"),
      steps({ value: "ok" }),
    );
    const contextA = { objective: "water", apiKey: "sk-firstSecret123" };
    const first = await gateway([providerA]).invoke(
      gatewayRequest({
        context: contextA,
        contextDigest: digestCanonical(contextA),
        input: { authorization: "Bearer firstTokenValue" },
      }),
    );
    const providerB = new DeterministicFakeModelProvider(
      descriptor("redaction"),
      steps({ value: "ok" }),
    );
    const contextB = { objective: "water", apiKey: "sk-secondSecret456" };
    const second = await gateway([providerB]).invoke(
      gatewayRequest({
        context: contextB,
        contextDigest: digestCanonical(contextB),
        input: { authorization: "Bearer secondTokenValue" },
      }),
    );
    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    if (first.status !== "succeeded" || second.status !== "succeeded") return;
    expect(JSON.stringify(providerA.requests)).not.toContain("firstSecret");
    expect(JSON.stringify(providerA.requests)).not.toContain("firstTokenValue");
    expect(first.effectiveContextDigest).toBe(second.effectiveContextDigest);
    expect(first.requestDigest).toBe(second.requestDigest);
    expect(first.redactions.length).toBeGreaterThanOrEqual(2);
  });

  test("honors timeout, caller abort, and invocation budgets", async () => {
    const slow = new DeterministicFakeModelProvider(descriptor("slow"), [
      { kind: "response", delayMilliseconds: 100, response: { output: { value: "late" } } },
    ]);
    const timedOut = await gateway([slow]).invoke(gatewayRequest({ timeoutMilliseconds: 5 }));
    expect(timedOut.status).toBe("budget_exceeded");
    expect(timedOut.records[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        errorCode: "MODEL_TIMEOUT",
        inputTokens: 100_000,
        outputTokens: 10_000,
        cost: 1,
      }),
    );

    const controller = new AbortController();
    controller.abort("test abort");
    const aborted = await gateway([
      new DeterministicFakeModelProvider(descriptor("abort"), steps({ value: "never" })),
    ]).invoke(gatewayRequest({ signal: controller.signal }));
    expect(aborted.status).toBe("aborted");
    expect(aborted.records).toEqual([]);

    const budgetProvider = new DeterministicFakeModelProvider(
      descriptor("budget"),
      steps({ value: "must-not-run" }),
    );
    const exhausted = await gateway([budgetProvider]).invoke(
      gatewayRequest({
        budget: {
          maximumCalls: 1,
          maximumInputTokens: 1,
          maximumOutputTokens: 10_000,
          maximumTotalTokens: 10_001,
          maximumCost: 1,
        },
      }),
    );
    expect(exhausted.status).toBe("budget_exceeded");
    // Preflight accounting fails before a provider effect when the request cannot fit.
    expect(budgetProvider.requests).toHaveLength(0);
  });

  test("fails closed on a repair timeout without invoking fallback", async () => {
    const repairing = new DeterministicFakeModelProvider(descriptor("repair-timeout"), [
      ...steps({ wrong: true }),
      {
        kind: "response",
        delayMilliseconds: 100,
        response: { output: { value: "late repair" } },
      },
    ]);
    const fallback = new DeterministicFakeModelProvider(
      descriptor("timeout-fallback"),
      steps({ value: "must-not-run" }),
    );
    const result = await gateway([repairing, fallback]).invoke(
      gatewayRequest({ timeoutMilliseconds: 5 }),
    );

    expect(result.status).toBe("budget_exceeded");
    expect(repairing.requests).toHaveLength(2);
    expect(fallback.requests).toHaveLength(0);
    expect(result.records[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        errorCode: "MODEL_TIMEOUT",
        repairAttempts: 1,
        inputTokens: 100_000,
        outputTokens: 10_000,
        cost: 1,
      }),
    );
  });

  test("fails closed immediately when the caller aborts an in-flight provider", async () => {
    const controller = new AbortController();
    const active = new DeterministicFakeModelProvider(descriptor("active-abort"), [
      {
        kind: "response",
        delayMilliseconds: 100,
        response: { output: { value: "late" } },
      },
    ]);
    const fallback = new DeterministicFakeModelProvider(
      descriptor("abort-fallback"),
      steps({ value: "must-not-run" }),
    );
    setTimeout(() => controller.abort("caller stopped"), 5);
    const result = await gateway([active, fallback]).invoke(
      gatewayRequest({ signal: controller.signal }),
    );

    expect(result.status).toBe("aborted");
    expect(active.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(0);
    expect(result.records[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        errorCode: "MODEL_INVOCATION_ABORTED",
        inputTokens: 100_000,
        outputTokens: 10_000,
        cost: 1,
      }),
    );
    expect(result.records[0].inputTokens! + result.records[0].outputTokens!).toBe(110_000);
  });

  test("rejects a provider response resolved synchronously from its abort listener", async () => {
    const controller = new AbortController();
    let providerCalls = 0;
    let resolvedFromAbort = 0;
    const resolvingProvider: ModelProvider = {
      capabilities: descriptor("resolve-on-abort"),
      invoke(_request, signal) {
        providerCalls += 1;
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              resolvedFromAbort += 1;
              resolve({
                output: { value: "must-not-be-accepted" },
                usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
              });
            },
            { once: true },
          );
        });
      },
    };
    const fallback = new DeterministicFakeModelProvider(
      descriptor("resolve-on-abort-fallback"),
      steps({ value: "must-not-run" }),
    );

    setTimeout(() => controller.abort("caller stopped"), 5);
    const result = await gateway([resolvingProvider, fallback]).invoke(
      gatewayRequest({ signal: controller.signal }),
    );

    expect(result.status).toBe("aborted");
    expect(providerCalls).toBe(1);
    expect(resolvedFromAbort).toBe(1);
    expect(fallback.requests).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("must-not-be-accepted");
    expect(result.records).toEqual([
      expect.objectContaining({
        status: "failed",
        errorCode: "MODEL_INVOCATION_ABORTED",
        inputTokens: 100_000,
        outputTokens: 10_000,
        cost: 1,
      }),
    ]);
  });

  test("reserves remaining usage after an unknown provider failure without fallback", async () => {
    const failed = new DeterministicFakeModelProvider(descriptor("failed-upstream"), [
      { kind: "failure", errorCode: "CONNECTION_RESET_AFTER_SEND" },
    ]);
    const fallback = new DeterministicFakeModelProvider(
      descriptor("failure-fallback"),
      steps({ value: "must-not-run" }),
    );
    const result = await gateway([failed, fallback]).invoke(
      gatewayRequest({
        budget: {
          maximumCalls: 8,
          maximumInputTokens: 100_000,
          maximumOutputTokens: 10_000,
          maximumTotalTokens: 500,
          maximumCost: 0.75,
        },
      }),
    );

    expect(result.status).toBe("budget_exceeded");
    expect(failed.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(0);
    expect(result.records).toEqual([
      expect.objectContaining({
        status: "failed",
        errorCode: "MODEL_PROVIDER_FAILURE",
        inputTokens: 500,
        outputTokens: 0,
        cost: 0.75,
      }),
    ]);
    expect(result.records[0].inputTokens! + result.records[0].outputTokens!).toBe(500);
  });

  test("rebuilds the same request digest in a fresh gateway process", async () => {
    const firstProvider = new DeterministicFakeModelProvider(
      descriptor("restart-stable"),
      steps({ value: "same" }),
    );
    const secondProvider = new DeterministicFakeModelProvider(
      descriptor("restart-stable"),
      steps({ value: "same" }),
    );
    const first = await gateway([firstProvider]).invoke(gatewayRequest());
    const second = await gateway([secondProvider]).invoke(gatewayRequest());
    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    if (first.status !== "succeeded" || second.status !== "succeeded") return;
    expect(first.requestDigest).toBe(second.requestDigest);
    expect(first.responseDigest).toBe(second.responseDigest);
  });

  test("writes the durable intent before effect and records ambiguous failure without fallback", async () => {
    const events: string[] = [];
    const journal: ModelInvocationJournal = {
      async begin(intent) {
        events.push(`begin:${intent.id}`);
        return { admitted: true, intent };
      },
      async observe(input) {
        events.push(`observe:${input.status}`);
        return {} as never;
      },
    };
    const provider: ModelProvider = {
      capabilities: descriptor("journal-provider"),
      async invoke(_request, _signal) {
        events.push("provider");
        return {
          output: { value: "journaled" },
          usage: { inputTokens: 10, outputTokens: 5, cost: 0 },
        };
      },
    };
    const result = await gateway([provider]).invoke(gatewayRequest({ invocationJournal: journal }));
    expect(result.status).toBe("succeeded");
    expect(events[0]).toStartWith("begin:");
    expect(events).toEqual([expect.stringMatching(/^begin:/), "provider", "observe:observed"]);

    const failedEvents: string[] = [];
    const failedJournal: ModelInvocationJournal = {
      async begin(intent) {
        failedEvents.push("begin");
        return { admitted: true, intent };
      },
      async observe(input) {
        failedEvents.push(`observe:${input.status}`);
        return {} as never;
      },
    };
    const failed = new DeterministicFakeModelProvider(descriptor("journal-failure"), [
      { kind: "failure", errorCode: "RESET_AFTER_SEND" },
    ]);
    const fallback = new DeterministicFakeModelProvider(
      descriptor("journal-fallback"),
      steps({ value: "must-not-run" }),
    );
    const failedResult = await gateway([failed, fallback]).invoke(
      gatewayRequest({ invocationJournal: failedJournal }),
    );
    expect(failedResult.status).toBe("budget_exceeded");
    expect(failedEvents).toEqual(["begin", "observe:ambiguous"]);
    expect(fallback.requests).toHaveLength(0);
  });

  test("does not replay a durable invocation that is already ambiguous", async () => {
    let providerCalls = 0;
    const journal: ModelInvocationJournal = {
      async begin(intent) {
        return { admitted: false, reason: "already_ambiguous", intent };
      },
      async observe() {
        throw new Error("observation must not run without admission");
      },
    };
    const provider: ModelProvider = {
      capabilities: descriptor("no-replay"),
      async invoke() {
        providerCalls += 1;
        return { output: { value: "must-not-run" } };
      },
    };
    const result = await gateway([provider]).invoke(gatewayRequest({ invocationJournal: journal }));
    expect(result.status).toBe("ambiguous");
    expect(providerCalls).toBe(0);
  });

  test("does not replay a pre-effect unavailable intent and can use a safe fallback", async () => {
    let admissionCount = 0;
    const journal: ModelInvocationJournal = {
      async begin(intent) {
        admissionCount += 1;
        return admissionCount === 1
          ? { admitted: false, reason: "already_unavailable", intent }
          : { admitted: true, intent };
      },
      async observe() {
        return {} as never;
      },
    };
    const primary = new DeterministicFakeModelProvider(descriptor("unavailable-restart"), [
      { kind: "response", response: { output: { value: "must-not-run" } } },
    ]);
    const fallback = new DeterministicFakeModelProvider(
      descriptor("safe-fallback"),
      steps({ value: "fallback-after-restart" }),
    );
    const result = await gateway([primary, fallback]).invoke(
      gatewayRequest({ invocationJournal: journal }),
    );

    expect(result.status).toBe("succeeded");
    expect(primary.requests).toHaveLength(0);
    expect(fallback.requests).toHaveLength(1);
  });
});
