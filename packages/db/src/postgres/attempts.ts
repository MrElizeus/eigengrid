import {
  VALID_TRANSITIONS,
  canTransitionJobStatus,
  type JobAttempt,
  type JobAttemptStatus,
  type JobStatus,
  type RunnerKind,
} from "@eigengrid/core";
import type { TerminalAttemptEvidence } from "../client";
import { DbError, DbErrorCode, DbInvalidTransitionError, DbNotFoundError } from "../errors";
import { VALID_ATTEMPT_TRANSITIONS, isValidAttemptTransition } from "../rows";
import type { PostgresContext } from "./context";
import {
  JOB_ATTEMPT_STATUSES,
  isJobAttemptStatus,
  isJobStatus,
  mapJobAttemptRow,
} from "./row-helpers";

import { emitClientEvent } from "./events";

export async function createJobAttempt(
  context: PostgresContext,
  attempt: {
    id: string;
    jobId: string;
    runner: RunnerKind;
    command: string;
    cwd: string;
    status?: JobAttemptStatus;
    pid?: number;
    exitCode?: number;
    startedAt?: number;
    finishedAt?: number;
  },
): Promise<void> {
  const status = attempt.status ?? "created";
  if (!isJobAttemptStatus(status)) {
    throw new DbInvalidTransitionError("job_attempt", "", status, [...JOB_ATTEMPT_STATUSES]);
  }

  // Wrap state insert + event emission in a transaction for atomicity
  if (!context.pool) throw new DbError("Database not initialized", DbErrorCode.NOT_INITIALIZED);
  const client = await context.pool.connect();
  try {
    await client.query("BEGIN");

    const now = context.nextTimestamp();
    await client.query(
      `INSERT INTO job_attempts (id, job_id, runner, status, command, cwd, pid, exit_code, started_at, finished_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        attempt.id,
        attempt.jobId,
        attempt.runner,
        status,
        attempt.command,
        attempt.cwd,
        attempt.pid ?? null,
        attempt.exitCode ?? null,
        attempt.startedAt ?? null,
        attempt.finishedAt ?? null,
        now,
        now,
      ],
    );

    await emitClientEvent(context, client, {
      type: "attempt.created",
      jobId: attempt.jobId,
      attemptId: attempt.id,
      payload: { runner: attempt.runner, command: attempt.command, cwd: attempt.cwd },
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

export async function updateJobAttemptStatus(
  context: PostgresContext,
  attemptId: string,
  status: JobAttemptStatus,
  updates?: {
    pid?: number;
    startedAt?: number;
    exitCode?: number;
    finishedAt?: number;
  },
): Promise<void> {
  if (!isJobAttemptStatus(status)) {
    throw new DbInvalidTransitionError("job_attempt", "", status, [...JOB_ATTEMPT_STATUSES]);
  }

  if (!context.pool) throw new DbError("Database not initialized", DbErrorCode.NOT_INITIALIZED);
  const client = await context.pool.connect();
  try {
    await client.query("BEGIN");

    const current = (
      await client.query("SELECT * FROM job_attempts WHERE id = $1 FOR UPDATE", [attemptId])
    ).rows[0] as Record<string, unknown> | undefined;
    if (!current) throw new DbNotFoundError("JobAttempt", attemptId);

    const previousStatus = String(current.status) as JobAttemptStatus;

    // Same-state no-op: no updated_at rewrite, no status event
    if (previousStatus === status) {
      await client.query("COMMIT");
      return;
    }

    if (!isValidAttemptTransition(previousStatus, status)) {
      const allowed = [...(VALID_ATTEMPT_TRANSITIONS[previousStatus] ?? [])];
      throw new DbInvalidTransitionError(
        "job_attempt",
        previousStatus,
        status,
        allowed.map(String),
      );
    }

    const now = context.nextTimestamp();
    const setFields = ["status = $1", "updated_at = $2"];
    const params: unknown[] = [status, now];
    let paramIdx = 3;

    if (updates?.pid !== undefined) {
      setFields.push(`pid = $${paramIdx++}`);
      params.push(updates.pid);
    }
    if (updates?.startedAt !== undefined) {
      setFields.push(`started_at = $${paramIdx++}`);
      params.push(updates.startedAt);
    }
    if (updates?.exitCode !== undefined) {
      setFields.push(`exit_code = $${paramIdx++}`);
      params.push(updates.exitCode);
    }
    if (updates?.finishedAt !== undefined) {
      setFields.push(`finished_at = $${paramIdx++}`);
      params.push(updates.finishedAt);
    }

    params.push(attemptId, previousStatus);
    const transitioned = await client.query(
      `UPDATE job_attempts SET ${setFields.join(", ")}
         WHERE id = $${paramIdx} AND status = $${paramIdx + 1}
         RETURNING id`,
      params,
    );
    if (transitioned.rowCount !== 1) {
      throw new DbError(
        `Concurrent job attempt transition for ${attemptId}`,
        DbErrorCode.CONSTRAINT,
      );
    }

    // Use same client to append event inside the transaction
    await emitClientEvent(context, client, {
      type: "attempt.status.changed",
      jobId: String(current.job_id),
      attemptId,
      payload: {
        from: previousStatus,
        to: status,
        ...(updates?.pid !== undefined ? { pid: updates.pid } : {}),
        ...(updates?.exitCode !== undefined ? { exitCode: updates.exitCode } : {}),
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

export async function listJobAttempts(
  context: PostgresContext,
  jobId?: string,
): Promise<JobAttempt[]> {
  let sql: string;
  let params: unknown[] = [];
  if (jobId) {
    sql = "SELECT * FROM job_attempts WHERE job_id = $1 ORDER BY created_at ASC";
    params = [jobId];
  } else {
    sql = "SELECT * FROM job_attempts ORDER BY created_at ASC";
  }
  const { rows } = await context.query(sql, params);
  return rows.map(mapJobAttemptRow);
}

export async function materializeTerminalAttempt(
  context: PostgresContext,
  evidence: TerminalAttemptEvidence,
): Promise<void> {
  if (!context.pool) throw new DbError("Database not initialized", DbErrorCode.NOT_INITIALIZED);
  const client = await context.pool.connect();
  try {
    await client.query("BEGIN");
    const current = (
      await client.query(
        `SELECT a.status AS attempt_status, a.exit_code, a.finished_at,
                  j.status AS job_status
           FROM job_attempts a
           JOIN jobs j ON j.id = a.job_id
           WHERE a.id = $1 AND a.job_id = $2
           FOR UPDATE OF a, j`,
        [evidence.attemptId, evidence.jobId],
      )
    ).rows[0] as Record<string, unknown> | undefined;
    if (!current) throw new DbNotFoundError("JobAttempt", evidence.attemptId);

    // Keep lock ordering consistent with the other state writers: row lock
    // first, event advisory lock second. The advisory lock must precede the
    // evidence query so concurrent appendEvent calls are visible here.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [evidence.jobId]);

    const terminalType =
      evidence.status === "completed"
        ? "process.completed"
        : evidence.status === "cancelled"
          ? "process.cancelled"
          : "process.failed";
    const terminalEvents = (
      await client.query(
        `SELECT type, payload_json FROM job_events
           WHERE job_id = $1 AND attempt_id = $2
             AND type IN ('process.completed', 'process.failed', 'process.cancelled')`,
        [evidence.jobId, evidence.attemptId],
      )
    ).rows as Array<{ type: string; payload_json: string | null }>;
    if (terminalEvents.some((event) => event.type !== terminalType)) {
      throw new DbError(
        `Conflicting terminal evidence for attempt ${evidence.attemptId}`,
        DbErrorCode.CONSTRAINT,
      );
    }
    for (const event of terminalEvents) {
      if (event.payload_json == null || evidence.exitCode === undefined) continue;
      let payload: Record<string, unknown> | null = null;
      try {
        payload = JSON.parse(event.payload_json) as Record<string, unknown>;
      } catch {
        throw new DbError(
          `Malformed terminal evidence for attempt ${evidence.attemptId}`,
          DbErrorCode.CONSTRAINT,
        );
      }
      if (payload.exitCode != null && Number(payload.exitCode) !== evidence.exitCode) {
        throw new DbError(
          `Conflicting terminal metadata for attempt ${evidence.attemptId}`,
          DbErrorCode.CONSTRAINT,
        );
      }
    }

    const previousAttemptStatus = String(current.attempt_status) as JobAttemptStatus;
    if (previousAttemptStatus === evidence.status) {
      const storedExitCode = current.exit_code == null ? undefined : Number(current.exit_code);
      const storedFinishedAt =
        current.finished_at == null ? undefined : Number(current.finished_at);
      if (storedExitCode !== evidence.exitCode || storedFinishedAt !== evidence.finishedAt) {
        throw new DbError(
          `Conflicting terminal metadata for attempt ${evidence.attemptId}`,
          DbErrorCode.CONSTRAINT,
        );
      }
    }
    if (
      previousAttemptStatus !== evidence.status &&
      !isValidAttemptTransition(previousAttemptStatus, evidence.status)
    ) {
      throw new DbInvalidTransitionError(
        "job_attempt",
        previousAttemptStatus,
        evidence.status,
        [...(VALID_ATTEMPT_TRANSITIONS[previousAttemptStatus] ?? [])].map(String),
      );
    }

    const attemptStatusChanged = previousAttemptStatus !== evidence.status;
    if (attemptStatusChanged) {
      await client.query(
        `UPDATE job_attempts
           SET status = $1, exit_code = COALESCE($2, exit_code), finished_at = $3, updated_at = $4
           WHERE id = $5 AND job_id = $6`,
        [
          evidence.status,
          evidence.exitCode ?? null,
          evidence.finishedAt,
          context.nextTimestamp(),
          evidence.attemptId,
          evidence.jobId,
        ],
      );
    }
    if (attemptStatusChanged) {
      await emitClientEvent(context, client, {
        type: "attempt.status.changed",
        jobId: evidence.jobId,
        attemptId: evidence.attemptId,
        payload: {
          from: previousAttemptStatus,
          to: evidence.status,
          ...(evidence.exitCode !== undefined ? { exitCode: evidence.exitCode } : {}),
        },
      });
    }

    const previousJobStatus = String(current.job_status);
    if (previousJobStatus !== evidence.status) {
      if (
        !isJobStatus(previousJobStatus) ||
        !canTransitionJobStatus(previousJobStatus, evidence.status)
      ) {
        const allowed = VALID_TRANSITIONS[previousJobStatus as JobStatus] ?? [];
        throw new DbInvalidTransitionError("job", previousJobStatus, evidence.status, [...allowed]);
      }
      await client.query("UPDATE jobs SET status = $1, updated_at = $2 WHERE id = $3", [
        evidence.status,
        context.nextTimestamp(),
        evidence.jobId,
      ]);
      await emitClientEvent(context, client, {
        type: "job.status.changed",
        jobId: evidence.jobId,
        payload: { from: previousJobStatus, to: evidence.status },
      });
    }

    if (terminalEvents.length === 0) {
      await emitClientEvent(context, client, {
        type: terminalType,
        jobId: evidence.jobId,
        attemptId: evidence.attemptId,
        source: evidence.source,
        payload: evidence.payload,
      });
    }

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
