// ────────────────────────────────────────────────────────────
// CLI scheduler run --once E2E gate — compiled binary
// ────────────────────────────────────────────────────────────
// Uses `EIGENGRID_TEST_CLI_BIN` when the release wrapper supplies an exact
// candidate, with `dist/eigengrid` retained as a development fallback.
// Separate OS processes drive every scheduler tick. Deterministic fake
// chemistry executables, observable launch marker/PID evidence,
// isolated temp projects. Covers:
//   1. One queued job → exactly one dispatch, one marker
//   2. Repeated --once → no relaunch, no duplicate attempt
//   3. Insufficient capacity → no marker, no lifecycle mutation
//   4. Failed launch → truthful cleanup, no process leak
//   5. Two concurrent --once → at most one dispatches
// ────────────────────────────────────────────────────────────

import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";

// ── Constants ──────────────────────────────────────────────

const REPO_ROOT = resolve(import.meta.dir, "../..");
const BIN_PATH = process.env.EIGENGRID_TEST_CLI_BIN
  ? resolve(process.env.EIGENGRID_TEST_CLI_BIN)
  : join(REPO_ROOT, "dist/eigengrid");
const RECONCILIATION_DEADLINE_MS = 5_000;

// ── Helpers ────────────────────────────────────────────────

function writeMarkerScript(dir: string, markerFile: string): string {
  // Named "orca" — the recipe looks for `orca` in PATH
  const script = `#!/usr/bin/env bash
echo "$$" > "${markerFile}"
exec sleep 30
`;
  const p = join(dir, "orca");
  writeFileSync(p, script, { mode: 0o755 });
  return p;
}

/**
 * Read the database path from a project dir.
 * eigengrid init stores the db in .eigengrid/<database-filename>.
 */
function getDbPath(projectDir: string): string {
  return join(projectDir, ".eigengrid", "scheduler.db");
}

/**
 * Initialize an eigengrid project in the given directory.
 */
