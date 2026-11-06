import { digestCanonical } from "@eigengrid/scientific-schema";
import { z } from "zod";
import { currentMissionContext, missionAccess } from "./authority";
import {
  type MissionApplicationContext,
  MissionApplicationError,
  type MissionApplicationState,
} from "./contracts";
import { AgentInferenceAdmission, type AgentInferenceLease } from "./requests";

/** Host-only inference admission using the mission runtime's existing atomic mission budget ledger. */
export async function missionBeginAgentInference<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  value: z.input<typeof AgentInferenceAdmission>,
): Promise<AgentInferenceLease> {
  const input = AgentInferenceAdmission.parse(value);
  const context = await currentMissionContext(application);
  await missionAccess(application, input, context);
  const budget = await application.options.store.getMissionBudget(input.missionId);
  const held = (kind: "model_tokens" | "cost") =>
    budget.reservations
      .filter((r) => r.kind === kind && ["reserved", "ambiguous"].includes(r.state))
      .reduce((sum, r) => sum + r.amount, 0);
  const availableTokens = Math.floor(
    budget.limits.modelTokens - budget.consumed.modelTokens - held("model_tokens"),
  );
  const availableCost = budget.limits.cost - budget.consumed.cost - held("cost");
  const total = Math.min(availableTokens, input.maximumInputTokens + input.maximumOutputTokens);
  const outputTokens = Math.min(input.maximumOutputTokens, Math.floor(total / 2));
  const inputTokens = Math.min(input.maximumInputTokens, total - outputTokens);
  if (inputTokens < 1 || outputTokens < 1 || availableCost <= 0 || input.maximumCost <= 0)
    throw new MissionApplicationError("CONFLICT", "PARENT_MODEL_BUDGET_EXHAUSTED");
  const cost = Math.min(input.maximumCost, availableCost);
  const key = digestCanonical({
    sessionId: input.sessionId,
    step: input.step,
    missionId: input.missionId,
    requestDigest: input.requestDigest,
    contextDigest: input.contextDigest,
    provider: input.provider,
    model: input.model,
  });
  const at = application.now().toISOString();
  const mission = await application.options.store.getMission(input.missionId);
  await missionAccess(application, input, context);
  const admitted = await application.options.store.beginModelInvocation({
    id: `agent-model-${key.slice(0, 48)}`,
    idempotencyKey: key,
    missionId: input.missionId,
    ...(mission?.activePlanId ? { planId: mission.activePlanId } : {}),
    role: "diagnostician",
    provider: input.provider,
    model: input.model,
    capabilityDigest: digestCanonical({
      port: "eigengrid.agent-inference/v1",
      policy: context.compilerPolicy.policyDigest,
    }),
    requestDigest: input.requestDigest,
    contextDigest: input.contextDigest,
    budget: {
      maximumCalls: 1,
      maximumInputTokens: inputTokens,
      maximumOutputTokens: outputTokens,
      maximumTotalTokens: inputTokens + outputTokens,
      maximumCost: cost,
    },
    budgetReservationIds: {
      modelTokens: `agent-model-${key.slice(0, 48)}-tokens`,
      cost: `agent-model-${key.slice(0, 48)}-cost`,
    },
    timeoutMilliseconds: input.timeoutMilliseconds,
    maximumRepairAttempts: 0,
    status: "invoking",
    createdAt: at,
    updatedAt: at,
  });
  if (!admitted.admitted)
    throw new MissionApplicationError("CONFLICT", "MODEL_INVOCATION_REQUIRES_RECONCILIATION");
  const lease = Object.freeze({
    intent: admitted.intent,
    remainingBudget: Object.freeze({ inputTokens, outputTokens, cost }),
  });
  application.inferenceLeases.add(lease);
  return lease;
}

/** Account an already admitted call even if a client disconnects or loses permission.
 * This host-issued lease cannot authorize a scientific effect or a new model call. */
export async function missionObserveAgentInference<C extends MissionApplicationContext>(
  application: MissionApplicationState<C>,
  lease: AgentInferenceLease,
  observation: {
    responseDigest?: string;
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
    ambiguous?: boolean;
  },
): Promise<void> {
  if (!application.inferenceLeases.has(lease))
    throw new MissionApplicationError("FORBIDDEN", "Foreign inference accounting lease");
  await application.options.store.observeModelInvocation({
    intentId: lease.intent.id,
    status: observation.ambiguous ? "ambiguous" : "observed",
    observedAt: application.now().toISOString(),
    ...(observation.ambiguous
      ? { errorCode: "MODEL_USAGE_UNCONFIRMED" }
      : {
          responseDigest: observation.responseDigest,
          inputTokens: observation.inputTokens,
          outputTokens: observation.outputTokens,
          cost: observation.cost,
        }),
  });
}
