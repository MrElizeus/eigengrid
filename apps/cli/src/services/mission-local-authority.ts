import {
  MdFailedAllocationReviewSchema,
  type MdFailedAllocationReview,
} from "./md-failed-allocation-review";
import { MdNoSubmitReviewSchema, type MdNoSubmitReview } from "./md-no-submit-review";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { z } from "zod";
import { createHash, timingSafeEqual } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import {
  CompilerPolicyProfileSchema,
  EnvironmentCapabilityProfileSchema,
  MdCompilerPolicySchema,
  computeCompilerPolicyDigest,
  computeMdCompilerPolicyDigest,
  type CompilerPolicyProfile,
  type EnvironmentCapabilityProfile,
  type MdCompilerPolicy,
} from "@eigengrid/scientific-agent";
import {
  MdEnvironmentCapabilitySnapshotSchema,
  assertMdEnvironmentCapabilitySnapshotDigest,
  canonicalJson,
  digestCanonical,
  type ActorIdentity,
  type MdEnvironmentCapabilitySnapshot,
} from "@eigengrid/scientific-schema";

export const MissionClientConfigPath = "/etc/eigengrid/mission-client.json";
const maximumBytes = 256 * 1024;
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/u);
const role = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/u);
const unixUid = z.number().int().positive().max(4_294_967_294);
const hasControlCharacter = (value: string) =>
  [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

export const MissionClientConfigSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.mission-client/v1"),
    artifactRoot: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (value) =>
          isAbsolute(value) &&
          resolve(value) === value &&
          value !== "/" &&
          !hasControlCharacter(value),
        "A canonical absolute artifact root is required",
      ),
    databaseUrl: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            ["postgres:", "postgresql:"].includes(url.protocol) &&
            Boolean(url.hostname && url.username && url.pathname.length > 1) &&
            !url.hash &&
            !hasControlCharacter(value) &&
            !value.includes(" ")
          );
        } catch {
          return false;
        }
      }, "A complete protected PostgreSQL URL is required"),
    operators: z
      .array(
        z
          .object({
            uid: unixUid,
            actorId: identity,
            primaryRole: role,
            roles: z.array(role).min(1).max(32),
            httpCredentialDigest: z
              .string()
              .regex(/^[a-f0-9]{64}$/u)
              .optional(),
            httpProjectIds: z.array(identity).max(1024).optional(),
          })
          .strict()
          .refine(
            (operator) =>
              operator.roles.includes(operator.primaryRole) &&
              new Set(operator.roles).size === operator.roles.length,
            "Operator roles must be unique and include the primary role",
          ),
      )
      .max(1024),
    compilerPolicy: CompilerPolicyProfileSchema,
    environment: EnvironmentCapabilityProfileSchema,
    http: z
      .object({
        origin: z
          .string()
          .url()
          .refine((value) => {
            const url = new URL(value);
            return url.protocol === "https:" && url.origin === value;
          }),
        port: z.number().int().min(1024).max(65535),
        sessionSeconds: z.number().int().min(60).max(86400),
      })
      .strict()
      .optional(),
    mdNoSubmitReviews: z.array(MdNoSubmitReviewSchema).max(32).optional(),
    mdFailedAllocationReviews: z.array(MdFailedAllocationReviewSchema).max(32).optional(),
    mdCompilerPolicy: MdCompilerPolicySchema.optional(),
    mdEnvironment: MdEnvironmentCapabilitySnapshotSchema.optional(),
  })
  .strict()
  .superRefine((config, context) => {
    if (
      new Set(config.operators.map((operator) => operator.uid)).size !== config.operators.length ||
      new Set(config.operators.map((operator) => operator.actorId)).size !== config.operators.length
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Operator UIDs and actor IDs must be unique",
      });
    const credentials = config.operators.flatMap((operator) =>
      operator.httpCredentialDigest ? [operator.httpCredentialDigest] : [],
    );
    if (new Set(credentials).size !== credentials.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "HTTP credentials must identify exactly one actor",
      });
    if (computeCompilerPolicyDigest(config.compilerPolicy) !== config.compilerPolicy.policyDigest)
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Compiler policy digest mismatch" });
    if (Boolean(config.mdCompilerPolicy) !== Boolean(config.mdEnvironment))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "MD policy and environment must be provisioned together",
      });
    if (
      config.mdCompilerPolicy &&
      computeMdCompilerPolicyDigest(config.mdCompilerPolicy) !==
        config.mdCompilerPolicy.policyDigest
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "MD compiler policy digest mismatch",
      });
    if (config.mdEnvironment) {
      try {
        assertMdEnvironmentCapabilitySnapshotDigest(config.mdEnvironment);
      } catch {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "MD environment digest mismatch",
        });
      }
    }
  });
