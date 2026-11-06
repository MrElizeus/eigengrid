import { type Artifact } from "@eigengrid/core";
import { mapArtifactRow as mapArtifactRowHelper } from "../rows";
import type { SqliteContext } from "./context";

import { emitBaseEvent } from "./events";

export async function createArtifact(
  context: SqliteContext,
  artifact: Omit<Artifact, "createdAt">,
): Promise<void> {
  const db = context.ensureDb();

  // Wrap state insert + event emission in a transaction for atomicity
  db.query("BEGIN IMMEDIATE").run();
  try {
    const now = context.nextTimestamp();
    db.query(
      "INSERT INTO artifacts (id, job_id, attempt_id, kind, path, label, mime_type, size_bytes, created_at) VALUES ($id, $jobId, $attemptId, $kind, $path, $label, $mimeType, $sizeBytes, $createdAt)",
    ).run({
      $id: artifact.id,
      $jobId: artifact.jobId,
      $attemptId: artifact.attemptId,
      $kind: artifact.kind,
      $path: artifact.path,
      $label: artifact.label ?? null,
      $mimeType: artifact.mimeType ?? null,
      $sizeBytes: artifact.sizeBytes ?? null,
      $createdAt: now,
    });

    // Emit event after registering artifact
    emitBaseEvent(context, {
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
    db.query("COMMIT").run();
  } catch (err) {
    db.query("ROLLBACK").run();
    throw err;
  }
}

export async function createArtifactIfAbsent(
  context: SqliteContext,
  artifact: Omit<Artifact, "createdAt">,
): Promise<boolean> {
  const db = context.ensureDb();
  db.query("BEGIN IMMEDIATE").run();
  try {
    const existing = db
      .query(
        `SELECT id FROM artifacts
           WHERE job_id = $jobId AND attempt_id = $attemptId AND kind = $kind AND path = $path
           LIMIT 1`,
      )
      .get({
        $jobId: artifact.jobId,
        $attemptId: artifact.attemptId,
        $kind: artifact.kind,
        $path: artifact.path,
      });
    if (existing) {
      db.query("COMMIT").run();
      return false;
    }

    const now = context.nextTimestamp();
    db.query(
      "INSERT INTO artifacts (id, job_id, attempt_id, kind, path, label, mime_type, size_bytes, created_at) VALUES ($id, $jobId, $attemptId, $kind, $path, $label, $mimeType, $sizeBytes, $createdAt)",
    ).run({
      $id: artifact.id,
      $jobId: artifact.jobId,
      $attemptId: artifact.attemptId,
      $kind: artifact.kind,
      $path: artifact.path,
      $label: artifact.label ?? null,
      $mimeType: artifact.mimeType ?? null,
      $sizeBytes: artifact.sizeBytes ?? null,
      $createdAt: now,
    });
    emitBaseEvent(context, {
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
    db.query("COMMIT").run();
    return true;
  } catch (err) {
    db.query("ROLLBACK").run();
    throw err;
  }
}

export async function listArtifacts(context: SqliteContext, jobId?: string): Promise<Artifact[]> {
  const db = context.ensureDb();
  const rows = jobId
    ? db
        .query("SELECT * FROM artifacts WHERE job_id = $jobId ORDER BY created_at ASC")
        .all({ $jobId: jobId })
    : db.query("SELECT * FROM artifacts ORDER BY created_at ASC").all();

  return rows.map((row: Record<string, unknown>) => mapArtifactRowHelper(row));
}
