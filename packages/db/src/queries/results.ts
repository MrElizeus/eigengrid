import { generateId } from "@eigengrid/core";
import type { DatabaseLike, StoredResultRecord } from "../client";
import { mapStoredResultRow } from "../rows";

interface SqliteConn {
  query(sql: string): {
    run(params?: Record<string, unknown>): unknown;
    get(params?: Record<string, unknown>): Record<string, unknown> | undefined;
    all(params?: Record<string, unknown>): Record<string, unknown>[];
  };
}

export interface SaveResultInput {
  jobId: string;
  attemptId: string;
  parser: string;
  status: "completed" | "failed" | "partial" | "unknown";
  energyHartree?: number;
  scfConverged?: boolean;
  imaginaryFrequencies?: number;
  normalTermination?: boolean;
  warnings?: string[];
  errors?: string[];
  raw?: Record<string, unknown>;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

/** Immutable scientific evidence for one deterministic parser label. */
export function resultEvidenceFingerprint(result: {
  status: SaveResultInput["status"];
  energyHartree?: number | null;
  scfConverged?: boolean | null;
  imaginaryFrequencies?: number | null;
  normalTermination?: boolean | null;
  warnings?: string[] | null;
  errors?: string[] | null;
  raw?: Record<string, unknown> | null;
}): string {
  return JSON.stringify(
    canonicalize({
      status: result.status,
      energyHartree: result.energyHartree ?? null,
      scfConverged: result.scfConverged ?? null,
      imaginaryFrequencies: result.imaginaryFrequencies ?? null,
      normalTermination: result.normalTermination ?? null,
      warnings: result.warnings ?? [],
      errors: result.errors ?? [],
      raw: result.raw ?? null,
    }),
  );
}

/**
 * Save a parse result for a job.
 * Returns the result ID.
 * Canonical identity: exactly one result per (jobId, attemptId, parser).
 * Exact replays return the same ID without rewriting evidence. Divergent
 * replays under the same deterministic parser label are rejected.
 */
export async function saveResult(db: DatabaseLike, input: SaveResultInput): Promise<string> {
  if (db._provider === "sqlite") {
    const sqlite = db as unknown as { ensureDb(): SqliteConn };
    const dbConn = sqlite.ensureDb();

    const ownedAttempt = dbConn
      .query("SELECT id FROM job_attempts WHERE id = $attemptId AND job_id = $jobId")
      .get({ $attemptId: input.attemptId, $jobId: input.jobId });
    if (!ownedAttempt) {
      throw new Error(`Result attempt ${input.attemptId} is not owned by job ${input.jobId}`);
    }

    const now = Date.now();
    const resultId = generateId("result");
    const stored = dbConn
      .query(
        `INSERT INTO results (id, job_id, attempt_id, parser, status, energy_hartree, scf_converged, imaginary_frequencies, normal_termination, warnings_json, errors_json, raw_json, created_at)
         VALUES ($id, $jobId, $attemptId, $parser, $status, $energyHartree, $scfConverged, $imaginaryFrequencies, $normalTermination, $warningsJson, $errorsJson, $rawJson, $createdAt)
         ON CONFLICT(job_id, attempt_id, parser) DO NOTHING
         RETURNING id`,
      )
      .get({
        $id: resultId,
        $jobId: input.jobId,
        $attemptId: input.attemptId,
        $parser: input.parser,
        $status: input.status,
        $energyHartree: input.energyHartree != null ? String(input.energyHartree) : null,
        $scfConverged: input.scfConverged != null ? (input.scfConverged ? 1 : 0) : null,
        $imaginaryFrequencies: input.imaginaryFrequencies ?? null,
        $normalTermination:
          input.normalTermination != null ? (input.normalTermination ? 1 : 0) : null,
        $warningsJson: JSON.stringify(input.warnings ?? []),
        $errorsJson: JSON.stringify(input.errors ?? []),
        $rawJson: input.raw ? JSON.stringify(input.raw) : null,
        $createdAt: now,
      }) as { id: string } | undefined;

    if (stored?.id) return stored.id;

    const existing = dbConn
      .query(
        `SELECT * FROM results
         WHERE job_id = $jobId AND attempt_id = $attemptId AND parser = $parser
         LIMIT 1`,
      )
      .get({
        $jobId: input.jobId,
        $attemptId: input.attemptId,
        $parser: input.parser,
      }) as Record<string, unknown> | undefined;
    if (!existing) throw new Error("Canonical result disappeared after uniqueness conflict");
    const existingRecord = mapStoredResultRow(existing);
    if (resultEvidenceFingerprint(existingRecord) !== resultEvidenceFingerprint(input)) {
      throw new Error(
        `Conflicting immutable result evidence for ${input.jobId}/${input.attemptId}/${input.parser}`,
      );
    }
    return existingRecord.id;
  }

  // PostgreSQL path: delegate to DatabaseLike.saveResult
  return db.saveResult(input);
}

/**
 * List results, optionally filtered by job ID.
 */
export async function listResults(
  db: DatabaseLike,
  jobId?: string,
  attemptId?: string,
): Promise<StoredResultRecord[]> {
  if (db._provider === "sqlite") {
    const sqlite = db as unknown as { ensureDb(): SqliteConn };
    const dbConn = sqlite.ensureDb();
    if (attemptId && !jobId) {
      throw new Error("Result attempt filtering requires a job ID");
    }
    const rows: Record<string, unknown>[] =
      jobId && attemptId
        ? dbConn
            .query(
              `SELECT * FROM results
             WHERE job_id = $jobId AND attempt_id = $attemptId
             ORDER BY created_at ASC`,
            )
            .all({ $jobId: jobId, $attemptId: attemptId })
        : jobId
          ? dbConn
              .query(
                `SELECT * FROM results
             WHERE job_id = $jobId AND attempt_id IS NOT NULL
             ORDER BY created_at ASC`,
              )
              .all({ $jobId: jobId })
          : dbConn
              .query("SELECT * FROM results WHERE attempt_id IS NOT NULL ORDER BY created_at ASC")
              .all();

    return rows.map(mapStoredResultRow);
  }

  return db.listResults(jobId, attemptId);
}

/**
 * Get the most recent result for a job.
 */
export async function getLatestResult(
  db: DatabaseLike,
  jobId: string,
  attemptId: string,
): Promise<StoredResultRecord | null> {
  if (db._provider === "sqlite") {
    const sqlite = db as unknown as { ensureDb(): SqliteConn };
    const dbConn = sqlite.ensureDb();
    const row = dbConn
      .query(
        `SELECT * FROM results
         WHERE job_id = $jobId AND attempt_id = $attemptId
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get({ $jobId: jobId, $attemptId: attemptId }) as Record<string, unknown> | undefined;

    return row ? mapStoredResultRow(row) : null;
  }

  return db.getLatestResult(jobId, attemptId);
}
