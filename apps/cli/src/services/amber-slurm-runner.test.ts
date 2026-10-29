import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { ContentAddressedArtifactStore } from "@eigengrid/mission-runtime";
import { canonicalJson } from "@eigengrid/scientific-schema";
import { syntheticAmberBundleFixture } from "./amber-stage-bundle.fixture";
import { verifyRootOwnedAmberLibraryTree } from "./amber-library-tree";
import { SYNTHETIC_PMEMD_CUDA_SHA256, syntheticGpuAmberSeed } from "./amber-gpu-test-fixture";
import { publishAmberStageBundle } from "./amber-stage-bundle";
import {
  amberRunnerCapsuleDigest,
  computeAmberSlurmSiteProfileDigest,
  type AmberRunnerCapsule,
  type AmberSlurmSiteProfile,
} from "./amber-slurm-profile";
import {
  collectAmberSlurmStage,
  copyAmberWorkerResult,
  runAmberSlurmStage,
  verifyAmberWorkerReceipt,
  type AmberRunnerIO,
} from "./amber-slurm-runner";
import {
  logicalParent,
  openAmberFile,
  openAmberScratchRoot,
  openPrivateDirectory,
  privateChild,
  stageAmberInput,
  writeAmberMetadata,
} from "./amber-runner-files";
import { loadAmberSlurmSiteProfile } from "./amber-slurm-site-files";

const D = (value: string) => value.repeat(64);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Deliberately fake scientific executable over synthetic input bytes. Tests
 * real filesystem/process/signal/collection behavior, NOT Amber/QC or Slurm.
 */
