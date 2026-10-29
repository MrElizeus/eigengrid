import { sealSecurityProfile } from "./digest";
import type {
  EgressEndpoint,
  SecurityDigest,
  SecurityExecutableRule,
  SecurityProfile,
  SecurityResourceLimits,
} from "./schemas";

export const SECURITY_DENIED_ENVIRONMENT_KEYS = Object.freeze([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "EIGENGRID_DATABASE_URL",
  "EIGENGRID_SSH_PRIVATE_KEY",
  "EIGENGRID_LICENSE_SECRET",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "GITHUB_TOKEN",
  "SSH_AUTH_SOCK",
] as const);

export const DEFAULT_SECURITY_RESOURCE_LIMITS: SecurityResourceLimits = Object.freeze({
  cpuQuotaPercent: 200,
  memoryMaxBytes: 4 * 1_024 * 1_024 * 1_024,
  tasksMax: 256,
  wallTimeMaxMs: 60 * 60 * 1_000,
  outputMaxBytes: 64 * 1_024 * 1_024,
});

export interface CreateWorkerJobSecurityProfileInput {
  profileId?: string;
  version?: number;
  executablePath: string;
  executableDigest: SecurityDigest;
  capability?: string;
  scratchRoot?: string;
  artifactRoot?: string;
  allowedEgress?: readonly EgressEndpoint[];
  resources?: Partial<SecurityResourceLimits>;
}

/**
 * Construct an exact CPU worker/job profile. This creates policy material,
 * not host evidence; activation still requires the static and real-host gates.
 */
export function createWorkerJobSecurityProfile(
  input: CreateWorkerJobSecurityProfileInput,
): SecurityProfile {
  const capability = input.capability ?? "job.execute";
  const scratchRoot = input.scratchRoot ?? "/scratch/eigengrid";
  const artifactRoot = input.artifactRoot ?? "/srv/eigengrid/artifacts";
  const executable: SecurityExecutableRule = {
    capability,
    path: input.executablePath,
    digest: input.executableDigest,
    maxArguments: 64,
    maxArgumentBytes: 64 * 1_024,
  };
  return sealSecurityProfile({
    schema: "eigengrid.security-profile.v1",
    profileId: input.profileId ?? "worker-job-cpu.v1",
    surface: "job",
    version: input.version ?? 1,
    authority: {
      issuer: "eigengrid-head",
      audience: "eigengrid-worker",
      trustedKeyIds: ["key:head:7"],
      revocationMaxAgeMs: 5 * 60 * 1_000,
    },
    capabilities: [capability],
    executables: [executable],
    filesystem: {
      readOnlyRoots: ["/usr/local/lib/eigengrid"],
      readWriteRoots: [scratchRoot, artifactRoot],
      deniedRoots: ["/etc/eigengrid", "/var/lib/eigengrid/head", "/home"],
      privateTmp: true,
    },
    environment: {
      allowedKeys: ["LANG", "LC_ALL", "OMP_NUM_THREADS", "PATH"],
      deniedKeys: [...SECURITY_DENIED_ENVIRONMENT_KEYS],
      maxValueBytes: 4_096,
      secretDelivery: "reference_only",
    },
    network: {
      defaultPolicy: "deny",
      allowedEgress: [...(input.allowedEgress ?? [])],
    },
    resources: { ...DEFAULT_SECURITY_RESOURCE_LIMITS, ...input.resources },
    systemd: {
      user: "eigengrid-worker",
      group: "eigengrid-worker",
      appArmorProfile: "eigengrid-worker-job",
      readWritePaths: [scratchRoot, artifactRoot],
      allowedAddressFamilies: ["AF_UNIX"],
      credentialNames: [],
    },
  });
}

export interface StaticSystemdSecurityExpectation {
  id: "head" | "worker";
  unitPath: string;
  user: string;
  group: string;
  appArmorProfile: string;
  readWritePaths: readonly string[];
  addressFamilies: readonly ("AF_UNIX" | "AF_INET" | "AF_INET6")[];
  credentialNames: readonly string[];
  postgresPeerSocketGroup?: string;
}

export const STATIC_SYSTEMD_SECURITY_EXPECTATIONS: Readonly<
  Record<StaticSystemdSecurityExpectation["id"], StaticSystemdSecurityExpectation>
> = Object.freeze({
  head: Object.freeze({
    id: "head",
    unitPath: "packaging/systemd/eigengrid-head.service",
    user: "eigengrid",
    group: "eigengrid",
    appArmorProfile: "eigengrid-head",
    readWritePaths: ["/var/lib/eigengrid/head"],
    addressFamilies: ["AF_UNIX"] as const,
    credentialNames: [],
    postgresPeerSocketGroup: "eigengrid-db",
  }),
  worker: Object.freeze({
    id: "worker",
    unitPath: "packaging/systemd/eigengrid-worker.service",
    user: "eigengrid-worker",
    group: "eigengrid-worker",
    appArmorProfile: "eigengrid-worker",
    readWritePaths: ["/var/lib/eigengrid/worker", "/var/log/eigengrid", "/scratch/eigengrid"],
    addressFamilies: ["AF_UNIX", "AF_INET", "AF_INET6"] as const,
    credentialNames: ["worker-identity"],
  }),
});
