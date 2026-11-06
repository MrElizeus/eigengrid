import { digestCanonical } from "@eigengrid/scientific-schema";
import { compareSemver } from "@eigengrid/scientific-skills";
import { AuthorizedScientificCatalog, skillKey } from "./catalog";
import { DOCUMENT_POLICY, retrievalDocuments, type RetrievalDocument } from "./documents";
import type {
  ContextRequest,
  EmbeddingProvider,
  IndexState,
  RetrievalHit,
  RetrievalMode,
  RetrievalRequest,
  RetrievalResult,
} from "./contracts";
import { LocalScientificVectorIndex, EmbeddingIdentitySchema } from "./vector-index";
import {
  assessApplicability,
  collapseCandidates,
  lexicalCandidates,
  reciprocalRankFusion,
  scientificOrder,
} from "./ranking";
import { selectRetrievalContext } from "./context";

export interface ScientificRetrievalOptions {
  catalog: AuthorizedScientificCatalog;
  index?: LocalScientificVectorIndex;
  embeddings?: EmbeddingProvider;
  mode?: RetrievalMode;
  rrfK?: number;
}

/** Retrieval is read-only scientific guidance. It has no execution or skill-promotion capability. */
export class ScientificRetrievalService {
  private derived?: { revision: string; documents: RetrievalDocument[] };
  readonly catalog: AuthorizedScientificCatalog;
  constructor(private readonly options: ScientificRetrievalOptions) {
    this.catalog = options.catalog;
    if (options.embeddings) EmbeddingIdentitySchema.parse(options.embeddings.identity);
    if (
      !Number.isFinite(options.rrfK ?? 60) ||
      (options.rrfK ?? 60) < 1 ||
      (options.rrfK ?? 60) > 1000
    )
      throw new Error("Invalid RRF k");
  }
  snapshot() {
    return this.catalog.snapshot();
  }
  private documents(snapshot: ReturnType<ScientificRetrievalService["snapshot"]>) {
    if (this.derived?.revision !== snapshot.revision)
      this.derived = { revision: snapshot.revision, documents: retrievalDocuments(snapshot) };
    return this.derived.documents;
  }
  status() {
    const snapshot = this.snapshot();
    const documents = this.documents(snapshot);
    const { embeddings, index } = this.options;
    return {
      mode: this.options.mode ?? "lexical",
      corpusDigest: snapshot.registry.corpusDigest,
      scopeDigest: snapshot.scopeDigest,
      skills: snapshot.registry.all().length,
      fragments: snapshot.fragments.length,
      documents: documents.length,
      indexState:
        embeddings && index
          ? index.read(snapshot, documents, embeddings.identity).state
          : "disabled",
      embedding: embeddings?.identity,
      executionAuthorized: false,
    };
  }
  async rebuild() {
    const { embeddings, index } = this.options;
    if (!embeddings || !index)
      throw new Error("Rebuild requires an explicit local embedding provider and index directory");
    const snapshot = this.snapshot();
    const result = await index.rebuild(
      snapshot,
      this.documents(snapshot),
      embeddings,
      () => this.snapshot().revision === snapshot.revision,
    );
    return {
      ...result,
      corpusDigest: snapshot.registry.corpusDigest,
      scopeDigest: snapshot.scopeDigest,
      embedding: embeddings.identity,
    };
  }
  async search(input: RetrievalRequest): Promise<RetrievalResult> {
    const request = { ...input, asOf: input.asOf ?? new Date().toISOString().slice(0, 10) };
    if (!request.query.trim() || request.query.length > 2000)
      throw new Error("Query must contain 1–2000 characters");
    const limit = request.limit ?? 20;
    const candidateLimit = request.candidateLimit ?? 100;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      !Number.isInteger(candidateLimit) ||
      candidateLimit < 1 ||
      candidateLimit > 1000
    )
      throw new Error("Invalid candidate or result limit");
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(request.asOf)) throw new Error("asOf must be an ISO date");
    const snapshot = this.snapshot();
    const allDocuments = this.documents(snapshot);
    const eligible = new Map(
      snapshot.registry
        .all()
        .filter(
          (skill) =>
            skill.manifest.status === "active" &&
            (!request.domains?.length ||
              request.domains.some((domain) => skill.manifest.domains.includes(domain))),
        )
        .map((skill) => [skillKey(skill.manifest.id, skill.manifest.version), skill]),
    );
    const documents = allDocuments.filter((document) =>
      eligible.has(skillKey(document.reference.skillId, document.reference.version)),
    );
    const lexical = collapseCandidates(
      lexicalCandidates(documents, request.query),
      documents,
    ).slice(0, candidateLimit);
    const exact = request.query.trim().toLowerCase();
    // Preserve exact identifiers even when tokenization has no terms or a dense list misses them.
    for (const [key, skill] of eligible) {
      if (skill.manifest.id.toLowerCase() !== exact && key.toLowerCase() !== exact) continue;
      const index = lexical.findIndex((hit) => hit.key === key);
      const hit =
        index >= 0
          ? lexical.splice(index, 1)[0]
          : {
              key,
              score: 1,
              fragments: documents
                .filter(
                  (document) =>
                    document.reference.skillId === skill.manifest.id &&
                    document.reference.version === skill.manifest.version,
                )
                .slice(0, 1)
                .map((document) => document.reference.fragmentId),
            };
      lexical.unshift(hit);
    }
    const requestedMode = request.mode ?? this.options.mode ?? "lexical";
    if (!["lexical", "vector", "hybrid", "scientific"].includes(requestedMode))
      throw new Error("Unknown retrieval mode");
    let effectiveMode = requestedMode;
    let indexState: IndexState = "disabled";
    let vector: ReturnType<typeof collapseCandidates> = [];
    const { embeddings, index } = this.options;
    const identity = embeddings ? structuredClone(embeddings.identity) : undefined;
    if (requestedMode !== "lexical") {
      const loaded =
        embeddings && index
          ? index.read(snapshot, allDocuments, embeddings.identity)
          : { state: "disabled" as const };
      indexState = loaded.state;
      if (loaded.state === "ready" && loaded.rows && embeddings && index) {
        try {
          const vectors = await embeddings.embed([request.query], "query");
          if (
            vectors.length !== 1 ||
            digestCanonical(identity) !== digestCanonical(embeddings.identity)
          )
            throw new Error("Embedding identity or batch changed");
          const eligibleDocuments = new Set(documents.map((document) => document.id));
          vector = collapseCandidates(
            index.candidates(
              loaded.rows.filter((row) => eligibleDocuments.has(row.id)),
              vectors[0],
              embeddings.identity.dimensions,
            ),
            documents,
          ).slice(0, candidateLimit);
        } catch {
          indexState = "provider_unavailable";
        }
      }
      if (indexState !== "ready") effectiveMode = "lexical";
    }
    // Authorization can change while an embedding request is pending.
    if (this.snapshot().revision !== snapshot.revision)
      throw new Error("Catalog or authorization changed during retrieval; retry");
    const fused = reciprocalRankFusion(
      effectiveMode === "vector" ? [] : lexical,
      effectiveMode === "lexical" ? [] : vector,
      this.options.rrfK ?? 60,
    );
    let hits: RetrievalHit[] = fused.map((hit) => {
      const skill = eligible.get(hit.key)!;
      return {
        skill: {
          skillId: skill.manifest.id,
          version: skill.manifest.version,
          contentDigest: skill.contentDigest,
        },
        title: skill.manifest.title,
        score: hit.score,
        lexicalRank: hit.lexicalRank,
        vectorRank: hit.vectorRank,
        lexicalScore: lexical.find((candidate) => candidate.key === hit.key)?.score,
        vectorScore: vector.find((candidate) => candidate.key === hit.key)?.score,
        fragmentIds: hit.fragments,
        ...assessApplicability(skill, request),
        reviewStatus: skill.manifest.review.status,
        knowledgeLevel: skill.manifest.knowledge_level,
      };
    });
    if (requestedMode === "scientific") hits.sort(scientificOrder);
    // Exact lookup remains available for inspection, with incompatibility explicitly reported.
    if (effectiveMode !== "vector")
      hits.sort((a, b) => {
        const aExact =
          a.skill.skillId.toLowerCase() === exact ||
          skillKey(a.skill.skillId, a.skill.version).toLowerCase() === exact;
        const bExact =
          b.skill.skillId.toLowerCase() === exact ||
          skillKey(b.skill.skillId, b.skill.version).toLowerCase() === exact;
        return (
          Number(bExact) - Number(aExact) ||
          (aExact && bExact ? compareSemver(b.skill.version, a.skill.version) : 0)
        );
      });
    const top = hits[0];
    const exactLookup =
      top &&
      [
        top.skill.skillId.toLowerCase(),
        skillKey(top.skill.skillId, top.skill.version).toLowerCase(),
      ].includes(exact);
    const lexicalMargin = lexical.length
      ? (lexical[0].score - (lexical[1]?.score ?? 0)) / Math.max(lexical[0].score, 1e-12)
      : 0;
    // RRF scores are not probabilities. Until model-specific calibration, semantic-only hits require inspection.
    const ambiguous =
      !top ||
      top.applicability === "incompatible" ||
      (!exactLookup && (top.lexicalRank !== 1 || lexicalMargin < 0.2));
    hits = hits.slice(0, limit);
    const result = {
      query: request.query,
      request: structuredClone(request),
      rankingPolicy: {
        version: "scientific-retrieval/1",
        rrfK: this.options.rrfK ?? 60,
        candidateLimit,
        documentPolicy: DOCUMENT_POLICY,
      },
      requestedMode,
      effectiveMode,
      corpusDigest: snapshot.registry.corpusDigest,
      scopeDigest: snapshot.scopeDigest,
      indexState,
      ...(identity && requestedMode !== "lexical" ? { embedding: identity } : {}),
      hits,
      ambiguous,
      executionAuthorized: false as const,
    };
    return { ...result, retrievalDigest: digestCanonical(result) };
  }
  context(result: RetrievalResult, request: RetrievalRequest, options?: ContextRequest) {
    const { retrievalDigest, ...payload } = result;
    if (
      digestCanonical(payload) !== retrievalDigest ||
      digestCanonical({ ...request, asOf: request.asOf ?? result.request.asOf }) !==
        digestCanonical(result.request)
    )
      throw new Error("Retrieval result or request changed before context selection");
    return selectRetrievalContext(this.snapshot(), result, request, options);
  }
  close(): void {
    this.options.embeddings?.close?.();
  }
}
