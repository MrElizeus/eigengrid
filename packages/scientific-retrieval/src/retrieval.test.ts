import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digestBytes, digestCanonical } from "@eigengrid/scientific-schema";
import {
  repositoryScientificSkillsRoot,
  searchScientificSkills,
} from "@eigengrid/scientific-skills";
import { AuthorizedScientificCatalog } from "./catalog";
import { retrievalDocuments } from "./documents";
import { ScientificRetrievalService } from "./service";
import { LocalScientificVectorIndex } from "./vector-index";
import { reciprocalRankFusion } from "./ranking";
import { rankingMetrics } from "./evaluation";
import { fixtureRoot, fixtureService, FixtureEmbeddings } from "./test-support";
import type { CatalogGrant } from "./contracts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture(paths?: string[]) {
  const root = fixtureRoot(paths);
  cleanups.push(root.dispose);
  return { ...root, ...fixtureService(root.root, root.directory) };
}

describe("hybrid scientific retrieval contracts", () => {
  test("keeps semantic-only candidates and lexical candidates in the canonical legacy union", () => {
    const { service } = fixture();
    const registry = service.snapshot().registry;
    const hits = searchScientificSkills(registry, "geometricoptimization", {
      candidateIds: ["workflows.gimic-ring-currents", "private.nonexistent"],
    }).hits;
    expect(hits.map((hit) => hit.skill.skillId)).toContain("workflows.gimic-ring-currents");
    expect(hits.some((hit) => hit.skill.skillId === "private.nonexistent")).toBe(false);
    const union = searchScientificSkills(registry, "workflows.geometry-optimization", {
      candidateIds: ["workflows.gimic-ring-currents"],
    });
    expect(union.hits[0].skill.skillId).toBe("workflows.geometry-optimization");
    expect(union.hits).toHaveLength(2);
  });

  test("retrieves semantic-only fragments and preserves exact IDs over vector rankings", async () => {
    const { service } = fixture();
    await service.rebuild();
    const result = await service.search({ query: "antipodex", limit: 2 });
    expect(result.indexState).toBe("ready");
    expect(result.hits[0].skill.skillId).toBe("workflows.gimic-ring-currents");
    expect(result.hits[0].lexicalRank).toBeUndefined();
    expect(result.hits[0].vectorRank).toBe(1);
    expect(result.executionAuthorized).toBe(false);
    expect(result.hits[0].knowledgeLevel).toBe("draft");
    expect(result.hits[0].reasons).toContain("scientific_review_pending");
    const exact = await service.search({ query: "workflows.geometry-optimization" });
    expect(exact.hits[0].skill.skillId).toBe("workflows.geometry-optimization");
    expect(exact.ambiguous).toBe(false);
  });

  test("pins fragment metadata, windows and source digests without changing the corpus", () => {
    const { service } = fixture();
    const snapshot = service.snapshot();
    const documents = retrievalDocuments(snapshot);
    expect(new Set(documents.map((document) => document.id)).size).toBe(documents.length);
    for (const document of documents) {
      const fragment = snapshot.fragments.find(
        (item) => item.reference.fragmentId === document.reference.fragmentId,
      )!;
      expect(digestBytes(fragment.content)).toBe(document.reference.fragmentDigest);
      expect(document.contentDigest).toBe(digestBytes(document.text));
      expect(document.end - document.start).toBeLessThanOrEqual(1200);
      expect(document.accessScope).toBe("private");
      expect(document.reviewStatus).toBe("unreviewed");
    }
    expect(service.snapshot().registry.corpusDigest).toBe(snapshot.registry.corpusDigest);
  });

  test("keeps Unicode scientific symbols intact across overlapping embedding windows", () => {
    const { service, root } = fixture();
    appendFileSync(
      join(root, "workflows/gimic-ring-currents/SKILL.md"),
      `\n\n## Synthetic Unicode boundary\n${"𝛼".repeat(1500)}\n`,
    );
    const snapshot = service.snapshot();
    for (const document of retrievalDocuments(snapshot)) {
      expect(Buffer.from(document.text, "utf8").toString("utf8")).toBe(document.text);
      expect(document.end - document.start).toBeLessThanOrEqual(1200);
    }
  });

  test("falls back on absent, stale, corrupt and unavailable indexes", async () => {
    const { service, index, embeddings } = fixture();
    const request = { query: "workflows.geometry-optimization" };
    expect((await service.search(request)).indexState).toBe("missing");
    await service.rebuild();
    const provider = embeddings as FixtureEmbeddings;
    provider.identity = { ...provider.identity, revision: "fixture-2" };
    expect((await service.search(request)).indexState).toBe("stale");
    provider.identity = { ...provider.identity, revision: "fixture-1" };
    provider.afterEmbed = () => {
      throw new Error("unavailable");
    };
    expect((await service.search(request)).indexState).toBe("provider_unavailable");
    provider.afterEmbed = undefined;
    writeFileSync(index.path(service.snapshot().scopeDigest), "not a SQLite index");
    const corrupt = await service.search(request);
    expect(corrupt.indexState).toBe("corrupt");
    expect(corrupt.effectiveMode).toBe("lexical");
    expect(corrupt.hits[0].skill.skillId).toBe(request.query);
    await service.rebuild();
    expect((await service.search(request)).indexState).toBe("ready");
  });

  test("rejects forged vector dimensions even with a recalculated payload checksum", async () => {
    const { service, index } = fixture();
    await service.rebuild();
    const db = new Database(index.path(service.snapshot().scopeDigest));
    const record = db.query<{ payload: string }, []>("SELECT payload FROM derived_index").get()!;
    const payload = JSON.parse(record.payload);
    payload.rows[0].vector = [1, 0];
    db.query("UPDATE derived_index SET payload = ?, checksum = ?").run(
      JSON.stringify(payload),
      digestCanonical(payload),
    );
    db.close();
    expect((await service.search({ query: "XDENS" })).indexState).toBe("corrupt");
  });

  test("invalidates same-path, same-mtime content and rejects stale context", async () => {
    const { service, root } = fixture();
    await service.rebuild();
    const request = { query: "workflows.gimic-ring-currents" };
    const result = await service.search(request);
    const path = join(root, "workflows/gimic-ring-currents/SKILL.md");
    const stat = statSync(path);
    writeFileSync(path, readFileSync(path, "utf8").replace("GIMIC", "Gimic"));
    utimesSync(path, stat.atime, stat.mtime);
    const current = await service.search(request);
    expect(current.corpusDigest).not.toBe(result.corpusDigest);
    expect(current.indexState).toBe("stale");
    expect(() => service.context(result, request)).toThrow("view changed");
    appendFileSync(
      join(root, "workflows/gimic-ring-currents/skill.yaml"),
      "\nunknown_field: true\n",
    );
    expect(() => service.snapshot()).toThrow();
    expect(() => service.snapshot()).toThrow();
  });

  test("keeps the previous complete index if a rebuild fails", async () => {
    const { service, index, embeddings } = fixture();
    await service.rebuild();
    const path = index.path(service.snapshot().scopeDigest);
    const prior = digestBytes(readFileSync(path));
    (embeddings as FixtureEmbeddings).afterEmbed = () => {
      throw new Error("interrupted build");
    };
    await expect(service.rebuild()).rejects.toThrow("interrupted");
    expect(digestBytes(readFileSync(path))).toBe(prior);
  });

  test("scientific constraints outrank similarity without promoting draft knowledge", async () => {
    const { service } = fixture();
    await service.rebuild();
    const result = await service.search({
      query: "antipodex",
      engine: { id: "orca", version: "6.0.0" },
    });
    expect(result.hits[0].skill.skillId).toBe("workflows.geometry-optimization");
    expect(result.hits.find((hit) => hit.skill.skillId.includes("gimic"))?.reasons).toContain(
      "engine_incompatible",
    );
    expect(result.hits[0].applicability).toBe("unknown");
    const strict = await service.search({
      query: "workflows.gimic-ring-currents",
      minimumKnowledgeMaturity: "expert_reviewed",
    });
    expect(strict.hits[0].reasons).toContain("maturity_below_required");
    expect(
      service.context(strict, { query: strict.query, minimumKnowledgeMaturity: "expert_reviewed" })
        .status,
    ).toBe("empty");
  });

  test("RRF uses one vote per list and the evaluator computes graded nDCG", () => {
    const a = { key: "a", score: 99, fragments: ["a:1"] };
    const b = { key: "b", score: 1, fragments: ["b:1"] };
    const result = reciprocalRankFusion([a, b], [b], 60);
    expect(result[0].key).toBe("b");
    expect(result[0].score).toBeCloseTo(1 / 62 + 1 / 61, 10);
    expect(rankingMetrics(["b", "a"], { a: 3, b: 1 }, 2).recall).toBe(1);
    expect(rankingMetrics(["b", "a"], { a: 3, b: 1 }, 2).ndcg).toBeLessThan(1);
    expect(rankingMetrics(["a", "b"], { a: 3, b: 1 }, 2).ndcg).toBe(1);
  });

  test("does not assemble an ambiguous semantic candidate or accept an altered audit result", async () => {
    const { service } = fixture();
    await service.rebuild();
    const request = { query: "antipodex" };
    const result = await service.search(request);
    expect(result.ambiguous).toBe(true);
    expect(service.context(result, request).status).toBe("ambiguous");
    const selected = service.context(result, request, {
      roots: [result.hits[0].skill],
      maxCharacters: 100000,
      maxFragments: 100,
    });
    expect(selected.status).toBe("complete");
    expect(() => service.context({ ...result, query: "changed" }, request)).toThrow("changed");
    expect(() => service.context(result, { query: "changed" })).toThrow("changed");
  });
});

