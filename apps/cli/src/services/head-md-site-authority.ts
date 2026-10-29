import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  MdDeliveryPrincipalSchema,
  ScientificEffectReconciliationStore,
  type MdEffectDelivery,
  type MdSubmissionAuthority,
  type ScientificDatabase,
} from "@eigengrid/mission-runtime";
import { canonicalJson, digestCanonical } from "@eigengrid/scientific-schema";
import {
  hasControlCharacter,
  SubmitterCapabilitySchema,
  AnySubmitterCapabilitySchema,
} from "@eigengrid/slurm";
import {
  amberSlurmProject,
  assertAmberSlurmSiteProfile,
  buildAdmittedAmberSlurmBody,
} from "./amber-slurm-profile";
import type { VerifiedAmberStageBundle } from "./amber-stage-bundle";
import {
  HeadMdDeliverySigner,
  HeadMdSubmitterGrantSchema,
  type PreparedMdCapability,
  type PreparedMdAccountingCapability,
  type HeadMdSubmitterGrant,
} from "./md-delivery-signer";
import { parseAmberSlurmDelivery } from "./amber-slurm-delivery";
import {
  SubmitterServiceConfigSchema,
  SubmitterSitePolicySchema,
  type SubmitterServiceConfig,
  type SubmitterSitePolicy,
} from "./submitter-site-authority";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u);
const linuxId = z.number().int().positive().max(4_294_967_294);
const protectedPath = z
  .string()
  .max(1024)
  .refine(
    (value) =>
      isAbsolute(value) && resolve(value) === value && value !== "/" && !hasControlCharacter(value),
    "Expected a canonical protected absolute path",
  );

/** Root-provisioned Head configuration. Its service config paths are selected
 * by system configuration, never by a browser, model, or mission payload.
 */
export const HeadMdSiteAuthorityConfigSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.head-md-site-authority/v1"),
    configPath: protectedPath,
    headUid: linuxId,
    privateKeyPath: protectedPath,
    submitterConfigPaths: z.array(protectedPath).min(1).max(128),
  })
  .strict()
  .refine(
    (value) => new Set(value.submitterConfigPaths).size === value.submitterConfigPaths.length,
    "Duplicate submitter service configuration path",
  );
export type HeadMdSiteAuthorityConfig = z.infer<typeof HeadMdSiteAuthorityConfigSchema>;

/** This association is resolved by the canonical PostgreSQL mission/project
 * authority in P1-03. It intentionally contains no UID, GID, profile, policy,
 * key, or socket field that an API/browser could smuggle into a capability.
 */
export const HeadMdTrustedProjectAssociationSchema = z
  .object({ subject: identifier, projectId: identifier })
  .strict();
export type HeadMdTrustedProjectAssociation = z.infer<typeof HeadMdTrustedProjectAssociationSchema>;

export interface ProtectedHeadMdFileStat {
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface ProtectedHeadMdFileHandle {
  stat(): ProtectedHeadMdFileStat;
  readExact(size: number): Buffer;
  close(): void;
}

interface ProtectedHeadMdFileSnapshot {
  readonly path: string;
  readonly stat: ProtectedHeadMdFileStat;
  readonly maxBytes?: number;
  readonly privateKey?: boolean;
}

interface ProtectedHeadMdFileRead {
  readonly bytes: Buffer;
  readonly snapshots: readonly ProtectedHeadMdFileSnapshot[];
}

/** The production implementation always opens O_NOFOLLOW. The test-only
 * factory below accepts this narrow port so permission metadata can be modeled
 * without weakening a real Head process or requiring root-owned temp fixtures.
 */
export interface HeadMdSiteAuthorityFileSystem {
  currentUid(): number;
  lstat(path: string): ProtectedHeadMdFileStat;
  openReadOnlyNoFollow(path: string): ProtectedHeadMdFileHandle;
}

const MAX_HEAD_CONFIG_BYTES = 64 * 1024;
const MAX_SITE_JSON_BYTES = 256 * 1024;
const MAX_PRIVATE_KEY_BYTES = 16 * 1024;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const productionFileSystem: HeadMdSiteAuthorityFileSystem = Object.freeze({
  currentUid: () => process.getuid?.() ?? -1,
  lstat: (path: string) => lstatSync(path),
  openReadOnlyNoFollow(path: string) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let closed = false;
    return {
      stat: () => fstatSync(fd),
      readExact(size: number) {
        const bytes = Buffer.alloc(size);
        let offset = 0;
        while (offset < bytes.length) {
          const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
          if (!count) throw new Error("Protected Head file was truncated during read");
          offset += count;
        }
        return bytes;
      },
      close() {
        if (!closed) {
          closed = true;
          closeSync(fd);
        }
      },
    };
  },
});

