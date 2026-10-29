import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNodeCapabilityManifest, DurableNodeHeartbeatJournal } from "@eigengrid/protocol";
import { recordNodeHeartbeat } from "../../apps/cli/src/services/node-service";

function fakeDb() {
  const updates: Array<{ id: string; updates: Record<string, unknown> }> = [];
  return {
    updates,
    async getNode(id: string) {
      return { id, name: id, host: "worker", user: "eg", runner: "worker-daemon" };
    },
    async updateNode(id: string, update: Record<string, unknown>) {
      updates.push({ id, updates: update });
    },
  } as any;
}

describe("node heartbeat application boundary", () => {
  test("updates scheduler projection only after a fenced heartbeat", async () => {
    const db = fakeDb();
    const root = mkdtempSync(join(tmpdir(), "eigengrid-node-heartbeat-service-"));
    try {
      const journal = new DurableNodeHeartbeatJournal(join(root, "heartbeats.ndjson"));
      const capability = createNodeCapabilityManifest({
        nodeId: "worker-01",
        identity: { host: "worker" },
        role: "worker",
        os: { name: "Ubuntu", version: "24.04" },
        architecture: "x86_64",
        cpu: { threads: 4 },
        ramBytes: 1024,
        storage: [],
        network: { egress: false },
        gpus: [],
        runtimes: { bun: "1.3.14" },
        scheduler: null,
        scientificEngines: [],
        resourceLimits: {},
        isolation: { mode: "dedicated-user" },
        lastAudit: "2026-08-30T10:00:00.000Z",
        provenance: { source: "measurement" },
      });
      const first = await recordNodeHeartbeat(
        db,
        {
          nodeId: "worker-01",
          instanceId: "i-a",
          fence: "0001",
          sequence: 1,
          status: "healthy",
          capabilityDigest: capability.manifestDigest,
          sentAt: new Date("2026-08-30T10:00:00.000Z"),
          expiresAt: new Date("2026-08-30T10:01:00.000Z"),
        },
        journal,
      );
      expect(first).toMatchObject({ accepted: true, nodeStatus: "online" });
      const stale = await recordNodeHeartbeat(
        db,
        {
          nodeId: "worker-01",
          instanceId: "i-a",
          fence: "0001",
          sequence: 0,
          status: "healthy",
          capabilityDigest: capability.manifestDigest,
          sentAt: new Date("2026-08-30T10:00:01.000Z"),
          expiresAt: new Date("2026-08-30T10:01:00.000Z"),
        },
        journal,
      );
      expect(stale).toMatchObject({ accepted: false, reason: "stale-sequence" });
      expect(db.updates).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
