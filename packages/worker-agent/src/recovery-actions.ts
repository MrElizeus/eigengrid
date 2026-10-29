import { existsSync, lstatSync, renameSync } from "fs";
import { isAbsolute, join, relative, resolve } from "path";
import {
  appendWorkerEvent,
  writeStatusFile,
  getRunningDir,
  getFailedDir,
  getDoneDir,
  getOrphanedDir,
  getInboxDir,
  atomicWriteFileSync,
  readStatusFile,
} from "@eigengrid/worker";
import type { RecoveryActionResult } from "./types";

// ────────────────────────────────────────────────────────────
// Recovery Actions — Pure, Typed Action Functions
// ────────────────────────────────────────────────────────────
// Each action is a named, typed function. No arbitrary command
// strings accepted. No shell execution. No LLM usage.

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/u;

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`Unsafe ${label}: ${value}`);
}

function assertRealDirectory(path: string, label: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} is not a real directory: ${path}`);
  }
}

function assertRegularFile(path: string, label: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`${label} is not a regular file: ${path}`);
  }
}

function assertContainedFile(root: string, path: string, label: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const rel = relative(resolvedRoot, resolvedPath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} escapes the bundle: ${path}`);
  }
}

/**
 * Re-trigger artifact sync for a specific job/attempt.
 * Idempotent — safe to call multiple times.
 */
export function retryArtifactSync(
  scratchDir: string,
  jobId: string,
  attemptId: string,
): RecoveryActionResult {
  try {
    assertSafeId(jobId, "job identifier");
    assertSafeId(attemptId, "attempt identifier");
  } catch (error) {
    return { ok: false, decision: "retry-artifact-sync", message: (error as Error).message };
  }
  const bundlePath = findBundlePath(scratchDir, jobId);
  if (!bundlePath) {
    return {
      ok: false,
      decision: "retry-artifact-sync",
      message: `Bundle not found for job ${jobId}`,
    };
  }

  let status: ReturnType<typeof readStatusFile>;
  try {
    status = readStatusFile(bundlePath);
  } catch (error) {
    return {
      ok: false,
      decision: "retry-artifact-sync",
      message: `Bundle status is unreadable; refusing artifact retry: ${(error as Error).message}`,
    };
  }
  if (status?.attemptId && status.attemptId !== attemptId) {
    return {
      ok: false,
      decision: "retry-artifact-sync",
      message: `Attempt ${attemptId} is not the bundle's current attempt`,
    };
  }

  const syncMarker = join(bundlePath, ".artifact-sync-retry");
  try {
    atomicWriteFileSync(syncMarker, JSON.stringify({ jobId, attemptId, triggeredAt: Date.now() }));

    appendWorkerEvent(bundlePath, "worker.artifact.available", {
      jobId,
      attemptId,
      message: "artifact sync retry triggered by worker agent",
    });

    return {
      ok: true,
      decision: "retry-artifact-sync",
      message: `Artifact sync retry triggered for ${jobId}`,
    };
  } catch (err) {
    return {
      ok: false,
      decision: "retry-artifact-sync",
      message: `Failed to trigger artifact sync retry: ${(err as Error).message}`,
    };
  }
}

/**
 * Retry parsing if output artifacts exist.
 * Only runs when output artifact files are present on disk.
 */
export function retryParserIfOutputExists(
  scratchDir: string,
  jobId: string,
  outputPath: string,
): RecoveryActionResult {
  try {
    assertSafeId(jobId, "job identifier");
  } catch (error) {
    return { ok: false, decision: "retry-parser", message: (error as Error).message };
  }
  const bundlePath = findBundlePath(scratchDir, jobId);
  if (!bundlePath) {
    return {
      ok: false,
      decision: "retry-parser",
      message: `Bundle not found for job ${jobId}`,
    };
  }

  // Safety: only proceed if output artifact file exists
  try {
    const artifactsRoot = join(bundlePath, "artifacts");
    assertContainedFile(artifactsRoot, outputPath, "Parser output");
    assertRegularFile(outputPath, "Parser output");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return {
      ok: false,
      decision: "retry-parser",
      message:
        code === "ENOENT"
          ? `Output path does not exist: ${outputPath}; parser retry requires an existing regular output`
          : `${(error as Error).message}; parser retry requires an existing regular output`,
    };
  }

  const parserMarker = join(bundlePath, ".parser-retry");
  try {
    atomicWriteFileSync(
      parserMarker,
      JSON.stringify({ jobId, outputPath, triggeredAt: Date.now() }),
    );

    appendWorkerEvent(bundlePath, "worker.artifact.available", {
      jobId,
      path: outputPath,
      kind: "output",
      message: "parser retry triggered by worker agent",
    });

    return {
      ok: true,
      decision: "retry-parser",
      message: `Parser retry triggered for ${jobId} at ${outputPath}`,
    };
  } catch (err) {
    return {
      ok: false,
      decision: "retry-parser",
      message: `Failed to trigger parser retry: ${(err as Error).message}`,
    };
  }
}

