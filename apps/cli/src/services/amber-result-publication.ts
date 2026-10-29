import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { LogicalPathSchema } from "@eigengrid/amber-adapter";
import {
  DigestSchema,
  TimestampSchema,
  canonicalJson,
  digestBytes,
  digestCanonical,
} from "@eigengrid/scientific-schema";
import {
  assertSlurmSubmissionBinding,
  hasControlCharacter,
  type SlurmSubmissionBinding,
} from "@eigengrid/slurm";
import {
  amberRunnerCapsuleDigest,
  assertAmberRunnerCapsule,
  assertAmberSlurmSiteProfile,
  type AmberRunnerCapsule,
  type AmberSlurmSiteProfile,
} from "./amber-slurm-profile";
import { AmberWorkerReceiptSchema, type AmberWorkerReceipt } from "./amber-slurm-runner";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u);
const operationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u);
const uid = z.number().int().positive().max(4_294_967_294);
const byteSize = z.number().int().nonnegative().safe();
const nonzeroByteSize = byteSize.positive();
const mediaType = z
  .string()
  .regex(/^[a-z0-9.+-]+\/[a-zA-Z0-9.+-]+$/u)
  .max(120);
const artifactRole = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u)
  .max(80);
const canonicalTimestamp = TimestampSchema.refine(
  (value) => new Date(value).toISOString() === value,
  "Expected a canonical UTC timestamp",
);
const protectedAbsolutePath = z
  .string()
  .min(2)
  .max(1024)
  .refine(
    (path) =>
      isAbsolute(path) && resolve(path) === path && path !== "/" && !hasControlCharacter(path),
    "Expected a canonical absolute protected path",
  );

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export const AmberResultPublicationReferenceSchema = z
  .object({ sha256: DigestSchema, sizeBytes: byteSize })
  .strict();
export type AmberResultPublicationReference = z.infer<typeof AmberResultPublicationReferenceSchema>;

const principalSchema = z.object({ uid, gid: uid }).strict();
const projectSchema = z.object({ subject: identifier, projectId: identifier }).strict();

/** Site limits apply to the final, closed publication. P1-06 applies the same
 * limits while streaming, so an incoming partial transfer can never exceed them.
 */
export const AmberResultPublicationLimitsSchema = z
  .object({
    maxManifestBytes: nonzeroByteSize.max(4 * 1024 * 1024),
    maxObjectBytes: nonzeroByteSize,
    maxTotalBytes: nonzeroByteSize,
    // Receipt + engine claim + engine receipt + at least one command output.
    maxObjectCount: z.number().int().min(4).max(19),
    // Unique immutable objects plus the standalone receipt and final marker.
    maxFileCount: z.number().int().min(6).max(21),
    maxPathBytes: z.number().int().min(256).max(4096),
  })
  .strict()
  .superRefine((limits, context) => {
    if (limits.maxTotalBytes < limits.maxObjectBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxTotalBytes"],
        message: "Total result limit must cover one object",
      });
    }
    if (limits.maxFileCount < limits.maxObjectCount + 2) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxFileCount"],
        message: "File limit must cover objects, receipt, and final marker",
      });
    }
  });
export type AmberResultPublicationLimits = z.infer<typeof AmberResultPublicationLimitsSchema>;

/** Non-secret, root-provisioned declaration. This module intentionally does not
 * read it from disk: P1-06 must use a protected descriptor/no-follow reader.
 */
export const AmberResultPublicationSiteConfigSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.amber-result-publication-site/v1"),
    configPath: protectedAbsolutePath,
    siteProfilePath: protectedAbsolutePath,
    siteProfileDigest: DigestSchema,
    resultSpoolRoot: protectedAbsolutePath,
    writer: principalSchema,
    collector: principalSchema,
    /** Dedicated result reader group; never the scientific primary/input group. */
    publicationGroupId: uid,
    projects: z.array(projectSchema).min(1).max(128),
    limits: AmberResultPublicationLimitsSchema,
  })
  .strict()
  .superRefine((config, context) => {
    if (config.writer.uid === config.collector.uid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["collector", "uid"],
        message: "Scientific writer and Head collector must use distinct UIDs",
      });
    }
    if (pathsOverlap(config.configPath, config.resultSpoolRoot)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resultSpoolRoot"],
        message: "Protected config must not live inside the writer spool",
      });
    }
    const projects = config.projects.map((project) => canonicalJson(project));
    if (new Set(projects).size !== projects.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["projects"],
        message: "Duplicate result publication project authority",
      });
    }
  });
