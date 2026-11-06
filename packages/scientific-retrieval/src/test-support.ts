import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestCanonical } from "@eigengrid/scientific-schema";
import { repositoryScientificSkillsRoot } from "@eigengrid/scientific-skills";
import { AuthorizedScientificCatalog } from "./catalog";
import { ScientificRetrievalService } from "./service";
import { LocalScientificVectorIndex } from "./vector-index";
import type { EmbeddingProvider } from "./contracts";

/** Synthetic vectors test contracts only. They are never used for retrieval quality claims. */
export class FixtureEmbeddings implements EmbeddingProvider {
  identity = {
    model: "test-only",
    revision: "fixture-1",
    dimensions: 3,
    configurationDigest: digestCanonical({ fixture: 1 }),
  };
  calls: { purpose: string; texts: readonly string[] }[] = [];
  afterEmbed?: () => void;
  async embed(texts: readonly string[], purpose: "query" | "passage"): Promise<number[][]> {
    this.calls.push({ purpose, texts });
    this.afterEmbed?.();
    return texts.map((text) =>
      purpose === "query" || text.startsWith("workflows.gimic-ring-currents\n")
        ? [1, 0, 0]
        : [0, 1, 0],
    );
  }
}

export function fixtureRoot(
  paths = ["workflows/geometry-optimization", "workflows/gimic-ring-currents"],
) {
  const directory = mkdtempSync(join(tmpdir(), "eigengrid-retrieval-"));
  const root = join(directory, "corpus");
  mkdirSync(root);
  for (const path of paths) {
    const target = join(root, path);
    mkdirSync(target, { recursive: true });
    cpSync(join(repositoryScientificSkillsRoot(), path), target, { recursive: true });
  }
  return { directory, root, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

export function fixtureService(
  root: string,
  directory: string,
  embeddings: EmbeddingProvider = new FixtureEmbeddings(),
) {
  const catalog = new AuthorizedScientificCatalog(() => ({
    principal: { actorId: "researcher", projectIds: ["project-a"] },
    catalogs: [
      { id: "fixture", root, access: { kind: "private", ownerId: "researcher" }, revision: "1" },
    ],
  }));
  const index = new LocalScientificVectorIndex(join(directory, "index"));
  const service = new ScientificRetrievalService({
    catalog,
    index,
    embeddings,
    mode: "scientific",
  });
  return { catalog, index, service, embeddings };
}
