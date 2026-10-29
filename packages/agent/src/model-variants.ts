import { isReasoningEffort, type ReasoningEffort } from "@eigengrid/model-gateway";
import type { ChatGptModel } from "./chatgpt-auth";
import type { LlmConfig } from "./llm-client";

export interface ModelVariant {
  id: string;
  name: string;
  description: string;
  reasoningEffort?: ReasoningEffort;
}

/** Live metadata wins, including an explicitly empty list. Never guess proxy capabilities. */
export function modelVariants(
  model: ChatGptModel,
  config: Pick<LlmConfig, "authMode" | "providerName">,
): ModelVariant[] {
  let levels = model.reasoningLevels;
  if (
    levels === undefined &&
    config.authMode !== "chatgpt" &&
    config.providerName === "openai" &&
    model.reasoningProtocol === "openai"
  ) {
    // Official capability fallback for APIs whose model list exposes only IDs.
    // https://developers.openai.com/api/docs/guides/reasoning
    const match = /^(gpt-6\.1-sol|gpt-6-astra|gpt-6-sol|gpt-6-luna)(?:-\d{4}-\d{2}-\d{2})?$/.exec(
      model.id,
    );
    if (match) {
      const efforts: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
      if (match[1] === "gpt-6-sol" || match[1] === "gpt-6-luna") efforts.unshift("none");
      levels = efforts.map((effort) => ({ effort }));
    }
  }
  const supported =
    model.reasoningProtocol === "anthropic" ? ["low", "medium", "high", "xhigh", "max"] : undefined;
  const variants: ModelVariant[] = [
    { id: "default", name: "Provider default", description: "Send no reasoning override." },
  ];
  if (model.reasoningProtocol)
    for (const level of levels ?? []) {
      if (!isReasoningEffort(level.effort)) continue;
      if (supported && !supported.includes(level.effort)) continue;
      variants.push({
        id: level.effort,
        name: level.effort,
        reasoningEffort: level.effort,
        description: level.description ?? `${level.effort} reasoning effort`,
      });
    }
  return variants;
}

export function assertModelVariant(
  model: ChatGptModel,
  config: Pick<LlmConfig, "authMode" | "providerName"> & { reasoningEffort?: ReasoningEffort },
): void {
  if (
    config.reasoningEffort !== undefined &&
    !modelVariants(model, config).some(
      (variant) => variant.reasoningEffort === config.reasoningEffort,
    )
  )
    throw new Error(
      "The selected reasoning variant is not available for this model and access method. Choose /variants again.",
    );
}
