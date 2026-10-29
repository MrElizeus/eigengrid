import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ContentAddressedArtifactStore } from "@eigengrid/mission-runtime";
import { canonicalJson } from "@eigengrid/scientific-schema";
import {
  SlurmSubmissionTransport,
  AnySubmitterCapabilitySchema,
  assertSubmitterAccountingResult,
  slurmScriptDigest,
  type AnySubmitterCapability,
  type SlurmAccountingRecord,
  type SubmitterAccountingResult,
  type SlurmSubmissionAcknowledgement,
} from "@eigengrid/slurm";
import { parseAmberSlurmDeliveryBytes, type AmberSlurmDeliveryBody } from "./amber-slurm-delivery";
import { readAmberStageBundle, type VerifiedAmberStageBundle } from "./amber-stage-bundle";
import {
  amberEnginePath,
  amberEngineSha256,
  amberSlurmProject,
  assertAmberRunnerCapsule,
  assertAmberSlurmEngineResources,
  assertAmberSlurmResources,
  assertAmberSlurmSiteProfile,
  buildAmberSlurmRunnerScript,
  type AmberRunnerCapsule,
  type AmberSlurmSiteProfile,
} from "./amber-slurm-profile";

/** Root-provisioned binaries only. Hash the open descriptor, not a caller's path
 * string or a version banner. Root may update software only in a controlled
 * drained window; the worker checks the exact identity again before execution.
 */
export async function assertProtectedRootPath(path: string, depth = 0): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path || depth > 40)
    throw new Error("Invalid protected executable path");
  const parts = path.split("/").filter(Boolean);
  let prefix = "/";
  for (const part of parts) {
    prefix = join(prefix, part);
    const info = await lstat(prefix);
    if (info.uid !== 0 || (!info.isSymbolicLink() && (info.mode & 0o022) !== 0))
      throw new Error("Executable path can be redirected by an untrusted owner/writer");
    if (info.isSymbolicLink()) {
      const target = await readlink(prefix);
      await assertProtectedRootPath(resolve(dirname(prefix), target), depth + 1);
    }
  }
}

export async function verifyRootOwnedAmberBinary(path: string, digest: string): Promise<void> {
  await assertProtectedRootPath(path);
  const resolved = await realpath(path);
  const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.uid !== 0 ||
      (before.mode & 0o022) !== 0 ||
      (before.mode & 0o111) === 0 ||
      before.size <= 0 ||
      before.size > 512 * 1024 * 1024
    )
      throw new Error("Amber executable is not a protected bounded root-owned file");
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
      if (!bytesRead) throw new Error("Amber executable was truncated during verification");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await file.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      hash.digest("hex") !== digest
    )
      throw new Error("Amber executable differs from the pinned binary identity");
  } finally {
    await file.close();
  }
}

/** Ports allow contract tests; production uses the real verified CAS/root-file
 * readers and SlurmSubmissionTransport. There is no local/scientific fallback.
 */
export interface AmberSlurmBackendIO {
  readBundle: (root: string, body: AmberSlurmDeliveryBody) => Promise<VerifiedAmberStageBundle>;
  verifyBinary: typeof verifyRootOwnedAmberBinary;
}
const productionIO: AmberSlurmBackendIO = {
  async readBundle(root, body) {
    const store = new ContentAddressedArtifactStore(root, { access: "read-only" });
    try {
      await store.init();
      return await readAmberStageBundle(store, body.bundle, body.request);
    } finally {
      await store.close();
    }
  },
  verifyBinary: verifyRootOwnedAmberBinary,
};
export interface PreparedAmberSlurmEffect {
  readonly action: "submit" | "observe" | "accounting";
  readonly operationId: string;
}
interface Preparation {
  capability: AnySubmitterCapability;
  body: AmberSlurmDeliveryBody;
  capsule: AmberRunnerCapsule;
  script?: Uint8Array;
}

/** Backend INSIDE the authenticated per-UID boundary. prepare does no effect;
 * submit is called only after its parent consumes/fsyncs the transport journal.
 * This object is not exposed to CLI/web/models and owns no DB/attempt state.
 * Deployment entrypoints must require the protected service launch authority,
 * never expose an unauthenticated `submit` program to a scientific session.
 */
export class AmberSlurmSubmitterBackend {
  private readonly profile: AmberSlurmSiteProfile;
  private readonly pending = new WeakMap<PreparedAmberSlurmEffect, Preparation>();
  private readonly transport: Pick<SlurmSubmissionTransport, "sendAdmitted" | "discover">;

  constructor(
    profileValue: unknown,
    transport?: Pick<SlurmSubmissionTransport, "sendAdmitted" | "discover">,
    private readonly io: AmberSlurmBackendIO = productionIO,
    private readonly now: () => number = Date.now,
    private readonly readAccounting?: (jobId: string) => Promise<SlurmAccountingRecord | null>,
  ) {
    this.profile = assertAmberSlurmSiteProfile(profileValue);
    this.transport = transport ?? new SlurmSubmissionTransport(this.profile.transport);
  }