describe("authorized views and dependency context", () => {
  test("does not open denied catalogs or include their metadata in the visible digest", async () => {
    const { root, directory } = fixture();
    let catalogs: CatalogGrant[] = [
      { id: "public", root, access: { kind: "public" }, revision: "1" },
    ];
    const catalog = new AuthorizedScientificCatalog(() => ({
      principal: { actorId: "alice", projectIds: [] },
      catalogs,
    }));
    const before = catalog.snapshot();
    catalogs = [
      ...catalogs,
      {
        id: "secret-amber",
        root: join(directory, "does-not-exist"),
        access: { kind: "private", ownerId: "bob" },
        revision: "1",
      },
    ];
    const after = catalog.snapshot();
    expect(after.scopeDigest).toBe(before.scopeDigest);
    expect(after.registry.corpusDigest).toBe(before.registry.corpusDigest);
    const embeddings = new FixtureEmbeddings();
    const service = new ScientificRetrievalService({
      catalog,
      embeddings,
      index: new LocalScientificVectorIndex(join(directory, "acl-index")),
      mode: "hybrid",
    });
    await service.rebuild();
    expect(JSON.stringify(embeddings.calls)).not.toContain("secret-amber");
    expect(JSON.stringify(await service.search({ query: "secret-amber" }))).not.toContain(
      "does-not-exist",
    );
  });

  test("revocation during query and rebuild prevents returning an old authorized view", async () => {
    const { root, directory } = fixture();
    let projects = ["project-a"];
    const catalog = new AuthorizedScientificCatalog(() => ({
      principal: { actorId: "alice", projectIds: projects },
      catalogs: [
        { id: "project", root, access: { kind: "project", projectId: "project-a" }, revision: "1" },
      ],
    }));
    const embeddings = new FixtureEmbeddings();
    const service = new ScientificRetrievalService({
      catalog,
      embeddings,
      index: new LocalScientificVectorIndex(join(directory, "project-index")),
      mode: "hybrid",
    });
    await service.rebuild();
    embeddings.afterEmbed = () => {
      projects = [];
    };
    await expect(service.search({ query: "XDENS" })).rejects.toThrow("authorization changed");
    expect(service.status().skills).toBe(0);
    projects = ["project-a"];
    await expect(service.rebuild()).rejects.toThrow("authorization changed");
  });

  test("resolves mandatory dependencies outside the top-k and marks insufficient budgets", async () => {
    const { directory } = fixture();
    const { service } = fixtureService(repositoryScientificSkillsRoot(), directory);
    const request = {
      query: "workflows.geometry-optimization",
      mode: "lexical" as const,
      limit: 1,
    };
    const result = await service.search(request);
    const complete = service.context(result, request, {
      maxCharacters: 100000,
      maxFragments: 1000,
    });
    expect(complete.status).toBe("complete");
    expect(complete.resolved.length).toBeGreaterThan(1);
    expect(
      complete.fragments.some((fragment) => fragment.reference.skillId !== request.query),
    ).toBe(true);
    expect(
      complete.fragments.every(
        (fragment) => digestBytes(fragment.content) === fragment.reference.fragmentDigest,
      ),
    ).toBe(true);
    const bounded = service.context(result, request, { maxCharacters: 1, maxFragments: 1 });
    expect(bounded.status).toBe("budget_insufficient");
    expect(bounded.totalCharacters).toBeLessThanOrEqual(1);
    expect(bounded.missingRequiredFragmentIds.length).toBeGreaterThan(0);
    expect(complete.selectionDigest).toBe(
      service.context(result, request, { maxCharacters: 100000, maxFragments: 1000 })
        .selectionDigest,
    );
    expect(complete.executionAuthorized).toBe(false);
  });

  test("does not disclose inaccessible dependency names through resolver errors", async () => {
    const { service } = fixture(["workflows/geometry-optimization"]);
    const request = { query: "workflows.geometry-optimization", mode: "lexical" as const };
    const context = service.context(await service.search(request), request);
    expect(context.status).toBe("unavailable");
    expect(context.fragments).toHaveLength(0);
    expect(context.diagnostic).not.toContain("methods.");
  });
});
