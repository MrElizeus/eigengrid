import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { DigestSchema } from "@eigengrid/scientific-schema";
import {
  hasControlCharacter,
  slurmScriptDigest,
  type AnySubmitterCapability,
} from "@eigengrid/slurm";
import { readProtectedSiteJson } from "./amber-slurm-site-files";

const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u);
const uid = z.number().int().positive().max(4_294_967_294);
const path = z
  .string()
  .max(1024)
  .refine(
    (value) =>
      isAbsolute(value) && resolve(value) === value && value !== "/" && !hasControlCharacter(value),
  );
const kernelId = z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/u);
export const SubmitterServiceConfigSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.submitter-service/v1"),
    configPath: path,
    uid,
    gid: uid,
    headUid: uid,
    appArmorProfile: z.string().regex(/^eigengrid-submitter-[a-z0-9-]{1,64}$/u),
    socketPath: path,
    journalPath: path,
    journalId: identity,
    launchAuthorityPath: path,
    launchAuthorityDevice: kernelId,
    launchAuthorityInode: kernelId,
    launchAuthoritySha256: DigestSchema,
    backendExecutable: path,
    backendSha256: DigestSchema,
    siteProfilePath: path,
    policyPath: path,
  })
  .strict()
  .refine(
    (value) => value.uid !== value.headUid && value.launchAuthorityPath !== value.journalPath,
    "Separated Head/scientific identities and launch/journal descriptors are required",
  );
export type SubmitterServiceConfig = z.infer<typeof SubmitterServiceConfigSchema>;

export const SubmitterSitePolicySchema = z
  .object({
    schemaVersion: z.literal("eigengrid.submitter-site-policy/v1"),
    uid,
    gid: uid,
    headUid: uid,
    recoveryEpoch: identity,
    siteProfileDigest: DigestSchema,
    currentPolicyDigest: DigestSchema,
    publicKeyHex: DigestSchema,
    memberships: z
      .array(
        z
          .object({
            subject: identity,
            projectId: identity,
            generation: z.number().int().positive().safe(),
          })
          .strict(),
      )
      .max(128),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.memberships.map((m) => `${m.subject}/${m.projectId}`)).size ===
      value.memberships.length,
    "Duplicate membership",
  );
export type SubmitterSitePolicy = z.infer<typeof SubmitterSitePolicySchema>;

export async function loadSubmitterServiceConfig(
  configPath: string,
): Promise<SubmitterServiceConfig> {
  const config = SubmitterServiceConfigSchema.parse(await readProtectedSiteJson(configPath));
  if (config.configPath !== configPath) throw new Error("Submitter config path mismatch");
  return config;
}

export async function loadSubmitterSitePolicy(
  config: SubmitterServiceConfig,
): Promise<SubmitterSitePolicy> {
  const policy = SubmitterSitePolicySchema.parse(await readProtectedSiteJson(config.policyPath));
  if (policy.uid !== config.uid || policy.gid !== config.gid || policy.headUid !== config.headUid)
    throw new Error("Submitter policy identity differs from its root-provisioned service");
  return policy;
}

export function assertSubmitterCurrentPolicy(
  capability: AnySubmitterCapability,
  policy: SubmitterSitePolicy,
  now = Date.now(),
): void {
  const member = policy.memberships.find(
    (m) => m.subject === capability.subject && m.projectId === capability.projectId,
  );
  if (
    capability.uid !== policy.uid ||
    capability.gid !== policy.gid ||
    capability.recoveryEpoch !== policy.recoveryEpoch ||
    capability.siteProfileDigest !== policy.siteProfileDigest ||
    capability.membershipGeneration !== member?.generation ||
    !Number.isSafeInteger(now) ||
    now < capability.notBeforeMs ||
    now >= capability.expiresAtMs
  )
    throw new Error("Submitter capability is outside current site authority");
}

export function assertSubmitterProcessRestrictions(
  status: string,
  limits: string,
  ptraceScope: string,
): void {
  if (
    !/^NoNewPrivs:\s+1$/mu.test(status) ||
    !/^CapEff:\s+0+$/mu.test(status) ||
    // procfs pads the units column on Ubuntu24.04; that padding is not a
    // nonzero/unlimited core limit. Still require BOTH soft and hard exactly0.
    !/^Max core file size\s+0\s+0\s+bytes[ \t]*$/mu.test(limits) ||
    !["1\n", "2\n", "3\n"].includes(ptraceScope)
  )
    throw new Error("Submitter backend lacks required privilege/core restrictions");
}

function readKernelPtraceScope(): string {
  // Fixed root-provisioned read-only bind of the LIVE host sysctl. AppArmor
  // alone does not stop unconfined tracers; Yama covers the exec bootstrap.
  const fd = openSync(
    "/run/eigengrid-submitters/kernel-ptrace-scope",
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0)
      throw new Error("Kernel isolation binding is not protected");
    const bytes = Buffer.alloc(8);
    return bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0)).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** A real inherited file capability, not a token that a caller can manufacture
 * in JSON. Root owns the file0600 in a nontraversable directory; its immutable
 * device/inode/hash are provisioned in the public root-owned service config.
 * AppArmor must be active FROM EXEC, including the short bootstrap interval.
 * Always close the marker before reading a request or spawning any subprocess.
 */
export function consumeSubmitterLaunchAuthority(config: SubmitterServiceConfig, fd: number): void {
  if (!Number.isSafeInteger(fd) || fd < 3 || fd > 1024)
    throw new Error("Invalid launch descriptor");
  try {
    if (
      process.platform !== "linux" ||
      process.getuid?.() !== config.uid ||
      process.getgid?.() !== config.gid
    )
      throw new Error("Submitter backend must be its configured scientific UID/GID");
    const file = fstatSync(fd, { bigint: true });
    const descriptor = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
    const flags = /^flags:\s+([0-7]+)$/mu.exec(descriptor);
    if (
      !file.isFile() ||
      file.uid !== 0n ||
      file.nlink !== 1n ||
      (file.mode & 0o777n) !== 0o600n ||
      file.dev.toString() !== config.launchAuthorityDevice ||
      file.ino.toString() !== config.launchAuthorityInode ||
      file.size < 1n ||
      file.size > 4096n ||
      !flags ||
      (Number.parseInt(flags[1]!, 8) & 3) !== 0
    )
      throw new Error("No protected root launch authority was inherited");
    const bytes = Buffer.alloc(Number(file.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("Truncated launch authority");
      offset += count;
    }
    if (slurmScriptDigest(bytes) !== config.launchAuthoritySha256)
      throw new Error("Launch authority differs from root provisioning");
    if (
      readFileSync("/proc/self/attr/current", "utf8").trim() !==
      `${config.appArmorProfile} (enforce)`
    )
      throw new Error("Submitter backend AppArmor confinement is not active");
    const status = readFileSync("/proc/self/status", "utf8");
    const limits = readFileSync("/proc/self/limits", "utf8");
    assertSubmitterProcessRestrictions(status, limits, readKernelPtraceScope());
  } finally {
    closeSync(fd);
  }
}
