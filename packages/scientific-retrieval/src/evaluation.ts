import { digestCanonical } from "@eigengrid/scientific-schema";
import { searchScientificSkills } from "@eigengrid/scientific-skills";
import { z } from "zod";
import type { RetrievalRequest } from "./contracts";
import type { ScientificRetrievalService } from "./service";

export const RetrievalEvaluationCaseSchema = z
  .object({
    id: z.string().min(1),
    language: z.enum(["en", "es"]),
    query: z.string().min(1).max(2000),
    relevance: z.record(z.string(), z.number().int().min(1).max(3)),
    excluded: z.array(z.string()).default([]),
    dependencies: z.array(z.string()).default([]),
    criticalFragments: z
      .array(
        z
          .object({
            skillId: z.string(),
            relativePath: z.string(),
            selector: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    engine: z.object({ id: z.string(), version: z.string().optional() }).strict().optional(),
    exact: z.boolean().default(false),
    expectedAbstention: z.boolean().default(false),
  })
  .strict();
export type RetrievalEvaluationCase = z.infer<typeof RetrievalEvaluationCaseSchema>;

interface EvaluationRow {
  mode: string;
  caseId: string;
  language: string;
  repetition: number;
  ids: string[];
  recall: number | null;
  ndcg: number | null;
  latencyMs: number;
  effectiveMode: string;
  indexState: string;
  exactSuccess: boolean | null;
  incorrectSelection: boolean;
  excludedAtK: number;
  dependencyCoverage: number | null;
  criticalOmissions: number;
  criticalTotal: number;
  contextStatus: string;
  contextCharacters: number;
  estimatedContextTokens: number;
}

function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}
function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)] ?? 0;
}

export function rankingMetrics(
  ids: readonly string[],
  relevance: Readonly<Record<string, number>>,
  k: number,
) {
  const top = [...new Set(ids)].slice(0, k);
  const positive = Object.keys(relevance);
  const dcg = top.reduce(
    (sum, id, i) => sum + (2 ** (relevance[id] ?? 0) - 1) / Math.log2(i + 2),
    0,
  );
  const ideal = Object.values(relevance)
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((sum, gain, i) => sum + (2 ** gain - 1) / Math.log2(i + 2), 0);
  return {
    recall: positive.length ? top.filter((id) => relevance[id]).length / positive.length : null,
    ndcg: ideal ? dcg / ideal : null,
  };
}

