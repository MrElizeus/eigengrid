import type { Job } from "@eigengrid/core";
import { readDurableExitStatus } from "../durable-local-supervisor";
import type { LocalActiveIdentity } from "../local-identity";
import type { LocalReceipt, LocalReceiptV1 } from "../local-receipt";
import { LocalRunnerContext } from "./context";
import { localMaterializeTerminalEvidence } from "./terminal";

/**
 * Reconcile the durable truth about an attempt.
 *
 * 1. Check identity + receipt (most authoritative)
 * 2. Check in-memory tracked process
 * 3. Check persisted attempt PID with identity verification
 * 4. Use persisted terminal state if available
 *
 * Never infers running from status or PID existence alone.
 * Applies receipt-confirmed terminal state to DB.
 */
export async function localReconcileAttempt(
  runner: LocalRunnerContext,
  job: Job,
  attemptId: string,
): Promise<{
  status: "running" | "completed" | "failed" | "cancelled" | "safely-unknown";
  receipt?: LocalReceipt;
  exitCode?: number;
  message: string;
}> {
  const jobDir = runner.jobDir(job);
  const attempt = await runner.readAttempt(jobDir, attemptId);

  // A terminal file inside the writable job directory is not authoritative
  // while the exact persisted process identity is still alive. Check the
  // in-memory handle and anti-PID-reuse identity before reading either file.
  const tracked = runner.processes.get(job.id);
  if (tracked && !tracked.settled && tracked.handle.pid) {
    try {
      process.kill(tracked.handle.pid, 0);
      return { status: "running", message: `PID ${tracked.handle.pid} verified alive` };
    } catch {
      /* fall through to durable identity verification */
    }
  }

  let identity: LocalActiveIdentity | null = null;
  try {
    const candidate = runner.supervisor.readActiveIdentity(jobDir, attemptId);
    if (
      candidate &&
      candidate.jobId === job.id &&
      candidate.attemptId === attemptId &&
      candidate.cwd === jobDir
    ) {
      identity = candidate;
    }
  } catch {
    // Malformed or unreadable identity is never enough to trust terminal files.
  }
  const identityStatus = identity
    ? runner.supervisor.verifyActiveIdentity(jobDir, attemptId)
    : "absent";
  if (identityStatus === "valid") {
    return {
      status: "running",
      message: `PID ${identity!.pid} identity verified; terminal files are not yet authoritative`,
    };
  }
  const terminalFilesTrusted = identityStatus === "dead";

  // Terminal files are trusted only after the exact supervisor identity died.
  const receipt = terminalFilesTrusted
    ? runner.supervisor.readReceipt(jobDir, attemptId, {
        jobId: job.id,
        attemptId,
        cwd: jobDir,
      })
    : null;
  if (receipt) {
    // Persist all receipt-confirmed evidence. This must run even when status
    // is already terminal because a previous process may have exited between
    // the status write and artifact/event materialization.
    if (attempt) {
      try {
        await localMaterializeTerminalEvidence(runner, job, attempt, receipt);
      } catch {
        return {
          status: "safely-unknown",
          message: `Terminal receipt exists for ${attemptId}, but durable evidence materialization failed`,
        };
      }
    }
    return {
      status: receipt.status,
      receipt,
      exitCode: receipt.exitCode ?? undefined,
      message: `Receipt confirms ${receipt.status} (exit ${receipt.exitCode ?? "signal"})`,
    };
  }

  // The detached wrapper can finish after its launching Bun process is
  // killed. Convert its narrow terminal status into the canonical receipt,
  // anchored to the already persisted active process identity.
  if (runner.options.durableCompletion && terminalFilesTrusted) {
    const exitStatus = readDurableExitStatus(jobDir, attemptId);
    if (
      exitStatus &&
      identity &&
      identity.jobId === job.id &&
      identity.attemptId === attemptId &&
      identity.cwd === jobDir
    ) {
      const recoveredReceipt: LocalReceiptV1 = {
        schemaVersion: 1,
        jobId: job.id,
        attemptId,
        pid: identity.pid,
        command: identity.command,
        args: identity.args,
        cwd: identity.cwd,
        exitCode: exitStatus.exitCode,
        signal: null,
        finishedAt: exitStatus.finishedAt,
        status: exitStatus.exitCode === 0 ? "completed" : "failed",
      };
      try {
        runner.supervisor.writeTerminalReceipt(jobDir, attemptId, recoveredReceipt);
        if (attempt) {
          await localMaterializeTerminalEvidence(runner, job, attempt, recoveredReceipt);
        }
      } catch {
        return {
          status: "safely-unknown",
          message: `Durable exit status exists for ${attemptId}, but receipt reconciliation failed`,
        };
      }
      return {
        status: recoveredReceipt.status,
        receipt: recoveredReceipt,
        exitCode: recoveredReceipt.exitCode ?? undefined,
        message: `Durable supervisor confirms ${recoveredReceipt.status} (exit ${recoveredReceipt.exitCode})`,
      };
    }
  }

  // Persisted terminal DB state remains authoritative independently of files.
  if (attempt) {
    const terminalStates = ["completed", "failed", "cancelled"] as const;
    if (terminalStates.includes(attempt.status as (typeof terminalStates)[number])) {
      return {
        status: attempt.status as "completed" | "failed" | "cancelled",
        exitCode: attempt.exitCode,
        message: `From persisted state: ${attempt.status}`,
      };
    }
  }

  return { status: "safely-unknown", message: "No process evidence found" };
}
