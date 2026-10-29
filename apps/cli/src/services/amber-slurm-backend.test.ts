import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  ContentAddressedArtifactStore,
  type MdSubmissionAuthority,
} from "@eigengrid/mission-runtime";
import { canonicalJson } from "@eigengrid/scientific-schema";
import {
  createSlurmSubmissionBinding,
  slurmScriptDigest,
  type SlurmSubmissionAcknowledgement,
  type SlurmSubmissionBinding,
  type SlurmSubmissionResolution,
  type SubmitterCapability,
} from "@eigengrid/slurm";
import { syntheticAmberBundleFixture } from "./amber-stage-bundle.fixture";
import { SYNTHETIC_PMEMD_CUDA_SHA256, syntheticGpuAmberSeed } from "./amber-gpu-test-fixture";
import { publishAmberStageBundle, readAmberStageBundle } from "./amber-stage-bundle";
import {
  AmberSlurmSubmitterBackend,
  verifyRootOwnedAmberBinary,
  type AmberSlurmBackendIO,
} from "./amber-slurm-backend";
import { parseAmberSlurmDeliveryBytes, type AmberSlurmDeliveryBody } from "./amber-slurm-delivery";
import {
  assertAmberSlurmSiteProfile,
  buildAdmittedAmberSlurmBody,
  computeAmberSlurmSiteProfileDigest,
  type AmberSlurmSiteProfile,
} from "./amber-slurm-profile";

