// ────────────────────────────────────────────────────────────
// Centralized safe row mapping / runtime validation helpers
// Shared by SQLite and PostgreSQL adapters.
// ────────────────────────────────────────────────────────────

import type {
  Artifact,
  ArtifactKind,
  ChemistryResult,
  JobAttempt,
  JobAttemptStatus,
  RunnerKind,
  PermissionEffect,
} from "@eigengrid/core";
import { DbRowValidationError } from "./errors";

// ── Scalar validators ──────────────────────────────────────

/** Read a string field, throwing on missing/non-string values. */
export function readString(row: Record<string, unknown>, field: string): string {
  const v = row[field];
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  throw new DbRowValidationError(
    inferTable(row),
    field,
    `expected string, got ${typeof v} (${JSON.stringify(v)})`,
  );
}

/** Read an optional string field. */
export function readOptionalString(
  row: Record<string, unknown>,
  field: string,
): string | undefined {
  const v = row[field];
  if (v === null || v === undefined) return undefined;
  return String(v);
}

/** Read a number field (works with integer/bigint/text). */
export function readNumber(row: Record<string, unknown>, field: string): number {
  const v = row[field];
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (!isNaN(n)) return n;
  }
  if (typeof v === "bigint") return Number(v);
  throw new DbRowValidationError(
    inferTable(row),
    field,
    `expected number, got ${typeof v} (${JSON.stringify(v)})`,
  );
}

/** Read an optional number field. */
export function readOptionalNumber(
  row: Record<string, unknown>,
  field: string,
): number | undefined {
  const v = row[field];
  if (v === null || v === undefined) return undefined;
  return readNumber(row, field);
}

/** Read a boolean field (works with integer 0/1, true/false). */
export function readBoolean(row: Record<string, unknown>, field: string): boolean {
  const v = row[field];
  if (typeof v === "boolean") return v;
  if (v === 1 || v === 0) return v === 1;
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  throw new DbRowValidationError(
    inferTable(row),
    field,
    `expected boolean, got ${typeof v} (${JSON.stringify(v)})`,
  );
}

/** Read an optional boolean field. */
export function readOptionalBoolean(
  row: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const v = row[field];
  if (v === null || v === undefined) return undefined;
  return readBoolean(row, field);
}

