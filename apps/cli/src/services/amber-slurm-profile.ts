import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  DigestSchema,
  MdStageOperationRequestSchema,
  canonicalJson,
  digestCanonical,
} from "@eigengrid/scientific-schema";
import {
  SlurmSubmissionProfileSchema,
  buildSlurmRunnerScript,
  createSlurmSubmissionBinding,
  hasControlCharacter,
  sacctContractForVersion,
  slurmScriptDigest,
  type SlurmSubmissionBinding,
} from "@eigengrid/slurm";
import type { MdDeliveryPrincipal, MdSubmissionAuthority } from "@eigengrid/mission-runtime";
import {
  AmberBundleReferenceSchema,
  AmberStageBundleSchema,
  type VerifiedAmberStageBundle,
} from "./amber-stage-bundle";
import { createAmberSlurmDeliveryDraft, type AmberSlurmDeliveryBody } from "./amber-slurm-delivery";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u);
const uid = z.number().int().positive().max(4_294_967_294);
const absolutePath = z
  .string()
  .max(1024)
  .refine(
    (path) =>
      isAbsolute(path) && resolve(path) === path && path !== "/" && !hasControlCharacter(path),
    "Expected a canonical absolute site path",
  );

/** Non-secret, root-provisioned configuration. Never a request/browser argument.
 * All nodes use the same publication alias; systemd binds only that namespace
 * into the Head/submitter, while the worker mounts it read-only via NFS.
 */
export const AmberSlurmSiteProfileSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.amber-slurm-site/v1"),
    profilePath: absolutePath,
    transport: SlurmSubmissionProfileSchema,
    gid: uid,
    runnerExecutable: absolutePath,
    runnerSha256: DigestSchema,
    amberHome: absolutePath,
    sanderSha256: DigestSchema,
    /** Optional root-provisioned GPU engine identity. Omission keeps CPU-only sites valid. */
    pmemdCudaSha256: DigestSchema.optional(),
    gpuLibraryTreeSha256: DigestSchema.optional(),
    amberVersion: z.string().min(1).max(80),
    engineEnvironmentDigest: DigestSchema,
    scratchRoot: absolutePath,
    resultPublicationConfigPath: absolutePath.optional(),
    projects: z
      .array(
        z
          .object({
            subject: identifier,
            projectId: identifier,
            publicationRoot: absolutePath,
          })
          .strict(),
      )
      .min(1)
      .max(128),
  })
  .strict()
  .superRefine((profile, context) => {
    if ((profile.pmemdCudaSha256 === undefined) !== (profile.gpuLibraryTreeSha256 === undefined))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "GPU engine and protected library digest must be provisioned together",
      });
  });
export type AmberSlurmSiteProfile = z.infer<typeof AmberSlurmSiteProfileSchema>;

export function computeAmberSlurmSiteProfileDigest(value: unknown): string {
  const profile = AmberSlurmSiteProfileSchema.parse(value);
  const { siteProfileDigest: _digest, ...transport } = profile.transport;
  return digestCanonical({ ...profile, transport });
}

export function assertAmberSlurmSiteProfile(value: unknown): AmberSlurmSiteProfile {
  const profile = AmberSlurmSiteProfileSchema.parse(value);
  sacctContractForVersion(profile.transport.slurmVersion);
  absolutePath.parse(profile.transport.home);
  absolutePath.parse(profile.transport.submissionDirectory);
  if (!profile.transport.submissionDirectory.startsWith(profile.transport.home + "/"))
    throw new Error("Submission directory must be inside the scientific home");
  if (profile.transport.siteProfileDigest !== computeAmberSlurmSiteProfileDigest(profile))
    throw new Error("Amber Slurm site profile digest mismatch");
  const pairs = profile.projects.map(({ subject, projectId }) =>
    canonicalJson([subject, projectId]),
  );
  if (new Set(pairs).size !== pairs.length) throw new Error("Duplicate site project authority");
  // Keep local scientific scratch independent from the input publication/home.
  for (const path of [profile.transport.home, ...profile.projects.map((p) => p.publicationRoot)]) {
    if (
      profile.scratchRoot === path ||
      profile.scratchRoot.startsWith(path + "/") ||
      path.startsWith(profile.scratchRoot + "/")
    )
      throw new Error("Amber scratch and persistent namespaces must be separate");
  }
  return profile;
}

