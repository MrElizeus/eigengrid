import {
  agentDigest,
  DEFAULT_AGENT_LIMITS,
  AgentInferenceBudgetError,
  type AgentInferencePort,
} from "@eigengrid/agent-runtime";
import { AiSdkInferencePort } from "@eigengrid/agent/native-inference";
import { configureLlm, loadLlmConfig, resolveConfiguredModel } from "@eigengrid/agent";
import { buildSystemPrompt } from "@eigengrid/agent/agent-loop";
import type { AgentPrincipal } from "./agent-sessions";
import { openMissionApplication } from "./mission-composition";
import { MissionApplicationError } from "./mission-application";
import { ScientificBudgetExceededError } from "@eigengrid/mission-runtime";

export interface PreparedMissionInference {
  readonly inference: AgentInferencePort;
  readonly provider: string;
  readonly model: string;
  readonly identityDigest?: string;
  readonly maximumOutputTokens: number;
  readonly timeoutMilliseconds: number;
}
export async function prepareConfiguredMissionInference(): Promise<PreparedMissionInference> {
  // The service operator's working directory supplies model preferences, as in
  // the TUI. No HTTP/request field selects a config file, endpoint or API key.
  const saved = loadLlmConfig();
  if (saved) configureLlm(saved);
  const config = await resolveConfiguredModel();
  return {
    inference: new AiSdkInferencePort(
      { ...config, useGatewayProvider: true, providerIdentity: config.identity },
      buildSystemPrompt("mission"),
    ),
    provider: config.identity.providerId,
    model: config.identity.modelId,
    identityDigest: agentDigest({ identity: config.identity, pricing: config.pricing }),
    maximumOutputTokens: config.maxTokens,
    timeoutMilliseconds: config.timeoutMilliseconds,
  };
}

/** Per-session checkpoints and all Heads share the mission runtime's parent mission budget. A
 * crash/unknown provider usage retains the canonical reservation; it is never
 * released merely because an HTTP request or an agent process disappeared. */
export function createMissionBoundInference(
  principalFor: (sessionId: string) => Promise<AgentPrincipal>,
  open: typeof openMissionApplication = openMissionApplication,
  prepare: () => Promise<PreparedMissionInference> = prepareConfiguredMissionInference,
): AgentInferencePort {
  const bound: AgentInferencePort = {
    async infer(request) {
      const principal = await principalFor(request.sessionId);
      const prepared = await prepare(); // Missing local configuration spends no mission budget.
      const session = await open();
      try {
        const remaining = request.remainingBudget ?? {
          inputTokens: DEFAULT_AGENT_LIMITS.maximumInputTokens,
          outputTokens: DEFAULT_AGENT_LIMITS.maximumOutputTokens,
          cost: DEFAULT_AGENT_LIMITS.maximumCost,
        };
        const lease = await session.application
          .beginAgentInference({
            projectId: principal.projectId,
            missionId: principal.missionId,
            sessionId: request.sessionId,
            step: request.step,
            requestDigest: agentDigest({
              prompt: request.prompt,
              observations: request.observations,
              tools: request.tools,
              step: request.step,
            }),
            contextDigest: agentDigest({
              transcript: request.transcript,
              providerIdentity:
                prepared.identityDigest ??
                agentDigest({ provider: prepared.provider, model: prepared.model }),
            }),
            provider: prepared.provider,
            model: prepared.model,
            maximumInputTokens: remaining.inputTokens,
            maximumOutputTokens: Math.min(remaining.outputTokens, prepared.maximumOutputTokens),
            maximumCost: remaining.cost,
            timeoutMilliseconds: prepared.timeoutMilliseconds,
          })
          .catch((error: unknown) => {
            if (
              error instanceof ScientificBudgetExceededError ||
              (error instanceof MissionApplicationError &&
                error.message === "PARENT_MODEL_BUDGET_EXHAUSTED")
            )
              throw new AgentInferenceBudgetError("PARENT_MODEL_BUDGET_EXHAUSTED");
            throw error;
          });
        try {
          await principalFor(request.sessionId);
          const reply = await prepared.inference.infer({
            ...request,
            remainingBudget: lease.remainingBudget,
          });
          if (
            !Number.isSafeInteger(reply.usage.inputTokens) ||
            !Number.isSafeInteger(reply.usage.outputTokens) ||
            reply.usage.inputTokens < 0 ||
            reply.usage.outputTokens < 0 ||
            reply.usage.inputTokens > lease.remainingBudget.inputTokens ||
            reply.usage.outputTokens > lease.remainingBudget.outputTokens ||
            !Number.isFinite(reply.usage.cost) ||
            reply.usage.cost < 0 ||
            reply.usage.cost > lease.remainingBudget.cost
          )
            throw new Error("MODEL_USAGE_EXCEEDS_PARENT_RESERVATION");
          await session.application.observeAgentInference(lease, {
            ...reply.usage,
            responseDigest: agentDigest(reply),
          });
          return reply;
        } catch (error) {
          try {
            await session.application.observeAgentInference(lease, { ambiguous: true });
          } catch {
            /* Keep a durable invoking/ambiguous fence if accounting is unavailable. */
          }
          throw error;
        }
      } finally {
        await session.close();
      }
    },
  };
  return {
    async infer(request) {
      try {
        return await bound.infer(request);
      } catch (error) {
        if (error instanceof AgentInferenceBudgetError) throw error;
        // Provider/DB exceptions can include endpoints, SQL or private keys.
        // This message is persisted in the journal and visible to HTTP actors.
        throw new Error("MISSION_MODEL_INFERENCE_UNAVAILABLE");
      }
    },
  };
}
