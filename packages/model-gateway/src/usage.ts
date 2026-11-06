import { type LanguageModelUsage } from "ai";
import { z } from "zod";
import { type ModelInvocationBudget } from "./contracts";

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export function reserveUnknownInvocationUsage(
  totals: UsageTotals,
  budget: ModelInvocationBudget,
): { inputTokens: number; outputTokens: number; cost: number } {
  // The single total-token budget cannot independently reserve every remaining
  // input and output token when their maxima overlap. Allocate it deterministically
  // to input first: the upstream may consume the complete request before producing
  // any observable result. Output receives only the remaining total-token capacity.
  const remainingInputTokens = Math.max(
    0,
    Math.floor(budget.maximumInputTokens - totals.inputTokens),
  );
  const remainingTotalBeforeInput = Math.max(
    0,
    Math.floor(budget.maximumTotalTokens - totals.inputTokens - totals.outputTokens),
  );
  const inputTokens = Math.min(remainingInputTokens, remainingTotalBeforeInput);
  totals.inputTokens += inputTokens;

  const remainingOutputTokens = Math.max(
    0,
    Math.floor(budget.maximumOutputTokens - totals.outputTokens),
  );
  const remainingTotalTokens = Math.max(
    0,
    Math.floor(budget.maximumTotalTokens - totals.inputTokens - totals.outputTokens),
  );
  const outputTokens = Math.min(remainingOutputTokens, remainingTotalTokens);
  const cost = Math.max(0, budget.maximumCost - totals.cost);
  totals.outputTokens += outputTokens;
  totals.cost += cost;
  return { inputTokens, outputTokens, cost };
}

export function normalizeLanguageModelUsage(usage: LanguageModelUsage | undefined): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  const inputTokens = usage?.inputTokens;
  const outputTokens = usage?.outputTokens;
  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    inputTokens! < 0 ||
    outputTokens! < 0 ||
    !Number.isSafeInteger(inputTokens! + outputTokens!)
  )
    throw new Error("Model token usage is unknown or invalid; retain the invocation reservation");
  const totalTokens = usage?.totalTokens ?? inputTokens! + outputTokens!;
  if (!Number.isSafeInteger(totalTokens) || totalTokens < inputTokens! + outputTokens!)
    throw new Error("Model total token usage is invalid; retain the invocation reservation");
  return {
    inputTokens: inputTokens!,
    outputTokens: outputTokens!,
    totalTokens,
  };
}

export function wouldExceedBudget(
  totals: UsageTotals,
  budget: ModelInvocationBudget,
  nextInputTokens = 0,
): string | undefined {
  if (totals.calls >= budget.maximumCalls) return "maximum model calls exhausted";
  if (totals.inputTokens + nextInputTokens > budget.maximumInputTokens) {
    return "maximum input tokens exhausted";
  }
  if (totals.inputTokens + totals.outputTokens + nextInputTokens > budget.maximumTotalTokens) {
    return "maximum total tokens exhausted";
  }
  if (totals.outputTokens >= budget.maximumOutputTokens) return "maximum output tokens exhausted";
  if (totals.cost > budget.maximumCost) return "maximum model cost exhausted";
  return undefined;
}

export function exceededBudget(
  totals: UsageTotals,
  budget: ModelInvocationBudget,
): string | undefined {
  if (totals.calls > budget.maximumCalls) return "maximum model calls exceeded";
  if (totals.inputTokens > budget.maximumInputTokens) return "maximum input tokens exceeded";
  if (totals.outputTokens > budget.maximumOutputTokens) return "maximum output tokens exceeded";
  if (totals.inputTokens + totals.outputTokens > budget.maximumTotalTokens) {
    return "maximum total tokens exceeded";
  }
  if (totals.cost > budget.maximumCost) return "maximum model cost exceeded";
  return undefined;
}

interface ReportedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}

function readProperty(value: unknown, property: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    return Reflect.get(value, property);
  } catch {
    return undefined;
  }
}

export function reportedUsage(value: unknown): ReportedUsage {
  const usage = readProperty(value, "usage");
  const inputTokens = z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .safeParse(readProperty(usage, "inputTokens"));
  const outputTokens = z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .safeParse(readProperty(usage, "outputTokens"));
  const cost = z.number().finite().nonnegative().safeParse(readProperty(usage, "cost"));
  return {
    ...(inputTokens.success ? { inputTokens: inputTokens.data } : {}),
    ...(outputTokens.success ? { outputTokens: outputTokens.data } : {}),
    ...(cost.success ? { cost: cost.data } : {}),
  };
}
