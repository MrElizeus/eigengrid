import {
  BiomolecularAcquisitionCachePolicySchema,
  PdbIdentifierSchema,
  PubChemCidSchema,
  type BiomolecularAcquisitionCachePolicy,
  type PdbIdentifier,
  type PubChemCid,
} from "@eigengrid/scientific-schema";
import { cloneBytes, parseSha256Digest, sha256Digest, type Sha256Digest } from "./digest";
import {
  isProfilePdbId,
  isProfilePubChemCid,
  type BenchmarkTargetProfile,
} from "./benchmark-profiles";

export type EvidenceProvider = "rcsb" | "pubchem";
export type EvidenceCachePolicy = BiomolecularAcquisitionCachePolicy;

export interface EvidenceFetchRequest {
  readonly provider: EvidenceProvider;
  readonly resourceId: string;
  readonly sourceLocator: string;
  readonly mediaType: string;
}

export interface EvidenceFetchResult {
  readonly bytes: Uint8Array;
  readonly revision: string;
  readonly sourceLocator: string;
  readonly mediaType: string;
  readonly retrievedAt: string;
  readonly etag?: string;
  readonly lastModified?: string;
}

/** The only capability allowed to perform transport. Domain clients never call a network API directly. */
export interface EvidenceFetcher {
  fetch(request: EvidenceFetchRequest): Promise<EvidenceFetchResult>;
}

export interface EvidenceSourceMetadata {
  readonly provider: EvidenceProvider;
  readonly resourceId: string;
  readonly sourceLocator: string;
  readonly mediaType: string;
  readonly revision: string;
  readonly retrievedAt: string;
  readonly etag?: string;
  readonly lastModified?: string;
}

export interface ContentAddressedEvidence {
  readonly digest: Sha256Digest;
  readonly bytes: Uint8Array;
  readonly source: EvidenceSourceMetadata;
}

/**
 * Cache lookup is only by a caller-supplied content digest. Implementations may
 * maintain indexes, but this contract cannot turn a mutable locator into cache identity.
 */
export interface ContentAddressedEvidenceCache {
  get(digest: Sha256Digest): Promise<ContentAddressedEvidence | undefined>;
  put(evidence: ContentAddressedEvidence): Promise<void>;
}

export interface EvidenceAcquisitionOptions {
  readonly cachePolicy: EvidenceCachePolicy;
  readonly expectedDigest?: string;
  readonly expectedRevision?: string;
}

export interface AcquiredEvidence extends ContentAddressedEvidence {
  readonly availability: "cache" | "fetched";
}

export type EvidenceAcquisitionErrorCode =
  | "invalid_identifier"
  | "invalid_format"
  | "invalid_cache_policy"
  | "invalid_expected_digest"
  | "cache_digest_required"
  | "cache_miss"
  | "cache_digest_mismatch"
  | "cache_metadata_mismatch"
  | "content_digest_mismatch"
  | "revision_drift"
  | "source_mismatch"
  | "media_type_mismatch"
  | "empty_content"
  | "missing_revision"
  | "invalid_source_metadata"
  | "profile_required";

export class EvidenceAcquisitionError extends Error {
  constructor(
    readonly code: EvidenceAcquisitionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EvidenceAcquisitionError";
  }
}

export type RcsbStructureFormat = "mmcif" | "pdb";
export type PubChemCompoundFormat = "sdf" | "json";

interface ResolvedEvidenceRequest extends EvidenceFetchRequest {}

function rcsbRequest(pdbId: PdbIdentifier, format: RcsbStructureFormat): ResolvedEvidenceRequest {
  const extension = format === "mmcif" ? "cif" : "pdb";
  return {
    provider: "rcsb",
    resourceId: pdbId,
    sourceLocator: `https://files.rcsb.org/download/${pdbId}.${extension}`,
    mediaType: format === "mmcif" ? "chemical/x-mmcif" : "chemical/x-pdb",
  };
}

function pubChemRequest(cid: PubChemCid, format: PubChemCompoundFormat): ResolvedEvidenceRequest {
  const representation = format === "sdf" ? "SDF?record_type=3d" : "JSON";
  return {
    provider: "pubchem",
    resourceId: String(cid),
    sourceLocator: `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/${representation}`,
    mediaType: format === "sdf" ? "chemical/x-mdl-sdfile" : "application/json",
  };
}