/**
 * Mark a node as draining by writing a drain marker file.
 * Emits drain event. Does NOT modify compute resources.
 */
export function markNodeDraining(
  scratchDir: string,
  nodeId: string,
  reason: string,
): RecoveryActionResult {
  try {
    assertSafeId(nodeId, "node identifier");
    assertRealDirectory(join(scratchDir, "daemon"), "Worker daemon directory");
  } catch (error) {
    return { ok: false, decision: "mark-draining", message: (error as Error).message };
  }
  const drainMarker = join(scratchDir, "daemon", `.drain-${nodeId}`);
  try {
    atomicWriteFileSync(drainMarker, JSON.stringify({ nodeId, reason, triggeredAt: Date.now() }));

    appendWorkerEvent(join(scratchDir, "daemon"), "worker.error", {
      message: `node.draining: ${nodeId} — ${reason}`,
    });

    return {
      ok: true,
      decision: "mark-draining",
      message: `Node ${nodeId} marked as draining: ${reason}`,
    };
  } catch (err) {
    return {
      ok: false,
      decision: "mark-draining",
      message: `Failed to mark node draining: ${(err as Error).message}`,
    };
  }
}

/**
 * Check if a known PID is still alive. If alive, write a reattachment
 * marker so the daemon can re-monitor. Does NOT use process.kill with
 * signals beyond checking existence (kill(pid, 0)).
 */
export function reattachKnownPid(
  scratchDir: string,
  jobId: string,
  pid: number,
): RecoveryActionResult {
  try {
    assertSafeId(jobId, "job identifier");
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("PID is invalid");
  } catch (error) {
    return { ok: false, decision: "reattach-pid", message: (error as Error).message };
  }
  const bundlePath = findBundlePath(scratchDir, jobId);
  if (!bundlePath) {
    return {
      ok: false,
      decision: "reattach-pid",
      message: `Bundle not found for job ${jobId}`,
    };
  }

  let status: ReturnType<typeof readStatusFile>;
  try {
    status = readStatusFile(bundlePath);
  } catch (error) {
    return {
      ok: false,
      decision: "reattach-pid",
      message: `Bundle status is unreadable; refusing PID reattachment: ${(error as Error).message}`,
    };
  }
  if (status?.pid !== undefined && status.pid !== pid) {
    return {
      ok: false,
      decision: "reattach-pid",
      message: `PID ${pid} is not the bundle's recorded process`,
    };
  }

  // Check if PID is alive using kill(pid, 0) — no signal sent
  let pidAlive = false;
  try {
    process.kill(pid, 0);
    pidAlive = true;
  } catch {
    pidAlive = false;
  }

  if (!pidAlive) {
    return {
      ok: false,
      decision: "reattach-pid",
      message: `PID ${pid} for job ${jobId} is no longer alive; cannot reattach`,
    };
  }

  const reattachMarker = join(bundlePath, ".pid-reattached");
  try {
    atomicWriteFileSync(reattachMarker, JSON.stringify({ jobId, pid, reattachedAt: Date.now() }));

    appendWorkerEvent(bundlePath, "worker.process.started", {
      jobId,
      pid,
      message: "PID reattached by worker agent",
    });

    return {
      ok: true,
      decision: "reattach-pid",
      message: `PID ${pid} for job ${jobId} is alive and reattached`,
    };
  } catch (err) {
    return {
      ok: false,
      decision: "reattach-pid",
      message: `Failed to reattach PID: ${(err as Error).message}`,
    };
  }
}

/**
 * Mark a zombie job as failed with event.
 * Writes status.json and moves bundle from running/ to failed/.
 */
