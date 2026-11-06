import {
  VALID_TRANSITIONS,
  type Artifact,
  type JobAttempt,
  type JobAttemptStatus,
  type JobStatus,
  type RunnerKind,
} from "@eigengrid/core";
import type { ProposalRow, ProposalStatus } from "../client";
export interface PgRow {
  [key: string]: unknown;
}

export const JOB_ATTEMPT_STATUSES = new Set<JobAttemptStatus>([
  "created",
  "queued",
  "staged",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export function isJobAttemptStatus(value: string): value is JobAttemptStatus {
  return JOB_ATTEMPT_STATUSES.has(value as JobAttemptStatus);
}

export function isJobStatus(value: string): value is JobStatus {
  return value in VALID_TRANSITIONS;
}

export const VALID_PROPOSAL_TRANSITIONS: Record<ProposalStatus, readonly ProposalStatus[]> = {
  pending: ["approved", "rejected"],
  approved: ["executed"],
  rejected: [],
  executed: [],
};

export function mapJobAttemptRow(row: PgRow): JobAttempt {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    runner: String(row.runner) as RunnerKind,
    status: String(row.status) as JobAttemptStatus,
    command: String(row.command),
    cwd: String(row.cwd),
    ...(row.pid != null ? { pid: Number(row.pid) } : {}),
    ...(row.exit_code != null ? { exitCode: Number(row.exit_code) } : {}),
    ...(row.started_at != null ? { startedAt: Number(row.started_at) } : {}),
    ...(row.finished_at != null ? { finishedAt: Number(row.finished_at) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function mapArtifactRow(row: PgRow): Artifact {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    attemptId: String(row.attempt_id),
    kind: String(row.kind) as Artifact["kind"],
    path: String(row.path),
    ...(typeof row.label === "string" ? { label: row.label } : {}),
    ...(typeof row.mime_type === "string" ? { mimeType: row.mime_type } : {}),
    ...(row.size_bytes != null ? { sizeBytes: Number(row.size_bytes) } : {}),
    createdAt: Number(row.created_at),
  };
}

export function mapProposalRow(row: PgRow): ProposalRow {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    action: String(row.action),
    reason: String(row.reason),
    proposedChanges: String(row.proposed_changes),
    status: String(row.status) as ProposalStatus,
    diagnosisJson: row.diagnosis_json != null ? String(row.diagnosis_json) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function tryParseJson(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}