const D = (char: string) => char.repeat(64);
const epoch = Date.parse("2026-09-20T10:00:00.000Z");
const stores: { root: string; store: ContentAddressedArtifactStore }[] = [];
afterEach(async () => {
  for (const { root, store } of stores.splice(0)) {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

/** Real CAS/canonical render; synthetic molecular bytes, fixture admission and
 * mocked Slurm are NOT a real approved mission, engine run or cluster evidence.
 */
async function fixture(gpu = false) {
  const root = await mkdtemp(join(tmpdir(), "eg-amber-backend-"));
  const store = new ContentAddressedArtifactStore(root);
  stores.push({ root, store });
  await store.init();
  const { seed: cpuSeed } = await syntheticAmberBundleFixture(store, {
    resourceProfile: { cpuCores: 1, memoryBytes: 128 * 1024 * 1024 },
  });
  const seed = gpu
    ? await syntheticGpuAmberSeed(store, { cpuCores: 1, memoryBytes: 128 * 1024 * 1024 })
    : cpuSeed;
  const bundle = await publishAmberStageBundle(store, seed);
  const profile: AmberSlurmSiteProfile = {
    schemaVersion: "eigengrid.amber-slurm-site/v1",
    profilePath: "/etc/eigengrid/amber-fixture.json",
    transport: {
      cluster: "fixture-cluster",
      slurmVersion: "23.11.4",
      uid: userInfo().uid,
      username: userInfo().username,
      home: userInfo().homedir,
      submissionDirectory: join(userInfo().homedir, ".eg-submit"),
      siteProfileDigest: D("0"),
      partition: "chem",
      node: "worker-01",
      account: "fixture-account",
      cpuLimit: 2,
      memoryMiBLimit: 1024,
      walltimeLimitSeconds: 3600,
      ...(gpu ? { gpuType: "a100", gpuLimit: 1 as const } : {}),
    },
    gid: userInfo().gid,
    runnerExecutable: "/opt/apps/eigengrid-test/amber-runner",
    runnerSha256: D("9"),
    amberHome: "/opt/apps/ambertools-test",
    sanderSha256: seed.request.environment.binaryDigest,
    ...(gpu
      ? {
          pmemdCudaSha256: SYNTHETIC_PMEMD_CUDA_SHA256,
          gpuLibraryTreeSha256: D("b"),
        }
      : {}),
    amberVersion: seed.request.environment.engine.version,
    engineEnvironmentDigest: seed.request.environment.engineEnvironmentDigest,
    scratchRoot: "/scratch/eigengrid",
    projects: [{ subject: "fixture-user", projectId: "project-1", publicationRoot: root }],
  };
  profile.transport.siteProfileDigest = computeAmberSlurmSiteProfileDigest(profile);
  const principal = {
    subject: "fixture-user",
    projectId: "project-1",
    uid: profile.transport.uid,
    gid: profile.gid,
    siteProfileDigest: profile.transport.siteProfileDigest,
  };
  // Only a pure-builder contract fixture. Production obtains this structure by
  // locking/revalidating the admitted PostgreSQL operation, not by casting it.
  const authority = {
    operation: { id: "amber-operation-1", request: seed.request },
    admission: { admissionDigest: D("1"), fencingGeneration: 7 },
    stage: seed.stage,
    checkedAt: new Date(epoch).toISOString(),
    expiresAt: new Date(epoch + 60_000).toISOString(),
  } as unknown as MdSubmissionAuthority;
  const body = buildAdmittedAmberSlurmBody(authority, principal, bundle, profile);
  const bytes = Buffer.from(canonicalJson(body));
  const capability: SubmitterCapability = {
    version: "eigengrid.submitter-capability/v1",
    action: "submit",
    requestId: "request-1",
    ...principal,
    recoveryEpoch: "test-epoch-1",
    membershipGeneration: 1,
    operationId: body.binding.operationId,
    requestDigest: body.binding.requestDigest,
    admissionDigest: body.binding.admissionDigest,
    bindingDigest: body.binding.bindingDigest,
    bodyDigest: slurmScriptDigest(bytes),
    fencingGeneration: authority.admission.fencingGeneration,
    notBeforeMs: epoch,
    expiresAtMs: epoch + 60_000,
  };
  const submissions: { binding: SlurmSubmissionBinding; script: Uint8Array }[] = [];
  const observations: SlurmSubmissionBinding[] = [];
  const checks: [string, string][] = [];
  const reads: string[] = [];
  const clock = { value: epoch + 1 };
  const result: SlurmSubmissionResolution = {
    status: "indeterminate",
    resubmitAllowed: false,
    reason: "No durable accounting match yet",
    observations: [],
  };
  const ack: SlurmSubmissionAcknowledgement = {
    status: "acknowledged",
    jobId: "43",
    cluster: profile.transport.cluster,
    resubmitAllowed: false,
  };
  const transport = {
    async sendAdmitted(binding: SlurmSubmissionBinding, script: Uint8Array) {
      submissions.push({ binding, script });
      return ack;
    },
    async discover(binding: SlurmSubmissionBinding) {
      observations.push(binding);
      return result;
    },
  };
  const io: AmberSlurmBackendIO = {
    async readBundle(path, delivery) {
      reads.push(path);
      const reader = new ContentAddressedArtifactStore(path, { access: "read-only" });
      try {
        await reader.init();
        return await readAmberStageBundle(reader, delivery.bundle, delivery.request);
      } finally {
        await reader.close();
      }
    },
    async verifyBinary(path, digest) {
      checks.push([path, digest]);
    },
  };
  const backend = new AmberSlurmSubmitterBackend(profile, transport, io, () => clock.value);
  return {
    profile,
    principal,
    authority,
    bundle,
    body,
    bytes,
    capability,
    submissions,
    observations,
    checks,
    reads,
    clock,
    transport,
    io,
    backend,
    result,
  };
}

describe("typed Amber backend inside per-UID journal boundary", () => {
  test("reconstructs verified CAS inputs and exact frozen script, no effect before submit", async () => {
    const f = await fixture();
    const token = await f.backend.prepare(f.capability, f.bytes);
    expect(Object.isFrozen(token)).toBe(true);
    expect(f.reads).toEqual([f.profile.projects[0]!.publicationRoot]);
    expect(f.checks).toEqual([
      [join(f.profile.amberHome, "bin/sander"), f.profile.sanderSha256],
      [f.profile.runnerExecutable, f.profile.runnerSha256],
    ]);
    expect(f.submissions).toHaveLength(0);
    expect(await f.backend.submit(token)).toMatchObject({ status: "acknowledged", jobId: "43" });
    expect(f.submissions).toHaveLength(1);
    expect(f.submissions[0]!.binding).toEqual(f.body.binding);
    expect(slurmScriptDigest(f.submissions[0]!.script)).toBe(f.body.binding.scriptDigest);
    expect(Buffer.from(f.submissions[0]!.script).toString()).not.toContain("engine.started.json");
    await expect(f.backend.submit(token)).rejects.toThrow("No exact prepared");
    await expect(f.backend.submit({ ...token })).rejects.toThrow("No exact prepared");
    await expect(f.backend.observe(token)).rejects.toThrow("No exact prepared");
    expect(f.submissions).toHaveLength(1);
  });

  test("GPU admission verifies the exact synthetic pmemd.cuda binary and binds one GPU", async () => {
    const f = await fixture(true);
    expect(f.body.binding.resources.gpuCount).toBe(1);
    expect(f.body.request.environment.engine.executable).toBe("pmemd.cuda");
    const token = await f.backend.prepare(f.capability, f.bytes);
    expect(f.checks).toEqual([
      [join(f.profile.amberHome, "bin/pmemd.cuda"), SYNTHETIC_PMEMD_CUDA_SHA256],
      [f.profile.runnerExecutable, f.profile.runnerSha256],
    ]);
    await expect(f.backend.submit(token)).resolves.toMatchObject({ status: "acknowledged" });
    expect(f.submissions[0]!.binding.resources.gpuCount).toBe(1);

    const withoutGpuBinding = structuredClone(f.body);
    delete withoutGpuBinding.binding.resources.gpuCount;
    await expect(
      f.backend.prepare(f.capability, Buffer.from(canonicalJson(withoutGpuBinding))),
    ).rejects.toThrow();
  });

  test("pure Head builder binds manifest, live request/stage, principal and profile", async () => {
    const f = await fixture();
    expect(buildAdmittedAmberSlurmBody(f.authority, f.principal, f.bundle, f.profile)).toEqual(
      f.body,
    );
    for (const change of [
      { ...f.bundle, reference: { ...f.bundle.reference, sha256: D("2") } },
      {
        ...f.bundle,
        reference: { ...f.bundle.reference, sizeBytes: f.bundle.reference.sizeBytes + 1 },
      },
    ])
      expect(() =>
        buildAdmittedAmberSlurmBody(f.authority, f.principal, change, f.profile),
      ).toThrow();
    const changed = structuredClone(f.authority);
    changed.stage.resourceProfile.cpuCores++;
    expect(() => buildAdmittedAmberSlurmBody(changed, f.principal, f.bundle, f.profile)).toThrow(
      "exact live admission",
    );
    expect(() =>
      buildAdmittedAmberSlurmBody(
        f.authority,
        { ...f.principal, projectId: "other" },
        f.bundle,
        f.profile,
      ),
    ).toThrow("not provisioned");
    expect(() =>
      buildAdmittedAmberSlurmBody(
        f.authority,
        { ...f.principal, gid: f.principal.gid + 1 },
        f.bundle,
        f.profile,
      ),
    ).toThrow("provisioned identity");
    const stale = structuredClone(f.profile);
    stale.runnerSha256 = D("8");
    expect(() => assertAmberSlurmSiteProfile(stale)).toThrow("digest mismatch");
    stale.transport.siteProfileDigest = computeAmberSlurmSiteProfileDigest(stale);
    expect(() => buildAdmittedAmberSlurmBody(f.authority, f.principal, f.bundle, stale)).toThrow();
    expect(parseAmberSlurmDeliveryBytes(f.bytes)).toEqual(f.body);
  });

  test("closed canonical wire rejects duplicate keys, injections and alternative encoding", async () => {
    const f = await fixture();
    const text = f.bytes.toString();
    for (const bytes of [
      Buffer.from(text + "\n"),
      Buffer.from("\ufeff" + text),
      Buffer.from('{"schemaVersion":"ignored",' + text.slice(1)),
      Buffer.from(canonicalJson({ ...f.body, command: "id" })),
      Buffer.from([0xff]),
      Buffer.alloc(512 * 1024 + 1),
      Buffer.alloc(0),
    ])
      expect(() => parseAmberSlurmDeliveryBytes(bytes)).toThrow();
    expect(f.submissions).toHaveLength(0);
  });

  test("capability/body/UID/project/engine/fence changes never reach Slurm", async () => {
    const f = await fixture();
    for (const change of [
      { uid: f.capability.uid + 1 },
      { gid: f.capability.gid + 1 },
      { subject: "different" },
      { projectId: "different" },
      { siteProfileDigest: D("a") },
      { operationId: "other" },
      { requestDigest: D("b") },
      { admissionDigest: D("c") },
      { bindingDigest: D("d") },
      { bodyDigest: D("e") },
      { fencingGeneration: 8 },
      { notBeforeMs: epoch - 1, expiresAtMs: epoch + 59_999 },
    ])
      await expect(f.backend.prepare({ ...f.capability, ...change }, f.bytes)).rejects.toThrow();
    expect(f.submissions).toHaveLength(0);
    const profile = structuredClone(f.profile);
    profile.sanderSha256 = D("2");
    profile.transport.siteProfileDigest = computeAmberSlurmSiteProfileDigest(profile);
    expect(() =>
      buildAdmittedAmberSlurmBody(
        f.authority,
        { ...f.principal, siteProfileDigest: profile.transport.siteProfileDigest },
        f.bundle,
        profile,
      ),
    ).toThrow("engine");
  });

  test("self-consistent forged script/resource binding is not a verified canonical render", async () => {
    const f = await fixture();
    for (const change of [
      { scriptDigest: D("a") },
      { resources: { ...f.body.binding.resources, cpus: 2 } },
      { resources: { ...f.body.binding.resources, partition: "other" } },
      { resources: { ...f.body.binding.resources, cpus: 3 } },
    ]) {
      const body: AmberSlurmDeliveryBody = {
        ...f.body,
        binding: createSlurmSubmissionBinding({ ...f.body.binding, ...change }),
      };
      const bytes = Buffer.from(canonicalJson(body));
      await expect(
        f.backend.prepare(
          {
            ...f.capability,
            bindingDigest: body.binding.bindingDigest,
            bodyDigest: slurmScriptDigest(bytes),
          },
          bytes,
        ),
      ).rejects.toThrow();
    }
    expect(f.submissions).toHaveLength(0);
  });

  test("storage/hash/engine verification failure is pre-effect, not a fallback", async () => {
    for (const phase of ["readBundle", "verifyBinary"] as const) {
      const f = await fixture();
      f.io[phase] = async () => {
        throw new Error("injected " + phase);
      };
      await expect(f.backend.prepare(f.capability, f.bytes)).rejects.toThrow("injected");
      expect(f.submissions).toHaveLength(0);
    }
  });

  test("snapshots caller inputs before asynchronous verification", async () => {
    const f = await fixture();
    const originalRead = f.io.readBundle;
    f.io.readBundle = async (...args) => {
      f.capability.operationId = "mutated-after-await";
      f.bytes.fill(0);
      return originalRead(...args);
    };
    const token = await f.backend.prepare(f.capability, f.bytes);
    await f.backend.submit(token);
    expect(f.submissions[0]!.binding.operationId).toBe("amber-operation-1");
  });

  test("expiry during preparation or before effect closes the prepared token", async () => {
    const f = await fixture();
    const read = f.io.readBundle;
    f.io.readBundle = async (...args) => {
      const bundle = await read(...args);
      f.clock.value = epoch + 60_000;
      return bundle;
    };
    await expect(f.backend.prepare(f.capability, f.bytes)).rejects.toThrow("live window");
    f.io.readBundle = read;
    f.clock.value = epoch + 1;
    const token = await f.backend.prepare(f.capability, f.bytes);
    f.clock.value = epoch + 60_000;
    await expect(f.backend.submit(token)).rejects.toThrow("live window");
    f.clock.value = epoch + 1;
    await expect(f.backend.submit(token)).rejects.toThrow("No exact prepared");
    expect(f.submissions).toHaveLength(0);
  });

  test("historical observation needs fresh authority, not live inputs/software or a new job", async () => {
    const f = await fixture();
    f.clock.value = epoch + 86_400_000;
    f.io.readBundle = async () => {
      throw new Error("NFS unavailable");
    };
    f.io.verifyBinary = async () => {
      throw new Error("software unavailable");
    };
    const cap: SubmitterCapability = {
      ...f.capability,
      action: "observe",
      notBeforeMs: f.clock.value - 1,
      expiresAtMs: f.clock.value + 59_999,
    };
    const token = await f.backend.prepare(cap, f.bytes);
    await expect(f.backend.submit(token)).rejects.toThrow("No exact prepared");
    expect(await f.backend.observe(token)).toEqual(f.result);
    expect(f.observations).toEqual([f.body.binding]);
    expect(f.reads).toHaveLength(0);
    expect(f.checks).toHaveLength(0);
    expect(f.submissions).toHaveLength(0);
    await expect(f.backend.observe(token)).rejects.toThrow("No exact prepared");
    await expect(
      f.backend.prepare({ ...cap, expiresAtMs: f.clock.value }, f.bytes),
    ).rejects.toThrow();
  });

  test("lost effect acknowledgement cannot reuse the process preparation", async () => {
    const f = await fixture();
    f.transport.sendAdmitted = async (binding, script) => {
      f.submissions.push({ binding, script });
      throw new Error("lost ACK after sbatch");
    };
    const token = await f.backend.prepare(f.capability, f.bytes);
    await expect(f.backend.submit(token)).rejects.toThrow("lost ACK");
    await expect(f.backend.submit(token)).rejects.toThrow("No exact prepared");
    expect(f.submissions).toHaveLength(1);
  });

  test("site profile rejects namespace overlap, duplicate authority and unsupported accounting", async () => {
    const f = await fixture();
    for (const change of [
      { scratchRoot: f.profile.transport.home },
      { scratchRoot: f.profile.projects[0]!.publicationRoot + "/scratch" },
      { projects: [...f.profile.projects, f.profile.projects[0]!] },
      { transport: { ...f.profile.transport, slurmVersion: "0.0.0" } },
      { transport: { ...f.profile.transport, submissionDirectory: "/tmp" } },
    ]) {
      const profile = {
        ...f.profile,
        ...change,
        transport: { ...f.profile.transport, ...change.transport },
      };
      profile.transport.siteProfileDigest = computeAmberSlurmSiteProfileDigest(profile);
      expect(() => assertAmberSlurmSiteProfile(profile)).toThrow();
    }
  });
});

describe("protected Amber binary identity (real filesystem)", () => {
  test("hashes a protected root binary and rejects a wrong release or writable ancestry", async () => {
    const hash = slurmScriptDigest(await readFile("/usr/bin/true"));
    await verifyRootOwnedAmberBinary("/usr/bin/true", hash);
    await expect(verifyRootOwnedAmberBinary("/usr/bin/true", D("0"))).rejects.toThrow(
      "pinned binary",
    );
    await expect(verifyRootOwnedAmberBinary("/tmp/not-a-protected-binary", hash)).rejects.toThrow(
      "untrusted",
    );
    await expect(verifyRootOwnedAmberBinary("/usr/bin/../bin/true", hash)).rejects.toThrow(
      "Invalid protected",
    );
  });
});
