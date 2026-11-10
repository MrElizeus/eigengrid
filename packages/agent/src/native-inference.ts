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
  private presentedEvents = 0;
  /** Presentation context only; incomplete text is never a verified inference reply. */
  partialText = "";
  constructor(
    readonly resolution: AgentModelResolution,
    readonly system: string,
    readonly prior: readonly ModelMessage[] = [],
    readonly onTextDelta?: (text: string) => Promise<void>,
    readonly onSteering?: (messages: readonly string[]) => Promise<void>,
  ) {}

  async infer(request: AgentInferenceRequest): Promise<AgentInferenceReply> {
    this.partialText = "";
    const modelMessages = conversationMessages(this.prior, request.prompt, request.transcript);
    // Publish accepted user input in transcript order before the next response.
    for (const event of request.transcript.slice(this.presentedEvents)) {
      if (event.type === "steering_received") await this.onSteering?.(event.messages);
    }
    this.presentedEvents = request.transcript.length;
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
      timeoutMilliseconds: this.resolution.timeoutMilliseconds ?? 300_000,
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
            this.partialText += part.text;
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
    this.partialText = "";
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
/** Reconstruct model context, including superseded proposals with explicit non-execution results. */
export function conversationMessages(
  original: readonly ModelMessage[],
  prompt: string,
  transcript: readonly AgentEvent[],
): ModelMessage[] {
  const messages: ModelMessage[] = [...original, { role: "user", content: prompt }];
  const started = new Set<string>();
  const pending = new Map<string, { id: string; name: string }>();
  for (const event of transcript) {
    if (event.type === "inference_observed") {
      const { reply } = event;
      if (reply.calls.length) {
        messages.push({
          role: "assistant",
          content: [
            ...(reply.text ? [{ type: "text" as const, text: reply.text }] : []),
            ...reply.calls.map((call) => {
              pending.set(call.id, call);
              return {
                type: "tool-call" as const,
                toolCallId: call.id,
                toolName: call.name,
                input: call.input,
              };
            }),
          ],
        });
      } else if (reply.text) messages.push({ role: "assistant", content: reply.text });
    } else if (event.type === "effect_observed" || event.type === "effect_reconciled") {
      const o = event.observation;
      pending.delete(o.id);
      messages.push({
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
    } else if (event.type === "effect_intent") {
      started.add(event.call.id);
    } else if (event.type === "terminated") {
      for (const call of pending.values()) {
        messages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: call.id,
              toolName: call.name,
              output: {
                type: "error-text",
                value: started.has(call.id)
                  ? "Outcome unconfirmed. Inspect canonical evidence before retrying this operation."
                  : "Not executed: the agent stopped before dispatch.",
              },
            },
          ],
        });
      }
      pending.clear();
    } else if (event.type === "steering_received") {
      // This is model context, never an execution receipt or a successful result.
      for (const call of pending.values()) {
        messages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: call.id,
              toolName: call.name,
              output: {
                type: "error-text",
                value: "Not executed: superseded by new user instructions.",
              },
            },
          ],
        });
      }
      pending.clear();
      messages.push(...event.messages.map((content) => ({ role: "user" as const, content })));
    }
  }
  return messages;
}

export function completedConversationHistory(
  original: readonly ModelMessage[],
  prompt: string,
  transcript: readonly AgentEvent[],
  finalText: string,
  retainToolHistory = false,
): ModelMessage[] {
  if (
    retainToolHistory ||
    transcript.some((event) => event.type === "steering_received" || event.type === "terminated")
  ) {
    const messages = conversationMessages(original, prompt, transcript);
    const last = messages.at(-1);
    if (last?.role !== "assistant" || last.content !== finalText)
      messages.push({ role: "assistant", content: finalText });
    return messages;
  }
  return [
    ...original,
    { role: "user", content: prompt },
    { role: "assistant", content: finalText },
  ];
}
