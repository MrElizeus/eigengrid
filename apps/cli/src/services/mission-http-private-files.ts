import { constants } from "node:fs";
import { open, lstat, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, resolve, basename } from "node:path";
import { randomUUID } from "node:crypto";

async function retry<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (
        !["EAGAIN", "EWOULDBLOCK"].includes((error as NodeJS.ErrnoException).code ?? "") ||
        attempt >= 6
      )
        throw error;
      await new Promise((done) => setTimeout(done, Math.min(8 * 2 ** attempt, 64)));
    }
  }
}

async function protectedAncestors(path: string) {
  if (resolve(path) !== path) throw new Error("Mission client paths must be canonical");
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      ![0, process.getuid?.()].includes(info.uid) ||
      ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000) !== 0))
    )
      throw new Error(
        "Mission client ancestry must be owned and protected; symlinks are unsupported",
      );
    if (dirname(current) === current) return;
  }
}

export async function ensurePrivateClientDirectory(path: string) {
  if (resolve(path) !== path) throw new Error("Mission client directory must be canonical");
  await protectedAncestors(dirname(path));
  await mkdir(path, { mode: 0o700 }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error("Mission client directory must be owned and protected by the current user");
}
export async function readPrivateClientJson(
  path: string,
  optional = false,
): Promise<unknown | undefined> {
  try {
    await lstat(path);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Private mission client file is unavailable");
  }
  await ensurePrivateClientDirectory(dirname(path));
  const directory = await open(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let handle;
  try {
    handle = await retry(() =>
      open(
        `/proc/self/fd/${directory.fd}/${basename(path)}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      ),
    );
  } catch (error) {
    await directory.close();
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Private mission client file is unavailable");
  }
  try {
    await ensurePrivateClientDirectory(dirname(path));
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o077) !== 0 ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > 1024 * 1024
    )
      throw new Error("Mission client files require current-user ownership and mode 0600");
    const buffer = Buffer.alloc(before.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const part = await retry(() => handle.read(buffer, total, buffer.length - total, total));
      if (!part.bytesRead) break;
      total += part.bytesRead;
    }
    const after = await handle.stat();
    if (
      total !== before.size ||
      ["dev", "ino", "mode", "uid", "size", "mtimeMs", "ctimeMs"].some(
        (field) => before[field as keyof typeof before] !== after[field as keyof typeof after],
      )
    )
      throw new Error("Private mission client file changed during read");
    try {
      return JSON.parse(buffer.subarray(0, total).toString("utf8"));
    } catch {
      throw new Error("Private mission client JSON is invalid");
    }
  } finally {
    await handle.close();
    await directory.close();
  }
}
export async function writePrivateClientJson(path: string, value: unknown) {
  await ensurePrivateClientDirectory(dirname(path));
  const directory = await open(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const bound = `/proc/self/fd/${directory.fd}`;
  const temp = `${bound}/${basename(path)}.${randomUUID()}.tmp`;
  try {
    const handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, `${bound}/${basename(path)}`);
    await directory.sync();
  } finally {
    await unlink(temp).catch(() => {});
    await directory.close();
  }
}
export async function lockPrivateClient(path: string) {
  await ensurePrivateClientDirectory(dirname(path));
  const directory = await open(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const boundPath = `/proc/self/fd/${directory.fd}/${basename(path)}`;
  let handle;
  try {
    handle = await open(
      boundPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    await directory.close();
    throw new Error(
      "Mission HTTP client is busy or a prior process left a lock; inspect its private state before recovery",
    );
  }
  const info = await handle.stat();
  return async () => {
    try {
      const current = await lstat(boundPath);
      if (current.ino !== info.ino || current.dev !== info.dev)
        throw new Error("Mission client lock identity changed");
      await unlink(boundPath);
    } finally {
      await handle.close();
      await directory.close();
    }
  };
}
