import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, statfs, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  ContentAddressedArtifactStore,
  ContentAddressedStoreError,
} from "@eigengrid/mission-runtime";
import { DigestSchema, canonicalJson, digestCanonical } from "@eigengrid/scientific-schema";
import { SLURM_ENGINE_SUPERVISOR, slurmScriptDigest } from "@eigengrid/slurm";
import { verifyRootOwnedAmberBinary } from "./amber-slurm-backend";
import { verifyRootOwnedAmberLibraryTree } from "./amber-library-tree";
import {
  copyAmberStageBundle,
  AmberBundleReferenceSchema,
  readAmberStageBundle,
  type AmberBundleReference,
  type VerifiedAmberStageBundle,
} from "./amber-stage-bundle";
import {
  amberRunnerCapsuleDigest,
  amberEnginePath,
  amberEngineSha256,
  amberSlurmProject,
  assertAmberRunnerCapsule,
  assertAmberSlurmEngineResources,
  assertAmberSlurmSiteProfile,
  type AmberRunnerCapsule,
  type AmberSlurmSiteProfile,
} from "./amber-slurm-profile";
import {
  descriptorPath,
  logicalParent,
  openAmberFile,
  openAmberScratchRoot,
  openPrivateDirectory,
  privateChild,
  stableAmberFile,
  stageAmberInput,
  writeAmberMetadata,
} from "./amber-runner-files";

const jobId = z.string().regex(/^[1-9][0-9]{0,19}$/u);
const reference = z
  .object({ sha256: DigestSchema, sizeBytes: z.number().int().nonnegative().safe() })
  .strict();
const ns = z.string().regex(/^[1-9][0-9]{0,23}$/u);
export const AmberEngineExitSchema = z
  .object({
    schema: z.literal("eigengrid.engine-exit/v1"),
    commandDigest: DigestSchema,
    claimDigest: DigestSchema,
    startedAtNs: ns,
    finishedAtNs: ns,
    exitCode: z.number().int().min(0).max(255).nullable(),
    signal: z.number().int().min(1).max(64).nullable(),
    supervisorSignals: z.array(z.number().int().min(1).max(64)).max(128),
    executionError: z.string().max(1024).nullable(),
  })
  .strict()
  .refine(
    (v) =>
      (v.exitCode === null) !== (v.signal === null) &&
      BigInt(v.finishedAtNs) >= BigInt(v.startedAtNs),
    "Invalid engine exit observation",
  );
const startSchema = z
  .object({
    schema: z.literal("eigengrid.engine-start/v1"),
    commandDigest: DigestSchema,
    startedAtNs: ns,
    hostname: z.string().min(1).max(128),
    uid: z.number().int().positive(),
    gid: z.number().int().positive(),
    slurmJobId: jobId,
  })
  .strict();
const supervisionSchema = z
  .object({
    exitCode: z.number().int().min(0).max(255),
    stopReason: z.enum(["cancelled", "deadline", "log_limit"]).nullable(),
    stdoutBytes: z.number().int().nonnegative().safe(),
    stderrBytes: z.number().int().nonnegative().safe(),
  })
  .strict();
