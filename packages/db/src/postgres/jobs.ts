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
import type { PostgresContext } from "./context";
import { isJobStatus, type PgRow } from "./row-helpers";

import { emitClientEvent } from "./events";

export async function createJob(
  context: PostgresContext,
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
  const now = context.nextTimestamp();
  await context.query(
    `INSERT INTO jobs (id, name, software, input_path, workdir, output_path, owner_user_id, project_id, backend, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      job.id,
      job.name,
      job.software,
      job.inputPath,
      job.workdir,
      job.outputPath ?? null,
      job.ownerUserId ?? null,
      job.projectId ?? null,
      job.backend ?? null,
      "created",
      now,
      now,
    ],
  );
}

export async function updateJobStatus(
  context: PostgresContext,
  jobId: string,
  status: string,
): Promise<void> {
  if (!context.pool) throw new DbError("Database not initialized", DbErrorCode.NOT_INITIALIZED);
  const client = await context.pool.connect();
  try {
    await client.query("BEGIN");

    const current = (
      await client.query("SELECT status FROM jobs WHERE id = $1 FOR UPDATE", [jobId])
    ).rows[0] as { status: string } | undefined;
    if (!current) throw new DbNotFoundError("Job", jobId);

    const currentStatus = String(current.status ?? "");

    // Same-state no-op: no updated_at rewrite, no status event
    if (currentStatus === status) {
      await client.query("COMMIT");
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

    const transitioned = await client.query(
      "UPDATE jobs SET status = $1, updated_at = $2 WHERE id = $3 AND status = $4 RETURNING id",
      [status, context.nextTimestamp(), jobId, currentStatus],
    );
    if (transitioned.rowCount !== 1) {
      throw new DbError(`Concurrent job transition for ${jobId}`, DbErrorCode.CONSTRAINT);
    }

    await emitClientEvent(context, client, {
      type: "job.status.changed",
      jobId,
      payload: { from: currentStatus, to: status },
    });

    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* best-effort */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function updateJobExternalMetadata(
  context: PostgresContext,
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
  const current = await getJob(context, jobId);
  if (!current) {
    throw new DbNotFoundError("Job", jobId);
  }

  const setFields: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (metadata.backend !== undefined) {
    setFields.push(`backend = $${paramIdx++}`);
    params.push(metadata.backend);
  }
  if (metadata.externalJobId !== undefined) {
    setFields.push(`external_job_id = $${paramIdx++}`);
    params.push(metadata.externalJobId);
  }
  if (metadata.externalState !== undefined) {
    setFields.push(`external_state = $${paramIdx++}`);
    params.push(metadata.externalState);
  }
  if (metadata.lastSyncAt !== undefined) {
    setFields.push(`last_sync_at = $${paramIdx++}`);
    params.push(metadata.lastSyncAt);
  }
  if (metadata.nativeDetail !== undefined) {
    setFields.push(`native_detail = $${paramIdx++}`);
    params.push(metadata.nativeDetail);
  }
  if (metadata.nodeName !== undefined) {
    setFields.push(`node_name = $${paramIdx++}`);
    params.push(metadata.nodeName);
  }

  if (setFields.length === 0) {
    return;
  }

  setFields.push(`updated_at = $${paramIdx++}`);
  params.push(Date.now(), jobId);

  await context.query(`UPDATE jobs SET ${setFields.join(", ")} WHERE id = $${paramIdx}`, params);
}

export async function getJob(context: PostgresContext, jobId: string): Promise<JobRecord | null> {
  const row = await context.queryOne("SELECT * FROM jobs WHERE id = $1", [jobId]);
  return row ? mapJobRow(row as Record<string, unknown>) : null;
}

export async function resolveJobId(context: PostgresContext, prefix: string): Promise<string> {
  const { rows } = await context.query("SELECT id FROM jobs WHERE id LIKE $1", [`${prefix}%`]);
  if (rows.length === 0) {
    throw new DbNotFoundError("Job", prefix);
  }
  if (rows.length > 1) {
    throw new DbAmbiguousPrefixError("job", prefix, rows.length);
  }
  return String(rows[0].id);
}

export async function listJobs(context: PostgresContext): Promise<JobRecord[]> {
  const { rows } = await context.query("SELECT * FROM jobs ORDER BY created_at DESC");
  return rows.map((r: PgRow) => mapJobRow(r as Record<string, unknown>));
}
