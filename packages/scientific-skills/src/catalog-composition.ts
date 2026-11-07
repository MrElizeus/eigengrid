import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { digestBytes, digestCanonical } from "@eigengrid/scientific-schema";
import { loadScientificSkillCorpus } from "./loader";
import { ScientificSkillRegistry } from "./registry";
import { resolveScientificSkillGraph } from "./resolver";
import { runScientificSkillEvaluations } from "./evaluation";
import type { LoadedScientificSkill } from "./types";

function fingerprint(root: string): string {
  const files: unknown[] = [];
  function visit(path: string) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("Catalog composition rejects symbolic links");
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
    else if (stat.isFile())
      files.push({
        path: relative(root, path),
        digest: digestBytes(readFileSync(path)),
        mode: stat.mode & 0o777,
        uid: stat.uid,
        gid: stat.gid,
      });
    else throw new Error("Catalog composition requires regular files and directories");
  }
  visit(root);
  return digestCanonical(files);
}

function source(directory: string) {
  const root = resolve(directory);
  if (!lstatSync(root).isDirectory()) throw new Error("Catalog root must be a real directory");
  const treeDigest = fingerprint(root);
  const skills = loadScientificSkillCorpus(root);
  if (!skills.length) throw new Error("Catalog composition requires nonempty inputs");
  const registry = new ScientificSkillRegistry(skills);
  if (fingerprint(root) !== treeDigest) throw new Error("Catalog changed during inspection");
  return { root, treeDigest, corpusDigest: registry.corpusDigest, skills };
}

function within(parent: string, child: string) {
  return child === parent || child.startsWith(parent + sep);
}

function privateDestination(output: string, inputs: string[]): string {
  const destination = resolve(output);
  const parent = dirname(destination);
  const stat = lstatSync(parent);
  if (
    !stat.isDirectory() ||
    realpathSync(parent) !== parent ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (stat.mode & 0o022) !== 0
  )
    throw new Error("Composition output requires an owned parent, not writable by other users");
  if (
    inputs.some(
      (input) =>
        within(realpathSync(input), destination) || within(destination, realpathSync(input)),
    )
  )
    throw new Error("Composition output must be separate from its source catalogs");
  for (let path = parent; ; path = dirname(path)) {
    if (existsSync(join(path, ".git")))
      throw new Error("Site catalogs cannot be written inside a Git checkout");
    if (path === dirname(path)) break;
  }
  if (existsSync(destination)) throw new Error("Composition destination already exists");
  return destination;
}

/** Site-only materialization. No active selection, source file or permission is changed. */
export function composeScientificCatalog(options: {
  publicRoot: string;
  siteRoot: string;
  output?: string;
  expectedPublicDigest?: string;
  expectedSiteDigest?: string;
}) {
  const publicSource = source(options.publicRoot);
  const siteSource = source(options.siteRoot);
  if (options.expectedPublicDigest && options.expectedPublicDigest !== publicSource.corpusDigest)
    throw new Error("Public catalog digest changed");
  if (options.expectedSiteDigest && options.expectedSiteDigest !== siteSource.corpusDigest)
    throw new Error("Site catalog digest changed");
  if (options.output && (!options.expectedPublicDigest || !options.expectedSiteDigest))
    throw new Error("Writing a composition requires both reviewed input digests");
  const entries = new Map<
    string,
    { skill: LoadedScientificSkill; origin: "public" | "site" | "shared" }
  >();
  const conflicts: Array<{
    id: string;
    version: string;
    publicDigest: string;
    siteDigest: string;
  }> = [];
  for (const [origin, input] of [
    ["public", publicSource],
    ["site", siteSource],
  ] as const) {
    for (const skill of input.skills) {
      const key = `${skill.manifest.id}@${skill.manifest.version}`;
      const existing = entries.get(key);
      if (!existing) entries.set(key, { skill, origin });
      else if (existing.skill.contentDigest === skill.contentDigest) existing.origin = "shared";
      else
        conflicts.push({
          id: skill.manifest.id,
          version: skill.manifest.version,
          publicDigest: existing.skill.contentDigest,
          siteDigest: skill.contentDigest,
        });
    }
  }
  if (conflicts.length) throw new Error("Catalog identity conflicts: " + JSON.stringify(conflicts));
  const registry = new ScientificSkillRegistry([...entries.values()].map((entry) => entry.skill));
  for (const skill of registry.all())
    resolveScientificSkillGraph(registry, {
      requested: [{ id: skill.manifest.id, range: "=" + skill.manifest.version }],
      resolvedAt: "1970-01-01T00:00:00.000Z",
    });
  const evaluation = runScientificSkillEvaluations(registry);
  if (evaluation.failed)
    throw new Error(
      "Combined catalog evaluations failed: " +
        JSON.stringify(
          evaluation.cases
            .filter((item) => !item.passed)
            .map(({ id, source, details }) => ({ id, source, details })),
        ),
    );
  const receipt = {
    schemaVersion: "eigengrid.site-catalog-composition/v1",
    public: {
      root: publicSource.root,
      corpusDigest: publicSource.corpusDigest,
      treeDigest: publicSource.treeDigest,
    },
    site: {
      root: siteSource.root,
      corpusDigest: siteSource.corpusDigest,
      treeDigest: siteSource.treeDigest,
    },
    corpusDigest: registry.corpusDigest,
    protocolCount: registry.ids().length,
    versionCount: registry.all().length,
    identicalDuplicates: [...entries.values()].filter((entry) => entry.origin === "shared").length,
    evaluations: { passed: evaluation.passed, failed: evaluation.failed },
    entries: registry.all().map((skill) => ({
      id: skill.manifest.id,
      version: skill.manifest.version,
      contentDigest: skill.contentDigest,
      origin: entries.get(`${skill.manifest.id}@${skill.manifest.version}`)!.origin,
    })),
  };
  const unchanged = () => {
    if (
      fingerprint(publicSource.root) !== publicSource.treeDigest ||
      fingerprint(siteSource.root) !== siteSource.treeDigest
    )
      throw new Error("Catalog source changed during composition");
  };
  unchanged();
  if (!options.output) return { ...receipt, written: false };
  const destination = privateDestination(options.output, [publicSource.root, siteSource.root]);
  mkdirSync(destination, { mode: 0o700 });
  try {
    const corpus = join(destination, "corpus");
    mkdirSync(corpus, { mode: 0o700 });
    for (const skill of registry.all()) {
      const target = join(
        corpus,
        encodeURIComponent(skill.manifest.id),
        encodeURIComponent(skill.manifest.version),
      );
      mkdirSync(target, { recursive: true, mode: 0o700 });
      for (const file of skill.files) {
        const original = join(skill.directory, file);
        const output = join(target, file);
        mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
        // Only the composing account can read the new view until a site administrator grants access.
        const mode = lstatSync(original).mode & 0o100 ? 0o700 : 0o600;
        writeFileSync(output, readFileSync(original), { mode, flag: "wx" });
      }
    }
    const copied = new ScientificSkillRegistry(loadScientificSkillCorpus(corpus));
    if (copied.corpusDigest !== registry.corpusDigest)
      throw new Error("Composed catalog integrity mismatch");
    unchanged();
    writeFileSync(join(destination, "composition.json"), JSON.stringify(receipt, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    return { ...receipt, written: true, root: corpus };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}
