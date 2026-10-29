import { describe, expect, test } from "bun:test";
import {
  NodeManifestSchemaVersion,
  auditNodeManifest,
  createNodeCapabilityManifest,
  verifyNodeCapabilityManifest,
} from "@eigengrid/protocol";

function manifest() {
  return createNodeCapabilityManifest({
    nodeId: "worker-01",
    identity: { hostname: "worker-01", hostKeyDigest: "sha256:host" },
    role: "worker",
    os: { distribution: "Ubuntu", version: "24.04" },
    architecture: "x86_64",
    cpu: { model: "test", cores: 4 },
    ramBytes: 8 * 1024 ** 3,
    storage: [{ mount: "/scratch", bytes: 1000 }],
    network: { egress: "deny-by-default" },
    gpus: [],
    runtimes: { python: "3.13" },
    scheduler: null,
    scientificEngines: [{ id: "amber", version: "unknown", validation: "unqualified" }],
    resourceLimits: { maxJobs: 1 },
    isolation: { unixIdentity: true, cgroup: true },
    lastAudit: new Date().toISOString(),
    provenance: { measuredBy: "node-audit/v1", measurementVersion: "1.0.0" },
  });
}

describe("NodeCapabilityManifest/v1", () => {
  test("is measured, digest-bound, and tamper evident", () => {
    const value = manifest();
    expect(value.schema).toBe(NodeManifestSchemaVersion);
    expect(verifyNodeCapabilityManifest(value)).toEqual({ ok: true, manifest: value });
    expect(verifyNodeCapabilityManifest({ ...value, architecture: "aarch64" }).ok).toBe(false);
  });

  test("audit is read-only and emits typed remediation", () => {
    const value = manifest();
    const report = auditNodeManifest(value, { isolation: { unixIdentity: false } });
    expect(report.mutating).toBe(false);
    expect(report.risk).toBe("high");
    expect(report.remediation[0]).toEqual({ path: "isolation", action: "review" });
  });
});
