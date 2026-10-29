import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  canonicalJson,
  computeMdEnvironmentCapabilitySnapshotDigest,
  MdEnvironmentCapabilitySnapshotSchemaVersion,
} from "@eigengrid/scientific-schema";
import {
  computeCompilerPolicyDigest,
  computeMdCompilerPolicyDigest,
} from "@eigengrid/scientific-agent";
import { makeCompilerPolicy, makeEnvironment } from "@eigengrid/scientific-agent/test-fixtures";
import {
  MissionClientConfigPath,
  MissionClientConfigSchema,
  MissionLocalAuthority,
  type MissionClientConfig,
  type MissionLocalAuthorityTestIo,
} from "./mission-local-authority";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mission-authority-"));
  cleanup.push(root);
  mkdirSync(join(root, "etc/eigengrid"), { recursive: true, mode: 0o755 });
  const actual = (path: string) => join(root, path);
  const config: MissionClientConfig = {
    schemaVersion: "eigengrid.mission-client/v1",
    artifactRoot: "/var/lib/eigengrid/mission-artifacts",
    databaseUrl: "postgresql://mission_user:protected@localhost:5432/eigengrid",
    operators: [
      {
        uid: 1001,
        actorId: "scientist-one",
        primaryRole: "scientist",
        roles: ["scientist", "scientific_reviewer"],
      },
    ],
    compilerPolicy: makeCompilerPolicy(),
    environment: makeEnvironment(),
  };
  const write = (value: unknown = config) => {
    writeFileSync(actual(MissionClientConfigPath), canonicalJson(value), { mode: 0o640 });
    // Provision this fixture's exact group-readable mode independently of the
    // rootless runner's restrictive umask. Production validation stays strict.
    chmodSync(actual(MissionClientConfigPath), 0o640);
  };
  write();
  let uid = 1001;
  let effectiveUid = 1001;
  let metadata = (_path: string, stats: BigIntStats): BigIntStats =>
    Object.assign(stats, { uid: 0n });
  let onRead = () => {};
  const descriptors = new Map<number, string>();
  const io: MissionLocalAuthorityTestIo = {
    identity: () => ({ uid, effectiveUid }),
    open(path, flags) {
      expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      const fd = openSync(actual(path), flags);
      descriptors.set(fd, path);
      return fd;
    },
    lstat: (path) => metadata(path, lstatSync(actual(path), { bigint: true })),
    stat: (fd) => metadata(descriptors.get(fd)!, fstatSync(fd, { bigint: true })),
    read(fd, bytes, offset, length, position) {
      // Exercise short reads over the actual bytes, not an injected parsed object.
      const count = readSync(fd, bytes, offset, Math.min(length, 113), position);
      onRead();
      return count;
    },
    close(fd) {
      closeSync(fd);
      descriptors.delete(fd);
    },
  };
  return {
    config,
    write,
    actual,
    io,
    descriptors,
    authority: MissionLocalAuthority.forTests(io),
    setIdentity(real: number, effective = real) {
      uid = real;
      effectiveUid = effective;
    },
    setMetadata(fn: typeof metadata) {
      metadata = fn;
    },
    onRead(fn: () => void) {
      onRead = fn;
    },
  };
}

