/** Rootless-container provisioning ONLY; never production service configuration. */
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmodSync, chownSync, mkdirSync, writeFileSync } from "node:fs";
import { canonicalJson } from "@eigengrid/scientific-schema";
import { computeAmberSlurmSiteProfileDigest } from "../../../apps/cli/src/services/amber-slurm-profile";
import { reviewedSander26Environment } from "../../../packages/amber-adapter/src/canonical-stage.fixture";

export const FIXTURE_ROOT = "/fixture";
export const FIXTURE_PUBLICATION = "/fixture/publication";
export const FIXTURE_PRIVATE_CAS = "/fixture/private-cas";
export const FIXTURE_AUTHORITY = "/fixture/head.json";
export const FIXTURE_CONTROL = "/fixture/control";
export const FIXTURE_SOCKET = "/fixture/submitter.sock";
export const fixtureEnvironment = reviewedSander26Environment();

if (import.meta.main) {
  if (process.env.EIGENGRID_MD_BOUNDARY_CONTAINER !== "1" || process.getuid?.() !== 0)
    throw new Error("Test provisioning requires the isolated rootless-container root");
  mkdirSync(FIXTURE_ROOT, { mode: 0o755 });
  for (const path of [FIXTURE_PUBLICATION, FIXTURE_PRIVATE_CAS, FIXTURE_CONTROL]) {
    mkdirSync(path, { mode: 0o770 });
    chmodSync(path, 0o770);
    chownSync(path, 1000, 1000);
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicDer = createPublicKey(privateKey).export({ type: "spki", format: "der" }) as Buffer;
  const profile = {
    schemaVersion: "eigengrid.amber-slurm-site/v1",
    profilePath: "/fixture/profile.json",
    transport: {
      cluster: "counted-fixture",
      slurmVersion: "23.11.4",
      uid: 2101,
      username: "test-scientist",
      home: "/home/test-scientist",
      submissionDirectory: "/home/test-scientist/.eg-submit",
      siteProfileDigest: "0".repeat(64),
      partition: "test",
      node: "counted-node",
      account: "test-account",
      cpuLimit: 2,
      memoryMiBLimit: 1024,
      walltimeLimitSeconds: 3600,
    },
    gid: 2101,
    runnerExecutable: "/opt/test-only-amber-runner",
    runnerSha256: "1".repeat(64),
    amberHome: "/opt/test-only-amber",
    sanderSha256: fixtureEnvironment.canonicalSnapshot.engine.buildDigest,
    amberVersion: fixtureEnvironment.canonicalSnapshot.engine.version,
    engineEnvironmentDigest: fixtureEnvironment.canonicalSnapshot.engine.environmentDigest,
    scratchRoot: "/scratch/test-only",
    projects: [
      {
        subject: "scientist-1",
        projectId: "project-md-boundary",
        publicationRoot: FIXTURE_PUBLICATION,
      },
    ],
  };
  profile.transport.siteProfileDigest = computeAmberSlurmSiteProfileDigest(profile);
  const policy = {
    schemaVersion: "eigengrid.submitter-site-policy/v1",
    uid: 2101,
    gid: 2101,
    headUid: 1000,
    recoveryEpoch: "counted-epoch",
    siteProfileDigest: profile.transport.siteProfileDigest,
    currentPolicyDigest: "f".repeat(64),
    publicKeyHex: publicDer.subarray(-32).toString("hex"),
    memberships: [{ subject: "scientist-1", projectId: "project-md-boundary", generation: 1 }],
  };
  const service = {
    schemaVersion: "eigengrid.submitter-service/v1",
    configPath: "/fixture/service.json",
    uid: 2101,
    gid: 2101,
    headUid: 1000,
    appArmorProfile: "eigengrid-submitter-fixture",
    socketPath: FIXTURE_SOCKET,
    journalPath: "/fixture/journal",
    journalId: "counted-journal",
    launchAuthorityPath: "/fixture/launch",
    launchAuthorityDevice: "1",
    launchAuthorityInode: "2",
    launchAuthoritySha256: "2".repeat(64),
    backendExecutable: "/opt/test-only-counted-backend",
    backendSha256: "3".repeat(64),
    siteProfilePath: profile.profilePath,
    policyPath: "/fixture/policy.json",
  };
  const head = {
    schemaVersion: "eigengrid.head-md-site-authority/v1",
    configPath: FIXTURE_AUTHORITY,
    headUid: 1000,
    privateKeyPath: "/fixture/key.pem",
    submitterConfigPaths: [service.configPath],
  };
  for (const [path, value] of [
    [profile.profilePath, profile],
    [service.policyPath, policy],
    [service.configPath, service],
    [FIXTURE_AUTHORITY, head],
  ] as const)
    writeFileSync(path, canonicalJson(value), { mode: 0o644 });
  writeFileSync(head.privateKeyPath, pem, { mode: 0o640 });
  chownSync(head.privateKeyPath, 0, 1000);
  chmodSync(head.privateKeyPath, 0o640);
}
