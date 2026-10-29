/** Wire-level efforts supported by the Responses reasoning contract. */
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

export interface ReasoningLevel {
  effort: ReasoningEffort;
  description?: string;
}

/** Keep client orchestration modes, such as ultra, out of model API parameters. */
export function parseReasoningLevels(value: unknown): ReasoningLevel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  return value.flatMap((item) => {
    const raw =
      typeof item === "string"
        ? { effort: item }
        : item && typeof item === "object"
          ? (item as Record<string, unknown>)
          : {};
    if (!isReasoningEffort(raw.effort) || seen.has(raw.effort)) return [];
    seen.add(raw.effort);
    return [
      {
        effort: raw.effort,
        ...(typeof raw.description === "string"
          ? { description: raw.description.slice(0, 300) }
          : {}),
      },
    ];
  });
}