function assertNonEmptyRevision(revision: string): void {
  if (revision.trim().length === 0) {
    throw new EvidenceAcquisitionError(
      "missing_revision",
      "Fetcher response omitted a provider revision",
    );
  }
}

function assertExpectedRevision(actual: string, expected: string | undefined): void {
  if (expected !== undefined && actual !== expected) {
    throw new EvidenceAcquisitionError(
      "revision_drift",
      `Provider revision drift: expected ${expected}, observed ${actual}`,
    );
  }
}

function copyEvidence(
  evidence: ContentAddressedEvidence,
  availability: AcquiredEvidence["availability"],
): AcquiredEvidence {
  return {
    digest: evidence.digest,
    bytes: cloneBytes(evidence.bytes),
    source: { ...evidence.source },
    availability,
  };
}

function validateCachedEvidence(
  cached: ContentAddressedEvidence,
  expectedDigest: Sha256Digest,
  request: ResolvedEvidenceRequest,
  expectedRevision: string | undefined,
): void {
  if (cached.digest !== expectedDigest || sha256Digest(cached.bytes) !== expectedDigest) {
    throw new EvidenceAcquisitionError(
      "cache_digest_mismatch",
      `Cached bytes do not match requested digest ${expectedDigest}`,
    );
  }
  const source = cached.source;
  if (
    source.provider !== request.provider ||
    source.resourceId !== request.resourceId ||
    source.sourceLocator !== request.sourceLocator
  ) {
    throw new EvidenceAcquisitionError(
      "cache_metadata_mismatch",
      "Cached evidence metadata does not match the allowlisted request",
    );
  }
  if (source.mediaType !== request.mediaType) {
    throw new EvidenceAcquisitionError(
      "cache_metadata_mismatch",
      `Cached media type ${source.mediaType} does not match ${request.mediaType}`,
    );
  }
  assertNonEmptyRevision(source.revision);
  assertExpectedRevision(source.revision, expectedRevision);
}

async function acquire(
  request: ResolvedEvidenceRequest,
  options: EvidenceAcquisitionOptions,
  fetcher: EvidenceFetcher,
  cache: ContentAddressedEvidenceCache,
): Promise<AcquiredEvidence> {
  if (!BiomolecularAcquisitionCachePolicySchema.safeParse(options.cachePolicy).success) {
    throw new EvidenceAcquisitionError(
      "invalid_cache_policy",
      `Unsupported evidence cache policy ${JSON.stringify(options.cachePolicy)}`,
    );
  }
  let expectedDigest: Sha256Digest | undefined;
  if (options.expectedDigest !== undefined) {
    try {
      expectedDigest = parseSha256Digest(options.expectedDigest);
    } catch (error) {
      throw new EvidenceAcquisitionError(
        "invalid_expected_digest",
        error instanceof Error ? error.message : "Invalid expected SHA-256 digest",
      );
    }
  }

  if (options.cachePolicy === "cache_only" && expectedDigest === undefined) {
    throw new EvidenceAcquisitionError(
      "cache_digest_required",
      "cache_only requires an exact expected SHA-256 digest",
    );
  }

  if (
    (options.cachePolicy === "cache_only" || options.cachePolicy === "prefer_cache") &&
    expectedDigest !== undefined
  ) {
    const cached = await cache.get(expectedDigest);
    if (cached !== undefined) {
      validateCachedEvidence(cached, expectedDigest, request, options.expectedRevision);
      return copyEvidence(cached, "cache");
    }
    if (options.cachePolicy === "cache_only") {
      throw new EvidenceAcquisitionError(
        "cache_miss",
        `No cached evidence exists for exact digest ${expectedDigest}`,
      );
    }
  }

  const fetched = await fetcher.fetch({ ...request });
  if (fetched.sourceLocator !== request.sourceLocator) {
    throw new EvidenceAcquisitionError(
      "source_mismatch",
      `Fetcher returned ${fetched.sourceLocator}; expected allowlisted source ${request.sourceLocator}`,
    );
  }
  if (fetched.mediaType !== request.mediaType) {
    throw new EvidenceAcquisitionError(
      "media_type_mismatch",
      `Fetcher returned ${fetched.mediaType}; expected ${request.mediaType}`,
    );
  }
  if (fetched.bytes.byteLength === 0) {
    throw new EvidenceAcquisitionError(
      "empty_content",
      "Fetcher returned an empty evidence payload",
    );
  }
  if (fetched.retrievedAt.trim() === "" || Number.isNaN(Date.parse(fetched.retrievedAt))) {
    throw new EvidenceAcquisitionError(
      "invalid_source_metadata",
      "Fetcher response retrievedAt must be an explicit timestamp",
    );
  }
  assertNonEmptyRevision(fetched.revision);
  assertExpectedRevision(fetched.revision, options.expectedRevision);

  const digest = sha256Digest(fetched.bytes);
  if (expectedDigest !== undefined && digest !== expectedDigest) {
    throw new EvidenceAcquisitionError(
      "content_digest_mismatch",
      `Fetched digest ${digest} does not match expected digest ${expectedDigest}`,
    );
  }

  const evidence: ContentAddressedEvidence = {
    digest,
    bytes: cloneBytes(fetched.bytes),
    source: {
      provider: request.provider,
      resourceId: request.resourceId,
      sourceLocator: request.sourceLocator,
      mediaType: request.mediaType,
      revision: fetched.revision,
      retrievedAt: fetched.retrievedAt,
      ...(fetched.etag === undefined ? {} : { etag: fetched.etag }),
      ...(fetched.lastModified === undefined ? {} : { lastModified: fetched.lastModified }),
    },
  };

  await cache.put({
    ...evidence,
    bytes: cloneBytes(evidence.bytes),
    source: { ...evidence.source },
  });
  return copyEvidence(evidence, "fetched");
}

