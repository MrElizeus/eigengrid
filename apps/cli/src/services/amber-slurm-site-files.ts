import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { canonicalJson } from "@eigengrid/scientific-schema";
import { assertProtectedRootPath } from "./amber-slurm-backend";
import { assertAmberSlurmSiteProfile } from "./amber-slurm-profile";

/** Site paths are root-provisioned service arguments, never RPC fields. Root
 * may rotate a whole immutable profile only in a controlled deployment window.
 */
export async function readProtectedSiteJson(path: string): Promise<unknown> {
  await assertProtectedRootPath(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.uid !== 0 ||
      (before.mode & 0o022) !== 0 ||
      before.size < 1 ||
      before.size > 256 * 1024
    )
      throw new Error("Invalid protected Amber site profile");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error("Truncated Amber site profile");
      offset += bytesRead;
    }
    const after = await file.stat();
    const text = bytes.toString("utf8");
    const value: unknown = JSON.parse(text);
    if (
      !Buffer.from(text).equals(bytes) ||
      canonicalJson(value) !== text ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("Amber site profile changed or is not canonical");
    return value;
  } finally {
    await file.close();
  }
}

export async function loadAmberSlurmSiteProfile(path: string) {
  const profile = assertAmberSlurmSiteProfile(await readProtectedSiteJson(path));
  if (profile.profilePath !== path) throw new Error("Amber site profile path mismatch");
  return profile;
}
