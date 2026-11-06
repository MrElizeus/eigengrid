import { generateId } from "@eigengrid/core";
import type { SaveResultInput, StoredResultRecord } from "../client";
import { DbError, DbErrorCode } from "../errors";
import { resultEvidenceFingerprint } from "../queries/results";
import { mapStoredResultRow } from "../rows";
import type { PostgresContext } from "./context";
import { type PgRow } from "./row-helpers";

export async function saveResult(
  context: PostgresContext,
  input: SaveResultInput,
): Promise<string> {
  const now = Date.now();

  const ownedAttempt = await context.queryOne(
    "SELECT id FROM job_attempts WHERE id = $1 AND job_id = $2",
    [input.attemptId, input.jobId],
  );
  if (!ownedAttempt) {
    throw new DbError(
      `Result attempt ${input.attemptId} is not owned by job ${input.jobId}`,
      DbErrorCode.CONSTRAINT,
    );
  }

  const resultId = generateId("result");
  const { rows } = await context.query(
    `INSERT INTO results (id, job_id, attempt_id, parser, status, energy_hartree, scf_converged, imaginary_frequencies, normal_termination, warnings_json, errors_json, raw_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (job_id, attempt_id, parser) DO NOTHING
       RETURNING id`,
    [
      resultId,
      input.jobId,
      input.attemptId,
      input.parser,
      input.status,
      input.energyHartree != null ? String(input.energyHartree) : null,
      input.scfConverged != null ? (input.scfConverged ? 1 : 0) : null,
      input.imaginaryFrequencies ?? null,
      input.normalTermination != null ? (input.normalTermination ? 1 : 0) : null,
      JSON.stringify(input.warnings ?? []),
      JSON.stringify(input.errors ?? []),
      input.raw ? JSON.stringify(input.raw) : null,
      now,
    ],
  );

  const storedId = rows[0]?.id;
  if (storedId) return String(storedId);

  const existing = await context.queryOne(
    `SELECT * FROM results
       WHERE job_id = $1 AND attempt_id = $2 AND parser = $3
       LIMIT 1`,
    [input.jobId, input.attemptId, input.parser],
  );
  if (!existing) {
    throw new DbError(
      "Canonical result disappeared after uniqueness conflict",
      DbErrorCode.CONSTRAINT,
    );
  }
  const existingRecord = mapStoredResultRow(existing);
  if (resultEvidenceFingerprint(existingRecord) !== resultEvidenceFingerprint(input)) {
    throw new DbError(
      `Conflicting immutable result evidence for ${input.jobId}/${input.attemptId}/${input.parser}`,
      DbErrorCode.CONSTRAINT,
    );
  }
  return existingRecord.id;
}

export async function listResults(
  context: PostgresContext,
  jobId?: string,
  attemptId?: string,
): Promise<StoredResultRecord[]> {
  let sql: string;
  let params: unknown[];
  if (attemptId && !jobId) {
    throw new DbError("Result attempt filtering requires a job ID", DbErrorCode.CONSTRAINT);
  }
  if (jobId && attemptId) {
    sql = "SELECT * FROM results WHERE job_id = $1 AND attempt_id = $2 ORDER BY created_at ASC";
    params = [jobId, attemptId];
  } else if (jobId) {
    sql =
      "SELECT * FROM results WHERE job_id = $1 AND attempt_id IS NOT NULL ORDER BY created_at ASC";
    params = [jobId];
  } else {
    sql = "SELECT * FROM results WHERE attempt_id IS NOT NULL ORDER BY created_at ASC";
    params = [];
  }
  const { rows } = await context.query(sql, params);
  return rows.map((r: PgRow) => mapStoredResultRow(r as Record<string, unknown>));
}

export async function getLatestResult(
  context: PostgresContext,
  jobId: string,
  attemptId: string,
): Promise<StoredResultRecord | null> {
  const sql = `SELECT * FROM results
       WHERE job_id = $1 AND attempt_id = $2
       ORDER BY created_at DESC, id DESC LIMIT 1`;
  const row = await context.queryOne(sql, [jobId, attemptId]);
  return row ? mapStoredResultRow(row as Record<string, unknown>) : null;
}
