// ────────────────────────────────────────────────────────────
// Concurrency and event sequence tests
// ────────────────────────────────────────────────────────────
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDatabase, type DatabaseLike } from "@eigengrid/db";

describe("SQLite event sequence concurrency", () => {
  let tmpDir: string;
  let db: DatabaseLike;
  let dbPath: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "db-conc-"));
    dbPath = join(tmpDir, "test.sqlite");
    db = createDatabase(dbPath);
    await db.init();
    await db.createJob({
      id: "conc-job-1",
      name: "conc-test",
      software: "gaussian",
      inputPath: "x.in",
      workdir: tmpDir,
    });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("events from sequential calls have increasing sequences", async () => {
    for (let i = 0; i < 10; i++) {
      await db.appendEvent({
        id: `conc-seq-${i}`,
        at: Date.now(),
        source: "test",
        type: "concurrency.sequence",
        jobId: "conc-job-1",
        payload: { index: i },
      });
    }

    const events = await db.getEvents("conc-job-1");
    const seqEvents = events
      .filter((e: any) => e.type === "concurrency.sequence")
      .sort((a: any, b: any) => Number(a.sequence) - Number(b.sequence));

    expect(seqEvents.length).toBe(10);
    for (let i = 0; i < seqEvents.length; i++) {
      expect(Number(seqEvents[i].sequence)).toBeGreaterThan(0);
      if (i > 0) {
        expect(Number(seqEvents[i].sequence)).toBeGreaterThan(Number(seqEvents[i - 1].sequence));
      }
    }
  });

  it("events from different jobs have independent sequences", async () => {
    await db.createJob({
      id: "conc-job-2",
      name: "conc-test-2",
      software: "orca",
      inputPath: "y.in",
      workdir: tmpDir,
    });

    await db.appendEvent({
      id: "conc-indep-1",
      at: Date.now(),
      source: "test",
      type: "concurrency.independent",
      jobId: "conc-job-2",
      payload: {},
    });

    const evt1 = await db.getEvents("conc-job-1");
    const evt2 = await db.getEvents("conc-job-2");

    // Both should have non-null sequences
    expect(evt1.some((e: any) => e.sequence != null)).toBe(true);
    expect(evt2.some((e: any) => e.sequence != null)).toBe(true);
  });

  it("events emitted via state mutations have sequences", async () => {
    await db.createJob({
      id: "conc-job-3",
      name: "conc-mutation",
      software: "gaussian",
      inputPath: "x.in",
      workdir: tmpDir,
    });

    await db.createJobAttempt({
      id: "conc-att-1",
      jobId: "conc-job-3",
      runner: "local",
      command: "echo test",
      cwd: tmpDir,
    });

    await db.updateJobAttemptStatus("conc-att-1", "queued");
    await db.updateJobAttemptStatus("conc-att-1", "staged");
    await db.updateJobAttemptStatus("conc-att-1", "running", { pid: 42 });

    const events = await db.getEvents("conc-job-3");
    // The events emitted by createJobAttempt and updateJobAttemptStatus
    // should have sequence values
    const attemptCreated = events.filter((e: any) => e.type === "attempt.created");
    const statusChanged = events.filter((e: any) => e.type === "attempt.status.changed");

    for (const evt of [...attemptCreated, ...statusChanged]) {
      expect(Number(evt.sequence)).toBeGreaterThan(0);
    }
  });

  it("separate connections see consistent sequences (SQLite WAL)", async () => {
    // SQLite with WAL mode supports concurrent readers + one writer.
    // Open a second connection to the same database
    const db2 = createDatabase(dbPath);
    await db2.init();

    try {
      // Write events from connection 1
      for (let i = 0; i < 3; i++) {
        await db.appendEvent({
          id: `conn1-evt-${i}`,
          at: Date.now(),
          source: "conn1",
          type: "concurrency.multi-conn",
          jobId: "conc-job-1",
          payload: { conn: 1, i },
        });
      }

      // Read from connection 2
      const evtsFrom2 = await db2.getEvents("conc-job-1");
      const filtered = evtsFrom2.filter((e: any) => e.type === "concurrency.multi-conn");
      expect(filtered.length).toBe(3);

      // Verify sequences are monotonic
      const seqs = filtered.map((e: any) => Number(e.sequence)).sort((a, b) => a - b);
      expect(seqs[0]).toBeGreaterThan(0);
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
      }

      // Now write from connection 2
      for (let i = 0; i < 2; i++) {
        await db2.appendEvent({
          id: `conn2-evt-${i}`,
          at: Date.now(),
          source: "conn2",
          type: "concurrency.multi-conn",
          jobId: "conc-job-1",
          payload: { conn: 2, i },
        });
      }

      // Read from connection 1 — should see all 5 events
      const allEvts = await db.getEvents("conc-job-1");
      const allFiltered = allEvts.filter((e: any) => e.type === "concurrency.multi-conn");
      expect(allFiltered.length).toBe(5);

      // All sequences should be unique
      const allSeqs = allFiltered.map((e: any) => Number(e.sequence));
      const uniqueSeqs = new Set(allSeqs);
      expect(uniqueSeqs.size).toBe(allSeqs.length);
    } finally {
      await db2.close();
    }
  });

  it("result save is canonical per job+parser", async () => {
    await db.createJob({
      id: "conc-result-1",
      name: "conc-result",
      software: "gaussian",
      inputPath: "x.in",
      workdir: tmpDir,
    });
    await db.createJobAttempt({
      id: "conc-result-attempt-1",
      jobId: "conc-result-1",
      runner: "local",
      command: "gaussian x.in",
      cwd: tmpDir,
    });

    const id1 = await db.saveResult({
      jobId: "conc-result-1",
      attemptId: "conc-result-attempt-1",
      parser: "gaussian",
      status: "completed",
      energyHartree: -76.5,
    });

    const id2 = await db.saveResult({
      jobId: "conc-result-1",
      attemptId: "conc-result-attempt-1",
      parser: "gaussian",
      status: "completed",
      energyHartree: -76.5,
    });

    // Canonical: same job+parser = same ID
    expect(id1).toBe(id2);

    // Different parser = different ID
    const id3 = await db.saveResult({
      jobId: "conc-result-1",
      attemptId: "conc-result-attempt-1",
      parser: "orca",
      status: "completed",
      energyHartree: -152.0,
    });

    expect(id3).not.toBe(id1);
  });
});