function sameProtectedFile(a: ProtectedHeadMdFileStat, b: ProtectedHeadMdFileStat): boolean {
  return (
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.mode === b.mode &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

function pathAncestors(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const ancestors = ["/"];
  let prefix = "/";
  for (const part of parts.slice(0, -1)) {
    prefix = join(prefix, part);
    ancestors.push(prefix);
  }
  return ancestors;
}

function assertProtectedDirectory(info: ProtectedHeadMdFileStat): void {
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0)
    throw new Error("Protected Head path has an unsafe ancestor");
}

function assertProtectedFile(
  info: ProtectedHeadMdFileStat,
  maxBytes: number,
  privateKey: boolean,
): void {
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.uid !== 0 ||
    info.nlink !== 1 ||
    (info.mode & 0o022) !== 0 ||
    info.size < 1 ||
    info.size > maxBytes ||
    (privateKey && (info.mode & 0o007) !== 0)
  )
    throw new Error("Protected Head file is not a bounded root-owned regular file");
}

function revalidateProtectedSnapshots(
  snapshots: readonly ProtectedHeadMdFileSnapshot[],
  fileSystem: HeadMdSiteAuthorityFileSystem,
): void {
  for (const snapshot of snapshots) {
    const current = fileSystem.lstat(snapshot.path);
    if (snapshot.maxBytes === undefined) assertProtectedDirectory(current);
    else assertProtectedFile(current, snapshot.maxBytes, snapshot.privateKey === true);
    if (!sameProtectedFile(snapshot.stat, current))
      throw new Error("Protected Head authority changed during resolution");
  }
}

function readProtectedBytes(
  pathValue: string,
  maxBytes: number,
  fileSystem: HeadMdSiteAuthorityFileSystem,
  privateKey = false,
): ProtectedHeadMdFileRead {
  const path = protectedPath.parse(pathValue);
  const snapshots: ProtectedHeadMdFileSnapshot[] = [];
  for (const ancestor of pathAncestors(path)) {
    const stat = fileSystem.lstat(ancestor);
    assertProtectedDirectory(stat);
    snapshots.push({ path: ancestor, stat });
  }
  const before = fileSystem.lstat(path);
  assertProtectedFile(before, maxBytes, privateKey);
  snapshots.push({ path, stat: before, maxBytes, privateKey });
  const file = fileSystem.openReadOnlyNoFollow(path);
  try {
    const opened = file.stat();
    assertProtectedFile(opened, maxBytes, privateKey);
    if (!sameProtectedFile(before, opened))
      throw new Error("Protected Head file changed before open");
    const bytes = file.readExact(opened.size);
    const after = file.stat();
    if (bytes.length !== opened.size || !sameProtectedFile(opened, after))
      throw new Error("Protected Head file changed during read");
    const pathAfter = fileSystem.lstat(path);
    assertProtectedFile(pathAfter, maxBytes, privateKey);
    if (!sameProtectedFile(after, pathAfter))
      throw new Error("Protected Head file changed during read");
    return { bytes, snapshots };
  } finally {
    file.close();
  }
}

function parseCanonicalProtectedJson<T>(
  bytes: Buffer,
  parser: { parse(value: unknown): T },
  label: string,
): T {
  try {
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("not UTF-8");
    const value: unknown = JSON.parse(text);
    if (canonicalJson(value) !== text) throw new Error("not canonical");
    return parser.parse(value);
  } catch {
    throw new Error(`Invalid protected ${label} JSON`);
  }
}

function readCanonicalProtectedJson<T>(
  path: string,
  maxBytes: number,
  parser: { parse(value: unknown): T },
  label: string,
  fileSystem: HeadMdSiteAuthorityFileSystem,
  snapshots: ProtectedHeadMdFileSnapshot[],
): T {
  const read = readProtectedBytes(path, maxBytes, fileSystem);
  snapshots.push(...read.snapshots);
  return parseCanonicalProtectedJson(read.bytes, parser, label);
}

