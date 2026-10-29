import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { EvidenceReferenceSchema } from "@eigengrid/scientific-schema";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CAS_URI_PATTERN = /^cas:\/\/sha256\/([a-f0-9]{64})$/u;
export const BACKUP_CONTROL_FILE_MAX_BYTES = 1_048_576;
const DIRECT_LEGACY_KINDS = new Set([
  "objective",
  "structure",
  "rendered_input",
  "environment",
  "operation_receipt",
  "artifact",
  "parser_output",
  "skill_fragment",
  "human_review",
]);
const ARTIFACT_EVIDENCE_KINDS = new Set([
  "biomolecular_system_manifest",
  "force_field_stack",
  "pose_candidate",
  "atom_map",
  "topology",
  "coordinates",
  "restart",
  "trajectory",
  "mdout",
  "mdinfo",
  "reproducibility_bundle",
]);

function expectedLegacyEvidenceKind(kind: string): string | undefined {
  if (DIRECT_LEGACY_KINDS.has(kind)) return kind;
  if (["source_snapshot", "construct_audit"].includes(kind)) return "structure";
  if (["normalized_metrics", "analysis_result"].includes(kind)) return "parser_output";
  if (["microstate_decision", "md_assessment"].includes(kind)) return "human_review";
  if (ARTIFACT_EVIDENCE_KINDS.has(kind)) return "artifact";
  return undefined;
}

export interface ScientificCasReference {
  evidenceId: string;
  digest: string;
  uri: string;
  expectedSizeBytes?: number;
  mediaType?: string;
  sourceId?: string;
}

export interface BackupCasContentStream {
  digest: string;
  uri: string;
  sizeBytes: number;
  bytes: AsyncIterable<Uint8Array>;
}

/**
 * Structural boundary implemented by ContentAddressedArtifactStore without
 * coupling the backup package to mission-runtime.
 */
export interface BackupContentAddressedStore {
  getStream(digest: string): Promise<BackupCasContentStream>;
}

export interface ScientificCasIndexObject {
  digest: string;
  uri: string;
  archivePath: string;
  sizeBytes: number;
  evidenceIds: string[];
}

export interface ScientificCasIndex {
  format: "eigengrid-scientific-cas";
  formatVersion: 1;
  hashAlgorithm: "sha256";
  objects: ScientificCasIndexObject[];
}

type ScientificEvidenceRow = {
  id: string;
  mission_id: string;
  work_unit_id: string | null;
  kind: string;
  evidence_kind_id: string;
  uri: string;
  content_digest: string;
  immutable: number | boolean;
  source_id: string | null;
  payload_json: string;
  created_at: string;
};

type ScientificArtifactClaimRow = {
  evidence_id: string;
  content_digest: string;
  media_type: string;
  size_bytes: number | null;
  operation_receipt_id?: string | null;
};

type ClaimMetadata = {
  sizeBytes?: number;
  mediaType?: string;
  sourceId?: string;
};

const CLAIM_TABLES = [
  { name: "scientific_biomolecular_manifest_artifacts", hasReceipt: true },
  { name: "scientific_biomolecular_material_artifact_claims", hasReceipt: true },
  { name: "scientific_force_field_stack_evidence", hasReceipt: false },
  { name: "scientific_md_stage_result_artifacts", hasReceipt: true },
] as const;
const MATERIAL_DIGEST_REFERENCE_TABLES = [
  {
    name: "scientific_force_field_stack_revisions",
    evidenceColumn: "artifact_evidence_id",
    digestColumn: "stack_digest",
  },
  {
    name: "scientific_atom_map_revisions",
    evidenceColumn: "artifact_evidence_id",
    digestColumn: "map_digest",
  },
] as const;

function own(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  if (!own(value, key)) return undefined;
  return requiredString(value[key], label);
}

function optionalSize(
  value: Record<string, unknown>,
  key: string,
  label: string,
): number | undefined {
  if (!own(value, key)) return undefined;
  const size = value[key];
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return size;
}

