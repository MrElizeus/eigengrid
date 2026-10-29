import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { DurableNodeHeartbeatJournal, HeartbeatFence } from "@eigengrid/protocol";
import { classifyWorkerLiveness, WorkerHeartbeatReporter } from "./heartbeat";

const capabilityDigest = `sha256:${"a".repeat(64)}` as const;

describe("worker heartbeat reporting", () => {
  test("persists before transport, emits monotonic sequences, and drains explicitly", async () => {
    const root = await mkdtemp(join(tmpdir(), "eigengrid-worker-heartbeat-"));
    const journal = new DurableNodeHeartbeatJournal(join(root, "heartbeats.jsonl"));
    const observed: string[] = [];
    let now = new Date("2026-08-30T12:00:00.000Z");
    const reporter = new WorkerHeartbeatReporter({
      nodeId: "worker-1",
      instanceId: "instance-1",
      fence: "0001",
      capabilityDigest,
      intervalMilliseconds: 60_000,
      expiresAfterMilliseconds: 30_000,
      now: () => now,
      journal,
      sink: (heartbeat) => {
        observed.push(heartbeat.heartbeatDigest);
      },
    });
    const first = await reporter.start();
    now = new Date("2026-08-30T12:00:01.000Z");
    const second = await reporter.emit();
    const draining = await reporter.stop();
    expect([first.sequence, second.sequence, draining!.sequence]).toEqual([0, 1, 2]);
    expect(observed).toHaveLength(3);
    expect((await journal.list()).map((heartbeat) => heartbeat.sequence)).toEqual([0, 1, 2]);
    const fence = new HeartbeatFence(await journal.list());
    expect(fence.accept(first).accepted).toBe(false);
  });

  test("classifies missing, stale, unreachable, and operator states without inferring health from registration", () => {
    const now = "2026-08-30T12:00:00.000Z";
    const base = {
      nodeId: "worker-1",
      now,
      staleAfterMilliseconds: 10_000,
      unreachableAfterMilliseconds: 30_000,
      announcedStatus: "healthy" as const,
    };
    expect(classifyWorkerLiveness({ ...base, lastSeenAt: null })).toBe("unreachable");
    expect(classifyWorkerLiveness({ ...base, lastSeenAt: "2026-08-30T11:59:49.000Z" })).toBe(
      "stale",
    );
    expect(classifyWorkerLiveness({ ...base, lastSeenAt: "2026-08-30T11:59:20.000Z" })).toBe(
      "unreachable",
    );
    expect(classifyWorkerLiveness({ ...base, lastSeenAt: "2026-08-30T11:59:59.000Z" })).toBe(
      "healthy",
    );
    expect(
      classifyWorkerLiveness({
        ...base,
        lastSeenAt: "2026-08-30T11:59:59.000Z",
        announcedStatus: "draining",
      }),
    ).toBe("draining");
    expect(() =>
      classifyWorkerLiveness({ ...base, lastSeenAt: null, unreachableAfterMilliseconds: 10_000 }),
    ).toThrow(/greater/);
  });
});
