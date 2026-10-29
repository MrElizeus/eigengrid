import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

/** Reject symlinked path components before recursive creation or publication. */
function assertNoSymlinkComponents(path: string): void {
  let current = resolve(path);
  for (;;) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Runner path contains a symlink: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Ensure a runner-owned directory is real, private, and not a symlink. */
export function ensurePrivateRunnerDirectory(path: string): void {
  assertNoSymlinkComponents(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Runner directory is not a real directory: ${path}`);
  }
  chmodSync(path, 0o700);
}

/** Reject symlink/non-regular file targets before a runner writes or pulls. */
export function assertRegularRunnerFile(path: string, label: string): void {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`${label} is not a regular file: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Atomic private-file publication with O_NOFOLLOW and parent-directory fsync. */
export function atomicWriteRunnerFile(path: string, content: string): void {
  assertNoSymlinkComponents(dirname(path));
  assertRegularRunnerFile(path, "Runner file target");
  const parent = dirname(path);
  const temporary = `.${path.slice(path.lastIndexOf("/") + 1)}.${process.pid}.${randomUUID()}.tmp`;
  const temporaryPath = `${parent}/${temporary}`;
  const descriptor = openSync(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const bytes = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("runner file write made no progress");
      offset += written;
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporaryPath, path);
    fsyncDirectory(parent);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Preserve the publication error; the orphaned private temp is harmless
      // and remains distinguishable for maintenance cleanup.
    }
    throw error;
  }
}

/**
 * Publish a file produced by an external copier (for example `scp`) without
 * opening or truncating the final path. The source must be a regular file in
 * a runner-private directory; rename replaces a concurrently-created target
 * atomically and never follows a target symlink.
 */
export function atomicPromoteRunnerFile(source: string, target: string): void {
  assertNoSymlinkComponents(dirname(source));
  assertNoSymlinkComponents(dirname(target));
  assertRegularRunnerFile(source, "Runner temporary file");
  assertRegularRunnerFile(target, "Runner file target");
  const parent = dirname(target);
  renameSync(source, target);
  fsyncDirectory(parent);
}

/** Copy a source file through no-follow descriptors and publish atomically. */
export function atomicCopyRunnerFile(source: string, target: string): void {
  assertNoSymlinkComponents(dirname(source));
  assertNoSymlinkComponents(dirname(target));
  const sourceFd = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let temporaryFd: number | undefined;
  const parent = dirname(target);
  const temporary = `${parent}/.${target.slice(target.lastIndexOf("/") + 1)}.${process.pid}.${randomUUID()}.copy`;
  try {
    const sourceInfo = fstatSync(sourceFd);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
      throw new Error(`Runner copy source is not a regular file: ${source}`);
    }
    assertRegularRunnerFile(target, "Runner file target");
    temporaryFd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const count = readSync(sourceFd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      let offset = 0;
      while (offset < count) {
        const written = writeSync(temporaryFd, buffer, offset, count - offset);
        if (written <= 0) throw new Error("runner copy write made no progress");
        offset += written;
      }
    }
    fsyncSync(temporaryFd);
    closeSync(temporaryFd);
    temporaryFd = undefined;
    renameSync(temporary, target);
    fsyncDirectory(parent);
  } finally {
    closeSync(sourceFd);
    if (temporaryFd !== undefined) closeSync(temporaryFd);
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the primary copy/publication failure.
    }
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
