import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { composeScientificCatalog } from "./catalog-composition";
import { loadScientificSkillCorpus } from "./loader";
import { ScientificSkillRegistry } from "./registry";

let temporary: string, site: string;
const publicRoot = resolve("scientific-skills");
beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "eg-catalog-composition-"));
  site = join(temporary, "site");
  mkdirSync(site, { mode: 0o700 });
  cpSync(join(publicRoot, "representations/molecular-structures"), join(site, "shared"), {
    recursive: true,
  });
});
afterEach(() => rmSync(temporary, { recursive: true, force: true }));

function oldSiteVersion() {
  const target = join(site, "older-validation");
  cpSync(join(publicRoot, "validation/minimum-validation"), target, { recursive: true });
  for (const name of ["skill.yaml", "SKILL.md"]) {
    const path = join(target, name);
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("1.0.1", "1.0.0"));
  }
  return target;
}

test("combines new public protocols and a retained site version with a private receipt", () => {
  oldSiteVersion();
  const before = new ScientificSkillRegistry(loadScientificSkillCorpus(site)).corpusDigest;
  const preview = composeScientificCatalog({ publicRoot, siteRoot: site });
  expect(preview.written).toBe(false);
  expect(preview.identicalDuplicates).toBe(1);
  expect(preview.versionCount).toBe(32);
  expect(preview.protocolCount).toBe(31);
  expect(preview.evaluations.failed).toBe(0);
  const output = join(temporary, "composed");
  const result = composeScientificCatalog({
    publicRoot,
    siteRoot: site,
    output,
    expectedPublicDigest: preview.public.corpusDigest,
    expectedSiteDigest: preview.site.corpusDigest,
  });
  expect(result.written).toBe(true);
  const combined = new ScientificSkillRegistry(loadScientificSkillCorpus(join(output, "corpus")));
  expect(combined.exact("validation.minimum-validation", "1.0.0")).toBeDefined();
  expect(combined.exact("validation.minimum-validation", "1.0.1")).toBeDefined();
  expect(combined.exact("workflows.gimic-ring-currents", "1.0.0")).toBeDefined();
  expect(new ScientificSkillRegistry(loadScientificSkillCorpus(site)).corpusDigest).toBe(before);
  for (const file of readdirSync(output, { recursive: true }) as string[]) {
    const st = statSync(join(output, file));
    expect(st.mode & 0o077).toBe(0);
  }
  const receipt = JSON.parse(readFileSync(join(output, "composition.json"), "utf8"));
  expect(receipt.corpusDigest).toBe(combined.corpusDigest);
  expect(() =>
    composeScientificCatalog({
      publicRoot,
      siteRoot: site,
      output,
      expectedPublicDigest: preview.public.corpusDigest,
      expectedSiteDigest: preview.site.corpusDigest,
    }),
  ).toThrow("already exists");
});

test("conflicting identity stops before writing without choosing a preferred catalog", () => {
  const document = join(site, "shared/SKILL.md");
  writeFileSync(document, readFileSync(document, "utf8") + "\nSite-only conflicting text.\n");
  const output = join(temporary, "conflicted");
  expect(() =>
    composeScientificCatalog({
      publicRoot,
      siteRoot: site,
      output,
      expectedPublicDigest: "a".repeat(64),
      expectedSiteDigest: "b".repeat(64),
    }),
  ).toThrow("digest changed");
  expect(() => composeScientificCatalog({ publicRoot, siteRoot: site })).toThrow(
    "Catalog identity conflicts",
  );
  expect(existsSync(output)).toBe(false);
  expect(readFileSync(document, "utf8")).toContain("Site-only conflicting text");
});

test("retains a synthetic site-only protocol alongside public protocols", () => {
  const privateSkill = join(site, "private-fixture");
  cpSync(join(publicRoot, "representations/molecular-structures"), privateSkill, {
    recursive: true,
  });
  for (const file of readdirSync(privateSkill, { recursive: true }) as string[]) {
    const path = join(privateSkill, file);
    if (!statSync(path).isFile()) continue;
    writeFileSync(
      path,
      readFileSync(path, "utf8").replaceAll(
        "representations.molecular-structures",
        "site.synthetic-structures",
      ),
    );
  }
  // Keep fixture evaluations specific, so a duplicate generic description is not
  // mistaken for a claim about retrieval quality on real private knowledge.
  for (const file of readdirSync(join(privateSkill, "evals"))) {
    if (file.includes("composition")) continue;
    const path = join(privateSkill, "evals", file);
    const cases = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const item of cases)
      if (item.expected_included.includes("site.synthetic-structures"))
        item.query = "site.synthetic-structures";
    writeFileSync(path, cases.map((item) => JSON.stringify(item)).join("\n") + "\n");
  }
  const result = composeScientificCatalog({ publicRoot, siteRoot: site });
  expect(result.entries.find((entry) => entry.id === "site.synthetic-structures")?.origin).toBe(
    "site",
  );
  expect(result.protocolCount).toBe(32);
  expect(result.evaluations.failed).toBe(0);
});

test("requires reviewed digests and refuses stale inputs, Git outputs and symlinks", () => {
  const preview = composeScientificCatalog({ publicRoot, siteRoot: site });
  const pinned = {
    publicRoot,
    siteRoot: site,
    expectedPublicDigest: preview.public.corpusDigest,
    expectedSiteDigest: preview.site.corpusDigest,
  };
  expect(() =>
    composeScientificCatalog({ publicRoot, siteRoot: site, output: join(temporary, "unpinned") }),
  ).toThrow("both reviewed input digests");
  expect(() => composeScientificCatalog({ ...pinned, output: resolve("private-catalog") })).toThrow(
    "Git checkout",
  );
  expect(() => composeScientificCatalog({ ...pinned, output: join(site, "nested") })).toThrow(
    "separate",
  );
  mkdirSync(join(temporary, "unsafe"));
  chmodSync(join(temporary, "unsafe"), 0o777);
  expect(() =>
    composeScientificCatalog({ ...pinned, output: join(temporary, "unsafe/view") }),
  ).toThrow("owned parent");
  symlinkSync(join(publicRoot, "representations/molecular-structures"), join(site, "link"));
  expect(() => composeScientificCatalog(pinned)).toThrow("symbolic links");
});
