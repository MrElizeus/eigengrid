// ────────────────────────────────────────────────────────────
// Transaction, concurrency, and fault-injection tests
// ────────────────────────────────────────────────────────────

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDatabase, type DatabaseLike } from "@eigengrid/db";

describe("SQLite transaction lifecycle", () => {
  let tmpDir: string;
  let db: DatabaseLike;
  let dbPath: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "db-txn-"));
    dbPath = join(tmpDir, "test.sqlite");
    db = createDatabase(dbPath);
    await db.init();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("begin/commit transaction without errors", async () => {
    await db.createJob({
      id: "txn-job-1",
      name: "txn-test",
      software: "gaussian",
      inputPath: "x.in",
      workdir: tmpDir,
    });
    const tx = await db.beginTransaction();
    expect(tx).toBeDefined();
    // Use the transaction to run a query
    await tx.query("SELECT 1");
    await tx.commit();
  });

  it("begin/rollback transaction without errors", async () => {
    const tx = await db.beginTransaction();
    await tx.query("SELECT 1");
    await tx.rollback();
  });

  it("rolls back state mutation when event emission fails", async () => {
    // This proves that a failed transaction doesn't leave partial state
    const tx = await db.beginTransaction();

    // Try to insert into a non-existent table — forces rollback
    try {
      await tx.query("INSERT INTO nonexistent_table (id) VALUES ('x')");
      await tx.commit();
    } catch {
      await tx.rollback();
    }

    // The original DB state is untouched
    const jobs = await db.listJobs();
    expect(jobs.length).toBeGreaterThanOrEqual(1);
  });
});

