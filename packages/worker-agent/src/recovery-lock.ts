import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "fs";
import { dirname } from "path";
import { join } from "path";
import { getLocksDir } from "@eigengrid/worker";

const LOCK_FILE = "worker-agent-recovery.lock";

interface RecoveryLockMetadata {
  token: string;
  pid: number;
  nodeId: string;
  acquiredAt: number;
}

export type RecoveryLockResult =
  | { kind: "acquired"; release: () => void }
  | { kind: "contended" }
  | { kind: "error" };

export function acquireRecoveryLock(scratchDir: string, nodeId: string): RecoveryLockResult {
  const path = join(getLocksDir(scratchDir), LOCK_FILE);
  const metadata: RecoveryLockMetadata = {
    token: crypto.randomUUID(),
    pid: process.pid,
    nodeId,
    acquiredAt: Date.now(),
  };
  let fd: number | undefined;
  try {
    mkdirSync(getLocksDir(scratchDir), { recursive: true });
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const bytes = Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
      if (written <= 0) throw new Error("recovery lock write made no progress");
      offset += written;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const directory = openSync(
      dirname(path),
      constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0),
    );
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    return { kind: "acquired", release: () => release(path, metadata.token) };
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
        rmSync(path);
      } catch {
        /* leave ambiguous ownership in place */
      }
    }
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return { kind: "error" };
    return validMetadata(path) ? { kind: "contended" } : { kind: "error" };
  }
}

function validMetadata(path: string): boolean {
  try {
    const metadata = JSON.parse(readFileSync(path, "utf-8"));
    return (
      typeof metadata.token === "string" &&
      metadata.token.length > 0 &&
      typeof metadata.pid === "number" &&
      typeof metadata.nodeId === "string" &&
      typeof metadata.acquiredAt === "number"
    );
  } catch {
    return false;
  }
}

function release(path: string, token: string): void {
  try {
    const metadata = JSON.parse(readFileSync(path, "utf-8"));
    if (metadata?.token === token) {
      rmSync(path);
      const directory = openSync(
        dirname(path),
        constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0),
      );
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  } catch {
    // Leave malformed, unreadable, or changed ownership for operator inspection.
  }
}
