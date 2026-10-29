import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContentAddressedArtifactStore,
  ScientificEffectReconciliationStore,
  type ScientificDatabase,
} from "@eigengrid/mission-runtime";
import type { VerifiedAmberStageBundle } from "./amber-stage-bundle";
import { canonicalJson, digestCanonical, digestBytes } from "@eigengrid/scientific-schema";
import {
  computeAmberSlurmSiteProfileDigest,
  type AmberSlurmSiteProfile,
} from "./amber-slurm-profile";
import {
  createHeadMdSiteAuthorityReaderForTest,
  HeadMdTrustedProjectAssociationSchema,
  type HeadMdSiteAuthorityConfig,
  type HeadMdSiteAuthorityFileSystem,
  type ProtectedHeadMdFileStat,
} from "./head-md-site-authority";
import { createSlurmSubmissionBinding } from "@eigengrid/slurm";
import { syntheticAmberBundleFixture } from "./amber-stage-bundle.fixture";
import type { SubmitterServiceConfig, SubmitterSitePolicy } from "./submitter-site-authority";

const HEAD_UID = 9001;
const SUBMITTER_UID = 2101;
const SUBMITTER_GID = 2911;
const association = { subject: "fixture-user", projectId: "project-1" };
const paths = {
  root: "/",
  etc: "/etc",
  directory: "/etc/eigengrid",
  head: "/etc/eigengrid/head-md-authority.json",
  service: "/etc/eigengrid/submitter-2101.json",
  policy: "/etc/eigengrid/submitter-2101-policy.json",
  profile: "/etc/eigengrid/amber-2101.json",
  signingKey: "/etc/eigengrid/head-md-ed25519.pem",
} as const;

const digest = (character: string) => character.repeat(64);
const fixtures: HeadAuthorityFixture[] = [];

type MetadataOverride = Partial<
  Pick<
    ProtectedHeadMdFileStat,
    "uid" | "gid" | "mode" | "nlink" | "size" | "dev" | "ino" | "mtimeMs" | "ctimeMs"
  >
>;

interface HeadAuthorityFixture {
  readonly root: string;
  readonly physicalPath: ReadonlyMap<string, string>;
  readonly fileSystem: HeadMdSiteAuthorityFileSystem;
  readonly metadataOverrides: Map<string, MetadataOverride>;
  readonly lstatCounts: Map<string, number>;
  privateKeyPem: string;
  currentUid: number;
  onLstat?: (logicalPath: string, count: number) => void;
  unstableHandlePath?: string;
  writeJson(logicalPath: string, value: unknown): void;
  readJson<T>(logicalPath: string): T;
  rotateKey(): void;
  cleanup(): void;
}

