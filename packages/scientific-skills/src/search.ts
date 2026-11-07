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
  preparar: "preparation", preparacion: "preparation", armar: "assembly", ensamblar: "assembly",
  sistema: "system", sistemas: "system", calentamiento: "heating", calentar: "heating",
  minimizar: "minimization", reinicio: "restart", reiniciar: "restart",
  parametros: "parameters", parametrizacion: "parameterization", cargas: "charges",
  validar: "validation", validacion: "validation", corregir: "repair", correccion: "repair",
  diagnostico: "diagnostics", fallo: "failure", fallos: "failure", errores: "failure",
  especializado: "specialized", especializados: "specialized", planificar: "planning",
  topologia: "topology", trayectoria: "trajectory", trayectorias: "trajectory",
  replicas: "replica", incertidumbre: "uncertainty",
  absorcion: "absorption", espectro: "spectrum", transicion: "transition",
  frecuencia: "frequency", imaginaria: "imaginary", imaginarias: "imaginary", barrera: "barrier",
  reduccion: "reduction", electrodo: "electrode", ferroceno: "ferrocene",
  dimero: "dimer", fantasma: "ghost", superposicion: "superposition", interaccion: "interaction",
  funcional: "functional", funcionales: "functional", convergencia: "convergence",
  poblaciones: "populations", conformeros: "conformer", espin: "spin",
  contaminado: "contamination", contaminacion: "contamination", multiplicidad: "multiplicity",
  periodico: "periodic", periodica: "periodic", celda: "cell", malla: "mesh",
  rmn: "nmr", blindaje: "shielding", blindajes: "shielding",
  desplazamientos: "shifts", protones: "proton", carbonos: "carbon",
  aromaticidad: "aromaticity", anillo: "ring", anillos: "ring",
  corriente: "current", corrientes: "currents", anular: "ring", anulares: "ring",
  sonda: "probe", sondas: "probe", barrido: "scan", periferico: "peripheral",
});

function orderedQueryTerms(query: string): string[] {
  const normalized = query.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
  return normalized
    .split(/[^a-z0-9]+/u)
    .map((term) =>
      Object.hasOwn(SCIENTIFIC_QUERY_ALIASES, term) ? SCIENTIFIC_QUERY_ALIASES[term] : term,
    )
    .filter((term) => term.length > 2 && !STOP_WORDS.has(term));
}

export function scientificQueryTerms(query: string): string[] {
  return [...new Set(orderedQueryTerms(query))].sort();
}

function queryPhrases(text: string): Set<string> {
  const words = orderedQueryTerms(text);
  return new Set(words.slice(1).map((word, index) => `${words[index]} ${word}`));
}

function scoreSkill(
  skill: LoadedScientificSkill,
  terms: readonly string[],
  query: string,
  phrases: ReadonlySet<string>,
): SkillSearchHit & { baseScore: number } {
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
  const baseScore = score;
  // Preserve ordered concepts in identity and summary fields. Each phrase votes
  // once per field; repetitions and full protocol bodies cannot inflate it.
  const idPhrases = queryPhrases(id);
  const titlePhrases = queryPhrases(title);
  const descriptionPhrases = new Set([
    ...queryPhrases(skill.manifest.summary),
    ...queryPhrases(skill.frontmatter.description),
  ]);
  for (const phrase of phrases) {
    if (idPhrases.has(phrase)) score += 12;
    if (titlePhrases.has(phrase)) score += 8;
    if (descriptionPhrases.has(phrase)) score += 4;
  }
  return {
    skill: {
      skillId: skill.manifest.id,
      version: skill.manifest.version,
      contentDigest: skill.contentDigest,
    },
    title: skill.manifest.title,
    description: skill.manifest.summary,
    score,
    baseScore,
    matchedTerms,
  };
}

export interface SkillSearchOptions {
  limit?: number;
  domains?: readonly string[];
  includeDeprecated?: boolean;
  candidateIds?: readonly string[];
}

/** Canonical lexical search with an optional union of derived semantic candidates. */
export function searchScientificSkills(
  registry: ScientificSkillRegistry,
  query: string,
  options: SkillSearchOptions = {},
): SkillSearchResult {
  const terms = scientificQueryTerms(query);
  const phrases = queryPhrases(query);
  const candidateIds = options.candidateIds ? new Set(options.candidateIds) : undefined;
  const candidates = registry
    .all()
    .filter((skill) => options.includeDeprecated || skill.manifest.status === "active")
    .filter(
      (skill) =>
        !options.domains?.length ||
        options.domains.some((domain) => skill.manifest.domains.includes(domain)),
    )
    .map((skill) => scoreSkill(skill, terms, query, phrases))
    .filter((hit) => terms.length === 0 || hit.score > 0 || candidateIds?.has(hit.skill.skillId));
  // Phrase order improves ranking, but must not hide an otherwise ambiguous
  // choice between plausible protocols. Ranking is not execution authority.
  const base = candidates.map((hit) => hit.baseScore).sort((a, b) => b - a);
  const baseAmbiguous = (base[0] ?? 0) === 0 || ((base[1] ?? 0) > 0 && base[0] - base[1] < 3);
  const hits = candidates
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.skill.skillId.localeCompare(right.skill.skillId) ||
        left.skill.version.localeCompare(right.skill.version),
    )
    .slice(0, options.limit ?? 20)
    .map(({ baseScore: _baseScore, ...hit }) => hit);
  const top = hits[0]?.score ?? 0;
  const second = hits[1]?.score ?? 0;
  return { query, hits, ambiguous: baseAmbiguous || top === 0 || (second > 0 && top - second < 3) };
}

/** Rebuildable indexes rank candidate ids only; repository manifests remain authoritative. */
export interface RebuildableSemanticSkillIndex {
  readonly corpusDigest: string;
  rebuild(skills: readonly LoadedScientificSkill[]): Promise<void>;
  candidates(query: string, limit: number): Promise<readonly string[]>;
}