export function markZombieFailed(
  scratchDir: string,
  jobId: string,
  attemptId: string,
): RecoveryActionResult {
  try {
    assertSafeId(jobId, "job identifier");
    assertSafeId(attemptId, "attempt identifier");
  } catch (error) {
    return { ok: false, decision: "mark-zombie-failed", message: (error as Error).message };
  }
  const bundlePath = findBundlePath(scratchDir, jobId);
  if (!bundlePath) {
    return {
      ok: false,
      decision: "mark-zombie-failed",
      message: `Bundle not found for job ${jobId}`,
    };
  }

  try {
    // Write zombie-failed status
    writeStatusFile(bundlePath, {
      schemaVersion: 1,
      jobId,
      attemptId,
      state: "failed" as const,
      command: "",
      finishedAt: Date.now(),
      message: "marked zombie-failed by worker agent (PID no longer alive)",
    });

    // Move bundle from running to failed
    const runningPath = join(getRunningDir(scratchDir), jobId);
    const failedDir = getFailedDir(scratchDir);
    const failedPath = join(failedDir, jobId);

    if (existsSync(runningPath)) {
      assertRealDirectory(failedDir, "Worker failed directory");
      if (existsSync(failedPath))
        throw new Error(`Failed destination already exists: ${failedPath}`);
      renameSync(runningPath, failedPath);
    }

    appendWorkerEvent(join(scratchDir, "daemon"), "worker.job.failed", {
      jobId,
      attemptId,
      message: "zombie job marked as failed by worker agent",
    });

    return {
      ok: true,
      decision: "mark-zombie-failed",
      message: `Job ${jobId} marked as zombie-failed`,
    };
  } catch (err) {
    return {
      ok: false,
      decision: "mark-zombie-failed",
      message: `Failed to mark zombie failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Re-stage the same command exactly once.
 * Reads the manifest and re-creates a READY marker so the daemon
 * picks it up again. At most one retry per job.
 */
export function retrySameCommandOnce(scratchDir: string, jobId: string): RecoveryActionResult {
  try {
    assertSafeId(jobId, "job identifier");
  } catch (error) {
    return { ok: false, decision: "retry-same-command-once", message: (error as Error).message };
  }
  const bundlePath = findBundlePath(scratchDir, jobId);
  if (!bundlePath) {
    return {
      ok: false,
      decision: "retry-same-command-once",
      message: `Bundle not found for job ${jobId}`,
    };
  }

  const manifestPath = join(bundlePath, "manifest.json");
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      decision: "retry-same-command-once",
      message: `Manifest not found at ${manifestPath}`,
    };
  }
  try {
    assertRegularFile(manifestPath, "Worker manifest");
  } catch (error) {
    return { ok: false, decision: "retry-same-command-once", message: (error as Error).message };
  }

  try {
    // Re-stage: copy bundle back to inbox with READY marker
    const inboxDir = getInboxDir(scratchDir);
    const inboxPath = join(inboxDir, jobId);

    if (existsSync(inboxPath)) {
      // Already in inbox — just ensure READY marker
      assertRealDirectory(inboxPath, "Worker inbox bundle");
      const readyFile = join(inboxPath, "READY");
      if (!existsSync(readyFile)) {
        atomicWriteFileSync(readyFile, "");
      } else {
        assertRegularFile(readyFile, "Worker READY marker");
      }
    } else {
      // Move from failed/done back to inbox
      const failedPath = join(getFailedDir(scratchDir), jobId);
      const donePath = join(getDoneDir(scratchDir), jobId);

      let sourcePath = "";
      if (existsSync(failedPath)) sourcePath = failedPath;
      else if (existsSync(donePath)) sourcePath = donePath;

      if (sourcePath) {
        assertRealDirectory(inboxDir, "Worker inbox directory");
        assertRealDirectory(sourcePath, "Worker retry source");
        if (existsSync(inboxPath))
          throw new Error(`Inbox destination already exists: ${inboxPath}`);
        renameSync(sourcePath, inboxPath);
        atomicWriteFileSync(join(inboxPath, "READY"), "");
      } else {
        return {
          ok: false,
          decision: "retry-same-command-once",
          message: `No failed/done bundle found for job ${jobId}`,
        };
      }
    }

    appendWorkerEvent(join(scratchDir, "daemon"), "worker.job.claimed", {
      jobId,
      message: "same command re-staged by worker agent (retry-same-command-once)",
    });

    return {
      ok: true,
      decision: "retry-same-command-once",
      message: `Same command re-staged for job ${jobId}`,
    };
  } catch (err) {
    return {
      ok: false,
      decision: "retry-same-command-once",
      message: `Failed to re-stage command: ${(err as Error).message}`,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────

/**
 * Find a bundle directory across running/, failed/, done/, orphaned/.
 */
function findBundlePath(scratchDir: string, jobId: string): string | null {
  if (!SAFE_ID.test(jobId)) return null;
  const candidates = [
    join(getRunningDir(scratchDir), jobId),
    join(getFailedDir(scratchDir), jobId),
    join(getDoneDir(scratchDir), jobId),
    join(getOrphanedDir(scratchDir), jobId),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        assertRealDirectory(candidate, "Worker bundle");
        return candidate;
      } catch {
        return null;
      }
    }
  }

  return null;
}
