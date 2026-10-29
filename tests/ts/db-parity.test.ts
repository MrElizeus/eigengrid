import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDatabase, type DatabaseLike } from "@eigengrid/db";

describe("DatabaseLike interface parity", () => {
  let tmpDir: string;
  let db: DatabaseLike;
  let dbPath: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "db-parity-"));
    dbPath = join(tmpDir, "test.sqlite");
    db = createDatabase(dbPath);
    await db.init();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Job lifecycle ────────────────────────────────────────

  it("implements full job lifecycle", async () => {
    await db.createJob({
      id: "job-lifecycle-1",
      name: "test-job",
      software: "gaussian",
      inputPath: "input.in",
      workdir: tmpDir,
    });

    const job = await db.getJob("job-lifecycle-1");
    expect(job).not.toBeNull();
    expect(job!.name).toBe("test-job");
    expect(job!.status).toBe("created");

    await db.updateJobStatus("job-lifecycle-1", "queued");
    const updated = await db.getJob("job-lifecycle-1");
    expect(updated!.status).toBe("queued");

    const jobs = await db.listJobs();
    expect(jobs.length).toBeGreaterThanOrEqual(1);
  });

  // ── Attempt lifecycle ────────────────────────────────────

  it("implements full attempt lifecycle", async () => {
    await db.createJob({
      id: "job-attempt-1",
      name: "attempt-test",
      software: "orca",
      inputPath: "test.inp",
      workdir: tmpDir,
    });

    await db.createJobAttempt({
      id: "attempt-1",
      jobId: "job-attempt-1",
      runner: "local",
      command: "orca test.inp",
      cwd: tmpDir,
    });

    await db.updateJobAttemptStatus("attempt-1", "queued");
    await db.updateJobAttemptStatus("attempt-1", "staged");
    await db.updateJobAttemptStatus("attempt-1", "running", { pid: 999 });
    await db.updateJobAttemptStatus("attempt-1", "completed", { exitCode: 0 });

    const attempts = await db.listJobAttempts("job-attempt-1");
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("completed");
    expect(attempts[0].pid).toBe(999);
    expect(attempts[0].exitCode).toBe(0);
  });

  // ── Artifact CRUD ────────────────────────────────────────

  it("implements artifact CRUD", async () => {
    await db.createArtifact({
      id: "art-1",
      jobId: "job-lifecycle-1",
      attemptId: "attempt-1",
      kind: "input",
      path: "/tmp/input.in",
      label: "test input",
    });

    const artifacts = await db.listArtifacts("job-lifecycle-1");
    expect(artifacts.length).toBeGreaterThanOrEqual(1);
    expect(artifacts.find((a) => a.id === "art-1")?.label).toBe("test input");
  });

  // ── Log operations ──────────────────────────────────────

  it("implements log operations", async () => {
    // Insert a log entry via the event system
    const logs = await db.getLogs("job-lifecycle-1");
    expect(Array.isArray(logs)).toBe(true);
  });

  // ── Event operations ─────────────────────────────────────

  it("implements event append and retrieval", async () => {
    await db.appendEvent({
      id: "evt-1",
      at: Date.now(),
      source: "test",
      type: "system.notice",
      jobId: "job-lifecycle-1",
      payload: { message: "test event" },
    });

    const events = await db.getEvents("job-lifecycle-1");
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  // ── Result operations ────────────────────────────────────

  it("implements result save and retrieval", async () => {
    await db.createJobAttempt({
      id: "result-attempt-lifecycle-1",
      jobId: "job-lifecycle-1",
      runner: "local",
      command: "gaussian input.in",
      cwd: tmpDir,
    });
    const resultId = await db.saveResult({
      jobId: "job-lifecycle-1",
      attemptId: "result-attempt-lifecycle-1",
      parser: "gaussian",
      status: "completed",
      energyHartree: -76.5,
      scfConverged: true,
    });

    expect(resultId).toBeTruthy();
    expect(typeof resultId).toBe("string");

    const results = await db.listResults("job-lifecycle-1");
    expect(results.length).toBeGreaterThanOrEqual(1);

    const latest = await db.getLatestResult("job-lifecycle-1", "result-attempt-lifecycle-1");
    expect(latest).not.toBeNull();
  });

  // ── Proposal operations ──────────────────────────────────

  it("implements proposal CRUD", async () => {
    const propId = await db.createProposal({
      jobId: "job-lifecycle-1",
      action: "retry",
      reason: "test proposal",
      proposedChanges: '{"command": "retry"}',
    });

    expect(propId).toBeTruthy();

    const prop = await db.getProposal(propId);
    expect(prop).not.toBeNull();
    expect(prop!.status).toBe("pending");

    await db.updateProposalStatus(propId, "approved");
    const approved = await db.getProposal(propId);
    expect(approved!.status).toBe("approved");

    const proposals = await db.listProposals({ jobId: "job-lifecycle-1" });
    expect(proposals.length).toBeGreaterThanOrEqual(1);
  });

  // ── Node operations ─────────────────────────────────────

  it("implements node CRUD", async () => {
    await db.createNode({
      id: "node-1",
      name: "test-node",
      host: "localhost",
      user: "test",
      runner: "local",
    });

    const node = await db.getNode("node-1");
    expect(node).not.toBeNull();
    expect(node!.name).toBe("test-node");

    const nodeByName = await db.getNodeByName("test-node");
    expect(nodeByName).not.toBeNull();

    const nodes = await db.listNodes();
    expect(nodes.length).toBeGreaterThanOrEqual(1);
  });

  // ── Permission operations ───────────────────────────────

  it("implements permission CRUD", async () => {
    await db.createPermission({
      id: "perm-1",
      action: "read",
      resource: "jobs/*",
      effect: "allow",
    });

    const perms = await db.listPermissions();
    expect(perms.length).toBeGreaterThanOrEqual(1);
    expect(perms.find((p) => p.id === "perm-1")?.effect).toBe("allow");

    await db.removePermission("perm-1");
    const permsAfter = await db.listPermissions();
    expect(permsAfter.find((p) => p.id === "perm-1")).toBeUndefined();
  });

  // ── Timeline ─────────────────────────────────────────────

  it("implements timeline retrieval", async () => {
    const timeline = await db.getTimeline("job-lifecycle-1");
    expect(Array.isArray(timeline)).toBe(true);
  });
});
