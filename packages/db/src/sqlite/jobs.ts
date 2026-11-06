import { VALID_TRANSITIONS, canTransitionJobStatus, type JobStatus } from "@eigengrid/core";
import type { JobRecord } from "../client";
import {
  DbAmbiguousPrefixError,
  DbError,
  DbErrorCode,
  DbInvalidTransitionError,
  DbNotFoundError,
} from "../errors";
import { mapJobRow } from "../rows";
import type { SqliteContext } from "./context";
import { isJobStatus } from "./row-helpers";

import { emitBaseEvent } from "./events";

export async function createJob(
  context: SqliteContext,
  job: {
    id: string;
    name: string;
    software: string;
    inputPath: string;
    workdir: string;
    outputPath?: string;
    ownerUserId?: string;
    projectId?: string;
    backend?: string;
  },
): Promise<void> {
  const db = context.ensureDb();
  const now = context.nextTimestamp();
  db.query(
    "INSERT INTO jobs (id, name, software, input_path, workdir, output_path, owner_user_id, project_id, backend, status, created_at, updated_at) VALUES ($id, $name, $software, $inputPath, $workdir, $outputPath, $ownerUserId, $projectId, $backend, $status, $createdAt, $updatedAt)",
  ).run({
    $id: job.id,
    $name: job.name,
    $software: job.software,
    $inputPath: job.inputPath,
    $workdir: job.workdir,
    $outputPath: job.outputPath ?? null,
    $ownerUserId: job.ownerUserId ?? null,
    $projectId: job.projectId ?? null,
    $backend: job.backend ?? null,
    $status: "created",
    $createdAt: now,
    $updatedAt: now,
  });
}

export async function updateJobStatus(
  context: SqliteContext,
  jobId: string,
  status: string,
): Promise<void> {
  const db = context.ensureDb();
  db.query("BEGIN IMMEDIATE").run();
  try {
    const current = db.query("SELECT status FROM jobs WHERE id = $jobId").get({ $jobId: jobId });
    if (!current) throw new DbNotFoundError("Job", jobId);

    const currentStatus = String(current.status ?? "");

    // Same-state no-op: no updated_at rewrite, no status event
    if (currentStatus === status) {
      db.query("COMMIT").run();
      return;
    }

    if (
      !isJobStatus(currentStatus) ||
      !isJobStatus(status) ||
      !canTransitionJobStatus(currentStatus, status)
    ) {
      const allowed = VALID_TRANSITIONS[currentStatus as JobStatus] ?? [];
      throw new DbInvalidTransitionError("job", currentStatus, status, [...allowed]);
    }

    const transitioned = db
      .query(
        `UPDATE jobs SET status = $status, updated_at = $updatedAt
           WHERE id = $jobId AND status = $currentStatus`,
      )
      .run({
        $status: status,
        $updatedAt: context.nextTimestamp(),
        $jobId: jobId,
        $currentStatus: currentStatus,
      }) as { changes: number };
    if (transitioned.changes !== 1) {
      throw new DbError(`Concurrent job transition for ${jobId}`, DbErrorCode.CONSTRAINT);
    }

    // Emit event after successful transition
    emitBaseEvent(context, {
      type: "job.status.changed",
      jobId,
      payload: { from: currentStatus, to: status },
    });
    db.query("COMMIT").run();
  } catch (err) {
    db.query("ROLLBACK").run();
    throw err;
  }
}

export async function updateJobExternalMetadata(
  context: SqliteContext,
  jobId: string,
  metadata: {
    backend?: string;
    externalJobId?: string;
    externalState?: string;
    lastSyncAt?: number;
    nativeDetail?: string;
    nodeName?: string;
  },
): Promise<void> {
  const db = context.ensureDb();
  const sets: string[] = [];
  const params: Record<string, unknown> = { $id: jobId };

  if (metadata.backend !== undefined) {
    sets.push("backend = $backend");
    params.$backend = metadata.backend;
  }
  if (metadata.externalJobId !== undefined) {
    sets.push("external_job_id = $externalJobId");
    params.$externalJobId = metadata.externalJobId;
  }
  if (metadata.externalState !== undefined) {
    sets.push("external_state = $externalState");
    params.$externalState = metadata.externalState;
  }
  if (metadata.lastSyncAt !== undefined) {
    sets.push("last_sync_at = $lastSyncAt");
    params.$lastSyncAt = metadata.lastSyncAt;
  }
  if (metadata.nativeDetail !== undefined) {
    sets.push("native_detail = $nativeDetail");
    params.$nativeDetail = metadata.nativeDetail;
  }
  if (metadata.nodeName !== undefined) {
    sets.push("node_name = $nodeName");
    params.$nodeName = metadata.nodeName;
  }

  if (sets.length === 0) return;
  sets.push("updated_at = $updatedAt");
  params.$updatedAt = Date.now();

  db.query(`UPDATE jobs SET ${sets.join(", ")} WHERE id = $id`).run(params);
}

export async function getJob(context: SqliteContext, jobId: string): Promise<JobRecord | null> {
  const db = context.ensureDb();
  const row = db.query("SELECT * FROM jobs WHERE id = $jobId").get({ $jobId: jobId });
  if (!row) return null;
  return mapJobRow(row as Record<string, unknown>);
}

export async function resolveJobId(context: SqliteContext, prefix: string): Promise<string> {
  const db = context.ensureDb();
  const rows = db.query("SELECT id FROM jobs WHERE id LIKE $prefix").all({ $prefix: `${prefix}%` });
  if (rows.length === 0) throw new DbNotFoundError("Job", prefix);
  if (rows.length > 1) throw new DbAmbiguousPrefixError("job", prefix, rows.length);
  return String(rows[0].id);
}

export async function listJobs(context: SqliteContext): Promise<JobRecord[]> {
  const db = context.ensureDb();
  return db
    .query("SELECT * FROM jobs ORDER BY created_at DESC")
    .all()
    .map((r: Record<string, unknown>) => mapJobRow(r));
}
