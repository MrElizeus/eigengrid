import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "@eigengrid/scientific-schema";
import { amberResultSpoolFixture } from "./amber-result-spool.fixture";
import { createAmberResultSpool } from "./amber-result-spool";
import { collectAmberSlurmStage, runAmberSlurmStage } from "./amber-slurm-runner";

const fixtures: Awaited<ReturnType<typeof amberResultSpoolFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture(mode?: string) {
  const f = await amberResultSpoolFixture(mode);
  fixtures.push(f);
  return f;
}
async function published(mode?: string) {
  const f = await fixture(mode);
  const result = await runAmberSlurmStage(f.capsule, f.profile, undefined, f.runnerIO);
  const spool = await f.factory(f.config.configPath);
  const observation = await f.observation();
  const source = await f.source();
  const publish = () =>
    spool.publish({
      capsule: f.capsule,
      observedBindingDigest: f.binding.bindingDigest,
      receiptReference: result.reference,
      source,
      transfer: observation.transfer,
    });
  const originalClose = f.close;
  f.close = async () => {
    await source.close();
    await originalClose();
  };
  return {
    ...f,
    result,
    spool,
    source,
    observation,
    publish,
    open: () =>
      spool.openVerifiedPublication({
        capsule: f.capsule,
        binding: f.binding,
        expectedJobId: "43",
      }),
  };
}

