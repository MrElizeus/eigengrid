import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "fs";
import { dirname, join } from "path";
import { appendWorkerEvent, readWorkerEventsWithIntegrity } from "./events";
import { executeBundle, type SpawnAdapter } from "./executor";
import { getDaemonDir, getDoneDir, getFailedDir, getOrphanedDir, getRunningDir } from "./layout";
import { claimJob, detectOrphaned, listReadyJobs } from "./queue";
import { writeStatusFile } from "./status-file";
import { atomicWriteFileSync } from "./persistence";
import type { WorkerHeartbeatReporter } from "./heartbeat";

// ────────────────────────────────────────────────────────────
// Worker Daemon — Long-lived Poll Loop
// ────────────────────────────────────────────────────────────

export interface DaemonConfig {
  scratchDir: string;
  pollIntervalMs: number;
  maxConcurrent: number;
  recoveryHandler?: (scratchDir: string) => Promise<void>;
  spawnAdapter?: SpawnAdapter;
  /** Optional Head-bound liveness reporter; absent in standalone test mode. */
  heartbeatReporter?: Pick<WorkerHeartbeatReporter, "start" | "stop">;
}

export interface DaemonState {
  running: boolean;
  startedAt: number;
  processedCount: number;
  activeCount: number;
}

export interface StopController {
  promise: Promise<void>;
  stop: () => void;
}

export function createStopController(): StopController {
  let stop: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    stop = resolve;
  });
  return { promise, stop };
}

// ── Daemon PID Management ─────────────────────────────────

const DAEMON_PID_FILE = "daemon.pid";
const DAEMON_LOCK_FILE = "daemon.lock";

function ensureRealDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Worker daemon path is not a real directory: ${path}`);
  }
}

type DaemonLease = { path: string; token: string; fd: number };

function acquireDaemonLease(daemonDir: string): DaemonLease {
  const path = join(daemonDir, DAEMON_LOCK_FILE);
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
      const bytes = Buffer.from(`${token}\n`, "utf8");
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
        if (written <= 0) throw new Error("worker daemon lease write made no progress");
        offset += written;
      }
      fsyncSync(fd);
      return { path, token, fd };
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      let owner: string;
      try {
        owner = readFileSync(path, "utf8").trim();
      } catch {
        throw new Error("worker daemon lease is malformed; refusing to bypass it");
      }
      const pid = Number(owner.split(":", 1)[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error("worker daemon lease has invalid ownership metadata");
      }
      try {
        process.kill(pid, 0);
        throw new Error(`worker daemon is already running with pid ${pid}`);
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== "ESRCH") throw probeError;
        rmSync(path, { force: true });
        continue;
      }
    }
  }
}

function releaseDaemonLease(lease: DaemonLease): void {
  try {
    if (readFileSync(lease.path, "utf8").trim() === lease.token) {
      rmSync(lease.path, { force: true });
      const directory = openSync(
        dirname(lease.path),
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
      );
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  } finally {
    closeSync(lease.fd);
  }
}

function writeDaemonPid(daemonDir: string): void {
  atomicWriteFileSync(join(daemonDir, DAEMON_PID_FILE), `${process.pid}\n`);
}

function removeDaemonPid(daemonDir: string): void {
  try {
    rmSync(join(daemonDir, DAEMON_PID_FILE), { force: true });
  } catch {
    // best-effort
  }
}

function isDaemonAlive(daemonDir: string): boolean {
  const pidPath = join(daemonDir, DAEMON_PID_FILE);
  if (!existsSync(pidPath)) return false;

  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    if (isNaN(pid)) return false;
    // On Unix: kill(pid, 0) checks existence without sending signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the worker daemon loop.
 * Polls inbox, claims ready jobs, executes them, moves to done/failed.
 * Supports graceful shutdown: drains active jobs before exit.
 */
export async function runDaemon(
  config: DaemonConfig,
  stopSignal?: StopController,
): Promise<DaemonState> {
  const daemonDir = getDaemonDir(config.scratchDir);
  if (!existsSync(daemonDir)) {
    throw new Error(
      `Worker scratch layout not initialized: ${config.scratchDir}. Run 'eigengrid worker daemon --init' first.`,
    );
  }
  ensureRealDirectory(daemonDir);

  const lease = acquireDaemonLease(daemonDir);

  const state: DaemonState = {
    running: true,
    startedAt: Date.now(),
    processedCount: 0,
    activeCount: 0,
  };

  const ownStop = stopSignal ?? createStopController();
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  // Track active execution promises for graceful drain
  const activeExecutions: Promise<void>[] = [];

  // Write PID file only after the exclusive daemon lease is held.
  try {
    writeDaemonPid(daemonDir);
  } catch (error) {
    releaseDaemonLease(lease);
    throw error;
  }

  if (config.heartbeatReporter) {
    try {
      await config.heartbeatReporter.start();
    } catch (error) {
      removeDaemonPid(daemonDir);
      releaseDaemonLease(lease);
      throw new Error(`worker heartbeat could not start: ${(error as Error).message}`);
    }
  }

  // Write daemon started event
  try {
    appendWorkerEvent(daemonDir, "worker.daemon.started", {
      message: `daemon started; pid=${process.pid}, poll=${config.pollIntervalMs}ms, max=${config.maxConcurrent}`,
    });
  } catch (error) {
    removeDaemonPid(daemonDir);
    releaseDaemonLease(lease);
    throw error;
  }

  const poll = async () => {
    if (!state.running) return;

    try {
      // Detect orphans and move them from running/ to orphaned/
      const orphans = detectOrphaned(config.scratchDir);
      for (const orphan of orphans) {
        writeStatusFile(orphan.bundlePath, {
          schemaVersion: 1,
          jobId: orphan.jobId,
          attemptId: "",
          state: "orphaned",
          command: "",
          message: `orphaned (last updated ${new Date(orphan.status.updatedAt).toISOString()})`,
        });

        // Move orphan from running/ to orphaned/ so it doesn't consume a slot
        try {
          const targetPath = join(getOrphanedDir(config.scratchDir), orphan.jobId);
          ensureRealDirectory(getOrphanedDir(config.scratchDir));
          if (existsSync(targetPath))
            throw new Error(`orphan destination already exists: ${targetPath}`);
          renameSync(orphan.bundlePath, targetPath);
        } catch (error) {
          appendWorkerEvent(daemonDir, "worker.error", {
            message: `failed to move orphan ${orphan.jobId}: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      // Count running jobs (only bundles physically in running/)
      const runningDir = getRunningDir(config.scratchDir);
      let runningCount = 0;
      if (existsSync(runningDir)) {
        runningCount = readdirSync(runningDir, { withFileTypes: true }).filter((e) =>
          e.isDirectory(),
        ).length;
      }
      state.activeCount = runningCount;

      // Recovery agent: evaluate and execute safe recovery actions
      if (config.recoveryHandler) {
        try {
          await config.recoveryHandler(config.scratchDir);
        } catch {
          // best-effort — recovery failure should not crash the daemon
        }
      }

      // Claim and execute up to maxConcurrent
      const slotsAvailable = config.maxConcurrent - runningCount;
      if (slotsAvailable > 0) {
        const readyJobs = listReadyJobs(config.scratchDir);
        const toClaim = readyJobs.slice(0, slotsAvailable);

        for (const ready of toClaim) {
          const claim = claimJob(config.scratchDir, ready.jobId);
          if (!claim.ok || !claim.runningPath) continue;

          const runningPath: string = claim.runningPath;
          const jobId: string = ready.jobId;
          state.activeCount++;

          // Execute and track the promise for graceful drain
          const execPromise = executeBundle(runningPath, undefined, config.spawnAdapter)
            .then((result) => {
              state.processedCount++;
              state.activeCount--;

              // Move to done or failed
              const targetDir = result.ok
                ? getDoneDir(config.scratchDir)
                : getFailedDir(config.scratchDir);

              try {
                ensureRealDirectory(targetDir);
                const destination = join(targetDir, jobId);
                if (!existsSync(destination)) {
                  renameSync(runningPath, destination);
                } else {
                  throw new Error(`terminal destination already exists: ${destination}`);
                }
              } catch (error) {
                appendWorkerEvent(daemonDir, "worker.error", {
                  message: `failed to publish ${jobId} terminal bundle: ${error instanceof Error ? error.message : String(error)}`,
                });
              }
            })
            .catch((error) => {
              state.activeCount--;
              appendWorkerEvent(daemonDir, "worker.error", {
                message: `worker execution failed for ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
              });
            })
            .finally(() => {
              // Remove from active executions list
              const idx = activeExecutions.indexOf(execPromise);
              if (idx >= 0) activeExecutions.splice(idx, 1);
            });

          activeExecutions.push(execPromise);
        }
      }
    } catch (err) {
      appendWorkerEvent(daemonDir, "worker.error", {
        message: `poll error: ${(err as Error).message}`,
      });
    }

    // Schedule next poll
    if (state.running) {
      pollTimer = setTimeout(poll, config.pollIntervalMs);
    }
  };

  // Start first poll
  poll();

  // Wait for stop signal
  await ownStop.promise;
  state.running = false;

  // Clear pending timer (no new polls)
  if (pollTimer) clearTimeout(pollTimer);

  // Graceful drain: wait for all active executions to complete
  if (activeExecutions.length > 0) {
    await Promise.allSettled(activeExecutions);
  }

  // Clean up PID file
  removeDaemonPid(daemonDir);

  if (config.heartbeatReporter) {
    try {
      await config.heartbeatReporter.stop();
    } catch (error) {
      appendWorkerEvent(daemonDir, "worker.error", {
        message: `heartbeat shutdown error: ${(error as Error).message}`,
      });
    }
  }

  // Write daemon stopped event
  try {
    appendWorkerEvent(daemonDir, "worker.daemon.stopped", {
      message: `daemon stopped after processing ${state.processedCount} jobs`,
    });
  } finally {
    releaseDaemonLease(lease);
  }

  return state;
}

// ────────────────────────────────────────────────────────────
// Once Mode — process one ready job and exit
// ────────────────────────────────────────────────────────────

export async function runOnce(
  scratchDir: string,
  spawnAdapter?: SpawnAdapter,
): Promise<{ ok: boolean; processed: number }> {
  const readyJobs = listReadyJobs(scratchDir);

  if (readyJobs.length === 0) {
    return { ok: true, processed: 0 };
  }

  const ready = readyJobs[0];
  const claim = claimJob(scratchDir, ready.jobId);
  if (!claim.ok || !claim.runningPath) {
    return { ok: false, processed: 0 };
  }

  const result = await executeBundle(claim.runningPath, undefined, spawnAdapter);

  // Move to done or failed
  const targetDir = result.ok ? getDoneDir(scratchDir) : getFailedDir(scratchDir);

  if (existsSync(targetDir)) {
    try {
      ensureRealDirectory(targetDir);
      const destination = join(targetDir, ready.jobId);
      if (existsSync(destination))
        throw new Error(`terminal destination already exists: ${destination}`);
      renameSync(claim.runningPath, destination);
    } catch (error) {
      appendWorkerEvent(getDaemonDir(scratchDir), "worker.error", {
        message: `failed to publish one-shot terminal bundle ${ready.jobId}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return { ok: result.ok, processed: 1 };
}

// ────────────────────────────────────────────────────────────
// Daemon Status
// ────────────────────────────────────────────────────────────

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  startedAt?: number;
  processedCount?: number;
  activeJobs: number;
  daemonDir: string;
}

export function getDaemonStatus(scratchDir: string): DaemonStatus {
  const daemonDir = getDaemonDir(scratchDir);
  let pid: number | undefined;
  let startedAt: number | undefined;

  // Check daemon PID file
  const pidPath = join(daemonDir, DAEMON_PID_FILE);
  if (existsSync(pidPath)) {
    try {
      pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      if (isNaN(pid)) pid = undefined;
    } catch {
      pid = undefined;
    }
  }

  const running = pid !== undefined && isDaemonAlive(daemonDir);

  // Read daemon events.jsonl for startedAt timestamp
  if (running) {
    for (const evt of readWorkerEventsWithIntegrity(daemonDir).records) {
      if (evt.type === "worker.daemon.started") {
        startedAt = evt.at;
      }
    }
  }

  const activeJobs = (() => {
    const runningDir = getRunningDir(scratchDir);
    if (!existsSync(runningDir)) return 0;
    return readdirSync(runningDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  })();

  return {
    running,
    pid,
    startedAt,
    activeJobs,
    daemonDir,
  };
}
