import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  createNodeCapabilityManifest,
  createNodeManifestAttestation,
  verifyNodeManifestAttestation,
} from "@eigengrid/protocol";

function manifest() {
  return createNodeCapabilityManifest({
    nodeId: "worker-attested",
    identity: { hostname: "worker-attested" },
    role: "worker",
    os: { distribution: "Ubuntu", release: "24.04" },
    architecture: "x86_64",
    cpu: { cores: 4 },
    ramBytes: 8 * 1024 ** 3,
    storage: [],
    network: { egress: "deny" },
    gpus: [],
    runtimes: { python: "3.13" },
    scheduler: null,
    scientificEngines: [],
    resourceLimits: { maxJobs: 1 },
    isolation: { cgroup: true },
    lastAudit: "2026-08-30T06:00:00.000Z",
    provenance: { measuredBy: "node-audit/v1" },
  });
}

describe("signed node capability attestation", () => {
  test("authenticates the measured manifest and rejects tampering/staleness", () => {
    const keys = generateKeyPairSync("ed25519");
    const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const value = manifest();
    const attestation = createNodeManifestAttestation({
      manifest: value,
      signerKeyId: "site-key-1",
      evidenceClass: "site_attested",
      observedAt: "2026-08-30T06:00:00.000Z",
      privateKeyPem,
    });
    expect(
      verifyNodeManifestAttestation(
        attestation,
        value,
        { "site-key-1": publicKeyPem },
        {
          now: new Date("2026-08-30T06:04:00.000Z"),
          maxAgeMs: 5 * 60_000,
        },
      ).ok,
    ).toBe(true);
    expect(
      verifyNodeManifestAttestation(
        { ...attestation, manifestDigest: `sha256:${"0".repeat(64)}` },
        value,
        { "site-key-1": publicKeyPem },
      ).ok,
    ).toBe(false);
    expect(
      verifyNodeManifestAttestation(
        attestation,
        value,
        { "site-key-1": publicKeyPem },
        {
          now: new Date("2026-08-30T07:00:00.000Z"),
          maxAgeMs: 5 * 60_000,
        },
      ).ok,
    ).toBe(false);
  });
});