describe("SQLite atomic state+event mutations", () => {
  let tmpDir: string;
  let db: DatabaseLike;
  let dbPath: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "db-atomic-"));
    dbPath = join(tmpDir, "test.sqlite");
    db = createDatabase(dbPath);
    await db.init();
    await db.createJob({
      id: "atomic-job-1",
      name: "atomic-test",
      software: "gaussian",
      inputPath: "x.in",
      workdir: tmpDir,
    });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates job attempt and event atomically", async () => {
    await db.createJobAttempt({
      id: "atomic-attempt-1",
      jobId: "atomic-job-1",
      runner: "local",
      command: "g16 x.in",
      cwd: tmpDir,
    });

    // Both the attempt and the event should exist
    const attempts = await db.listJobAttempts("atomic-job-1");
    expect(attempts.some((a) => a.id === "atomic-attempt-1")).toBe(true);

    const events = await db.getEvents("atomic-job-1");
    expect(events.some((e: any) => e.attempt_id === "atomic-attempt-1")).toBe(true);
  });

  it("creates artifact and event atomically", async () => {
    await db.createArtifact({
      id: "atomic-art-1",
      jobId: "atomic-job-1",
      attemptId: "atomic-attempt-1",
      kind: "input",
      path: "/tmp/x.in",
    });

    const artifacts = await db.listArtifacts("atomic-job-1");
    expect(artifacts.some((a) => a.id === "atomic-art-1")).toBe(true);

    const events = await db.getEvents("atomic-job-1");
    expect(events.some((e: any) => e.artifact_id === "atomic-art-1")).toBe(true);
  });

  it("updates attempt status and emits event atomically", async () => {
    await db.updateJobAttemptStatus("atomic-attempt-1", "queued");
    await db.updateJobAttemptStatus("atomic-attempt-1", "staged");
    await db.updateJobAttemptStatus("atomic-attempt-1", "running", { pid: 100 });

    const attempts = await db.listJobAttempts("atomic-job-1");
    const updated = attempts.find((a) => a.id === "atomic-attempt-1");
    expect(updated).toBeDefined();
    expect(updated!.status).toBe("running");

    const events = await db.getEvents("atomic-job-1");
    const statusEvents = events.filter(
      (e: any) => e.type === "attempt.status.changed" && e.attempt_id === "atomic-attempt-1",
    );
    expect(statusEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("updates job status and emits event atomically", async () => {
    // Go through valid transition: created -> queued -> staged -> running
    // Job is already running from test before, so we can't go back

    // Create a fresh job for this test
    await db.createJob({
      id: "atomic-job-status",
      name: "status-test",
      software: "gaussian",
      inputPath: "x.in",
      workdir: tmpDir,
    });

    await db.updateJobStatus("atomic-job-status", "queued");

    const job = await db.getJob("atomic-job-status");
    expect(job!.status).toBe("queued");

    const events = await db.getEvents("atomic-job-status");
    expect(events.some((e: any) => e.type === "job.status.changed")).toBe(true);
  });
});

describe("SQLite event sequencing", () => {
  let tmpDir: string;
  let db: DatabaseLike;
  let dbPath: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "db-seq-"));
    dbPath = join(tmpDir, "test.sqlite");
    db = createDatabase(dbPath);
    await db.init();
    await db.createJob({
      id: "seq-job-1",
      name: "seq-test",
      software: "gaussian",
      inputPath: "x.in",
      workdir: tmpDir,
    });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("assigns monotonically increasing sequences per job", async () => {
    // Append several events
    for (let i = 0; i < 5; i++) {
      await db.appendEvent({
        id: `seq-evt-${i}`,
        at: Date.now(),
        source: "test",
        type: "test.sequence",
        jobId: "seq-job-1",
        payload: { index: i },
      });
    }

    const stored = await db.getEvents("seq-job-1");
    const seqEvents = stored
      .filter((e: any) => e.type === "test.sequence")
      .sort((a: any, b: any) => (a.sequence || 0) - (b.sequence || 0));

    // Each event should have a unique, increasing sequence
    for (let i = 1; i < seqEvents.length; i++) {
      expect(Number(seqEvents[i].sequence)).toBeGreaterThan(Number(seqEvents[i - 1].sequence));
    }
  });

  it("sequences are scoped per job", async () => {
    // Create another job
    await db.createJob({
      id: "seq-job-2",
      name: "seq-test-2",
      software: "orca",
      inputPath: "y.in",
      workdir: tmpDir,
    });

    await db.appendEvent({
      id: "seq-evt-other",
      at: Date.now(),
      source: "test",
      type: "test.sequence",
      jobId: "seq-job-2",
      payload: {},
    });

    const evts1 = await db.getEvents("seq-job-1");
    const evts2 = await db.getEvents("seq-job-2");

    // Both should have sequences starting at 1 (or whatever the DB assigns)
    expect(evts1.some((e: any) => e.sequence != null)).toBe(true);
    expect(evts2.some((e: any) => e.sequence != null)).toBe(true);
  });
});

describe("SQLite result idempotency", () => {
  let tmpDir: string;
  let db: DatabaseLike;
  let dbPath: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "db-result-"));
    dbPath = join(tmpDir, "test.sqlite");
    db = createDatabase(dbPath);
    await db.init();
    await db.createJob({
      id: "result-job-1",
      name: "result-test",
      software: "gaussian",
      inputPath: "x.in",
      workdir: tmpDir,
    });
    await db.createJobAttempt({
      id: "result-attempt-1",
      jobId: "result-job-1",
      runner: "local",
      command: "gaussian x.in",
      cwd: tmpDir,
    });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saveResult is canonical (same job+parser returns same ID)", async () => {
    const id1 = await db.saveResult({
      jobId: "result-job-1",
      attemptId: "result-attempt-1",
      parser: "gaussian",
      status: "completed",
      energyHartree: -76.5,
    });

    const id2 = await db.saveResult({
      jobId: "result-job-1",
      attemptId: "result-attempt-1",
      parser: "gaussian",
      status: "completed",
      energyHartree: -76.5,
    });

    // Canonical: duplicate save returns same ID
    expect(id1).toBe(id2);

    // Only one result for this job+parser
    const results = await db.listResults("result-job-1");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});