export const AmberWorkerReceiptSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.amber-worker-receipt/v1"),
    capsuleDigest: DigestSchema,
    requestDigest: DigestSchema,
    operationId: z.string().min(1).max(128),
    admissionDigest: DigestSchema,
    uid: z.number().int().positive(),
    gid: z.number().int().positive(),
    node: z.string().min(1).max(128),
    cluster: z.string().min(1).max(128),
    jobId,
    engine: AmberEngineExitSchema,
    supervision: supervisionSchema.nullable(),
    engineClaim: reference,
    engineReceipt: reference,
    inputsIntact: z.boolean(),
    artifactStatus: z.enum(["complete", "incomplete"]),
    outputs: z
      .array(
        z
          .object({
            role: z.string().min(1).max(80),
            logicalPath: z.string().min(1).max(512),
            mediaType: z.string().min(1).max(120),
            status: z.enum(["present", "missing", "empty", "invalid"]),
            object: reference.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    qcStatus: z.literal("not_evaluated"),
    scientificVerdict: z.literal("not_evaluated"),
  })
  .strict();
export type AmberWorkerReceipt = z.infer<typeof AmberWorkerReceiptSchema>;

export const AmberResultObservationSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.amber-result-observation/v1"),
    capsuleDigest: DigestSchema,
    bindingDigest: DigestSchema,
    jobId,
    transfer: z
      .object({
        schemaVersion: z.literal("eigengrid.amber-result-transfer/v1"),
        transferId: z.string().uuid(),
        observedAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict();

type ResultSpoolFactory = typeof import("./amber-result-spool").createAmberResultSpool;
type ResultSpool = Awaited<ReturnType<ResultSpoolFactory>>;

export interface AmberRunnerHost {
  uid: number;
  gid: number;
  node: string;
  cluster: string;
  jobId: string;
  jobName?: string;
  cpus: number;
  memoryMiB: number;
  gpusOnNode?: number;
  cudaVisibleDevices?: string;
  ordinaryBatch: boolean;
}
export interface AmberRunnerIO {
  host: () => AmberRunnerHost;
  verifyBinary: typeof verifyRootOwnedAmberBinary;
  verifyLibraryTree: typeof verifyRootOwnedAmberLibraryTree;
  checkDisk: (root: FileHandle, scratchBytes: number) => Promise<void>;
  /** Test port only; CLI always loads the protected root configuration. */
  resultSpool?: ResultSpoolFactory;
}
/** Slurm 23 export=NIL may omit its cluster variable. The fallback is fixed
 * in the protected, digest-verified launcher; conflicting native identity wins
 * and remains subject to the unchanged worker/profile equality check. */
export function amberRunnerClusterIdentity(
  nativeCluster: string | undefined,
  protectedLaunchCluster: string | undefined,
): string {
  return nativeCluster ?? protectedLaunchCluster ?? "";
}
const productionIO: AmberRunnerIO = {
  host: () => ({
    uid: process.getuid!(),
    gid: process.getgid!(),
    node: hostname(),
    cluster: amberRunnerClusterIdentity(
      process.env.SLURM_CLUSTER_NAME,
      process.env.EIGENGRID_SLURM_CLUSTER,
    ),
    jobId: process.env.SLURM_JOB_ID ?? "",
    jobName: process.env.SLURM_JOB_NAME,
    cpus: Number(process.env.SLURM_CPUS_PER_TASK),
    memoryMiB: Number(process.env.SLURM_MEM_PER_NODE),
    gpusOnNode: Number(process.env.SLURM_GPUS_ON_NODE ?? "0"),
    cudaVisibleDevices: process.env.CUDA_VISIBLE_DEVICES,
    ordinaryBatch:
      process.env.SLURMD_NODENAME === hostname() &&
      !process.env.SLURM_ARRAY_JOB_ID &&
      !process.env.SLURM_HET_SIZE &&
      (!process.env.SLURM_RESTART_COUNT || process.env.SLURM_RESTART_COUNT === "0"),
  }),
  verifyBinary: verifyRootOwnedAmberBinary,
  verifyLibraryTree: verifyRootOwnedAmberLibraryTree,
  async checkDisk(root, scratchBytes) {
    const disk = await statfs(descriptorPath(root), { bigint: true });
    // Qualified local filesystems only, never NFS trajectory scratch.
    if (
      ![0xef53n, 0x58465342n].includes(disk.type) ||
      disk.bavail * disk.bsize < BigInt(scratchBytes) * 4n + 64n * 1024n * 1024n ||
      disk.ffree < 1024n
    )
      throw new Error("Amber needs local ext4/XFS scratch with sufficient bytes and inodes");
  },
};

/** Closed operational diagnostics, never allocation authority or scientific QC. */
export function amberRunnerAllocationObservation(host: AmberRunnerHost = productionIO.host()) {
  const word = (v: string | undefined, pattern: RegExp) =>
    v !== undefined && v.length <= 128 && pattern.test(v) ? v : null;
  const count = (v: number | undefined) =>
    v !== undefined && Number.isSafeInteger(v) && v >= 0 ? v : null;
  return {
    schemaVersion: "eigengrid.amber-runner-allocation-observation/v1",
    workerUid: count(host.uid),
    workerGid: count(host.gid),
    workerNode: word(host.node, /^[A-Za-z0-9_.-]+$/),
    slurmCluster: word(host.cluster, /^[A-Za-z0-9_.-]+$/),
    slurmJobId: word(host.jobId, /^[1-9][0-9]*$/),
    ordinaryBatch: host.ordinaryBatch,
    cpuCores: count(host.cpus),
    memoryMiB: count(host.memoryMiB),
    gpusOnNode: count(host.gpusOnNode),
    cudaVisibleDevices: word(host.cudaVisibleDevices, /^[A-Za-z0-9,_.:-]+$/),
  };
}

function hostIdentity(
  host: AmberRunnerHost,
  capsule: AmberRunnerCapsule,
  profile: AmberSlurmSiteProfile,
) {
  jobId.parse(host.jobId);
  if (
    process.platform !== "linux" ||
    host.uid !== capsule.uid ||
    host.gid !== capsule.gid ||
    host.node !== profile.transport.node ||
    host.cluster !== profile.transport.cluster ||
    !host.ordinaryBatch
  )
    throw new Error("Amber runner is outside its scientific UID/worker Slurm allocation");
}

function actualArgv(
  bundle: VerifiedAmberStageBundle,
  workspace: string,
  profile: AmberSlurmSiteProfile,
): string[] {
  const command = bundle.rendered.commandRequest;
  if (command.executable !== bundle.manifest.request.environment.engine.executable)
    throw new Error("Amber command differs from its exact environment engine");
  const paths = new Set([...command.inputs, ...command.outputs].map((p) => p.logicalPath));
  return [
    amberEnginePath(profile, command.executable),
    ...command.argv.map((word) => (paths.has(word) ? join(workspace, word) : word)),
  ];
}
function checkReservedPaths(bundle: VerifiedAmberStageBundle) {
  for (const { logicalPath } of [
    ...bundle.rendered.commandRequest.inputs,
    ...bundle.rendered.commandRequest.outputs,
  ]) {
    if (
      logicalPath
        .split("/")
        .some((part) => ["engine.started.json", "engine.exit.json", "exit.status"].includes(part))
    )
      throw new Error("Amber scientific paths collide with runner evidence");
  }
}

async function readBounded(file: FileHandle, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stableAmberFile(file, limit)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function readEvidence(workspace: FileHandle, cwd: string, name: string, uid: number) {
  const file = await openAmberFile(workspace, `${cwd}/${name}`, uid);
  try {
    return await readBounded(file, 64 * 1024);
  } finally {
    await file.close();
  }
}

/** Runs only a fixed verified Amber engine argv. No DB, Slurm submit/cancel, SSH,
 * approvals, canonical ACK, or scientific verdict is available to this worker.
 * A repeat capsule cannot reuse an existing workspace, even after SIGKILL.
 */
export async function runAmberSlurmStage(
  capsuleValue: unknown,
  profileValue: unknown,
  signal?: AbortSignal,
  io: AmberRunnerIO = productionIO,
) {
  const profile = assertAmberSlurmSiteProfile(profileValue);
  const capsule = assertAmberRunnerCapsule(capsuleValue, profile);
  const host = io.host();
  hostIdentity(host, capsule, profile);
  // The job-name digest is an untrusted observation. Only Head compares it with
  // durable submission authority; preserving it avoids a new wire argument.
  let resultSpool: ResultSpool | undefined;
  let observation: z.infer<typeof AmberResultObservationSchema> | undefined;
  if (profile.resultPublicationConfigPath) {
    const match = /^egv1-([a-f0-9]{64})$/u.exec(host.jobName ?? "");
    if (!match) throw new Error("Amber result publication requires the full Slurm job-name digest");
    resultSpool = await (
      io.resultSpool ?? (await import("./amber-result-spool")).createAmberResultSpool
    )(profile.resultPublicationConfigPath);
    if (canonicalJson(resultSpool.siteProfile) !== canonicalJson(profile))
      throw new Error("Amber publication profile differs from runner profile");
    observation = AmberResultObservationSchema.parse({
      schemaVersion: "eigengrid.amber-result-observation/v1",
      capsuleDigest: amberRunnerCapsuleDigest(capsule),
      bindingDigest: match[1],
      jobId: host.jobId,
      transfer: {
        schemaVersion: "eigengrid.amber-result-transfer/v1",
        transferId: randomUUID(),
        observedAt: new Date().toISOString(),
      },
    });
  }
  const project = amberSlurmProject(profile, capsule.subject, capsule.projectId);
  const source = new ContentAddressedArtifactStore(project.publicationRoot, {
    access: "read-only",
  });
  const scratch = await openAmberScratchRoot(profile.scratchRoot, capsule.uid);
  let workspace: FileHandle | undefined, metadata: FileHandle | undefined;
  let objects: ContentAddressedArtifactStore | undefined;
  try {
    await source.init();
    const bundle = await readAmberStageBundle(source, capsule.bundle, capsule.request);
    checkReservedPaths(bundle);
    const resources = bundle.manifest.stage.resourceProfile;
    const engine = bundle.manifest.request.environment;
    assertAmberSlurmEngineResources(
      profile,
      engine.engine.executable,
      engine.binaryDigest,
      resources.gpuCount,
    );
    if (
      host.cpus !== resources.cpuCores ||
      host.memoryMiB !== Math.ceil(resources.memoryBytes / 1024 / 1024) ||
      (host.gpusOnNode ?? 0) !== resources.gpuCount ||
      (resources.gpuCount === 1 && !/^[0-9]+$/u.test(host.cudaVisibleDevices ?? "")) ||
      (resources.gpuCount === 0 && Boolean(host.cudaVisibleDevices))
    )
      throw new Error("Amber allocation differs from its exact admitted resources");
    await io.checkDisk(scratch, resources.scratchBytes);
    await io.verifyBinary(
      amberEnginePath(profile, engine.engine.executable),
      amberEngineSha256(profile, engine.engine.executable),
    );
    if (resources.gpuCount === 1) {
      if (!profile.gpuLibraryTreeSha256)
        throw new Error("Amber GPU library identity is not provisioned");
      await io.verifyLibraryTree(join(profile.amberHome, "lib"), profile.gpuLibraryTreeSha256);
    }
    await io.verifyBinary(profile.runnerExecutable, profile.runnerSha256);
    if (signal?.aborted) throw new Error("Amber stopped before workspace claim");
    const identity = amberRunnerCapsuleDigest(capsule);
    workspace = await privateChild(scratch, identity, capsule.uid, true);
    const path = join(profile.scratchRoot, identity);
    metadata = await privateChild(workspace, ".eigengrid", capsule.uid, true);
    await writeAmberMetadata(metadata, "capsule.json", Buffer.from(canonicalJson(capsule)));
    if (observation)
      await writeAmberMetadata(
        metadata,
        "result-observation.json",
        Buffer.from(canonicalJson(observation)),
      );
    objects = new ContentAddressedArtifactStore(join(path, ".eigengrid", "objects"));
    await objects.init();
    // Verified local copy: recovery/collection no longer depends on NFS inputs.
    await copyAmberStageBundle(source, objects, capsule.bundle, capsule.request);
    for (const input of bundle.manifest.inputs)
      await stageAmberInput(
        objects,
        { sha256: input.sha256, sizeBytes: input.sizeBytes },
        workspace,
        input.logicalPath,
        capsule.uid,
      );
    for (const output of bundle.rendered.commandRequest.outputs) {
      const parent = await logicalParent(workspace, output.logicalPath, capsule.uid, true);
      await parent.parent.close();
    }
    const cwdParent = await logicalParent(
      workspace,
      bundle.rendered.commandRequest.cwd + "/placeholder",
      capsule.uid,
      true,
    );
    await cwdParent.parent.close();
    if (signal?.aborted) throw new Error("Amber stopped before engine claim");
    const engineExit = await superviseEngine(
      actualArgv(bundle, path, profile),
      join(path, bundle.rendered.commandRequest.cwd),
      metadata,
      host,
      profile,
      resources.scratchBytes,
      resources.wallTimeSeconds,
      signal,
    );
    await writeAmberMetadata(metadata, "supervision.json", Buffer.from(canonicalJson(engineExit)));
    const result = await collectAmberSlurmStage(
      capsule,
      profile,
      io.host(),
      resultSpool ? async () => resultSpool! : undefined,
    );
    return {
      ...result,
      exitCode:
        engineExit.exitCode ||
        result.receipt.engine.exitCode ||
        (result.receipt.engine.signal ? 128 + result.receipt.engine.signal : 0) ||
        (result.receipt.artifactStatus === "complete" ? 0 : 74),
    };
  } finally {
    await objects?.close();
    await metadata?.close();
    await workspace?.close();
    await scratch.close();
    await source.close();
  }
}

async function superviseEngine(
  argv: string[],
  cwd: string,
  metadata: FileHandle,
  host: AmberRunnerHost,
  profile: AmberSlurmSiteProfile,
  fileLimit: number,
  wallSeconds: number,
  signal?: AbortSignal,
): Promise<z.infer<typeof supervisionSchema>> {
  const logs: FileHandle[] = [];
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let killed = false,
    exceeded = false;
  let stopReason: z.infer<typeof supervisionSchema>["stopReason"] = null;
  const sizes = [0, 0];
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: NonNullable<typeof stopReason>) => {
    if (killed || !child) return;
    killed = true;
    stopReason = reason;
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      child?.kill("SIGKILL");
    }, 6000);
  };
  const abort = () => stop("cancelled");
  const deadline = setTimeout(() => stop("deadline"), wallSeconds * 1000);
  try {
    for (const name of ["stdout", "stderr"])
      logs.push(
        await open(
          `${descriptorPath(metadata)}/engine.${name}.log`,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        ),
      );
    const code =
      `import resource\nresource.setrlimit(resource.RLIMIT_CORE, (0, 0))\nresource.setrlimit(resource.RLIMIT_FSIZE, (${fileLimit}, ${fileLimit}))\n` +
      SLURM_ENGINE_SUPERVISOR;
    child = Bun.spawn(["/usr/bin/python3", "-I", "-", ...argv], {
      cwd,
      stdin: new Blob([code]),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: "/usr/bin:/bin",
        LC_ALL: "C",
        TZ: "UTC",
        AMBERHOME: profile.amberHome,
        ...(host.cudaVisibleDevices ? { LD_LIBRARY_PATH: join(profile.amberHome, "lib") } : {}),
        HOME: profile.transport.home,
        USER: profile.transport.username,
        LOGNAME: profile.transport.username,
        OMP_NUM_THREADS: String(host.cpus),
        OPENBLAS_NUM_THREADS: "1",
        MKL_NUM_THREADS: "1",
        SLURM_JOB_ID: host.jobId,
        SLURM_CLUSTER_NAME: host.cluster,
        ...(host.cudaVisibleDevices ? { CUDA_VISIBLE_DEVICES: host.cudaVisibleDevices } : {}),
      },
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const drain = async (stream: ReadableStream<Uint8Array>, file: FileHandle, index: number) => {
      let count = 0;
      for await (const chunk of stream) {
        const retained = chunk.subarray(0, Math.max(0, 1024 * 1024 - count));
        count += chunk.length;
        if (retained.length) await file.writeFile(retained);
        if (count > 1024 * 1024) {
          exceeded = true;
          stop("log_limit");
        }
      }
      await file.sync();
      sizes[index] = count;
    };
    const [exitCode] = await Promise.all([
      child.exited,
      drain(child.stdout as ReadableStream<Uint8Array>, logs[0]!, 0),
      drain(child.stderr as ReadableStream<Uint8Array>, logs[1]!, 1),
    ]);
    return supervisionSchema.parse({
      exitCode: exitCode || (exceeded ? 74 : 0),
      stopReason,
      stdoutBytes: sizes[0],
      stderrBytes: sizes[1],
    });
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", abort);
    if (child && child.exitCode === null) {
      abort(); // supervisor escalates its own engine group before our deadline
      await child.exited;
    }
    clearTimeout(killTimer);
    await Promise.all(logs.map((file) => file.close()));
  }
}

/** Collection-only recovery. It never spawns an engine and never requires the
 * publication or engine binary to remain available. Immutable local CAS objects
 * can be transferred repeatedly; the Head must verify and replicate before ACK.
 */
export async function collectAmberSlurmStage(
  capsuleValue: unknown,
  profileValue: unknown,
  hostValue = productionIO.host(),
  resultSpoolFactory?: ResultSpoolFactory,
): Promise<{
  receipt: AmberWorkerReceipt;
  reference: AmberBundleReference;
  publication?: { reference: AmberBundleReference; canonicalAcknowledged: false };
}> {
  const profile = assertAmberSlurmSiteProfile(profileValue);
  const capsule = assertAmberRunnerCapsule(capsuleValue, profile);
  // Collection may run after allocation expiry, but only as the original UID on worker.
  if (
    hostValue.uid !== capsule.uid ||
    hostValue.gid !== capsule.gid ||
    hostValue.node !== profile.transport.node
  )
    throw new Error("Amber collection is outside its original worker/UID");
  const identity = amberRunnerCapsuleDigest(capsule);
  const path = join(profile.scratchRoot, identity);
  const scratch = await openAmberScratchRoot(profile.scratchRoot, capsule.uid);
  let workspace: FileHandle | undefined, metadata: FileHandle | undefined;
  const objects = new ContentAddressedArtifactStore(join(path, ".eigengrid", "objects"));
  try {
    workspace = await openPrivateDirectory(`${descriptorPath(scratch)}/${identity}`, capsule.uid);
    metadata = await openPrivateDirectory(`${descriptorPath(workspace)}/.eigengrid`, capsule.uid);
    const frozen = await openAmberFile(metadata, "capsule.json", capsule.uid);
    try {
      if ((await readBounded(frozen, 512 * 1024)).toString() !== canonicalJson(capsule))
        throw new Error("Local Amber workspace belongs to a different capsule");
    } finally {
      await frozen.close();
    }
    await objects.init();
    const bundle = await readAmberStageBundle(objects, capsule.bundle, capsule.request);
    checkReservedPaths(bundle);
    const command = bundle.rendered.commandRequest;
    async function stageOut(receipt: AmberWorkerReceipt, reference: AmberBundleReference) {
      if (!profile.resultPublicationConfigPath) return { receipt, reference };
      const file = await openAmberFile(metadata!, "result-observation.json", capsule.uid);
      let observation: z.infer<typeof AmberResultObservationSchema>;
      try {
        const bytes = await readBounded(file, 4096);
        observation = AmberResultObservationSchema.parse(JSON.parse(bytes.toString("utf8")));
        if (canonicalJson(observation) !== bytes.toString("utf8"))
          throw new Error("Noncanonical frozen result observation");
      } finally {
        await file.close();
      }
      if (observation.capsuleDigest !== identity || observation.jobId !== receipt.jobId)
        throw new Error("Frozen result observation differs from receipt/capsule");
      const spool = await (
        resultSpoolFactory ?? (await import("./amber-result-spool")).createAmberResultSpool
      )(profile.resultPublicationConfigPath);
      if (canonicalJson(spool.siteProfile) !== canonicalJson(profile))
        throw new Error("Amber publication profile differs from runner profile");
      const published = await spool.publish({
        capsule,
        source: objects,
        receiptReference: reference,
        observedBindingDigest: observation.bindingDigest,
        transfer: observation.transfer,
      });
      return {
        receipt,
        reference,
        publication: { reference: published.reference, canonicalAcknowledged: false as const },
      };
    }
    const existing = await readFrozenReceipt(metadata, capsule.uid);
    if (existing !== null) {
      await verifyAmberWorkerReceipt(objects, existing, capsule, profile, bundle);
      const stored = await objects.put(Buffer.from(canonicalJson(existing)));
      return await stageOut(existing, { sha256: stored.digest, sizeBytes: stored.sizeBytes });
    }
    const claimBytes = await readEvidence(
      workspace,
      command.cwd,
      "engine.started.json",
      capsule.uid,
    );
    const exitBytes = await readEvidence(workspace, command.cwd, "engine.exit.json", capsule.uid);
    const claim = startSchema.parse(JSON.parse(claimBytes.toString()));
    const engine = AmberEngineExitSchema.parse(JSON.parse(exitBytes.toString()));
    const expectedCommand = slurmScriptDigest(
      Buffer.from(JSON.stringify(actualArgv(bundle, path, profile))),
    );
    if (
      claim.commandDigest !== expectedCommand ||
      engine.commandDigest !== expectedCommand ||
      engine.claimDigest !== slurmScriptDigest(claimBytes) ||
      engine.startedAtNs !== claim.startedAtNs ||
      claim.uid !== capsule.uid ||
      claim.gid !== capsule.gid ||
      claim.hostname !== profile.transport.node
    )
      throw new Error("Amber engine receipt differs from its exact durable worker claim");
    let inputsIntact = true;
    for (const input of bundle.manifest.inputs) {
      try {
        const file = await openAmberFile(workspace, input.logicalPath, capsule.uid);
        try {
          const hash = createHash("sha256");
          let size = 0;
          for await (const bytes of stableAmberFile(file, input.sizeBytes)) {
            hash.update(bytes);
            size += bytes.length;
          }
          if (size !== input.sizeBytes || hash.digest("hex") !== input.sha256) inputsIntact = false;
        } finally {
          await file.close();
        }
      } catch {
        inputsIntact = false;
      }
    }
    const outputs: AmberWorkerReceipt["outputs"] = [];
    let remaining = bundle.manifest.stage.resourceProfile.scratchBytes;
    for (const output of command.outputs) {
      try {
        const file = await openAmberFile(workspace, output.logicalPath, capsule.uid);
        try {
          const stored = await objects.putStream(stableAmberFile(file, remaining), {
            maxBytes: Math.max(1, remaining),
          });
          remaining -= stored.sizeBytes;
          outputs.push({
            role: output.role,
            logicalPath: output.logicalPath,
            mediaType: output.mediaType,
            status: stored.sizeBytes ? "present" : "empty",
            object: { sha256: stored.digest, sizeBytes: stored.sizeBytes },
          });
        } finally {
          await file.close();
        }
      } catch (error) {
        // An interrupted/corrupt transfer must remain retriable collection,
        // never be frozen as a scientific missing artifact or rerun the engine.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        outputs.push({
          role: output.role,
          logicalPath: output.logicalPath,
          mediaType: output.mediaType,
          status: "missing",
          object: null,
        });
      }
    }
    const claimObject = await objects.put(claimBytes),
      exitObject = await objects.put(exitBytes);
    let supervision: z.infer<typeof supervisionSchema> | null = null;
    let supervisorFile: FileHandle | undefined;
    try {
      supervisorFile = await openAmberFile(metadata, "supervision.json", capsule.uid);
      const bytes = await readBounded(supervisorFile, 4096);
      supervision = supervisionSchema.parse(JSON.parse(bytes.toString()));
      if (canonicalJson(supervision) !== bytes.toString())
        throw new Error("Noncanonical runner supervision");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      await supervisorFile?.close();
    }
    const receipt = AmberWorkerReceiptSchema.parse({
      schemaVersion: "eigengrid.amber-worker-receipt/v1",
      capsuleDigest: identity,
      requestDigest: digestCanonical(capsule.request),
      operationId: capsule.operationId,
      admissionDigest: capsule.admissionDigest,
      uid: capsule.uid,
      gid: capsule.gid,
      node: profile.transport.node,
      cluster: profile.transport.cluster,
      jobId: claim.slurmJobId,
      engine,
      supervision,
      engineClaim: { sha256: claimObject.digest, sizeBytes: claimObject.sizeBytes },
      engineReceipt: { sha256: exitObject.digest, sizeBytes: exitObject.sizeBytes },
      inputsIntact,
      artifactStatus:
        inputsIntact && outputs.every((o) => o.status === "present") ? "complete" : "incomplete",
      outputs,
      qcStatus: "not_evaluated",
      scientificVerdict: "not_evaluated",
    });
    const stored = await objects.put(Buffer.from(canonicalJson(receipt)));
    try {
      await writeAmberMetadata(metadata, "receipt.json", Buffer.from(canonicalJson(receipt)));
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        canonicalJson(await readFrozenReceipt(metadata, capsule.uid)) !== canonicalJson(receipt)
      )
        throw error;
    }
    return await stageOut(receipt, { sha256: stored.digest, sizeBytes: stored.sizeBytes });
  } finally {
    await objects.close();
    await metadata?.close();
    await workspace?.close();
    await scratch.close();
  }
}