export class RcsbEvidenceClient {
  constructor(
    private readonly fetcher: EvidenceFetcher,
    private readonly cache: ContentAddressedEvidenceCache,
    private readonly profile?: BenchmarkTargetProfile,
  ) {}

  async acquireStructure(
    pdbId: string,
    format: RcsbStructureFormat,
    options: EvidenceAcquisitionOptions,
  ): Promise<AcquiredEvidence> {
    if (!this.profile) {
      throw new EvidenceAcquisitionError(
        "profile_required",
        "External structure acquisition requires an explicit benchmark target profile",
      );
    }
    const normalizedPdbId = pdbId.toUpperCase();
    if (!PdbIdentifierSchema.safeParse(normalizedPdbId).success) {
      throw new EvidenceAcquisitionError(
        "invalid_identifier",
        "RCSB PDB ID " + JSON.stringify(pdbId) + " is not a valid PDB identifier",
      );
    }
    if (!isProfilePdbId(this.profile, normalizedPdbId)) {
      throw new EvidenceAcquisitionError(
        "invalid_identifier",
        "RCSB PDB ID " + JSON.stringify(pdbId) + " is not in the selected target profile",
      );
    }
    if (format !== "mmcif" && format !== "pdb") {
      throw new EvidenceAcquisitionError(
        "invalid_format",
        `RCSB format ${JSON.stringify(format)} is not allowlisted`,
      );
    }
    return acquire(rcsbRequest(normalizedPdbId, format), options, this.fetcher, this.cache);
  }
}

export class PubChemEvidenceClient {
  constructor(
    private readonly fetcher: EvidenceFetcher,
    private readonly cache: ContentAddressedEvidenceCache,
    private readonly profile?: BenchmarkTargetProfile,
  ) {}

  async acquireCompound(
    cid: number,
    format: PubChemCompoundFormat,
    options: EvidenceAcquisitionOptions,
  ): Promise<AcquiredEvidence> {
    if (!this.profile) {
      throw new EvidenceAcquisitionError(
        "profile_required",
        "External compound acquisition requires an explicit benchmark target profile",
      );
    }
    if (!Number.isSafeInteger(cid) || !PubChemCidSchema.safeParse(cid).success) {
      throw new EvidenceAcquisitionError(
        "invalid_identifier",
        "PubChem CID " + JSON.stringify(cid) + " is not a valid PubChem CID",
      );
    }
    if (!isProfilePubChemCid(this.profile, cid)) {
      throw new EvidenceAcquisitionError(
        "invalid_identifier",
        "PubChem CID " + JSON.stringify(cid) + " is not in the selected target profile",
      );
    }
    if (format !== "sdf" && format !== "json") {
      throw new EvidenceAcquisitionError(
        "invalid_format",
        `PubChem format ${JSON.stringify(format)} is not allowlisted`,
      );
    }
    return acquire(pubChemRequest(cid, format), options, this.fetcher, this.cache);
  }
}