export type AmberResultPublicationSiteConfig = z.infer<
  typeof AmberResultPublicationSiteConfigSchema
>;

export const AmberResultPublicationTransferSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.amber-result-transfer/v1"),
    // A canonical UUIDv4 identifies one resumable stage-out, not a new engine run.
    transferId: z
      .string()
      .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u),
    observedAt: canonicalTimestamp,
  })
  .strict();
export type AmberResultPublicationTransfer = z.infer<typeof AmberResultPublicationTransferSchema>;

const publicationObjectStatus = z.enum(["present", "missing", "empty", "invalid"]);
export const AmberResultPublicationObjectSchema = z
  .object({
    kind: z.enum(["worker_receipt", "engine_claim", "engine_receipt", "output"]),
    role: artifactRole,
    logicalPath: LogicalPathSchema,
    mediaType,
    status: publicationObjectStatus,
    object: AmberResultPublicationReferenceSchema.nullable(),
  })
  .strict()
  .superRefine((object, context) => {
    const hasObject = object.object !== null;
    if ((object.status === "present" || object.status === "empty") !== hasObject) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["object"],
        message: "Result object presence differs from its status",
      });
    }
    if (object.status === "empty" && object.object?.sizeBytes !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["object", "sizeBytes"],
        message: "Empty result objects must have zero bytes",
      });
    }
    if (object.status === "present" && object.object?.sizeBytes === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["object", "sizeBytes"],
        message: "Present result objects must not be empty",
      });
    }
  });
export type AmberResultPublicationObject = z.infer<typeof AmberResultPublicationObjectSchema>;

const staticObject = {
  worker_receipt: { role: "worker.receipt", logicalPath: "receipt.json" },
  engine_claim: { role: "engine.claim", logicalPath: "engine.started.json" },
  engine_receipt: { role: "engine.receipt", logicalPath: "engine.exit.json" },
} as const;
const reservedOutputPaths = new Set([
  "receipt.json",
  "engine.started.json",
  "engine.exit.json",
  "publication.json",
]);

export const AmberResultPublicationManifestSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.amber-result-publication/v1"),
    publicationKey: DigestSchema,
    transferKey: DigestSchema,
    transfer: AmberResultPublicationTransferSchema,
    operationId,
    workUnitId: z.string().min(1).max(256),
    capsuleDigest: DigestSchema,
    requestDigest: DigestSchema,
    admissionDigest: DigestSchema,
    bindingDigest: DigestSchema,
    fencingGeneration: z.number().int().positive().safe(),
    uid,
    gid: uid,
    subject: identifier,
    projectId: identifier,
    siteProfileDigest: DigestSchema,
    cluster: identifier,
    jobId: z.string().regex(/^[1-9][0-9]{0,19}$/u),
    artifactStatus: z.enum(["complete", "incomplete"]),
    receipt: AmberResultPublicationReferenceSchema,
    objects: z.array(AmberResultPublicationObjectSchema).min(4).max(19),
    // The canonical manifest itself is written exactly once at this path, last.
    finalMarker: z.literal("publication.json"),
  })
  .strict()
  .superRefine((manifest, context) => {
    const roles = new Set<string>();
    const paths = new Set<string>();
    const references = new Map<string, number>();
    const staticCounts = new Map<keyof typeof staticObject, number>();
    let outputCount = 0;
    for (const [index, object] of manifest.objects.entries()) {
      if (roles.has(object.role)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["objects", index, "role"],
          message: "Duplicate publication object role",
        });
      }
      roles.add(object.role);
      if (paths.has(object.logicalPath)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["objects", index, "logicalPath"],
          message: "Duplicate publication object path",
        });
      }
      paths.add(object.logicalPath);
      if (object.object) {
        const previous = references.get(object.object.sha256);
        if (previous !== undefined && previous !== object.object.sizeBytes) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["objects", index, "object", "sizeBytes"],
            message: "Same object digest has conflicting sizes",
          });
        }
        references.set(object.object.sha256, object.object.sizeBytes);
      }
      if (object.kind === "output") {
        outputCount++;
        if (
          reservedOutputPaths.has(object.logicalPath) ||
          object.logicalPath.startsWith("incoming/") ||
          object.logicalPath.startsWith("objects/")
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["objects", index, "logicalPath"],
            message: "Output path collides with a return-spool control path",
          });
        }
        continue;
      }
      const expected = staticObject[object.kind];
      staticCounts.set(object.kind, (staticCounts.get(object.kind) ?? 0) + 1);
      if (
        object.role !== expected.role ||
        object.logicalPath !== expected.logicalPath ||
        object.mediaType !== "application/json" ||
        object.status !== "present" ||
        object.object === null ||
        object.object.sizeBytes === 0
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["objects", index],
          message: "Invalid fixed Amber result evidence object",
        });
      }
    }
    for (const kind of Object.keys(staticObject) as (keyof typeof staticObject)[]) {
      if (staticCounts.get(kind) !== 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["objects"],
          message: `Expected one ${kind} object`,
        });
      }
    }
    if (outputCount === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["objects"],
        message: "Expected at least one Amber output object",
      });
    }
    const receipt = manifest.objects.find((object) => object.kind === "worker_receipt")?.object;
    if (canonicalJson(receipt) !== canonicalJson(manifest.receipt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receipt"],
        message: "Receipt reference differs from worker receipt inventory object",
      });
    }
  });