describe("Amber result spool — local real bytes/FDs; two UIDs/root ownership modeled", () => {
  test("runner auto-publishes only closed CAS bytes; Head streams/revalidates with no scientific ACK", async () => {
    const f = await published();
    expect(f.result.publication?.canonicalAcknowledged).toBe(false);
    expect(await readFile(f.launches, "utf8")).toBe("launch\n");
    expect((await stat(join(f.publicationRoot, "publication.json"))).mode & 0o7777).toBe(0o440);
    expect((await stat(join(f.publicationRoot, "receipt.json"))).nlink).toBe(1);
    f.collector();
    const reader = await f.open();
    try {
      expect(reader.receipt.qcStatus).toBe("not_evaluated");
      expect(reader.manifest.bindingDigest).toBe(f.binding.bindingDigest);
      for (const item of reader.manifest.objects) {
        if (!item.object) continue;
        const chunks = [];
        for await (const bytes of (
          await reader.getStream(item.object.sha256, { maxBytes: item.object.sizeBytes })
        ).bytes)
          chunks.push(bytes);
        expect(Buffer.concat(chunks).length).toBe(item.object.sizeBytes);
      }
      await reader.revalidate();
      await expect(reader.getStream("f".repeat(64))).rejects.toThrow("not in");
    } finally {
      await reader.close();
    }
    await expect(reader.revalidate()).rejects.toThrow("closed");
  });

  test("collect retry keeps exact marker/transfer and launches no engine after input/binary removal", async () => {
    const f = await published();
    const marker = await readFile(join(f.publicationRoot, "publication.json"));
    await rm(f.engine);
    await f.input.close();
    await rm(join(f.root, "inputs"), { recursive: true });
    const host = { ...f.runnerIO.host(), jobId: "", jobName: undefined, ordinaryBatch: false };
    const result = await collectAmberSlurmStage(f.capsule, f.profile, host, f.factory);
    expect(result.reference).toEqual(f.result.reference);
    expect(await readFile(join(f.publicationRoot, "publication.json"))).toEqual(marker);
    expect(await readFile(f.launches, "utf8")).toBe("launch\n");
    expect(
      await readdir(join(f.publicationRoot, "incoming", f.observation.transfer.transferId)),
    ).toEqual([]);
  });

  test("missing full job-name observation stops before scientific effect", async () => {
    const f = await fixture();
    const host = f.runnerIO.host();
    f.runnerIO.host = () => ({ ...host, jobName: "egv1-short" });
    await expect(runAmberSlurmStage(f.capsule, f.profile, undefined, f.runnerIO)).rejects.toThrow(
      "full Slurm job-name",
    );
    await expect(stat(f.launches)).rejects.toMatchObject({ code: "ENOENT" });
  });

  for (const mode of ["missing", "exit42"])
    test(`stage-out preserves ${mode} receipt without promoting QC`, async () => {
      const f = await published(mode);
      f.collector();
      const reader = await f.open();
      try {
        expect(reader.receipt.artifactStatus).toBe(mode === "missing" ? "incomplete" : "complete");
        expect(reader.receipt.engine.exitCode).toBe(mode === "exit42" ? 42 : 0);
        expect(reader.receipt.scientificVerdict).toBe("not_evaluated");
      } finally {
        await reader.close();
      }
    });

  test("production loader rejects modeled root config, writable or linked config also fail closed", async () => {
    const f = await fixture();
    await expect(createAmberResultSpool(f.config.configPath)).rejects.toThrow("root-owned");
    await chmod(f.config.configPath, 0o666);
    await expect(f.factory(f.config.configPath)).rejects.toThrow("root-protected");
    await chmod(f.config.configPath, 0o600);
    await link(f.config.configPath, join(f.root, "config-alias"));
    await expect(f.factory(f.config.configPath)).rejects.toThrow("root-protected");
  });

  test("writer and collector principals and membership are separate", async () => {
    const f = await published();
    await expect(f.open()).rejects.toThrow("principal/group");
    f.collector();
    await expect(f.publish()).rejects.toThrow("principal/group");
    f.io.groups = () => [];
    await expect(f.open()).rejects.toThrow("principal/group");
  });

  test("wrong protected project mode rejects stage-out but retains source receipt for retry", async () => {
    const f = await fixture();
    await chmod(f.project, 0o2770);
    await expect(runAmberSlurmStage(f.capsule, f.profile, undefined, f.runnerIO)).rejects.toThrow(
      "ownership/mode",
    );
    expect(await readFile(f.launches, "utf8")).toBe("launch\n");
    expect(Bun.spawnSync(["/usr/bin/chmod", "2750", f.project]).exitCode).toBe(0);
    const result = await collectAmberSlurmStage(f.capsule, f.profile, f.runnerIO.host(), f.factory);
    expect(result.publication?.canonicalAcknowledged).toBe(false);
    expect(await readFile(f.launches, "utf8")).toBe("launch\n");
  });

  test("changed transfer conflicts and cannot rewrite a completed marker", async () => {
    const f = await published();
    const before = await readFile(join(f.publicationRoot, "publication.json"));
    await expect(
      f.spool.publish({
        capsule: f.capsule,
        observedBindingDigest: f.binding.bindingDigest,
        receiptReference: f.result.reference,
        source: f.source,
        transfer: { ...f.observation.transfer, observedAt: "2026-09-20T11:00:00.000Z" },
      }),
    ).rejects.toThrow();
    expect(await readFile(join(f.publicationRoot, "publication.json"))).toEqual(before);
  });

  test("collector rejects crash hardlink window; same transfer recovers only its exact inode", async () => {
    const f = await published();
    const final = join(f.publicationRoot, "publication.json");
    const pending = join(
      f.publicationRoot,
      "incoming",
      f.observation.transfer.transferId,
      "publication.json",
    );
    await link(final, pending);
    f.collector();
    await expect(f.open()).rejects.toThrow("link count");
    f.writer();
    await f.publish();
    expect((await stat(final)).nlink).toBe(1);
    f.collector();
    const reader = await f.open();
    await reader.close();
  });

  for (const attack of ["symlink", "hardlink", "writable", "wrong-size"])
    test(`collector rejects ${attack} output before adoption`, async () => {
      const f = await published();
      const reference = f.result.receipt.outputs.find((o) => o.object)!.object!;
      const object = join(f.publicationRoot, "objects", reference.sha256);
      if (attack === "symlink") {
        await rename(object, join(f.root, "detached"));
        await symlink(join(f.root, "detached"), object);
      }
      if (attack === "hardlink") await link(object, join(f.root, "extra-link"));
      if (attack === "writable") await chmod(object, 0o660);
      if (attack === "wrong-size") {
        await chmod(object, 0o640);
        await writeFile(object, "short");
        await chmod(object, 0o440);
      }
      f.collector();
      await expect(f.open()).rejects.toThrow();
    });

  test("anchored reader detects same-size mutation and replaced parent after open", async () => {
    const f = await published();
    f.collector();
    const reader = await f.open();
    try {
      const item = reader.manifest.objects.find((o) => o.kind === "output" && o.object)!.object!;
      const object = join(f.publicationRoot, "objects", item.sha256);
      await chmod(object, 0o640);
      await writeFile(object, Buffer.alloc(item.sizeBytes, 88));
      await chmod(object, 0o440);
      await expect(reader.getStream(item.sha256)).rejects.toThrow("changed");
      await expect(reader.revalidate()).rejects.toThrow("changed");
    } finally {
      await reader.close();
    }
  });

  test("wrong job or durable binding cannot authorize a publication", async () => {
    const f = await published();
    f.collector();
    await expect(
      f.spool.openVerifiedPublication({
        capsule: f.capsule,
        binding: f.binding,
        expectedJobId: "44",
      }),
    ).rejects.toThrow("job differs");
    await expect(
      f.spool.openVerifiedPublication({
        capsule: f.capsule,
        binding: { ...f.binding, bindingDigest: "f".repeat(64) },
        expectedJobId: "43",
      }),
    ).rejects.toThrow("binding digest");
  });

  test("per-object limits stop before publication, while local receipt survives", async () => {
    const f = await fixture();
    f.config.limits.maxObjectBytes = 1;
    await f.writeConfig();
    await expect(runAmberSlurmStage(f.capsule, f.profile, undefined, f.runnerIO)).rejects.toThrow(
      "receipt exceeds",
    );
    expect(await readFile(join(f.workspace, ".eigengrid/receipt.json"), "utf8")).toContain(
      "not_evaluated",
    );
    await expect(stat(join(f.publicationRoot, "publication.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("noncanonical manifest and namespace overlap are rejected", async () => {
    const f = await published();
    const marker = join(f.publicationRoot, "publication.json");
    const manifest = JSON.parse(await readFile(marker, "utf8"));
    await chmod(marker, 0o640);
    await writeFile(marker, JSON.stringify(manifest, null, 2));
    await chmod(marker, 0o440);
    f.collector();
    await expect(f.open()).rejects.toThrow("canonical");
    f.writer();
    f.config.resultSpoolRoot = f.profile.scratchRoot;
    await f.writeConfig();
    const spool = await f.factory(f.config.configPath);
    await expect(
      spool.publish({
        capsule: f.capsule,
        observedBindingDigest: f.binding.bindingDigest,
        receiptReference: f.result.reference,
        source: f.source,
        transfer: f.observation.transfer,
      }),
    ).rejects.toThrow("separate");
    expect(canonicalJson(manifest).length).toBeGreaterThan(100);
  });
});