function publicKeyHexFromPrivateKey(bytes: Buffer): {
  pem: string;
  publicKeyHex: string;
  fingerprint: string;
} {
  try {
    const pem = bytes.toString("utf8");
    if (!Buffer.from(pem, "utf8").equals(bytes)) throw new Error("not UTF-8");
    const privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("not Ed25519");
    const encoded = createPublicKey(privateKey).export({ type: "spki", format: "der" }) as Buffer;
    if (
      encoded.length !== ED25519_SPKI_PREFIX.length + 32 ||
      !encoded.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
    )
      throw new Error("unexpected Ed25519 public encoding");
    return {
      pem,
      publicKeyHex: encoded.subarray(ED25519_SPKI_PREFIX.length).toString("hex"),
      fingerprint: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    throw new Error("Protected Head signing key is not an Ed25519 private key");
  }
}

interface ResolvedSubmitterAuthority {
  readonly service: SubmitterServiceConfig;
  readonly policy: SubmitterSitePolicy;
  readonly profile: ReturnType<typeof assertAmberSlurmSiteProfile>;
}

interface LiveHeadMdAuthority {
  readonly grant: HeadMdSubmitterGrant;
  readonly privateKeyPem: string;
  readonly publicKeyHex: string;
  readonly privateKeyFingerprint: string;
  readonly service: SubmitterServiceConfig;
  readonly profile: ReturnType<typeof assertAmberSlurmSiteProfile>;
  /** Binds non-secret transport material selected solely from protected files.
   * A session treats any change as a fail-closed configuration rotation. */
  readonly endpointBinding: string;
}

export type HeadMdDeliveryBodyBuilder = (
  authority: MdSubmissionAuthority,
  grant: HeadMdSubmitterGrant,
) => unknown;

/** A process-local MD delivery session. It owns the protected selector for the
 * submitter socket/profile and never returns a private key, a mutable profile,
 * or authority selected by a request. The returned target is valid only for a
 * capability issued by this session and only after a fresh DB + site check.
 */
export interface HeadMdObservationSession {
  observe(operationId: string): Promise<PreparedMdCapability>;
  authorizeObserveRpc(input: { prepared: PreparedMdCapability }): Promise<{
    socketPath: string;
    wire: Uint8Array;
    delivery: MdEffectDelivery;
    capabilityRequestId: string;
  }>;
}

export interface HeadMdAccountingSession {
  accounting(operationId: string): Promise<PreparedMdAccountingCapability>;
  authorizeAccountingRpc(input: { prepared: PreparedMdAccountingCapability }): Promise<{
    socketPath: string;
    wire: Uint8Array;
    delivery: MdEffectDelivery;
    capabilityRequestId: string;
  }>;
}

export interface HeadMdAmberDeliverySession extends HeadMdObservationSession {
  prepare(input: { operationId: string; claimOwner: string }): Promise<PreparedMdCapability>;
  authorizeSubmitRpc(input: { prepared: PreparedMdCapability; claimOwner: string }): Promise<{
    socketPath: string;
    wire: Uint8Array;
    /** Snapshot metadata for the same immutable bytes represented by `wire`.
     * Callers must use this rather than the mutable continuation token after
     * authorization has crossed the protected authority boundary. */
    delivery: MdEffectDelivery;
    capabilityRequestId: string;
  }>;
}

interface StableHeadMdAuthority {
  readonly grant: HeadMdSubmitterGrant;
  readonly publicKeyHex: string;
  readonly privateKeyFingerprint: string;
  readonly endpointBinding: string;
  readonly socketPath: string;
}

function stableAuthority(value: LiveHeadMdAuthority): StableHeadMdAuthority {
  return {
    grant: value.grant,
    publicKeyHex: value.publicKeyHex,
    privateKeyFingerprint: value.privateKeyFingerprint,
    endpointBinding: value.endpointBinding,
    socketPath: value.service.socketPath,
  };
}

function assertStableAuthority(initial: StableHeadMdAuthority, current: LiveHeadMdAuthority): void {
  const now = stableAuthority(current);
  if (
    canonicalJson(initial.grant) !== canonicalJson(now.grant) ||
    initial.publicKeyHex !== now.publicKeyHex ||
    initial.privateKeyFingerprint !== now.privateKeyFingerprint ||
    initial.endpointBinding !== now.endpointBinding ||
    initial.socketPath !== now.socketPath
  ) {
    throw new Error("Protected Head MD authority changed during delivery session");
  }
}

/** The signer emits an object, not an unforgeable in-process reference. Keep a
 * private WeakMap of outputs it issued so the session cannot be used as a
 * generic capability-to-socket relay by passing a fabricated/deserialized
 * value. */
class ProtectedHeadMdAmberDeliverySession
  implements HeadMdAmberDeliverySession, HeadMdAccountingSession
{
  /**
   * `PreparedMdCapability` is structurally mutable TypeScript data. Retain a
   * private byte-for-byte snapshot keyed by the object we issued so a caller
   * cannot turn this session into a relay for a substituted capability or
   * wire after `prepare()` returns. The caller-facing value is only an opaque
   * continuation token for this process-local session.
   */
  private readonly issued = new WeakMap<
    object,
    {
      prepared: PreparedMdCapability | PreparedMdAccountingCapability;
      authorizationConsumed: boolean;
    }
  >();

  constructor(
    private readonly database: ScientificDatabase,
    private readonly signer: HeadMdDeliverySigner,
    private readonly initial: StableHeadMdAuthority,
    private readonly resolveStableLive: () => LiveHeadMdAuthority,
    private readonly now: () => Date,
  ) {}

  async prepare(input: { operationId: string; claimOwner: string }): Promise<PreparedMdCapability> {
    const prepared = await this.signer.prepare(input);
    this.remember(prepared);
    return prepared;
  }

  async observe(operationId: string): Promise<PreparedMdCapability> {
    const prepared = await this.signer.observe(operationId);
    this.remember(prepared);
    return prepared;
  }

  async accounting(operationId: string): Promise<PreparedMdAccountingCapability> {
    const prepared = await this.signer.accounting(operationId);
    this.remember(prepared);
    return prepared;
  }

  async authorizeSubmitRpc(input: { prepared: PreparedMdCapability; claimOwner: string }): Promise<{
    socketPath: string;
    wire: Uint8Array;
    delivery: MdEffectDelivery;
    capabilityRequestId: string;
  }> {
    const issued = this.issued.get(input.prepared);
    if (!issued)
      throw new Error("MD submit RPC requires a capability issued by this delivery session");
    // Consume before the first await: concurrent callers cannot obtain two
    // socket targets from one newly-created delivery. If later revalidation
    // fails, recovery remains P1-04 observe-only rather than retrying a
    // potentially exposed external submit capability.
    if (issued.authorizationConsumed)
      throw new Error("MD submit capability has already consumed its one RPC authorization");
    issued.authorizationConsumed = true;
    const prepared = issued.prepared;
    if (prepared.action !== "submit")
      throw new Error("Only a newly-created MD delivery may reach the submit RPC");

    const delivery = parseAmberSlurmDelivery(prepared.delivery);
    const capability = SubmitterCapabilitySchema.parse(prepared.capability);
    const before = this.resolveStableLive();
    assertStableAuthority(this.initial, before);
    const checked = await new ScientificEffectReconciliationStore(
      this.database,
      this.now,
    ).readMdDeliverySigningAuthority(
      {
        operationId: prepared.delivery.operationId,
        claimOwner: input.claimOwner,
        currentPolicyDigest: before.grant.currentPolicyDigest,
      },
      before.grant.principal,
    );
    const after = this.resolveStableLive();
    assertStableAuthority(this.initial, after);
    const clock = this.now().getTime();
    if (
      !Number.isSafeInteger(clock) ||
      clock < capability.notBeforeMs ||
      clock >= capability.expiresAtMs
    )
      throw new Error("MD submit capability is outside its current time window");
    if (
      canonicalJson(checked.delivery) !== canonicalJson(prepared.delivery) ||
      canonicalJson(checked.delivery.principal) !== canonicalJson(before.grant.principal) ||
      capability.action !== "submit" ||
      capability.operationId !== prepared.delivery.operationId ||
      capability.requestDigest !== prepared.delivery.requestDigest ||
      capability.admissionDigest !== prepared.delivery.admissionDigest ||
      capability.bindingDigest !== prepared.delivery.bindingDigest ||
      capability.bodyDigest !== prepared.delivery.bodyDigest ||
      capability.fencingGeneration !== prepared.delivery.fencingGeneration ||
      capability.subject !== before.grant.principal.subject ||
      capability.projectId !== before.grant.principal.projectId ||
      capability.uid !== before.grant.principal.uid ||
      capability.gid !== before.grant.principal.gid ||
      capability.siteProfileDigest !== before.grant.principal.siteProfileDigest ||
      capability.recoveryEpoch !== before.grant.recoveryEpoch ||
      capability.membershipGeneration !== before.grant.membershipGeneration ||
      capability.notBeforeMs < Date.parse(prepared.delivery.notBefore) ||
      capability.expiresAtMs > Date.parse(prepared.delivery.expiresAt) ||
      delivery.binding.operationId !== prepared.delivery.operationId
    ) {
      throw new Error("MD capability/delivery no longer matches current protected authority");
    }
    return {
      socketPath: after.service.socketPath,
      wire: new Uint8Array(prepared.wire),
      delivery: structuredClone(prepared.delivery),
      capabilityRequestId: prepared.capability.requestId,
    };
  }

  async authorizeObserveRpc(input: { prepared: PreparedMdCapability }): Promise<{
    socketPath: string;
    wire: Uint8Array;
    delivery: MdEffectDelivery;
    capabilityRequestId: string;
  }> {
    return this.authorizeReadRpc(input.prepared, "observe");
  }

  async authorizeAccountingRpc(input: { prepared: PreparedMdAccountingCapability }): Promise<{
    socketPath: string;
    wire: Uint8Array;
    delivery: MdEffectDelivery;
    capabilityRequestId: string;
  }> {
    return this.authorizeReadRpc(input.prepared, "accounting");
  }

  private async authorizeReadRpc(
    token: PreparedMdCapability | PreparedMdAccountingCapability,
    action: "observe" | "accounting",
  ) {
    const issued = this.issued.get(token);
    if (!issued)
      throw new Error("MD observe RPC requires a capability issued by this delivery session");
    if (issued.authorizationConsumed)
      throw new Error("MD observe capability has already consumed its one RPC authorization");
    issued.authorizationConsumed = true;
    const prepared = issued.prepared;
    if (prepared.action !== action)
      throw new Error("MD observation requires an observe-only capability");
    const body = parseAmberSlurmDelivery(prepared.delivery);
    const capability = AnySubmitterCapabilitySchema.parse(prepared.capability);
    const before = this.resolveStableLive();
    assertStableAuthority(this.initial, before);
    // Historical recovery needs no bundle or current scientific lease. It does
    // require live project access and the exact persisted delivery/admission.
    const checked = await new ScientificEffectReconciliationStore(
      this.database,
      this.now,
    ).readMdSubmissionDelivery(prepared.delivery.operationId, before.grant.principal);
    const after = this.resolveStableLive();
    assertStableAuthority(this.initial, after);
    const clock = this.now().getTime();
    if (
      !Number.isSafeInteger(clock) ||
      clock < capability.notBeforeMs ||
      clock >= capability.expiresAtMs
    )
      throw new Error("MD observe capability is outside its current time window");
    if (
      !checked ||
      canonicalJson(checked) !== canonicalJson(prepared.delivery) ||
      canonicalJson(checked.principal) !== canonicalJson(before.grant.principal) ||
      capability.action !== action ||
      capability.operationId !== checked.operationId ||
      capability.requestDigest !== checked.requestDigest ||
      capability.admissionDigest !== checked.admissionDigest ||
      capability.bindingDigest !== checked.bindingDigest ||
      capability.bodyDigest !== checked.bodyDigest ||
      capability.fencingGeneration !== checked.fencingGeneration ||
      capability.subject !== before.grant.principal.subject ||
      capability.projectId !== before.grant.principal.projectId ||
      capability.uid !== before.grant.principal.uid ||
      capability.gid !== before.grant.principal.gid ||
      capability.siteProfileDigest !== before.grant.principal.siteProfileDigest ||
      capability.recoveryEpoch !== before.grant.recoveryEpoch ||
      capability.membershipGeneration !== before.grant.membershipGeneration ||
      body.binding.operationId !== checked.operationId
    )
      throw new Error("MD observation no longer matches current protected authority");
    return {
      socketPath: after.service.socketPath,
      wire: new Uint8Array(prepared.wire),
      delivery: structuredClone(prepared.delivery),
      capabilityRequestId: prepared.capability.requestId,
    };
  }

  private remember(prepared: PreparedMdCapability | PreparedMdAccountingCapability): void {
    this.issued.set(prepared, {
      prepared: structuredClone(prepared),
      authorizationConsumed: false,
    });
  }
}

/** Reads every authority snapshot synchronously and afresh. Its principal must
 * come from the canonical PostgreSQL-authorized mission/delivery path; this
 * module accepts no browser/request UID, project, profile, or key fields.
 */
export class HeadMdSiteAuthorityReader {
  constructor(
    private readonly configPath: string,
    private readonly fileSystem: HeadMdSiteAuthorityFileSystem = productionFileSystem,
  ) {}

  private readConfig(snapshots: ProtectedHeadMdFileSnapshot[]): HeadMdSiteAuthorityConfig {
    const config = readCanonicalProtectedJson(
      this.configPath,
      MAX_HEAD_CONFIG_BYTES,
      HeadMdSiteAuthorityConfigSchema,
      "Head site authority configuration",
      this.fileSystem,
      snapshots,
    );
    if (config.configPath !== this.configPath)
      throw new Error("Protected Head site authority configuration path mismatch");
    if (this.fileSystem.currentUid() !== config.headUid)
      throw new Error("Head site authority is not executing as its configured Head UID");
    return config;
  }

  private readSubmitterAuthority(
    path: string,
    headUid: number,
    snapshots: ProtectedHeadMdFileSnapshot[],
  ): ResolvedSubmitterAuthority {
    const service = readCanonicalProtectedJson(
      path,
      MAX_SITE_JSON_BYTES,
      SubmitterServiceConfigSchema,
      "submitter service configuration",
      this.fileSystem,
      snapshots,
    );
    if (service.configPath !== path || service.headUid !== headUid)
      throw new Error("Submitter service configuration disagrees with Head authority");
    const policy = readCanonicalProtectedJson(
      service.policyPath,
      MAX_SITE_JSON_BYTES,
      SubmitterSitePolicySchema,
      "submitter site policy",
      this.fileSystem,
      snapshots,
    );
    if (
      policy.uid !== service.uid ||
      policy.gid !== service.gid ||
      policy.headUid !== service.headUid
    )
      throw new Error("Submitter policy identity differs from its protected service configuration");
    const profile = assertAmberSlurmSiteProfile(
      readCanonicalProtectedJson(
        service.siteProfilePath,
        MAX_SITE_JSON_BYTES,
        { parse: (value) => value },
        "Amber Slurm site profile",
        this.fileSystem,
        snapshots,
      ),
    );
    if (
      profile.profilePath !== service.siteProfilePath ||
      profile.transport.uid !== service.uid ||
      profile.gid !== service.gid ||
      profile.transport.siteProfileDigest !== policy.siteProfileDigest
    )
      throw new Error("Amber Slurm site profile differs from submitter authority");
    return { service, policy, profile };
  }

  private resolveLive(associationValue: HeadMdTrustedProjectAssociation): LiveHeadMdAuthority {
    const association = HeadMdTrustedProjectAssociationSchema.parse(associationValue);
    const snapshots: ProtectedHeadMdFileSnapshot[] = [];
    const config = this.readConfig(snapshots);
    const matches: ResolvedSubmitterAuthority[] = [];
    for (const path of config.submitterConfigPaths) {
      const candidate = this.readSubmitterAuthority(path, config.headUid, snapshots);
      const memberships = candidate.policy.memberships.filter(
        (membership) =>
          membership.subject === association.subject &&
          membership.projectId === association.projectId,
      );
      const projects = candidate.profile.projects.filter(
        (project) =>
          project.subject === association.subject && project.projectId === association.projectId,
      );
      if (!memberships.length && !projects.length) continue;
      if (memberships.length !== 1 || projects.length !== 1)
        throw new Error(
          "Protected site authority is missing or ambiguous for the authorized project",
        );
      matches.push(candidate);
    }
    if (matches.length !== 1)
      throw new Error(
        "No unique protected submitter authority exists for the database-authorized principal",
      );
    const candidate = matches[0]!;
    const membership = candidate.policy.memberships.find(
      (value) => value.subject === association.subject && value.projectId === association.projectId,
    );
    if (!membership) throw new Error("Protected site membership disappeared during resolution");
    amberSlurmProject(candidate.profile, association.subject, association.projectId);
    const protectedKey = readProtectedBytes(
      config.privateKeyPath,
      MAX_PRIVATE_KEY_BYTES,
      this.fileSystem,
      true,
    );
    snapshots.push(...protectedKey.snapshots);
    const key = publicKeyHexFromPrivateKey(protectedKey.bytes);
    if (key.publicKeyHex !== candidate.policy.publicKeyHex)
      throw new Error("Protected Head signing key does not match current submitter policy");
    const resolved: LiveHeadMdAuthority = {
      grant: HeadMdSubmitterGrantSchema.parse({
        principal: MdDeliveryPrincipalSchema.parse({
          subject: association.subject,
          projectId: association.projectId,
          uid: candidate.service.uid,
          gid: candidate.service.gid,
          siteProfileDigest: candidate.policy.siteProfileDigest,
        }),
        recoveryEpoch: candidate.policy.recoveryEpoch,
        membershipGeneration: membership.generation,
        currentPolicyDigest: candidate.policy.currentPolicyDigest,
      }),
      privateKeyPem: key.pem,
      publicKeyHex: key.publicKeyHex,
      privateKeyFingerprint: key.fingerprint,
      service: candidate.service,
      profile: candidate.profile,
      endpointBinding: digestCanonical({
        schemaVersion: "eigengrid.head-md-delivery-endpoint/v1",
        service: candidate.service,
        profile: candidate.profile,
      }),
    };
    revalidateProtectedSnapshots(snapshots, this.fileSystem);
    return resolved;
  }

  resolveCurrentGrant(
    authorizedAssociation: HeadMdTrustedProjectAssociation,
  ): HeadMdSubmitterGrant {
    return this.resolveLive(authorizedAssociation).grant;
  }

  /** Key bytes stay inside the signer. Every signer callback rereads protected
   * site authority; a public-key rotation makes the old signer fail closed.
   */
  createSigner(
    database: ScientificDatabase,
    authorizedAssociation: HeadMdTrustedProjectAssociation,
    buildBody: HeadMdDeliveryBodyBuilder,
    now?: () => Date,
  ): HeadMdDeliverySigner {
    // Capture only a parsed subject/project snapshot. UID/GID and every
    // capability-relevant authority field are still reread from protected
    // site files for each signer callback.
    const association = HeadMdTrustedProjectAssociationSchema.parse(authorizedAssociation);
    const initial = this.resolveLive(association);
    return new HeadMdDeliverySigner(
      database,
      () => {
        const current = this.resolveLive(association);
        if (
          current.publicKeyHex !== initial.publicKeyHex ||
          current.privateKeyFingerprint !== initial.privateKeyFingerprint
        )
          throw new Error("Protected Head signing key rotated; create a new signer");
        return current.grant;
      },
      buildBody,
      initial.privateKeyPem,
      now,
    );
  }

  /** Only protected configuration selects the project publication root and
   * engine tuple. The caller must first establish its DB mission association. */
  resolvePublication(authorizedAssociation: HeadMdTrustedProjectAssociation) {
    const current = this.resolveLive(authorizedAssociation);
    const project = amberSlurmProject(
      current.profile,
      current.grant.principal.subject,
      current.grant.principal.projectId,
    );
    return structuredClone({
      publicationRoot: project.publicationRoot,
      grant: current.grant,
      endpointBinding: current.endpointBinding,
      environment: {
        amberVersion: current.profile.amberVersion,
        sanderSha256: current.profile.sanderSha256,
        ...(current.profile.pmemdCudaSha256
          ? { pmemdCudaSha256: current.profile.pmemdCudaSha256 }
          : {}),
        engineEnvironmentDigest: current.profile.engineEnvironmentDigest,
      },
    });
  }

  /** Historical collection uses a protected profile and current site access;
   * the exact delivery and DB project authority are checked by the read session. */
  resolveResultPublication(authorizedAssociation: HeadMdTrustedProjectAssociation) {
    const current = this.resolveLive(authorizedAssociation);
    const resultPublicationConfigPath = current.profile.resultPublicationConfigPath;
    if (!resultPublicationConfigPath)
      throw new Error("Protected result publication is not configured");
    return structuredClone({
      profile: current.profile,
      resultPublicationConfigPath,
      grant: current.grant,
      endpointBinding: current.endpointBinding,
    });
  }

  /** Recovery reads only persisted delivery bytes. It cannot build a new
   * delivery and does not need an available scientific bundle/CAS. */
  createAmberObservationSession(
    database: ScientificDatabase,
    authorizedAssociation: HeadMdTrustedProjectAssociation,
    now: () => Date = () => new Date(),
  ): HeadMdObservationSession {
    return this.createReadSession(database, authorizedAssociation, now);
  }

  createAmberAccountingSession(
    database: ScientificDatabase,
    authorizedAssociation: HeadMdTrustedProjectAssociation,
    now: () => Date = () => new Date(),
  ): HeadMdAccountingSession {
    return this.createReadSession(database, authorizedAssociation, now);
  }

  private createReadSession(
    database: ScientificDatabase,
    authorizedAssociation: HeadMdTrustedProjectAssociation,
    now: () => Date,
  ): ProtectedHeadMdAmberDeliverySession {
    if (database._provider !== "postgres")
      throw new Error("Production MD observation sessions require PostgreSQL");
    const association = HeadMdTrustedProjectAssociationSchema.parse(authorizedAssociation);
    const initial = this.resolveLive(association);
    const stable = stableAuthority(initial);
    const resolveStableLive = (): LiveHeadMdAuthority => {
      const current = this.resolveLive(association);
      assertStableAuthority(stable, current);
      return current;
    };
    const signer = new HeadMdDeliverySigner(
      database,
      () => resolveStableLive().grant,
      () => {
        throw new Error("Observation session cannot create an MD delivery");
      },
      initial.privateKeyPem,
      now,
    );
    return new ProtectedHeadMdAmberDeliverySession(
      database,
      signer,
      stable,
      resolveStableLive,
      now,
    );
  }

  /**
   * Compose the fixed Amber body, Ed25519 signer, protected socket selector and
   * final database/site revalidation as one Head-only session. The bundle is
   * already independently verified before this method is called; it is never
   * substituted from a caller's Slurm/profile/path fields.
   */
  createAmberDeliverySession(
    database: ScientificDatabase,
    authorizedAssociation: HeadMdTrustedProjectAssociation,
    preparedBundle: VerifiedAmberStageBundle,
    now: () => Date = () => new Date(),
  ): HeadMdAmberDeliverySession {
    if (database._provider !== "postgres")
      throw new Error("Production MD delivery sessions require PostgreSQL");
    const association = HeadMdTrustedProjectAssociationSchema.parse(authorizedAssociation);
    const initial = this.resolveLive(association);
    const stable = stableAuthority(initial);
    const resolveStableLive = (): LiveHeadMdAuthority => {
      const current = this.resolveLive(association);
      assertStableAuthority(stable, current);
      return current;
    };
    const signer = new HeadMdDeliverySigner(
      database,
      () => resolveStableLive().grant,
      (authority, grant) => {
        const current = resolveStableLive();
        if (canonicalJson(current.grant) !== canonicalJson(grant))
          throw new Error("Protected Head grant changed while building Amber delivery");
        return buildAdmittedAmberSlurmBody(
          authority,
          grant.principal,
          preparedBundle,
          current.profile,
        );
      },
      initial.privateKeyPem,
      now,
    );
    return new ProtectedHeadMdAmberDeliverySession(
      database,
      signer,
      stable,
      resolveStableLive,
      now,
    );
  }
}

export function createHeadMdSiteAuthorityReader(configPath: string): HeadMdSiteAuthorityReader {
  return new HeadMdSiteAuthorityReader(configPath);
}

/** Test-only permission/filesystem injection. Production composition must use
 * createHeadMdSiteAuthorityReader and cannot choose this port at runtime.
 */
export function createHeadMdSiteAuthorityReaderForTest(
  configPath: string,
  fileSystem: HeadMdSiteAuthorityFileSystem,
): HeadMdSiteAuthorityReader {
  return new HeadMdSiteAuthorityReader(configPath, fileSystem);
}

/** Shared protected CONFIGURATION reader, not an API/file browsing capability.
 * Uses the same descriptor/ancestor/ownership checks as submission authority.
 */
export function readProtectedHeadJson<T>(
  path: string,
  parser: { parse(value: unknown): T },
  maxBytes = 256 * 1024,
): T {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024)
    throw new Error("Invalid Head configuration size limit");
  const snapshots: ProtectedHeadMdFileSnapshot[] = [];
  const value = readCanonicalProtectedJson(
    path,
    maxBytes,
    parser,
    "MD postprocessing configuration",
    productionFileSystem,
    snapshots,
  );
  revalidateProtectedSnapshots(snapshots, productionFileSystem);
  return value;
}
