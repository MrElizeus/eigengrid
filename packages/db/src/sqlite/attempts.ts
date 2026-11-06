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
import {
  JOB_ATTEMPT_STATUSES,
  VALID_ATTEMPT_TRANSITIONS,
  isJobAttemptStatus,
  isValidAttemptTransition,
  mapJobAttemptRow as mapJobAttemptRowHelper,
} from "../rows";
import type { SqliteContext } from "./context";
import { isJobStatus } from "./row-helpers";

import { emitBaseEvent } from "./events";

export async function createJobAttempt(
  context: SqliteContext,
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
  const db = context.ensureDb();
  const status = attempt.status ?? "created";
  if (!isJobAttemptStatus(status)) {
    throw new DbError(`Invalid job attempt status: ${status}`, DbErrorCode.INVALID_TRANSITION);
  }

  // Wrap state insert + event emission in a transaction for atomicity
  db.query("BEGIN IMMEDIATE").run();
  try {
    const now = context.nextTimestamp();
    db.query(
      "INSERT INTO job_attempts (id, job_id, runner, status, command, cwd, pid, exit_code, started_at, finished_at, created_at, updated_at) VALUES ($id, $jobId, $runner, $status, $command, $cwd, $pid, $exitCode, $startedAt, $finishedAt, $createdAt, $updatedAt)",
    ).run({
      $id: attempt.id,
      $jobId: attempt.jobId,
      $runner: attempt.runner,
      $status: status,
      $command: attempt.command,
      $cwd: attempt.cwd,
      $pid: attempt.pid ?? null,
      $exitCode: attempt.exitCode ?? null,
      $startedAt: attempt.startedAt ?? null,
      $finishedAt: attempt.finishedAt ?? null,
      $createdAt: now,
      $updatedAt: now,
    });

    // Emit event after creating attempt
    emitBaseEvent(context, {
      type: "attempt.created",
      jobId: attempt.jobId,
      attemptId: attempt.id,
      payload: { runner: attempt.runner, command: attempt.command, cwd: attempt.cwd },
    });
    db.query("COMMIT").run();
  } catch (err) {
    db.query("ROLLBACK").run();
    throw err;
  }
}

