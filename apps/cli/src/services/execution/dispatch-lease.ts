import { ensurePrivateRunnerDirectory } from "@eigengrid/runners";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type DispatchLease = { path: string; token: string };

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("dispatch lease write made no progress");
    offset += written;
  }
}

/**
 * Cross-process fence for remote dispatch. A same-job dispatch must not race
 * two stage/start sequences before either one has created a durable attempt.
 * Live owners cause a safe retry outcome; dead owners may be reclaimed, but
 * only after their PID is no longer alive and the replacement is token-fenced.
 */
export function acquireDispatchLease(jobDir: string): DispatchLease | null {
  ensurePrivateRunnerDirectory(jobDir);
  const path = join(jobDir, ".dispatch.lock");

  for (;;) {
    const token = randomUUID();
    try {
      const descriptor = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        writeAll(descriptor, Buffer.from(JSON.stringify({ pid: process.pid, token }) + "\n"));
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      fsyncDirectory(jobDir);
      return { path, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid?: number; token?: string };
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error(`Execution dispatch lock is not a regular file: ${path}`);
        }
        owner = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; token?: string };
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error(
          `Execution dispatch lock is unreadable; refusing concurrent dispatch: ${readError instanceof Error ? readError.message : String(readError)}`,
        );
      }
      if (owner.pid !== undefined && processIsAlive(owner.pid)) return null;
      try {
        unlinkSync(path);
        fsyncDirectory(jobDir);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
    }
  }
}

export function releaseDispatchLease(lease: DispatchLease): void {
  try {
    const stat = lstatSync(lease.path);
    if (stat.isSymbolicLink() || !stat.isFile()) return;
    const owner = JSON.parse(readFileSync(lease.path, "utf8")) as { token?: string };
    if (owner.token !== lease.token) return;
    unlinkSync(lease.path);
    fsyncDirectory(dirname(lease.path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Releasing a lease cannot safely turn a completed/ambiguous dispatch
      // into a different outcome. Leave the lock for reconciliation instead.
    }
  }
}