function initProject(projectDir: string): void {
  const result = Bun.spawnSync({
    cmd: [
      BIN_PATH,
      "init",
      "--database",
      "scheduler.db",
      "--jobs-dir",
      "jobs",
      "--logs-dir",
      "logs",
      "--outputs-dir",
      "outputs",
      "--sessions-dir",
      "sessions",
    ],
    cwd: projectDir,
    env: { ...process.env, HOME: projectDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`init failed: ${result.stderr.toString()}`);
  }
}

function seedNode(db: Database, id: string): void {
  const now = Date.now();
  db.run(
    `INSERT OR IGNORE INTO nodes (id, name, host, "user", runner, status, engines, cpu_threads_total, memory_mb_total, scratch_mb_total, max_jobs, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      id,
      "localhost",
      "test",
      "local",
      "enabled",
      JSON.stringify(["orca"]),
      16,
      32768,
      102400,
      10,
      now,
      now,
      now,
    ],
  );
}

function queueJob(
  db: Database,
  id: string,
  software: string,
  inputPath: string,
  cpuThreads: number = 1,
  jobsDir: string = "/tmp/jobs",
): void {
  const now = Date.now();
  db.run(
    `INSERT INTO jobs (id, name, software, input_path, workdir, status, cpu_threads, memory_mb, scratch_mb, priority, owner_user_id, project_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      id,
      software,
      inputPath,
      jobsDir,
      "queued",
      cpuThreads,
      1024,
      1024,
      "normal",
      "local",
      "default",
      now,
      now,
    ],
  );
}

function spawnSchedulerOnce(env: Record<string, string>): {
  proc: import("bun").Subprocess;
  pid: number;
} {
  const proc = Bun.spawn([BIN_PATH, "scheduler", "run", "--once"], {
    env,
    cwd: env.HOME,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { proc, pid: proc.pid };
}

async function waitForProc(
  proc: import("bun").Subprocess,
  timeoutMs: number = 15000,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const exited = await Promise.race([
    proc.exited,
    Bun.sleep(timeoutMs).then(() => {
      try {
        proc.kill();
      } catch {}
      return null;
    }),
  ]);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: exited, stdout, stderr };
}

type SchedulerRunResult = Awaited<ReturnType<typeof waitForProc>>;

async function reconcileUntilAttemptFailed(
  env: Record<string, string>,
  jobId: string,
  timeoutMs: number = RECONCILIATION_DEADLINE_MS,
): Promise<SchedulerRunResult[]> {
  const deadline = Date.now() + timeoutMs;
  const results: SchedulerRunResult[] = [];
  let lastStatus: string | null = null;

  do {
    const remainingMs = Math.max(1, deadline - Date.now());
    const result = await waitForProc(spawnSchedulerOnce(env).proc, remainingMs);
    results.push(result);
    if (result.exitCode !== 0) {
      throw new Error(
        `scheduler reconciliation tick failed (${result.exitCode}): ${result.stderr || result.stdout}`,
      );
    }

    const db = new Database(getDbPath(env.HOME));
    try {
      const row = db.query("SELECT status FROM job_attempts WHERE job_id = ?").get(jobId) as
        | { status: string }
        | undefined;
      lastStatus = row?.status ?? null;
    } finally {
      db.close();
    }

    if (lastStatus === "failed") return results;
    if (lastStatus === "completed" || lastStatus === "cancelled") {
      throw new Error(`attempt for ${jobId} reached unexpected terminal status ${lastStatus}`);
    }
    await Bun.sleep(50);
  } while (Date.now() < deadline);

  throw new Error(
    `attempt for ${jobId} did not reconcile to failed within ${timeoutMs}ms (last status: ${lastStatus ?? "missing"})`,
  );
}

function countAttempts(db: Database, jobId: string): number {
  const rows = db.query("SELECT COUNT(*) AS cnt FROM job_attempts WHERE job_id = ?").get(jobId) as
    | Record<string, unknown>
    | undefined;
  return Number(rows?.cnt ?? 0);
}

/** Read a file safely or return empty string. */
function readFileSyncSafe(p: string): string {
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

/** Check whether a PID is alive (signal 0). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kill a PID and its process group. */
function killPid(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* best-effort */
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* best-effort */
  }
}

// Helper to build the env for a project
function buildEnv(projectDir: string, fixturesDir: string): Record<string, string> {
  return {
    EIGENGRID_DB_PATH: getDbPath(projectDir),
    EIGENGRID_JOBS_DIR: join(projectDir, ".eigengrid", "jobs"),
    EIGENGRID_LOGS_DIR: join(projectDir, ".eigengrid", "logs"),
    EIGENGRID_OUTPUTS_DIR: join(projectDir, ".eigengrid", "outputs"),
    EIGENGRID_SESSIONS_DIR: join(projectDir, ".eigengrid", "sessions"),
    PATH: `${fixturesDir}:${process.env.PATH ?? ""}`,
    HOME: projectDir,
  };
}

// ── Setup ──────────────────────────────────────────────────

beforeAll(() => {
  if (!existsSync(BIN_PATH)) {
    throw new Error(`Compiled binary not found at ${BIN_PATH}.`);
  }
});

// ── Tests ──────────────────────────────────────────────────

describe("scheduler run --once compiled binary gate", () => {
  test("one queued job dispatches exactly once with PID marker and live process evidence", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "sched-e2e-ok-"));
    const fixturesDir = join(projectDir, "fixtures");
    const markerFile = join(projectDir, "job-1.pid");
    mkdirSync(fixturesDir, { recursive: true });
    writeMarkerScript(fixturesDir, markerFile);

    // Initialize project
    initProject(projectDir);

    // Create input file
    const jobsDir = join(projectDir, ".eigengrid", "jobs");
    mkdirSync(jobsDir, { recursive: true });
    const inputPath = join(jobsDir, "water.inp");
    writeFileSync(inputPath, "# test input\n");

    // Seed data
    const db = new Database(getDbPath(projectDir));
    seedNode(db, "node-1");
    queueJob(db, "job-1", "orca", inputPath, 1, jobsDir);
    db.close();

    // Run scheduler (async spawn so we can kill the child before the 30s sleep)
    const { proc } = spawnSchedulerOnce(buildEnv(projectDir, fixturesDir));

    // Wait for marker to appear (PID written by orca process)
    const markerDeadline = Date.now() + 5000;
    while (Date.now() < markerDeadline && !existsSync(markerFile)) {
      Bun.sleepSync(100);
    }
    expect(existsSync(markerFile)).toBe(true);

    // ── PID marker assertions ───────────────────────────────
    const markerContent = readFileSyncSafe(markerFile);
    expect(markerContent).toMatch(/^\d+$/);
    const orcaPid = parseInt(markerContent, 10);
    expect(orcaPid).toBeGreaterThan(0);

    // ── Process is alive during observation ─────────────────
    expect(isPidAlive(orcaPid)).toBe(true);

    // ── Kill the child process so the binary exits ──────────
    killPid(orcaPid);

    // ── Now wait for the binary to exit ─────────────────────
    const result = await waitForProc(proc);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Dispatching");
    expect(result.stdout).toContain("Started:");

    // ── DB assertions ───────────────────────────────────────
    const db2 = new Database(getDbPath(projectDir));
    expect(countAttempts(db2, "job-1")).toBe(1);

    const events = db2
      .query("SELECT type FROM job_events WHERE job_id = ? AND type = 'attempt.created'")
      .all("job-1");
    expect(events.length).toBe(1);
    const started = db2
      .query("SELECT type FROM job_events WHERE job_id = ? AND type = 'process.started'")
      .all("job-1");
    expect(started.length).toBe(1);

    // node_id assigned
    const jobRow = db2.query("SELECT node_id FROM jobs WHERE id = 'job-1'").get() as
      | Record<string, unknown>
      | undefined;
    expect(jobRow?.node_id).toBe("node-1");
    db2.close();

    // ── Verify child cleanup ────────────────────────────────
    const deadline2 = Date.now() + 5000;
    while (Date.now() < deadline2 && isPidAlive(orcaPid)) {
      Bun.sleepSync(200);
    }
    expect(isPidAlive(orcaPid)).toBe(false);
  });

  test("repeated --once on already-running job produces no duplicate attempt, marker count exactly one", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "sched-e2e-repeat-"));
    const fixturesDir = join(projectDir, "fixtures");
    const markerFile = join(projectDir, "job-1.pid");
    mkdirSync(fixturesDir, { recursive: true });
    writeMarkerScript(fixturesDir, markerFile);

    initProject(projectDir);

    const jobsDir = join(projectDir, ".eigengrid", "jobs");
    mkdirSync(jobsDir, { recursive: true });
    const inputPath = join(jobsDir, "water.inp");
    writeFileSync(inputPath, "# test input\n");

    const db = new Database(getDbPath(projectDir));
    seedNode(db, "node-1");
    queueJob(db, "job-1", "orca", inputPath, 1, jobsDir);
    db.close();

    // First tick: dispatch (async spawn, kill child to let binary exit)
    const { proc: firstProc } = spawnSchedulerOnce(buildEnv(projectDir, fixturesDir));
    const markerDeadline = Date.now() + 5000;
    while (Date.now() < markerDeadline && !existsSync(markerFile)) {
      await Bun.sleep(50);
    }
    expect(existsSync(markerFile)).toBe(true);
    const pidStr = readFileSyncSafe(markerFile);
    const thePid = parseInt(pidStr, 10);
    expect(thePid).toBeGreaterThan(0);
    expect(isPidAlive(thePid)).toBe(true);
    // Kill the orca process so first binary exits
    killPid(thePid);
    const first = await waitForProc(firstProc);
    expect(first.exitCode).toBe(0);

    // The durable wrapper can publish its exit evidence just after the first
    // scheduler process exits. Drive bounded scheduler ticks until that truth
    // is materialized; every tick must remain a no-dispatch cycle.
    const reconciliationTicks = await reconcileUntilAttemptFailed(
      buildEnv(projectDir, fixturesDir),
      "job-1",
    );
    for (const tick of reconciliationTicks) {
      expect(tick.stdout).toContain("No dispatch decisions");
      expect(tick.stdout).not.toContain("SKIPPED:");
    }

    // Exactly one attempt from first dispatch
    const db2 = new Database(getDbPath(projectDir));
    const allAttempts = db2
      .query("SELECT id, status FROM job_attempts WHERE job_id = 'job-1'")
      .all() as { id: string; status: string }[];
    expect(allAttempts.length).toBe(1);
    expect(allAttempts[0].status).toBe("failed");

    const events = db2
      .query("SELECT type FROM job_events WHERE job_id = ? AND type = 'attempt.created'")
      .all("job-1");
    expect(events.length).toBe(1);
    const startedEvents = db2
      .query("SELECT type FROM job_events WHERE job_id = ? AND type = 'process.started'")
      .all("job-1");
    expect(startedEvents.length).toBe(1);
    const failedEvents = db2
      .query("SELECT type FROM job_events WHERE job_id = ? AND type = 'process.failed'")
      .all("job-1");
    expect(failedEvents.length).toBe(1);
    db2.close();
  });

  test("insufficient capacity produces hold with zero markers and no lifecycle mutation", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "sched-e2e-hold-"));
    const fixturesDir = join(projectDir, "fixtures");
    const markerFile = join(projectDir, "hold-marker.txt");
    mkdirSync(fixturesDir, { recursive: true });
    writeMarkerScript(fixturesDir, markerFile); // should NOT be created

    initProject(projectDir);

    const db = new Database(getDbPath(projectDir));
    // Node with very limited CPU — even the default job (cpu=1) will exceed 0
    seedNode(db, "node-tiny");
    // Set cpu_threads_total to 0 so no job fits
    db.run("UPDATE nodes SET cpu_threads_total = 0 WHERE id = 'node-tiny'");

    const jobsDir = join(projectDir, ".eigengrid", "jobs");
    mkdirSync(jobsDir, { recursive: true });
    const inputPath = join(jobsDir, "water.inp");
    writeFileSync(inputPath, "# test input\n");

    queueJob(db, "job-hold", "orca", inputPath, 1, jobsDir);
    db.close();

    // Scheduler run: the pure schedule() function will determine node-tiny
    // has cpu_threads_total=0 which means effective capacity is 0.
    // But schedule() checks effectiveCPU against job.cpuThreads, not cpu_total.
    // cpu_total=0 means available=0, so effectiveCPU=0 < job.cpuThreads=1 → hold
    const result = await waitForProc(spawnSchedulerOnce(buildEnv(projectDir, fixturesDir)).proc);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No dispatch decisions");

    // Zero marker — nothing launched
    expect(existsSync(markerFile)).toBe(false);

    // No attempt created
    const db2 = new Database(getDbPath(projectDir));
    expect(countAttempts(db2, "job-hold")).toBe(0);

    // No events
    const started = db2
      .query("SELECT type FROM job_events WHERE job_id = ? AND type = 'process.started'")
      .all("job-hold");
    expect(started.length).toBe(0);
    db2.close();
  });

  test("failed launch with missing executable leaves attempt failed and node_id cleared, no process leak", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "sched-e2e-fail-"));
    // Empty fixtures dir — no orca executable, so spawn will ENOENT
    const fixturesDir = join(projectDir, "fixtures");
    mkdirSync(fixturesDir, { recursive: true });
    initProject(projectDir);

    const jobsDir = join(projectDir, ".eigengrid", "jobs");
    mkdirSync(jobsDir, { recursive: true });
    const inputPath = join(jobsDir, "water.inp");
    writeFileSync(inputPath, "# test input\n");

    const db = new Database(getDbPath(projectDir));
    seedNode(db, "node-1");
    queueJob(db, "job-fail", "orca", inputPath, 1, jobsDir);
    db.close();

    // Set PATH to fixtures-only — real system orca is NOT accessible
    const failEnv: Record<string, string> = {
      ...buildEnv(projectDir, fixturesDir),
      PATH: fixturesDir,
    };
    const result = await waitForProc(spawnSchedulerOnce(failEnv).proc);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("FAILED:");
    expect(result.stdout).not.toContain("Started:");

    const db2 = new Database(getDbPath(projectDir));
    // After failed start: node_id should be cleared
    const jobRow = db2.query("SELECT node_id, status FROM jobs WHERE id = 'job-fail'").get() as
      | Record<string, unknown>
      | undefined;
    expect(jobRow?.node_id).toBeNull();
    expect(jobRow?.status).toBe("failed");

    // Attempt should be failed
    const attemptRow = db2
      .query("SELECT status FROM job_attempts WHERE job_id = 'job-fail'")
      .get() as Record<string, unknown> | undefined;
    expect(attemptRow?.status).toBe("failed");

    // No process.started event
    const startedEvents = db2
      .query("SELECT type FROM job_events WHERE job_id = ? AND type = 'process.started'")
      .all("job-fail");
    expect(startedEvents.length).toBe(0);

    // Exactly one process.failed event
    const failEvents = db2
      .query("SELECT type FROM job_events WHERE job_id = ? AND type = 'process.failed'")
      .all("job-fail");
    expect(failEvents.length).toBe(1);

    // No running process leak
    const hasPid = db2.query("SELECT pid FROM job_attempts WHERE job_id = 'job-fail'").get() as
      | Record<string, unknown>
      | undefined;
    expect(hasPid?.pid).toBeNull();
    db2.close();

    // A deterministic launch failure is terminal. A second scheduler tick
    // must not create another attempt or emit another failure event.
    const reconciliationTicks = await reconcileUntilAttemptFailed(failEnv, "job-fail");
    for (const tick of reconciliationTicks) {
      expect(tick.stdout).toContain("No dispatch decisions");
      expect(tick.stdout).not.toContain("SKIPPED:");
    }

    const db3 = new Database(getDbPath(projectDir));
    expect(countAttempts(db3, "job-fail")).toBe(1);
    const repeatedAttemptEvents = db3
      .query("SELECT type FROM job_events WHERE job_id = ? AND type = 'attempt.created'")
      .all("job-fail");
    expect(repeatedAttemptEvents.length).toBe(1);
    const repeatedFailures = db3
      .query("SELECT type FROM job_events WHERE job_id = ? AND type = 'process.failed'")
      .all("job-fail");
    expect(repeatedFailures.length).toBe(1);
    db3.close();
  });

  test("two concurrent --once invocations produce at most one winner with cleanup", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "sched-e2e-concur-"));
    const fixturesDir = join(projectDir, "fixtures");
    const markerFile = join(projectDir, "winner.pid");
    mkdirSync(fixturesDir, { recursive: true });
    writeMarkerScript(fixturesDir, markerFile);

    initProject(projectDir);

    const jobsDir = join(projectDir, ".eigengrid", "jobs");
    mkdirSync(jobsDir, { recursive: true });
    const inputPath = join(jobsDir, "water.inp");
    writeFileSync(inputPath, "# test input\n");

    const db = new Database(getDbPath(projectDir));
    seedNode(db, "node-1");
    queueJob(db, "job-concur", "orca", inputPath, 1, jobsDir);
    db.close();

    const env = buildEnv(projectDir, fixturesDir);

    // Launch two processes concurrently
    const p1 = spawnSchedulerOnce(env);
    const p2 = spawnSchedulerOnce(env);

    // Wait briefly for marker, then wait for both processes to finish
    // (they exit when orca child finishes or is killed by timeout)
    await Bun.sleep(2000);

    // Kill both binaries so they exit (orca sleep 30 would keep them alive)
    p1.proc.kill();
    p2.proc.kill();

    // Read outputs
    const [out1, out2] = await Promise.all([
      waitForProc(p1.proc, 5000).then((r) => r.stdout),
      waitForProc(p2.proc, 5000).then((r) => r.stdout),
    ]);

    const successes = [out1, out2].filter((o) => o.includes("Started:"));
    expect(successes.length).toBeLessThanOrEqual(1);

    // Parse winner PID from marker (if exists)
    let winnerPid = 0;
    if (existsSync(markerFile)) {
      const pidStr = readFileSyncSafe(markerFile);
      if (pidStr.match(/^\d+$/)) {
        winnerPid = parseInt(pidStr, 10);
      }
    }

    if (successes.length === 1) {
      expect(winnerPid).toBeGreaterThan(0);
      // The process might have been killed by the binary's timeout/cleanup
      // If alive, clean it up
      if (isPidAlive(winnerPid)) {
        killPid(winnerPid);
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && isPidAlive(winnerPid)) {
          Bun.sleepSync(200);
        }
        expect(isPidAlive(winnerPid)).toBe(false);
      }
    } else {
      // Neither claimed — marker should not exist
      if (winnerPid > 0) {
        // Marker exists but no "Started:" — cleanup the orphan
        killPid(winnerPid);
      }
    }

    // At most one attempt
    const db2 = new Database(getDbPath(projectDir));
    expect(countAttempts(db2, "job-concur")).toBeLessThanOrEqual(1);

    const events = db2
      .query("SELECT type FROM job_events WHERE job_id = ? AND type = 'attempt.created'")
      .all("job-concur");
    expect(events.length).toBeLessThanOrEqual(1);
    db2.close();
  }, 30000);
});