export function amberSlurmProject(
  profile: AmberSlurmSiteProfile,
  subject: string,
  projectId: string,
) {
  const project = profile.projects.find((p) => p.subject === subject && p.projectId === projectId);
  if (!project) throw new Error("Project is not provisioned for this scientific UID");
  return project;
}

export const AmberRunnerCapsuleSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.amber-runner-capsule/v1"),
    operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u),
    admissionDigest: DigestSchema,
    fencingGeneration: z.number().int().positive().safe(),
    uid,
    gid: uid,
    subject: identifier,
    projectId: identifier,
    siteProfileDigest: DigestSchema,
    request: MdStageOperationRequestSchema,
    bundle: AmberBundleReferenceSchema,
  })
  .strict();
export type AmberRunnerCapsule = z.infer<typeof AmberRunnerCapsuleSchema>;

/** Stable identity for local workspace/receipts. It is not a permission token. */
export function amberRunnerCapsuleDigest(value: unknown): string {
  return digestCanonical(AmberRunnerCapsuleSchema.parse(value));
}

export function assertAmberRunnerCapsule(
  value: unknown,
  profileValue: unknown,
): AmberRunnerCapsule {
  const capsule = AmberRunnerCapsuleSchema.parse(value);
  const profile = assertAmberSlurmSiteProfile(profileValue);
  amberSlurmProject(profile, capsule.subject, capsule.projectId);
  const executable = capsule.request.environment.engine.executable;
  const expectedDigest = amberSlurmEngineDigest(profile, executable);
  if (
    capsule.uid !== profile.transport.uid ||
    capsule.gid !== profile.gid ||
    capsule.siteProfileDigest !== profile.transport.siteProfileDigest ||
    capsule.request.environment.engine.engine !== "amber" ||
    capsule.request.environment.binaryDigest !== expectedDigest ||
    capsule.request.environment.engine.version !== profile.amberVersion ||
    capsule.request.environment.engineEnvironmentDigest !== profile.engineEnvironmentDigest
  )
    throw new Error("Amber runner capsule differs from provisioned identity/engine");
  return capsule;
}

/** The same pure renderer is used by Head and submitter. No client scripts.
 * Runner creates exclusive local scratch before starting its engine supervisor.
 */
export function buildAmberSlurmRunnerScript(
  capsuleValue: unknown,
  profileValue: unknown,
): Uint8Array {
  const profile = assertAmberSlurmSiteProfile(profileValue);
  const capsule = assertAmberRunnerCapsule(capsuleValue, profile);
  const encoded = Buffer.from(canonicalJson(capsule)).toString("base64");
  if (encoded.length > 64 * 1024) throw new Error("Amber runner capsule exceeds its argv bound");
  const script = Buffer.from(
    buildSlurmRunnerScript(
      {
        executable: profile.runnerExecutable,
        argv: ["--site-profile", profile.profilePath, "--capsule", encoded],
      },
      {
        jobName: "eigengrid-amber",
        chdir: "/tmp",
        envVars: { EIGENGRID_SLURM_CLUSTER: profile.transport.cluster },
      },
    ),
  );
  if (script.length > 256 * 1024)
    throw new Error("Amber runner script exceeds Slurm transport bound");
  return script;
}

export function amberSanderPath(profile: AmberSlurmSiteProfile): string {
  return join(profile.amberHome, "bin", "sander");
}

/** Resolve only engines whose identities are provisioned by the root-owned profile. */
export function amberEnginePath(profile: AmberSlurmSiteProfile, executable: string): string {
  amberEngineSha256(profile, executable);
  return join(profile.amberHome, "bin", executable);
}

export function amberEngineSha256(profile: AmberSlurmSiteProfile, executable: string): string {
  if (executable === "sander") return profile.sanderSha256;
  if (executable === "pmemd.cuda" && profile.pmemdCudaSha256) return profile.pmemdCudaSha256;
  throw new Error("Amber engine is not provisioned by the site profile");
}

/** Compatibility aliases for callers using the Slurm-qualified names. */
export const amberSlurmEnginePath = amberEnginePath;
export const amberSlurmEngineDigest = amberEngineSha256;