async function fixture(mode = "complete", gpu = false) {
  const root = await mkdtemp(join(tmpdir(), "eg-amber-runner-"));
  const store = new ContentAddressedArtifactStore(join(root, "publication"));
  cleanup.push(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.init();
  const { seed: cpuSeed } = await syntheticAmberBundleFixture(store, {
    resourceProfile: {
      cpuCores: 1,
      memoryBytes: 128 * 1024 * 1024,
      scratchBytes: 16 * 1024 * 1024,
    },
  });
  const seed = gpu
    ? await syntheticGpuAmberSeed(store, {
        cpuCores: 1,
        memoryBytes: 128 * 1024 * 1024,
        scratchBytes: 16 * 1024 * 1024,
      })
    : cpuSeed;
  const bundle = await publishAmberStageBundle(store, seed);
  const scratch = join(root, "scratch");
  await mkdir(scratch, { mode: 0o700 });
  const amberHome = join(root, "fake-amber");
  await mkdir(join(amberHome, "bin"), { recursive: true, mode: 0o700 });
  const count = join(root, "engine-launches");
  const engine = join(amberHome, "bin", gpu ? "pmemd.cuda" : "sander");
  await writeFile(
    engine,
    `#!/usr/bin/python3 -I
import json, os, pathlib, signal, subprocess, sys, time
mode = ${JSON.stringify(mode)}
args = sys.argv[1:]
def argument(flag): return pathlib.Path(args[args.index(flag)+1])
for flag in ['-i', '-p', '-c']: assert argument(flag).read_bytes()
if mode == 'ignore-term': signal.signal(signal.SIGTERM, signal.SIG_IGN)
with pathlib.Path(${JSON.stringify(count)}).open('a') as stream: stream.write('launch\\n')
for flag in ['-o', '-r', '-inf', '-x']:
    if flag not in args or (mode == 'missing' and flag == '-r'): continue
    if mode == 'symlink' and flag == '-r':
        argument(flag).symlink_to(${JSON.stringify(count)})
    else: argument(flag).write_text(json.dumps(dict(flag=flag, env=dict(os.environ))) + '\\n')
if mode == 'tamper-input':
    argument('-c').chmod(0o600); argument('-c').write_text('corrupted input')
if mode == 'fork':
    child = subprocess.Popen(['/usr/bin/sleep', '30'])
    pathlib.Path(${JSON.stringify(join(root, "child-pid"))}).write_text(str(child.pid))
if mode == 'ignore-term': time.sleep(30)
if mode == 'flood':
    sys.stdout.write('X' * (2 * 1024 * 1024)); sys.stdout.flush(); time.sleep(30)
if mode == 'signal': os.kill(os.getpid(), signal.SIGKILL)
sys.exit(42 if mode == 'exit42' else 0)
`,
    { mode: 0o700 },
  );
  const user = userInfo();
  const profile: AmberSlurmSiteProfile = {
    schemaVersion: "eigengrid.amber-slurm-site/v1",
    profilePath: "/etc/eigengrid/test-only.json",
    transport: {
      cluster: "fixture-cluster",
      slurmVersion: "23.11.4",
      uid: user.uid,
      username: user.username,
      home: user.homedir,
      submissionDirectory: join(user.homedir, ".eg-submit"),
      siteProfileDigest: D("0"),
      partition: "chem",
      node: hostname(),
      account: "fixture-account",
      cpuLimit: 2,
      memoryMiBLimit: 1024,
      walltimeLimitSeconds: 3600,
      ...(gpu ? { gpuType: "a100", gpuLimit: 1 as const } : {}),
    },
    gid: user.gid,
    runnerExecutable: "/opt/apps/fixture/runner",
    runnerSha256: D("1"),
    amberHome,
    sanderSha256: seed.request.environment.binaryDigest,
    ...(gpu
      ? {
          pmemdCudaSha256: SYNTHETIC_PMEMD_CUDA_SHA256,
          gpuLibraryTreeSha256: D("b"),
        }
      : {}),
    amberVersion: seed.request.environment.engine.version,
    engineEnvironmentDigest: seed.request.environment.engineEnvironmentDigest,
    scratchRoot: scratch,
    projects: [
      {
        subject: "fixture-user",
        projectId: "project-1",
        publicationRoot: join(root, "publication"),
      },
    ],
  };
  profile.transport.siteProfileDigest = computeAmberSlurmSiteProfileDigest(profile);
  const capsule: AmberRunnerCapsule = {
    schemaVersion: "eigengrid.amber-runner-capsule/v1",
    operationId: "operation-1",
    admissionDigest: D("2"),
    fencingGeneration: 1,
    uid: user.uid,
    gid: user.gid,
    subject: "fixture-user",
    projectId: "project-1",
    siteProfileDigest: profile.transport.siteProfileDigest,
    request: seed.request,
    bundle: bundle.reference,
  };
  const checks: string[] = [];
  const io: AmberRunnerIO = {
    host: () => ({
      uid: user.uid,
      gid: user.gid,
      node: hostname(),
      cluster: "fixture-cluster",
      jobId: "43",
      cpus: 1,
      memoryMiB: 128,
      ...(gpu ? { gpusOnNode: 1, cudaVisibleDevices: "0" } : {}),
      ordinaryBatch: true,
    }),
    async verifyBinary(path) {
      checks.push(path);
    }, // local synthetic binary, not a site qualification
    async verifyLibraryTree(path) {
      checks.push(path);
    }, // synthetic user-owned tree; production checks root ownership and modes
    async checkDisk() {
      checks.push("disk");
    }, // test temp filesystem, no claim of ext4 capacity
  };
  const workspace = join(scratch, amberRunnerCapsuleDigest(capsule));
  const objects = () =>
    new ContentAddressedArtifactStore(join(workspace, ".eigengrid", "objects"), {
      access: "read-only",
    });
  return {
    root,
    store,
    seed,
    bundle,
    profile,
    capsule,
    io,
    checks,
    count,
    engine,
    workspace,
    objects,
  };
}

async function untilFile(path: string) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await Bun.sleep(10);
  }
  throw new Error("Engine fixture did not start before deadline");
}

