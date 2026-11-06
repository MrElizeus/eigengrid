import type { Job, JobAttempt } from "@eigengrid/core";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { LocalReceipt, LocalReceiptV1 } from "../local-receipt";
import { localRegisterOutputArtifact, localWriteLogArtifacts } from "./artifacts";
import { localCollectAttempt } from "./collection";
import { LocalRunnerContext } from "./context";
import { type LocalTerminalAttemptEvidence, type TrackedProcess } from "./contracts";

/**
 * Materialize the database evidence derived from an authoritative terminal
 * receipt. The detached durable supervisor can outlive the CLI process, so
 * this work must also be available to a later reconciliation context.
 *
 * Every operation is idempotent: artifacts are deduplicated by their exact
 * attempt/path identity and the terminal event is appended only when the
 * durable event log does not already contain it.
 */
export async function localMaterializeTerminalEvidence(
  runner: LocalRunnerContext,
  job: Job,
  attempt: JobAttempt,
  receipt: LocalReceipt,
): Promise<void> {
  await localCollectAttempt(runner, job, attempt.id, { requiredOutput: false });

  const evidence: LocalTerminalAttemptEvidence = {
    jobId: job.id,
    attemptId: attempt.id,
    status: receipt.status,
    exitCode: receipt.exitCode ?? undefined,
    finishedAt: receipt.finishedAt,
    source: "runner",
    payload:
      receipt.status === "cancelled"
        ? { pid: receipt.pid, signal: receipt.signal ?? "SIGTERM" }
        : {
            pid: receipt.pid,
            exitCode: receipt.exitCode ?? 1,
            durationMs: attempt.startedAt
              ? Math.max(0, receipt.finishedAt - attempt.startedAt)
              : undefined,
          },
  };
  await localPersistTerminalAttempt(runner, evidence);
}

export async function localPersistTerminalAttempt(
  runner: LocalRunnerContext,
  evidence: LocalTerminalAttemptEvidence,
): Promise<void> {
  await runner.db.materializeTerminalAttempt(evidence);
}

// ── Lifecycle Finalization ──────────────────────────────
// Writes a durable terminal receipt + DB state + events.
// The receipt survives the originating context, enabling a
// new process to recover the outcome.

export async function localFinalizeAttempt(
  runner: LocalRunnerContext,
  job: Job,
  record: TrackedProcess,
  result: { exitCode: number | undefined; stdout: string; stderr: string },
): Promise<void> {
  if (record.settled) return;
  record.settled = true;

  const stdout =
    runner.options.durableCompletion && existsSync(record.stdoutPath)
      ? readFileSync(record.stdoutPath, "utf8")
      : result.stdout;
  const stderr =
    runner.options.durableCompletion && existsSync(record.stderrPath)
      ? readFileSync(record.stderrPath, "utf8")
      : result.stderr;
  await localWriteLogArtifacts(runner, job.id, record, stdout, stderr);
  await localRegisterOutputArtifact(runner, job, record);

  const exitCode = result.exitCode ?? 1;
  const now = Date.now();
  const status = exitCode === 0 ? "completed" : "failed";

  // Write durable terminal receipt (survives context exit)
  const receipt: LocalReceiptV1 = {
    schemaVersion: 1,
    jobId: job.id,
    attemptId: record.attemptId,
    pid: record.handle.pid ?? 0,
    command: "",
    args: [],
    cwd: record.jobDir,
    exitCode,
    signal: null,
    finishedAt: now,
    status,
  };
  try {
    runner.supervisor.writeTerminalReceipt(record.jobDir, record.attemptId, receipt);
  } catch {
    // Non-fatal if receipt write fails — state is still persisted in DB
  }

  await localPersistTerminalAttempt(runner, {
    jobId: job.id,
    attemptId: record.attemptId,
    status,
    exitCode,
    finishedAt: now,
    source: "runner",
    payload: {
      pid: record.handle.pid ?? null,
      exitCode,
      durationMs: now - record.startedAt,
    },
  });
}

export async function localFinalizeSpawnError(
  runner: LocalRunnerContext,
  job: Job,
  record: Pick<TrackedProcess, "attemptId" | "stdoutPath" | "stderrPath">,
  error: Error & { code?: string },
): Promise<void> {
  const now = Date.now();
  await localWriteLogArtifacts(runner, job.id, record, "", `${error.message}\n`);

  const exitCode = error.code === "ENOENT" ? 127 : 1;

  // Write receipt for spawn errors too
  const receipt: LocalReceiptV1 = {
    schemaVersion: 1,
    jobId: job.id,
    attemptId: record.attemptId,
    pid: 0,
    command: "",
    args: [],
    cwd: "",
    exitCode,
    signal: null,
    finishedAt: now,
    status: "failed",
  };
  try {
    runner.supervisor.writeTerminalReceipt(join(job.workdir, job.id), record.attemptId, receipt);
  } catch {
    /* best-effort */
  }

  await localPersistTerminalAttempt(runner, {
    jobId: job.id,
    attemptId: record.attemptId,
    status: "failed",
    exitCode,
    finishedAt: now,
    source: "runner",
    payload: { pid: null, exitCode, error: error.message },
  });
}