export type MissionClientConfig = z.infer<typeof MissionClientConfigSchema>;

/** Internal composition context. Never serialize this object: databaseUrl is authority. */
export interface MissionLocalContext {
  readonly authenticatedActor: ActorIdentity;
  readonly authorizedRoles: readonly string[];
  readonly compilerPolicy: CompilerPolicyProfile;
  readonly environment: EnvironmentCapabilityProfile;
  readonly mdNoSubmitReviews?: readonly MdNoSubmitReview[];
  readonly mdFailedAllocationReviews?: readonly MdFailedAllocationReview[];
  readonly mdCompilerPolicy?: MdCompilerPolicy;
  readonly mdEnvironment?: MdEnvironmentCapabilitySnapshot;
  readonly unixUid: number;
  readonly configDigest: string;
  readonly databaseUrl: string;
  readonly artifactRoot: string;
  readonly http?: MissionClientConfig["http"];
  readonly httpProjectIds?: readonly string[];
}

/** Explicit unit-test seam. Production construction never accepts paths, identities or IO. */
export interface MissionLocalAuthorityTestIo {
  identity(): { uid: number; effectiveUid: number };
  open(path: string, flags: number): number;
  lstat(path: string): BigIntStats;
  stat(fd: number): BigIntStats;
  read(fd: number, bytes: Buffer, offset: number, length: number, position: number): number;
  close(fd: number): void;
}

const nativeIo: MissionLocalAuthorityTestIo = {
  identity() {
    if (process.platform !== "linux" || !process.getuid || !process.geteuid)
      throw new Error("Mission local authority requires a Unix identity on Linux");
    return { uid: process.getuid(), effectiveUid: process.geteuid() };
  },
  open: openSync,
  lstat: (path) => lstatSync(path, { bigint: true }),
  stat: (fd) => fstatSync(fd, { bigint: true }),
  read: readSync,
  close: closeSync,
};

function assertProtected(info: BigIntStats, directory: boolean): void {
  if (
    info.uid !== 0n ||
    (info.mode & 0o022n) !== 0n ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    (!directory && (info.nlink !== 1n || info.size < 1n || info.size > BigInt(maximumBytes)))
  )
    throw new Error(
      "Mission configuration and ancestry must be protected root-owned files/directories",
    );
  // The protected URL may contain credentials. Root provisions group access
  // only for local mission operators; unrelated local users must not read it.
  if (!directory && (info.mode & 0o004n) !== 0n)
    throw new Error("Mission configuration must not be world-readable");
}

function stable(before: BigIntStats, after: BigIntStats): boolean {
  return ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(
    (key) => before[key as keyof BigIntStats] === after[key as keyof BigIntStats],
  );
}

function readConfig(io: MissionLocalAuthorityTestIo): MissionClientConfig {
  const opened: { path: string; fd: number; before: BigIntStats; directory: boolean }[] = [];
  try {
    for (const path of ["/", "/etc", "/etc/eigengrid", MissionClientConfigPath]) {
      const directory = path !== MissionClientConfigPath;
      const before = io.lstat(path);
      assertProtected(before, directory);
      const fd = io.open(
        path,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          (directory ? constants.O_DIRECTORY : 0),
      );
      opened.push({ path, fd, before, directory });
      const descriptor = io.stat(fd);
      assertProtected(descriptor, directory);
      if (!stable(before, descriptor))
        throw new Error("Mission configuration path changed during open");
    }
    const file = opened[opened.length - 1]!;
    const bytes = Buffer.alloc(Number(file.before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = io.read(file.fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0 || count > bytes.length - offset)
        throw new Error("Truncated mission configuration");
      offset += count;
    }
    for (const entry of opened) {
      const descriptor = io.stat(entry.fd);
      const currentPath = io.lstat(entry.path);
      assertProtected(descriptor, entry.directory);
      assertProtected(currentPath, entry.directory);
      if (!stable(entry.before, descriptor) || !stable(entry.before, currentPath))
        throw new Error("Mission configuration changed during read");
    }
    const text = bytes.toString("utf8");
    const value: unknown = JSON.parse(text);
    if (!Buffer.from(text).equals(bytes) || canonicalJson(value) !== text)
      throw new Error("Mission configuration must contain canonical UTF-8 JSON");
    const config = MissionClientConfigSchema.parse(value);
    // Also rejects unknown nested fields that upstream schemas would strip.
    if (canonicalJson(config) !== text)
      throw new Error("Mission configuration must contain only explicit schema fields");
    return config;
  } finally {
    for (const entry of opened.reverse()) io.close(entry.fd);
  }
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freezeDeep(item);
    Object.freeze(value);
  }
  return value;
}