/** Reproducible retrieval evaluation; proxy labels do not measure an LLM's scientific decisions. */
export async function evaluateScientificRetrieval(
  service: ScientificRetrievalService,
  cases: readonly RetrievalEvaluationCase[],
  options: { k?: number; repeats?: number; maxCharacters?: number } = {},
) {
  const k = options.k ?? 5;
  const repeats = options.repeats ?? 1;
  if (
    !cases.length ||
    cases.length > 1000 ||
    !Number.isInteger(k) ||
    k < 1 ||
    k > 100 ||
    !Number.isInteger(repeats) ||
    repeats < 1 ||
    repeats > 20
  )
    throw new Error("Invalid evaluation size or options");
  const parsed = cases.map((item) => RetrievalEvaluationCaseSchema.parse(item));
  if (new Set(parsed.map((item) => item.id)).size !== parsed.length)
    throw new Error("Duplicate evaluation case ID");
  const initial = service.snapshot();
  const rows: EvaluationRow[] = [];
  const modes = ["legacy_lexical", "lexical", "vector", "hybrid", "scientific"] as const;
  for (const mode of modes) {
    for (const item of parsed) {
      for (let repetition = 0; repetition < repeats; repetition++) {
        const request: RetrievalRequest = {
          query: item.query,
          engine: item.engine,
          mode: mode === "legacy_lexical" ? "lexical" : mode,
          limit: Math.max(k, 5),
        };
        const start = performance.now();
        const result = mode === "legacy_lexical" ? undefined : await service.search(request);
        const ids = result
          ? result.hits.map((hit) => hit.skill.skillId)
          : searchScientificSkills(service.snapshot().registry, item.query, { limit: k }).hits.map(
              (hit) => hit.skill.skillId,
            );
        const context =
          mode === "scientific" && result
            ? service.context(result, request, {
                maxCharacters: options.maxCharacters ?? 24000,
                maxFragments: 64,
              })
            : undefined;
        const latencyMs = performance.now() - start;
        const criticalOmissions = item.criticalFragments.filter(
          (required) =>
            !context?.fragments.some(
              (fragment) =>
                fragment.reference.skillId === required.skillId &&
                fragment.reference.relativePath === required.relativePath &&
                (!required.selector || fragment.reference.selector === required.selector),
            ),
        ).length;
        const top = ids.slice(0, k);
        rows.push({
          mode,
          caseId: item.id,
          language: item.language,
          repetition,
          ids: top,
          ...rankingMetrics(top, item.relevance, k),
          latencyMs,
          effectiveMode: result?.effectiveMode ?? "legacy_lexical",
          indexState: result?.indexState ?? "disabled",
          exactSuccess: item.exact ? Boolean(item.relevance[top[0]]) : null,
          incorrectSelection: item.expectedAbstention
            ? top.length > 0
            : Boolean(
                top[0] &&
                (!item.relevance[top[0]] ||
                  item.excluded.includes(top[0]) ||
                  result?.hits[0]?.applicability === "incompatible"),
              ),
          excludedAtK: top.filter((id) => item.excluded.includes(id)).length,
          dependencyCoverage: item.dependencies.length
            ? item.dependencies.filter((id) => context?.resolved.some((ref) => ref.skillId === id))
                .length / item.dependencies.length
            : null,
          criticalOmissions,
          criticalTotal: item.criticalFragments.length,
          contextStatus: context?.status ?? "not_selected",
          contextCharacters: context?.totalCharacters ?? 0,
          estimatedContextTokens: Math.ceil((context?.totalCharacters ?? 0) / 4),
        });
      }
    }
  }
  if (service.snapshot().revision !== initial.revision)
    throw new Error("Evaluation corpus or authorization changed");
  const summary = modes.map((mode) => {
    const selected = rows.filter((row) => row.mode === mode);
    return {
      mode,
      recallAtK: mean(selected.flatMap((row) => (row.recall === null ? [] : [row.recall]))),
      ndcgAtK: mean(selected.flatMap((row) => (row.ndcg === null ? [] : [row.ndcg]))),
      exactSuccessRate: mean(
        selected.flatMap((row) => (row.exactSuccess === null ? [] : [Number(row.exactSuccess)])),
      ),
      incorrectSelectionRate: mean(selected.map((row) => Number(row.incorrectSelection))),
      excludedAtK: selected.reduce((sum, row) => sum + row.excludedAtK, 0),
      dependencyCoverage:
        mode === "scientific"
          ? mean(
              selected.flatMap((row) =>
                row.dependencyCoverage === null ? [] : [row.dependencyCoverage],
              ),
            )
          : null,
      criticalOmissions:
        mode === "scientific"
          ? selected.reduce((sum, row) => sum + row.criticalOmissions, 0)
          : null,
      latencyP50Ms: percentile(
        selected.map((row) => row.latencyMs),
        0.5,
      ),
      latencyP95Ms: percentile(
        selected.map((row) => row.latencyMs),
        0.95,
      ),
      meanEstimatedContextTokens:
        mode === "scientific" ? mean(selected.map((row) => row.estimatedContextTokens)) : null,
      fallbackCount: selected.filter(
        (row) => mode !== "legacy_lexical" && row.effectiveMode !== mode,
      ).length,
    };
  });
  const lexical = summary[0];
  const scientific = summary[4];
  const gates = {
    realVectorIndexUsed: summary.slice(2).every((entry) => entry.fallbackCount === 0),
    exactLookupNonRegression: (scientific.exactSuccessRate ?? 0) >= (lexical.exactSuccessRate ?? 0),
    incorrectSelectionReduced:
      (scientific.incorrectSelectionRate ?? 1) < (lexical.incorrectSelectionRate ?? 1),
    dependencyCoverageComplete: scientific.dependencyCoverage === 1,
    noCriticalOmissions: scientific.criticalOmissions === 0,
  };
  return {
    schema: "eigengrid.retrieval-evaluation/v1",
    corpusDigest: initial.registry.corpusDigest,
    scopeDigest: initial.scopeDigest,
    casesDigest: digestCanonical(parsed),
    settings: { k, repeats, maxCharacters: options.maxCharacters ?? 24000 },
    embedding: service.status().embedding,
    summary,
    gates,
    enableHybridByDefault: false,
    qualification:
      "Exploratory retrieval labels; independent scientific review and agent decision evaluation are still required. Context tokens use a characters/4 estimate, not an LLM tokenizer.",
    rows,
  };
}