  private validate(value: unknown, bytes: Uint8Array): Preparation {
    const capability = AnySubmitterCapabilitySchema.parse(value);
    const body = parseAmberSlurmDeliveryBytes(bytes);
    const binding = body.binding;
    if (
      slurmScriptDigest(bytes) !== capability.bodyDigest ||
      binding.operationId !== capability.operationId ||
      binding.requestDigest !== capability.requestDigest ||
      binding.admissionDigest !== capability.admissionDigest ||
      binding.bindingDigest !== capability.bindingDigest ||
      binding.uid !== capability.uid ||
      binding.siteProfileDigest !== capability.siteProfileDigest ||
      binding.cluster !== this.profile.transport.cluster
    )
      throw new Error("Verified capability differs from typed Amber delivery");
    this.checkClock(capability);
    if (
      capability.action === "submit" &&
      (capability.notBeforeMs < Date.parse(binding.notBefore) ||
        capability.expiresAtMs > Date.parse(binding.expiresAt))
    )
      throw new Error("Submit capability extends the frozen Slurm delivery window");
    assertAmberSlurmResources(binding.resources, this.profile);
    const capsule = assertAmberRunnerCapsule(
      {
        schemaVersion: "eigengrid.amber-runner-capsule/v1",
        operationId: capability.operationId,
        admissionDigest: capability.admissionDigest,
        fencingGeneration: capability.fencingGeneration,
        uid: capability.uid,
        gid: capability.gid,
        subject: capability.subject,
        projectId: capability.projectId,
        siteProfileDigest: capability.siteProfileDigest,
        request: body.request,
        bundle: body.bundle,
      },
      this.profile,
    );
    return { capability, body, capsule };
  }

  private checkClock(capability: AnySubmitterCapability): void {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < capability.notBeforeMs || now >= capability.expiresAtMs)
      throw new Error("Amber submitter capability is outside its live window");
  }

  async prepare(capability: unknown, bytes: Uint8Array): Promise<PreparedAmberSlurmEffect> {
    // Snapshot before awaits: callers cannot race input mutations against IO.
    const prepared = this.validate(capability, Buffer.from(bytes));
    if (prepared.capability.action === "submit") {
      const project = amberSlurmProject(
        this.profile,
        prepared.capsule.subject,
        prepared.capsule.projectId,
      );
      const bundle = await this.io.readBundle(project.publicationRoot, prepared.body);
      const resources = bundle.manifest.stage.resourceProfile;
      const engine = bundle.manifest.request.environment;
      assertAmberSlurmEngineResources(
        this.profile,
        engine.engine.executable,
        engine.binaryDigest,
        resources.gpuCount,
      );
      if (
        canonicalJson(bundle.manifest.request) !== canonicalJson(prepared.body.request) ||
        canonicalJson(bundle.reference) !== canonicalJson(prepared.body.bundle) ||
        (prepared.body.binding.resources.gpuCount ?? 0) !== resources.gpuCount ||
        resources.cpuCores !== prepared.body.binding.resources.cpus ||
        Math.ceil(resources.memoryBytes / (1024 * 1024)) !==
          prepared.body.binding.resources.memoryMiB ||
        resources.wallTimeSeconds !== prepared.body.binding.resources.walltimeSeconds
      )
        throw new Error("Amber bundle resources/request differ from exact Slurm delivery");
      await this.io.verifyBinary(
        amberEnginePath(this.profile, engine.engine.executable),
        amberEngineSha256(this.profile, engine.engine.executable),
      );
      await this.io.verifyBinary(this.profile.runnerExecutable, this.profile.runnerSha256);
      prepared.script = buildAmberSlurmRunnerScript(prepared.capsule, this.profile);
      if (slurmScriptDigest(prepared.script) !== prepared.body.binding.scriptDigest)
        throw new Error("Amber Slurm script differs from exact Head-frozen renderer");
    }
    // Observation deliberately needs NO CAS/input/engine/runner IO. Accounting
    // must remain discoverable after input/software outages or stage completion.
    this.checkClock(prepared.capability);
    const token = Object.freeze({
      action: prepared.capability.action,
      operationId: prepared.capability.operationId,
    });
    this.pending.set(token, prepared);
    return token;
  }

  async submit(token: PreparedAmberSlurmEffect): Promise<SlurmSubmissionAcknowledgement> {
    const prepared = this.pending.get(token);
    if (!prepared || prepared.capability.action !== "submit" || !prepared.script)
      throw new Error("No exact prepared Amber submit effect");
    // Local replay also fails closed. The durable Python journal is mandatory
    // across process restarts and is consumed BEFORE reaching this function.
    this.pending.delete(token);
    this.checkClock(prepared.capability);
    return this.transport.sendAdmitted(prepared.body.binding, prepared.script);
  }

  async observe(token: PreparedAmberSlurmEffect) {
    const prepared = this.pending.get(token);
    if (!prepared || prepared.capability.action !== "observe")
      throw new Error("No exact prepared Amber observation");
    this.pending.delete(token);
    this.checkClock(prepared.capability);
    return this.transport.discover(prepared.body.binding);
  }

  async accounting(token: PreparedAmberSlurmEffect): Promise<SubmitterAccountingResult> {
    const prepared = this.pending.get(token);
    if (!prepared || prepared.capability.action !== "accounting")
      throw new Error("No exact prepared Amber accounting read");
    this.pending.delete(token);
    this.checkClock(prepared.capability);
    const observation = await this.transport.discover(prepared.body.binding);
    const resolved = assertSubmitterAccountingResult(
      { observation, accounting: null },
      prepared.body.binding,
    );
    this.checkClock(prepared.capability);
    let accounting: SlurmAccountingRecord | null = null;
    if (resolved.observation.status === "matched") {
      if (!this.readAccounting) throw new Error("Protected accounting provider is unavailable");
      accounting = await this.readAccounting(resolved.observation.identity.jobId);
    }
    this.checkClock(prepared.capability);
    return assertSubmitterAccountingResult(
      { observation: resolved.observation, accounting },
      prepared.body.binding,
    );
  }
}
