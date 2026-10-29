import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import { getFailedDir, getInboxDir, getRunningDir, getLocksDir } from "./layout";
import { readStatusFile, writeStatusFile } from "./status-file";
import { parseManifest } from "./manifest";
import { resolveRecipeCommand } from "./executor";

// ────────────────────────────────────────────────────────────
// Queue Scanner — Inbox Polling
// ────────────────────────────────────────────────────────────

export interface ReadyJob {
  jobId: string;
  bundlePath: string;
}

function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0));
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!(code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP")) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function ensureRealDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Worker queue path is not a real directory: ${path}`);
  }
}

function isRegularFile(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Reclaim a stale lock only after proving its recorded owner is gone. */
function staleLockOwnerIsDead(path: string): boolean {
  let owner: string;
  try {
    owner = readFileSync(path, "utf8").trim();
  } catch {
    return false;
  }
  const pidText = owner.split(":", 1)[0] ?? "";
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * List all ready bundles in the inbox directory.
 * A bundle is "ready" when:
 *   1. It's a directory (not a .tmp file)
 *   2. It contains a READY marker file
 *   3. It contains a manifest.json
 */
export function listReadyJobs(scratchDir: string): ReadyJob[] {
  const inboxDir = getInboxDir(scratchDir);

  try {
    const info = lstatSync(inboxDir);
    if (info.isSymbolicLink() || !info.isDirectory()) return [];
  } catch {
    return [];
  }

  const entries = readdirSync(inboxDir, { withFileTypes: true });
  const ready: ReadyJob[] = [];

  for (const entry of entries) {
    // Skip .tmp directories (still being staged)
    if (entry.name.endsWith(".tmp")) continue;

    if (!entry.isDirectory()) continue;
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(entry.name)) continue;

    const bundlePath = join(inboxDir, entry.name);
    const readyFile = join(bundlePath, "READY");
    if (isRegularFile(readyFile)) {
      ready.push({ jobId: entry.name, bundlePath });
    }
  }

  return ready;
}

// ────────────────────────────────────────────────────────────
// Atomic Claim
// ────────────────────────────────────────────────────────────

export interface ClaimResult {
  ok: boolean;
  runningPath?: string;
  error?: string;
}

/**
 * Atomically claim a job bundle by moving it from inbox/ to running/.
 * Uses a lock file to prevent race conditions.
 */
export function claimJob(scratchDir: string, jobId: string, _lockTimeoutMs = 5000): ClaimResult {
  if (
    !jobId ||
    jobId.endsWith(".tmp") ||
    jobId === "." ||
    jobId === ".." ||
    /[\\/\p{Cc}]/u.test(jobId)
  ) {
    return { ok: false, error: `unsafe job id ${jobId}` };
  }
  const inboxPath = join(getInboxDir(scratchDir), jobId);
  const runningPath = join(getRunningDir(scratchDir), jobId);
  const lockPath = join(getLocksDir(scratchDir), `${jobId}.lock`);

  // Ensure lock directory exists
  ensureRealDirectory(getLocksDir(scratchDir));

  // Acquire lock. A crashed claimant must not permanently strand a bundle;
  // the bounded stale-lock policy is only a recovery aid and never grants a
  // second owner while a fresh lock exists.
  let lockFd: number | undefined;
  const lockToken = randomUUID();
  try {
    lockFd = openSync(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const pid = Buffer.from(`${process.pid}:${lockToken}\n`);
    writeSync(lockFd, pid, 0, pid.length);
    fsyncSync(lockFd);
  } catch (error) {
    if (lockFd !== undefined) {
      closeSync(lockFd);
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // Preserve the acquisition failure.
      }
    }
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      try {
        const age = Date.now() - lstatSync(lockPath).mtimeMs;
        if (age > _lockTimeoutMs && staleLockOwnerIsDead(lockPath)) {
          rmSync(lockPath, { force: true });
          return claimJob(scratchDir, jobId, _lockTimeoutMs);
        }
      } catch {
        // A disappearing lock is simply contention; fail closed below.
      }
    }
    return { ok: false, error: `cannot acquire lock for ${jobId}` };
  }

  try {
    // Validate bundle exists and is ready
    if (!existsSync(inboxPath)) {
      return { ok: false, error: `bundle ${jobId} not found in inbox` };
    }
    try {
      if (lstatSync(inboxPath).isSymbolicLink() || !lstatSync(inboxPath).isDirectory()) {
        return { ok: false, error: `bundle ${jobId} is not a real directory` };
      }
    } catch {
      return { ok: false, error: `bundle ${jobId} is not readable` };
    }

    const readyFile = join(inboxPath, "READY");
    if (!isRegularFile(readyFile)) {
      return { ok: false, error: `bundle ${jobId} not ready (no READY marker)` };
    }

    const quarantine = (message: string): ClaimResult => {
      writeStatusFile(inboxPath, {
        schemaVersion: 1,
        jobId,
        attemptId: "",
        state: "failed",
        command: "",
        finishedAt: Date.now(),
        message,
      });
      const failedDir = getFailedDir(scratchDir);
      ensureRealDirectory(failedDir);
      let destination = join(failedDir, jobId);
      let suffix = 1;
      while (existsSync(destination)) destination = join(failedDir, `${jobId}.invalid-${suffix++}`);
      renameSync(inboxPath, destination);
      syncDirectory(getInboxDir(scratchDir));
      syncDirectory(failedDir);
      return { ok: false, error: message };
    };

    const manifestPath = join(inboxPath, "manifest.json");
    if (!isRegularFile(manifestPath)) {
      return quarantine(`bundle ${jobId} has no manifest.json`);
    }

    let manifestRaw: unknown;
    try {
      manifestRaw = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch (error) {
      return quarantine(`bundle ${jobId} manifest invalid: ${(error as Error).message}`);
    }
    let attemptId = "";
    const parsed = parseManifest(manifestRaw);
    if (!parsed.ok || parsed.manifest.jobId !== jobId) {
      return quarantine(
        `bundle ${jobId} manifest invalid: ${parsed.ok ? "jobId mismatch" : parsed.errors.map((error) => error.message).join("; ")}`,
      );
    }
    try {
      resolveRecipeCommand(parsed.manifest, join(runningPath, "work"));
    } catch (error) {
      return quarantine(`bundle ${jobId} manifest invalid: ${(error as Error).message}`);
    }
    attemptId = parsed.manifest.attemptId;

    // Ensure running directory exists
    ensureRealDirectory(getRunningDir(scratchDir));
    if (existsSync(runningPath)) {
      return {
        ok: false,
        error: `running destination already exists for ${jobId}; refusing replacement`,
      };
    }

    // Atomic rename from inbox/ to running/
    try {
      renameSync(inboxPath, runningPath);
      syncDirectory(getInboxDir(scratchDir));
      syncDirectory(getRunningDir(scratchDir));
    } catch (err) {
      return {
        ok: false,
        error: `failed to move ${jobId} to running: ${(err as Error).message}`,
      };
    }

    // Write claimed status
    writeStatusFile(runningPath, {
      schemaVersion: 1,
      jobId,
      attemptId,
      state: "claimed",
      command: "",
      startedAt: Date.now(),
    });

    return { ok: true, runningPath };
  } finally {
    // Release lock
    try {
      // Fence stale/replaced owners: a delayed claimant must not remove a
      // newer owner's lock after its own lease was reclaimed.
      const owner = readFileSync(lockPath, "utf8").trim();
      if (owner.endsWith(`:${lockToken}`)) rmSync(lockPath, { force: true });
    } catch {
      // Best-effort lock cleanup
    }
    if (lockFd !== undefined) closeSync(lockFd);
  }
}

// ────────────────────────────────────────────────────────────
// Orphan Detection
// ────────────────────────────────────────────────────────────

export interface OrphanedJob {
  jobId: string;
  bundlePath: string;
  status: { state: string; updatedAt: number };
}

/**
 * Detect stale running bundles (daemon crashed, no PID alive).
 */
export function detectOrphaned(scratchDir: string, staleThresholdMs = 60000): OrphanedJob[] {
  const runningDir = getRunningDir(scratchDir);

  try {
    const info = lstatSync(runningDir);
    if (info.isSymbolicLink() || !info.isDirectory()) return [];
  } catch {
    return [];
  }

  const entries = readdirSync(runningDir, { withFileTypes: true });
  const orphans: OrphanedJob[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const bundlePath = join(runningDir, entry.name);
    const status = readStatusFile(bundlePath);

    if (!status) continue;

    // A daemon can crash after atomically claiming a bundle but before the
    // child process has been spawned. Treat both claimed and running states as
    // recoverable leases once their freshness window expires.
    if ((status.state === "running" || status.state === "claimed") && status.pid) {
      // Check if PID is still alive
      try {
        // On Linux: kill(pid, 0) checks existence without sending signal
        process.kill(status.pid, 0);
        // PID is alive — not orphaned
        continue;
      } catch {
        // PID not alive — orphaned
      }
    } else if ((status.state === "running" || status.state === "claimed") && !status.pid) {
      // No PID and state is claimed/running — likely orphaned
    } else {
      // Not in running state — skip
      continue;
    }

    // Check staleness threshold
    const elapsed = Date.now() - status.updatedAt;
    if (elapsed < staleThresholdMs) continue;

    orphans.push({
      jobId: entry.name,
      bundlePath,
      status: { state: status.state ?? "running", updatedAt: status.updatedAt },
    });
  }

  return orphans;
}