export async function updateJobAttemptStatus(
  context: SqliteContext,
  attemptId: string,
  status: JobAttemptStatus,
  updates?: {
    pid?: number;
    startedAt?: number;
    exitCode?: number;
    finishedAt?: number;
  },
): Promise<void> {
  const db = context.ensureDb();
  if (!isJobAttemptStatus(status)) {
    throw new DbInvalidTransitionError("job_attempt", "", status, [...JOB_ATTEMPT_STATUSES]);
  }

  db.query("BEGIN IMMEDIATE").run();
  try {
    const current = db
      .query("SELECT * FROM job_attempts WHERE id = $attemptId")
      .get({ $attemptId: attemptId });
    if (!current) throw new DbNotFoundError("JobAttempt", attemptId);

    const previousStatus = String(current.status) as JobAttemptStatus;

    // Same-state no-op: no updated_at rewrite, no status event
    if (previousStatus === status) {
      db.query("COMMIT").run();
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

    const fields = ["status = $status", "updated_at = $updatedAt"];
    const params: Record<string, unknown> = {
      $attemptId: attemptId,
      $status: status,
      $updatedAt: context.nextTimestamp(),
    };

    if (updates?.pid !== undefined) {
      fields.push("pid = $pid");
      params.$pid = updates.pid;
    }
    if (updates?.startedAt !== undefined) {
      fields.push("started_at = $startedAt");
      params.$startedAt = updates.startedAt;
    }
    if (updates?.exitCode !== undefined) {
      fields.push("exit_code = $exitCode");
      params.$exitCode = updates.exitCode;
    }
    if (updates?.finishedAt !== undefined) {
      fields.push("finished_at = $finishedAt");
      params.$finishedAt = updates.finishedAt;
    }

    params.$previousStatus = previousStatus;
    const transitioned = db
      .query(
        `UPDATE job_attempts SET ${fields.join(", ")}
           WHERE id = $attemptId AND status = $previousStatus`,
      )
      .run(params) as { changes: number };
    if (transitioned.changes !== 1) {
      throw new DbError(
        `Concurrent job attempt transition for ${attemptId}`,
        DbErrorCode.CONSTRAINT,
      );
    }

    // Emit event after successful transition
    emitBaseEvent(context, {
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
    db.query("COMMIT").run();
  } catch (err) {
    db.query("ROLLBACK").run();
    throw err;
  }
}

export async function listJobAttempts(
  context: SqliteContext,
  jobId?: string,
): Promise<JobAttempt[]> {
  const db = context.ensureDb();
  const rows = jobId
    ? db
        .query("SELECT * FROM job_attempts WHERE job_id = $jobId ORDER BY created_at ASC")
        .all({ $jobId: jobId })
    : db.query("SELECT * FROM job_attempts ORDER BY created_at ASC").all();

  return rows.map((row: Record<string, unknown>) => mapJobAttemptRowHelper(row));
}

export async function materializeTerminalAttempt(
  context: SqliteContext,
  evidence: TerminalAttemptEvidence,
): Promise<void> {
  const db = context.ensureDb();
  db.query("BEGIN IMMEDIATE").run();
  try {
    const attempt = db
      .query(
        `SELECT status, exit_code, finished_at FROM job_attempts
           WHERE id = $attemptId AND job_id = $jobId`,
      )
      .get({ $attemptId: evidence.attemptId, $jobId: evidence.jobId });
    if (!attempt) throw new DbNotFoundError("JobAttempt", evidence.attemptId);

    const job = db
      .query("SELECT status FROM jobs WHERE id = $jobId")
      .get({ $jobId: evidence.jobId });
    if (!job) throw new DbNotFoundError("Job", evidence.jobId);

    const terminalType =
      evidence.status === "completed"
        ? "process.completed"
        : evidence.status === "cancelled"
          ? "process.cancelled"
          : "process.failed";
    const terminalEvents = db
      .query(
        `SELECT type, payload_json FROM job_events
           WHERE job_id = $jobId AND attempt_id = $attemptId
             AND type IN ('process.completed', 'process.failed', 'process.cancelled')`,
      )
      .all({ $jobId: evidence.jobId, $attemptId: evidence.attemptId });
    const conflictingEvent = terminalEvents.find((event) => String(event.type) !== terminalType);
    if (conflictingEvent) {
      throw new DbError(
        `Conflicting terminal evidence for attempt ${evidence.attemptId}`,
        DbErrorCode.CONSTRAINT,
      );
    }
    for (const event of terminalEvents) {
      if (event.payload_json == null || evidence.exitCode === undefined) continue;
      let payload: Record<string, unknown> | null = null;
      try {
        payload = JSON.parse(String(event.payload_json)) as Record<string, unknown>;
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

    const previousAttemptStatus = String(attempt.status) as JobAttemptStatus;
    if (previousAttemptStatus === evidence.status) {
      const storedExitCode = attempt.exit_code == null ? undefined : Number(attempt.exit_code);
      const storedFinishedAt =
        attempt.finished_at == null ? undefined : Number(attempt.finished_at);
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
      const fields = ["status = $status", "finished_at = $finishedAt", "updated_at = $updatedAt"];
      const params: Record<string, unknown> = {
        $status: evidence.status,
        $finishedAt: evidence.finishedAt,
        $updatedAt: context.nextTimestamp(),
        $attemptId: evidence.attemptId,
        $jobId: evidence.jobId,
      };
      if (evidence.exitCode !== undefined) {
        fields.push("exit_code = $exitCode");
        params.$exitCode = evidence.exitCode;
      }
      db.query(
        `UPDATE job_attempts SET ${fields.join(", ")}
           WHERE id = $attemptId AND job_id = $jobId`,
      ).run(params);
    }
    if (attemptStatusChanged) {
      emitBaseEvent(context, {
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

    const previousJobStatus = String(job.status);
    if (previousJobStatus !== evidence.status) {
      if (
        !isJobStatus(previousJobStatus) ||
        !canTransitionJobStatus(previousJobStatus, evidence.status)
      ) {
        const allowed = VALID_TRANSITIONS[previousJobStatus as JobStatus] ?? [];
        throw new DbInvalidTransitionError("job", previousJobStatus, evidence.status, [...allowed]);
      }
      db.query("UPDATE jobs SET status = $status, updated_at = $updatedAt WHERE id = $jobId").run({
        $status: evidence.status,
        $updatedAt: context.nextTimestamp(),
        $jobId: evidence.jobId,
      });
      emitBaseEvent(context, {
        type: "job.status.changed",
        jobId: evidence.jobId,
        payload: { from: previousJobStatus, to: evidence.status },
      });
    }

    if (terminalEvents.length === 0) {
      emitBaseEvent(context, {
        type: terminalType,
        jobId: evidence.jobId,
        attemptId: evidence.attemptId,
        source: evidence.source,
        payload: evidence.payload,
      });
    }

    db.query("COMMIT").run();
  } catch (err) {
    db.query("ROLLBACK").run();
    throw err;
  }
}