function exactOptionalColumn(
  payload: Record<string, unknown>,
  key: string,
  column: string | null,
  evidenceId: string,
): string | undefined {
  const value = optionalString(payload, key, `Scientific evidence ${evidenceId} ${key}`);
  if ((column === null && value !== undefined) || (column !== null && value !== column)) {
    throw new Error(`Scientific evidence ${evidenceId} payload ${key} disagrees with its row`);
  }
  return value;
}

function parseEvidencePayload(row: ScientificEvidenceRow): {
  sizeBytes?: number;
  mediaType?: string;
  sourceId?: string;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(row.payload_json);
  } catch {
    throw new Error(`Scientific evidence ${row.id} has malformed payload_json`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Scientific evidence ${row.id} payload_json must be an object`);
  }
  const parsed = EvidenceReferenceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Scientific evidence ${row.id} payload_json violates EvidenceReferenceSchema`);
  }
  const payload = raw as Record<string, unknown>;
  const exact = [
    ["id", row.id],
    ["missionId", row.mission_id],
    ["kind", row.evidence_kind_id],
    ["uri", row.uri],
    ["contentDigest", row.content_digest],
    ["createdAt", row.created_at],
  ] as const;
  for (const [key, expected] of exact) {
    if (requiredString(payload[key], `Scientific evidence ${row.id} ${key}`) !== expected) {
      throw new Error(`Scientific evidence ${row.id} payload ${key} disagrees with its row`);
    }
  }
  const expectedLegacyKind = expectedLegacyEvidenceKind(row.evidence_kind_id);
  if (!expectedLegacyKind || row.kind !== expectedLegacyKind) {
    throw new Error(`Scientific evidence ${row.id} legacy kind disagrees with evidence_kind_id`);
  }
  if (payload.immutable !== true || (row.immutable !== 1 && row.immutable !== true)) {
    throw new Error(`Scientific evidence ${row.id} is not canonically immutable`);
  }
  exactOptionalColumn(payload, "workUnitId", row.work_unit_id, row.id);
  const sourceId = exactOptionalColumn(payload, "sourceId", row.source_id, row.id);
  const sizeBytes = optionalSize(payload, "sizeBytes", `Scientific evidence ${row.id} sizeBytes`);
  const mediaType = optionalString(payload, "mediaType", `Scientific evidence ${row.id} mediaType`);
  return {
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(sourceId === undefined ? {} : { sourceId }),
  };
}

function mergeClaimMetadata(
  evidenceId: string,
  current: ClaimMetadata,
  incoming: ClaimMetadata,
): ClaimMetadata {
  for (const key of ["sizeBytes", "mediaType", "sourceId"] as const) {
    if (
      current[key] !== undefined &&
      incoming[key] !== undefined &&
      current[key] !== incoming[key]
    ) {
      throw new Error(`Scientific evidence ${evidenceId} has conflicting ${key} claims`);
    }
  }
  return {
    sizeBytes: current.sizeBytes ?? incoming.sizeBytes,
    mediaType: current.mediaType ?? incoming.mediaType,
    sourceId: current.sourceId ?? incoming.sourceId,
  };
}

