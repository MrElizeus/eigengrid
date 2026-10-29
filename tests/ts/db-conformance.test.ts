// ────────────────────────────────────────────────────────────
// Shared adapter conformance suite
// Runs against both SQLite and (optionally) PostgreSQL
// ────────────────────────────────────────────────────────────

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDatabase, type DatabaseLike } from "@eigengrid/db";

export function createSqliteDb(): { db: DatabaseLike; path: string; cleanup: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), "db-conformance-"));
  const dbPath = join(tmpDir, "test.sqlite");
  const db = createDatabase(dbPath);
  return {
    db,
    path: dbPath,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

/**
 * Run a conformance suite against a DatabaseLike instance.
 */
export function runConformanceSuite(
  label: string,
  factory: () => Promise<{ db: DatabaseLike; cleanup: () => void | Promise<void> }>,
): void {
  describe(`Conformance: ${label}`, () => {
    let db: DatabaseLike;
    let cleanup: () => void | Promise<void>;

    beforeAll(async () => {
      const ctx = await factory();
      db = ctx.db;
      cleanup = ctx.cleanup;
      await db.init();
    });

    afterAll(async () => {
      await db.close();
      await cleanup();
    });

    // ── Lifecycle ──────────────────────────────────────────

    it("init and close lifecycle works", async () => {
      // Already initialized in beforeAll
      await expect(db.getMigrationVersion()).resolves.toBeGreaterThanOrEqual(0);
    });

    it("beginTransaction is available", async () => {
      const tx = await db.beginTransaction();
      expect(tx).toBeDefined();
      expect(typeof tx.commit).toBe("function");
      expect(typeof tx.rollback).toBe("function");
      await tx.rollback();
    });

    // ── Jobs ────────────────────────────────────────────────

    it("creates and retrieves a job", async () => {
      await db.createJob({
        id: "conform-job-1",
        name: "conformance-job",
        software: "gaussian",
        inputPath: "input.in",
        workdir: "/tmp",
      });

      const job = await db.getJob("conform-job-1");
      expect(job).not.toBeNull();
      expect(job!.name).toBe("conformance-job");
      expect(job!.status).toBe("created");
    });

    it("updates job status", async () => {
      await db.createJob({
        id: "conform-job-status",
        name: "status-test",
        software: "orca",
        inputPath: "test.inp",
        workdir: "/tmp",
      });

      await db.updateJobStatus("conform-job-status", "queued");
      const job = await db.getJob("conform-job-status");
      expect(job!.status).toBe("queued");

      // Status state machine: created -> queued -> staged -> running
      await db.updateJobStatus("conform-job-status", "staged");
      expect((await db.getJob("conform-job-status"))!.status).toBe("staged");

      await db.updateJobStatus("conform-job-status", "running");
      expect((await db.getJob("conform-job-status"))!.status).toBe("running");
    });

    it("rejects invalid status transitions", async () => {
      await db.createJob({
        id: "conform-job-bad-trans",
        name: "bad-trans",
        software: "gaussian",
        inputPath: "x.in",
        workdir: "/tmp",
      });

      // Cannot go from created to completed directly
      await expect(
        db.updateJobStatus("conform-job-bad-trans", "completed" as any),
      ).rejects.toThrow();
    });

    it("resolves job ID by prefix", async () => {
      const id = await db.resolveJobId("conform-job-1");
      expect(id).toBe("conform-job-1");
    });

    it("lists jobs", async () => {
      const jobs = await db.listJobs();
      expect(jobs.length).toBeGreaterThanOrEqual(3);
    });

    // ── Attempts ────────────────────────────────────────────

    it("creates and retrieves job attempts", async () => {
      await db.createJobAttempt({
        id: "conform-attempt-1",
        jobId: "conform-job-1",
        runner: "local",
        command: "g16 input.in",
        cwd: "/tmp",
      });

      const attempts = await db.listJobAttempts("conform-job-1");
      expect(attempts.length).toBeGreaterThanOrEqual(1);
      expect(attempts[0].status).toBe("created");
    });

    it("updates attempt status", async () => {
      await db.updateJobAttemptStatus("conform-attempt-1", "queued");
      await db.updateJobAttemptStatus("conform-attempt-1", "staged");
      await db.updateJobAttemptStatus("conform-attempt-1", "running", { pid: 42 });
      await db.updateJobAttemptStatus("conform-attempt-1", "completed", { exitCode: 0 });

      const attempts = await db.listJobAttempts("conform-job-1");
      const updated = attempts.find((a) => a.id === "conform-attempt-1");
      expect(updated).toBeDefined();
      expect(updated!.status).toBe("completed");
      expect(updated!.pid).toBe(42);
      expect(updated!.exitCode).toBe(0);
    });

    // ── Artifacts ───────────────────────────────────────────

    it("creates and lists artifacts", async () => {
      await db.createArtifact({
        id: "conform-art-1",
        jobId: "conform-job-1",
        attemptId: "conform-attempt-1",
        kind: "input",
        path: "/tmp/input.in",
        label: "test input",
      });

      const artifacts = await db.listArtifacts("conform-job-1");
      expect(artifacts.length).toBeGreaterThanOrEqual(1);
      const art = artifacts.find((a) => a.id === "conform-art-1");
      expect(art).toBeDefined();
      expect(art!.label).toBe("test input");
    });

    it("createArtifactIfAbsent is atomic by semantic artifact identity", async () => {
      expect(db.createArtifactIfAbsent).toBeFunction();
      const tag = `artifact-once-${Date.now()}`;
      const artifact = {
        id: `${tag}-a`,
        jobId: "conform-job-1",
        attemptId: "conform-attempt-1",
        kind: "output" as const,
        path: `/tmp/${tag}.out`,
      };

      const created = await Promise.all([
        db.createArtifactIfAbsent!({ ...artifact }),
        db.createArtifactIfAbsent!({ ...artifact, id: `${tag}-b` }),
      ]);
      expect(created.filter(Boolean)).toHaveLength(1);

      const artifacts = await db.listArtifacts("conform-job-1");
      expect(
        artifacts.filter(
          (entry) =>
            entry.attemptId === artifact.attemptId &&
            entry.kind === artifact.kind &&
            entry.path === artifact.path,
        ),
      ).toHaveLength(1);
      const events = await db.listJobEvents("conform-job-1");
      expect(
        events.filter(
          (event) =>
            event.type === "artifact.registered" &&
            event.attemptId === artifact.attemptId &&
            JSON.parse(event.payloadJson ?? "null")?.path === artifact.path,
        ),
      ).toHaveLength(1);
    });

    // ── Events ──────────────────────────────────────────────

    it("appends and retrieves events", async () => {
      await db.appendEvent({
        id: "conform-evt-1",
        at: Date.now(),
        source: "conformance-test",
        type: "test.event",
        jobId: "conform-job-1",
        payload: { message: "conformance test event" },
      });

      const events = await db.getEvents("conform-job-1");
      const found = events.find((e: any) => e.event_id === "conform-evt-1");
      expect(found).toBeDefined();
    });

    // ── Results ─────────────────────────────────────────────

    it("saves and retrieves results", async () => {
      const resultId = await db.saveResult({
        jobId: "conform-job-1",
        attemptId: "conform-attempt-1",
        parser: "gaussian",
        status: "completed",
        energyHartree: -76.5,
        scfConverged: true,
      });

      expect(resultId).toBeTruthy();
      expect(typeof resultId).toBe("string");

      const results = await db.listResults("conform-job-1");
      expect(results.length).toBeGreaterThanOrEqual(1);

      const latest = await db.getLatestResult("conform-job-1", "conform-attempt-1");
      expect(latest).not.toBeNull();
      expect(latest?.attemptId).toBe("conform-attempt-1");
    });

    // ── Proposals ───────────────────────────────────────────

    it("creates and manages proposals", async () => {
      const propId = await db.createProposal({
        jobId: "conform-job-1",
        action: "retry",
        reason: "conformance test",
        proposedChanges: '{"retry": true}',
      });

      expect(propId).toBeTruthy();

      const prop = await db.getProposal(propId);
      expect(prop).not.toBeNull();
      expect(prop!.status).toBe("pending");

      await db.updateProposalStatus(propId, "approved");
      const approved = await db.getProposal(propId);
      expect(approved!.status).toBe("approved");
    });

    // ── Permissions ─────────────────────────────────────────

    it("creates and removes permissions", async () => {
      await db.createPermission({
        id: "conform-perm-1",
        action: "read",
        resource: "jobs/*",
        effect: "allow",
      });

      const perms = await db.listPermissions();
      expect(perms.length).toBeGreaterThanOrEqual(1);
      expect(perms.find((p) => p.id === "conform-perm-1")?.effect).toBe("allow");

      await db.removePermission("conform-perm-1");
      const after = await db.listPermissions();
      expect(after.find((p) => p.id === "conform-perm-1")).toBeUndefined();
    });

    // ── Users and Projects ─────────────────────

    it("creates users", async () => {
      await db.createUser({
        id: "conform-user-1",
        username: "conform-test-user",
        displayName: "Conformance Test User",
      });
      const user = await db.getUser("conform-user-1");
      expect(user).not.toBeNull();
      expect(user!.username).toBe("conform-test-user");
    });

    it("creates projects", async () => {
      await db.createProject({
        id: "conform-proj-1",
        name: "conformance-project",
        description: "Test project for conformance",
      });
      const proj = await db.getProject("conform-proj-1");
      expect(proj).not.toBeNull();
      expect(proj!.name).toBe("conformance-project");
    });

    // ── Nodes ──────────────────────────────────────────────

    it("creates and retrieves nodes", async () => {
      await db.createNode({
        id: "conform-node-1",
        name: "conformance-node",
        host: "localhost",
        user: "test",
        runner: "local",
      });

      const node = await db.getNode("conform-node-1");
      expect(node).not.toBeNull();
      expect(node!.name).toBe("conformance-node");
    });

    it("updates the provider-neutral node fields", async () => {
      if (!db.updateNode) {
        throw new Error("Database adapter does not implement updateNode");
      }

      await db.updateNode("conform-node-1", {
        status: "online",
        tags: ["head", "gpu"],
        maxJobs: 4,
        engines: ["gaussian", "orca"],
        cpuThreadsTotal: 16,
        memoryMbTotal: 32768,
        scratchMbTotal: 500000,
        draining: true,
        thermalState: "nominal",
        lastSeenAt: 1700000000000,
        isHead: true,
        powerMode: "wake-on-lan",
        macAddress: "AA:BB:CC:DD:EE:FF",
        broadcastAddress: "192.168.1.255",
        wolPort: 9,
        allowWake: true,
        allowPowerDown: true,
        idlePowerDownAfterSec: 900,
        remoteScratchDir: "/var/tmp/eigengrid",
      });

      const updated = await db.getNode("conform-node-1");
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("online");
      expect(JSON.parse(updated!.tagsJson)).toEqual(["head", "gpu"]);
      expect(updated!.maxJobs).toBe(4);
      expect(JSON.parse(updated!.engines)).toEqual(["gaussian", "orca"]);
      expect(updated!.cpuThreadsTotal).toBe(16);
      expect(updated!.memoryMbTotal).toBe(32768);
      expect(updated!.scratchMbTotal).toBe(500000);
      expect(updated!.draining).toBe(true);
      expect(updated!.isHead).toBe(true);
      expect(updated!.powerMode).toBe("wake-on-lan");
      expect(updated!.macAddress).toBe("AA:BB:CC:DD:EE:FF");
      expect(updated!.wolPort).toBe(9);
      expect(updated!.remoteScratchDir).toBe("/var/tmp/eigengrid");

      await db.updateNode("conform-node-1", {
        macAddress: null,
        broadcastAddress: null,
        lastSeenAt: null,
        idlePowerDownAfterSec: null,
      });
      const cleared = await db.getNode("conform-node-1");
      expect(cleared!.macAddress).toBeNull();
      expect(cleared!.broadcastAddress).toBeNull();
      expect(cleared!.lastSeenAt).toBeNull();
      expect(cleared!.idlePowerDownAfterSec).toBeNull();
    });

    // ── Timeline ────────────────────────────────────────────

    it("returns a timeline", async () => {
      const timeline = await db.getTimeline("conform-job-1");
      expect(Array.isArray(timeline)).toBe(true);
    });

    // ── Idempotency ─────────────────────────────────────────

    it("init is idempotent", async () => {
      await expect(db.init()).resolves.toBeUndefined();
    });

    // ── Error handling ──────────────────────────────────────

    it("throws on missing job", async () => {
      await expect(db.resolveJobId("nonexistent-job-xyz")).rejects.toThrow();
    });

    it("returns null for non-existent getters", async () => {
      await expect(db.getNode("nonexistent-node-xyz")).resolves.toBeNull();
      await expect(db.getUser("nonexistent-user")).resolves.toBeNull();
      await expect(db.getProject("nonexistent-project")).resolves.toBeNull();
    });

    // ── Transaction lifecycle ─────────────────────────────────

    it("transaction commit succeeds", async () => {
      const tx = await db.beginTransaction();
      await tx.query("SELECT 1");
      await tx.commit();
    });

    it("transaction rollback succeeds", async () => {
      const tx = await db.beginTransaction();
      await tx.query("SELECT 1");
      await tx.rollback();
    });

    // ── Idempotency ─────────────────────────────────────────

    it("result save is canonical under concurrent writes per job+attempt+parser", async () => {
      const input = {
        jobId: "conform-job-1",
        attemptId: "conform-attempt-1",
        parser: "canonical-test",
        status: "completed" as const,
        energyHartree: -76.5,
      };
      const [id1, id2] = await Promise.all([db.saveResult(input), db.saveResult(input)]);

      // Canonical identity: duplicate save returns same ID
      expect(id1).toBe(id2);
      const results = await db.listResults("conform-job-1");
      const matching = results.filter(
        (result) => result.attemptId === "conform-attempt-1" && result.parser === "canonical-test",
      );
      expect(matching).toHaveLength(1);
      const createdAt = matching[0]!.createdAt;

      expect(await db.saveResult(input)).toBe(id1);
      expect((await db.getLatestResult("conform-job-1", "conform-attempt-1"))?.createdAt).toBe(
        createdAt,
      );

      await expect(db.saveResult({ ...input, energyHartree: -75 })).rejects.toThrow(
        "Conflicting immutable result evidence",
      );
      const unchanged = await db.getLatestResult("conform-job-1", "conform-attempt-1");
      expect(unchanged?.energyHartree).toBe(-76.5);
      expect(unchanged?.createdAt).toBe(createdAt);

      const divergentRace = await Promise.allSettled([
        db.saveResult({ ...input, parser: "canonical-divergent-race", energyHartree: -1 }),
        db.saveResult({ ...input, parser: "canonical-divergent-race", energyHartree: -2 }),
      ]);
      expect(divergentRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(divergentRace.filter((result) => result.status === "rejected")).toHaveLength(1);
      const raceRows = (await db.listResults("conform-job-1", "conform-attempt-1")).filter(
        (result) => result.parser === "canonical-divergent-race",
      );
      expect(raceRows).toHaveLength(1);
      expect([-1, -2]).toContain(raceRows[0]!.energyHartree);
    });

    it("never falls back to a result from a different attempt", async () => {
      const tag = `result-attempt-binding-${Date.now()}`;
      const jobId = `${tag}-job`;
      const firstAttemptId = `${tag}-attempt-1`;
      const secondAttemptId = `${tag}-attempt-2`;
      await db.createJob({
        id: jobId,
        name: tag,
        software: "orca",
        inputPath: "/tmp/test.inp",
        workdir: "/tmp",
      });
      for (const attemptId of [firstAttemptId, secondAttemptId]) {
        await db.createJobAttempt({
          id: attemptId,
          jobId,
          runner: "local",
          command: "orca /tmp/test.inp",
          cwd: "/tmp",
        });
      }

      const firstResultId = await db.saveResult({
        jobId,
        attemptId: firstAttemptId,
        parser: "orca",
        status: "completed",
        energyHartree: -1,
      });
      expect(await db.getLatestResult(jobId, secondAttemptId)).toBeNull();
      expect(await db.listResults(jobId, secondAttemptId)).toHaveLength(0);

      const secondResultId = await db.saveResult({
        jobId,
        attemptId: secondAttemptId,
        parser: "orca",
        status: "completed",
        energyHartree: -2,
      });
      expect(secondResultId).not.toBe(firstResultId);
      expect((await db.getLatestResult(jobId, firstAttemptId))?.energyHartree).toBe(-1);
      expect((await db.getLatestResult(jobId, secondAttemptId))?.energyHartree).toBe(-2);

      await expect(
        db.saveResult({
          jobId: "conform-job-1",
          attemptId: secondAttemptId,
          parser: "orca",
          status: "completed",
        }),
      ).rejects.toThrow("not owned");
    });
    // ── Event ordering ───────────────────────────────────────

    it("events have monotonically increasing sequences per job", async () => {
      for (let i = 0; i < 3; i++) {
        await db.appendEvent({
          id: `cseq-evt-${i}`,
          at: Date.now(),
          source: "conformance",
          type: "conformance.sequence",
          jobId: "conform-job-1",
          payload: { index: i },
        });
      }

      const stored = await db.getEvents("conform-job-1");
      const seqEvents = stored
        .filter((e: any) => e.type === "conformance.sequence")
        .sort((a: any, b: any) => (a.sequence || 0) - (b.sequence || 0));

      if (seqEvents.length >= 2) {
        for (let i = 1; i < seqEvents.length; i++) {
          expect(Number(seqEvents[i].sequence)).toBeGreaterThan(Number(seqEvents[i - 1].sequence));
        }
      }
    });

    it("materializes terminal state and evidence exactly once", async () => {
      expect(db.materializeTerminalAttempt).toBeFunction();
      const tag = `terminal-once-${Date.now()}`;
      const jobId = `${tag}-job`;
      const attemptId = `${tag}-attempt`;
      await db.createJob({
        id: jobId,
        name: tag,
        software: "orca",
        inputPath: "/tmp/test.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobId, "queued");
      await db.updateJobStatus(jobId, "staged");
      await db.updateJobStatus(jobId, "running");
      await db.createJobAttempt({
        id: attemptId,
        jobId,
        runner: "local",
        command: "orca /tmp/test.inp",
        cwd: "/tmp",
        status: "running",
        pid: 42,
        startedAt: 100,
      });
      const evidence = {
        jobId,
        attemptId,
        status: "completed" as const,
        exitCode: 0,
        finishedAt: 200,
        source: "runner" as const,
        payload: { pid: 42, exitCode: 0, durationMs: 100 },
      };

      await Promise.all([
        db.materializeTerminalAttempt!(evidence),
        db.materializeTerminalAttempt!(evidence),
      ]);

      expect((await db.getJob(jobId))?.status).toBe("completed");
      const attempt = (await db.listJobAttempts(jobId)).find((entry) => entry.id === attemptId);
      expect(attempt?.status).toBe("completed");
      expect(attempt?.exitCode).toBe(0);
      expect(attempt?.finishedAt).toBe(200);
      const terminalUpdatedAt = attempt!.updatedAt;

      await db.materializeTerminalAttempt!(evidence);
      expect(
        (await db.listJobAttempts(jobId)).find((entry) => entry.id === attemptId)?.updatedAt,
      ).toBe(terminalUpdatedAt);

      const events = await db.listJobEvents(jobId);
      expect(
        events.filter(
          (event) => event.type === "process.completed" && event.attemptId === attemptId,
        ),
      ).toHaveLength(1);
      expect(
        events.filter(
          (event) => event.type === "attempt.status.changed" && event.attemptId === attemptId,
        ),
      ).toHaveLength(1);
      expect(events.filter((event) => event.type === "job.status.changed")).toHaveLength(4);
      const sequences = events.map((event) => event.sequence);
      expect(sequences.every((sequence) => sequence != null)).toBe(true);
      expect(new Set(sequences).size).toBe(sequences.length);

      await expect(
        db.materializeTerminalAttempt!({
          ...evidence,
          exitCode: 9,
          finishedAt: 201,
        }),
      ).rejects.toThrow("Conflicting terminal metadata");
      const unchanged = (await db.listJobAttempts(jobId)).find((entry) => entry.id === attemptId);
      expect(unchanged?.exitCode).toBe(0);
      expect(unchanged?.finishedAt).toBe(200);
      expect(unchanged?.updatedAt).toBe(terminalUpdatedAt);
    });

    it("materializes cancellation state and process.cancelled atomically exactly once", async () => {
      const tag = `cancel-materialization-${Date.now()}`;
      const jobId = `${tag}-job`;
      const attemptId = `${tag}-attempt`;
      await db.createJob({
        id: jobId,
        name: tag,
        software: "orca",
        inputPath: "/tmp/test.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobId, "queued");
      await db.updateJobStatus(jobId, "staged");
      await db.updateJobStatus(jobId, "running");
      await db.createJobAttempt({
        id: attemptId,
        jobId,
        runner: "local",
        command: "orca /tmp/test.inp",
        cwd: "/tmp",
        status: "running",
        pid: 42,
        startedAt: 100,
      });
      const evidence = {
        jobId,
        attemptId,
        status: "cancelled" as const,
        finishedAt: 200,
        source: "runner" as const,
        payload: { pid: 42, signal: "SIGTERM" },
      };

      await Promise.all([
        db.materializeTerminalAttempt!(evidence),
        db.materializeTerminalAttempt!(evidence),
      ]);

      expect((await db.getJob(jobId))?.status).toBe("cancelled");
      const attempt = (await db.listJobAttempts(jobId)).find((entry) => entry.id === attemptId);
      expect(attempt?.status).toBe("cancelled");
      expect(attempt?.finishedAt).toBe(200);
      const terminalUpdatedAt = attempt!.updatedAt;
      const events = await db.listJobEvents(jobId);
      expect(
        events.filter(
          (event) => event.type === "process.cancelled" && event.attemptId === attemptId,
        ),
      ).toHaveLength(1);

      await db.materializeTerminalAttempt!(evidence);
      expect(
        (await db.listJobAttempts(jobId)).find((entry) => entry.id === attemptId)?.updatedAt,
      ).toBe(terminalUpdatedAt);
      await expect(
        db.materializeTerminalAttempt!({ ...evidence, finishedAt: 201 }),
      ).rejects.toThrow("Conflicting terminal metadata");
      expect(
        (await db.listJobEvents(jobId)).filter(
          (event) => event.type === "process.cancelled" && event.attemptId === attemptId,
        ),
      ).toHaveLength(1);
    });

    it("serializes job status writers against terminal materialization", async () => {
      const tag = `terminal-job-race-${Date.now()}`;
      const jobId = `${tag}-job`;
      const attemptId = `${tag}-attempt`;
      await db.createJob({
        id: jobId,
        name: tag,
        software: "orca",
        inputPath: "/tmp/test.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobId, "queued");
      await db.updateJobStatus(jobId, "staged");
      await db.updateJobStatus(jobId, "running");
      await db.createJobAttempt({
        id: attemptId,
        jobId,
        runner: "local",
        command: "orca /tmp/test.inp",
        cwd: "/tmp",
        status: "running",
      });

      const results = await Promise.allSettled([
        db.updateJobStatus(jobId, "cancelled"),
        db.materializeTerminalAttempt!({
          jobId,
          attemptId,
          status: "failed",
          exitCode: 1,
          finishedAt: 200,
          source: "runner",
          payload: { exitCode: 1 },
        }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

      const job = await db.getJob(jobId);
      const attempt = (await db.listJobAttempts(jobId)).find((entry) => entry.id === attemptId);
      const terminalEvents = (await db.listJobEvents(jobId)).filter(
        (event) => event.type === "process.failed" && event.attemptId === attemptId,
      );
      if (job?.status === "failed") {
        expect(attempt?.status).toBe("failed");
        expect(terminalEvents).toHaveLength(1);
      } else {
        expect(job?.status).toBe("cancelled");
        expect(attempt?.status).toBe("running");
        expect(terminalEvents).toHaveLength(0);
      }
    });

    it("serializes attempt status writers against terminal materialization", async () => {
      const tag = `terminal-attempt-race-${Date.now()}`;
      const jobId = `${tag}-job`;
      const attemptId = `${tag}-attempt`;
      await db.createJob({
        id: jobId,
        name: tag,
        software: "orca",
        inputPath: "/tmp/test.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobId, "queued");
      await db.updateJobStatus(jobId, "staged");
      await db.updateJobStatus(jobId, "running");
      await db.createJobAttempt({
        id: attemptId,
        jobId,
        runner: "local",
        command: "orca /tmp/test.inp",
        cwd: "/tmp",
        status: "running",
      });

      const results = await Promise.allSettled([
        db.updateJobAttemptStatus(attemptId, "completed", {
          exitCode: 0,
          finishedAt: 201,
        }),
        db.materializeTerminalAttempt!({
          jobId,
          attemptId,
          status: "failed",
          exitCode: 1,
          finishedAt: 200,
          source: "runner",
          payload: { exitCode: 1 },
        }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

      const job = await db.getJob(jobId);
      const attempt = (await db.listJobAttempts(jobId)).find((entry) => entry.id === attemptId);
      const terminalEvents = (await db.listJobEvents(jobId)).filter(
        (event) => event.type === "process.failed" && event.attemptId === attemptId,
      );
      if (attempt?.status === "failed") {
        expect(job?.status).toBe("failed");
        expect(terminalEvents).toHaveLength(1);
      } else {
        expect(attempt?.status).toBe("completed");
        expect(job?.status).toBe("running");
        expect(terminalEvents).toHaveLength(0);
      }
    });

    it("serializes artifact registration with terminal materialization", async () => {
      const tag = `artifact-terminal-race-${Date.now()}`;
      const jobId = `${tag}-job`;
      const attemptId = `${tag}-attempt`;
      await db.createJob({
        id: jobId,
        name: tag,
        software: "orca",
        inputPath: "/tmp/test.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobId, "queued");
      await db.updateJobStatus(jobId, "staged");
      await db.updateJobStatus(jobId, "running");
      await db.createJobAttempt({
        id: attemptId,
        jobId,
        runner: "local",
        command: "orca /tmp/test.inp",
        cwd: "/tmp",
        status: "running",
      });

      const [created] = await Promise.all([
        db.createArtifactIfAbsent!({
          id: `${tag}-artifact`,
          jobId,
          attemptId,
          kind: "output",
          path: `/tmp/${tag}.out`,
        }),
        db.materializeTerminalAttempt!({
          jobId,
          attemptId,
          status: "completed",
          exitCode: 0,
          finishedAt: 200,
          source: "runner",
          payload: { exitCode: 0 },
        }),
      ]);

      expect(created).toBe(true);
      expect((await db.getJob(jobId))?.status).toBe("completed");
      expect(
        (await db.listArtifacts(jobId)).filter((entry) => entry.attemptId === attemptId),
      ).toHaveLength(1);
    });

    // ── Scheduler Dispatch Claim ──────────────────────────────

    it("claimJobForDispatch returns claimed on eligible queued job", async () => {
      // Create a job, a node, then claim
      const generatedId = `claim-test-${Date.now()}`;
      const jobId = `${generatedId}-job`;
      const nodeId = `${generatedId}-node`;
      const attemptId = `${generatedId}-att`;
      await db.createJob({
        id: jobId,
        name: "test",
        software: "orca",
        inputPath: "/tmp/test.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobId, "queued");
      await db.createNode({
        id: nodeId,
        name: "test-node",
        host: "localhost",
        user: "test",
        runner: "local",
      });

      const result = await db.claimJobForDispatch(
        jobId,
        nodeId,
        attemptId,
        "local",
        "orca /tmp/test.inp",
        "/tmp",
      );
      expect(result.claimed).toBe(true);
      if (result.claimed) {
        expect(result.jobId).toBe(jobId);
        expect(result.attemptId).toBe(attemptId);
      }
    });

    it("claimJobForDispatch returns has_nonterminal_attempt when job has running attempt", async () => {
      const generatedId = `claim-nterm-${Date.now()}`;
      const jobId = `${generatedId}-job`;
      const nodeId = `${generatedId}-node`;
      const attemptId = `${generatedId}-att`;
      await db.createJob({
        id: jobId,
        name: "test",
        software: "orca",
        inputPath: "/tmp/test.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobId, "queued");
      await db.createNode({
        id: nodeId,
        name: "test-node",
        host: "localhost",
        user: "test",
        runner: "local",
      });
      // Create a running attempt
      await db.createJobAttempt({
        id: attemptId,
        jobId,
        runner: "local",
        command: "orca /tmp/test.inp",
        cwd: "/tmp",
        status: "running",
      });

      // Claim should fail — already has nonterminal attempt
      const result = await db.claimJobForDispatch(
        jobId,
        nodeId,
        `${generatedId}-att2`,
        "local",
        "orca",
        "/tmp",
      );
      expect(result.claimed).toBe(false);
      expect(result.reason).toBe("has_nonterminal_attempt");
    });

    it("claimJobForDispatch returns not_queued for cancelled/terminal job", async () => {
      const generatedId = `claim-term-${Date.now()}`;
      const jobId = `${generatedId}-job`;
      const nodeId = `${generatedId}-node`;
      await db.createJob({
        id: jobId,
        name: "test",
        software: "orca",
        inputPath: "/tmp/test.inp",
        workdir: "/tmp",
      });
      await db.createNode({
        id: nodeId,
        name: "test-node",
        host: "localhost",
        user: "test",
        runner: "local",
      });

      // Transition: created → queued → cancelled
      await db.updateJobStatus(jobId, "queued");
      await db.updateJobStatus(jobId, "cancelled");

      const result = await db.claimJobForDispatch(
        jobId,
        nodeId,
        `${generatedId}-att`,
        "local",
        "orca",
        "/tmp",
      );
      expect(result.claimed).toBe(false);
      expect(result.reason).toBe("not_queued");
    });

    it("claimJobForDispatch creates exactly one attempt and one attempt.created event", async () => {
      const generatedId = `claim-ev-${Date.now()}`;
      const jobId = `${generatedId}-job`;
      const nodeId = `${generatedId}-node`;
      const attemptId = `${generatedId}-att`;
      await db.createJob({
        id: jobId,
        name: "test",
        software: "orca",
        inputPath: "/tmp/test.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobId, "queued");
      await db.createNode({
        id: nodeId,
        name: "test-node",
        host: "localhost",
        user: "test",
        runner: "local",
      });

      const result = await db.claimJobForDispatch(
        jobId,
        nodeId,
        attemptId,
        "local",
        "orca /tmp/test.inp",
        "/tmp",
      );
      expect(result.claimed).toBe(true);

      // Verify exactly one attempt
      const attempts = await db.listJobAttempts(jobId);
      const matchingAttempts = attempts.filter((a) => a.id === attemptId);
      expect(matchingAttempts).toHaveLength(1);

      // Verify attempt.created event
      const events = await db.listJobEvents(jobId);
      const createdEvents = events.filter(
        (e) => e.type === "attempt.created" && e.attemptId === attemptId,
      );
      expect(createdEvents).toHaveLength(1);
    });

    it("second claim on already-claimed job returns not_queued", async () => {
      const generatedId = `claim2-${Date.now()}`;
      const jobId = `${generatedId}-job`;
      const nodeId = `${generatedId}-node`;
      await db.createJob({
        id: jobId,
        name: "test",
        software: "orca",
        inputPath: "/tmp/test.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobId, "queued");
      await db.createNode({
        id: nodeId,
        name: "test-node",
        host: "localhost",
        user: "test",
        runner: "local",
      });

      // First claim succeeds
      const first = await db.claimJobForDispatch(
        jobId,
        nodeId,
        `att-${generatedId}-1`,
        "local",
        "orca",
        "/tmp",
      );
      expect(first.claimed).toBe(true);

      // Second claim on same job should fail (has nonterminal attempt now)
      const second = await db.claimJobForDispatch(
        jobId,
        nodeId,
        `att-${generatedId}-2`,
        "local",
        "orca",
        "/tmp",
      );
      expect(second.claimed).toBe(false);
      expect(second.reason).toBe("has_nonterminal_attempt");
    });

    it("claimJobForDispatch on nonexistent node returns node_invalid", async () => {
      const generatedId = `claim-no-${Date.now()}`;
      const jobId = `${generatedId}-job`;
      await db.createJob({
        id: jobId,
        name: "test",
        software: "orca",
        inputPath: "/tmp/test.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobId, "queued");

      const result = await db.claimJobForDispatch(
        jobId,
        "nonexistent-node",
        `${generatedId}-att`,
        "local",
        "orca",
        "/tmp",
      );
      expect(result.claimed).toBe(false);
      expect(result.reason).toBe("node_invalid");
    });

    it("claimJobForDispatch rejects a node that starts draining after eligibility was observed", async () => {
      const generatedId = `claim-drain-race-${Date.now()}`;
      const jobId = `${generatedId}-job`;
      const nodeId = `${generatedId}-node`;
      const attemptId = `${generatedId}-att`;
      await db.createJob({
        id: jobId,
        name: "test",
        software: "orca",
        inputPath: "/tmp/test.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobId, "queued");
      await db.createNode({
        id: nodeId,
        name: "test-node",
        host: "localhost",
        user: "test",
        runner: "local",
      });

      const eligibilitySnapshot = await db.getNode(nodeId);
      expect(eligibilitySnapshot?.draining).toBe(false);

      const tx = await db.beginTransaction();
      try {
        await tx.query("UPDATE nodes SET draining = TRUE WHERE id = $1", [nodeId]);
        await tx.commit();
      } catch (error) {
        await tx.rollback();
        throw error;
      }

      const result = await db.claimJobForDispatch(
        jobId,
        nodeId,
        attemptId,
        "local",
        "orca",
        "/tmp",
      );
      expect(result.claimed).toBe(false);
      expect(result.reason).toBe("node_invalid");
      expect(await db.listJobAttempts(jobId)).toHaveLength(0);
      expect((await db.getJob(jobId))?.nodeId).toBeNull();
      expect(
        (await db.listJobEvents(jobId)).filter((event) => event.type === "attempt.created"),
      ).toHaveLength(0);
    });

    it("claimJobForDispatch rejects a node whose status becomes draining after eligibility was observed", async () => {
      const generatedId = `claim-status-race-${Date.now()}`;
      const jobId = `${generatedId}-job`;
      const nodeId = `${generatedId}-node`;
      const attemptId = `${generatedId}-att`;
      await db.createJob({
        id: jobId,
        name: "test",
        software: "orca",
        inputPath: "/tmp/test.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobId, "queued");
      await db.createNode({
        id: nodeId,
        name: "test-node",
        host: "localhost",
        user: "test",
        runner: "local",
      });

      const eligibilitySnapshot = await db.getNode(nodeId);
      expect(eligibilitySnapshot?.status).not.toBe("draining");

      const tx = await db.beginTransaction();
      try {
        await tx.query("UPDATE nodes SET status = $1 WHERE id = $2", ["draining", nodeId]);
        await tx.commit();
      } catch (error) {
        await tx.rollback();
        throw error;
      }

      const result = await db.claimJobForDispatch(
        jobId,
        nodeId,
        attemptId,
        "local",
        "orca",
        "/tmp",
      );
      expect(result.claimed).toBe(false);
      expect(result.reason).toBe("node_invalid");
      expect(await db.listJobAttempts(jobId)).toHaveLength(0);
      expect((await db.getJob(jobId))?.nodeId).toBeNull();
      expect(
        (await db.listJobEvents(jobId)).filter((event) => event.type === "attempt.created"),
      ).toHaveLength(0);
    });

    it("claimJobForDispatch on nonexistent job returns not_found", async () => {
      const result = await db.claimJobForDispatch(
        "nonexistent-job",
        "some-node",
        "some-att",
        "local",
        "orca",
        "/tmp",
      );
      expect(result.claimed).toBe(false);
      expect(result.reason).toBe("not_found");
    });

    it("claimJobForDispatch rolls back on attempt/event failure", async () => {
      // Verify that a claim with a duplicate attempt ID fails
      const generatedId = `claim-roll-${Date.now()}`;
      const jobId = `${generatedId}-job`;
      const nodeId = `${generatedId}-node`;
      const attemptId = `${generatedId}-att`;
      await db.createJob({
        id: jobId,
        name: "test",
        software: "orca",
        inputPath: "/tmp/test.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobId, "queued");
      await db.createNode({
        id: nodeId,
        name: "test-node",
        host: "localhost",
        user: "test",
        runner: "local",
      });

      // First claim succeeds
      const first = await db.claimJobForDispatch(jobId, nodeId, attemptId, "local", "orca", "/tmp");
      expect(first.claimed).toBe(true);

      // Create a new job for a duplicate-attempt-id claim
      const jobId2 = `${generatedId}-job2`;
      await db.createJob({
        id: jobId2,
        name: "test2",
        software: "orca",
        inputPath: "/tmp/test2.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobId2, "queued");

      // Second claim with same attemptId on different job should fail (duplicate PK)
      const second = await db.claimJobForDispatch(
        jobId2,
        nodeId,
        attemptId,
        "local",
        "orca",
        "/tmp",
      );
      expect(second.claimed).toBe(false);
    });

    it("claimJobForDispatch returns insufficient_capacity when node at maxJobs", async () => {
      const generatedId = `cap-maxj-${Date.now()}`;
      const jobId = `${generatedId}-job`;
      const nodeId = `${generatedId}-node`;
      await db.createJob({
        id: jobId,
        name: "test",
        software: "orca",
        inputPath: "/tmp/test.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobId, "queued");
      // Node with maxJobs=1 (default capacity should fit one job)
      await db.createNode({
        id: nodeId,
        name: "test-node",
        host: "localhost",
        user: "test",
        runner: "local",
        maxJobs: 1,
      });
      // Claim first job
      const first = await db.claimJobForDispatch(
        jobId,
        nodeId,
        `${generatedId}-att1`,
        "local",
        "orca",
        "/tmp",
      );
      expect(first.claimed).toBe(true);

      // Use a second job for the capacity test
      const jobId2 = `${generatedId}-job2`;
      await db.createJob({
        id: jobId2,
        name: "test2",
        software: "orca",
        inputPath: "/tmp/test.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobId2, "queued");

      // Node at maxJobs — second job must not claim (the first job is queued on node, counted in capacity)
      const second = await db.claimJobForDispatch(
        jobId2,
        nodeId,
        `${generatedId}-att2`,
        "local",
        "orca",
        "/tmp",
      );
      expect(second.claimed).toBe(false);
      expect(second.reason).toBe("insufficient_capacity");
    });

    it("releaseJobDispatch clears node_id, marks job and attempt failed, emits exactly one process.failed", async () => {
      const generatedId = `rel-${Date.now()}`;
      const jobId = `${generatedId}-job`;
      const nodeId = `${generatedId}-node`;
      const attemptId = `${generatedId}-att`;
      await db.createJob({
        id: jobId,
        name: "test",
        software: "orca",
        inputPath: "/tmp/test.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobId, "queued");
      await db.createNode({
        id: nodeId,
        name: "test-node",
        host: "localhost",
        user: "test",
        runner: "local",
      });
      const claim = await db.claimJobForDispatch(jobId, nodeId, attemptId, "local", "orca", "/tmp");
      expect(claim.claimed).toBe(true);

      // Release
      await db.releaseJobDispatch(jobId, attemptId, "test failure");

      // node_id cleared
      const job = await db.getJob(jobId);
      expect(job?.nodeId).toBeNull();
      expect(job?.status).toBe("failed");

      // attempt failed
      const attempts = await db.listJobAttempts(jobId);
      const released = attempts.find((a) => a.id === attemptId);
      expect(released?.status).toBe("failed");

      // exactly one process.failed event
      const events = await db.listJobEvents(jobId);
      const failEvents = events.filter(
        (e) => e.type === "process.failed" && e.attemptId === attemptId,
      );
      expect(failEvents.length).toBe(1);
      expect(
        events.filter((e) => e.type === "attempt.status.changed" && e.attemptId === attemptId)
          .length,
      ).toBe(1);
      expect(events.filter((e) => e.type === "job.status.changed").length).toBe(2);
      const sequences = events.map((event) => event.sequence);
      expect(sequences.every((sequence) => sequence != null)).toBe(true);
      expect(new Set(sequences).size).toBe(sequences.length);
    });

    it("releaseJobDispatch is idempotent under concurrent calls", async () => {
      const tag = `rel-concurrent-${Date.now()}`;
      const jobId = `${tag}-job`;
      const nodeId = `${tag}-node`;
      const attemptId = `${tag}-attempt`;
      await db.createJob({
        id: jobId,
        name: tag,
        software: "orca",
        inputPath: "/tmp/test.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobId, "queued");
      await db.createNode({
        id: nodeId,
        name: tag,
        host: "localhost",
        user: "test",
        runner: "local",
      });
      expect(
        (await db.claimJobForDispatch(jobId, nodeId, attemptId, "local", "orca", "/tmp")).claimed,
      ).toBe(true);

      await Promise.all([
        db.releaseJobDispatch(jobId, attemptId, "first"),
        db.releaseJobDispatch(jobId, attemptId, "second"),
      ]);

      const events = await db.listJobEvents(jobId);
      expect(
        events.filter((event) => event.type === "process.failed" && event.attemptId === attemptId),
      ).toHaveLength(1);
      expect(
        events.filter(
          (event) => event.type === "attempt.status.changed" && event.attemptId === attemptId,
        ),
      ).toHaveLength(1);
      expect(events.filter((event) => event.type === "job.status.changed")).toHaveLength(2);
    });

    it("releaseJobDispatch rejects conflicting completed evidence without mutation", async () => {
      const tag = `rel-conflict-${Date.now()}`;
      const jobId = `${tag}-job`;
      const nodeId = `${tag}-node`;
      const attemptId = `${tag}-attempt`;
      await db.createJob({
        id: jobId,
        name: tag,
        software: "orca",
        inputPath: "/tmp/test.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobId, "queued");
      await db.createNode({
        id: nodeId,
        name: tag,
        host: "localhost",
        user: "test",
        runner: "local",
      });
      expect(
        (await db.claimJobForDispatch(jobId, nodeId, attemptId, "local", "orca", "/tmp")).claimed,
      ).toBe(true);
      await db.appendEvent({
        id: `${tag}-completed`,
        type: "process.completed",
        at: Date.now(),
        source: "runner",
        jobId,
        attemptId,
        payload: { exitCode: 0 },
      });

      await expect(db.releaseJobDispatch(jobId, attemptId, "must conflict")).rejects.toThrow(
        "Conflicting terminal evidence",
      );
      expect((await db.getJob(jobId))?.status).toBe("queued");
      expect((await db.getJob(jobId))?.nodeId).toBe(nodeId);
      expect((await db.listJobAttempts(jobId))[0]?.status).toBe("created");
      const events = await db.listJobEvents(jobId);
      expect(events.filter((event) => event.type === "process.failed")).toHaveLength(0);
    });

    it("releaseJobDispatch on already-failed attempt does not emit second process.failed", async () => {
      const generatedId = `rel-fail-${Date.now()}`;
      const jobId = `${generatedId}-job`;
      const nodeId = `${generatedId}-node`;
      const attemptId = `${generatedId}-att`;
      await db.createJob({
        id: jobId,
        name: "test",
        software: "orca",
        inputPath: "/tmp/test.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobId, "queued");
      await db.createNode({
        id: nodeId,
        name: "test-node",
        host: "localhost",
        user: "test",
        runner: "local",
      });
      const claim = await db.claimJobForDispatch(jobId, nodeId, attemptId, "local", "orca", "/tmp");
      expect(claim.claimed).toBe(true);

      // First release: should emit process.failed and transition to failed
      await db.releaseJobDispatch(jobId, attemptId, "first failure");
      let events = await db.listJobEvents(jobId);
      let failEvents = events.filter(
        (e) => e.type === "process.failed" && e.attemptId === attemptId,
      );
      expect(failEvents.length).toBe(1);

      // Second release on already-failed attempt: must NOT emit a second process.failed
      await db.releaseJobDispatch(jobId, attemptId, "second call");
      events = await db.listJobEvents(jobId);
      failEvents = events.filter((e) => e.type === "process.failed" && e.attemptId === attemptId);
      expect(failEvents.length).toBe(1);
    });

    // ── Five-branch releaseJobDispatch identity safety ──────────

    it("releaseJobDispatch branch 1: pre-running attempt transitions to failed, clears node_id, emits exactly one event", async () => {
      const tag = `br1-${Date.now()}`;
      const jobId = `${tag}-job`;
      const nodeId = `${tag}-node`;
      const attemptId = `${tag}-att`;
      await db.createJob({
        id: jobId,
        name: "t1",
        software: "orca",
        inputPath: "/tmp/t.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobId, "queued");
      await db.createNode({
        id: nodeId,
        name: "t1",
        host: "localhost",
        user: "t",
        runner: "local",
      });
      const claim = await db.claimJobForDispatch(
        jobId,
        nodeId,
        attemptId,
        "local",
        "orca /tmp/t.inp",
        "/tmp",
      );
      expect(claim.claimed).toBe(true);

      await db.releaseJobDispatch(jobId, attemptId, "branch1 fail");

      // Attempt is failed
      const attempts = await db.listJobAttempts(jobId);
      const a = attempts.find((x) => x.id === attemptId);
      expect(a?.status).toBe("failed");

      // node_id cleared
      const job = await db.getJob(jobId);
      expect(job?.nodeId).toBeNull();
      expect(job?.status).toBe("failed");

      // Exactly one process.failed
      const evts = await db.listJobEvents(jobId);
      expect(
        evts.filter((e) => e.type === "process.failed" && e.attemptId === attemptId).length,
      ).toBe(1);
    });

    it("releaseJobDispatch branch 2: already-failed attempt clears node_id without second event", async () => {
      const tag = `br2-${Date.now()}`;
      const jobId = `${tag}-job`;
      const nodeId = `${tag}-node`;
      const attemptId = `${tag}-att`;
      await db.createJob({
        id: jobId,
        name: "t2",
        software: "orca",
        inputPath: "/tmp/t.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobId, "queued");
      await db.createNode({
        id: nodeId,
        name: "t2",
        host: "localhost",
        user: "t",
        runner: "local",
      });
      await db.claimJobForDispatch(jobId, nodeId, attemptId, "local", "orca", "/tmp");
      await db.releaseJobDispatch(jobId, attemptId, "first"); // transitions to failed, emits event
      let evts = await db.listJobEvents(jobId);
      expect(
        evts.filter((e) => e.type === "process.failed" && e.attemptId === attemptId).length,
      ).toBe(1);

      // Release again on already-failed: idempotent — no second event
      await db.releaseJobDispatch(jobId, attemptId, "second call");
      evts = await db.listJobEvents(jobId);
      expect(
        evts.filter((e) => e.type === "process.failed" && e.attemptId === attemptId).length,
      ).toBe(1);

      // node_id was cleared by first release (Branch 1 behavior). Verify it stays null.
      const job = await db.getJob(jobId);
      expect(job?.nodeId).toBeNull();
      expect(job?.status).toBe("failed");
    });

    it("releaseJobDispatch branch 3: running attempt leaves node_id and no event", async () => {
      const tag = `br3-${Date.now()}`;
      const jobId = `${tag}-job`;
      const nodeId = `${tag}-node`;
      const attemptId = `${tag}-att`;
      await db.createJob({
        id: jobId,
        name: "t3",
        software: "orca",
        inputPath: "/tmp/t.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobId, "queued");
      await db.createNode({
        id: nodeId,
        name: "t3",
        host: "localhost",
        user: "t",
        runner: "local",
      });
      await db.claimJobForDispatch(jobId, nodeId, attemptId, "local", "orca", "/tmp");
      // Manually transition attempt through valid chain: created → queued → staged → running
      await db.updateJobAttemptStatus(attemptId, "queued");
      await db.updateJobAttemptStatus(attemptId, "staged");
      await db.updateJobAttemptStatus(attemptId, "running", { pid: 9999, startedAt: Date.now() });

      // Branch 3: release on running attempt — no mutation
      await db.releaseJobDispatch(jobId, attemptId, "should be ignored");

      const job = await db.getJob(jobId);
      expect(job?.nodeId).toBe(nodeId); // node_id still assigned
      const attempts = await db.listJobAttempts(jobId);
      const a = attempts.find((x) => x.id === attemptId);
      expect(a?.status).toBe("running"); // status unchanged
      const evts = await db.listJobEvents(jobId);
      expect(
        evts.filter((e) => e.type === "process.failed" && e.attemptId === attemptId).length,
      ).toBe(0);
    });

    it("releaseJobDispatch branch 4: missing attempt does nothing", async () => {
      const tag = `br4-${Date.now()}`;
      const jobId = `${tag}-job`;
      await db.createJob({
        id: jobId,
        name: "t4",
        software: "orca",
        inputPath: "/tmp/t.inp",
        workdir: "/tmp",
      });

      // Release with nonexistent attempt — no error, no event
      await db.releaseJobDispatch(jobId, "nonexistent-attempt", "missing");
      const evts = await db.listJobEvents(jobId);
      expect(evts.length).toBe(0);
    });

    it("releaseJobDispatch branch 5: wrong-job attempt does nothing to either job", async () => {
      const tag = `br5-${Date.now()}`;
      const jobIdA = `${tag}-a`;
      const jobIdB = `${tag}-b`;
      const nodeId = `${tag}-node`;
      const attemptIdA = `${tag}-att`;
      await db.createJob({
        id: jobIdA,
        name: "t5a",
        software: "orca",
        inputPath: "/tmp/t.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobIdA, "queued");
      await db.createJob({
        id: jobIdB,
        name: "t5b",
        software: "orca",
        inputPath: "/tmp/t.inp",
        workdir: "/tmp",
      });
      await db.updateJobStatus(jobIdB, "queued");
      await db.createNode({
        id: nodeId,
        name: "t5",
        host: "localhost",
        user: "t",
        runner: "local",
      });
      // Claim job A — gets attemptIdA, node_id=A → nodeId
      await db.claimJobForDispatch(jobIdA, nodeId, attemptIdA, "local", "orca", "/tmp");

      // Release with attemptIdA but claim jobIdB (wrong owner)
      await db.releaseJobDispatch(jobIdB, attemptIdA, "wrong job");

      // Job A must be unchanged: attempt still created, node_id still assigned
      const aAttempts = await db.listJobAttempts(jobIdA);
      const aAtt = aAttempts.find((x) => x.id === attemptIdA);
      expect(aAtt?.status).toBe("created");

      const jobA = await db.getJob(jobIdA);
      expect(jobA?.nodeId).toBe(nodeId); // reservation intact

      // Job B unchanged: no attempt, no events
      const bAttempts = await db.listJobAttempts(jobIdB);
      expect(bAttempts.length).toBe(0);
      const evtsB = await db.listJobEvents(jobIdB);
      expect(evtsB.filter((e) => e.type === "process.failed").length).toBe(0);
    });
  });
}

// ── SQLite conformance ─────────────────────────────────────

runConformanceSuite("SQLite", async () => {
  const ctx = createSqliteDb();
  await ctx.db.init();
  return { db: ctx.db, cleanup: ctx.cleanup };
});
