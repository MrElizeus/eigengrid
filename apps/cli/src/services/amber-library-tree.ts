import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { DigestSchema } from "@eigengrid/scientific-schema";
import { assertProtectedRootPath } from "./amber-slurm-backend";

/** Stable content identity for the root-provisioned Amber GPU library tree.
 * Symlinks bind both their target text and the target file's contents.
 */
export async function computeProtectedAmberLibraryTreeDigest(root: string): Promise<string> {
  await assertProtectedRootPath(root);
  const digest = createHash("sha256");
  let entries = 0;
  let bytes = 0;
  const fileIdentity = async (path: string): Promise<{ size: number; sha256: string }> => {
    await assertProtectedRootPath(path);
    const resolved = await realpath(path);
    const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (
        !before.isFile() ||
        before.uid !== 0 ||
        (before.mode & 0o022) !== 0 ||
        before.size > 512 * 1024 * 1024
      )
        throw new Error("Amber library is not a protected bounded root-owned file");
      bytes += before.size;
      if (bytes > 2 * 1024 * 1024 * 1024)
        throw new Error("Amber library tree exceeds its byte limit");
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(1024 * 1024);
      let offset = 0;
      while (offset < before.size) {
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, before.size - offset),
          offset,
        );
        if (!bytesRead) throw new Error("Amber library changed during verification");
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = await file.stat();
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        throw new Error("Amber library changed during verification");
      return { size: before.size, sha256: hash.digest("hex") };
    } finally {
      await file.close();
    }
  };
  const walk = async (directory: string, relative: string, depth: number): Promise<void> => {
    if (depth > 16) throw new Error("Amber library tree exceeds its directory depth");
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.uid !== 0 || directoryInfo.mode & 0o022)
      throw new Error("Amber library directory is not protected");
    for (const name of (await readdir(directory)).sort()) {
      if (++entries > 10_000) throw new Error("Amber library tree exceeds its entry limit");
      const path = join(directory, name);
      const child = relative ? `${relative}/${name}` : name;
      const info = await lstat(path);
      if (info.uid !== 0 || (!info.isSymbolicLink() && info.mode & 0o022))
        throw new Error("Amber library entry is not protected");
      if (info.isDirectory()) {
        digest.update(`D\0${child}\0`);
        await walk(path, child, depth + 1);
      } else if (info.isFile()) {
        const identity = await fileIdentity(path);
        digest.update(`F\0${child}\0${identity.size}\0${identity.sha256}\0`);
      } else if (info.isSymbolicLink()) {
        await assertProtectedRootPath(path);
        if (!(await stat(path)).isFile())
          throw new Error("Amber library symlink must resolve to a protected file");
        const identity = await fileIdentity(path);
        digest.update(
          `L\0${child}\0${await readlink(path)}\0${identity.size}\0${identity.sha256}\0`,
        );
      } else throw new Error("Amber library tree contains a special file");
    }
  };
  await walk(root, "", 0);
  return digest.digest("hex");
}

export async function verifyRootOwnedAmberLibraryTree(
  root: string,
  expectedSha256: string,
): Promise<void> {
  const expected = DigestSchema.parse(expectedSha256);
  if ((await computeProtectedAmberLibraryTreeDigest(root)) !== expected)
    throw new Error("Amber library tree differs from the pinned site identity");
}