async function readFrozenReceipt(
  metadata: FileHandle,
  uid: number,
): Promise<AmberWorkerReceipt | null> {
  let file: FileHandle;
  try {
    file = await openAmberFile(metadata, "receipt.json", uid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const bytes = await readBounded(file, 1024 * 1024);
    const receipt = AmberWorkerReceiptSchema.parse(JSON.parse(bytes.toString()));
    if (canonicalJson(receipt) !== bytes.toString())
      throw new Error("Noncanonical frozen Amber receipt");
    return receipt;
  } finally {
    await file.close();
  }
}

/** Head/collector validation of a worker observation, not execution authority or
 * scientific QC. Accounting must independently corroborate this exact JobID/UID.
 */
export async function verifyAmberWorkerReceipt(
  objects: Pick<ContentAddressedArtifactStore, "get" | "verify">,
  receiptValue: unknown,
  capsuleValue: unknown,
  profileValue: unknown,
  bundle: VerifiedAmberStageBundle,
): Promise<AmberWorkerReceipt> {
  const profile = assertAmberSlurmSiteProfile(profileValue);
  const capsule = assertAmberRunnerCapsule(capsuleValue, profile);
  const receipt = AmberWorkerReceiptSchema.parse(receiptValue);
  if (
    receipt.capsuleDigest !== amberRunnerCapsuleDigest(capsule) ||
    receipt.requestDigest !== digestCanonical(capsule.request) ||
    receipt.operationId !== capsule.operationId ||
    receipt.admissionDigest !== capsule.admissionDigest ||
    receipt.uid !== capsule.uid ||
    receipt.gid !== capsule.gid ||
    receipt.node !== profile.transport.node ||
    receipt.cluster !== profile.transport.cluster ||
    canonicalJson(bundle.reference) !== canonicalJson(capsule.bundle) ||
    canonicalJson(bundle.manifest.request) !== canonicalJson(capsule.request)
  )
    throw new Error("Amber worker receipt differs from exact admitted capsule");
  const expected = bundle.rendered.commandRequest.outputs;
  if (receipt.outputs.length !== expected.length)
    throw new Error("Amber output inventory differs from its contract");
  let total = 0;
  for (const [index, output] of receipt.outputs.entries()) {
    const contract = expected[index]!;
    if (
      output.role !== contract.role ||
      output.logicalPath !== contract.logicalPath ||
      output.mediaType !== contract.mediaType ||
      (output.status === "present" || output.status === "empty") !== (output.object !== null) ||
      (output.object !== null && (output.status === "empty") !== (output.object.sizeBytes === 0))
    )
      throw new Error("Amber output inventory differs from its contract");
    if (output.object) {
      total += output.object.sizeBytes;
      const actual = await objects.verify(output.object.sha256);
      if (actual.sizeBytes !== output.object.sizeBytes)
        throw new Error("Amber artifact size mismatch");
    }
  }
  if (
    total > bundle.manifest.stage.resourceProfile.scratchBytes ||
    receipt.artifactStatus !==
      (receipt.inputsIntact && receipt.outputs.every((o) => o.status === "present")
        ? "complete"
        : "incomplete")
  )
    throw new Error("Amber artifact status/budget differs from its verified inventory");
  for (const item of [receipt.engineClaim, receipt.engineReceipt]) {
    if (item.sizeBytes > 64 * 1024 || item.sizeBytes === 0)
      throw new Error("Invalid bounded engine evidence");
    const actual = await objects.verify(item.sha256);
    if (actual.sizeBytes !== item.sizeBytes) throw new Error("Amber engine evidence size mismatch");
  }
  const claim = startSchema.parse(
    JSON.parse(Buffer.from((await objects.get(receipt.engineClaim.sha256)).bytes).toString()),
  );
  const engine = AmberEngineExitSchema.parse(
    JSON.parse(Buffer.from((await objects.get(receipt.engineReceipt.sha256)).bytes).toString()),
  );
  const path = join(profile.scratchRoot, receipt.capsuleDigest);
  const expectedCommand = slurmScriptDigest(
    Buffer.from(JSON.stringify(actualArgv(bundle, path, profile))),
  );
  if (
    canonicalJson(engine) !== canonicalJson(receipt.engine) ||
    engine.claimDigest !== receipt.engineClaim.sha256 ||
    engine.commandDigest !== expectedCommand ||
    claim.commandDigest !== expectedCommand ||
    claim.startedAtNs !== engine.startedAtNs ||
    claim.uid !== capsule.uid ||
    claim.gid !== capsule.gid ||
    claim.hostname !== profile.transport.node ||
    claim.slurmJobId !== receipt.jobId
  )
    throw new Error("Frozen engine evidence differs from its worker/capsule/JobID");
  return receipt;
}

/** Resume verified transfer by hash, publish the receipt LAST. A transfer error
 * never calls runAmberSlurmStage; complete scientific files are not recomputed.
 * This is not a canonical ACK: independent replication/reconciliation are Head
 * responsibilities, not inferred from a successful copy to one destination.
 */
export async function copyAmberWorkerResult(
  source: ContentAddressedArtifactStore,
  target: ContentAddressedArtifactStore,
  referenceValue: unknown,
  capsuleValue: unknown,
  profileValue: unknown,
) {
  const profile = assertAmberSlurmSiteProfile(profileValue);
  const capsule = assertAmberRunnerCapsule(capsuleValue, profile);
  const receiptReference = AmberBundleReferenceSchema.parse(referenceValue);
  if (receiptReference.sizeBytes > 1024 * 1024) throw new Error("Worker receipt exceeds its bound");
  const bytes = await source.get(receiptReference.sha256);
  if (bytes.sizeBytes !== receiptReference.sizeBytes)
    throw new Error("Worker receipt size mismatch");
  const text = Buffer.from(bytes.bytes).toString();
  const bundle = await readAmberStageBundle(source, capsule.bundle, capsule.request);
  const receipt = await verifyAmberWorkerReceipt(
    source,
    JSON.parse(text),
    capsule,
    profile,
    bundle,
  );
  if (text !== canonicalJson(receipt)) throw new Error("Worker receipt is not canonical");
  await copyAmberStageBundle(source, target, capsule.bundle, capsule.request);
  for (const object of [
    receipt.engineClaim,
    receipt.engineReceipt,
    ...receipt.outputs.flatMap((o) => (o.object ? [o.object] : [])),
  ]) {
    try {
      const found = await target.verify(object.sha256);
      if (found.sizeBytes !== object.sizeBytes) throw new Error("Receiving artifact size mismatch");
      continue;
    } catch (error) {
      if (!(error instanceof ContentAddressedStoreError) || error.code !== "NOT_FOUND") throw error;
    }
    const stream = await source.getStream(object.sha256);
    async function* exactBytes() {
      for await (const chunk of stream.bytes) {
        if (stream.sizeBytes !== object.sizeBytes || stream.digest !== object.sha256)
          throw new Error("Transferring artifact metadata mismatch");
        yield chunk;
      }
    }
    const stored = await target.putStream(exactBytes(), {
      maxBytes: Math.max(1, object.sizeBytes),
    });
    if (stored.digest !== object.sha256 || stored.sizeBytes !== object.sizeBytes)
      throw new Error("Transferring artifact hash/size mismatch");
  }
  await verifyAmberWorkerReceipt(target, receipt, capsule, profile, bundle);
  const stored = await target.put(bytes.bytes);
  if (stored.digest !== receiptReference.sha256 || stored.sizeBytes !== receiptReference.sizeBytes)
    throw new Error("Receiving worker receipt mismatch");
  return { receipt, reference: receiptReference, canonicalAcknowledged: false as const };
}
