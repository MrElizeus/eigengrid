import { digestCanonical } from "@eigengrid/scientific-schema";
import {
  resolveScientificSkillGraph,
  type ScientificSkillFragment,
} from "@eigengrid/scientific-skills";
import { skillKey, type CatalogSnapshot } from "./catalog";
import type {
  ContextRequest,
  RetrievalContext,
  RetrievalRequest,
  RetrievalResult,
} from "./contracts";
import { assessApplicability } from "./ranking";

const REQUIRED_KINDS = new Set(["protocols", "decision_rules", "diagnostics", "validation"]);

export function selectRetrievalContext(
  snapshot: CatalogSnapshot,
  result: RetrievalResult,
  request: RetrievalRequest,
  options: ContextRequest = {},
): RetrievalContext {
  if (
    options.maxRoots !== undefined &&
    (!Number.isInteger(options.maxRoots) || options.maxRoots < 1 || options.maxRoots > 20)
  )
    throw new Error("maxRoots must be between 1 and 20");
  if (options.roots && options.roots.length > 20)
    throw new Error("At most 20 exact roots may be selected");
  if (
    result.corpusDigest !== snapshot.registry.corpusDigest ||
    result.scopeDigest !== snapshot.scopeDigest
  )
    throw new Error("Retrieval view changed; search again before selecting context");
  const roots =
    options.roots ??
    result.hits
      .filter((hit) => hit.applicability !== "incompatible")
      .slice(0, options.maxRoots ?? 1)
      .map((hit) => hit.skill);
  const base = {
    corpusDigest: snapshot.registry.corpusDigest,
    scopeDigest: snapshot.scopeDigest,
    executionAuthorized: false as const,
  };
  const empty = (
    status: "empty" | "unavailable" | "ambiguous",
    diagnostic?: string,
  ): RetrievalContext => ({
    ...base,
    status,
    fragments: [],
    resolved: [],
    missingRequiredFragmentIds: [],
    totalCharacters: 0,
    requiredCharacters: 0,
    selectionDigest: digestCanonical({
      ...base,
      status,
      diagnostic: diagnostic ?? null,
      retrievalDigest: result.retrievalDigest,
    }),
    ...(diagnostic ? { diagnostic } : {}),
  });
  if (!roots.length) return empty("empty");
  if (result.ambiguous && !options.roots)
    return empty(
      "ambiguous",
      "Inspect candidates or supply explicitly selected, version-pinned roots before composing context",
    );
  if (
    roots.some((root) => {
      const skill = snapshot.registry.exact(root.skillId, root.version);
      return (
        !skill ||
        skill.contentDigest !== root.contentDigest ||
        assessApplicability(skill, request).applicability === "incompatible"
      );
    })
  )
    return empty(
      "unavailable",
      "A requested root is unavailable or incompatible in this authorized view",
    );
  let resolved;
  try {
    resolved = resolveScientificSkillGraph(snapshot.registry, {
      requested: roots.map((root) => ({ id: root.skillId, range: root.version })),
      engine: request.engine?.version
        ? { id: request.engine.id, version: request.engine.version }
        : undefined,
      minimumKnowledgeMaturity: request.minimumKnowledgeMaturity,
      requiredCapability: request.requiredCapability,
      activeConditions: request.activeConditions,
      includeOptional: false,
    });
  } catch {
    // Resolver details can contain names from inaccessible dependencies; do not surface them.
    return empty(
      "unavailable",
      "Required dependency closure is unavailable or incompatible in this authorized view",
    );
  }
  if (
    resolved.skills.some(
      (skill) => assessApplicability(skill, request).applicability === "incompatible",
    )
  )
    return empty("unavailable", "A required dependency does not satisfy the declared constraints");
  const keys = new Set(
    resolved.skills.map((skill) => skillKey(skill.manifest.id, skill.manifest.version)),
  );
  const candidates = snapshot.fragments.filter((fragment) =>
    keys.has(skillKey(fragment.reference.skillId, fragment.reference.version)),
  );
  const required = new Set(options.requiredFragmentIds ?? []);
  for (const key of keys) {
    const summary = candidates.find(
      (fragment) =>
        skillKey(fragment.reference.skillId, fragment.reference.version) === key &&
        fragment.assetKind === "summary",
    );
    if (summary) required.add(summary.reference.fragmentId);
  }
  for (const fragment of candidates)
    if (REQUIRED_KINDS.has(fragment.assetKind)) required.add(fragment.reference.fragmentId);
  if (
    [...required].some((id) => !candidates.some((fragment) => fragment.reference.fragmentId === id))
  )
    return empty(
      "unavailable",
      "A required fragment is unavailable in the selected dependency closure",
    );
  const maxCharacters = options.maxCharacters ?? 24000;
  const maxFragments = options.maxFragments ?? 32;
  if (
    !Number.isInteger(maxCharacters) ||
    maxCharacters < 0 ||
    maxCharacters > 1000000 ||
    !Number.isInteger(maxFragments) ||
    maxFragments < 0 ||
    maxFragments > 10000
  )
    throw new Error("Invalid context budget");
  const preferred = new Set(result.hits.flatMap((hit) => hit.fragmentIds));
  const ranked = [...candidates].sort(
    (a, b) =>
      Number(required.has(b.reference.fragmentId)) - Number(required.has(a.reference.fragmentId)) ||
      Number(preferred.has(b.reference.fragmentId)) -
        Number(preferred.has(a.reference.fragmentId)) ||
      a.reference.fragmentId.localeCompare(b.reference.fragmentId),
  );
  const selected: ScientificSkillFragment[] = [];
  let totalCharacters = 0;
  for (const fragment of ranked) {
    if (
      selected.length >= maxFragments ||
      totalCharacters + fragment.content.length > maxCharacters
    )
      continue;
    selected.push(fragment);
    totalCharacters += fragment.content.length;
  }
  const included = new Set(selected.map((fragment) => fragment.reference.fragmentId));
  const missingRequiredFragmentIds = [...required].filter((id) => !included.has(id)).sort();
  selected.sort((a, b) => a.reference.fragmentId.localeCompare(b.reference.fragmentId));
  const references = resolved.graph.nodes;
  const status = missingRequiredFragmentIds.length ? "budget_insufficient" : "complete";
  return {
    ...base,
    status,
    fragments: selected,
    resolved: references,
    missingRequiredFragmentIds,
    totalCharacters,
    requiredCharacters: candidates
      .filter((fragment) => required.has(fragment.reference.fragmentId))
      .reduce((sum, fragment) => sum + fragment.content.length, 0),
    selectionDigest: digestCanonical({
      ...base,
      retrievalDigest: result.retrievalDigest,
      graphDigest: resolved.graph.graphDigest,
      policy: "conservative-required-assets/v1",
      status,
      required: [...required].sort(),
      references: selected.map((fragment) => fragment.reference),
      maxCharacters,
      maxFragments,
    }),
  };
}
