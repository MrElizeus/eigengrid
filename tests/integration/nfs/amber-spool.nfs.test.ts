import { afterEach, describe, expect, test } from "bun:test";
import { constants, statfsSync } from "node:fs";
import { link, open, readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { amberResultSpoolFixture } from "../../../apps/cli/src/services/amber-result-spool.fixture";
import {
  collectAmberSlurmStage,
  runAmberSlurmStage,
} from "../../../apps/cli/src/services/amber-slurm-runner";

/** Explicit opt-in. These tests exercise actual NFS I/O but use synthetic
 * authority and a local fake engine; they are not a site or science qualification. */
const enabled = process.env.EIGENGRID_NFS_INTEGRATION === "1";
const fixtures: Awaited<ReturnType<typeof amberResultSpoolFixture>>[] = [];
async function fixture() {
  if (statfsSync(tmpdir()).type !== 0x6969)
    throw new Error("NFS integration requires TMPDIR on an actual NFS mount");
  const f = await amberResultSpoolFixture();
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

describe.skipIf(!enabled)("real NFS result spool integration", () => {
  test("mount uses NFS and reproduces an open-unlink retained link", async () => {
    const f = await fixture();
    const staged = join(f.root, "nfs-semantics-staging");
    const final = join(f.root, "nfs-semantics-final");
    const writer = await open(
      staged,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await writer.writeFile("synthetic-nfs-probe");
      await writer.sync();
      await link(staged, final);
      await unlink(staged);
      // Linux NFS normally retains a hidden silly-renamed link while an inode is
      // still open. If this environment does not reproduce it, fail explicitly:
      // a passing suite must not claim it exercised the historical failure.
      expect((await stat(final)).nlink).toBe(2);
    } finally {
      await writer.close();
    }
    expect((await stat(final)).nlink).toBe(1);
    await unlink(final);
  });

  test("publishes actual NFS objects and closed marker without engine replay", async () => {
    const f = await fixture();
    const result = await runAmberSlurmStage(f.capsule, f.profile, undefined, f.runnerIO);
    expect(result.publication?.canonicalAcknowledged).toBe(false);
    expect((await stat(join(f.publicationRoot, "publication.json"))).nlink).toBe(1);
    expect(await readFile(f.launches, "utf8")).toBe("launch\n");
    f.collector();
    const spool = await f.factory(f.config.configPath);
    const reader = await spool.openVerifiedPublication({
      capsule: f.capsule,
      binding: f.binding,
      expectedJobId: "43",
    });
    try {
      await reader.revalidate();
      expect(reader.receipt.scientificVerdict).toBe("not_evaluated");
    } finally {
      await reader.close();
    }
  });

  test("recovers exact hardlink crash window on NFS without a second engine", async () => {
    const f = await fixture();
    await runAmberSlurmStage(f.capsule, f.profile, undefined, f.runnerIO);
    const observation = await f.observation();
    const final = join(f.publicationRoot, "publication.json");
    const staged = join(
      f.publicationRoot,
      "incoming",
      observation.transfer.transferId,
      "publication.json",
    );
    await link(final, staged);
    expect((await stat(final)).nlink).toBe(2);
    const result = await collectAmberSlurmStage(f.capsule, f.profile, f.runnerIO.host(), f.factory);
    expect(result.publication?.canonicalAcknowledged).toBe(false);
    expect((await stat(final)).nlink).toBe(1);
    expect(
      await readdir(join(f.publicationRoot, "incoming", observation.transfer.transferId)),
    ).toEqual([]);
    expect(await readFile(f.launches, "utf8")).toBe("launch\n");
  });

  test("recovers stale staging inode on NFS without a second engine", async () => {
    const f = await fixture();
    const realUnlink = f.io.unlink;
    f.io.unlink = async () => {
      throw Object.assign(new Error("synthetic interrupted transfer"), { code: "EIO" });
    };
    await expect(
      runAmberSlurmStage(f.capsule, f.profile, undefined, f.runnerIO),
    ).rejects.toMatchObject({ phase: "stage_out", errno: "EIO" });
    f.io.unlink = realUnlink;
    const observation = await f.observation();
    const incoming = join(f.publicationRoot, "incoming", observation.transfer.transferId);
    const staged = await readdir(incoming);
    expect(staged).toHaveLength(1);
    await unlink(join(f.publicationRoot, "objects", staged[0]!));
    expect((await stat(join(incoming, staged[0]!))).nlink).toBe(1);
    const result = await collectAmberSlurmStage(f.capsule, f.profile, f.runnerIO.host(), f.factory);
    expect(result.publication?.canonicalAcknowledged).toBe(false);
    expect(await readdir(incoming)).toEqual([]);
    expect(await readFile(f.launches, "utf8")).toBe("launch\n");
  });
});