function ed25519PrivateKeyPem(): string {
  const keyPair = generateKeyPairSync("ed25519");
  return keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function ed25519PublicKeyHex(privateKeyPem: string): string {
  const der = createPublicKey(createPrivateKey(privateKeyPem)).export({
    type: "spki",
    format: "der",
  }) as Buffer;
  return der.subarray(-32).toString("hex");
}

function createFixture(pmemdCudaSha256?: string): HeadAuthorityFixture {
  const root = mkdtempSync(join(tmpdir(), "eigengrid-head-authority-"));
  const physicalPath = new Map<string, string>([
    [paths.root, root],
    [paths.etc, root],
    [paths.directory, root],
    [paths.head, join(root, "head-md-authority.json")],
    [paths.service, join(root, "submitter-2101.json")],
    [paths.policy, join(root, "submitter-2101-policy.json")],
    [paths.profile, join(root, "amber-2101.json")],
    [paths.signingKey, join(root, "head-md-ed25519.pem")],
  ]);
  const metadataOverrides = new Map<string, MetadataOverride>();
  const lstatCounts = new Map<string, number>();
  let currentUid = HEAD_UID;
  let onLstat: HeadAuthorityFixture["onLstat"];
  let unstableHandlePath: string | undefined;

  const physical = (logicalPath: string): string => {
    const resolved = physicalPath.get(logicalPath);
    if (!resolved) throw new Error(`Unexpected protected path fixture access: ${logicalPath}`);
    return resolved;
  };
  const protect = (logicalPath: string, info = lstatSync(physical(logicalPath))) => {
    const mode =
      (info.mode & ~0o777) | (info.isDirectory() ? 0o755 : info.isSymbolicLink() ? 0o640 : 0o640);
    return {
      uid: 0,
      gid: 0,
      mode,
      nlink: info.nlink,
      size: info.size,
      dev: info.dev,
      ino: info.ino,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      isFile: () => info.isFile(),
      isDirectory: () => info.isDirectory(),
      isSymbolicLink: () => info.isSymbolicLink(),
      ...metadataOverrides.get(logicalPath),
    } satisfies ProtectedHeadMdFileStat;
  };
  const fileSystem: HeadMdSiteAuthorityFileSystem = {
    currentUid: () => currentUid,
    lstat(logicalPath) {
      const count = (lstatCounts.get(logicalPath) ?? 0) + 1;
      lstatCounts.set(logicalPath, count);
      const stat = protect(logicalPath);
      onLstat?.(logicalPath, count);
      return stat;
    },
    openReadOnlyNoFollow(logicalPath) {
      const descriptor = openSync(physical(logicalPath), constants.O_RDONLY | constants.O_NOFOLLOW);
      let closed = false;
      let statCalls = 0;
      return {
        stat() {
          statCalls++;
          const stat = protect(logicalPath, fstatSync(descriptor));
          return logicalPath === unstableHandlePath && statCalls > 1
            ? { ...stat, ctimeMs: stat.ctimeMs + 1 }
            : stat;
        },
        readExact(size) {
          const bytes = Buffer.alloc(size);
          let offset = 0;
          while (offset < bytes.length) {
            const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
            if (!count) throw new Error("Test fixture read unexpectedly truncated");
            offset += count;
          }
          return bytes;
        },
        close() {
          if (!closed) {
            closed = true;
            closeSync(descriptor);
          }
        },
      };
    },
  };
  const privateKeyPem = ed25519PrivateKeyPem();
  const profile = {
    schemaVersion: "eigengrid.amber-slurm-site/v1",
    profilePath: paths.profile,
    transport: {
      cluster: "fixture-cluster",
      slurmVersion: "23.11.4",
      uid: SUBMITTER_UID,
      username: "fixtureuser",
      home: "/home/fixtureuser",
      submissionDirectory: "/home/fixtureuser/.eg-submit",
      siteProfileDigest: digest("0"),
      partition: "chem",
      node: "worker-01",
      account: "fixture-account",
      cpuLimit: 2,
      memoryMiBLimit: 1024,
      walltimeLimitSeconds: 3600,
    },
    gid: SUBMITTER_GID,
    runnerExecutable: "/opt/eigengrid/bin/amber-runner",
    runnerSha256: digest("1"),
    amberHome: "/opt/ambertools-26",
    sanderSha256: digest("2"),
    ...(pmemdCudaSha256 ? { pmemdCudaSha256, gpuLibraryTreeSha256: digest("b") } : {}),
    amberVersion: "26",
    engineEnvironmentDigest: digest("3"),
    scratchRoot: "/scratch/eigengrid",
    projects: [
      {
        ...association,
        publicationRoot: "/srv/eigengrid/inputs/2101/project-1",
      },
    ],
  };
  profile.transport.siteProfileDigest = computeAmberSlurmSiteProfileDigest(profile);
  const writeJson = (logicalPath: string, value: unknown) => {
    writeFileSync(physical(logicalPath), canonicalJson(value), { mode: 0o600 });
  };
  const policy = {
    schemaVersion: "eigengrid.submitter-site-policy/v1",
    uid: SUBMITTER_UID,
    gid: SUBMITTER_GID,
    headUid: HEAD_UID,
    recoveryEpoch: "fixture-epoch-1",
    siteProfileDigest: profile.transport.siteProfileDigest,
    currentPolicyDigest: digest("4"),
    publicKeyHex: ed25519PublicKeyHex(privateKeyPem),
    memberships: [{ ...association, generation: 3 }],
  };
  writeFileSync(physical(paths.signingKey), privateKeyPem, { mode: 0o600 });
  writeJson(paths.profile, profile);
  writeJson(paths.policy, policy);
  writeJson(paths.service, {
    schemaVersion: "eigengrid.submitter-service/v1",
    configPath: paths.service,
    uid: SUBMITTER_UID,
    gid: SUBMITTER_GID,
    headUid: HEAD_UID,
    appArmorProfile: "eigengrid-submitter-2101",
    socketPath: "/run/eigengrid/submitter-2101.sock",
    journalPath: "/var/lib/eigengrid/submitter-2101.journal",
    journalId: "fixture-journal-2101",
    launchAuthorityPath: "/var/lib/eigengrid/submitter-2101.launch",
    launchAuthorityDevice: "1",
    launchAuthorityInode: "2",
    launchAuthoritySha256: digest("5"),
    backendExecutable: "/opt/eigengrid/bin/submitter-backend",
    backendSha256: digest("6"),
    siteProfilePath: paths.profile,
    policyPath: paths.policy,
  });
  writeJson(paths.head, {
    schemaVersion: "eigengrid.head-md-site-authority/v1",
    configPath: paths.head,
    headUid: HEAD_UID,
    privateKeyPath: paths.signingKey,
    submitterConfigPaths: [paths.service],
  });
  const result: HeadAuthorityFixture = {
    root,
    physicalPath,
    fileSystem,
    metadataOverrides,
    lstatCounts,
    get privateKeyPem() {
      return privateKeyPem;
    },
    set privateKeyPem(value: string) {
      writeFileSync(physical(paths.signingKey), value, { mode: 0o600 });
    },
    get currentUid() {
      return currentUid;
    },
    set currentUid(value: number) {
      currentUid = value;
    },
    get onLstat() {
      return onLstat;
    },
    set onLstat(value) {
      onLstat = value;
    },
    get unstableHandlePath() {
      return unstableHandlePath;
    },
    set unstableHandlePath(value) {
      unstableHandlePath = value;
    },
    writeJson,
    readJson<T>(logicalPath: string): T {
      return JSON.parse(readFileSync(physical(logicalPath), "utf8")) as T;
    },
    rotateKey() {
      const replacement = ed25519PrivateKeyPem();
      writeFileSync(physical(paths.signingKey), replacement, { mode: 0o600 });
      const nextPolicy = result.readJson<SubmitterSitePolicy>(paths.policy);
      nextPolicy.publicKeyHex = ed25519PublicKeyHex(replacement);
      writeJson(paths.policy, nextPolicy);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
  fixtures.push(result);
  return result;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function readerFor(fixture: HeadAuthorityFixture) {
  return createHeadMdSiteAuthorityReaderForTest(paths.head, fixture.fileSystem);
}

function thrownMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected protected authority operation to throw");
}

describe("Head MD protected site authority", () => {
  test("binds a delivery session to one protected endpoint/key snapshot before any database access", async () => {
    const fixture = createFixture();
    const reader = readerFor(fixture);
    let databaseCalls = 0;
    const database = {
      _provider: "postgres" as const,
      async beginTransaction() {
        databaseCalls++;
        throw new Error("database must not be reached after protected authority drift");
      },
    } as ScientificDatabase;
    const session = reader.createAmberDeliverySession(
      database,
      association,
      {} as VerifiedAmberStageBundle,
      () => new Date("2026-09-20T00:00:00.000Z"),
    );
    expect(JSON.stringify(session)).not.toContain(fixture.privateKeyPem);
    await expect(
      session.authorizeSubmitRpc({
        prepared: {} as never,
        claimOwner: "head-md-authority-fixture",
      }),
    ).rejects.toThrow("issued by this delivery session");

    const service = fixture.readJson<SubmitterServiceConfig>(paths.service);
    service.socketPath = "/run/eigengrid/submitter-2101-rotated.sock";
    fixture.writeJson(paths.service, service);
    await expect(
      session.prepare({
        operationId: "operation-session-1",
        claimOwner: "head-md-authority-fixture",
      }),
    ).rejects.toThrow("changed during delivery session");
    expect(databaseCalls).toBe(0);

    const membershipFixture = createFixture();
    const membershipSession = readerFor(membershipFixture).createAmberDeliverySession(
      database,
      association,
      {} as VerifiedAmberStageBundle,
    );
    const policy = membershipFixture.readJson<SubmitterSitePolicy>(paths.policy);
    policy.memberships[0]!.generation++;
    membershipFixture.writeJson(paths.policy, policy);
    await expect(
      membershipSession.prepare({
        operationId: "operation-session-2",
        claimOwner: "head-md-authority-fixture",
      }),
    ).rejects.toThrow("changed during delivery session");

    const keyFixture = createFixture();
    const keySession = readerFor(keyFixture).createAmberDeliverySession(
      database,
      association,
      {} as VerifiedAmberStageBundle,
    );
    keyFixture.rotateKey();
    await expect(
      keySession.prepare({
        operationId: "operation-session-3",
        claimOwner: "head-md-authority-fixture",
      }),
    ).rejects.toThrow("changed during delivery session");
    expect(databaseCalls).toBe(0);
  });

  test("resolves an exact fresh grant from protected config without serializing its key", () => {
    const fixture = createFixture();
    const reader = readerFor(fixture);

    expect(reader.resolveCurrentGrant(association)).toEqual({
      principal: {
        ...association,
        uid: SUBMITTER_UID,
        gid: SUBMITTER_GID,
        siteProfileDigest: fixture.readJson<SubmitterSitePolicy>(paths.policy).siteProfileDigest,
      },
      recoveryEpoch: "fixture-epoch-1",
      membershipGeneration: 3,
      currentPolicyDigest: digest("4"),
    });
    expect(
      HeadMdTrustedProjectAssociationSchema.safeParse({ ...association, uid: 2103 }).success,
    ).toBe(false);
    expect(JSON.stringify(reader)).not.toContain(fixture.privateKeyPem);
    expect(Object.keys(reader)).not.toContain("privateKeyPem");
  });

  test("re-reads revocation, generation, profile and service drift before granting", () => {
    const fixture = createFixture();
    const reader = readerFor(fixture);
    expect(reader.resolveCurrentGrant(association).membershipGeneration).toBe(3);

    const updatedPolicy = fixture.readJson<SubmitterSitePolicy>(paths.policy);
    updatedPolicy.memberships[0].generation = 4;
    fixture.writeJson(paths.policy, updatedPolicy);
    expect(reader.resolveCurrentGrant(association).membershipGeneration).toBe(4);

    updatedPolicy.memberships = [];
    fixture.writeJson(paths.policy, updatedPolicy);
    expect(() => reader.resolveCurrentGrant(association)).toThrow("missing or ambiguous");

    updatedPolicy.memberships = [{ ...association, generation: 4 }];
    fixture.writeJson(paths.policy, updatedPolicy);
    const service = fixture.readJson<SubmitterServiceConfig>(paths.service);
    service.headUid = HEAD_UID + 1;
    fixture.writeJson(paths.service, service);
    expect(() => reader.resolveCurrentGrant(association)).toThrow("disagrees with Head authority");

    const profileDrift = createFixture();
    const profile = profileDrift.readJson<AmberSlurmSiteProfile>(paths.profile);
    profile.gid++;
    profile.transport.siteProfileDigest = computeAmberSlurmSiteProfileDigest(profile);
    profileDrift.writeJson(paths.profile, profile);
    const policy = profileDrift.readJson<SubmitterSitePolicy>(paths.policy);
    policy.siteProfileDigest = profile.transport.siteProfileDigest;
    profileDrift.writeJson(paths.policy, policy);
    expect(() => readerFor(profileDrift).resolveCurrentGrant(association)).toThrow(
      "profile differs from submitter authority",
    );
  });

  test("rejects an absent UID, duplicate membership, mismatched public key and non-provisioned project", () => {
    const fixture = createFixture();
    const reader = readerFor(fixture);
    const service = fixture.readJson<SubmitterServiceConfig>(paths.service) as Record<
      string,
      unknown
    >;
    delete service.uid;
    fixture.writeJson(paths.service, service);
    expect(() => reader.resolveCurrentGrant(association)).toThrow("Invalid protected submitter");

    const second = createFixture();
    const duplicatePolicy = second.readJson<SubmitterSitePolicy>(paths.policy);
    duplicatePolicy.memberships.push({ ...association, generation: 3 });
    second.writeJson(paths.policy, duplicatePolicy);
    expect(() => readerFor(second).resolveCurrentGrant(association)).toThrow(
      "Invalid protected submitter",
    );

    const third = createFixture();
    const wrongKeyPolicy = third.readJson<SubmitterSitePolicy>(paths.policy);
    wrongKeyPolicy.publicKeyHex = ed25519PublicKeyHex(ed25519PrivateKeyPem());
    third.writeJson(paths.policy, wrongKeyPolicy);
    const error = thrownMessage(() => readerFor(third).resolveCurrentGrant(association));
    expect(error).toContain("does not match");
    expect(error).not.toContain(third.privateKeyPem);

    const fourth = createFixture();
    const missingProjectProfile = fourth.readJson<AmberSlurmSiteProfile>(paths.profile);
    missingProjectProfile.projects = [
      {
        subject: "another-user",
        projectId: "another-project",
        publicationRoot: "/srv/eigengrid/inputs/2101/another-project",
      },
    ];
    missingProjectProfile.transport.siteProfileDigest =
      computeAmberSlurmSiteProfileDigest(missingProjectProfile);
    fourth.writeJson(paths.profile, missingProjectProfile);
    const missingProjectPolicy = fourth.readJson<SubmitterSitePolicy>(paths.policy);
    missingProjectPolicy.siteProfileDigest = missingProjectProfile.transport.siteProfileDigest;
    fourth.writeJson(paths.policy, missingProjectPolicy);
    expect(() => readerFor(fourth).resolveCurrentGrant(association)).toThrow(
      "missing or ambiguous",
    );
  });

  test("fails closed when a protected authority file changes after its read", () => {
    const fixture = createFixture();
    fixture.onLstat = (logicalPath, count) => {
      if (logicalPath === paths.policy && count === 2) {
        const policy = fixture.readJson<SubmitterSitePolicy>(paths.policy);
        policy.memberships = [];
        fixture.writeJson(paths.policy, policy);
      }
    };
    expect(() => readerFor(fixture).resolveCurrentGrant(association)).toThrow(
      "changed during resolution",
    );

    const unstable = createFixture();
    unstable.unstableHandlePath = paths.head;
    expect(() => readerFor(unstable).resolveCurrentGrant(association)).toThrow(
      "changed during read",
    );
  });

  test("rejects symlinks, hardlinks, writable ancestors, oversize and noncanonical config", () => {
    const symlink = createFixture();
    unlinkSync(symlink.physicalPath.get(paths.head)!);
    symlinkSync(symlink.physicalPath.get(paths.service)!, symlink.physicalPath.get(paths.head)!);
    expect(() => readerFor(symlink).resolveCurrentGrant(association)).toThrow("bounded root-owned");

    const hardlink = createFixture();
    linkSync(
      hardlink.physicalPath.get(paths.head)!,
      join(hardlink.root, "head-md-authority-link.json"),
    );
    expect(() => readerFor(hardlink).resolveCurrentGrant(association)).toThrow(
      "bounded root-owned",
    );

    const writableAncestor = createFixture();
    writableAncestor.metadataOverrides.set(paths.etc, { mode: 0o775 });
    expect(() => readerFor(writableAncestor).resolveCurrentGrant(association)).toThrow(
      "unsafe ancestor",
    );

    const oversize = createFixture();
    writeFileSync(oversize.physicalPath.get(paths.head)!, Buffer.alloc(64 * 1024 + 1, 0x20));
    expect(() => readerFor(oversize).resolveCurrentGrant(association)).toThrow(
      "bounded root-owned",
    );

    const noncanonical = createFixture();
    const config = noncanonical.readJson<HeadMdSiteAuthorityConfig>(paths.head);
    writeFileSync(noncanonical.physicalPath.get(paths.head)!, JSON.stringify(config, null, 2));
    expect(() => readerFor(noncanonical).resolveCurrentGrant(association)).toThrow(
      "Invalid protected Head",
    );
  });

  test("rejects a different runtime Head identity and never reuses a rotated signing key", async () => {
    const fixture = createFixture();
    fixture.currentUid = HEAD_UID + 1;
    expect(() => readerFor(fixture).resolveCurrentGrant(association)).toThrow(
      "configured Head UID",
    );

    const rotated = createFixture();
    const reader = readerFor(rotated);
    const signer = reader.createSigner(
      {
        _provider: "postgres",
        beginTransaction: async () => {
          throw new Error("Database must not be touched before rotated-key rejection");
        },
      } as unknown as ScientificDatabase,
      association,
      () => ({}),
      () => new Date("2026-09-20T12:00:00.000Z"),
    );
    expect(JSON.stringify(signer)).not.toContain(rotated.privateKeyPem);
    rotated.rotateKey();
    await expect(signer.observe("operation-1")).rejects.toThrow("key rotated");
  });
});

async function observationDeliveryFixture(fixture: HeadAuthorityFixture) {
  const reader = readerFor(fixture);
  const store = new ContentAddressedArtifactStore(join(fixture.root, "cas"));
  await store.init();
  const { seed } = await syntheticAmberBundleFixture(store);
  const grant = reader.resolveCurrentGrant(association);
  const at = "2026-09-20T00:00:00.000Z";
  const expiresAt = "2026-09-20T00:01:00.000Z";
  const operationId = "operation-protected-observation";
  const requestDigest = digestCanonical(seed.request);
  const binding = createSlurmSubmissionBinding({
    operationId,
    requestDigest,
    admissionDigest: digest("a"),
    scriptDigest: digest("b"),
    siteProfileDigest: grant.principal.siteProfileDigest,
    uid: grant.principal.uid,
    cluster: "fixture-cluster",
    notBefore: at,
    expiresAt,
    resources: {
      partition: "chem",
      node: "worker-01",
      account: "fixture-account",
      cpus: 1,
      memoryMiB: 256,
      walltimeSeconds: 60,
    },
  });
  const body = Buffer.from(
    canonicalJson({
      schemaVersion: "eigengrid.amber-slurm-delivery/v1",
      request: seed.request,
      binding,
      bundle: { sha256: digest("c"), sizeBytes: 100 },
    }),
  );
  const unsigned = {
    schemaVersion: "eigengrid.md-effect-delivery/v1" as const,
    operationId,
    missionId: "mission-protected-observation",
    workUnitId: seed.request.workUnitId,
    requestDigest,
    admissionDigest: binding.admissionDigest,
    fencingGeneration: 7,
    principal: grant.principal,
    transport: "slurm.amber-md/v1" as const,
    bindingDigest: binding.bindingDigest,
    bodyBase64: body.toString("base64"),
    bodyDigest: digestBytes(body),
    notBefore: at,
    expiresAt,
    createdAt: at,
  };
  return { ...unsigned, deliveryDigest: digestCanonical(unsigned) };
}

describe("Head protected MD observation", () => {
  test("publication selection is a protected fresh copy without key material", () => {
    const fixture = createFixture();
    const reader = readerFor(fixture);
    expect(() => reader.resolveResultPublication(association)).toThrow("not configured");
    const value = reader.resolvePublication(association);
    expect(value.publicationRoot).toBe("/srv/eigengrid/inputs/2101/project-1");
    expect(value.environment).toEqual({
      amberVersion: "26",
      sanderSha256: digest("2"),
      engineEnvironmentDigest: digest("3"),
    });
    expect(JSON.stringify(value)).not.toContain(fixture.privateKeyPem);
    value.grant.principal.uid = 999;
    expect(reader.resolvePublication(association).grant.principal.uid).toBe(SUBMITTER_UID);
    expect(() =>
      reader.resolvePublication({ ...association, projectId: "another-project" }),
    ).toThrow();
  });

  test("publication authority exposes only the root-provisioned pmemd.cuda digest", () => {
    const cpuOnly = readerFor(createFixture()).resolvePublication(association);
    expect(cpuOnly.environment).not.toHaveProperty("pmemdCudaSha256");

    const gpuReader = readerFor(createFixture(digest("4")));
    expect(gpuReader.resolvePublication(association).environment).toMatchObject({
      sanderSha256: digest("2"),
      pmemdCudaSha256: digest("4"),
    });
  });

  test("observes expired delivery with one private snapshot and refuses forged/reused tokens", async () => {
    const fixture = createFixture();
    const delivery = await observationDeliveryFixture(fixture);
    const read = spyOn(
      ScientificEffectReconciliationStore.prototype,
      "readMdSubmissionDelivery",
    ).mockImplementation(async () => structuredClone(delivery));
    try {
      const database = {
        _provider: "postgres",
        beginTransaction: async () => {
          throw new Error("DB seam replaced");
        },
      } as ScientificDatabase;
      const session = readerFor(fixture).createAmberObservationSession(
        database,
        association,
        () => new Date("2026-09-20T01:00:00.000Z"),
      );
      await expect(session.authorizeObserveRpc({ prepared: {} as never })).rejects.toThrow(
        "issued by this delivery session",
      );
      const prepared = await session.observe(delivery.operationId);
      const originalWire = new Uint8Array(prepared.wire);
      expect(prepared.capability.action).toBe("observe");
      expect(prepared.capability.fencingGeneration).toBe(7);
      prepared.action = "submit";
      prepared.wire.fill(0);
      prepared.delivery.fencingGeneration = 99;
      const target = await session.authorizeObserveRpc({ prepared });
      expect(target.wire).toEqual(originalWire);
      expect(target.delivery.fencingGeneration).toBe(7);
      expect(read).toHaveBeenCalledTimes(3);
      await expect(session.authorizeObserveRpc({ prepared })).rejects.toThrow("already consumed");
    } finally {
      read.mockRestore();
    }
  });

  test("accounts for expired delivery with one private snapshot and refuses forged/reused tokens", async () => {
    const fixture = createFixture();
    const delivery = await observationDeliveryFixture(fixture);
    const read = spyOn(
      ScientificEffectReconciliationStore.prototype,
      "readMdSubmissionDelivery",
    ).mockImplementation(async () => structuredClone(delivery));
    try {
      const database = {
        _provider: "postgres",
        beginTransaction: async () => {
          throw new Error("DB seam replaced");
        },
      } as ScientificDatabase;
      const session = readerFor(fixture).createAmberAccountingSession(
        database,
        association,
        () => new Date("2026-09-20T01:00:00.000Z"),
      );
      await expect(session.authorizeAccountingRpc({ prepared: {} as never })).rejects.toThrow(
        "issued by this delivery session",
      );
      const prepared = await session.accounting(delivery.operationId);
      const originalWire = new Uint8Array(prepared.wire);
      expect(prepared.capability.action).toBe("accounting");
      expect(prepared.capability.fencingGeneration).toBe(7);
      expect(prepared.capability.version).toBe("eigengrid.submitter-capability/v2");
      expect(prepared.delivery.bodyDigest).toBe(delivery.bodyDigest);
      prepared.capability.uid = 999;
      prepared.wire.fill(0);
      prepared.delivery.fencingGeneration = 99;
      const target = await session.authorizeAccountingRpc({ prepared });
      expect(target.wire).toEqual(originalWire);
      expect(target.delivery.fencingGeneration).toBe(7);
      // Accounting reads once to sign and once more before authorizing the RPC.
      expect(read).toHaveBeenCalledTimes(2);
      await expect(session.authorizeAccountingRpc({ prepared })).rejects.toThrow(
        "already consumed",
      );
    } finally {
      read.mockRestore();
    }
  });

  test.each(["revocation", "epoch", "membership", "socket", "expiry", "delivery"])(
    "blocks %s between signing and RPC authorization",
    async (change) => {
      const fixture = createFixture();
      const delivery = await observationDeliveryFixture(fixture);
      const read = spyOn(
        ScientificEffectReconciliationStore.prototype,
        "readMdSubmissionDelivery",
      ).mockImplementation(async () => structuredClone(delivery));
      try {
        const database = {
          _provider: "postgres",
          beginTransaction: async () => {
            throw new Error("DB seam replaced");
          },
        } as ScientificDatabase;
        let clock = Date.parse("2026-09-20T01:00:00.000Z");
        const session = readerFor(fixture).createAmberObservationSession(
          database,
          association,
          () => new Date(clock),
        );
        const prepared = await session.observe(delivery.operationId);
        if (change === "revocation") read.mockRejectedValue(new Error("Membership revoked"));
        if (change === "delivery") read.mockResolvedValue({ ...delivery, fencingGeneration: 8 });
        if (change === "expiry") clock += 60_000;
        if (change === "epoch" || change === "membership") {
          const policy = fixture.readJson<SubmitterSitePolicy>(paths.policy);
          if (change === "epoch") policy.recoveryEpoch = "rotated-epoch";
          else policy.memberships[0]!.generation++;
          fixture.writeJson(paths.policy, policy);
        }
        if (change === "socket") {
          const service = fixture.readJson<SubmitterServiceConfig>(paths.service);
          service.socketPath = "/run/eigengrid/rotated.sock";
          fixture.writeJson(paths.service, service);
        }
        await expect(session.authorizeObserveRpc({ prepared })).rejects.toThrow();
        await expect(session.authorizeObserveRpc({ prepared })).rejects.toThrow("already consumed");
      } finally {
        read.mockRestore();
      }
    },
  );
  test.each(["revocation", "epoch", "membership", "socket", "expiry", "delivery"])(
    "accounting blocks %s between signing and RPC authorization",
    async (change) => {
      const fixture = createFixture();
      const delivery = await observationDeliveryFixture(fixture);
      const read = spyOn(
        ScientificEffectReconciliationStore.prototype,
        "readMdSubmissionDelivery",
      ).mockImplementation(async () => structuredClone(delivery));
      try {
        const database = {
          _provider: "postgres",
          beginTransaction: async () => {
            throw new Error("DB seam replaced");
          },
        } as ScientificDatabase;
        let clock = Date.parse("2026-09-20T01:00:00.000Z");
        const session = readerFor(fixture).createAmberAccountingSession(
          database,
          association,
          () => new Date(clock),
        );
        const prepared = await session.accounting(delivery.operationId);
        if (change === "revocation") read.mockRejectedValue(new Error("Membership revoked"));
        if (change === "delivery") read.mockResolvedValue({ ...delivery, fencingGeneration: 8 });
        if (change === "expiry") clock += 60_000;
        if (change === "epoch" || change === "membership") {
          const policy = fixture.readJson<SubmitterSitePolicy>(paths.policy);
          if (change === "epoch") policy.recoveryEpoch = "rotated-epoch";
          else policy.memberships[0]!.generation++;
          fixture.writeJson(paths.policy, policy);
        }
        if (change === "socket") {
          const service = fixture.readJson<SubmitterServiceConfig>(paths.service);
          service.socketPath = "/run/eigengrid/rotated.sock";
          fixture.writeJson(paths.service, service);
        }
        await expect(session.authorizeAccountingRpc({ prepared })).rejects.toThrow();
        await expect(session.authorizeAccountingRpc({ prepared })).rejects.toThrow(
          "already consumed",
        );
      } finally {
        read.mockRestore();
      }
    },
  );
});