/** The production profile supports sander on CPU and pmemd.cuda on one GPU. */
export function assertAmberSlurmEngineResources(
  profile: AmberSlurmSiteProfile,
  executable: string,
  binaryDigest: string,
  gpuCount: number,
): void {
  if (
    binaryDigest !== amberSlurmEngineDigest(profile, executable) ||
    (executable === "sander" && gpuCount !== 0) ||
    (executable === "pmemd.cuda" &&
      (gpuCount !== 1 ||
        profile.transport.gpuLimit !== 1 ||
        !profile.transport.gpuType ||
        !profile.gpuLibraryTreeSha256))
  )
    throw new Error("Amber engine and GPU allocation differ from the provisioned profile");
}

export function assertAmberSlurmResources(
  resources: SlurmSubmissionBinding["resources"],
  profile: AmberSlurmSiteProfile,
): void {
  const site = profile.transport;
  if (
    resources.partition !== site.partition ||
    resources.node !== site.node ||
    resources.account !== site.account ||
    resources.cpus > site.cpuLimit ||
    resources.memoryMiB > site.memoryMiBLimit ||
    resources.walltimeSeconds > site.walltimeLimitSeconds ||
    (resources.gpuCount !== undefined &&
      (resources.gpuCount !== 1 || site.gpuLimit !== 1 || !site.gpuType))
  )
    throw new Error("Amber allocation exceeds the provisioned site profile");
}

/** Bundle preparation/verification occurs BEFORE the admission transaction.
 * This synchronous builder only compares frozen inputs to its exact live
 * authority and generates the closed body for HeadMdDeliverySigner.
 */
export function buildAdmittedAmberSlurmBody(
  authority: MdSubmissionAuthority,
  principal: MdDeliveryPrincipal,
  prepared: VerifiedAmberStageBundle,
  profileValue: unknown,
): AmberSlurmDeliveryBody {
  const profile = assertAmberSlurmSiteProfile(profileValue);
  const manifest = AmberStageBundleSchema.parse(prepared.manifest);
  const reference = AmberBundleReferenceSchema.parse(prepared.reference);
  const manifestBytes = Buffer.from(canonicalJson(manifest));
  if (
    slurmScriptDigest(manifestBytes) !== reference.sha256 ||
    manifestBytes.length !== reference.sizeBytes ||
    canonicalJson(manifest.request) !== canonicalJson(authority.operation.request) ||
    canonicalJson(manifest.stage) !== canonicalJson(authority.stage)
  )
    throw new Error("Prepared Amber bundle differs from exact live admission");
  const capsule = assertAmberRunnerCapsule(
    {
      schemaVersion: "eigengrid.amber-runner-capsule/v1",
      operationId: authority.operation.id,
      admissionDigest: authority.admission.admissionDigest,
      fencingGeneration: authority.admission.fencingGeneration,
      ...principal,
      request: manifest.request,
      bundle: reference,
    },
    profile,
  );
  const resources = authority.stage.resourceProfile;
  assertAmberSlurmEngineResources(
    profile,
    manifest.request.environment.engine.executable,
    manifest.request.environment.binaryDigest,
    resources.gpuCount,
  );
  const binding = createSlurmSubmissionBinding({
    operationId: authority.operation.id,
    requestDigest: digestCanonical(manifest.request),
    admissionDigest: authority.admission.admissionDigest,
    scriptDigest: slurmScriptDigest(buildAmberSlurmRunnerScript(capsule, profile)),
    siteProfileDigest: profile.transport.siteProfileDigest,
    cluster: profile.transport.cluster,
    uid: principal.uid,
    notBefore: authority.checkedAt,
    expiresAt: authority.expiresAt,
    resources: {
      partition: profile.transport.partition,
      node: profile.transport.node,
      account: profile.transport.account,
      cpus: resources.cpuCores,
      memoryMiB: Math.ceil(resources.memoryBytes / (1024 * 1024)),
      walltimeSeconds: resources.wallTimeSeconds,
      ...(resources.gpuCount === 1 ? { gpuCount: 1 as const } : {}),
    },
  });
  const body: AmberSlurmDeliveryBody = {
    schemaVersion: "eigengrid.amber-slurm-delivery/v1",
    request: manifest.request,
    binding,
    bundle: reference,
  };
  assertAmberSlurmResources(binding.resources, profile);
  createAmberSlurmDeliveryDraft(authority, principal, body);
  return body;
}
