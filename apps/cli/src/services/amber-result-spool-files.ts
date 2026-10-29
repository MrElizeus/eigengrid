import { constants, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { canonicalJson } from "@eigengrid/scientific-schema";
import { descriptorPath, stableAmberFile } from "./amber-runner-files";

/** Identity-only seam for local tests. Production always uses kernel credentials
 * and descriptor fstat; this is not a configurable site authentication bypass. */
export interface AmberResultSpoolFileIO {
  uid(): number;
  gid(): number;
  groups(): number[];
  stat(file: FileHandle, path: string): Promise<Stats>;
  chown(file: FileHandle, uid: number, gid: number): Promise<void>;
}
export const amberResultSpoolFileIO: AmberResultSpoolFileIO = {
  uid: () => process.getuid!(),
  gid: () => process.getgid!(),
  groups: () => process.getgroups!(),
  stat: (file) => file.stat(),
  chown: (file, uid, gid) => file.chown(uid, gid),
};
export const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
export const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
export function errno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}
export function sameFile(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

/** Walk every component from an anchored descriptor; symlinked ancestors and
 * root paths writable by a scientific UID are rejected, including /tmp. */
export async function protectedDirectory(
  path: string,
  io: AmberResultSpoolFileIO,
): Promise<FileHandle> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("Noncanonical protected path");
  let directory = await open("/", directoryFlags);
  let traversed = "";
  try {
    const root = await io.stat(directory, "/");
    if (root.uid !== 0 || root.mode & 0o022) throw new Error("Unsafe protected root");
    for (const component of path.split("/").filter(Boolean)) {
      const next = await open(`${descriptorPath(directory)}/${component}`, directoryFlags);
      await directory.close();
      directory = next;
      traversed += `/${component}`;
      const stat = await io.stat(directory, traversed);
      if (!stat.isDirectory() || stat.uid !== 0 || stat.mode & 0o022)
        throw new Error("Amber protected ancestor must be root-owned and not writable by peers");
    }
    return directory;
  } catch (error) {
    await directory.close();
    throw error;
  }
}

export async function boundedBytes(file: FileHandle, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stableAmberFile(file, maxBytes)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
export function parseCanonical(bytes: Buffer): unknown {
  const text = bytes.toString("utf8");
  const value: unknown = JSON.parse(text);
  if (!Buffer.from(text).equals(bytes) || canonicalJson(value) !== text)
    throw new Error("Amber result JSON must be canonical UTF-8");
  return value;
}
export async function protectedJson(path: string, io: AmberResultSpoolFileIO): Promise<unknown> {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new Error("Noncanonical protected file path");
  const parent = await protectedDirectory(dirname(path), io);
  let file: FileHandle | undefined;
  try {
    file = await open(`${descriptorPath(parent)}/${basename(path)}`, fileFlags);
    const stat = await io.stat(file, path);
    if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || stat.mode & 0o022 || stat.size < 1)
      throw new Error("Amber result configuration must be a root-protected regular file");
    return parseCanonical(await boundedBytes(file, 256 * 1024));
  } finally {
    await file?.close();
    await parent.close();
  }
}
