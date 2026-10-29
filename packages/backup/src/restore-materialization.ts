import { createHash, randomUUID } from "crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeSync,
} from "fs";
import { dirname, join, resolve, sep } from "path";

export type RestoreEntry = {
  path: string;
  stagedPath: string;
  size: number;
  expectedDigest: string;
};
type MaterializeOptions = {
  beforePublish?: (parent: string) => void;
  fchmod?: (fd: number, mode: number) => void;
};
const directory = constants.O_DIRECTORY ?? 0;
const CAS_OBJECT_PATH = /^cas\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/u;
function anchor(fd: number, name = ""): string {
  for (const root of ["/proc/self/fd", "/dev/fd"])
    if (existsSync(join(root, String(fd)))) return join(root, String(fd), name);
  throw new Error("descriptor-anchored paths require /proc/self/fd or /dev/fd support");
}
function parts(path: string): string[] {
  return resolve(path).split(sep).filter(Boolean);
}

/** Checks the path without creating it; materialize() repeats this walk with held descriptors. */
export function validateRestoreDestination(target: string): string[] {
  const errors: string[] = [];
  const absolute = resolve(target);
  if (absolute === resolve(absolute, "..")) return ["Restore target cannot be filesystem root"];
  try {
    const fd = openSync(sep, constants.O_RDONLY | constants.O_NOFOLLOW | directory);
    try {
      anchor(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  let current: string = sep;
  for (const part of parts(absolute)) {
    current = join(current, part);
    if (!existsSync(current)) break;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) return [`Restore target contains a symlink: ${current}`];
    if (!stat.isDirectory()) return [`Restore target exists and is not a directory: ${target}`];
  }
  return errors;
}
function openDir(
  parent: number,
  name: string,
  create: boolean,
  chmod: (fd: number, mode: number) => void,
): number {
  const path = anchor(parent, name);
  try {
    return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | directory);
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(path, { mode: 0o777 });
    const oPath =
      (constants as typeof constants & { O_PATH?: number }).O_PATH ??
      (process.platform === "linux" ? 0x200000 : undefined);
    if (oPath !== undefined) {
      const bootstrap = openSync(path, oPath | constants.O_NOFOLLOW | directory);
      try {
        if (!fstatSync(bootstrap).isDirectory())
          throw new Error(`Restore directory is not a directory: ${name}`);
        chmodSync(anchor(bootstrap), 0o700);
      } finally {
        closeSync(bootstrap);
      }
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | directory);
    try {
      chmod(fd, 0o700);
      fsyncSync(fd);
      fsyncSync(parent);
      return fd;
    } catch (failure) {
      closeSync(fd);
      try {
        rmdirSync(path);
      } catch {
        // Preserve the authoritative chmod failure; never recursively remove a raced directory.
      }
      throw failure;
    }
  }
}
function matchesHeldDirectory(fd: number, path: string): boolean {
  try {
    const held = fstatSync(fd),
      current = lstatSync(path);
    return (
      held.isDirectory() &&
      current.isDirectory() &&
      !current.isSymbolicLink() &&
      held.dev === current.dev &&
      held.ino === current.ino
    );
  } catch {
    return false;
  }
}

function directoryKey(path: string): string {
  return path.split("/").filter(Boolean).join("/");
}

export function materializeRestore(
  target: string,
  entries: RestoreEntry[],
  options: MaterializeOptions = {},
): void {
  const fds = new Map<string, number>();
  const absoluteTarget = resolve(target);
  let root = -1;
  try {
    root = openSync(sep, constants.O_RDONLY | constants.O_NOFOLLOW | directory);
    try {
      anchor(root);
    } catch (error) {
      closeSync(root);
      root = -1;
      throw error;
    }
    fds.set("", root);
    const getDir = (path: string): number => {
      const key = directoryKey(path);
      if (fds.has(key)) return fds.get(key)!;
      const parent = getDir(dirname(path));
      const fd = openDir(
        parent,
        key.slice(key.lastIndexOf("/") + 1),
        true,
        options.fchmod ?? fchmodSync,
      );
      if (!fstatSync(fd).isDirectory()) {
        closeSync(fd);
        throw new Error(`Restore directory is not a directory: ${path}`);
      }
      fds.set(key, fd);
      return fd;
    };
    getDir(absoluteTarget);
    for (const entry of entries) {
      const parent = getDir(join(absoluteTarget, dirname(entry.path)));
      const name = entry.path.split("/").pop()!;
      const source = openSync(entry.stagedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const temporary = `.eigengrid-${randomUUID()}.tmp`;
      try {
        const sourceStat = fstatSync(source);
        if (!sourceStat.isFile() || sourceStat.nlink !== 1 || sourceStat.size !== entry.size)
          throw new Error(`Unsafe staged restore file: ${entry.path}`);
        if (!matchesHeldDirectory(parent, join(absoluteTarget, dirname(entry.path))))
          throw new Error(`Restore directory changed: ${entry.path}`);
        const temp = openSync(
          anchor(parent, temporary),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          (options.fchmod ?? fchmodSync)(temp, 0o600);
          const hash = createHash("sha256"),
            buffer = Buffer.allocUnsafe(64 * 1024);
          let read: number;
          let copied = 0;
          while ((read = readSync(source, buffer, 0, buffer.length, null)) > 0) {
            hash.update(buffer.subarray(0, read));
            copied += read;
            for (let offset = 0; offset < read; )
              offset += writeSync(temp, buffer, offset, read - offset);
          }
          if (copied !== entry.size || hash.digest("hex") !== entry.expectedDigest)
            throw new Error(`Staged restore file changed: ${entry.path}`);
          (options.fchmod ?? fchmodSync)(temp, CAS_OBJECT_PATH.test(entry.path) ? 0o444 : 0o600);
          fsyncSync(temp);
        } finally {
          closeSync(temp);
        }
        if (!matchesHeldDirectory(parent, join(absoluteTarget, dirname(entry.path))))
          throw new Error(`Restore directory changed: ${entry.path}`);
        options.beforePublish?.(join(absoluteTarget, dirname(entry.path)));
        const destination = anchor(parent, name);
        if (existsSync(destination) && lstatSync(destination).isDirectory())
          throw new Error(`Restore destination is a directory: ${entry.path}`);
        renameSync(anchor(parent, temporary), destination);
        if (!matchesHeldDirectory(parent, join(absoluteTarget, dirname(entry.path)))) {
          rmSync(destination, { force: true });
          fsyncSync(parent);
          throw new Error(`Restore directory changed: ${entry.path}`);
        }
        fsyncSync(parent);
      } finally {
        rmSync(anchor(parent, temporary), { force: true });
        closeSync(source);
      }
    }
  } finally {
    for (const fd of fds.values()) closeSync(fd);
  }
}