function tableExists(database: Database, name: string): boolean {
  return Boolean(
    database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

function validateArtifactClaims(
  database: Database,
  evidenceRows: Map<string, ScientificEvidenceRow>,
  payloadMetadata: Map<string, ClaimMetadata>,
): Map<string, ClaimMetadata> {
  const observed = new Map<string, ClaimMetadata>();
  for (const table of CLAIM_TABLES) {
    if (!tableExists(database, table.name)) continue;
    const receipt = table.hasReceipt ? ", operation_receipt_id" : "";
    const rows = database
      .query(
        `SELECT evidence_id, content_digest, media_type, size_bytes${receipt}
           FROM ${table.name}
          ORDER BY evidence_id`,
      )
      .all() as ScientificArtifactClaimRow[];
    for (const claim of rows) {
      const evidence = evidenceRows.get(claim.evidence_id);
      if (!evidence) {
        throw new Error(`${table.name} references missing evidence ${claim.evidence_id}`);
      }
      const payload = payloadMetadata.get(claim.evidence_id);
      if (!payload || !CAS_URI_PATTERN.test(evidence.uri)) {
        throw new Error(`${table.name} material evidence ${claim.evidence_id} is not CAS-backed`);
      }
      if (
        !SHA256_PATTERN.test(claim.content_digest) ||
        claim.content_digest !== evidence.content_digest
      ) {
        throw new Error(`${table.name} digest disagrees with evidence ${claim.evidence_id}`);
      }
      const mediaType = requiredString(
        claim.media_type,
        `${table.name} media_type for ${claim.evidence_id}`,
      );
      let sizeBytes: number | undefined;
      if (claim.size_bytes !== null) {
        if (
          typeof claim.size_bytes !== "number" ||
          !Number.isSafeInteger(claim.size_bytes) ||
          claim.size_bytes < 0
        ) {
          throw new Error(`${table.name} size_bytes is invalid for ${claim.evidence_id}`);
        }
        sizeBytes = claim.size_bytes;
      }
      const sourceId = table.hasReceipt
        ? requiredString(
            claim.operation_receipt_id,
            `${table.name} operation_receipt_id for ${claim.evidence_id}`,
          )
        : undefined;
      if (
        payload.mediaType !== mediaType ||
        payload.sizeBytes !== sizeBytes ||
        (table.hasReceipt && payload.sourceId !== sourceId)
      ) {
        throw new Error(`${table.name} metadata disagrees with evidence ${claim.evidence_id}`);
      }
      const metadata = mergeClaimMetadata(
        claim.evidence_id,
        observed.get(claim.evidence_id) ?? {},
        {
          ...(sizeBytes === undefined ? {} : { sizeBytes }),
          mediaType,
          ...(sourceId === undefined ? {} : { sourceId }),
        },
      );
      observed.set(claim.evidence_id, metadata);
      mergeClaimMetadata(claim.evidence_id, payload, metadata);
    }
  }
  for (const table of MATERIAL_DIGEST_REFERENCE_TABLES) {
    if (!tableExists(database, table.name)) continue;
    const rows = database
      .query(
        `SELECT ${table.evidenceColumn} AS evidence_id,
                ${table.digestColumn} AS content_digest
           FROM ${table.name}
          ORDER BY ${table.evidenceColumn}`,
      )
      .all() as Array<{ evidence_id: string; content_digest: string }>;
    for (const reference of rows) {
      const evidence = evidenceRows.get(reference.evidence_id);
      if (!evidence) {
        throw new Error(`${table.name} references missing evidence ${reference.evidence_id}`);
      }
      if (
        !SHA256_PATTERN.test(reference.content_digest) ||
        reference.content_digest !== evidence.content_digest
      ) {
        throw new Error(`${table.name} digest disagrees with evidence ${reference.evidence_id}`);
      }
    }
  }
  return observed;
}

function validateReference(
  row: ScientificEvidenceRow,
  payload: ClaimMetadata,
  claims: ClaimMetadata,
): ScientificCasReference | undefined {
  if (!row.uri.startsWith("cas://")) return undefined;
  const match = CAS_URI_PATTERN.exec(row.uri);
  if (!match) {
    throw new Error(`Scientific evidence ${row.id} has an invalid CAS URI`);
  }
  const digest = match[1]!;
  if (!SHA256_PATTERN.test(row.content_digest) || row.content_digest !== digest) {
    throw new Error(`Scientific evidence ${row.id} does not bind its CAS URI digest exactly`);
  }
  if (row.immutable !== 1 && row.immutable !== true) {
    throw new Error(`Scientific CAS evidence ${row.id} is not marked immutable`);
  }
  const merged = mergeClaimMetadata(row.id, payload, claims);
  return {
    evidenceId: row.id,
    digest,
    uri: row.uri,
    ...(merged.sizeBytes === undefined ? {} : { expectedSizeBytes: merged.sizeBytes }),
    ...(merged.mediaType === undefined ? {} : { mediaType: merged.mediaType }),
    ...(merged.sourceId === undefined ? {} : { sourceId: merged.sourceId }),
  };
}

/** Read exact CAS references from an already frozen SQLite snapshot. */
export async function readScientificCasReferences(
  snapshotPath: string,
): Promise<ScientificCasReference[]> {
  const { Database } = await import("bun:sqlite");
  const database = new Database(snapshotPath, { readonly: true });
  try {
    const integrity = database.query("PRAGMA integrity_check").all() as Array<
      Record<string, unknown>
    >;
    if (
      integrity.length !== 1 ||
      Object.keys(integrity[0]!).length !== 1 ||
      integrity[0]!.integrity_check !== "ok"
    ) {
      throw new Error("Scientific backup head.sqlite failed integrity_check");
    }
    const foreignKeyViolations = database.query("PRAGMA foreign_key_check").all();
    if (foreignKeyViolations.length !== 0) {
      throw new Error(
        `Scientific backup head.sqlite has ${foreignKeyViolations.length} foreign-key violation(s)`,
      );
    }
    const table = database
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scientific_evidence'")
      .get();
    if (!table) return [];
    const columns = new Set(
      (
        database.query("PRAGMA table_info(scientific_evidence)").all() as Array<{ name: string }>
      ).map((column) => column.name),
    );
    const evidenceKind = columns.has("evidence_kind_id")
      ? "evidence_kind_id"
      : "kind AS evidence_kind_id";
    const rows = database
      .query(
        `SELECT id, mission_id, work_unit_id, kind, ${evidenceKind}, uri,
                content_digest, immutable, source_id, payload_json, created_at
           FROM scientific_evidence
          ORDER BY id`,
      )
      .all() as ScientificEvidenceRow[];
    const evidenceRows = new Map(rows.map((row) => [row.id, row]));
    const payloadMetadata = new Map<string, ClaimMetadata>();
    for (const row of rows) {
      if (row.uri.startsWith("cas://")) payloadMetadata.set(row.id, parseEvidencePayload(row));
    }
    const claimMetadata = validateArtifactClaims(database, evidenceRows, payloadMetadata);
    return rows
      .map((row) =>
        validateReference(row, payloadMetadata.get(row.id) ?? {}, claimMetadata.get(row.id) ?? {}),
      )
      .filter((reference): reference is ScientificCasReference => reference !== undefined);
  } finally {
    database.close();
  }
}

/** Inspect snapshot bytes without consulting the mutable source database. */
export async function readScientificCasReferencesFromBytes(
  snapshot: Uint8Array,
): Promise<ScientificCasReference[]> {
  const directory = await mkdtemp(join(tmpdir(), "eigengrid-backup-cas-catalog-"));
  const path = join(directory, "head.sqlite");
  try {
    await writeFile(path, snapshot, { flag: "wx", mode: 0o600 });
    return await readScientificCasReferences(path);
  } finally {
    await rm(directory, { recursive: true, force: false });
  }
}

export function scientificCasArchivePath(digest: string): string {
  if (!SHA256_PATTERN.test(digest)) throw new Error("Invalid scientific CAS digest");
  return `cas/sha256/${digest.slice(0, 2)}/${digest}`;
}

export function groupScientificCasReferences(
  references: ScientificCasReference[],
): Array<{ digest: string; uri: string; evidenceIds: string[]; expectedSizeBytes?: number }> {
  const grouped = new Map<
    string,
    { digest: string; uri: string; evidenceIds: string[]; expectedSizeBytes?: number }
  >();
  for (const reference of references) {
    const current = grouped.get(reference.digest);
    if (current) {
      current.evidenceIds.push(reference.evidenceId);
      if (
        current.expectedSizeBytes !== undefined &&
        reference.expectedSizeBytes !== undefined &&
        current.expectedSizeBytes !== reference.expectedSizeBytes
      ) {
        throw new Error(`Scientific CAS object ${reference.digest} has conflicting size claims`);
      }
      current.expectedSizeBytes ??= reference.expectedSizeBytes;
    } else {
      grouped.set(reference.digest, {
        digest: reference.digest,
        uri: reference.uri,
        evidenceIds: [reference.evidenceId],
        ...(reference.expectedSizeBytes === undefined
          ? {}
          : { expectedSizeBytes: reference.expectedSizeBytes }),
      });
    }
  }
  return Array.from(grouped.values())
    .map((entry) => ({ ...entry, evidenceIds: entry.evidenceIds.sort() }))
    .sort((left, right) => left.digest.localeCompare(right.digest));
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (result.bytesWritten <= 0) throw new Error("Scientific CAS backup write made no progress");
    offset += result.bytesWritten;
  }
}

/**
 * Copy one descriptor-bound CAS stream into private backup staging and verify
 * its address again while copying.
 */
export async function stageScientificCasObject(
  store: BackupContentAddressedStore,
  digest: string,
  targetPath: string,
  maxBytes?: number,
): Promise<number> {
  const content = await store.getStream(digest);
  if (
    content.digest !== digest ||
    content.uri !== `cas://sha256/${digest}` ||
    !Number.isSafeInteger(content.sizeBytes) ||
    content.sizeBytes < 0 ||
    (maxBytes !== undefined && content.sizeBytes > maxBytes)
  ) {
    throw new Error(`CAS reader returned conflicting metadata for ${digest}`);
  }
  const handle = await open(
    targetPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o400,
  );
  const hash = createHash("sha256");
  let sizeBytes = 0;
  try {
    for await (const value of content.bytes) {
      const chunk = Uint8Array.from(value);
      sizeBytes += chunk.byteLength;
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes > content.sizeBytes) {
        throw new Error(`CAS stream size exceeds declared size for ${digest}`);
      }
      hash.update(chunk);
      await writeAll(handle, chunk);
    }
    if (sizeBytes !== content.sizeBytes || hash.digest("hex") !== digest) {
      throw new Error(`CAS stream bytes do not match their address for ${digest}`);
    }
    await handle.sync();
    await handle.chmod(0o400);
    return sizeBytes;
  } finally {
    await handle.close();
  }
}

