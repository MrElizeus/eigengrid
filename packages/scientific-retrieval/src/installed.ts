import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { digestCanonical } from "@eigengrid/scientific-schema";
import { installedScientificSkillRoot } from "@eigengrid/scientific-skills";
import { AuthorizedScientificCatalog } from "./catalog";
import { ScientificRetrievalService } from "./service";
import { LocalScientificVectorIndex } from "./vector-index";
import { JsonlEmbeddingProvider } from "./embedding-process";

export const LocalEmbeddingManifestSchema = z
  .object({
    schema: z.literal("eigengrid.local-embedding/v1"),
    model: z.string().min(1),
    revision: z.string().min(1),
    dimensions: z.number().int().min(1).max(16384),
    files: z
      .object({
        model: z
          .object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u) })
          .strict(),
        tokenizer: z
          .object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u) })
          .strict(),
      })
      .strict(),
    maxTokens: z.number().int().min(16).max(512),
    queryPrefix: z.string().max(128),
    passagePrefix: z.string().max(128),
    pooling: z.literal("attention_mean_l2"),
    runtime: z
      .object({
        onnxruntime: z.string(),
        tokenizers: z.string(),
        numpy: z.string(),
        threads: z.number().int().min(1).max(32),
      })
      .strict(),
  })
  .strict();

const ConfigSchema = z
  .object({
    mode: z.enum(["lexical", "vector", "hybrid", "scientific"]).default("lexical"),
    indexDirectory: z.string().optional(),
    rrfK: z.number().min(1).max(1000).default(60),
    embeddings: z
      .object({ python: z.string().min(1), manifest: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

function readConfiguration(configPath?: string) {
  let config = ConfigSchema.parse({});
  if (configPath) {
    const stat = statSync(configPath);
    if (
      !stat.isFile() ||
      stat.size > 65536 ||
      (stat.mode & 0o022) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Retrieval configuration must be an owned file, not writable by other users");
    config = ConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
  }
  const base = configPath ? dirname(resolve(configPath)) : process.cwd();
  const absolute = (path: string) => (isAbsolute(path) ? path : resolve(base, path));
  const manifestPath = config.embeddings ? absolute(config.embeddings.manifest) : undefined;
  if (manifestPath && statSync(manifestPath).size > 65536)
    throw new Error("Embedding manifest exceeds limits");
  const manifest = manifestPath
    ? LocalEmbeddingManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")))
    : undefined;
  return { config, absolute, manifestPath, manifest };
}

export function installedRetrievalConfigurationDigest(
  root: string,
  configPath = process.env.EIGENGRID_RETRIEVAL_CONFIG,
): string {
  const { config, manifest } = readConfiguration(configPath);
  return digestCanonical({
    root: resolve(root),
    configPath: configPath ? resolve(configPath) : null,
    config,
    manifest,
  });
}

/** CLI/TUI single-user adapter. Multi-user hosts must construct AuthorizedScientificCatalog themselves. */
export function createInstalledScientificRetrieval(
  root = installedScientificSkillRoot(),
  configPath = process.env.EIGENGRID_RETRIEVAL_CONFIG,
): ScientificRetrievalService {
  const { config, absolute, manifestPath, manifest } = readConfiguration(configPath);
  let embeddings: JsonlEmbeddingProvider | undefined;
  if (config.embeddings && manifestPath && manifest) {
    embeddings = new JsonlEmbeddingProvider(
      [
        config.embeddings.python,
        "-m",
        "eigengrid_retrieval",
        manifestPath,
        digestCanonical(manifest),
      ],
      {
        model: manifest.model,
        revision: manifest.revision,
        dimensions: manifest.dimensions,
        configurationDigest: digestCanonical(manifest),
      },
    );
  }
  const actorId = `os-user:${process.getuid?.() ?? process.env.USER ?? "local"}`;
  return new ScientificRetrievalService({
    catalog: new AuthorizedScientificCatalog(() => ({
      principal: { actorId, projectIds: [] },
      catalogs: existsSync(root)
        ? [{ id: "installed", root, revision: "1", access: { kind: "private", ownerId: actorId } }]
        : [],
    })),
    mode: config.mode,
    rrfK: config.rrfK,
    embeddings,
    index: new LocalScientificVectorIndex(
      config.indexDirectory
        ? absolute(config.indexDirectory)
        : join(homedir(), ".cache", "eigengrid", "retrieval"),
    ),
  });
}

let cached: { key: string; service: ScientificRetrievalService } | undefined;
/** Configuration bytes and canonical bytes are both rechecked; a directory path is not a revision. */
export function installedScientificRetrieval(
  root = installedScientificSkillRoot(),
): ScientificRetrievalService {
  const key = installedRetrievalConfigurationDigest(root);
  if (cached?.key !== key) {
    cached?.service.close();
    cached = { key, service: createInstalledScientificRetrieval(root) };
  }
  return cached.service;
}
