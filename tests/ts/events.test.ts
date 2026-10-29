import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDatabase } from "@eigengrid/db";
import type { EigenGridEventBase } from "@eigengrid/events";
import { generateId } from "@eigengrid/core";

function createWorkspace(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "eigengrid-events-"));
  return { root, dbPath: join(root, ".eigengrid", "eigengrid.sqlite") };
}

async function createTestDb(): Promise<{
  db: ReturnType<typeof createDatabase>;
  root: string;
  cleanup: () => void;
}> {
  const { root, dbPath } = createWorkspace();
  const db = createDatabase(dbPath);
  await db.init();
  return { db, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("Event log", () => {
  it("appendEvent stores normalized payload", async () => {
    const { db, cleanup } = await createTestDb();
    try {
      const { appendEvent, listEvents } = await import("@eigengrid/db");

      await db.createJob({
        id: "job-test-1",
        name: "test.in",
        software: "orca",
        inputPath: "test.in",
        workdir: "/tmp",
      });

      const event: EigenGridEventBase = {
        id: generateId("evt"),
        type: "job.status.changed",
        at: Date.now(),
        source: "cli",
        jobId: "job-test-1",
        payload: { from: "created", to: "queued" },
      };

      await appendEvent(db, event);

      const events = await listEvents(db, { jobId: "job-test-1" });
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(String(events[0].type)).toBe("job.status.changed");
      expect(String(events[0].source)).toBe("cli");
      expect(String(events[0].event_id)).toBe(event.id);
    } finally {
      cleanup();
    }
  });

  it("listJobEvents returns sequence order (deterministic replay)", async () => {
    const { db, cleanup } = await createTestDb();
    try {
      const { appendEvent, listJobEvents } = await import("@eigengrid/db");

      await db.createJob({
        id: "job-test-2",
        name: "test.in",
        software: "orca",
        inputPath: "test.in",
        workdir: "/tmp",
      });

      const lateEvent: EigenGridEventBase = {
        id: generateId("evt"),
        type: "job.status.changed",
        at: Date.now() + 100,
        source: "cli",
        jobId: "job-test-2",
        payload: { from: "created", to: "queued" },
      };
      const earlyEvent: EigenGridEventBase = {
        id: generateId("evt"),
        type: "job.created",
        at: Date.now(),
        source: "cli",
        jobId: "job-test-2",
      };

      // Insert out of order
      await appendEvent(db, lateEvent, { at: lateEvent.at });
      await appendEvent(db, earlyEvent, { at: earlyEvent.at });

      const events = await listJobEvents(db, "job-test-2");
      expect(events.length).toBe(2);
      // Events are ordered by sequence ASC (insertion order), so the first
      // inserted event (lateEvent) comes first regardless of created_at
      expect(String(events[0].type)).toBe("job.status.changed");
      expect(String(events[1].type)).toBe("job.created");
      expect(Number(events[0].sequence)).toBeLessThan(Number(events[1].sequence));
    } finally {
      cleanup();
    }
  });

  it("getTimeline returns compact rows", async () => {
    const { db, cleanup } = await createTestDb();
    try {
      const { appendEvent, getTimeline } = await import("@eigengrid/db");

      await db.createJob({
        id: "job-test-3",
        name: "test.in",
        software: "orca",
        inputPath: "test.in",
        workdir: "/tmp",
      });

      await appendEvent(db, {
        id: generateId("evt"),
        type: "job.created",
        at: Date.now(),
        source: "cli",
        jobId: "job-test-3",
      });
      await appendEvent(db, {
        id: generateId("evt"),
        type: "job.status.changed",
        at: Date.now() + 10,
        source: "db",
        jobId: "job-test-3",
        payload: { from: "created", to: "queued" },
      });

      const timeline = await getTimeline(db, "job-test-3");
      expect(timeline.length).toBe(2);
      expect(timeline[0].type).toBe("job.created");
      expect(timeline[1].type).toBe("job.status.changed");
      expect(timeline[1].details).toContain("created");
      expect(timeline[1].details).toContain("queued");
    } finally {
      cleanup();
    }
  });

  it("job.status.changed emitted by updateJobStatus", async () => {
    const { db, cleanup } = await createTestDb();
    try {
      const { listJobEvents } = await import("@eigengrid/db");

      await db.createJob({
        id: "job-test-4",
        name: "test.in",
        software: "orca",
        inputPath: "test.in",
        workdir: "/tmp",
      });
      await db.updateJobStatus("job-test-4", "queued");

      const events = await listJobEvents(db, "job-test-4");
      const statusEvents = events.filter((e) => String(e.type) === "job.status.changed");
      expect(statusEvents.length).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });

  it("attempt.created emitted by createJobAttempt", async () => {
    const { db, cleanup } = await createTestDb();
    try {
      const { listJobEvents } = await import("@eigengrid/db");

      await db.createJob({
        id: "job-test-5",
        name: "test.in",
        software: "orca",
        inputPath: "test.in",
        workdir: "/tmp",
      });
      await db.createJobAttempt({
        id: "attempt-test-1",
        jobId: "job-test-5",
        runner: "local",
        command: "orca test.inp",
        cwd: "/tmp",
      });

      const events = await listJobEvents(db, "job-test-5");
      const attemptEvents = events.filter((e) => String(e.type) === "attempt.created");
      expect(attemptEvents.length).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });

  it("artifact.registered emitted by createArtifact", async () => {
    const { db, cleanup } = await createTestDb();
    try {
      const { listJobEvents } = await import("@eigengrid/db");

      await db.createJob({
        id: "job-test-6",
        name: "test.in",
        software: "orca",
        inputPath: "test.in",
        workdir: "/tmp",
      });
      await db.createJobAttempt({
        id: "attempt-test-2",
        jobId: "job-test-6",
        runner: "local",
        command: "orca test.inp",
        cwd: "/tmp",
      });
      await db.createArtifact({
        id: "artifact-test-1",
        jobId: "job-test-6",
        attemptId: "attempt-test-2",
        kind: "output",
        path: "/tmp/test.out",
      });

      const events = await listJobEvents(db, "job-test-6");
      const artifactEvents = events.filter((e) => String(e.type) === "artifact.registered");
      expect(artifactEvents.length).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });

  it("saveResult persists and getLatestResult retrieves", async () => {
    const { db, cleanup } = await createTestDb();
    try {
      const { saveResult, getLatestResult } = await import("@eigengrid/db");

      await db.createJob({
        id: "job-test-7",
        name: "test.in",
        software: "orca",
        inputPath: "test.in",
        workdir: "/tmp",
      });
      await db.createJobAttempt({
        id: "attempt-test-7",
        jobId: "job-test-7",
        runner: "local",
        command: "orca test.in",
        cwd: "/tmp",
      });

      const resultId1 = await saveResult(db, {
        jobId: "job-test-7",
        attemptId: "attempt-test-7",
        parser: "orca",
        status: "completed",
        energyHartree: -74.9,
        scfConverged: true,
        normalTermination: true,
        warnings: [],
        errors: [],
      });

      expect(resultId1).toBeTruthy();
      expect(typeof resultId1).toBe("string");

      const initial = await getLatestResult(db, "job-test-7", "attempt-test-7");
      expect(initial).not.toBeNull();

      // Exact replay is an idempotent no-op.
      const resultId2 = await saveResult(db, {
        jobId: "job-test-7",
        attemptId: "attempt-test-7",
        parser: "orca",
        status: "completed",
        energyHartree: -74.9,
        scfConverged: true,
        normalTermination: true,
        warnings: [],
        errors: [],
      });
      expect(resultId2).toBe(resultId1);

      // Divergent replay must not rewrite immutable scientific evidence.
      await expect(
        saveResult(db, {
          jobId: "job-test-7",
          attemptId: "attempt-test-7",
          parser: "orca",
          status: "completed",
          energyHartree: -75.0,
          scfConverged: true,
          normalTermination: true,
          warnings: [],
          errors: [],
        }),
      ).rejects.toThrow("Conflicting immutable result evidence");

      const latest = await getLatestResult(db, "job-test-7", "attempt-test-7");
      expect(latest).not.toBeNull();
      expect(latest!.energyHartree).toBe(-74.9);
      expect(latest!.createdAt).toBe(initial!.createdAt);

      // listResults should return one canonical result per job+attempt+parser.
      const { listResults } = await import("@eigengrid/db");
      const allResults = await listResults(db, "job-test-7");
      expect(allResults.length).toBe(1);
    } finally {
      cleanup();
    }
  });
});
