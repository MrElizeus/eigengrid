import { describe, expect, test } from "bun:test";
import {
  EvidenceAcquisitionError,
  PubChemEvidenceClient,
  RcsbEvidenceClient,
  sha256Digest,
  type ContentAddressedEvidence,
  type ContentAddressedEvidenceCache,
  type EvidenceFetchRequest,
  type EvidenceFetcher,
  type EvidenceFetchResult,
  type RcsbStructureFormat,
  type Sha256Digest,
} from "../src/index";

const encoder = new TextEncoder();
const FIXTURE_TARGET_PROFILE = {
  id: "fixture-only",
  pdbIds: ["1ABC"],
  pubchemCids: [1, 2, 3, 4],
} as const;

class FakeFetcher implements EvidenceFetcher {
  readonly calls: EvidenceFetchRequest[] = [];

  constructor(
    private readonly responder: (
      request: EvidenceFetchRequest,
    ) => EvidenceFetchResult | Promise<EvidenceFetchResult>,
  ) {}

  async fetch(request: EvidenceFetchRequest): Promise<EvidenceFetchResult> {
    this.calls.push(request);
    return this.responder(request);
  }
}

class MemoryContentAddressedCache implements ContentAddressedEvidenceCache {
  readonly records = new Map<Sha256Digest, ContentAddressedEvidence>();
  getCount = 0;
  putCount = 0;

  async get(digest: Sha256Digest): Promise<ContentAddressedEvidence | undefined> {
    this.getCount += 1;
    return this.records.get(digest);
  }

  async put(evidence: ContentAddressedEvidence): Promise<void> {
    this.putCount += 1;
    this.records.set(evidence.digest, evidence);
  }
}

function fetched(
  request: EvidenceFetchRequest,
  content = "synthetic evidence",
  revision = "rev-1",
) {
  return {
    bytes: encoder.encode(content),
    revision,
    sourceLocator: request.sourceLocator,
    mediaType: request.mediaType,
    retrievedAt: "2026-08-23T12:00:00.000Z",
    etag: '"fixture-etag"',
  } satisfies EvidenceFetchResult;
}

