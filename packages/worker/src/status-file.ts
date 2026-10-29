import { closeSync, constants, existsSync, lstatSync, openSync, readFileSync } from "fs";
import { join } from "path";
import type { WorkerJobState, WorkerJobStatusFile } from "./types";
import { appendWorkerEvent } from "./events";
import { atomicWriteFileSync } from "./persistence";

// ────────────────────────────────────────────────────────────
// Status → Event Type Mapping
// ────────────────────────────────────────────────────────────

const stateEventMap: Record<WorkerJobState, string | null> = {
  enqueued: null,
  claimed: "worker.job.claimed",
  staged: null,
  running: "worker.process.started",
  completed: "worker.job.completed",
  failed: "worker.job.failed",
  cancelled: "worker.job.cancelled",
  orphaned: "worker.job.orphaned",
};

function stateToEventType(state: WorkerJobState): string | null {
  return stateEventMap[state] ?? null;
}

// ────────────────────────────────────────────────────────────
// Status File (status.json)
// ────────────────────────────────────────────────────────────

export function writeStatusFile(
  bundleDir: string,
  status: Omit<WorkerJobStatusFile, "updatedAt">,
): void {
  const bundleInfo = lstatSync(bundleDir);
  if (bundleInfo.isSymbolicLink() || !bundleInfo.isDirectory()) {
    throw new Error(`Worker bundle is not a real directory: ${bundleDir}`);
  }
  const full: WorkerJobStatusFile = {
    ...status,
    updatedAt: Date.now(),
  };

  const statusPath = join(bundleDir, "status.json");
  atomicWriteFileSync(statusPath, JSON.stringify(full, null, 2));

  // Also append a worker event for this state change
  const eventType = stateToEventType(status.state);
  if (eventType) {
    appendWorkerEvent(bundleDir, eventType as any, {
      jobId: status.jobId,
      attemptId: status.attemptId,
      pid: status.pid,
      exitCode: status.exitCode,
      message: status.message,
    });
  }
}

export function readStatusFile(bundleDir: string): WorkerJobStatusFile | null {
  const statusPath = join(bundleDir, "status.json");

  if (!existsSync(statusPath)) {
    return null;
  }

  let fd: number | undefined;
  let content: string;
  try {
    const info = lstatSync(statusPath);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    fd = openSync(statusPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    content = readFileSync(fd, "utf-8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return JSON.parse(content) as WorkerJobStatusFile;
}
