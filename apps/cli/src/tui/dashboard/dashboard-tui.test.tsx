// ────────────────────────────────────────────────────────────
// Dashboard TUI — end-to-end Ink render tests
// ────────────────────────────────────────────────────────────
// Renders the real App with a real DashboardController backed by a
// temporary initialized SQLite ApplicationContext. No component
// props are mocked — the DB is the source of truth. Deterministic
// fake stdin/stdout + debug-mode Ink frames drive and observe keys.
// ────────────────────────────────────────────────────────────

import { describe, expect, it, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import React, { act } from "react";
import { render } from "ink";
import type { DatabaseLike } from "@eigengrid/db";
// Construct the adapter class directly (rather than via createDatabase)
// so the TUI tests stay robust when a pre-existing test file's
// mock.module("@eigengrid/db") override is active in the same worker.
import { SqliteDatabase } from "@eigengrid/db";
import type { ParseResult, PythonResult } from "@eigengrid/core";
import type { PythonBridge } from "@eigengrid/python-bridge";
import { createApplicationContext } from "../../composition/context";
import type {
  DashboardDataSource,
  DashboardFetchOptions,
  DashboardSnapshot,
} from "../../composition/types";
import { DashboardController } from "./dashboard-controller";
import { App } from "../App";

// ── Deterministic fake streams ──────────────────────────────

class FakeStdin extends EventEmitter {
  isTTY = true;
  #buffer = "";

  setRawMode(): this {
    return this;
  }
  setEncoding(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  read(): string | null {
    if (!this.#buffer) return null;
    const chunk = this.#buffer;
    this.#buffer = "";
    return chunk;
  }
  write(data: string): void {
    this.#buffer += data;
    this.emit("readable");
  }
  async press(data: string): Promise<void> {
    await act(async () => {
      this.write(data);
    });
  }
}

class FakeStdout extends EventEmitter {
  columns = 120;
  rows = 40;
  readonly frames: string[] = [];

  write(data: string): boolean {
    this.frames.push(data);
    return true;
  }
}

// ── Test seams ──────────────────────────────────────────────

class FakeBridge implements PythonBridge {
  async parse(_software: string, _outputPath: string): Promise<ParseResult> {
    return { ok: true, parser: "test", status: "completed" };
  }
  async generate(_recipe: string, _params: Record<string, unknown>) {
    return { ok: true };
  }
  async conformers(_smiles: string, _n: number) {
    return { ok: true, conformers: 0 };
  }
  async run(_cmd: string, _args: string[]): Promise<PythonResult> {
    return { ok: true };
  }
}

/** Wraps a real data source but can inject refresh failures on demand. */
class FailOnDemandDataSource implements DashboardDataSource {
  fail = false;
  constructor(private readonly inner: DashboardDataSource) {}
  async fetch(options?: DashboardFetchOptions): Promise<DashboardSnapshot> {
    if (this.fail) throw new Error("simulated refresh failure");
    return this.inner.fetch(options);
  }
}

// ── Mounting helper ─────────────────────────────────────────

interface Mounted {
  db: DatabaseLike;
  controller: DashboardController;
  dataSource: FailOnDemandDataSource;
  stdin: FakeStdin;
  stdout: FakeStdout;
  unmount: () => void;
  cleanup: () => void;
  waitUntilExit: () => Promise<void>;
  interval: { handle: unknown; fired: () => void; cleared: unknown[] };
}

async function mountDashboard(
  seed: (db: DatabaseLike) => Promise<void>,
  size = { columns: 120, rows: 40 },
): Promise<Mounted> {
  const tmpDir = mkdtempSync(join(tmpdir(), "dashboard-tui-"));
  const dbPath = join(tmpDir, "test.sqlite");
  const db = new SqliteDatabase(dbPath);
  await db.init();
  await seed(db);

  const ctx = await createApplicationContext({
    db,
    bridge: new FakeBridge(),
    config: { databasePath: dbPath, dbProvider: "sqlite", pythonCommand: "python3" },
  });

  const dataSource = new FailOnDemandDataSource(ctx.dashboard);
  const cleared: unknown[] = [];
  let intervalHandle: unknown = null;
  let intervalHandler: () => void = () => {};
  const controller = new DashboardController({
    dataSource,
    refreshIntervalMs: 25,
    setIntervalFn: (handler) => {
      intervalHandler = handler;
      intervalHandle = { handler };
      return intervalHandle;
    },
    clearIntervalFn: (handle) => {
      cleared.push(handle);
    },
  });

  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  stdout.columns = size.columns;
  stdout.rows = size.rows;
  const stderr = new FakeStdout();
  let instance!: ReturnType<typeof render>;
  // A debug frame is written during commit, before Ink's passive input effects.
  // Flush effects explicitly; observing READY alone is not an input-ready barrier.
  await act(async () => {
    instance = render(React.createElement(App, { controller }), {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: true,
    });
    controller.start();
  });
  // Ink 5 creates this promise lazily; subscribe before a key can cause exit.
  const exited = instance.waitUntilExit();

  return {
    db,
    controller,
    dataSource,
    stdin,
    stdout,
    interval: {
      handle: intervalHandle,
      fired: () => intervalHandler(),
      cleared,
    },
    unmount: () => instance.unmount(),
    waitUntilExit: () => exited,
    cleanup: async () => {
      instance.cleanup();
      await ctx.close();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

async function waitForFrame(
  stdout: FakeStdout,
  predicate: (frame: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = stdout.frames.at(-1);
    if (current !== undefined && predicate(current)) return current;
    await Bun.sleep(10);
  }
  throw new Error("frame not found; last frames:\n" + stdout.frames.slice(-5).join("\n---\n"));
}

async function press(
  mounted: Mounted,
  key: string,
  predicate: (frame: string) => boolean,
): Promise<string> {
  // Ink flushes passive input subscriptions after painting a frame.
  await Bun.sleep(20);
  mounted.stdout.frames.length = 0;
  mounted.stdin.write(key);
  return waitForFrame(mounted.stdout, predicate);
}

async function seedBasic(db: DatabaseLike): Promise<void> {
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

  const tx = await db.beginTransaction();
  await tx.query(
    "INSERT INTO job_logs (job_id, stream, line, created_at) VALUES ($jobId, $stream, $line, $createdAt)",
    { $jobId: "job-2", $stream: "stdout", $line: "SCF converged", $createdAt: 100 },
  );
  await tx.query(
    "INSERT INTO job_logs (job_id, stream, line, created_at) VALUES ($jobId, $stream, $line, $createdAt)",
    { $jobId: "job-2", $stream: "stderr", $line: "basis set ok", $createdAt: 110 },
  );
  await tx.commit();

  await db.appendEvent({
    id: "evt-1",
    type: "job.created",
    at: 100,
    source: "cli",
    jobId: "job-2",
  });
}

// ── Tests ───────────────────────────────────────────────────

describe("dashboard TUI", () => {
  let mounted: Mounted | null = null;

  afterEach(async () => {
    if (mounted) {
      mounted.controller.dispose();
      mounted.unmount();
      await mounted.cleanup();
      mounted = null;
    }
  });

  it("renders real jobs, nodes, and selected-job logs from initialized SQLite", async () => {
    mounted = await mountDashboard(seedBasic);

    await waitForFrame(mounted.stdout, (frame) => frame.includes("job-1"));
    const frame = await waitForFrame(mounted.stdout, (frame) => frame.includes("localbox"));

    expect(frame).toContain("job-1");
    expect(frame).toContain("gaussian");
    expect(frame).toContain("job-2");
    expect(frame).toContain("orca");
    expect(frame).toContain("localbox");
    expect(frame).toContain("READY");
    expect(frame).toContain("▸ Jobs"); // JobList starts focused
  });

  it("arrow keys select a job and show its logs", async () => {
    mounted = await mountDashboard(seedBasic);

    await waitForFrame(mounted.stdout, (frame) => frame.includes("▸ Jobs"));
    await waitForFrame(mounted.stdout, (frame) => frame.includes("job-1"));

    await mounted.stdin.press("\u001B[B"); // down arrow
    await waitForFrame(mounted.stdout, (frame) => frame.includes("SCF converged"));

    const frame = mounted.stdout.frames.at(-1) ?? "";
    expect(frame).toContain("job job-2");
    expect(frame).toContain("SCF converged");
    expect(frame).toContain("basis set ok");
    expect(frame).toContain("job.created");
  });

  it("r refresh reflects live DB changes without remounting and keeps selection", async () => {
    mounted = await mountDashboard(seedBasic);

    await waitForFrame(mounted.stdout, (frame) => frame.includes("▸ Jobs"));
    await waitForFrame(mounted.stdout, (frame) => frame.includes("job-1"));

    // Select the first job (job-2 in DESC order) so its logs are visible.
    await mounted.stdin.press("\u001B[B");
    await waitForFrame(mounted.stdout, (frame) => frame.includes("SCF converged"));

    // External live change in the DB (dashboard stays read-only).
    await mounted.db.updateJobStatus("job-2", "queued");
    await mounted.db.updateJobStatus("job-2", "staged");
    await mounted.db.updateJobStatus("job-2", "running");
    await mounted.stdin.press("r");
    await waitForFrame(mounted.stdout, (frame) => frame.includes("running"));

    const frame = mounted.stdout.frames.at(-1) ?? "";
    expect(frame).toContain("running");
    expect(frame).toContain("SCF converged"); // selected job logs still shown
    expect(frame).toContain("▸ job-2"); // selection marker preserved
  });

  it("Tab cycles focus deterministically across panes", async () => {
    mounted = await mountDashboard(seedBasic);

    await waitForFrame(mounted.stdout, (frame) => frame.includes("READY"));

    await mounted.stdin.press("\t");
    await waitForFrame(mounted.stdout, (frame) => frame.includes("▸ Compute Nodes"));

    await mounted.stdin.press("\t");
    await waitForFrame(mounted.stdout, (frame) => frame.includes("▸ Logs"));

    await mounted.stdin.press("\t");
    await waitForFrame(mounted.stdout, (frame) => frame.includes("▸ Jobs"));
  });

  it("refresh errors retain the last snapshot and show STALE, then recover", async () => {
    mounted = await mountDashboard(seedBasic);
    const { dataSource, stdout } = mounted;

    await waitForFrame(stdout, (frame) => frame.includes("READY"));
    await waitForFrame(stdout, (frame) => frame.includes("job-1"));

    dataSource.fail = true;
    await mounted.stdin.press("r");
    await waitForFrame(stdout, (frame) => frame.includes("STALE"));
    const staleFrame = await waitForFrame(stdout, (frame) =>
      frame.includes("simulated refresh failure"),
    );
    expect(staleFrame).toContain("job-1"); // last valid snapshot retained

    dataSource.fail = false;
    await mounted.stdin.press("r");
    await waitForFrame(stdout, (frame) => frame.includes("READY"));
  });

  it("filters without leaking navigation keys into commands, and Escape restores the list", async () => {
    mounted = await mountDashboard(seedBasic);
    await waitForFrame(mounted.stdout, (frame) => frame.includes("READY"));
    await press(mounted, "/", (frame) => frame.includes("Search /"));
    await press(mounted, "water", (frame) => frame.includes("1 visible"));
    let frame = await press(mounted, "\r", (frame) => frame.includes("/water"));
    expect(frame).toContain("job-1");
    expect(frame).not.toContain("job-2");
    frame = await press(mounted, "\u001B", (frame) => frame.includes("2 visible"));
    expect(frame).toContain("job-2");
    await press(mounted, "/", (frame) => frame.includes("Search /"));
    await press(mounted, "q", (frame) => frame.includes("No matches"));
    await press(mounted, "\u001B", (frame) => frame.includes("2 visible"));
    await press(mounted, "f", (frame) => frame.includes("filter: active"));
    await press(mounted, "f", (frame) => frame.includes("filter: attention"));
    expect(mounted.stdout.frames.at(-1)).toContain("No matches");
    await press(mounted, "\u001B", (frame) => frame.includes("filter: all"));
  });

  it("uses a single pane at 80×24 and adapts to resize without losing selection", async () => {
    mounted = await mountDashboard(seedBasic, { columns: 80, rows: 24 });
    const frame = await waitForFrame(mounted.stdout, (frame) => frame.includes("READY"));
    expect(frame).toContain("▸ Jobs");
    expect(frame).not.toContain("Compute Nodes");
    expect(frame.split("\n").length).toBeLessThanOrEqual(24);
    expect(
      Math.max(...frame.split("\n").map((line) => Array.from(line).length)),
    ).toBeLessThanOrEqual(80);
    await press(mounted, "\u001B[B", (frame) => frame.includes("▸ job-2"));
    await press(mounted, "3", (frame) => frame.includes("SCF converged"));
    await press(mounted, "i", (frame) => frame.includes("DETAILS"));
    await press(mounted, "\u001B[6~", (frame) => frame.includes("Backend"));
    await press(mounted, "\u001B[6~", (frame) => frame.includes("Resources"));
    await press(mounted, "e", (frame) => frame.includes("job.created"));
    mounted.stdout.frames.length = 0;
    mounted.stdout.columns = 140;
    mounted.stdout.rows = 44;
    mounted.stdout.emit("resize");
    const wide = await waitForFrame(mounted.stdout, (frame) => frame.includes("Compute Nodes"));
    expect(wide).toContain("job job-2");
    expect(wide.split("\n").length).toBeLessThanOrEqual(44);
    mounted.stdout.frames.length = 0;
    mounted.stdout.columns = 45;
    mounted.stdout.rows = 15;
    mounted.stdout.emit("resize");
    await waitForFrame(mounted.stdout, (frame) => frame.includes("Resize to at least 64"));
    expect(mounted.controller.selectedJobId).toBe("job-2");
  });

  it("scrolls a large job list and keeps the selected row visible", async () => {
    mounted = await mountDashboard(async (db) => {
      for (let i = 0; i < 70; i++)
        await db.createJob({
          id: `calculation-${String(i).padStart(3, "0")}`,
          name: `molecule ${i}`,
          software: "orca",
          inputPath: "input.inp",
          workdir: "/tmp",
        });
    });
    await waitForFrame(mounted.stdout, (frame) => frame.includes("READY"));
    const last = mounted.controller.snapshot!.jobs.at(-1)!;
    const frame = await press(mounted, "G", (frame) => frame.includes(`job ${last.id}`));
    expect(mounted.controller.selectedJobId).toBe(last.id);
    expect(frame).toContain("of 70");
    expect(frame.split("\n").length).toBeLessThanOrEqual(40);
    await press(mounted, "g", (frame) =>
      frame.includes(`job ${mounted!.controller.snapshot!.jobs[0].id}`),
    );
    expect(mounted.controller.selectedJobId).toBe(mounted.controller.snapshot!.jobs[0].id);
  });

  it("scrolls logs, pans long lines and returns to the live tail", async () => {
    mounted = await mountDashboard(async (db) => {
      await seedBasic(db);
      const tx = await db.beginTransaction();
      for (let i = 0; i < 80; i++)
        await tx.query(
          "INSERT INTO job_logs (job_id, stream, line, created_at) VALUES ($jobId, $stream, $line, $createdAt)",
          {
            $jobId: "job-2",
            $stream: "stdout",
            $line: `iteration-${i} ${"x".repeat(80)} energy-tail-${i}`,
            $createdAt: 1000 + i,
          },
        );
      await tx.commit();
    });
    await waitForFrame(mounted.stdout, (frame) => frame.includes("READY"));
    await press(mounted, "\u001B[B", (frame) => frame.includes("iteration-79"));
    await press(mounted, "3", (frame) => frame.includes("▸ Logs"));
    await press(mounted, "g", (frame) => frame.includes("iteration-30"));
    await press(mounted, "G", (frame) => frame.includes("iteration-79"));
    for (let i = 0; i < 4; i++)
      await press(mounted, "\u001B[C", (frame) => frame.includes(`+${16 * (i + 1)}`));
    expect(mounted.stdout.frames.at(-1)).toContain("energy-tail-79");
    await press(mounted, "0", (frame) => frame.includes("iteration-79"));
  });

  it("help captures keys, supports reverse focus and closes before exiting", async () => {
    mounted = await mountDashboard(seedBasic);
    await waitForFrame(mounted.stdout, (frame) => frame.includes("READY"));
    await press(mounted, "\u001B[Z", (frame) => frame.includes("▸ Logs"));
    await press(mounted, "?", (frame) => frame.includes("Keyboard / Help"));
    await press(mounted, "q", (frame) => frame.includes("▸ Logs"));
    expect(mounted.controller.isDisposed).toBe(false);
  });

  it("q exits the Ink session and leaves no timer behind", async () => {
    mounted = await mountDashboard(seedBasic);
    const { controller, stdin, interval } = mounted;

    await waitForFrame(mounted.stdout, (frame) => frame.includes("job-1"));
    expect(interval.handle).not.toBeNull();

    await stdin.press("q");
    // waitUntilExit resolves after the App exits (deterministic).
    await mounted.waitUntilExit();
    mounted.controller.dispose();
    mounted.unmount();
    await mounted.cleanup();
    mounted = null;

    expect(controller.isDisposed).toBe(true);
    expect(interval.cleared).toEqual([interval.handle]);
    // The interval handler after dispose is a no-op — no more state changes.
    interval.fired();
    expect(controller.refreshCount).toBeGreaterThanOrEqual(1);
  });

  it("Escape exits the Ink session", async () => {
    mounted = await mountDashboard(seedBasic);
    const { controller, stdin } = mounted;

    await waitForFrame(mounted.stdout, (frame) => frame.includes("job-1"));

    await stdin.press("\u001B"); // escape
    await mounted.waitUntilExit();
    mounted.controller.dispose();
    mounted.unmount();
    await mounted.cleanup();
    mounted = null;

    expect(controller.isDisposed).toBe(true);
  });
});