describe("Amber worker runner — synthetic process fixture, not scientific qualification", () => {
  test("stages verified inputs, resolves argv under workspace, freezes artifacts without claiming QC", async () => {
    const f = await fixture();
    const result = await runAmberSlurmStage(f.capsule, f.profile, undefined, f.io);
    expect(result.exitCode).toBe(0);
    expect(result.receipt).toMatchObject({
      uid: userInfo().uid,
      jobId: "43",
      artifactStatus: "complete",
      inputsIntact: true,
      qcStatus: "not_evaluated",
      scientificVerdict: "not_evaluated",
      engine: { exitCode: 0, signal: null },
    });
    expect(result.receipt.outputs).toHaveLength(3);
    expect(await readFile(f.count, "utf8")).toBe("launch\n");
    expect(f.checks).toEqual(["disk", f.engine, f.profile.runnerExecutable]);
    const mdout = JSON.parse(
      await readFile(
        join(f.workspace, f.bundle.rendered.commandRequest.outputs[0]!.logicalPath),
        "utf8",
      ),
    );
    expect(mdout.env).toMatchObject({
      AMBERHOME: f.profile.amberHome,
      OMP_NUM_THREADS: "1",
      SLURM_JOB_ID: "43",
    });
    expect(mdout.env.LD_LIBRARY_PATH).toBeUndefined();
    expect(
      Object.keys(mdout.env).some((name) => /POSTGRES|DATABASE|SSH|SECRET|TOKEN/u.test(name)),
    ).toBe(false);
    const objects = f.objects();
    try {
      await objects.init();
      expect(
        await verifyAmberWorkerReceipt(objects, result.receipt, f.capsule, f.profile, f.bundle),
      ).toEqual(result.receipt);
      expect(Buffer.from((await objects.get(result.reference.sha256)).bytes).toString()).toBe(
        canonicalJson(result.receipt),
      );
    } finally {
      await objects.close();
    }
  });

  test("duplicate/concurrent capsule launches create one workspace and one engine", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      runAmberSlurmStage(f.capsule, f.profile, undefined, f.io),
      runAmberSlurmStage(f.capsule, f.profile, undefined, f.io),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    await expect(runAmberSlurmStage(f.capsule, f.profile, undefined, f.io)).rejects.toThrow();
    expect(await readFile(f.count, "utf8")).toBe("launch\n");
  });

  test("synthetic pmemd.cuda requires one Slurm GPU and passes CUDA_VISIBLE_DEVICES to the child", async () => {
    const f = await fixture("complete", true);
    const validHost = f.io.host;
    for (const change of [
      { gpusOnNode: 0 },
      { cudaVisibleDevices: undefined },
      { cudaVisibleDevices: "0,1" },
    ]) {
      f.io.host = () => ({ ...validHost(), ...change });
      await expect(runAmberSlurmStage(f.capsule, f.profile, undefined, f.io)).rejects.toThrow(
        "allocation differs",
      );
    }
    f.io.host = validHost;
    const result = await runAmberSlurmStage(f.capsule, f.profile, undefined, f.io);
    expect(result.exitCode).toBe(0);
    expect(f.checks).toEqual([
      "disk",
      f.engine,
      join(f.profile.amberHome, "lib"),
      f.profile.runnerExecutable,
    ]);
    expect(await readFile(f.count, "utf8")).toBe("launch\n");
    const mdout = JSON.parse(
      await readFile(
        join(f.workspace, f.bundle.rendered.commandRequest.outputs[0]!.logicalPath),
        "utf8",
      ),
    );
    expect(mdout.env).toMatchObject({
      CUDA_VISIBLE_DEVICES: "0",
      AMBERHOME: f.profile.amberHome,
      LD_LIBRARY_PATH: join(f.profile.amberHome, "lib"),
    });
  });

  for (const [mode, code, signal] of [
    ["exit42", 42, null],
    ["signal", 137, 9],
  ] as const) {
    test(`engine ${mode} remains separate from complete artifacts`, async () => {
      const f = await fixture(mode);
      const result = await runAmberSlurmStage(f.capsule, f.profile, undefined, f.io);
      expect(result.exitCode).toBe(code);
      expect(result.receipt.engine).toMatchObject({ exitCode: signal ? null : code, signal });
      expect(result.receipt.artifactStatus).toBe("complete");
      expect(result.receipt.qcStatus).toBe("not_evaluated");
    });
  }

  for (const mode of ["missing", "tamper-input"]) {
    test(`exit zero with ${mode} does not report complete artifacts`, async () => {
      const f = await fixture(mode);
      const result = await runAmberSlurmStage(f.capsule, f.profile, undefined, f.io);
      expect(result.exitCode).toBe(74);
      expect(result.receipt.engine.exitCode).toBe(0);
      expect(result.receipt.artifactStatus).toBe("incomplete");
      expect(result.receipt.inputsIntact).toBe(mode !== "tamper-input");
    });
  }

  test("historical collection works without publication/binary and never reruns the engine", async () => {
    const f = await fixture();
    const first = await runAmberSlurmStage(f.capsule, f.profile, undefined, f.io);
    await f.store.close();
    await rename(f.profile.projects[0]!.publicationRoot, join(f.root, "publication-offline"));
    await rename(f.engine, f.engine + ".offline");
    await writeFile(
      join(f.workspace, f.bundle.rendered.commandRequest.outputs[0]!.logicalPath),
      "changed after freeze",
    );
    const recovered = await collectAmberSlurmStage(f.capsule, f.profile, f.io.host());
    expect(recovered).toEqual({ receipt: first.receipt, reference: first.reference });
    expect(await readFile(f.count, "utf8")).toBe("launch\n");
  });

  test("collection recovers a missing final publication without a second engine invocation", async () => {
    const f = await fixture();
    const first = await runAmberSlurmStage(f.capsule, f.profile, undefined, f.io);
    // Emulate the durable state before final receipt publication; NOT a real kill drill.
    await rename(
      join(f.workspace, ".eigengrid/receipt.json"),
      join(f.workspace, ".eigengrid/saved-receipt.json"),
    );
    const recovered = await collectAmberSlurmStage(f.capsule, f.profile, f.io.host());
    expect(recovered).toEqual({ receipt: first.receipt, reference: first.reference });
    expect(await readFile(f.count, "utf8")).toBe("launch\n");
  });

  test("corrupt frozen CAS output is not replaced or accepted during retry", async () => {
    const f = await fixture();
    const first = await runAmberSlurmStage(f.capsule, f.profile, undefined, f.io);
    const sha = first.receipt.outputs[0]!.object!.sha256;
    const path = join(f.workspace, ".eigengrid/objects/sha256", sha.slice(0, 2), sha);
    await chmod(path, 0o600);
    await writeFile(path, "corruption");
    await chmod(path, 0o444);
    await expect(collectAmberSlurmStage(f.capsule, f.profile, f.io.host())).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("corruption");
    expect(await readFile(f.count, "utf8")).toBe("launch\n");
  });

  test("mismatched allocation, disk, binary, library or early cancellation never launch", async () => {
    const f = await fixture("complete", true);
    const host = f.io.host;
    for (const change of [
      { uid: userInfo().uid + 1 },
      { gid: userInfo().gid + 1 },
      { node: "other-node" },
      { cluster: "other" },
      { jobId: "42;id" },
      { cpus: 2 },
      { memoryMiB: 256 },
      { ordinaryBatch: false },
    ]) {
      f.io.host = () => ({ ...host(), ...change });
      await expect(runAmberSlurmStage(f.capsule, f.profile, undefined, f.io)).rejects.toThrow();
    }
    f.io.host = host;
    const disk = f.io.checkDisk;
    f.io.checkDisk = async () => {
      throw new Error("disk/inodes unavailable");
    };
    await expect(runAmberSlurmStage(f.capsule, f.profile, undefined, f.io)).rejects.toThrow(
      "unavailable",
    );
    f.io.checkDisk = disk;
    const verify = f.io.verifyBinary;
    f.io.verifyBinary = async () => {
      throw new Error("binary unavailable");
    };
    await expect(runAmberSlurmStage(f.capsule, f.profile, undefined, f.io)).rejects.toThrow(
      "unavailable",
    );
    f.io.verifyBinary = verify;
    const verifyLibraries = f.io.verifyLibraryTree;
    f.io.verifyLibraryTree = verifyRootOwnedAmberLibraryTree;
    await expect(runAmberSlurmStage(f.capsule, f.profile, undefined, f.io)).rejects.toThrow(
      "untrusted owner/writer",
    );
    f.io.verifyLibraryTree = verifyLibraries;
    await expect(
      runAmberSlurmStage(f.capsule, f.profile, AbortSignal.abort(), f.io),
    ).rejects.toThrow("before workspace");
    expect(await readdir(f.profile.scratchRoot)).toEqual([]);
    await expect(stat(f.count)).rejects.toThrow();
  });

  test("symlink output fails collection and cannot escape into a successful artifact manifest", async () => {
    const f = await fixture("symlink");
    await expect(runAmberSlurmStage(f.capsule, f.profile, undefined, f.io)).rejects.toThrow();
    await expect(stat(join(f.workspace, ".eigengrid/receipt.json"))).rejects.toThrow();
    await expect(collectAmberSlurmStage(f.capsule, f.profile, f.io.host())).rejects.toThrow();
    expect(await readFile(f.count, "utf8")).toBe("launch\n");
  });

  test("SIGTERM-ignoring engine is escalated/reaped with a real SIGKILL receipt", async () => {
    const f = await fixture("ignore-term");
    const controller = new AbortController();
    const running = runAmberSlurmStage(f.capsule, f.profile, controller.signal, f.io);
    await untilFile(f.count);
    const start = Date.now();
    controller.abort();
    const result = await running;
    expect(Date.now() - start).toBeLessThan(6500);
    expect(result.exitCode).toBe(137);
    expect(result.receipt.supervision?.stopReason).toBe("cancelled");
    expect(result.receipt.engine).toMatchObject({
      exitCode: null,
      signal: 9,
      supervisorSignals: [15],
    });
    await expect(runAmberSlurmStage(f.capsule, f.profile, undefined, f.io)).rejects.toThrow();
    expect(await readFile(f.count, "utf8")).toBe("launch\n");
  }, 15_000);

  test("engine descendants cannot keep logs open after their leader finishes", async () => {
    const f = await fixture("fork");
    const start = Date.now();
    const result = await runAmberSlurmStage(f.capsule, f.profile, undefined, f.io);
    expect(result.exitCode).toBe(0);
    expect(Date.now() - start).toBeLessThan(3000);
    const pid = (await readFile(join(f.root, "child-pid"), "utf8")).trim();
    try {
      expect((await readFile(`/proc/${pid}/stat`, "utf8")).split(" ")[2]).toBe("Z");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  });

  test("unbounded stdout is capped and stops the engine instead of filling scratch", async () => {
    const f = await fixture("flood");
    const result = await runAmberSlurmStage(f.capsule, f.profile, undefined, f.io);
    expect(result.exitCode).not.toBe(0);
    expect(result.receipt.supervision?.stopReason).toBe("log_limit");
    expect(
      (await stat(join(f.workspace, ".eigengrid/engine.stdout.log"))).size,
    ).toBeLessThanOrEqual(1024 * 1024);
    expect(await readFile(f.count, "utf8")).toBe("launch\n");
  }, 10_000);
});

