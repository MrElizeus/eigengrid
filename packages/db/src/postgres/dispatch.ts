import {
  VALID_TRANSITIONS,
  canTransitionJobStatus,
  type JobAttemptStatus,
  type JobStatus,
} from "@eigengrid/core";
import { DbError, DbErrorCode, DbInvalidTransitionError } from "../errors";
import { VALID_ATTEMPT_TRANSITIONS, isValidAttemptTransition } from "../rows";
import type { PostgresContext } from "./context";
import { isJobStatus } from "./row-helpers";

import { emitClientEvent } from "./events";

export async function claimJobForDispatch(
  context: PostgresContext,
  jobId: string,
  nodeId: string,
  attemptId: string,
  runner: import("@eigengrid/core").RunnerKind,
  command: string,
  cwd: string,
): Promise<import("../client").ClaimDispatchResult> {
  if (!context.pool) throw new DbError("Database not initialized", DbErrorCode.NOT_INITIALIZED);
  const client = await context.pool.connect();
  try {
    await client.query("BEGIN");

    // Mutual exclusion for same-job claims: row-level lock on job
    // 1. Verify job exists and is claimable (with FOR UPDATE to serialize concurrent claims)
    const jobRow = (await client.query("SELECT * FROM jobs WHERE id = $1 FOR UPDATE", [jobId]))
      .rows[0] as Record<string, unknown> | undefined;
    if (!jobRow) {
      await client.query("ROLLBACK");
      client.release();
      return { claimed: false, reason: "not_found", message: `Job ${jobId} not found` };
    }
    const jobStatus = String(jobRow.status ?? "");
    if (jobStatus !== "queued") {
      await client.query("ROLLBACK");
      client.release();
      return {
        claimed: false,
        reason: "not_queued",
        message: `Job ${jobId} has status "${jobStatus}", expected "queued"`,
      };
    }

    // 2. Check for existing nonterminal attempts (under same transaction, after FOR UPDATE on job)
    const attemptRows = (
      await client.query("SELECT id, status FROM job_attempts WHERE job_id = $1", [jobId])
    ).rows as Record<string, unknown>[];
    const nonTerminal = attemptRows.find((a) => {
      const s = String(a.status ?? "");
      return s === "created" || s === "queued" || s === "staged" || s === "running";
    });
    if (nonTerminal) {
      await client.query("ROLLBACK");
      client.release();
      return {
        claimed: false,
        reason: "has_nonterminal_attempt",
        message: `Job ${jobId} has nonterminal attempt ${String(nonTerminal.id)} (${String(nonTerminal.status)})`,
      };
    }

    // 3. Verify node exists and is enabled under node-key advisory lock
    //    Serialize same-node claims so maxJobs/capacity checks are accurate
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [nodeId]);
    const nodeRow = (await client.query("SELECT * FROM nodes WHERE id = $1 FOR UPDATE", [nodeId]))
      .rows[0] as Record<string, unknown> | undefined;
    if (!nodeRow) {
      await client.query("ROLLBACK");
      client.release();
      return { claimed: false, reason: "node_invalid", message: `Node ${nodeId} not found` };
    }
    const nodeStatus = String(nodeRow.status ?? "");
    const nodeDraining =
      nodeStatus === "draining" || nodeRow.draining === true || Number(nodeRow.draining ?? 0) === 1;
    if (nodeStatus === "offline" || nodeStatus === "error" || nodeDraining) {
      await client.query("ROLLBACK");
      client.release();
      return {
        claimed: false,
        reason: "node_invalid",
        message: nodeDraining ? `Node ${nodeId} is draining` : `Node ${nodeId} is ${nodeStatus}`,
      };
    }

    // ── Capacity revalidation: count existing reservations on this node ──
    // Count jobs with node_id = target node and non-terminal status (running, staged, queued)
    // Exclude the current job being claimed
    const capResult = (
      await client.query(
        `SELECT
           COUNT(*) AS existing_jobs,
           COALESCE(SUM(cpu_threads), 0) AS used_cpu,
           COALESCE(SUM(memory_mb), 0) AS used_mem,
           COALESCE(SUM(scratch_mb), 0) AS used_scratch
         FROM jobs WHERE node_id = $1 AND id != $2 AND status IN ('queued','staged','running')`,
        [nodeId, jobId],
      )
    ).rows[0] as Record<string, unknown>;
    const existingJobs = Number(capResult?.existing_jobs ?? 0);
    const usedCpu = Number(capResult?.used_cpu ?? 0);
    const usedMem = Number(capResult?.used_mem ?? 0);
    const usedScratch = Number(capResult?.used_scratch ?? 0);
    const jobCpu = Number(jobRow.cpu_threads ?? 1);
    const jobMem = Number(jobRow.memory_mb ?? 1024);
    const jobScratch = Number(jobRow.scratch_mb ?? 1024);
    const nodeMaxJobs = Number(nodeRow.max_jobs ?? 1);
    const nodeCpuTotal = Number(nodeRow.cpu_threads_total ?? 1);
    const nodeMemTotal = Number(nodeRow.memory_mb_total ?? 1024);
    const nodeScratchTotal = Number(nodeRow.scratch_mb_total ?? 10240);

    if (existingJobs >= nodeMaxJobs) {
      await client.query("ROLLBACK");
      client.release();
      return {
        claimed: false,
        reason: "insufficient_capacity",
        message: `Node ${nodeId} at maxJobs (${nodeMaxJobs})`,
      };
    }
    if (usedCpu + jobCpu > nodeCpuTotal) {
      await client.query("ROLLBACK");
      client.release();
      return {
        claimed: false,
        reason: "insufficient_capacity",
        message: `Node ${nodeId} insufficient CPU (used ${usedCpu} + need ${jobCpu} > ${nodeCpuTotal})`,
      };
    }
    if (usedMem + jobMem > nodeMemTotal) {
      await client.query("ROLLBACK");
      client.release();
      return {
        claimed: false,
        reason: "insufficient_capacity",
        message: `Node ${nodeId} insufficient memory (used ${usedMem} + need ${jobMem} > ${nodeMemTotal})`,
      };
    }
    if (usedScratch + jobScratch > nodeScratchTotal) {
      await client.query("ROLLBACK");
      client.release();
      return {
        claimed: false,
        reason: "insufficient_capacity",
        message: `Node ${nodeId} insufficient scratch (used ${usedScratch} + need ${jobScratch} > ${nodeScratchTotal})`,
      };
    }

    // 4. Create attempt with status "created"
    const now = context.nextTimestamp();
    await client.query(
      "INSERT INTO job_attempts (id, job_id, runner, status, command, cwd, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [attemptId, jobId, runner, "created", command, cwd, now, now],
    );

    // 5. Assign node_id on job
    await client.query("UPDATE jobs SET node_id = $1, updated_at = $2 WHERE id = $3", [
      nodeId,
      now,
      jobId,
    ]);

    // 6. Emit attempt.created event
    await emitClientEvent(context, client, {
      type: "attempt.created",
      jobId,
      attemptId,
      payload: { runner, command, cwd, nodeId },
    });

    await client.query("COMMIT");
    client.release();
    return { claimed: true, jobId, attemptId, nodeId };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* best-effort */
    }
    client.release();
    return {
      claimed: false,
      reason: "concurrent_claim",
      message: `Claim failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function releaseJobDispatch(
  context: PostgresContext,
  jobId: string,
  attemptId: string,
  errorMessage: string,
): Promise<void> {
  if (!context.pool) throw new DbError("Database not initialized", DbErrorCode.NOT_INITIALIZED);
  const client = await context.pool.connect();
  try {
    await client.query("BEGIN");
    // Lock the exact attempt/job ownership pair before deciding whether to
    // transition it.
    const current = (
      await client.query(
        `SELECT a.status AS attempt_status, j.status AS job_status, j.node_id
           FROM job_attempts a
           JOIN jobs j ON j.id = a.job_id
           WHERE a.id = $1 AND a.job_id = $2
           FOR UPDATE OF a, j`,
        [attemptId, jobId],
      )
    ).rows[0] as Record<string, unknown> | undefined;

    if (!current) {
      // Branch 4: Missing attempt OR Branch 5: job_id mismatch
      await client.query("COMMIT");
      return;
    }

    // Match the row-lock-then-advisory-lock ordering used by all state
    // writers, and serialize against direct event appenders before reading
    // terminal evidence.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [jobId]);

    const status = String(current.attempt_status ?? "");

    if (status === "running" || status === "completed" || status === "cancelled") {
      // Branch 3: Exact owner + running/completed/cancelled — no mutation at all
      await client.query("COMMIT");
      return;
    }

    const terminalEvents = (
      await client.query(
        `SELECT type FROM job_events
           WHERE job_id = $1 AND attempt_id = $2
             AND type IN ('process.completed', 'process.failed')`,
        [jobId, attemptId],
      )
    ).rows as Array<{ type: string }>;
    if (terminalEvents.some((event) => event.type === "process.completed")) {
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
        const transitioned = await client.query(
          `UPDATE job_attempts
             SET status = 'failed', exit_code = 1, finished_at = $1, updated_at = $2
             WHERE id = $3 AND job_id = $4 AND status = $5
             RETURNING id`,
          [now, now, attemptId, jobId, status],
        );
        if (transitioned.rowCount !== 1) {
          await client.query("ROLLBACK");
          return;
        }
        await emitClientEvent(context, client, {
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
        await client.query(
          "UPDATE jobs SET status = 'failed', node_id = NULL, updated_at = $1 WHERE id = $2",
          [now, jobId],
        );
      }
      if (jobStatus !== "failed") {
        await emitClientEvent(context, client, {
          type: "job.status.changed",
          jobId,
          payload: { from: jobStatus, to: "failed" },
        });
      }

      if (!terminalEvents.some((event) => event.type === "process.failed")) {
        await emitClientEvent(context, client, {
          type: "process.failed",
          jobId,
          attemptId,
          payload: { error: errorMessage, pid: null, exitCode: 1 },
        });
      }
      await client.query("COMMIT");
      return;
    }

    // Unknown status — no mutation
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* best-effort */
    }
    throw err;
  } finally {
    try {
      client.release();
    } catch {
      /* best-effort */
    }
  }
}
