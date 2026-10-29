// ────────────────────────────────────────────────────────────
// DashboardDataSource — provider-neutral read-only query boundary
// ────────────────────────────────────────────────────────────
// Runs against a temporary initialized SQLite database through the
// ApplicationContext. Proves the boundary delegates to typed query
// services, scopes selected-job data, bounds log tails, and exposes
// no mutation surface.
// ────────────────────────────────────────────────────────────

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
// Construct the adapter class directly (rather than via createDatabase)
// so the boundary tests stay robust when a pre-existing test file's
// mock.module("@eigengrid/db") override is active in the same worker.
import { SqliteDatabase, type DatabaseLike } from "@eigengrid/db";
import type { ParseResult, GenerateResult, ConformerResult, PythonResult } from "@eigengrid/core";
import type { PythonBridge } from "@eigengrid/python-bridge";
import { createApplicationContext } from "./context";
import type { DashboardDataSource } from "./types";

class FakeBridge implements PythonBridge {
  async parse(_software: string, _outputPath: string): Promise<ParseResult> {
    return { ok: true, parser: "test", status: "completed" };
  }
  async generate(_recipe: string, _params: Record<string, unknown>): Promise<GenerateResult> {
    return { ok: true };
  }
  async conformers(_smiles: string, _n: number): Promise<ConformerResult> {
    return { ok: true, conformers: 0 };
  }
  async run(_cmd: string, _args: string[]): Promise<PythonResult> {
    return { ok: true };
  }
}

describe("ApplicationContext dashboard data source", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: DatabaseLike;
  let ctx: Awaited<ReturnType<typeof createApplicationContext>>;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "dashboard-ds-"));
    dbPath = join(tmpDir, "test.sqlite");
    db = new SqliteDatabase(dbPath);
    await db.init();

    await db.createJob({
      id: "job-1",
      name: "water",
      software: "gaussian",
      inputPath: "water.gjf",
      workdir: "/tmp",
    });
    await db.createJob({
      id: "job-2",
      name: "methane",
      software: "orca",
      inputPath: "methane.inp",
      workdir: "/tmp",
    });
    await db.createNode({
      id: "node-1",
      name: "localbox",
      host: "localhost",
      user: "ops",
      runner: "local",
    });

    // Seed log lines via the typed transaction boundary (no raw SQL in prod code).
    const tx = await db.beginTransaction();
    await tx.query(
      "INSERT INTO job_logs (job_id, stream, line, created_at) VALUES ($jobId, $stream, $line, $createdAt)",
      { $jobId: "job-1", $stream: "stdout", $line: "SCF converged", $createdAt: 100 },
    );
    await tx.query(
      "INSERT INTO job_logs (job_id, stream, line, created_at) VALUES ($jobId, $stream, $line, $createdAt)",
      { $jobId: "job-1", $stream: "stderr", $line: "warning: basis set guess", $createdAt: 110 },
    );
    await tx.query(
      "INSERT INTO job_logs (job_id, stream, line, created_at) VALUES ($jobId, $stream, $line, $createdAt)",
      { $jobId: "job-1", $stream: "stdout", $line: "Final energy", $createdAt: 120 },
    );
    await tx.commit();

    await db.appendEvent({
      id: "evt-1",
      type: "job.created",
      at: 100,
      source: "cli",
      jobId: "job-1",
      payload: { software: "gaussian" },
    });
    await db.appendEvent({
      id: "evt-2",
      type: "job.status.changed",
      at: 110,
      source: "cli",
      jobId: "job-1",
      payload: { from: "created", to: "queued" },
    });

    ctx = await createApplicationContext({
      db,
      bridge: new FakeBridge(),
      config: { databasePath: dbPath, dbProvider: "sqlite", pythonCommand: "python3" },
    });
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is owned by ApplicationContext and satisfies the typed boundary", () => {
    expect(ctx.dashboard).toBeDefined();
    const ds: DashboardDataSource = ctx.dashboard;
    expect(ds).toBe(ctx.dashboard);
    // The boundary exposes exactly one read operation — no mutations.
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(ctx.dashboard)).filter(
      (name) => name !== "constructor",
    );
    expect(methods).toEqual(["fetch"]);
  });

  it("fetches jobs and nodes without a selection and no logs", async () => {
    const snapshot = await ctx.dashboard.fetch();
    expect(snapshot.jobs.map((job) => job.id).sort()).toEqual(["job-1", "job-2"]);
    expect(snapshot.nodes.map((node) => node.id)).toEqual(["node-1"]);
    expect(snapshot.logs).toEqual([]);
    expect(snapshot.events).toEqual([]);
    expect(snapshot.timeline).toEqual([]);
    expect(typeof snapshot.fetchedAt).toBe("number");
  });

  it("scopes logs, events, and timeline to the selected job", async () => {
    const snapshot = await ctx.dashboard.fetch({ jobId: "job-1" });
    expect(snapshot.logs.map((log) => log.line)).toEqual([
      "SCF converged",
      "warning: basis set guess",
      "Final energy",
    ]);
    expect(snapshot.events.map((event) => event.type)).toEqual([
      "job.created",
      "job.status.changed",
    ]);
    expect(snapshot.timeline.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.timeline[0]).toHaveProperty("type");
    expect(snapshot.timeline[0]).toHaveProperty("details");
  });

  it("does not leak another job's logs", async () => {
    const snapshot = await ctx.dashboard.fetch({ jobId: "job-2" });
    expect(snapshot.logs).toEqual([]);
    expect(snapshot.events).toEqual([]);
  });

  it("bounds the selected-job log tail", async () => {
    const snapshot = await ctx.dashboard.fetch({ jobId: "job-1", logTail: 2 });
    expect(snapshot.logs.length).toBe(2);
    expect(snapshot.logs.at(-1)?.line).toBe("Final energy");
  });
});
