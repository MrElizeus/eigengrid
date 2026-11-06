import type { SkillVersionReference } from "@eigengrid/scientific-schema";
import type {
  ResolveScientificSkillsRequest,
  ScientificSkillFragment,
} from "@eigengrid/scientific-skills";

/** Supplied by a trusted host, never inferred from a query or model tool arguments. */
export interface RetrievalPrincipal {
  actorId: string;
  projectIds: readonly string[];
}

export type CatalogAccess =
  | { kind: "public" }
  | { kind: "private"; ownerId: string }
  | { kind: "project"; projectId: string };

export interface CatalogGrant {
  id: string;
  root: string;
  access: CatalogAccess;
  /** Bump when the host changes access policy. Revocation also changes the visible set. */
  revision: string;
}

export interface EmbeddingIdentity {
  model: string;
  revision: string;
  dimensions: number;
  /** Digest of weights, tokenizer, pooling, prefixes, limits and runtime configuration. */
  configurationDigest: string;
}

export interface EmbeddingProvider {
  readonly identity: EmbeddingIdentity;
  embed(
    texts: readonly string[],
    purpose: "query" | "passage",
  ): Promise<readonly (readonly number[])[]>;
  close?(): void;
}

export type RetrievalMode = "lexical" | "vector" | "hybrid" | "scientific";
export type IndexState =
  | "disabled"
  | "missing"
  | "stale"
  | "corrupt"
  | "ready"
  | "provider_unavailable";

export interface RetrievalRequest {
  query: string;
  mode?: RetrievalMode;
  limit?: number;
  candidateLimit?: number;
  domains?: readonly string[];
  engine?: { id: string; version?: string };
  minimumKnowledgeMaturity?: ResolveScientificSkillsRequest["minimumKnowledgeMaturity"];
  requiredCapability?: ResolveScientificSkillsRequest["requiredCapability"];
  /** Known input names, not values or claims about live execution resources. */
  availableInputs?: readonly string[];
  activeConditions?: readonly string[];
  asOf?: string;
}

export interface RetrievalHit {
  skill: SkillVersionReference;
  title: string;
  score: number;
  lexicalRank?: number;
  vectorRank?: number;
  lexicalScore?: number;
  vectorScore?: number;
  fragmentIds: readonly string[];
  applicability: "incompatible" | "unknown" | "constraints_matched";
  reasons: readonly string[];
  reviewStatus: string;
  knowledgeLevel: string;
}

export interface RetrievalResult {
  query: string;
  request: Readonly<RetrievalRequest>;
  rankingPolicy: { version: string; rrfK: number; candidateLimit: number; documentPolicy: string };
  requestedMode: RetrievalMode;
  effectiveMode: RetrievalMode;
  corpusDigest: string;
  scopeDigest: string;
  indexState: IndexState;
  embedding?: EmbeddingIdentity;
  hits: readonly RetrievalHit[];
  ambiguous: boolean;
  /** Audit identity of query, policy, ranking and exact canonical references. */
  retrievalDigest: string;
  executionAuthorized: false;
}

export interface ContextRequest {
  roots?: readonly SkillVersionReference[];
  maxRoots?: number;
  maxCharacters?: number;
  maxFragments?: number;
  requiredFragmentIds?: readonly string[];
}

export interface RetrievalContext {
  status: "complete" | "budget_insufficient" | "unavailable" | "empty" | "ambiguous";
  /** Complete means the conservative retrieval policy is covered, not scientific approval. */
  fragments: readonly ScientificSkillFragment[];
  resolved: readonly SkillVersionReference[];
  missingRequiredFragmentIds: readonly string[];
  totalCharacters: number;
  requiredCharacters: number;
  selectionDigest: string;
  corpusDigest: string;
  scopeDigest: string;
  executionAuthorized: false;
  diagnostic?: string;
}