/** Parse a JSON array field, returning a default on null/missing/invalid. */
export function readJsonArray(row: Record<string, unknown>, field: string): string[] {
  const v = row[field];
  if (v === null || v === undefined) return [];
  try {
    const parsed = typeof v === "string" ? JSON.parse(v) : v;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Parse a JSON object field, returning null on null/missing/invalid. */
export function readJsonObject(
  row: Record<string, unknown>,
  field: string,
): Record<string, unknown> | null {
  const v = row[field];
  if (v === null || v === undefined) return null;
  try {
    const parsed = typeof v === "string" ? JSON.parse(v) : v;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Try-parse a JSON string to an object, returning null on failure. */
export function tryParseJson(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Try-parse a JSON string to an array, returning [] on failure. */
export function tryParseJsonArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── Table name inference ───────────────────────────────────

function inferTable(row: Record<string, unknown>): string {
  // Heuristic: use the first key before an underscore as a table hint
  for (const key of Object.keys(row)) {
    if (key !== "id") {
      const parts = key.split("_");
      if (parts.length > 1) return parts[0] + "_table";
    }
  }
  return "unknown";
}

// ── Row mappers ────────────────────────────────────────────

export function mapJobAttemptRow(row: Record<string, unknown>): JobAttempt {
  return {
    id: readString(row, "id"),
    jobId: readString(row, "job_id"),
    runner: readString(row, "runner") as RunnerKind,
    status: readString(row, "status") as JobAttemptStatus,
    command: readString(row, "command"),
    cwd: readString(row, "cwd"),
    ...(readOptionalNumber(row, "pid") !== undefined
      ? { pid: readOptionalNumber(row, "pid")! }
      : {}),
    ...(readOptionalNumber(row, "exit_code") !== undefined
      ? { exitCode: readOptionalNumber(row, "exit_code")! }
      : {}),
    ...(readOptionalNumber(row, "started_at") !== undefined
      ? { startedAt: readOptionalNumber(row, "started_at")! }
      : {}),
    ...(readOptionalNumber(row, "finished_at") !== undefined
      ? { finishedAt: readOptionalNumber(row, "finished_at")! }
      : {}),
    createdAt: readNumber(row, "created_at"),
    updatedAt: readNumber(row, "updated_at"),
  };
}

export function mapArtifactRow(row: Record<string, unknown>): Artifact {
  return {
    id: readString(row, "id"),
    jobId: readString(row, "job_id"),
    attemptId: readString(row, "attempt_id"),
    kind: readString(row, "kind") as ArtifactKind,
    path: readString(row, "path"),
    ...(readOptionalString(row, "label") !== undefined
      ? { label: readOptionalString(row, "label")! }
      : {}),
    ...(readOptionalString(row, "mime_type") !== undefined
      ? { mimeType: readOptionalString(row, "mime_type")! }
      : {}),
    ...(readOptionalNumber(row, "size_bytes") !== undefined
      ? { sizeBytes: readOptionalNumber(row, "size_bytes")! }
      : {}),
    createdAt: readNumber(row, "created_at"),
  };
}

export function mapResultRow(row: Record<string, unknown>): ChemistryResult {
  return {
    jobId: readString(row, "job_id"),
    attemptId: readString(row, "attempt_id"),
    parser: readString(row, "parser") as ChemistryResult["parser"],
    status: readString(row, "status") as ChemistryResult["status"],
    ...(readOptionalNumber(row, "energy_hartree") !== undefined
      ? { energyHartree: readOptionalNumber(row, "energy_hartree")! }
      : {}),
    ...(readOptionalBoolean(row, "scf_converged") !== undefined
      ? { scfConverged: readOptionalBoolean(row, "scf_converged")! }
      : {}),
    ...(readOptionalNumber(row, "imaginary_frequencies") !== undefined
      ? { imaginaryFrequencies: readOptionalNumber(row, "imaginary_frequencies")! }
      : {}),
    ...(readOptionalBoolean(row, "normal_termination") !== undefined
      ? { normalTermination: readOptionalBoolean(row, "normal_termination")! }
      : {}),
    warnings: readJsonArray(row, "warnings_json"),
    errors: readJsonArray(row, "errors_json"),
    raw: readJsonObject(row, "raw_json") ?? {},
  };
}

export function mapProposalRow(row: Record<string, unknown>): {
  id: string;
  jobId: string;
  action: string;
  reason: string;
  proposedChanges: string;
  status: string;
  diagnosisJson: string | null;
  createdAt: number;
  updatedAt: number;
} {
  return {
    id: readString(row, "id"),
    jobId: readString(row, "job_id"),
    action: readString(row, "action"),
    reason: readString(row, "reason"),
    proposedChanges: readString(row, "proposed_changes"),
    status: readString(row, "status"),
    diagnosisJson: row.diagnosis_json != null ? String(row.diagnosis_json) : null,
    createdAt: readNumber(row, "created_at"),
    updatedAt: readNumber(row, "updated_at"),
  };
}

/**
 * Canonical JOB_ATTEMPT_STATUSES set — single source of truth.
 */
export const JOB_ATTEMPT_STATUSES = new Set<JobAttemptStatus>([
  "created",
  "queued",
  "staged",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const VALID_ATTEMPT_TRANSITIONS: Record<JobAttemptStatus, readonly JobAttemptStatus[]> = {
  created: ["queued", "failed"],
  queued: ["staged", "failed", "cancelled"],
  staged: ["running", "failed", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isJobAttemptStatus(value: string): value is JobAttemptStatus {
  return JOB_ATTEMPT_STATUSES.has(value as JobAttemptStatus);
}

export function isValidAttemptTransition(from: JobAttemptStatus, to: JobAttemptStatus): boolean {
  if (from === to) return true; // same-state is idempotent no-op
  return VALID_ATTEMPT_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Valid proposal status transitions — single source of truth.
 */
export const VALID_PROPOSAL_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ["approved", "rejected"],
  approved: ["executed"],
  rejected: [],
  executed: [],
};

export function isValidProposalTransition(current: string, next: string): boolean {
  const allowed = VALID_PROPOSAL_TRANSITIONS[current];
  return !!allowed && allowed.includes(next);
}

// ── Event row mapper ──────────────────────────────────────

export interface EventRow {
  /** DB primary key (from SERIAL / AUTOINCREMENT) */
  id: number;
  jobId: string;
  type: string;
  eventId: string | null;
  source: string;
  attemptId: string | null;
  artifactId: string | null;
  resultId: string | null;
  sequence: number | null;
  schemaVersion: number;
  payloadJson: string | null;
  createdAt: number;
  /** Raw snake_case fields preserved for backward compatibility */
  job_id: string;
  event_id: string | null;
  attempt_id: string | null;
  artifact_id: string | null;
  result_id: string | null;
  schema_version: number;
  payload_json: string | null;
  created_at: number;
  [key: string]: unknown;
}

/**
 * Map a raw DB row from job_events to a typed EventRow.
 * Preserves both camelCase (TypeScript convention) and snake_case
 * (raw DB column names) for backward compatibility with existing
 * consumers that access either style.
 */
export function mapEventRow(row: Record<string, unknown>): EventRow {
  const id = readNumber(row, "id");
  const jobId = readString(row, "job_id");
  const type = readString(row, "type");
  const eventId = readOptionalString(row, "event_id") ?? null;
  const source = readString(row, "source");
  const attemptId = readOptionalString(row, "attempt_id") ?? null;
  const artifactId = readOptionalString(row, "artifact_id") ?? null;
  const resultId = readOptionalString(row, "result_id") ?? null;
  const sequence: number | null = readOptionalNumber(row, "sequence") ?? null;
  const schemaVersion = readNumber(row, "schema_version");
  const payloadJson = readOptionalString(row, "payload_json") ?? null;
  const createdAt = readNumber(row, "created_at");

  return {
    // Spread all raw snake_case keys
    ...row,
    // Override with validated camelCase
    id,
    jobId,
    type,
    eventId,
    source,
    attemptId,
    artifactId,
    resultId,
    sequence,
    schemaVersion,
    payloadJson,
    createdAt,
    // Explicit snake_case pass-through (in case row didn't have them)
    job_id: jobId,
    event_id: eventId,
    attempt_id: attemptId,
    artifact_id: artifactId,
    result_id: resultId,
    schema_version: schemaVersion,
    payload_json: payloadJson,
    created_at: createdAt,
  } as EventRow;
}

// ── Stored result row mapper ─────────────────────────────

import type { StoredResultRecord } from "./client";

export function mapStoredResultRow(row: Record<string, unknown>): StoredResultRecord {
  return {
    id: readString(row, "id"),
    jobId: readString(row, "job_id"),
    attemptId: readString(row, "attempt_id"),
    parser: readString(row, "parser"),
    status: readString(row, "status") as StoredResultRecord["status"],
    energyHartree: readOptionalNumber(row, "energy_hartree") ?? null,
    scfConverged: readOptionalBoolean(row, "scf_converged") ?? null,
    imaginaryFrequencies: readOptionalNumber(row, "imaginary_frequencies") ?? null,
    normalTermination: readOptionalBoolean(row, "normal_termination") ?? null,
    warnings: readJsonArray(row, "warnings_json"),
    errors: readJsonArray(row, "errors_json"),
    raw: readJsonObject(row, "raw_json"),
    createdAt: readNumber(row, "created_at"),
  };
}

// ── Record mappers (provider-neutral typed records) ──────

import type {
  JobRecord,
  UserRecord,
  ProjectRecord,
  NodeRecord,
  MembershipRecord,
  QuotaRecord,
  UsageRecord,
  PermissionRecord,
} from "./client";

export function mapJobRow(row: Record<string, unknown>): JobRecord {
  return {
    id: readString(row, "id"),
    name: readString(row, "name"),
    software: readString(row, "software"),
    inputPath: readString(row, "input_path"),
    workdir: readString(row, "workdir"),
    outputPath: readOptionalString(row, "output_path") ?? null,
    nodeId: readOptionalString(row, "node_id") ?? null,
    status: readString(row, "status"),
    ownerUserId: readOptionalString(row, "owner_user_id") ?? null,
    projectId: readOptionalString(row, "project_id") ?? null,
    backend: readOptionalString(row, "backend") ?? null,
    externalJobId: readOptionalString(row, "external_job_id") ?? null,
    externalState: readOptionalString(row, "external_state") ?? null,
    lastSyncAt: readOptionalNumber(row, "last_sync_at") ?? null,
    nativeDetail: readOptionalString(row, "native_detail") ?? null,
    nodeName: readOptionalString(row, "node_name") ?? null,
    cpuThreads: readNumber(row, "cpu_threads"),
    memoryMb: readNumber(row, "memory_mb"),
    scratchMb: readNumber(row, "scratch_mb"),
    priority: readString(row, "priority"),
    jobFamily: readOptionalString(row, "job_family") ?? null,
    createdAt: readNumber(row, "created_at"),
    updatedAt: readNumber(row, "updated_at"),
  };
}

export function mapUserRow(row: Record<string, unknown>): UserRecord {
  return {
    id: readString(row, "id"),
    username: readString(row, "username"),
    displayName: readOptionalString(row, "display_name") ?? null,
    email: readOptionalString(row, "email") ?? null,
    status: readString(row, "status"),
    createdAt: readNumber(row, "created_at"),
    updatedAt: readNumber(row, "updated_at"),
  };
}

export function mapProjectRow(row: Record<string, unknown>): ProjectRecord {
  return {
    id: readString(row, "id"),
    name: readString(row, "name"),
    description: readOptionalString(row, "description") ?? null,
    status: readString(row, "status"),
    maxConcurrentJobs: readNumber(row, "max_concurrent_jobs"),
    createdAt: readNumber(row, "created_at"),
    updatedAt: readNumber(row, "updated_at"),
  };
}

export function mapNodeRow(row: Record<string, unknown>): NodeRecord {
  return {
    id: readString(row, "id"),
    name: readString(row, "name"),
    host: readString(row, "host"),
    user: readString(row, "user"),
    runner: readString(row, "runner"),
    status: readString(row, "status"),
    tagsJson: readString(row, "tags_json"),
    maxJobs: readNumber(row, "max_jobs"),
    engines: readString(row, "engines"),
    cpuThreadsTotal: readNumber(row, "cpu_threads_total"),
    memoryMbTotal: readNumber(row, "memory_mb_total"),
    scratchMbTotal: readNumber(row, "scratch_mb_total"),
    draining: readBoolean(row, "draining"),
    thermalState: readString(row, "thermal_state"),
    lastSeenAt: readOptionalNumber(row, "last_seen_at") ?? null,
    isHead: readBoolean(row, "is_head"),
    powerMode: readString(row, "power_mode"),
    macAddress: readOptionalString(row, "mac_address") ?? null,
    broadcastAddress: readOptionalString(row, "broadcast_address") ?? null,
    wolPort: readOptionalNumber(row, "wol_port") ?? null,
    allowWake: readBoolean(row, "allow_wake"),
    allowPowerDown: readBoolean(row, "allow_power_down"),
    idlePowerDownAfterSec: readOptionalNumber(row, "idle_power_down_after_sec") ?? null,
    lastWakeAt: readOptionalNumber(row, "last_wake_at") ?? null,
    lastPowerDownAt: readOptionalNumber(row, "last_power_down_at") ?? null,
    port: readNumber(row, "port"),
    privateKeyPath: readOptionalString(row, "private_key_path") ?? null,
    remoteScratchDir: readString(row, "remote_scratch_dir"),
    createdAt: readNumber(row, "created_at"),
    updatedAt: readNumber(row, "updated_at"),
  };
}

export function mapMembershipRow(row: Record<string, unknown>): MembershipRecord {
  return {
    id: readString(row, "id"),
    projectId: readString(row, "project_id"),
    userId: readString(row, "user_id"),
    role: readString(row, "role"),
    createdAt: readNumber(row, "created_at"),
    updatedAt: readNumber(row, "updated_at"),
  };
}

export function mapQuotaRow(row: Record<string, unknown>): QuotaRecord {
  return {
    id: readString(row, "id"),
    projectId: readString(row, "project_id"),
    maxCpuThreads: readNumber(row, "max_cpu_threads"),
    maxMemoryMb: readNumber(row, "max_memory_mb"),
    maxScratchMb: readNumber(row, "max_scratch_mb"),
    maxJobsTotal: readNumber(row, "max_jobs_total"),
    createdAt: readNumber(row, "created_at"),
    updatedAt: readNumber(row, "updated_at"),
  };
}

export function mapUsageRow(row: Record<string, unknown>): UsageRecord {
  return {
    id: readString(row, "id"),
    projectId: readString(row, "project_id"),
    userId: readString(row, "user_id"),
    jobId: readString(row, "job_id"),
    cpuThreads: readNumber(row, "cpu_threads"),
    memoryMb: readNumber(row, "memory_mb"),
    scratchMb: readNumber(row, "scratch_mb"),
    walltimeMs: readOptionalNumber(row, "walltime_ms") ?? null,
    recordedAt: readNumber(row, "recorded_at"),
  };
}

export function mapPermissionRow(row: Record<string, unknown>): PermissionRecord {
  return {
    id: readString(row, "id"),
    action: readString(row, "action"),
    resource: readString(row, "resource"),
    effect: readString(row, "effect") as PermissionEffect,
    projectId: readOptionalString(row, "project_id"),
    label: readOptionalString(row, "label"),
  };
}
