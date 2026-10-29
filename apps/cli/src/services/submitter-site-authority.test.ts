import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { SubmitterCapabilitySchema } from "@eigengrid/slurm";
import {
  assertSubmitterCurrentPolicy,
  assertSubmitterProcessRestrictions,
  SubmitterServiceConfigSchema,
  SubmitterSitePolicySchema,
} from "./submitter-site-authority";

const user = userInfo();
const config = SubmitterServiceConfigSchema.parse({
  schemaVersion: "eigengrid.submitter-service/v1",
  configPath: "/etc/eigengrid/service.json",
  uid: user.uid,
  gid: user.gid,
  headUid: 2900,
  appArmorProfile: "eigengrid-submitter-2101",
  socketPath: "/run/eigengrid/socket",
  journalPath: "/var/lib/eigengrid/uid/journal",
  journalId: "journal-1",
  launchAuthorityPath: "/var/lib/eigengrid/uid/launch",
  launchAuthorityDevice: "1",
  launchAuthorityInode: "23",
  launchAuthoritySha256: "a".repeat(64),
  backendExecutable: "/opt/apps/eigengrid/backend",
  backendSha256: "b".repeat(64),
  siteProfilePath: "/etc/eigengrid/profile.json",
  policyPath: "/etc/eigengrid/policy.json",
});
const policy = SubmitterSitePolicySchema.parse({
  schemaVersion: "eigengrid.submitter-site-policy/v1",
  uid: user.uid,
  gid: user.gid,
  headUid: 2900,
  recoveryEpoch: "epoch-1",
  siteProfileDigest: "c".repeat(64),
  currentPolicyDigest: "d".repeat(64),
  publicKeyHex: "e".repeat(64),
  memberships: [{ subject: "eliseo", projectId: "m2-amber", generation: 1 }],
});
const capability = SubmitterCapabilitySchema.parse({
  version: "eigengrid.submitter-capability/v1",
  action: "submit",
  requestId: "rpc-1",
  subject: "eliseo",
  projectId: "m2-amber",
  uid: user.uid,
  gid: user.gid,
  recoveryEpoch: "epoch-1",
  membershipGeneration: 1,
  siteProfileDigest: policy.siteProfileDigest,
  operationId: "op-1",
  requestDigest: "a".repeat(64),
  admissionDigest: "b".repeat(64),
  bindingDigest: "d".repeat(64),
  bodyDigest: "e".repeat(64),
  fencingGeneration: 1,
  notBeforeMs: 1000,
  expiresAtMs: 2000,
});

describe("root submitter launch/policy authority", () => {
  test("actual Ubuntu procfs padding is accepted, never nonzero core/capabilities or missing NoNewPrivs", () => {
    const status = "CapEff:\t0000000000000000\nNoNewPrivs:\t1\n";
    // Exact public line observed in confined UID2101 in the isolated fixture.
    const limits =
      "Max core file size        0                    0                    bytes     \n";
    for (const scope of ["1\n", "2\n", "3\n"])
      expect(() => assertSubmitterProcessRestrictions(status, limits, scope)).not.toThrow();
    for (const scope of ["0\n", "", "1", "4\n", "1\n0\n", "01\n", " 1\n"])
      expect(() => assertSubmitterProcessRestrictions(status, limits, scope)).toThrow();
    for (const invalid of [
      limits.replace(/ 0 /u, " 1 "),
      limits.replace("bytes", "blocks"),
      limits.replace(" 0 ", " unlimited "),
      "",
      limits.replace("bytes", "bytesX"),
    ])
      expect(() => assertSubmitterProcessRestrictions(status, invalid, "1\n")).toThrow();
    for (const invalid of [
      status.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0"),
      status.replace("0000000000000000", "0000000000000001"),
      "",
    ])
      expect(() => assertSubmitterProcessRestrictions(invalid, limits, "1\n")).toThrow();
  });

  test("fresh authority closes on epoch, membership, identity, profile or expiry changes", () => {
    expect(() => assertSubmitterCurrentPolicy(capability, policy, 1500)).not.toThrow();
    for (const change of [
      { recoveryEpoch: "epoch-2" },
      { uid: user.uid + 1 },
      { gid: user.gid + 1 },
      { siteProfileDigest: "f".repeat(64) },
      { memberships: [] },
      { memberships: [{ subject: "eliseo", projectId: "m2-amber", generation: 2 }] },
    ]) {
      expect(() =>
        assertSubmitterCurrentPolicy(capability, { ...policy, ...change }, 1500),
      ).toThrow("current site authority");
    }
    for (const now of [999, 2000, NaN, Infinity])
      expect(() => assertSubmitterCurrentPolicy(capability, policy, now)).toThrow();
  });
  test("configuration is closed, paths canonical and identities/descriptors separated", () => {
    for (const change of [
      { uid: 0 },
      { headUid: config.uid },
      { extra: "shell" },
      { journalPath: config.launchAuthorityPath },
      { backendExecutable: "/tmp/../bin" },
      { appArmorProfile: "unconfined" },
      { launchAuthorityInode: "01" },
    ]) {
      expect(SubmitterServiceConfigSchema.safeParse({ ...config, ...change }).success).toBe(false);
    }
    expect(
      SubmitterSitePolicySchema.safeParse({
        ...policy,
        memberships: [policy.memberships[0], policy.memberships[0]],
      }).success,
    ).toBe(false);
  });
  test("a copied/user-owned launch marker is rejected and the descriptor consumed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "eigengrid-marker-negative-"));
    try {
      const path = join(directory, "marker");
      writeFileSync(path, "copied-marker", { mode: 0o600 });
      // Production is a fresh process with LimitNOFILE=512. The aggregate Bun
      // test process can already have >1024 database/runtime descriptors open;
      // exercise the real FD guard in a fresh child, do not relax that guard.
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
        import { openSync, fstatSync } from "node:fs";
        import { consumeSubmitterLaunchAuthority } from ${JSON.stringify(new URL("./submitter-site-authority.ts", import.meta.url).pathname)};
        const fd = openSync(${JSON.stringify(path)}, "r");
        let rejected = "", closed = false;
        try { consumeSubmitterLaunchAuthority(${JSON.stringify(config)}, fd); }
        catch (error) { rejected = error.message; }
        try { fstatSync(fd); } catch { closed = true; }
        process.stdout.write(JSON.stringify({ rejected, closed }));
      `,
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(JSON.parse(output)).toEqual({
        rejected: "No protected root launch authority was inherited",
        closed: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
