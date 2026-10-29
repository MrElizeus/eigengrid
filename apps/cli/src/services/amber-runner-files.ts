import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { LogicalPathSchema } from "@eigengrid/amber-adapter";
import { ContentAddressedArtifactStore } from "@eigengrid/mission-runtime";
import type { AmberBundleReference } from "./amber-stage-bundle";

export function descriptorPath(directory: FileHandle): string {
  return `/proc/self/fd/${directory.fd}`;
}

/** Open directory capabilities, never traverse a caller-created symlink. These
 * directories are per-UID private; all child lookups stay anchored after rename.
 */
export async function openPrivateDirectory(path: string, uid: number): Promise<FileHandle> {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700)
      throw new Error("Amber scratch directory must be private to its scientific UID");
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function openAmberScratchRoot(path: string, uid: number): Promise<FileHandle> {
  if (!isAbsolute(path) || resolve(path) !== path || (await realpath(path)) !== path)
    throw new Error("Amber scratch root must be canonical and symlink-free");
  let parent = await open("/", constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const part of path.split("/").filter(Boolean)) {
      const child = await open(
        `${descriptorPath(parent)}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await parent.close();
      parent = child;
      const info = await parent.stat();
      const rootSticky = info.uid === 0 && (info.mode & 0o1000) !== 0;
      if (
        (info.uid !== 0 && info.uid !== uid) ||
        (!rootSticky &&
          ((info.mode & 0o002) !== 0 ||
            ((info.mode & 0o020) !== 0 && (info.uid !== uid || info.gid !== process.getgid?.()))))
      )
        throw new Error("Amber scratch ancestry is writable by another identity");
    }
    const final = await parent.stat();
    if (final.uid !== uid || (final.mode & 0o777) !== 0o700)
      throw new Error("Amber scratch directory must be private to its scientific UID");
    return parent;
  } catch (error) {
    await parent.close();
    throw error;
  }
}

export async function privateChild(
  parent: FileHandle,
  name: string,
  uid: number,
  exclusive = false,
): Promise<FileHandle> {
  if (!/^(?:[A-Za-z0-9][A-Za-z0-9._-]*|\.eigengrid)$/u.test(name))
    throw new Error("Invalid private directory component");
  const path = `${descriptorPath(parent)}/${name}`;
  try {
    await mkdir(path, { mode: 0o700 });
    await parent.sync();
  } catch (error) {
    if (exclusive || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return openPrivateDirectory(path, uid);
}

export async function logicalParent(root: FileHandle, path: string, uid: number, create: boolean) {
  const parts = LogicalPathSchema.parse(path).split("/");
  const name = parts.pop()!;
  let parent = await openPrivateDirectory(descriptorPath(root) + "/.", uid);
  try {
    for (const part of parts) {
      const next = create
        ? await privateChild(parent, part, uid)
        : await openPrivateDirectory(`${descriptorPath(parent)}/${part}`, uid);
      await parent.close();
      parent = next;
    }
    return { parent, path: `${descriptorPath(parent)}/${name}` };
  } catch (error) {
    await parent.close();
    throw error;
  }
}

/** Streams are rehashed while consumed, even if their source preverified them. */
export async function stageAmberInput(
  store: ContentAddressedArtifactStore,
  reference: AmberBundleReference,
  workspace: FileHandle,
  logicalPath: string,
  uid: number,
): Promise<void> {
  const target = await logicalParent(workspace, logicalPath, uid, true);
  try {
    const file = await open(
      target.path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o400,
    );
    try {
      const stream = await store.getStream(reference.sha256);
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of stream.bytes) {
        size += chunk.length;
        if (stream.sizeBytes !== reference.sizeBytes || size > reference.sizeBytes)
          throw new Error("Staged Amber input exceeds its exact size");
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
          if (!bytesWritten) throw new Error("Short Amber staging write");
          offset += bytesWritten;
        }
      }
      if (size !== reference.sizeBytes || hash.digest("hex") !== reference.sha256)
        throw new Error("Staged Amber input differs from its exact hash");
      await file.sync();
      await target.parent.sync();
    } finally {
      await file.close();
    }
  } finally {
    await target.parent.close();
  }
}

export async function openAmberFile(
  root: FileHandle,
  logicalPath: string,
  uid: number,
): Promise<FileHandle> {
  const target = await logicalParent(root, logicalPath, uid, false);
  try {
    const file = await open(
      target.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o022) !== 0)
        throw new Error("Unsafe Amber scratch artifact");
      return file;
    } catch (error) {
      await file.close();
      throw error;
    }
  } finally {
    await target.parent.close();
  }
}

export async function* stableAmberFile(
  file: FileHandle,
  maxBytes: number,
): AsyncGenerator<Uint8Array> {
  const before = await file.stat();
  if (before.size > maxBytes) throw new Error("Amber artifact exceeds the scratch/transfer bound");
  const buffer = Buffer.alloc(1024 * 1024);
  let offset = 0;
  while (offset < before.size) {
    const { bytesRead } = await file.read(
      buffer,
      0,
      Math.min(buffer.length, before.size - offset),
      offset,
    );
    if (!bytesRead) throw new Error("Amber artifact truncated during collection");
    offset += bytesRead;
    yield Buffer.from(buffer.subarray(0, bytesRead));
  }
  const after = await file.stat();
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new Error("Amber artifact changed during collection");
}

export async function writeAmberMetadata(
  directory: FileHandle,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  if (!/^[a-z][a-z0-9.-]*$/u.test(name) || bytes.length > 1024 * 1024)
    throw new Error("Invalid bounded runner metadata");
  const temporary = `${descriptorPath(directory)}/${name}.tmp.${randomUUID()}`;
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o400,
  );
  try {
    await file.writeFile(bytes);
    await file.sync();
    await link(temporary, `${descriptorPath(directory)}/${name}`); // atomic, no replacement
    await unlink(temporary);
    await directory.sync();
  } finally {
    await file.close();
  }
}
