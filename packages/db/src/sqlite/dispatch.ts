import {
  VALID_TRANSITIONS,
  canTransitionJobStatus,
  type JobAttemptStatus,
  type JobStatus,
  type RunnerKind,
} from "@eigengrid/core";
import { DbError, DbErrorCode, DbInvalidTransitionError } from "../errors";
import { VALID_ATTEMPT_TRANSITIONS, isValidAttemptTransition } from "../rows";
import type { SqliteContext } from "./context";
import { isJobStatus } from "./row-helpers";

import { emitBaseEvent } from "./events";

export async function claimJobForDispatch(
  context: SqliteContext,
  jobId: string,
  nodeId: string,
  attemptId: string,
  runner: RunnerKind,
  command: string,
  cwd: string,
): Promise<import("../client").ClaimDispatchResult> {
  const db = context.ensureDb();

  db.query("BEGIN IMMEDIATE").run();
  try {
    // 1. Verify job exists and is queued (only queued, not "created")
    const jobRow = db.query("SELECT * FROM jobs WHERE id = $jobId").get({ $jobId: jobId }) as
      | Record<string, unknown>
      | undefined;
    if (!jobRow) {
      db.query("ROLLBACK").run();
      return { claimed: false, reason: "not_found", message: `Job ${jobId} not found` };
    }
    const jobStatus = String(jobRow.status ?? "");
    if (jobStatus !== "queued") {
      db.query("ROLLBACK").run();
      return {
        claimed: false,
        reason: "not_queued",
        message: `Job ${jobId} has status "${jobStatus}", expected "queued"`,
      };
    }

    // 2. Check for existing nonterminal attempts
    const existingAttempts = db
      .query("SELECT id, status FROM job_attempts WHERE job_id = $jobId")
      .all({ $jobId: jobId }) as Record<string, unknown>[];
    const nonTerminal = existingAttempts.find((a) => {
      const s = String(a.status ?? "");
      return s === "created" || s === "queued" || s === "staged" || s === "running";
    });
    if (nonTerminal) {
      db.query("ROLLBACK").run();
      return {
        claimed: false,
        reason: "has_nonterminal_attempt",
        message: `Job ${jobId} has nonterminal attempt ${nonTerminal.id} (${nonTerminal.status})`,
      };
    }

    // 3. Verify node exists and is enabled
    const nodeRow = db.query("SELECT * FROM nodes WHERE id = $nodeId").get({ $nodeId: nodeId }) as
      | Record<string, unknown>
      | undefined;
    if (!nodeRow) {
      db.query("ROLLBACK").run();
      return { claimed: false, reason: "node_invalid", message: `Node ${nodeId} not found` };
    }
    const nodeStatus = String(nodeRow.status ?? "");
    const nodeDraining =
      nodeStatus === "draining" || nodeRow.draining === true || Number(nodeRow.draining ?? 0) === 1;
    if (nodeStatus === "offline" || nodeStatus === "error" || nodeDraining) {
      db.query("ROLLBACK").run();
      return {
        claimed: false,
        reason: "node_invalid",
        message: nodeDraining ? `Node ${nodeId} is draining` : `Node ${nodeId} is ${nodeStatus}`,
      };
    }

    // ── Capacity revalidation: count existing reservations on this node ──
    // Count jobs with node_id = target node and non-terminal status (running, staged, queued)
    // Exclude the current job being claimed. Under BEGIN IMMEDIATE this is serialized.
    const capRow = db
      .query(
        `SELECT
           COUNT(*) AS existing_jobs,
           COALESCE(SUM(cpu_threads), 0) AS used_cpu,
           COALESCE(SUM(memory_mb), 0) AS used_mem,
           COALESCE(SUM(scratch_mb), 0) AS used_scratch
         FROM jobs WHERE node_id = $nodeId AND id != $jobId AND status IN ('queued','staged','running')`,
      )
      .get({ $nodeId: nodeId, $jobId: jobId }) as Record<string, unknown>;
    const existingJobs = Number(capRow?.existing_jobs ?? 0);
    const usedCpu = Number(capRow?.used_cpu ?? 0);
    const usedMem = Number(capRow?.used_mem ?? 0);
    const usedScratch = Number(capRow?.used_scratch ?? 0);
    const jobCpu = Number(jobRow.cpu_threads ?? 1);
    const jobMem = Number(jobRow.memory_mb ?? 1024);
    const jobScratch = Number(jobRow.scratch_mb ?? 1024);
    const nodeMaxJobs = Number(nodeRow.max_jobs ?? 1);
    const nodeCpuTotal = Number(nodeRow.cpu_threads_total ?? 1);
    const nodeMemTotal = Number(nodeRow.memory_mb_total ?? 1024);
    const nodeScratchTotal = Number(nodeRow.scratch_mb_total ?? 10240);

    if (existingJobs >= nodeMaxJobs) {
      db.query("ROLLBACK").run();
      return {
        claimed: false,
        reason: "insufficient_capacity",
        message: `Node ${nodeId} at maxJobs (${nodeMaxJobs})`,
      };
    }
    if (usedCpu + jobCpu > nodeCpuTotal) {
      db.query("ROLLBACK").run();
      return {
        claimed: false,
        reason: "insufficient_capacity",
        message: `Node ${nodeId} insufficient CPU (used ${usedCpu} + need ${jobCpu} > ${nodeCpuTotal})`,
      };
    }
    if (usedMem + jobMem > nodeMemTotal) {
      db.query("ROLLBACK").run();
      return {
        claimed: false,
        reason: "insufficient_capacity",
        message: `Node ${nodeId} insufficient memory (used ${usedMem} + need ${jobMem} > ${nodeMemTotal})`,
      };
    }
    if (usedScratch + jobScratch > nodeScratchTotal) {
      db.query("ROLLBACK").run();
      return {
        claimed: false,
        reason: "insufficient_capacity",
        message: `Node ${nodeId} insufficient scratch (used ${usedScratch} + need ${jobScratch} > ${nodeScratchTotal})`,
      };
    }

    // 4. Create attempt with status "created"
    const now = context.nextTimestamp();
    db.query(
      "INSERT INTO job_attempts (id, job_id, runner, status, command, cwd, created_at, updated_at) VALUES ($id, $jobId, $runner, $status, $command, $cwd, $createdAt, $updatedAt)",
    ).run({
      $id: attemptId,
      $jobId: jobId,
      $runner: runner,
      $status: "created",
      $command: command,
      $cwd: cwd,
      $createdAt: now,
      $updatedAt: now,
    });

    // 5. Assign node_id on job
    db.query("UPDATE jobs SET node_id = $nodeId, updated_at = $updatedAt WHERE id = $jobId").run({
      $nodeId: nodeId,
      $updatedAt: now,
      $jobId: jobId,
    });

    // 6. Emit attempt.created with the same per-job sequence allocator used
    // by every other durable event.
    emitBaseEvent(context, {
      type: "attempt.created",
      jobId,
      attemptId,
      payload: { runner, command, cwd, nodeId },
    });

    db.query("COMMIT").run();
    return { claimed: true, jobId, attemptId, nodeId };
  } catch (err) {
    db.query("ROLLBACK").run();
    return {
      claimed: false,
      reason: "concurrent_claim",
      message: `Claim failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function releaseJobDispatch(
  context: SqliteContext,
  jobId: string,
  attemptId: string,
  errorMessage: string,
): Promise<void> {
  const db = context.ensureDb();
  db.query("BEGIN IMMEDIATE").run();
  try {
    const current = db
      .query(
        `SELECT a.status AS attempt_status, j.status AS job_status, j.node_id
           FROM job_attempts a
           JOIN jobs j ON j.id = a.job_id
           WHERE a.id = $attemptId AND a.job_id = $jobId`,
      )
      .get({ $attemptId: attemptId, $jobId: jobId }) as Record<string, unknown> | undefined;

    if (!current) {
      // Branch 4: Missing attempt OR Branch 5: Attempt exists but job_id mismatch
      // No mutation of any kind — commit and return.
      db.query("COMMIT").run();
      return;
    }

    const status = String(current.attempt_status ?? "");

    if (status === "running" || status === "completed" || status === "cancelled") {
      // Branch 3: Exact owner + running/completed/cancelled — no mutation at all
      db.query("COMMIT").run();
      return;
    }

    const terminalEvents = db
      .query(
        `SELECT type FROM job_events
           WHERE job_id = $jobId AND attempt_id = $attemptId
             AND type IN ('process.completed', 'process.failed')`,
      )
      .all({ $jobId: jobId, $attemptId: attemptId });
    if (terminalEvents.some((event) => String(event.type) === "process.completed")) {
      throw new DbError(
        `Conflicting terminal evidence for attempt ${attemptId}`,
        DbErrorCode.CONSTRAINT,
      );
    }

    if (status === "created" || status === "queued" || status === "staged" || status === "failed") {
      const now = context.nextTimestamp();
      if (status !== "failed") {
        if (!isValidAttemptTransition(status as JobAttemptStatus, "failed")) {
          const allowed = VALID_ATTEMPT_TRANSITIONS[status as JobAttemptStatus] ?? [];
          throw new DbInvalidTransitionError("job_attempt", status, "failed", [...allowed]);
        }
        // The dispatch never started, so this failure is terminal: retrying
        // the same deterministic launch on every scheduler tick is unsafe.
        db.query(
          `UPDATE job_attempts
             SET status = 'failed', exit_code = 1, finished_at = $finishedAt, updated_at = $updatedAt
             WHERE id = $attemptId AND job_id = $jobId AND status = $expectedStatus`,
        ).run({
          $attemptId: attemptId,
          $jobId: jobId,
          $expectedStatus: status,
          $finishedAt: now,
          $updatedAt: now,
        });
        emitBaseEvent(context, {
          type: "attempt.status.changed",
          jobId,
          attemptId,
          payload: { from: status, to: "failed", exitCode: 1 },
        });
      }

      const jobStatus = String(current.job_status ?? "");
      const nodeAssigned = current.node_id != null;
      if (
        jobStatus !== "failed" &&
        (!isJobStatus(jobStatus) || !canTransitionJobStatus(jobStatus, "failed"))
      ) {
        const allowed = VALID_TRANSITIONS[jobStatus as JobStatus] ?? [];
        throw new DbInvalidTransitionError("job", jobStatus, "failed", [...allowed]);
      }
      if (jobStatus !== "failed" || nodeAssigned) {
        db.query(
          `UPDATE jobs SET status = 'failed', node_id = NULL, updated_at = $updatedAt
             WHERE id = $jobId`,
        ).run({ $jobId: jobId, $updatedAt: now });
      }
      if (jobStatus !== "failed") {
        emitBaseEvent(context, {
          type: "job.status.changed",
          jobId,
          payload: { from: jobStatus, to: "failed" },
        });
      }

      if (!terminalEvents.some((event) => String(event.type) === "process.failed")) {
        emitBaseEvent(context, {
          type: "process.failed",
          jobId,
          attemptId,
          payload: { error: errorMessage, pid: null, exitCode: 1 },
        });
      }
      db.query("COMMIT").run();
      return;
    }

    // Unknown status — no mutation
    db.query("COMMIT").run();
  } catch (err) {
    db.query("ROLLBACK").run();
    throw err;
  }
}
