import { tool as aiTool, jsonSchema, type ModelMessage } from "ai";
import { ModelGateway } from "@eigengrid/model-gateway";
import { canonicalAgentJson } from "@eigengrid/agent-runtime";
import type {
  AgentInferencePort,
  AgentInferenceRequest,
  AgentInferenceReply,
  AgentEvent,
} from "@eigengrid/agent-runtime";
import type { AgentModelResolution } from "./agent-loop";

/** The AI SDK is a single-inference adapter. It NEVER receives executable tools. */
export class AiSdkInferencePort implements AgentInferencePort {
  constructor(
    readonly resolution: AgentModelResolution,
    readonly system: string,
    readonly prior: readonly ModelMessage[] = [],
    readonly onTextDelta?: (text: string) => Promise<void>,
  ) {}

  async infer(request: AgentInferenceRequest): Promise<AgentInferenceReply> {
    const modelMessages: ModelMessage[] = [
      ...this.prior,
      { role: "user", content: request.prompt },
    ];
    for (const event of request.transcript) {
      if (event.type === "inference_observed") {
        const reply = event.reply;
        if (reply.calls.length > 0) {
          modelMessages.push({
            role: "assistant",
            content: [
              ...(reply.text ? [{ type: "text" as const, text: reply.text }] : []),
              ...reply.calls.map((c) => ({
                type: "tool-call" as const,
                toolCallId: c.id,
                toolName: c.name,
                input: c.input,
              })),
            ],
          });
        } else if (reply.text) modelMessages.push({ role: "assistant", content: reply.text });
      } else if (event.type === "effect_observed" || event.type === "effect_reconciled") {
        const o = event.observation;
        modelMessages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: o.id,
              toolName: o.tool,
              output: {
                type: "json",
                value: JSON.parse(canonicalAgentJson({ ok: o.ok, result: o.result })),
              },
            },
          ],
        });
      }
    }
    const descriptions: Record<string, ReturnType<typeof aiTool>> = {};
    for (const descriptor of request.tools) {
      descriptions[descriptor.name] = aiTool({
        description: descriptor.description,
        inputSchema: jsonSchema(descriptor.inputSchema),
      });
    }
    const gateway = this.resolution.gateway ?? new ModelGateway();
    const budget = this.resolution.budget;
    const maximumInputTokens = Math.min(
      budget?.maximumInputTokens ?? 1_000_000,
      request.remainingBudget?.inputTokens ?? Number.MAX_SAFE_INTEGER,
    );
    const maximumOutputTokens = Math.min(
      this.resolution.maxTokens,
      request.remainingBudget?.outputTokens ?? Number.MAX_SAFE_INTEGER,
    );
    const conversation = {
      ...(this.resolution.useGatewayProvider ? {} : { model: this.resolution.model }),
      ...(this.resolution.providerIdentity
        ? { providerIdentity: this.resolution.providerIdentity }
        : {}),
      system: request.answerOnly
        ? `${this.system}\n\n## Final response boundary\nThis is the final inference round allowed for this turn. Tools are disabled. Answer the user now using the observations already returned, in the user's language. Explain missing evidence or unsuccessful searches honestly. Do not propose another tool call, invent results, or claim an unobserved action succeeded.`
        : this.system,
      context: { toolDescriptors: request.tools },
      messages: modelMessages,
      tools: descriptions,
      maximumSteps: 1,
      temperature: this.resolution.temperature,
      maxOutputTokens: maximumOutputTokens,
      timeoutMilliseconds: this.resolution.timeoutMilliseconds ?? 30_000,
      maximumRawResponseBytes: this.resolution.maximumRawResponseBytes,
      signal: request.signal,
      budget: {
        maximumSteps: 1,
        maximumCalls: 1,
        maximumInputTokens,
        maximumOutputTokens,
        maximumTotalTokens: maximumInputTokens + maximumOutputTokens,
        maximumCost: Math.min(
          budget?.maximumCost ?? Number.MAX_SAFE_INTEGER,
          request.remainingBudget?.cost ?? Number.MAX_SAFE_INTEGER,
        ),
      },
    };
    const execution = await (async () => {
      if (!this.onTextDelta) return gateway.generateConversation(conversation);
      const streamingAbort = new AbortController();
      const stream = gateway.streamConversation({
        ...conversation,
        signal: conversation.signal
          ? AbortSignal.any([conversation.signal, streamingAbort.signal])
          : streamingAbort.signal,
      });
      void stream.metadata.catch(() => {});
      let textBytes = 0;
      try {
        for await (const part of stream.result.fullStream) {
          if (part.type === "error") throw part.error;
          if (part.type === "text-delta") {
            textBytes += Buffer.byteLength(part.text);
            if (textBytes > 1_000_000)
              throw new Error("Native inference text exceeds presentation limit");
            await this.onTextDelta(part.text);
          }
        }
        const [text, toolCalls, metadata] = await Promise.all([
          stream.result.text,
          stream.result.toolCalls,
          stream.metadata,
        ]);
        return { result: { text, toolCalls }, metadata };
      } finally {
        streamingAbort.abort();
      }
    })();
    const calls = execution.result.toolCalls.map((c) => ({
      id: c.toolCallId,
      name: c.toolName,
      input: c.input,
    }));
    return {
      text: execution.result.text ?? "",
      calls,
      provider: execution.metadata.provider.providerId,
      usage: {
        inputTokens: execution.metadata.usage.inputTokens,
        outputTokens: execution.metadata.usage.outputTokens,
        cost: execution.metadata.usage.cost,
        costPerInputToken: execution.metadata.usage.costPerInputToken,
        costPerOutputToken: execution.metadata.usage.costPerOutputToken,
      },
    };
  }
}
export function completedConversationHistory(
  original: readonly ModelMessage[],
  prompt: string,
  transcript: readonly AgentEvent[],
  finalText: string,
): ModelMessage[] {
  // Historical TUI API returns messages for the next conversational turn. We keep
  // the model-visible user prompt and final text, not privileged internal events.
  void transcript;
  return [
    ...original,
    { role: "user", content: prompt },
    { role: "assistant", content: finalText },
  ];
}
