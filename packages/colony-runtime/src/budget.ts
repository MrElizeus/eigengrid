import type { Budget, Usage } from "@eigengrid/colony-contracts";
import { z } from "zod";

const counter = z.number().int().nonnegative().safe();

export const ColonyBudgetSchema = z
  .object({
    modelCalls: counter,
    inputTokens: counter,
    outputTokens: counter,
    costMicrounits: counter,
    wallTimeMs: z.number().int().positive().safe(),
    corrections: counter,
    frontierCalls: counter,
    effects: counter,
    computeSeconds: counter,
  })
  .strict();
export type ColonyBudget = z.infer<typeof ColonyBudgetSchema>;

export const ColonyUsageSchema = ColonyBudgetSchema.extend({
  wallTimeMs: counter,
}).strict();
export type ColonyUsage = z.infer<typeof ColonyUsageSchema>;

export const COLONY_BUDGET_DIMENSIONS = [
  "modelCalls",
  "inputTokens",
  "outputTokens",
  "costMicrounits",
  "wallTimeMs",
  "corrections",
  "frontierCalls",
  "effects",
  "computeSeconds",
] as const satisfies readonly (keyof ColonyBudget)[];

export const ZERO_COLONY_USAGE: Readonly<ColonyUsage> = Object.freeze({
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costMicrounits: 0,
  wallTimeMs: 0,
  corrections: 0,
  frontierCalls: 0,
  effects: 0,
  computeSeconds: 0,
});

export class ColonyBudgetExceededError extends Error {
  constructor(
    readonly dimension: keyof ColonyBudget,
    readonly attempted: number,
    readonly limit: number,
    readonly subject: string,
  ) {
    super(`${subject} ${dimension} budget exceeded: ${attempted} > ${limit}`);
    this.name = "ColonyBudgetExceededError";
  }
}

export function addUsage(left: ColonyUsage, right: ColonyUsage): ColonyUsage {
  const sum = Object.fromEntries(
    COLONY_BUDGET_DIMENSIONS.map((dimension) => [dimension, left[dimension] + right[dimension]]),
  );
  return ColonyUsageSchema.parse(sum);
}

export function assertUsageWithin(usage: ColonyUsage, budget: ColonyBudget, subject: string): void {
  for (const dimension of COLONY_BUDGET_DIMENSIONS) {
    if (usage[dimension] > budget[dimension]) {
      throw new ColonyBudgetExceededError(dimension, usage[dimension], budget[dimension], subject);
    }
  }
}

export function contractUsageToColonyUsage(usage: Usage): ColonyUsage {
  return ColonyUsageSchema.parse({
    modelCalls: usage.modelCalls,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costMicrounits: usage.costMicrounits,
    wallTimeMs: usage.wallTimeMs,
    corrections: usage.corrections,
    frontierCalls: 0,
    effects: usage.effects,
    computeSeconds: usage.computeSeconds,
  });
}

export function contractBudgetToColonyBudget(budget: Budget): ColonyBudget {
  return ColonyBudgetSchema.parse({
    modelCalls: budget.modelCalls,
    inputTokens: budget.inputTokens,
    outputTokens: budget.outputTokens,
    costMicrounits: budget.costMicrounits,
    wallTimeMs: budget.wallTimeMs,
    corrections: budget.corrections,
    frontierCalls: 0,
    effects: budget.effects,
    computeSeconds: budget.computeSeconds,
  });
}

export function assertNestedBudgets(
  parent: ColonyBudget,
  children: readonly { id: string; budget: ColonyBudget }[],
): void {
  const allocated = children.reduce(
    (sum, child) => addUsage(sum, ColonyUsageSchema.parse(child.budget)),
    ColonyUsageSchema.parse(ZERO_COLONY_USAGE),
  );
  assertUsageWithin(allocated, parent, "campaign child allocation");
}
