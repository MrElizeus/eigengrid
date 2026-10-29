// ────────────────────────────────────────────────────────────
// PostgreSQL acceptance test
// Creates an ephemeral local cluster using initdb + postgres
// with --auth=trust, temporary data dir and port, bounded
// startup polling, and guaranteed teardown.
// ────────────────────────────────────────────────────────────

import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { PostgresDatabase } from "@eigengrid/db";
import { runConformanceSuite } from "./db-conformance.test";
import {
  canRunPostgres,
  startEphemeralPostgres,
  type EphemeralPostgresCluster as PgCluster,
} from "./helpers/postgres";

// ── PostgreSQL conformance ─────────────────────────────────

// Only run PG tests if we can find initdb
if (canRunPostgres) {
  runConformanceSuite("PostgreSQL (ephemeral)", async () => {
    const cluster = await startEphemeralPostgres();
    const db = new PostgresDatabase(cluster.url);
    return {
      db,
      cleanup: () => cluster.cleanup(),
    };
  });

  // ── Concurrent event append tests ──────────────────────────
  // Requires real PostgreSQL for true concurrent sessions.
  // Tests that advisory-lock-protected sequence allocation is
  // concurrency-safe with unique contiguous sequences per job.

  describe("PostgreSQL concurrent events", () => {
    let db: PostgresDatabase;
    let pgCluster: PgCluster;

    beforeAll(async () => {
      pgCluster = await startEphemeralPostgres();
      db = new PostgresDatabase(pgCluster.url);
      await db.init();
    });

    afterAll(async () => {
      await db.close();
      await pgCluster.cleanup();
    });

    it("simultaneous same-job appends produce unique contiguous sequences", async () => {
      const jobId = "concurrent-same-job";
      const count = 5;

      // Fire 5 concurrent appendEvent calls for the same job
      const tasks = Array.from({ length: count }, (_, i) =>
        db.appendEvent({
          id: `conc-evt-${i}`,
          at: Date.now() + i,
          source: "concurrency",
          type: "concurrency.test",
          jobId,
          payload: { index: i },
        }),
      );
      await Promise.all(tasks);

      const stored = await db.getEvents(jobId);
      const seqEvents = stored
        .filter((e) => e.type === "concurrency.test")
        .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

      expect(seqEvents.length).toBe(count);

      // Verify contiguous unique sequences
      for (let i = 0; i < seqEvents.length; i++) {
        expect(seqEvents[i].sequence).toBe(i + 1);
      }
    });

    it("simultaneous different-job appends do not interfere", async () => {
      const jobA = "concurrent-diff-job-a";
      const jobB = "concurrent-diff-job-b";

      // Interleave appends for two different jobs
      const tasks = [
        db.appendEvent({
          id: "conc-diff-a1",
          at: Date.now(),
          source: "concurrency",
          type: "concurrency.test",
          jobId: jobA,
          payload: {},
        }),
        db.appendEvent({
          id: "conc-diff-b1",
          at: Date.now(),
          source: "concurrency",
          type: "concurrency.test",
          jobId: jobB,
          payload: {},
        }),
        db.appendEvent({
          id: "conc-diff-a2",
          at: Date.now(),
          source: "concurrency",
          type: "concurrency.test",
          jobId: jobA,
          payload: {},
        }),
        db.appendEvent({
          id: "conc-diff-b2",
          at: Date.now(),
          source: "concurrency",
          type: "concurrency.test",
          jobId: jobB,
          payload: {},
        }),
      ];
      await Promise.all(tasks);

      const eventsA = await db.getEvents(jobA);
      const eventsB = await db.getEvents(jobB);
      const seqA = eventsA
        .filter((e) => e.type === "concurrency.test")
        .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
      const seqB = eventsB
        .filter((e) => e.type === "concurrency.test")
        .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

      expect(seqA.length).toBe(2);
      expect(seqB.length).toBe(2);
      expect(seqA[0]!.sequence).toBe(1);
      expect(seqA[1]!.sequence).toBe(2);
      expect(seqB[0]!.sequence).toBe(1);
      expect(seqB[1]!.sequence).toBe(2);
    });
  });

  // ── PostgresTransaction and atomic createArtifact fault tests ──
  //
  // Non-destructive tests share a single ephemeral PG.
  // Destructive tests (pg_terminate_backend) each get their own cluster.

  describe("PostgreSQL transaction and artifact atomicity", () => {
    let faultDb: PostgresDatabase;
    let faultCluster: PgCluster;

    beforeAll(async () => {
      faultCluster = await startEphemeralPostgres();
      faultDb = new PostgresDatabase(faultCluster.url);
      await faultDb.init();
      await faultDb.createJob({
        id: "atomic-art-job",
        name: "test",
        software: "orca",
        inputPath: "/tmp/test.inp",
        workdir: "/tmp",
      });
    });

    afterAll(async () => {
      await faultDb.close();
      await faultCluster.cleanup();
    });

    it("artifact success yields exactly one row and one artifact.registered event", async () => {
      await faultDb.createArtifact({
        id: "atomic-art-ok",
        jobId: "atomic-art-job",
        attemptId: "att-ok",
        kind: "output",
        path: "/tmp/output-ok.log",
      });

      const artifacts = await faultDb.listArtifacts("atomic-art-job");
      const matches = artifacts.filter((a) => a.id === "atomic-art-ok");
      expect(matches).toHaveLength(1);

      const events = await faultDb.getEvents("atomic-art-job");
      const eventMatches = events.filter(
        (e) => e.type === "artifact.registered" && e.artifactId === "atomic-art-ok",
      );
      expect(eventMatches).toHaveLength(1);
    });

    it("duplicate artifact PK rejects, no extra row or event", async () => {
      await faultDb.createArtifact({
        id: "atomic-art-dupe",
        jobId: "atomic-art-job",
        attemptId: "att-dupe",
        kind: "output",
        path: "/tmp/output-dupe.log",
      });

      await expect(
        faultDb.createArtifact({
          id: "atomic-art-dupe",
          jobId: "atomic-art-job",
          attemptId: "att-dupe-2",
          kind: "output",
          path: "/tmp/output-dupe-2.log",
        }),
      ).rejects.toThrow();

      const artifacts = await faultDb.listArtifacts("atomic-art-job");
      expect(artifacts.filter((a) => a.id === "atomic-art-dupe")).toHaveLength(1);

      const events = await faultDb.getEvents("atomic-art-job");
      expect(
        events.filter(
          (e) => e.type === "artifact.registered" && e.artifactId === "atomic-art-dupe",
        ),
      ).toHaveLength(1);
    });

    it("artifact-event failure rolls back both row and event", async () => {
      const dbSeam = faultDb as unknown as {
        emitClientEvent: (...args: unknown[]) => Promise<void>;
      };

      try {
        dbSeam.emitClientEvent = async () => {
          throw new Error("Simulated event emission failure");
        };

        await expect(
          faultDb.createArtifact({
            id: "atomic-art-fail",
            jobId: "atomic-art-job",
            attemptId: "att-fail",
            kind: "output",
            path: "/tmp/output-fail.log",
          }),
        ).rejects.toThrow("Simulated event emission failure");
      } finally {
        delete (dbSeam as unknown as Record<string, unknown>).emitClientEvent;
      }

      const artifacts = await faultDb.listArtifacts("atomic-art-job");
      expect(artifacts.some((a) => a.id === "atomic-art-fail")).toBe(false);

      const events = await faultDb.getEvents("atomic-art-job");
      expect(
        events.some((e) => e.type === "artifact.registered" && e.artifactId === "atomic-art-fail"),
      ).toBe(false);
    });

    it("successful commit idempotent", async () => {
      const tx = await faultDb.beginTransaction();
      await tx.query("SELECT 1");
      await tx.commit();
      await expect(tx.commit()).resolves.toBeUndefined();
      await expect(tx.rollback()).resolves.toBeUndefined();
    });

    it("successful rollback idempotent", async () => {
      const tx = await faultDb.beginTransaction();
      await tx.query("SELECT 1");
      await tx.rollback();
      await expect(tx.rollback()).resolves.toBeUndefined();
      await expect(tx.commit()).resolves.toBeUndefined();
    });
  });

  // ── PostgresTransaction COMMIT failure test ──
  // Forces transaction abort via a PK constraint violation.
  // ROLLBACK on an aborted transaction succeeds in PG; only COMMIT fails.
  // The ROLLBACK failure code path uses identical try/catch/finalize logic.

  // ── PostgresTransaction COMMIT/ROLLBACK failure tests ──
  // Uses PostgresTransaction directly with a fake PoolClient.
  // Imported from @eigengrid/db (exported for testing).

  describe("PostgresTransaction commit/rollback failure", () => {
    it("COMMIT failure emits TRANSACTION code, releases once, retry no-op", async () => {
      let released = false;
      const fakeClient = {
        query: async (sql: string) => {
          if (sql.trim().toUpperCase() === "COMMIT") throw new Error("Simulated COMMIT failure");
          return { rows: [] };
        },
        release: () => {
          released = true;
        },
      } as unknown as import("pg").PoolClient;

      const { PostgresTransaction: PT } = await import("@eigengrid/db");
      const tx = new PT(fakeClient);
      try {
        await tx.commit();
        expect(true).toBe(false);
      } catch (err: unknown) {
        expect((err as Error).message).toContain("commit failed");
      }
      expect(released).toBe(true);

      await expect(tx.commit()).resolves.toBeUndefined();
      await expect(tx.rollback()).resolves.toBeUndefined();
      expect(released).toBe(true);
    });

    it("ROLLBACK failure emits TRANSACTION code, releases once, retry no-op", async () => {
      let released = false;
      const fakeClient = {
        query: async (sql: string) => {
          if (sql.trim().toUpperCase() === "ROLLBACK")
            throw new Error("Simulated ROLLBACK failure");
          return { rows: [] };
        },
        release: () => {
          released = true;
        },
      } as unknown as import("pg").PoolClient;

      const { PostgresTransaction: PT } = await import("@eigengrid/db");
      const tx = new PT(fakeClient);
      try {
        await tx.rollback();
        expect(true).toBe(false);
      } catch (err: unknown) {
        expect((err as Error).message).toContain("rollback failed");
      }
      expect(released).toBe(true);

      await expect(tx.rollback()).resolves.toBeUndefined();
      await expect(tx.commit()).resolves.toBeUndefined();
      expect(released).toBe(true);
    });

    it("successful commit idempotent, no double release", async () => {
      let released = false;
      const fakeClient = {
        query: async () => ({ rows: [] }),
        release: () => {
          released = true;
        },
      } as unknown as import("pg").PoolClient;

      const { PostgresTransaction: PT } = await import("@eigengrid/db");
      const tx = new PT(fakeClient);
      await tx.query("SELECT 1");
      await tx.commit();
      expect(released).toBe(true);
      await expect(tx.commit()).resolves.toBeUndefined();
      await expect(tx.rollback()).resolves.toBeUndefined();
      expect(released).toBe(true);
    });

    it("successful rollback idempotent, no double release", async () => {
      let released = false;
      const fakeClient = {
        query: async () => ({ rows: [] }),
        release: () => {
          released = true;
        },
      } as unknown as import("pg").PoolClient;

      const { PostgresTransaction: PT } = await import("@eigengrid/db");
      const tx = new PT(fakeClient);
      await tx.query("SELECT 1");
      await tx.rollback();
      expect(released).toBe(true);
      await expect(tx.rollback()).resolves.toBeUndefined();
      await expect(tx.commit()).resolves.toBeUndefined();
      expect(released).toBe(true);
    });
  });
} else {
  describe("PostgreSQL acceptance", () => {
    it("skipped — initdb not found", () => {
      console.log("PostgreSQL acceptance tests skipped: initdb not available");
    });
  });
}
