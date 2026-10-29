import type { ScientificSkillRegistry } from "./registry";
import type { LoadedScientificSkill, SkillSearchHit, SkillSearchResult } from "./types";

const STOP_WORDS = new Set([
  "and",
  "for",
  "the",
  "with",
  "from",
  "this",
  "that",
  "use",
  "need",
  "want",
  "calculation",
  "scientific",
  "como", "puedo", "para", "con", "los", "las", "del", "que", "una", "unos", "unas", "ver", "elegir", "quiero", "necesito",
]);

const SCIENTIFIC_QUERY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  protocolo: "protocol", protocolos: "protocol",
  optimizacion: "optimization", geometria: "geometry", frecuencias: "frequencies",
  dinamica: "dynamics", dinamicas: "dynamics",
  simulacion: "simulation", simulaciones: "simulation",
  produccion: "production", equilibracion: "equilibration", equilibrado: "equilibration",
  minimizacion: "minimization", cuantica: "quantum", cuantico: "quantum",
  ligando: "ligand", ligandos: "ligand", proteina: "protein", proteinas: "protein",
  membrana: "membrane", membranas: "membrane",
});

function queryTerms(query: string): string[] {
  const normalized = query.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
  return [...new Set(normalized.split(/[^a-z0-9]+/u).map((term) => Object.hasOwn(SCIENTIFIC_QUERY_ALIASES, term) ? SCIENTIFIC_QUERY_ALIASES[term] : term))]
    .filter((term) => term.length > 2 && !STOP_WORDS.has(term))
    .sort();
}

function scoreSkill(
  skill: LoadedScientificSkill,
  terms: readonly string[],
  query: string,
): SkillSearchHit {
  const id = skill.manifest.id.toLowerCase();
  const title = skill.manifest.title.toLowerCase();
  const description = `${skill.manifest.summary} ${skill.frontmatter.description}`.toLowerCase();
  const matchedTerms: string[] = [];
  let score = 0;
  for (const term of terms) {
    let matched = false;
    if (id.split(/[.-]/u).includes(term)) {
      score += 12;
      matched = true;
    } else if (id.includes(term)) {
      score += 8;
      matched = true;
    }
    if (title.split(/[^a-z0-9]+/u).includes(term)) {
      score += 8;
      matched = true;
    } else if (title.includes(term)) {
      score += 4;
      matched = true;
    }
    if (description.includes(term)) {
      score += 3;
      matched = true;
    }
    if (skill.searchableText.includes(term)) {
      score += 1;
      matched = true;
    }
    if (matched) matchedTerms.push(term);
  }
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery && description.includes(normalizedQuery)) score += 10;
  if (normalizedQuery && id === normalizedQuery) score += 50;
  return {
    skill: {
      skillId: skill.manifest.id,
      version: skill.manifest.version,
      contentDigest: skill.contentDigest,
    },
    title: skill.manifest.title,
    description: skill.manifest.summary,
    score,
    matchedTerms,
  };
}

export interface SkillSearchOptions {
  limit?: number;
  domains?: readonly string[];
  includeDeprecated?: boolean;
  candidateIds?: readonly string[];
}

/** Authoritative lexical search. A derived semantic index may only provide candidateIds. */
export function searchScientificSkills(
  registry: ScientificSkillRegistry,
  query: string,
  options: SkillSearchOptions = {},
): SkillSearchResult {
  const terms = queryTerms(query);
  const candidateIds = options.candidateIds ? new Set(options.candidateIds) : undefined;
  const hits = registry
    .all()
    .filter((skill) => !candidateIds || candidateIds.has(skill.manifest.id))
    .filter((skill) => options.includeDeprecated || skill.manifest.status === "active")
    .filter(
      (skill) =>
        !options.domains?.length ||
        options.domains.some((domain) => skill.manifest.domains.includes(domain)),
    )
    .map((skill) => scoreSkill(skill, terms, query))
    .filter((hit) => terms.length === 0 || hit.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.skill.skillId.localeCompare(right.skill.skillId) ||
        left.skill.version.localeCompare(right.skill.version),
    )
    .slice(0, options.limit ?? 20);
  const top = hits[0]?.score ?? 0;
  const second = hits[1]?.score ?? 0;
  return { query, hits, ambiguous: top === 0 || (second > 0 && top - second < 3) };
}

/** Rebuildable indexes rank candidate ids only; repository manifests remain authoritative. */
export interface RebuildableSemanticSkillIndex {
  readonly corpusDigest: string;
  rebuild(skills: readonly LoadedScientificSkill[]): Promise<void>;
  candidates(query: string, limit: number): Promise<readonly string[]>;
}