describe("resumable worker result transfer, no canonical ACK", () => {
  test("interrupted object copy resumes, validates all hashes and publishes receipt last", async () => {
    const f = await fixture();
    const run = await runAmberSlurmStage(f.capsule, f.profile, undefined, f.io);
    const source = f.objects();
    const target = new ContentAddressedArtifactStore(join(f.root, "head-artifacts"));
    try {
      await source.init();
      await target.init();
      const original = target.putStream.bind(target);
      let copies = 0;
      target.putStream = async (...args) => {
        if (++copies === 8) throw new Error("injected collection interruption");
        return original(...args);
      };
      await expect(
        copyAmberWorkerResult(source, target, run.reference, f.capsule, f.profile),
      ).rejects.toThrow("interruption");
      await expect(target.verify(run.reference.sha256)).rejects.toThrow();
      target.putStream = original;
      const result = await copyAmberWorkerResult(
        source,
        target,
        run.reference,
        f.capsule,
        f.profile,
      );
      expect(result).toEqual({
        receipt: run.receipt,
        reference: run.reference,
        canonicalAcknowledged: false,
      });
      expect(
        await verifyAmberWorkerReceipt(target, result.receipt, f.capsule, f.profile, f.bundle),
      ).toEqual(run.receipt);
      expect(
        await copyAmberWorkerResult(source, target, run.reference, f.capsule, f.profile),
      ).toEqual(result);
      expect(await readFile(f.count, "utf8")).toBe("launch\n");
      for (const changed of [
        { ...run.receipt, jobId: "999" },
        { ...run.receipt, uid: run.receipt.uid + 1 },
        { ...run.receipt, capsuleDigest: D("9") },
        { ...run.receipt, outputs: run.receipt.outputs.slice(1) },
        { ...run.receipt, engine: { ...run.receipt.engine, exitCode: 42 } },
      ])
        await expect(
          verifyAmberWorkerReceipt(target, changed, f.capsule, f.profile, f.bundle),
        ).rejects.toThrow();
    } finally {
      await source.close();
      await target.close();
    }
  });
});

