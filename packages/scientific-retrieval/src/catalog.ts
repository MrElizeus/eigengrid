import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { digestBytes, digestCanonical } from "@eigengrid/scientific-schema";
import {
  loadScientificSkillCorpus,
  loadScientificSkillFragments,
  ScientificSkillRegistry,
  type ScientificSkillFragment,
} from "@eigengrid/scientific-skills";
import type { CatalogGrant, RetrievalPrincipal } from "./contracts";

export interface CatalogSnapshot {
  registry: ScientificSkillRegistry;
  fragments: readonly ScientificSkillFragment[];
  scopeDigest: string;
  revision: string;
  /** Catalog membership is host data, not canonical protocol authority. */
  catalogBySkill: ReadonlyMap<string, CatalogGrant>;
}

export function skillKey(id: string, version: string): string {
  return `${id}@${version}`;
}

function allowed(grant: CatalogGrant, principal: RetrievalPrincipal): boolean {
  switch (grant.access.kind) {
    case "public":
      return true;
    case "private":
      return grant.access.ownerId === principal.actorId;
    case "project":
      return principal.projectIds.includes(grant.access.projectId);
    default:
      return false;
  }
}

/** Read actual bytes, not mtimes: same-size replacements and timestamp restoration invalidate caches. */
function fingerprint(root: string): string {
  const files: { path: string; digest: string }[] = [];
  function visit(path: string, relative: string): void {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("Catalog symbolic links are not supported");
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort())
        visit(join(path, name), relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) {
      files.push({ path: relative, digest: digestBytes(readFileSync(path)) });
    } else throw new Error("Catalog contains a non-regular file");
  }
  visit(root, "");
  return digestCanonical(files);
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** A host-bound view. Denied catalogs are never opened, fingerprinted, embedded or counted. */
export class AuthorizedScientificCatalog {
  private cached?: CatalogSnapshot;
  constructor(
    private readonly authorize: () => {
      principal: RetrievalPrincipal;
      catalogs: readonly CatalogGrant[];
    },
  ) {}

  snapshot(): CatalogSnapshot {
    const { principal, catalogs } = this.authorize();
    if (!principal.actorId) throw new Error("Retrieval requires a host principal");
    const visible = catalogs
      .filter((grant) => allowed(grant, principal))
      .map((grant) => ({
        ...structuredClone(grant),
        root: realpathSync(resolve(grant.root)),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(visible.map((grant) => grant.id)).size !== visible.length)
      throw new Error("Duplicate authorized catalog ID");
    const scopeDigest = digestCanonical({
      actorId: principal.actorId,
      projectIds: [...principal.projectIds].sort(),
      catalogs: visible,
    });
    const revisions = visible.map((grant) => fingerprint(grant.root));
    const revision = digestCanonical({ scopeDigest, revisions });
    if (this.cached?.revision === revision) return this.cached;
    // Never retain a stale usable view after a canonical validation failure.
    this.cached = undefined;
    const catalogBySkill = new Map<string, CatalogGrant>();
    const skills = visible.flatMap((grant) =>
      loadScientificSkillCorpus(grant.root).map((skill) => {
        const key = skillKey(skill.manifest.id, skill.manifest.version);
        if (catalogBySkill.has(key))
          throw new Error("Ambiguous skill identity across authorized catalogs");
        catalogBySkill.set(key, freeze(grant));
        return freeze(skill);
      }),
    );
    const registry = new ScientificSkillRegistry(skills);
    const fragments = freeze(skills.flatMap((skill) => loadScientificSkillFragments(skill)));
    if (visible.some((grant, i) => fingerprint(grant.root) !== revisions[i]))
      throw new Error("Catalog changed during retrieval; retry with a fresh snapshot");
    this.cached = { registry, fragments, scopeDigest, revision, catalogBySkill };
    return this.cached;
  }
}