export function parseScientificCasIndex(value: unknown): ScientificCasIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Scientific CAS index must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.format !== "eigengrid-scientific-cas" ||
    candidate.formatVersion !== 1 ||
    candidate.hashAlgorithm !== "sha256" ||
    !Array.isArray(candidate.objects)
  ) {
    throw new Error("Scientific CAS index header is invalid");
  }
  const objects = candidate.objects.map((raw): ScientificCasIndexObject => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Scientific CAS index object is invalid");
    }
    const object = raw as Record<string, unknown>;
    if (
      typeof object.digest !== "string" ||
      !SHA256_PATTERN.test(object.digest) ||
      object.uri !== `cas://sha256/${object.digest}` ||
      object.archivePath !== scientificCasArchivePath(object.digest) ||
      typeof object.sizeBytes !== "number" ||
      !Number.isSafeInteger(object.sizeBytes) ||
      object.sizeBytes < 0 ||
      !Array.isArray(object.evidenceIds) ||
      object.evidenceIds.some((id) => typeof id !== "string" || id.length === 0) ||
      new Set(object.evidenceIds).size !== object.evidenceIds.length
    ) {
      throw new Error("Scientific CAS index object fields are invalid");
    }
    return {
      digest: object.digest,
      uri: object.uri as string,
      archivePath: object.archivePath as string,
      sizeBytes: object.sizeBytes,
      evidenceIds: [...(object.evidenceIds as string[])],
    };
  });
  if (
    new Set(objects.map((object) => object.digest)).size !== objects.length ||
    objects.some(
      (object, index) => index > 0 && objects[index - 1]!.digest.localeCompare(object.digest) >= 0,
    ) ||
    objects.some((object) =>
      object.evidenceIds.some(
        (id, index) => index > 0 && object.evidenceIds[index - 1]!.localeCompare(id) >= 0,
      ),
    )
  ) {
    throw new Error("Scientific CAS index is not uniquely canonical");
  }
  return {
    format: "eigengrid-scientific-cas",
    formatVersion: 1,
    hashAlgorithm: "sha256",
    objects,
  };
}
