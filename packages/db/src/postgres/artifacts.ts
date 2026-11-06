import { type Artifact } from "@eigengrid/core";
import { DbError, DbErrorCode, DbNotFoundError } from "../errors";
import type { PostgresContext } from "./context";
import { mapArtifactRow } from "./row-helpers";

import { emitClientEvent } from "./events";

export async function createArtifact(
  context: PostgresContext,
  artifact: Omit<Artifact, "createdAt">,
): Promise<void> {
  if (!context.pool) throw new DbError("Database not initialized", DbErrorCode.NOT_INITIALIZED);
  const client = await context.pool.connect();
  try {
    await client.query("BEGIN");

    const now = context.nextTimestamp();
    await client.query(
      `INSERT INTO artifacts (id, job_id, attempt_id, kind, path, label, mime_type, size_bytes, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        artifact.id,
        artifact.jobId,
        artifact.attemptId,
        artifact.kind,
        artifact.path,
        artifact.label ?? null,
        artifact.mimeType ?? null,
        artifact.sizeBytes ?? null,
        now,
      ],
    );

    await emitClientEvent(context, client, {
      type: "artifact.registered",
      jobId: artifact.jobId,
      attemptId: artifact.attemptId,
      artifactId: artifact.id,
      payload: {
        kind: artifact.kind,
        path: artifact.path,
        label: artifact.label ?? null,
        mimeType: artifact.mimeType ?? null,
        sizeBytes: artifact.sizeBytes ?? null,
      },
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

export async function createArtifactIfAbsent(
  context: PostgresContext,
  artifact: Omit<Artifact, "createdAt">,
): Promise<boolean> {
  if (!context.pool) throw new DbError("Database not initialized", DbErrorCode.NOT_INITIALIZED);
  const client = await context.pool.connect();
  try {
    await client.query("BEGIN");

    // Keep the state-writer lock order: owned rows first, job event lock
    // second. This also rejects a mismatched attempt/job pair explicitly.
    const owner = (
      await client.query(
        `SELECT a.id
           FROM job_attempts a
           JOIN jobs j ON j.id = a.job_id
           WHERE a.id = $1 AND a.job_id = $2
           FOR UPDATE OF a, j`,
        [artifact.attemptId, artifact.jobId],
      )
    ).rows[0];
    if (!owner) throw new DbNotFoundError("JobAttempt", artifact.attemptId);

    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [artifact.jobId]);

    const existing = (
      await client.query(
        `SELECT id FROM artifacts
           WHERE job_id = $1 AND attempt_id = $2 AND kind = $3 AND path = $4
           LIMIT 1`,
        [artifact.jobId, artifact.attemptId, artifact.kind, artifact.path],
      )
    ).rows[0];
    if (existing) {
      await client.query("COMMIT");
      return false;
    }

    const now = context.nextTimestamp();
    await client.query(
      `INSERT INTO artifacts (id, job_id, attempt_id, kind, path, label, mime_type, size_bytes, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        artifact.id,
        artifact.jobId,
        artifact.attemptId,
        artifact.kind,
        artifact.path,
        artifact.label ?? null,
        artifact.mimeType ?? null,
        artifact.sizeBytes ?? null,
        now,
      ],
    );
    await emitClientEvent(context, client, {
      type: "artifact.registered",
      jobId: artifact.jobId,
      attemptId: artifact.attemptId,
      artifactId: artifact.id,
      payload: {
        kind: artifact.kind,
        path: artifact.path,
        label: artifact.label ?? null,
        mimeType: artifact.mimeType ?? null,
        sizeBytes: artifact.sizeBytes ?? null,
      },
    });
    await client.query("COMMIT");
    return true;
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

export async function listArtifacts(context: PostgresContext, jobId?: string): Promise<Artifact[]> {
  let sql: string;
  let params: unknown[] = [];
  if (jobId) {
    sql = "SELECT * FROM artifacts WHERE job_id = $1 ORDER BY created_at ASC";
    params = [jobId];
  } else {
    sql = "SELECT * FROM artifacts ORDER BY created_at ASC";
  }
  const { rows } = await context.query(sql, params);
  return rows.map(mapArtifactRow);
}