describe("protected mission local operator authority", () => {
  test("HTTP credentials map only protected actors and policy rotation revokes issued sessions", async () => {
    const f = fixture();
    const credential = "A".repeat(43);
    f.config.http = { origin: "https://eigengrid.test", port: 8080, sessionSeconds: 3600 };
    f.config.operators.push({
      uid: 1002,
      actorId: "http-scientist",
      primaryRole: "scientist",
      roles: ["scientist"],
      httpCredentialDigest: createHash("sha256").update(credential).digest("hex"),
      httpProjectIds: ["project-a"],
    });
    f.write();
    const context = await f.authority.authenticateHttp(credential);
    expect(context.authenticatedActor.id).toBe("http-scientist");
    expect(context.httpProjectIds).toEqual(["project-a"]);
    await f.authority.assertCurrent(context);
    await expect(f.authority.authenticateHttp("B".repeat(43))).rejects.toThrow(
      "authentication failed",
    );
    f.config.operators.pop();
    f.write();
    await expect(
      f.authority.httpActor(context.authenticatedActor.id, context.configDigest),
    ).rejects.toThrow("revoked");
    await expect(f.authority.assertCurrent(context)).rejects.toThrow("changed");
  });
  test("reads actual bounded file bytes and maps only the kernel UID to immutable human authority", async () => {
    const f = fixture();
    const context = await f.authority.current();
    expect(context.authenticatedActor).toEqual({
      id: "scientist-one",
      kind: "human",
      role: "scientist",
    });
    expect(context.authorizedRoles).toEqual(["scientist", "scientific_reviewer"]);
    expect(context.databaseUrl).toBe(f.config.databaseUrl);
    expect(context.artifactRoot).toBe(f.config.artifactRoot);
    expect(Object.isFrozen(context.compilerPolicy.defaultRetryPolicy)).toBe(true);
    await f.authority.assertCurrent(context);
    expect(f.descriptors.size).toBe(0);
  });

  test("unmapped, root, invalid and elevated effective UIDs fail closed", async () => {
    const f = fixture();
    for (const [uid, effectiveUid] of [
      [1002, 1002],
      [0, 0],
      [-1, -1],
      [1001, 0],
      [1001, 1002],
    ]) {
      f.setIdentity(uid!, effectiveUid!);
      await expect(f.authority.current()).rejects.toThrow();
      expect(f.descriptors.size).toBe(0);
    }
  });

  test("identity changes during the protected read are rejected", async () => {
    const f = fixture();
    f.onRead(() => f.setIdentity(1002));
    await expect(f.authority.current()).rejects.toThrow("identity changed");
    expect(f.descriptors.size).toBe(0);
  });

  test("revocation, role/policy/database changes and subsequent UID changes invalidate issued contexts", async () => {
    for (const change of ["revoked", "role", "policy", "database", "uid"]) {
      const f = fixture();
      const context = await f.authority.current();
      if (change === "revoked") f.config.operators = [];
      if (change === "role") f.config.operators[0]!.roles = ["scientist"];
      if (change === "policy") {
        f.config.compilerPolicy.id = "policy-new";
        f.config.compilerPolicy.policyDigest = computeCompilerPolicyDigest(f.config.compilerPolicy);
      }
      if (change === "database")
        f.config.databaseUrl = f.config.databaseUrl.replace("eigengrid", "other");
      if (change === "uid") f.setIdentity(1002);
      f.write();
      await expect(f.authority.assertCurrent(context)).rejects.toThrow();
      expect(f.descriptors.size).toBe(0);
    }
  });

  test("forged and cross-instance contexts cannot be used as authenticated snapshots", async () => {
    const f = fixture();
    const context = await f.authority.current();
    await expect(f.authority.assertCurrent({ ...context })).rejects.toThrow("not issued");
    await expect(MissionLocalAuthority.forTests(f.io).assertCurrent(context)).rejects.toThrow(
      "not issued",
    );
  });

  test("every ancestor and configuration must be root owned without group or world writes", async () => {
    for (const target of ["/", "/etc", "/etc/eigengrid", MissionClientConfigPath]) {
      for (const unsafe of [{ uid: 1001n }, { mode: 0o40775n }, { mode: 0o40757n }]) {
        const f = fixture();
        f.setMetadata((path, stats) =>
          Object.assign(stats, { uid: 0n }, path === target ? unsafe : {}),
        );
        await expect(f.authority.current()).rejects.toThrow("protected root-owned");
        expect(f.descriptors.size).toBe(0);
      }
    }
  });

  test("credential-bearing configuration permits restricted group reads but rejects mode 0644", async () => {
    const f = fixture();
    expect(lstatSync(f.actual(MissionClientConfigPath)).mode & 0o777).toBe(0o640);
    const context = await f.authority.current();
    chmodSync(f.actual(MissionClientConfigPath), 0o644);
    await expect(f.authority.current()).rejects.toThrow("must not be world-readable");
    await expect(f.authority.assertCurrent(context)).rejects.toThrow("must not be world-readable");
    expect(f.descriptors.size).toBe(0);
  });

  test("actual symlinks at the file or directory are refused", async () => {
    for (const path of ["/etc/eigengrid", MissionClientConfigPath]) {
      const f = fixture();
      renameSync(f.actual(path), `${f.actual(path)}-target`);
      symlinkSync(`${f.actual(path)}-target`, f.actual(path));
      await expect(f.authority.current()).rejects.toThrow("protected root-owned");
      expect(f.descriptors.size).toBe(0);
    }
  });

  test("changed contents, permissions and path replacement during reads fail closed", async () => {
    for (const mutation of ["write", "mode", "replace"]) {
      const f = fixture();
      let changed = false;
      f.onRead(() => {
        if (changed) return;
        changed = true;
        if (mutation === "write") writeFileSync(f.actual(MissionClientConfigPath), "{}");
        if (mutation === "mode") chmodSync(f.actual(MissionClientConfigPath), 0o666);
        if (mutation === "replace") {
          renameSync(f.actual(MissionClientConfigPath), `${f.actual(MissionClientConfigPath)}-old`);
          f.write();
        }
      });
      await expect(f.authority.current()).rejects.toThrow();
      expect(f.descriptors.size).toBe(0);
    }
  });

  test("rejects oversized, empty, noncanonical, duplicate-key and invalid UTF-8 bytes", async () => {
    for (const bytes of [
      Buffer.alloc(256 * 1024 + 1, 32),
      Buffer.alloc(0),
      Buffer.from("{}\n"),
      Buffer.from('{"a":1,"a":2}'),
      Buffer.from([123, 34, 97, 34, 58, 34, 255, 34, 125]),
    ]) {
      const f = fixture();
      writeFileSync(f.actual(MissionClientConfigPath), bytes);
      await expect(f.authority.current()).rejects.toThrow();
      expect(f.descriptors.size).toBe(0);
    }
  });

  test("strict schema rejects duplicate identities, unauthorized primary role, unsupported DSNs and bad policy digests", () => {
    const { config } = fixture();
    for (const change of [
      { operators: [...config.operators, config.operators[0]] },
      { operators: [config.operators[0], { ...config.operators[0], uid: 1002 }] },
      { operators: [{ ...config.operators[0], primaryRole: "admin" }] },
      { operators: [{ ...config.operators[0], roles: ["scientist", "scientist"] }] },
      { databaseUrl: "file:///tmp/database" },
      { databaseUrl: "postgresql:///database" },
      { databaseUrl: "postgresql://localhost/database" },
      ...[
        "/",
        "relative",
        "/tmp/../artifacts",
        "/tmp/./artifacts",
        "/tmp//artifacts",
        "/tmp/artifacts\n",
      ].map((artifactRoot) => ({ artifactRoot })),
      { actor: { kind: "human", id: "injected" } },
      { compilerPolicy: { ...config.compilerPolicy, policyDigest: "f".repeat(64) } },
      { mdCompilerPolicy: {} },
    ])
      expect(MissionClientConfigSchema.safeParse({ ...config, ...change }).success).toBe(false);
  });

  test("nested unknown fields are rejected even where shared schemas normally strip them", async () => {
    const f = fixture();
    f.write({
      ...f.config,
      environment: {
        ...f.config.environment,
        selectedEngine: {
          ...f.config.environment.selectedEngine,
          injected: "authority",
        },
      },
    });
    await expect(f.authority.current()).rejects.toThrow("explicit schema fields");
  });

  test("MD policy and environment must be a complete pair with matching content digests", async () => {
    const f = fixture();
    const capability = { id: "amber.production", version: "1.0.0", contractDigest: "a".repeat(64) };
    const policy = {
      id: "md-policy",
      version: "1.0.0",
      minimumApprovalRole: "scientific_reviewer",
      capabilityByStageKind: {
        minimization: capability,
        heating: capability,
        equilibration: capability,
        production: capability,
      },
      riskByStageKind: {
        minimization: 3 as const,
        heating: 3 as const,
        equilibration: 4 as const,
        production: 4 as const,
      },
      retryPolicy: { maximumAttempts: 1, ambiguityRequiresReconciliation: true as const },
    };
    f.config.mdCompilerPolicy = { ...policy, policyDigest: computeMdCompilerPolicyDigest(policy) };
    expect(MissionClientConfigSchema.safeParse(f.config).success).toBe(false);
    const environment = {
      schemaVersion: MdEnvironmentCapabilitySnapshotSchemaVersion,
      id: "md-environment",
      engine: {
        engine: "amber",
        executable: "pmemd",
        version: "24",
        buildDigest: "b".repeat(64),
        environmentDigest: "c".repeat(64),
        compatibilityVersion: "1.0.0",
      },
      capabilities: [capability],
      targetCompatibility: {
        family: "amber" as const,
        versionRange: ">=24",
        compatible: true as const,
        evaluatorVersion: "1.0.0",
        evidenceDigest: "d".repeat(64),
      },
      observedAt: "2026-09-25T00:00:00.000Z",
    };
    f.config.mdEnvironment = {
      ...environment,
      environmentDigest: computeMdEnvironmentCapabilitySnapshotDigest(environment),
    };
    f.write();
    const context = await f.authority.current();
    expect(context.mdCompilerPolicy).toEqual(f.config.mdCompilerPolicy);
    expect(context.mdEnvironment).toEqual(f.config.mdEnvironment);
    f.config.mdEnvironment.engine.version = "25";
    f.write();
    await expect(f.authority.current()).rejects.toThrow("MD environment digest mismatch");
    f.config.mdEnvironment.environmentDigest = computeMdEnvironmentCapabilitySnapshotDigest(
      f.config.mdEnvironment,
    );
    f.config.mdCompilerPolicy.minimumApprovalRole = "other-role";
    f.write();
    await expect(f.authority.current()).rejects.toThrow("MD compiler policy digest mismatch");
  });
});
