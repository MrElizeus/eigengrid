import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { digestCanonical, SkillFragmentReferenceSchema } from "@eigengrid/scientific-schema";
import type { CatalogSnapshot } from "./catalog";
import type { EmbeddingIdentity, EmbeddingProvider, IndexState } from "./contracts";
import { DOCUMENT_POLICY, type RetrievalDocument } from "./documents";
import type { RankedDocument } from "./ranking";

export const EmbeddingIdentitySchema = z
  .object({
    model: z.string().min(1),
    revision: z.string().min(1),
    dimensions: z.number().int().min(1).max(16384),
    configurationDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
const MetadataSchema = z
  .object({
    reference: SkillFragmentReferenceSchema,
    catalogId: z.string(),
    accessScope: z.string(),
    assetKind: z.string(),
    domains: z.array(z.string()),
    engines: z.array(z.string()),
    reviewStatus: z.string(),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .strict();
const PayloadSchema = z
  .object({
    schema: z.literal("eigengrid.retrieval-index/v1"),
    key: z.string(),
    corpusDigest: z.string(),
    scopeDigest: z.string(),
    embedding: EmbeddingIdentitySchema,
    documentPolicy: z.string(),
    rows: z
      .array(
        z
          .object({
            id: z.string(),
            digest: z.string(),
            metadata: MetadataSchema,
            vector: z.array(z.number().finite()),
          })
          .strict(),
      )
      .max(100000),
  })
  .strict();
type Payload = z.infer<typeof PayloadSchema>;

function metadata(document: RetrievalDocument): z.infer<typeof MetadataSchema> {
  return {
    reference: document.reference,
    catalogId: document.catalogId,
    accessScope: document.accessScope,
    assetKind: document.assetKind,
    domains: [...document.domains],
    engines: [...document.engines],
    reviewStatus: document.reviewStatus,
    start: document.start,
    end: document.end,
  };
}

export function unitVector(vector: readonly number[], dimensions: number): number[] {
  if (vector.length !== dimensions || vector.some((value) => !Number.isFinite(value)))
    throw new Error("Invalid embedding dimensions or values");
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm < 1e-12)
    throw new Error("Invalid zero or unbounded embedding");
  return vector.map((value) => value / norm);
}

function identityKey(
  snapshot: CatalogSnapshot,
  documents: readonly RetrievalDocument[],
  identity: EmbeddingIdentity,
): string {
  return digestCanonical({
    schema: "eigengrid.retrieval-index/v1",
    scopeDigest: snapshot.scopeDigest,
    corpusDigest: snapshot.registry.corpusDigest,
    policy: DOCUMENT_POLICY,
    identity: EmbeddingIdentitySchema.parse(identity),
    documents: documents.map(({ id, contentDigest }) => ({ id, contentDigest })),
  });
}

/** Local exact vectors. Each authorized view has a separate file; the index contains no source text. */
export class LocalScientificVectorIndex {
  constructor(private readonly directory: string) {}
  path(scopeDigest: string): string {
    return join(this.directory, `${scopeDigest}.sqlite`);
  }

  read(
    snapshot: CatalogSnapshot,
    documents: readonly RetrievalDocument[],
    identity: EmbeddingIdentity,
  ): { state: IndexState; rows?: Payload["rows"] } {
    const path = this.path(snapshot.scopeDigest);
    if (!existsSync(path)) return { state: "missing" };
    let db: Database | undefined;
    try {
      const stat = lstatSync(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 128 * 1024 * 1024 ||
        (stat.mode & 0o077) !== 0
      )
        return { state: "corrupt" };
      db = new Database(path, { readonly: true });
      const row = db
        .query<
          { payload: string; checksum: string },
          []
        >("SELECT payload, checksum FROM derived_index WHERE id = 1")
        .get();
      if (!row) return { state: "corrupt" };
      const payload = PayloadSchema.parse(JSON.parse(row.payload));
      if (digestCanonical(payload) !== row.checksum) return { state: "corrupt" };
      if (payload.key !== identityKey(snapshot, documents, identity)) return { state: "stale" };
      if (
        payload.corpusDigest !== snapshot.registry.corpusDigest ||
        payload.scopeDigest !== snapshot.scopeDigest ||
        payload.documentPolicy !== DOCUMENT_POLICY ||
        digestCanonical(payload.embedding) !== digestCanonical(identity)
      )
        return { state: "stale" };
      if (payload.rows.length !== documents.length) return { state: "corrupt" };
      for (let i = 0; i < documents.length; i++) {
        const vector = payload.rows[i].vector;
        if (
          payload.rows[i].id !== documents[i].id ||
          payload.rows[i].digest !== documents[i].contentDigest ||
          digestCanonical(payload.rows[i].metadata) !== digestCanonical(metadata(documents[i])) ||
          vector.length !== identity.dimensions ||
          Math.abs(Math.hypot(...vector) - 1) > 1e-6
        )
          return { state: "corrupt" };
      }
      return { state: "ready", rows: payload.rows };
    } catch {
      return { state: "corrupt" };
    } finally {
      db?.close();
    }
  }

  async rebuild(
    snapshot: CatalogSnapshot,
    documents: readonly RetrievalDocument[],
    provider: EmbeddingProvider,
    stillCurrent: () => boolean,
  ): Promise<{ documents: number; key: string }> {
    const identity = structuredClone(EmbeddingIdentitySchema.parse(provider.identity));
    const rows: Payload["rows"] = [];
    for (let offset = 0; offset < documents.length; offset += 24) {
      if (!stillCurrent()) throw new Error("Catalog or authorization changed during rebuild");
      const batch = documents.slice(offset, offset + 24);
      const vectors = await provider.embed(
        batch.map((document) => document.text),
        "passage",
      );
      if (vectors.length !== batch.length) throw new Error("Embedding batch cardinality mismatch");
      batch.forEach((document, i) =>
        rows.push({
          id: document.id,
          digest: document.contentDigest,
          metadata: metadata(document),
          vector: unitVector(vectors[i], identity.dimensions),
        }),
      );
    }
    if (!stillCurrent() || digestCanonical(identity) !== digestCanonical(provider.identity))
      throw new Error("Catalog, authorization or embedding identity changed during rebuild");
    const payload: Payload = {
      schema: "eigengrid.retrieval-index/v1",
      key: identityKey(snapshot, documents, identity),
      corpusDigest: snapshot.registry.corpusDigest,
      scopeDigest: snapshot.scopeDigest,
      embedding: identity,
      documentPolicy: DOCUMENT_POLICY,
      rows,
    };
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, "utf8") > 120 * 1024 * 1024)
      throw new Error("Derived index exceeds the local 120 MiB payload limit");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink())
      throw new Error("Index directory must not be a symbolic link");
    const path = this.path(snapshot.scopeDigest);
    const temporary = `${path}.${randomUUID()}.tmp`;
    closeSync(openSync(temporary, "wx", 0o600));
    let db: Database | undefined;
    try {
      db = new Database(temporary);
      db.exec(
        "CREATE TABLE derived_index (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL, checksum TEXT NOT NULL)",
      );
      db.transaction(() =>
        db!
          .query("INSERT INTO derived_index VALUES (1, ?, ?)")
          .run(serialized, digestCanonical(payload)),
      )();
      db.close();
      db = undefined;
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
    } finally {
      db?.close();
      rmSync(temporary, { force: true });
    }
    return { documents: rows.length, key: payload.key };
  }

  candidates(
    rows: Payload["rows"],
    query: readonly number[],
    dimensions: number,
  ): RankedDocument[] {
    const normalized = unitVector(query, dimensions);
    return rows
      .map((row) => ({
        id: row.id,
        score: row.vector.reduce((sum, value, i) => sum + value * normalized[i], 0),
      }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  }
}
