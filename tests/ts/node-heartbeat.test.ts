import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  HeartbeatFence,
  DurableNodeHeartbeatJournal,
  classifyHeartbeat,
  createNodeHeartbeat,
  verifyNodeHeartbeat,
} from "@eigengrid/protocol";

const base = {
  nodeId: "worker-01",
  instanceId: "instance-a",
  fence: "0001",
  sequence: 1,
  status: "healthy" as const,
  capabilityDigest: `sha256:${"a".repeat(64)}`,
  sentAt: "2026-08-30T10:00:00.000Z",
  expiresAt: "2026-08-30T10:01:00.000Z",
};

describe("node heartbeat v1", () => {
  test("is self-addressed and rejects tampering", () => {
    const heartbeat = createNodeHeartbeat(base);
    expect(verifyNodeHeartbeat(heartbeat)).toMatchObject({ ok: true });
    expect(verifyNodeHeartbeat({ ...heartbeat, status: "degraded" })).toMatchObject({ ok: false });
    expect(classifyHeartbeat(heartbeat, new Date("2026-08-30T10:02:00.000Z"))).toBe("stale");
  });

  test("fences stale workers and accepts only monotonic sequence/fence", () => {
    const first = createNodeHeartbeat(base);
    const fence = new HeartbeatFence();
    expect(fence.accept(first)).toMatchObject({ accepted: true, reason: "new-instance" });
    expect(fence.accept(first)).toMatchObject({ accepted: true, reason: "duplicate" });
    expect(fence.accept(createNodeHeartbeat({ ...base, sequence: 0 }))).toMatchObject({
      accepted: false,
      reason: "stale-sequence",
    });
    expect(
      fence.accept(createNodeHeartbeat({ ...base, instanceId: "old", fence: "0000", sequence: 9 })),
    ).toMatchObject({ accepted: false, reason: "stale-fence" });
    expect(
      fence.accept(
        createNodeHeartbeat({ ...base, instanceId: "instance-b", fence: "0002", sequence: 1 }),
      ),
    ).toMatchObject({ accepted: true, reason: "new-instance" });
  });

  test("rebuilds accepted heartbeat state from durable journal", async () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-heartbeat-"));
    const path = join(root, "heartbeat.ndjson");
    try {
      const journal = new DurableNodeHeartbeatJournal(path);
      await journal.append(createNodeHeartbeat(base));
      await journal.append(createNodeHeartbeat({ ...base, sequence: 2 }));
      const restored = new DurableNodeHeartbeatJournal(path);
      const rows = await restored.list();
      expect(rows).toHaveLength(2);
      expect(rows.at(-1)?.sequence).toBe(2);
      await expect(restored.append(createNodeHeartbeat({ ...base, sequence: 1 }))).rejects.toThrow(
        "stale",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed on a malformed durable heartbeat record", async () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-heartbeat-corrupt-"));
    const path = join(root, "heartbeat.ndjson");
    try {
      appendFileSync(path, '{"schema":"eigengrid.node-heartbeat.v1"}\n');
      await expect(new DurableNodeHeartbeatJournal(path).list()).rejects.toThrow(
        "invalid heartbeat",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps a corrupt heartbeat journal failed after the first recovery attempt", async () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-heartbeat-sticky-"));
    const path = join(root, "heartbeat.ndjson");
    try {
      appendFileSync(path, "not-json\n");
      const journal = new DurableNodeHeartbeatJournal(path);
      await expect(journal.list()).rejects.toThrow("invalid heartbeat JSON");
      await expect(journal.append(createNodeHeartbeat(base))).rejects.toThrow(
        "invalid heartbeat JSON",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not append an already durable duplicate heartbeat", async () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-heartbeat-duplicate-"));
    const path = join(root, "heartbeat.ndjson");
    try {
      const journal = new DurableNodeHeartbeatJournal(path);
      const heartbeat = createNodeHeartbeat(base);
      await journal.append(heartbeat);
      await journal.append(heartbeat);
      expect((await journal.list()).map((row) => row.sequence)).toEqual([1]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
