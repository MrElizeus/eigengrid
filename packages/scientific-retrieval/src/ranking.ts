import {
  scientificQueryTerms,
  satisfiesSemver,
  type LoadedScientificSkill,
} from "@eigengrid/scientific-skills";
import type { RetrievalDocument } from "./documents";
import type { RetrievalHit, RetrievalRequest } from "./contracts";
import { skillKey } from "./catalog";

export interface RankedDocument {
  id: string;
  score: number;
}

/** BM25 over fragment windows. ID equality is handled separately at protocol level. */
export function lexicalCandidates(
  documents: readonly RetrievalDocument[],
  query: string,
): RankedDocument[] {
  const terms = scientificQueryTerms(query);
  if (!terms.length) return [];
  const frequencies = documents.map((document) => {
    const counts = new Map<string, number>();
    for (const token of document.text.split(/\s+/u).flatMap(scientificQueryTerms))
      counts.set(token, (counts.get(token) ?? 0) + 1);
    return counts;
  });
  const lengths = frequencies.map((counts) => [...counts.values()].reduce((a, b) => a + b, 0));
  const mean = lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length) || 1;
  const df = new Map(
    terms.map((term) => [term, frequencies.filter((counts) => counts.has(term)).length]),
  );
  return documents
    .map((document, index) => ({
      id: document.id,
      score: terms.reduce((score, term) => {
        const tf = frequencies[index].get(term) ?? 0;
        const idf = Math.log(1 + (documents.length - df.get(term)! + 0.5) / (df.get(term)! + 0.5));
        return score + (idf * (tf * 2.2)) / (tf + 1.2 * (0.25 + (0.75 * lengths[index]) / mean));
      }, 0),
    }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export interface RankedSkill {
  key: string;
  fragments: string[];
  score: number;
}

/** Collapse windows before fusion so a long protocol cannot vote hundreds of times. */
export function collapseCandidates(
  ranked: readonly RankedDocument[],
  documents: readonly RetrievalDocument[],
): RankedSkill[] {
  const byId = new Map(documents.map((document) => [document.id, document]));
  const skills = new Map<string, RankedSkill>();
  for (const hit of ranked) {
    const document = byId.get(hit.id);
    if (!document) continue;
    const key = skillKey(document.reference.skillId, document.reference.version);
    const prior = skills.get(key);
    if (!prior)
      skills.set(key, { key, score: hit.score, fragments: [document.reference.fragmentId] });
    else if (prior.fragments.length < 8 && !prior.fragments.includes(document.reference.fragmentId))
      prior.fragments.push(document.reference.fragmentId);
  }
  return [...skills.values()];
}

export function reciprocalRankFusion(
  lexical: readonly RankedSkill[],
  vector: readonly RankedSkill[],
  k: number,
): Array<RankedSkill & { lexicalRank?: number; vectorRank?: number }> {
  if (!Number.isFinite(k) || k < 1 || k > 1000) throw new Error("RRF k must be between 1 and 1000");
  const fused = new Map<string, RankedSkill & { lexicalRank?: number; vectorRank?: number }>();
  for (const [list, field] of [
    [lexical, "lexicalRank"],
    [vector, "vectorRank"],
  ] as const) {
    list.forEach((hit, index) => {
      const prior = fused.get(hit.key) ?? { key: hit.key, fragments: [], score: 0 };
      prior.score += 1 / (k + index + 1);
      prior[field] = index + 1;
      prior.fragments = [...new Set([...prior.fragments, ...hit.fragments])];
      fused.set(hit.key, prior);
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

const MATURITY = [
  "draft",
  "reference_curated",
  "expert_reviewed",
  "benchmark_backed",
  "production_certified",
];

/** Matching constraints is explicitly weaker than scientific applicability or execution permission. */
export function assessApplicability(
  skill: LoadedScientificSkill,
  request: RetrievalRequest,
): Pick<RetrievalHit, "applicability" | "reasons"> {
  const m = skill.manifest;
  const reasons: string[] = [];
  let incompatible = false;
  const reject = (reason: string) => {
    reasons.push(reason);
    incompatible = true;
  };
  if (m.status !== "active") reject("protocol_not_active");
  if (request.engine) {
    const range = m.engine_compatibility[request.engine.id];
    if (
      Object.keys(m.engine_compatibility).length &&
      (!range || (request.engine.version && !satisfiesSemver(request.engine.version, range)))
    )
      reject("engine_incompatible");
    else if (!request.engine.version) reasons.push("engine_version_unknown");
  } else reasons.push("engine_not_checked");
  if (
    request.minimumKnowledgeMaturity &&
    MATURITY.indexOf(m.knowledge_level) < MATURITY.indexOf(request.minimumKnowledgeMaturity)
  )
    reject("maturity_below_required");
  if (request.requiredCapability) {
    const level = request.requiredCapability;
    const c = m.capability_levels;
    const engine = request.engine;
    if (level === "reference" || level === "advisory" || level === "plannable") {
      if (!c[level]) reject("capability_unavailable");
    } else if (!engine?.version) reasons.push("capability_engine_version_unknown");
    else if (level === "validated") {
      if (!c.validated[engine.id]) reject("capability_unavailable");
    } else if (!c[level][engine.id] || !satisfiesSemver(engine.version, c[level][engine.id]))
      reject("capability_unavailable");
  }
  if (m.required_inputs.length) {
    if (!request.availableInputs) reasons.push("required_inputs_unchecked");
    else if (m.required_inputs.some((input) => !request.availableInputs!.includes(input)))
      reject("required_inputs_missing");
  }
  if (m.review.status !== "expert_reviewed") reasons.push("scientific_review_pending");
  if (!Object.values(m.capability_levels.validated).some(Boolean))
    reasons.push("installation_qualification_not_established");
  if (
    m.review.review_before &&
    m.review.review_before < (request.asOf ?? new Date().toISOString().slice(0, 10))
  )
    reasons.push("review_expired");
  if (m.conflicts.some((conflict) => conflict.when && !request.activeConditions))
    reasons.push("conditional_conflicts_unchecked");
  return {
    applicability: incompatible
      ? "incompatible"
      : reasons.length
        ? "unknown"
        : "constraints_matched",
    reasons,
  };
}

export function scientificOrder(a: RetrievalHit, b: RetrievalHit): number {
  const rank = { incompatible: 0, unknown: 1, constraints_matched: 2 };
  // Constraints dominate similarity. Maturity breaks close ties without granting authority.
  return (
    rank[b.applicability] - rank[a.applicability] ||
    b.score - a.score ||
    MATURITY.indexOf(b.knowledgeLevel) - MATURITY.indexOf(a.knowledgeLevel) ||
    a.skill.skillId.localeCompare(b.skill.skillId) ||
    a.skill.version.localeCompare(b.skill.version)
  );
}
