import type { Job } from "@eigengrid/core";
import { readDurableExitStatus } from "../durable-local-supervisor";
import type { LocalActiveIdentity } from "../local-identity";
import type { LocalReceipt, LocalReceiptV1 } from "../local-receipt";
import { LocalRunnerContext } from "./context";
import { localMaterializeTerminalEvidence } from "./terminal";

/**
 * Cancel a local attempt.
 *
 * The DB terminal materializer owns cancellation state and event atomically;
 * the backend returns whether this call initiated the cancellation.
 *
 * Race-safe: marks settled and removes in-memory tracking
 * BEFORE any awaits (signal → mark → await DB/receipt).
 */
export async function localCancelAttempt(
  runner: LocalRunnerContext,
  job: Job,
  attemptId: string,
): Promise<
  | { ok: true; transitioned: boolean; receipt: LocalReceipt; message: string }
  | { ok: false; message: string }
> {
  const jobDir = runner.jobDir(job);
  const attempt = await runner.readAttempt(jobDir, attemptId);

  let activeIdentity: LocalActiveIdentity | null = null;
  try {
    const candidate = runner.supervisor.readActiveIdentity(jobDir, attemptId);
    if (
      candidate &&
      candidate.jobId === job.id &&
      candidate.attemptId === attemptId &&
      candidate.cwd === jobDir
    ) {
      activeIdentity = candidate;
    }
  } catch {
    // Cancellation requires an exact readable identity below.
  }
  const initialIdentityStatus = activeIdentity
    ? runner.supervisor.verifyActiveIdentity(jobDir, attemptId)
    : "absent";

  // A receipt is idempotent evidence only after the exact identity died.
  const existingReceipt =
    initialIdentityStatus === "dead"
      ? runner.supervisor.readReceipt(jobDir, attemptId, {
          jobId: job.id,
          attemptId,
          cwd: jobDir,
        })
      : null;
  if (existingReceipt) {
    if (!attempt) {
      return {
        ok: false,
        message: `Terminal receipt exists for ${attemptId}, but its database attempt is missing`,
      };
    }
    try {
      // A previous cancellation/reconciliation may have written the receipt
      // before a DB write failed. Replay the canonical evidence before the
      // idempotent early return so partial persistence heals on retry.
      await localMaterializeTerminalEvidence(runner, job, attempt, existingReceipt);
    } catch {
      return {
        ok: false,
        message: `Terminal receipt exists for ${attemptId}, but durable evidence materialization failed`,
      };
    }
    if (existingReceipt.status === "cancelled") {
      return {
        ok: true,
        transitioned: false,
        receipt: existingReceipt,
        message: "Already cancelled",
      };
    }
    return {
      ok: false,
      message: `Attempt ${attemptId} is already ${existingReceipt.status} (cannot cancel)`,
    };
  }

  // Terminal states cannot be cancelled
  const terminalStates = ["completed", "failed", "cancelled", "parsed"] as const;
  if (attempt && terminalStates.includes(attempt.status as (typeof terminalStates)[number])) {
    return {
      ok: false,
      message: `Attempt ${attemptId} is already ${attempt.status} (cannot cancel)`,
    };
  }

  // Find process — prefer in-memory, fall back to identity-verified PID
  let targetPid: number | undefined;
  let identityVerified = false;

  const tracked = runner.processes.get(job.id);
  if (tracked && !tracked.settled && tracked.handle.pid) {
    targetPid = tracked.handle.pid;
    identityVerified = true;
  }

  // Fall back to active-identity verified PID (supports restart)
  if (!identityVerified && attempt?.pid) {
    if (initialIdentityStatus === "valid" && activeIdentity?.pid === attempt.pid) {
      targetPid = activeIdentity.pid;
      identityVerified = true;
    } else if (initialIdentityStatus === "absent") {
      return {
        ok: false,
        message: `PID-only cancellation refused for attempt ${attemptId}: no identity/receipt. Use SIGTERM manually if safe.`,
      };
    } else {
      return {
        ok: false,
        message: `Cancellation refused for attempt ${attemptId}: identity verification failed (${initialIdentityStatus})`,
      };
    }
  }

  if (!targetPid) {
    return { ok: false, message: `No tracked process or identity for attempt ${attemptId}` };
  }

  // ── Race-safe cancellation protocol ────────────────────
  // 1. Mark settled FIRST to suppress completion callback.
  // 2. Remove from tracking to prevent double-kill.
  // 3. Signal the process.
  // 4. THEN do awaits for receipt/DB/events.

  if (tracked) {
    tracked.settled = true;
    runner.processes.delete(job.id);
  }

  // Signal
  try {
    process.kill(targetPid, "SIGTERM");
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ESRCH") {
      // Process already dead — write receipt for cancelled
    } else {
      return { ok: false, message: `Failed to signal PID ${targetPid}: ${nodeErr.message}` };
    }
  }

  // Do not release capacity until the exact PID is dead. In durable mode the
  // status file is written only after the wrapper's TERM→KILL group cleanup.
  const confirmationDeadline =
    Date.now() + (runner.options.cancellationConfirmationTimeoutMs ?? 3_000);
  let durableStatus = runner.options.durableCompletion
    ? readDurableExitStatus(jobDir, attemptId)
    : null;
  let confirmed = false;
  while (Date.now() <= confirmationDeadline) {
    const verification = runner.supervisor.verifyActiveIdentity(jobDir, attemptId);
    if (runner.options.durableCompletion) {
      durableStatus = readDurableExitStatus(jobDir, attemptId);
    }
    if (verification === "dead" && (!runner.options.durableCompletion || durableStatus)) {
      confirmed = true;
      break;
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  if (!confirmed) {
    return {
      ok: false,
      message: `Cancellation signal sent to PID ${targetPid}, but termination is safely-unknown; durable state remains non-terminal`,
    };
  }

  // A natural completion may win the signal race. Preserve its real status.
  if (durableStatus && ![129, 130, 143].includes(durableStatus.exitCode)) {
    const completedReceipt: LocalReceiptV1 = {
      schemaVersion: 1,
      jobId: job.id,
      attemptId,
      pid: targetPid,
      command: activeIdentity?.command ?? attempt?.command ?? "",
      args: activeIdentity?.args ?? [],
      cwd: jobDir,
      exitCode: durableStatus.exitCode,
      signal: null,
      finishedAt: durableStatus.finishedAt,
      status: durableStatus.exitCode === 0 ? "completed" : "failed",
    };
    runner.supervisor.writeTerminalReceipt(jobDir, attemptId, completedReceipt);
    if (attempt) await localMaterializeTerminalEvidence(runner, job, attempt, completedReceipt);
    return {
      ok: false,
      message: `Attempt ${attemptId} finished before cancellation was confirmed`,
    };
  }

  const now = durableStatus?.finishedAt ?? Date.now();
  const receipt: LocalReceiptV1 = {
    schemaVersion: 1,
    jobId: job.id,
    attemptId,
    pid: targetPid,
    command: activeIdentity?.command ?? attempt?.command ?? "",
    args: activeIdentity?.args ?? [],
    cwd: jobDir,
    exitCode: null,
    signal: "SIGTERM",
    finishedAt: now,
    status: "cancelled",
  };

  runner.supervisor.writeTerminalReceipt(jobDir, attemptId, receipt);

  if (!attempt) {
    return {
      ok: false,
      message: `Cancellation receipt was written for ${attemptId}, but its database attempt is missing`,
    };
  }
  await localMaterializeTerminalEvidence(runner, job, attempt, receipt);

  return {
    ok: true,
    transitioned: true,
    receipt,
    message: `Cancelled PID ${targetPid} for attempt ${attemptId}`,
  };
}