export type AmberResultPublicationManifest = z.infer<typeof AmberResultPublicationManifestSchema>;

export interface AmberResultPublicationInput {
  /** Must be loaded from a root-protected configuration by P1-06. */
  siteConfig: unknown;
  /** Must be the protected Amber Slurm site profile, not a client argument. */
  siteProfile: unknown;
  capsule: unknown;
  /** The durable Slurm binding from the exact effect delivery. */
  binding: unknown;
  receipt: unknown;
  /** Exact canonical bytes of receipt, stored as a content-addressed object. */
  receiptReference: unknown;
  transfer: unknown;
}

export interface AmberResultPublicationPaths {
  readonly root: string;
  readonly publicationRoot: string;
  readonly incomingDirectory: string;
  readonly objectsDirectory: string;
  readonly receiptPath: string;
  readonly finalMarkerPath: string;
  objectPath(digest: unknown): string;
}

export interface AmberResultPublicationMarker {
  readonly logicalPath: "publication.json";
  readonly body: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface ResolvedAmberResultPublication {
  readonly siteConfig: AmberResultPublicationSiteConfig;
  readonly siteProfile: AmberSlurmSiteProfile;
  readonly capsule: AmberRunnerCapsule;
  readonly binding: SlurmSubmissionBinding;
  readonly receipt: AmberWorkerReceipt;
  readonly manifest: AmberResultPublicationManifest;
  readonly paths: AmberResultPublicationPaths;
  readonly marker: AmberResultPublicationMarker;
}

/** A digest/schema proves byte identity only. It is not producer authentication,
 * hardware attestation, authorization to collect, or a scientific PASS verdict.
 * In particular, this contract does not defend scientific claims against a
 * malicious root or the scientific UID itself; DEC-RET-01/site review decides
 * those residual risks before P1-06 can install any transport.
 */
export const AMBER_RESULT_PUBLICATION_TRUST_LIMITATION =
  "Hashes and schema validation establish declared byte identity only; they do not authenticate the scientific producer or attest scientific correctness.";

function resultPublicationProject(
  config: AmberResultPublicationSiteConfig,
  capsule: AmberRunnerCapsule,
) {
  const project = config.projects.find(
    (candidate) =>
      candidate.subject === capsule.subject && candidate.projectId === capsule.projectId,
  );
  if (!project) throw new Error("Amber result project is not provisioned for publication");
  return project;
}

function assertSeparateNamespaces(
  config: AmberResultPublicationSiteConfig,
  profile: AmberSlurmSiteProfile,
): void {
  const persistentNamespaces = [
    profile.transport.home,
    profile.transport.submissionDirectory,
    profile.scratchRoot,
    ...profile.projects.map((project) => project.publicationRoot),
  ];
  for (const namespace of persistentNamespaces) {
    if (pathsOverlap(config.resultSpoolRoot, namespace)) {
      throw new Error(
        "Amber result spool must be separate from input, home, and scratch namespaces",
      );
    }
  }
}

function assertBinding(
  capsule: AmberRunnerCapsule,
  profile: AmberSlurmSiteProfile,
  binding: SlurmSubmissionBinding,
): void {
  const requestDigest = digestCanonical(capsule.request);
  if (
    binding.operationId !== capsule.operationId ||
    binding.requestDigest !== requestDigest ||
    binding.admissionDigest !== capsule.admissionDigest ||
    binding.uid !== capsule.uid ||
    binding.siteProfileDigest !== capsule.siteProfileDigest ||
    binding.cluster !== profile.transport.cluster ||
    binding.resources.node !== profile.transport.node
  )
    throw new Error("Result publication binding differs from the exact Amber capsule/profile");
}

function assertReceipt(
  capsule: AmberRunnerCapsule,
  profile: AmberSlurmSiteProfile,
  receipt: AmberWorkerReceipt,
): void {
  const requestDigest = digestCanonical(capsule.request);
  if (
    receipt.capsuleDigest !== amberRunnerCapsuleDigest(capsule) ||
    receipt.requestDigest !== requestDigest ||
    receipt.operationId !== capsule.operationId ||
    receipt.admissionDigest !== capsule.admissionDigest ||
    receipt.uid !== capsule.uid ||
    receipt.gid !== capsule.gid ||
    receipt.node !== profile.transport.node ||
    receipt.cluster !== profile.transport.cluster ||
    receipt.engine.claimDigest !== receipt.engineClaim.sha256
  )
    throw new Error("Amber worker receipt differs from the exact capsule/binding");
  const expectedArtifactStatus =
    receipt.inputsIntact && receipt.outputs.every((output) => output.status === "present")
      ? "complete"
      : "incomplete";
  if (receipt.artifactStatus !== expectedArtifactStatus)
    throw new Error("Amber receipt artifact status differs from its declared outputs");
}

function assertExactReceiptReference(
  receipt: AmberWorkerReceipt,
  referenceValue: unknown,
): AmberResultPublicationReference {
  const reference = AmberResultPublicationReferenceSchema.parse(referenceValue);
  const bytes = Buffer.from(canonicalJson(receipt), "utf8");
  if (reference.sha256 !== digestBytes(bytes) || reference.sizeBytes !== bytes.length)
    throw new Error("Amber receipt reference differs from its exact canonical bytes");
  return reference;
}

function inventory(
  receipt: AmberWorkerReceipt,
  receiptReference: AmberResultPublicationReference,
): AmberResultPublicationObject[] {
  return z.array(AmberResultPublicationObjectSchema).parse([
    {
      kind: "worker_receipt",
      role: staticObject.worker_receipt.role,
      logicalPath: staticObject.worker_receipt.logicalPath,
      mediaType: "application/json",
      status: "present",
      object: receiptReference,
    },
    {
      kind: "engine_claim",
      role: staticObject.engine_claim.role,
      logicalPath: staticObject.engine_claim.logicalPath,
      mediaType: "application/json",
      status: "present",
      object: receipt.engineClaim,
    },
    {
      kind: "engine_receipt",
      role: staticObject.engine_receipt.role,
      logicalPath: staticObject.engine_receipt.logicalPath,
      mediaType: "application/json",
      status: "present",
      object: receipt.engineReceipt,
    },
    ...receipt.outputs.map((output) => ({
      kind: "output" as const,
      role: output.role,
      logicalPath: output.logicalPath,
      mediaType: output.mediaType,
      status: output.status,
      object: output.object,
    })),
  ]);
}

function manifestPaths(
  config: AmberResultPublicationSiteConfig,
  manifest: AmberResultPublicationManifest,
): AmberResultPublicationPaths {
  const publicationRoot = `${config.resultSpoolRoot}/${manifest.uid}/${manifest.projectId}/${manifest.operationId}/${manifest.capsuleDigest}`;
  const incomingDirectory = `${publicationRoot}/incoming/${manifest.transfer.transferId}`;
  const objectsDirectory = `${publicationRoot}/objects`;
  const result: AmberResultPublicationPaths = {
    root: config.resultSpoolRoot,
    publicationRoot,
    incomingDirectory,
    objectsDirectory,
    receiptPath: `${publicationRoot}/receipt.json`,
    finalMarkerPath: `${publicationRoot}/${manifest.finalMarker}`,
    objectPath(digestValue: unknown) {
      return `${objectsDirectory}/${DigestSchema.parse(digestValue)}`;
    },
  };
  return result;
}

function markerFor(manifest: AmberResultPublicationManifest): AmberResultPublicationMarker {
  const body = canonicalJson(manifest);
  return {
    logicalPath: "publication.json",
    body,
    sha256: digestBytes(body),
    sizeBytes: Buffer.byteLength(body, "utf8"),
  };
}

function assertLimits(
  manifest: AmberResultPublicationManifest,
  paths: AmberResultPublicationPaths,
  marker: AmberResultPublicationMarker,
  limits: AmberResultPublicationLimits,
): void {
  if (marker.sizeBytes > limits.maxManifestBytes)
    throw new Error("Amber result publication manifest exceeds its byte limit");
  if (manifest.objects.length > limits.maxObjectCount)
    throw new Error("Amber result publication exceeds its object count limit");
  const objects = new Map<string, number>();
  for (const item of manifest.objects) {
    if (!item.object) continue;
    if (item.object.sizeBytes > limits.maxObjectBytes)
      throw new Error("Amber result object exceeds its byte limit");
    objects.set(item.object.sha256, item.object.sizeBytes);
  }
  // receipt.json is a regular byte-for-byte receipt copy, never a symlink or
  // hard-link. publication.json is the separately created final marker.
  const totalBytes =
    [...objects.values()].reduce((total, size) => total + size, 0) +
    manifest.receipt.sizeBytes +
    marker.sizeBytes;
  if (totalBytes > limits.maxTotalBytes)
    throw new Error("Amber result publication exceeds its total byte limit");
  if (objects.size + 2 > limits.maxFileCount)
    throw new Error("Amber result publication exceeds its file count limit");
  const pathValues = [
    paths.publicationRoot,
    paths.incomingDirectory,
    paths.objectsDirectory,
    paths.receiptPath,
    paths.finalMarkerPath,
    ...[...objects.keys()].map((digest) => paths.objectPath(digest)),
  ];
  if (pathValues.some((path) => Buffer.byteLength(path, "utf8") > limits.maxPathBytes))
    throw new Error("Amber result publication exceeds its path byte limit");
}

export type AmberWorkerResultPublicationInput = Omit<AmberResultPublicationInput, "binding"> & {
  /** Untrusted SLURM_JOB_NAME observation. Head must compare its durable binding. */
  observedBindingDigest: unknown;
};
export type ResolvedAmberWorkerResultPublication = Omit<ResolvedAmberResultPublication, "binding">;

function resolveInput(input: AmberWorkerResultPublicationInput) {
  const siteConfig = AmberResultPublicationSiteConfigSchema.parse(input.siteConfig);
  const siteProfile = assertAmberSlurmSiteProfile(input.siteProfile);
  const capsule = assertAmberRunnerCapsule(input.capsule, siteProfile);
  const observedBindingDigest = DigestSchema.parse(input.observedBindingDigest);
  const receipt = AmberWorkerReceiptSchema.parse(input.receipt);
  const transfer = AmberResultPublicationTransferSchema.parse(input.transfer);
  if (
    siteConfig.siteProfilePath !== siteProfile.profilePath ||
    siteConfig.siteProfileDigest !== siteProfile.transport.siteProfileDigest ||
    siteConfig.writer.uid !== capsule.uid ||
    siteConfig.writer.gid !== capsule.gid ||
    (siteProfile.resultPublicationConfigPath !== undefined &&
      siteProfile.resultPublicationConfigPath !== siteConfig.configPath)
  )
    throw new Error("Result publication config differs from the protected Amber site identity");
  resultPublicationProject(siteConfig, capsule);
  assertSeparateNamespaces(siteConfig, siteProfile);
  assertReceipt(capsule, siteProfile, receipt);
  return {
    siteConfig,
    siteProfile,
    capsule,
    observedBindingDigest,
    receipt,
    receiptReference: assertExactReceiptReference(receipt, input.receiptReference),
    transfer,
  };
}

/** Builds only the closed data contract. It does not create directories, copy
 * bytes, mount NFS, authenticate a producer, or acknowledge canonical storage.
 */
export function createAmberWorkerResultPublication(
  input: AmberWorkerResultPublicationInput,
): ResolvedAmberWorkerResultPublication {
  const resolved = resolveInput(input);
  const capsuleDigest = amberRunnerCapsuleDigest(resolved.capsule);
  const publicationKey = digestCanonical({
    schemaVersion: "eigengrid.amber-result-publication-key/v1",
    operationId: resolved.capsule.operationId,
    capsuleDigest,
    requestDigest: digestCanonical(resolved.capsule.request),
    admissionDigest: resolved.capsule.admissionDigest,
    bindingDigest: resolved.observedBindingDigest,
    uid: resolved.capsule.uid,
    gid: resolved.capsule.gid,
    subject: resolved.capsule.subject,
    projectId: resolved.capsule.projectId,
    siteProfileDigest: resolved.capsule.siteProfileDigest,
    cluster: resolved.siteProfile.transport.cluster,
  });
  const manifest = AmberResultPublicationManifestSchema.parse({
    schemaVersion: "eigengrid.amber-result-publication/v1",
    publicationKey,
    transferKey: digestCanonical({
      schemaVersion: "eigengrid.amber-result-transfer-key/v1",
      publicationKey,
      transferId: resolved.transfer.transferId,
    }),
    transfer: resolved.transfer,
    operationId: resolved.capsule.operationId,
    workUnitId: resolved.capsule.request.workUnitId,
    capsuleDigest,
    requestDigest: digestCanonical(resolved.capsule.request),
    admissionDigest: resolved.capsule.admissionDigest,
    bindingDigest: resolved.observedBindingDigest,
    fencingGeneration: resolved.capsule.fencingGeneration,
    uid: resolved.capsule.uid,
    gid: resolved.capsule.gid,
    subject: resolved.capsule.subject,
    projectId: resolved.capsule.projectId,
    siteProfileDigest: resolved.capsule.siteProfileDigest,
    cluster: resolved.siteProfile.transport.cluster,
    jobId: resolved.receipt.jobId,
    artifactStatus: resolved.receipt.artifactStatus,
    receipt: resolved.receiptReference,
    objects: inventory(resolved.receipt, resolved.receiptReference),
    finalMarker: "publication.json",
  });
  const paths = manifestPaths(resolved.siteConfig, manifest);
  const marker = markerFor(manifest);
  assertLimits(manifest, paths, marker, resolved.siteConfig.limits);
  return { ...resolved, manifest, paths, marker };
}

/** Canonical Head constructor retains durable-binding authority. */
export function createAmberResultPublication(
  input: AmberResultPublicationInput,
): ResolvedAmberResultPublication {
  const binding = assertSlurmSubmissionBinding(input.binding);
  const resolved = createAmberWorkerResultPublication({
    ...input,
    observedBindingDigest: binding.bindingDigest,
  });
  assertBinding(resolved.capsule, resolved.siteProfile, binding);
  return { ...resolved, binding };
}

/** Rejects a partial, altered, cross-UID, or cross-operation manifest by
 * reconstructing the one exact publication allowed by its frozen inputs.
 */
export function assertAmberResultPublicationManifest(
  manifestValue: unknown,
  input: AmberResultPublicationInput,
): ResolvedAmberResultPublication {
  const manifest = AmberResultPublicationManifestSchema.parse(manifestValue);
  const expected = createAmberResultPublication(input);
  if (canonicalJson(manifest) !== canonicalJson(expected.manifest))
    throw new Error("Amber result publication manifest differs from its exact frozen inputs");
  return { ...expected, manifest, marker: markerFor(manifest) };
}