export class MissionLocalAuthority {
  #io: MissionLocalAuthorityTestIo = nativeIo;
  #issued = new WeakSet<MissionLocalContext>();

  /** Dependency injection is restricted to trusted test code, never CLI options or config. */
  static forTests(io: MissionLocalAuthorityTestIo): MissionLocalAuthority {
    const authority = new MissionLocalAuthority();
    authority.#io = io;
    return authority;
  }

  async current(): Promise<MissionLocalContext> {
    const before = this.#io.identity();
    if (!unixUid.safeParse(before.uid).success || before.uid !== before.effectiveUid)
      throw new Error(
        "Mission operators require an unprivileged, unchanged real/effective Unix UID",
      );
    const config = readConfig(this.#io);
    const after = this.#io.identity();
    if (before.uid !== after.uid || before.effectiveUid !== after.effectiveUid)
      throw new Error("Mission operator Unix identity changed during authentication");
    const operator = config.operators.find((candidate) => candidate.uid === before.uid);
    if (!operator) throw new Error("Unix UID is not an authorized mission operator");
    const context: MissionLocalContext = freezeDeep({
      authenticatedActor: {
        id: operator.actorId,
        kind: "human" as const,
        role: operator.primaryRole,
      },
      authorizedRoles: operator.roles,
      compilerPolicy: config.compilerPolicy,
      environment: config.environment,
      ...(config.mdCompilerPolicy ? { mdCompilerPolicy: config.mdCompilerPolicy } : {}),
      ...(config.mdEnvironment ? { mdEnvironment: config.mdEnvironment } : {}),
      ...(config.mdNoSubmitReviews ? { mdNoSubmitReviews: config.mdNoSubmitReviews } : {}),
      ...(config.mdFailedAllocationReviews
        ? { mdFailedAllocationReviews: config.mdFailedAllocationReviews }
        : {}),
      unixUid: before.uid,
      configDigest: digestCanonical(config),
      databaseUrl: config.databaseUrl,
      artifactRoot: config.artifactRoot,
      ...(config.http ? { http: config.http } : {}),
      ...(operator.httpProjectIds ? { httpProjectIds: operator.httpProjectIds } : {}),
    });
    this.#issued.add(context);
    return context;
  }

  /** The listener's own kernel UID must be authorized before any HTTP credential is considered. */
  async authenticateHttp(credential: string): Promise<MissionLocalContext> {
    const server = await this.current();
    if (!server.http || !/^[A-Za-z0-9_-]{43}$/u.test(credential))
      throw new Error("HTTP authentication failed");
    const config = readConfig(this.#io);
    const hash = createHash("sha256").update(credential).digest();
    const operator = config.operators.find(
      (item) =>
        item.httpCredentialDigest &&
        timingSafeEqual(Buffer.from(item.httpCredentialDigest, "hex"), hash),
    );
    if (!operator) throw new Error("HTTP authentication failed");
    return this.httpActor(operator.actorId, server.configDigest);
  }

  /** Used only after the durable session store authenticated an opaque server-issued token. */
  async httpActor(actorId: string, configDigest: string): Promise<MissionLocalContext> {
    const server = await this.current();
    const config = readConfig(this.#io);
    const operator = config.operators.find(
      (item) => item.actorId === actorId && item.httpCredentialDigest,
    );
    if (
      !server.http ||
      server.configDigest !== configDigest ||
      digestCanonical(config) !== configDigest ||
      !operator
    )
      throw new Error("HTTP authority revoked");
    const context = freezeDeep({
      ...server,
      authenticatedActor: {
        id: operator.actorId,
        kind: "human" as const,
        role: operator.primaryRole,
      },
      authorizedRoles: operator.roles,
      httpProjectIds: operator.httpProjectIds ?? [],
    });
    this.#issued.add(context);
    return context;
  }

  /** Re-read before each durable action; revocation and authority rotation fail closed. */
  async assertCurrent(context: MissionLocalContext): Promise<void> {
    if (!this.#issued.has(context))
      throw new Error("Mission context was not issued by this authority");
    const current = await this.current();
    if (current.unixUid !== context.unixUid || current.configDigest !== context.configDigest)
      throw new Error("Mission operator authority changed; start a fresh command");
  }
}