describe("descriptor-anchored scratch and root-only site configuration", () => {
  test("rejects traversal, symlink/hardlink artifacts and user-controlled site profiles", async () => {
    const f = await fixture();
    const root = await openAmberScratchRoot(f.profile.scratchRoot, userInfo().uid);
    try {
      const work = await privateChild(root, "unit", userInfo().uid, true);
      try {
        for (const path of ["../escape", "a/../escape", "/tmp/escape", "a//b"])
          await expect(logicalParent(work, path, userInfo().uid, true)).rejects.toThrow();
        const source = join(f.profile.scratchRoot, "unit", "source");
        await writeFile(source, "fixture", { mode: 0o600 });
        await symlink(source, join(f.profile.scratchRoot, "unit", "alias"));
        await expect(openAmberFile(work, "alias", userInfo().uid)).rejects.toThrow();
        await link(source, join(f.profile.scratchRoot, "unit", "hardlink"));
        await expect(openAmberFile(work, "hardlink", userInfo().uid)).rejects.toThrow("Unsafe");
        await writeAmberMetadata(work, "record.json", Buffer.from("{}"));
        await expect(writeAmberMetadata(work, "record.json", Buffer.from("new"))).rejects.toThrow();
        expect(await readFile(join(f.profile.scratchRoot, "unit", "record.json"), "utf8")).toBe(
          "{}",
        );
      } finally {
        await work.close();
      }
    } finally {
      await root.close();
    }
    const unsafe = join(f.root, "profile.json");
    await writeFile(unsafe, canonicalJson(f.profile));
    await expect(loadAmberSlurmSiteProfile(unsafe)).rejects.toThrow("untrusted");
    await symlink(f.profile.scratchRoot, join(f.root, "alias-scratch"));
    await expect(
      openAmberScratchRoot(join(f.root, "alias-scratch"), userInfo().uid),
    ).rejects.toThrow("canonical");
  });

  test("staging rehashes the consumed CAS stream and a partial file never becomes permission to execute", async () => {
    const f = await fixture();
    const root = await openPrivateDirectory(f.profile.scratchRoot, userInfo().uid);
    const item = f.bundle.manifest.inputs[0]!;
    try {
      await expect(
        stageAmberInput(
          f.store,
          { sha256: item.sha256, sizeBytes: item.sizeBytes + 1 },
          root,
          "bad/input",
          userInfo().uid,
        ),
      ).rejects.toThrow("size");
      await expect(
        stageAmberInput(
          f.store,
          { sha256: item.sha256, sizeBytes: item.sizeBytes },
          root,
          "bad/input",
          userInfo().uid,
        ),
      ).rejects.toThrow();
      expect(await readdir(f.profile.scratchRoot)).toEqual(["bad"]);
      await expect(stat(f.count)).rejects.toThrow();
    } finally {
      await root.close();
    }
  });
});