describe("typed evidence acquisition", () => {
  test("requires an explicit benchmark profile before any acquisition transport", async () => {
    const fetcher = new FakeFetcher((request) => fetched(request));
    const cache = new MemoryContentAddressedCache();
    await expect(
      new RcsbEvidenceClient(fetcher, cache).acquireStructure("1ABC", "pdb", {
        cachePolicy: "refresh",
      }),
    ).rejects.toMatchObject({ code: "profile_required" });
    await expect(
      new PubChemEvidenceClient(fetcher, cache).acquireCompound(4, "json", {
        cachePolicy: "refresh",
      }),
    ).rejects.toMatchObject({ code: "profile_required" });
    expect(fetcher.calls).toHaveLength(0);
  });

  test("RCSB acquisition uses only the injected fetcher, verifies metadata, and records CAS bytes", async () => {
    const cache = new MemoryContentAddressedCache();
    const fetcher = new FakeFetcher((request) => fetched(request, "data_1ABC\n#", "rcsb-rev-7"));
    const client = new RcsbEvidenceClient(fetcher, cache, FIXTURE_TARGET_PROFILE);

    const result = await client.acquireStructure("1ABC", "mmcif", { cachePolicy: "refresh" });

    expect(fetcher.calls).toEqual([
      {
        provider: "rcsb",
        resourceId: "1ABC",
        sourceLocator: "https://files.rcsb.org/download/1ABC.cif",
        mediaType: "chemical/x-mmcif",
      },
    ]);
    expect(result.digest).toBe(sha256Digest(encoder.encode("data_1ABC\n#")));
    expect(result.source.revision).toBe("rcsb-rev-7");
    expect(result.availability).toBe("fetched");
    expect(cache.putCount).toBe(1);
  });

  test("prefer_cache requires a known digest and never calls transport on a valid hit", async () => {
    const cache = new MemoryContentAddressedCache();
    const initialFetcher = new FakeFetcher((request) => fetched(request));
    const first = await new PubChemEvidenceClient(
      initialFetcher,
      cache,
      FIXTURE_TARGET_PROFILE,
    ).acquireCompound(1, "sdf", {
      cachePolicy: "refresh",
    });
    const forbiddenFetcher = new FakeFetcher(() => {
      throw new Error("transport must not be called");
    });

    const cached = await new PubChemEvidenceClient(
      forbiddenFetcher,
      cache,
      FIXTURE_TARGET_PROFILE,
    ).acquireCompound(1, "sdf", {
      cachePolicy: "prefer_cache",
      expectedDigest: first.digest,
      expectedRevision: "rev-1",
    });

    expect(cached.availability).toBe("cache");
    expect(forbiddenFetcher.calls).toHaveLength(0);
    expect(cache.getCount).toBe(1);
  });

  test("cache_only requires an exact digest and a hit without ever invoking transport", async () => {
    const cache = new MemoryContentAddressedCache();
    const forbiddenFetcher = new FakeFetcher(() => {
      throw new Error("cache_only must never invoke transport");
    });
    const client = new RcsbEvidenceClient(forbiddenFetcher, cache, FIXTURE_TARGET_PROFILE);

    await expect(
      client.acquireStructure("1ABC", "mmcif", { cachePolicy: "cache_only" }),
    ).rejects.toMatchObject({ code: "cache_digest_required" });
    await expect(
      client.acquireStructure("1ABC", "mmcif", { cachePolicy: "bypass" as never }),
    ).rejects.toMatchObject({ code: "invalid_cache_policy" });
    const missingDigest = sha256Digest(encoder.encode("not cached"));
    await expect(
      client.acquireStructure("1ABC", "mmcif", {
        cachePolicy: "cache_only",
        expectedDigest: missingDigest,
      }),
    ).rejects.toMatchObject({ code: "cache_miss" });

    expect(forbiddenFetcher.calls).toHaveLength(0);
    expect(cache.getCount).toBe(1);
    expect(cache.putCount).toBe(0);
  });

  test("cache_only returns a metadata-validated exact hit without network fallback", async () => {
    const cache = new MemoryContentAddressedCache();
    const bytes = encoder.encode("cached 1ABC");
    const expectedDigest = sha256Digest(bytes);
    cache.records.set(expectedDigest, {
      digest: expectedDigest,
      bytes,
      source: {
        provider: "rcsb",
        resourceId: "1ABC",
        sourceLocator: "https://files.rcsb.org/download/1ABC.cif",
        mediaType: "chemical/x-mmcif",
        revision: "rcsb-rev-7",
        retrievedAt: "2026-08-23T12:00:00.000Z",
      },
    });
    const forbiddenFetcher = new FakeFetcher(() => {
      throw new Error("cache_only must never invoke transport");
    });

    const acquired = await new RcsbEvidenceClient(
      forbiddenFetcher,
      cache,
      FIXTURE_TARGET_PROFILE,
    ).acquireStructure("1ABC", "mmcif", {
      cachePolicy: "cache_only",
      expectedDigest,
      expectedRevision: "rcsb-rev-7",
    });

    expect(acquired.availability).toBe("cache");
    expect(acquired.digest).toBe(expectedDigest);
    expect(forbiddenFetcher.calls).toHaveLength(0);
    expect(cache.putCount).toBe(0);
  });

  test("the selected profile rejects unknown PDB entries and unknown CIDs before transport", async () => {
    const cache = new MemoryContentAddressedCache();
    const fetcher = new FakeFetcher((request) => fetched(request));
    const rcsb = new RcsbEvidenceClient(fetcher, cache, FIXTURE_TARGET_PROFILE);
    const pubchem = new PubChemEvidenceClient(fetcher, cache, FIXTURE_TARGET_PROFILE);

    const normalized = await rcsb.acquireStructure("1abc", "pdb", { cachePolicy: "refresh" });
    expect(normalized.source.resourceId).toBe("1ABC");
    await expect(
      rcsb.acquireStructure("2XYZ", "pdb", { cachePolicy: "refresh" }),
    ).rejects.toMatchObject({
      code: "invalid_identifier",
    });
    await expect(
      pubchem.acquireCompound(9999, "json", { cachePolicy: "refresh" }),
    ).rejects.toMatchObject({
      code: "invalid_identifier",
    });
    await expect(
      rcsb.acquireStructure("1ABC", "xyz" as RcsbStructureFormat, {
        cachePolicy: "refresh",
      }),
    ).rejects.toMatchObject({ code: "invalid_format" });
    expect(fetcher.calls).toHaveLength(1);
  });

  test("digest mismatch and revision drift fail closed and do not populate cache", async () => {
    const cache = new MemoryContentAddressedCache();
    const fetcher = new FakeFetcher((request) => fetched(request, "provider bytes", "rev-new"));
    const client = new PubChemEvidenceClient(fetcher, cache, FIXTURE_TARGET_PROFILE);

    await expect(
      client.acquireCompound(3, "json", {
        cachePolicy: "refresh",
        expectedDigest: sha256Digest(encoder.encode("different bytes")),
      }),
    ).rejects.toMatchObject({ code: "content_digest_mismatch" });
    await expect(
      client.acquireCompound(3, "json", {
        cachePolicy: "refresh",
        expectedRevision: "rev-old",
      }),
    ).rejects.toMatchObject({ code: "revision_drift" });
    expect(cache.putCount).toBe(0);
  });

  test("corrupted cached bytes and redirected sources are rejected", async () => {
    const cache = new MemoryContentAddressedCache();
    const expectedBytes = encoder.encode("expected");
    const expectedDigest = sha256Digest(expectedBytes);
    cache.records.set(expectedDigest, {
      digest: expectedDigest,
      bytes: encoder.encode("corrupted"),
      source: {
        provider: "rcsb",
        resourceId: "1ABC",
        sourceLocator: "https://files.rcsb.org/download/1ABC.pdb",
        mediaType: "chemical/x-pdb",
        revision: "rev-1",
        retrievedAt: "2026-08-23T12:00:00.000Z",
      },
    });
    const unusedFetcher = new FakeFetcher((request) => fetched(request));
    await expect(
      new RcsbEvidenceClient(unusedFetcher, cache, FIXTURE_TARGET_PROFILE).acquireStructure(
        "1ABC",
        "pdb",
        {
          cachePolicy: "prefer_cache",
          expectedDigest,
        },
      ),
    ).rejects.toBeInstanceOf(EvidenceAcquisitionError);
    await expect(
      new RcsbEvidenceClient(
        new FakeFetcher((request) => ({
          ...fetched(request),
          sourceLocator: "https://example.invalid/redirect",
        })),
        new MemoryContentAddressedCache(),
        FIXTURE_TARGET_PROFILE,
      ).acquireStructure("1ABC", "pdb", { cachePolicy: "refresh" }),
    ).rejects.toMatchObject({ code: "source_mismatch" });
  });

  test("all four requested CIDs are admitted without attaching unverified chemistry claims", async () => {
    const fetcher = new FakeFetcher((request) => fetched(request, `fixture-${request.resourceId}`));
    const cache = new MemoryContentAddressedCache();
    const client = new PubChemEvidenceClient(fetcher, cache, FIXTURE_TARGET_PROFILE);
    for (const cid of [1, 2, 3, 4] as const) {
      const evidence = await client.acquireCompound(cid, "json", { cachePolicy: "refresh" });
      expect(evidence.source.resourceId).toBe(String(cid));
    }
    expect(fetcher.calls).toHaveLength(4);
  });
});
