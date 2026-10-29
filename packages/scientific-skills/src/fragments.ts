import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import {
  digestBytes,
  digestCanonical,
  type ResolvedSkillGraph,
  type SkillFragmentReference,
} from "@eigengrid/scientific-schema";
import { withResolvedScientificSkillGraphDigest } from "./graph-digest";
import type {
  LoadedScientificSkill,
  ResolvedScientificSkillGraph,
  ScientificSkillFragment,
  SelectedSkillContext,
} from "./types";

export interface FragmentLoadOptions {
  includeEvaluations?: boolean;
  assetKinds?: readonly string[];
}

function assetKind(relativePath: string): string {
  if (relativePath === "SKILL.md") return "summary";
  const [first] = relativePath.split("/");
  return first.replaceAll("-", "_").replace(/\.[^.]+$/u, "");
}

function mediaType(relativePath: string): ScientificSkillFragment["mediaType"] {
  const extension = extname(relativePath).toLowerCase();
  if (extension === ".md") return "text/markdown";
  if (extension === ".json") return "application/json";
  if (extension === ".jsonl") return "application/jsonl";
  if (extension === ".yaml" || extension === ".yml") return "application/yaml";
  return "text/plain";
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "") || "document"
  );
}

function markdownSections(content: string): Array<{ selector: string; content: string }> {
  const normalized = content.replaceAll("\r\n", "\n");
  const withoutFrontmatter = normalized.startsWith("---\n")
    ? normalized.slice(normalized.indexOf("\n---\n", 4) + 5)
    : normalized;
  const headings = [...withoutFrontmatter.matchAll(/^#{1,6}\s+(.+?)\s*$/gmu)];
  if (headings.length === 0) return [{ selector: "$", content: withoutFrontmatter.trim() }];
  const sections: Array<{ selector: string; content: string }> = [];
  const seen = new Map<string, number>();
  const preamble = withoutFrontmatter.slice(0, headings[0].index).trim();
  if (preamble) sections.push({ selector: "preamble", content: preamble });
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const start = heading.index!;
    const end = headings[index + 1]?.index ?? withoutFrontmatter.length;
    const base = `heading:${slug(heading[1])}`;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    sections.push({
      selector: occurrence === 1 ? base : `${base}:${occurrence}`,
      content: withoutFrontmatter.slice(start, end).trim(),
    });
  }
  return sections;
}

function fragmentReference(
  skill: LoadedScientificSkill,
  relativePath: string,
  selector: string,
  content: string,
): SkillFragmentReference {
  return {
    skillId: skill.manifest.id,
    version: skill.manifest.version,
    contentDigest: skill.contentDigest,
    fragmentId: `${skill.manifest.id}@${skill.manifest.version}:${relativePath}#${selector}`,
    fragmentDigest: digestBytes(content),
    relativePath,
    selector,
  };
}

/** Split repository assets into immutable, section-addressable fragments without interpreting authority. */
export function loadScientificSkillFragments(
  skill: LoadedScientificSkill,
  options: FragmentLoadOptions = {},
): ScientificSkillFragment[] {
  const allowedKinds = options.assetKinds ? new Set(options.assetKinds) : undefined;
  const fragments: ScientificSkillFragment[] = [];
  for (const relativePath of [...skill.files].sort()) {
    if (relativePath === "skill.yaml" || relativePath.startsWith("scripts/")) continue;
    if (!options.includeEvaluations && relativePath.startsWith("evals/")) continue;
    const kind = assetKind(relativePath);
    if (allowedKinds && !allowedKinds.has(kind)) continue;
    const content = readFileSync(join(skill.directory, relativePath), "utf8");
    const sections =
      extname(relativePath).toLowerCase() === ".md"
        ? markdownSections(content)
        : [{ selector: "$", content }];
    for (const section of sections) {
      if (!section.content.trim()) continue;
      fragments.push({
        reference: fragmentReference(skill, relativePath, section.selector, section.content),
        assetKind: kind,
        mediaType: mediaType(relativePath),
        content: section.content,
      });
    }
  }
  return fragments.sort((a, b) => a.reference.fragmentId.localeCompare(b.reference.fragmentId));
}

function tokens(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/u)
        .filter((token) => token.length > 2),
    ),
  ].sort();
}

function fragmentScore(fragment: ScientificSkillFragment, queryTokens: readonly string[]): number {
  const haystack =
    `${fragment.reference.relativePath} ${fragment.reference.selector} ${fragment.content}`.toLowerCase();
  let score = fragment.assetKind === "summary" ? 1 : 0;
  for (const token of queryTokens) {
    if (fragment.reference.relativePath.toLowerCase().includes(token)) score += 4;
    if (fragment.reference.selector.includes(token)) score += 3;
    if (haystack.includes(token)) score += 1;
  }
  return score;
}

export interface ProgressiveContextRequest {
  query: string;
  reason: string;
  assetKinds?: readonly string[];
  requiredFragmentIds?: readonly string[];
  maxFragments?: number;
  maxCharacters?: number;
}

/** Select a bounded context while preserving the exact source bytes and attribution of every section. */
export function selectProgressiveSkillContext(
  resolved: ResolvedScientificSkillGraph,
  request: ProgressiveContextRequest,
): SelectedSkillContext {
  const requiredIds = new Set(request.requiredFragmentIds ?? []);
  const queryTokens = tokens(request.query);
  const candidates = resolved.skills.flatMap((skill) =>
    loadScientificSkillFragments(skill, { assetKinds: request.assetKinds }),
  );
  const ranked = candidates.sort((left, right) => {
    const required =
      Number(requiredIds.has(right.reference.fragmentId)) -
      Number(requiredIds.has(left.reference.fragmentId));
    if (required) return required;
    const score = fragmentScore(right, queryTokens) - fragmentScore(left, queryTokens);
    return score || left.reference.fragmentId.localeCompare(right.reference.fragmentId);
  });
  const maxFragments = request.maxFragments ?? 24;
  const maxCharacters = request.maxCharacters ?? 24_000;
  const selected: ScientificSkillFragment[] = [];
  let totalCharacters = 0;
  for (const fragment of ranked) {
    const required = requiredIds.has(fragment.reference.fragmentId);
    const score = fragmentScore(fragment, queryTokens);
    if (!required && score === 0) continue;
    if (!required && selected.length >= maxFragments) continue;
    if (!required && totalCharacters + fragment.content.length > maxCharacters) continue;
    selected.push(fragment);
    totalCharacters += fragment.content.length;
  }
  const foundIds = new Set(selected.map((fragment) => fragment.reference.fragmentId));
  const missing = [...requiredIds].filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Required scientific skill fragments were not found: ${missing.sort().join(", ")}`,
    );
  }
  selected.sort((a, b) => a.reference.fragmentId.localeCompare(b.reference.fragmentId));
  const references = selected.map((fragment) => fragment.reference);
  return {
    fragments: selected,
    references,
    totalCharacters,
    selectionDigest: digestCanonical({ references, reason: request.reason }),
    reason: request.reason,
  };
}

export function graphWithSelectedFragments(
  graph: ResolvedSkillGraph,
  context: SelectedSkillContext,
): ResolvedSkillGraph {
  return withResolvedScientificSkillGraphDigest({
    ...graph,
    selectedFragments: [...context.references],
  });
}
