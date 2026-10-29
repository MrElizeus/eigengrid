import { digestCanonical } from "@eigengrid/scientific-schema";
import type { LoadedScientificSkill } from "./types";
import { compareSemver } from "./semver";

export class DuplicateScientificSkillError extends Error {
  readonly code = "DUPLICATE_SCIENTIFIC_SKILL";
  constructor(id: string, version: string) {
    super(`Duplicate scientific skill ${id}@${version}`);
    this.name = "DuplicateScientificSkillError";
  }
}

/** Immutable repository skill view. Derived indexes may rank it but never replace its authority. */
export class ScientificSkillRegistry {
  private readonly byId = new Map<string, LoadedScientificSkill[]>();
  readonly corpusDigest: string;

  constructor(skills: readonly LoadedScientificSkill[]) {
    for (const skill of skills) {
      const versions = this.byId.get(skill.manifest.id) ?? [];
      if (versions.some((candidate) => candidate.manifest.version === skill.manifest.version)) {
        throw new DuplicateScientificSkillError(skill.manifest.id, skill.manifest.version);
      }
      versions.push(skill);
      versions.sort((a, b) => {
        const version = compareSemver(b.manifest.version, a.manifest.version);
        return version || a.contentDigest.localeCompare(b.contentDigest);
      });
      this.byId.set(skill.manifest.id, versions);
    }
    this.corpusDigest = digestCanonical(
      this.all().map((skill) => ({
        id: skill.manifest.id,
        version: skill.manifest.version,
        contentDigest: skill.contentDigest,
      })),
    );
  }

  all(): LoadedScientificSkill[] {
    return [...this.byId.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([, versions]) => versions);
  }

  ids(): string[] {
    return [...this.byId.keys()].sort();
  }

  versions(id: string): readonly LoadedScientificSkill[] {
    return this.byId.get(id) ?? [];
  }

  exact(id: string, version: string): LoadedScientificSkill | undefined {
    return this.byId.get(id)?.find((skill) => skill.manifest.version === version);
  }
}
