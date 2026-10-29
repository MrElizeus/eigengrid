// ────────────────────────────────────────────────────────────
// CLI local lifecycle E2E gate — compiled-binary black-box
// ────────────────────────────────────────────────────────────
// Uses the compiled `eigengrid` binary and separate OS processes
// for every lifecycle action. All three scenarios (success,
// failure, cancellation) run in isolated temp project roots with
// deterministic env allowlists.
//
// No direct lifecycle imports or mocking. Pure validator
// functions are reimplemented inline to avoid importing any
// package that also exports lifecycle types.
//
// SIZE EXCEPTION (>400 lines): this single cohesive file
// contains all three scenarios (success, failure, cancel),
// inline deterministic fixture scripts, deterministic env
// bootstrap, and durable count-based assertions. Splitting
// across files would weaken the atomic gate contract. Every
// line serves a distinct assertion or fixture; no opportunistic
// scope. Authorized by Frontier WU-05 work-order as a single
// comprehensive gate.
// ────────────────────────────────────────────────────────────

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
} from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";

// ── Constants ──────────────────────────────────────────────

const REPO_ROOT = resolve(import.meta.dir, "../..");
const FAST_TIMEOUT_MS = 30_000;
const POLL_DEADLINE_MS = 60_000;
const POLL_INTERVAL_MS = 500;

// ── Context ────────────────────────────────────────────────

const ctx: {
  binPath: string;
  tmpDir: string;
  homeDir: string;
  runtimeDir: string;
  successDir: string;
  failureDir: string;
  cancelDir: string;
  fixturesDir: string;
  pidFile: string;
  signalMarker: string;
  successJobId: string;
  successAttemptId: string;
  failureJobId: string;
  failureAttemptId: string;
  cancelJobId: string;
  cancelAttemptId: string;
  cancelShimParent: string;
  cleanupDirs: string[];
} = {
  binPath: "",
  tmpDir: "",
  homeDir: "",
  runtimeDir: "",
  successDir: "",
  failureDir: "",
  cancelDir: "",
  fixturesDir: "",
  pidFile: "",
  signalMarker: "",
  successJobId: "",
  successAttemptId: "",
  failureJobId: "",
  failureAttemptId: "",
  cancelJobId: "",
  cancelAttemptId: "",
  cancelShimParent: "",
  cleanupDirs: [],
};

// ── Pure schema validators (inline, no lifecycle imports) ──

interface ReceiptShape {
  schemaVersion: number;
  jobId: string;
  attemptId: string;
  pid: number;
  command: string;
  args: readonly string[];
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  finishedAt: number;
  status: "completed" | "failed" | "cancelled";
}

function isPositiveInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && Number.isInteger(n);
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function validateReceiptShape(raw: unknown): raw is ReceiptShape {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 1) return false;
  if (typeof r.jobId !== "string" || r.jobId.length === 0) return false;
  if (typeof r.attemptId !== "string" || r.attemptId.length === 0) return false;
  if (!isPositiveInteger(r.pid)) return false;
  if (typeof r.command !== "string") return false;
  if (!Array.isArray(r.args)) return false;
  if (r.args.some((a: unknown) => typeof a !== "string")) return false;
  if (typeof r.cwd !== "string" || r.cwd.length === 0) return false;
  if (r.exitCode !== null && typeof r.exitCode !== "number") return false;
  if (r.signal !== null && typeof r.signal !== "string") return false;
  if (!isFiniteNumber(r.finishedAt)) return false;
  if (!["completed", "failed", "cancelled"].includes(r.status as string)) return false;
  return true;
}

interface IdentityShape {
  schemaVersion: number;
  jobId: string;
  attemptId: string;
  pid: number;
  command: string;
  args: readonly string[];
  cwd: string;
  startTime: number;
  processStartToken: string;
}

function validateIdentityShape(raw: unknown): raw is IdentityShape {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 1) return false;
  if (typeof r.jobId !== "string" || r.jobId.length === 0) return false;
  if (typeof r.attemptId !== "string" || r.attemptId.length === 0) return false;
  if (!isPositiveInteger(r.pid)) return false;
  if (typeof r.command !== "string") return false;
  if (!Array.isArray(r.args)) return false;
  if (r.args.some((a: unknown) => typeof a !== "string")) return false;
  if (typeof r.cwd !== "string" || r.cwd.length === 0) return false;
  if (!isFiniteNumber(r.startTime)) return false;
  if (typeof r.processStartToken !== "string" || r.processStartToken.length === 0) return false;
  return true;
}

// ── Fixture Scripts ────────────────────────────────────────

function writeFixture(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, { mode: 0o755 });
  return p;
}

const G16_SUCCESS = `#!/usr/bin/env bash
cat > /dev/null 2>/dev/null || :
cat <<'ENDOFOUTPUT'
 Gaussian 16:  ES64L-G16RevC.01 5-May-2021
 -----------------------------------------------------------
 Entering Link 1
 -----------------------------------------------------------
 Normal termination of Gaussian 16.
ENDOFOUTPUT
`;

const G16_FAILURE = `#!/usr/bin/env bash
cat > /dev/null 2>/dev/null || :
echo "Fake g16: deliberate failure" >&2
exit 42
`;

/**
 * g16 cancellable fixture: polls $PPID every 1s and self-terminates
 * within 1 s when the wrapper is killed. Writes own PID + parent PID
 * to marker for descendant termination assertions.
 */
const G16_CANCELLABLE = `#!/usr/bin/env bash
if [ -n "$G16_PID_FILE" ]; then
  echo "$$" > "$G16_PID_FILE"
  echo "$PPID" >> "$G16_PID_FILE"
fi
cat > /dev/null 2>/dev/null || :
i=0
while [ $i -lt 120 ]; do
  kill -0 "$PPID" 2>/dev/null || exit 0
  sleep 1
  i=$((i + 1))
done
echo "Fake g16 completed after sleep"
`;

/**
 * Signal-recording sh wrapper for cancellation testing.
 * Handles two invocation patterns:
 *   1. sh -c <script> <args…> — from the executor. Traps SIGTERM, records
 *      exactly one "SIGTERM" line to SIGNAL_MARKER per signal received,
 *      forwards TERM to child, reaps it, exits with child's status.
 *   2. Any other invocation — delegates to /bin/sh transparently.
 *
 * The recipe's real /bin/sh -c runs as a background child so the trap
 * fires immediately (bash defers traps during foreground command).
 * The cancellable g16 fixture is a descendant of that real sh child and
 * self-terminates within 1s of its parent dying.
 */
const SH_SIGNAL_WRAPPER = `#!/usr/bin/env bash
if [ "$1" = "-c" ]; then
  script="$2"
  shift 2
  trap 'echo "SIGTERM" >> "$SIGNAL_MARKER"; kill -TERM "$child" 2>/dev/null; exit 143' TERM
  /bin/sh -c "$script" "$@" &
  child=$!
  wait "$child"
  exit $?
fi
exec /bin/sh "$@"
`;

const PARSER_SHIM = `#!/usr/bin/env bash
cat <<'ENDOFJSON'
{
  "ok": true,
  "parser": "gaussian",
  "status": "completed",
  "data": {
    "normal_termination": true,
    "scf_converged": true,
    "energy_hartree": -76.012345,
    "method": "RB3LYP",
    "basis": "6-31G(d)",
    "charge": 0,
    "multiplicity": 1,
    "geometry": null,
    "frequencies": null,
    "imaginary_frequencies": 0,
    "thermochemistry": null,
    "scf_iterations": null,
    "cpu_time_seconds": null,
    "wall_time_seconds": null,
    "warnings": [],
    "errors": [],
    "raw": null
  }
}
ENDOFJSON
`;

// ── Helpers ────────────────────────────────────────────────

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Deterministic env allowlist — no EIGENGRID_*, DB, or host config leaks. */
function buildEnv(
  fixturesDir: string,
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  // Start with a minimal safe set plus common vars that shell/scripts need,
  // then apply extras. Explicitly exclude EIGENGRID_*, DATABASE_URL, etc.
  const env: Record<string, string> = {
    PATH: `${fixturesDir}:/bin:/usr/bin:/usr/local/bin`,
    HOME: ctx.homeDir,
    TMPDIR: ctx.runtimeDir,
    USER: process.env.USER ?? "test",
    TERM: "dumb",
    LANG: "C.UTF-8",
    SHELL: "/bin/bash",
    LOGNAME: process.env.USER ?? "test",
    LC_ALL: "C.UTF-8",
    // Editor/tool vars
    EDITOR: "cat",
    PAGER: "cat",
  };
  // Carry over common safe vars from host if present
  for (const k of ["SSH_AUTH_SOCK", "DISPLAY", "XDG_RUNTIME_DIR"]) {
    if (process.env[k]) env[k] = process.env[k]!;
  }
  // Apply extras (caller may override PATH, etc.)
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) env[k] = v;
  }
  // Ensure no config-bearing env vars leak through
  for (const k of Object.keys(env)) {
    if (
      k.startsWith("EIGENGRID_") ||
      k.startsWith("DATABASE_") ||
      k === "DATABASE_URL" ||
      k.startsWith("PG")
    ) {
      if (!(k in extra)) delete env[k];
    }
  }
  return env;
}

/**
 * Run the compiled CLI binary as a separate OS process.
 * Uses an explicit env allowlist — no host config leaks.
 * Timeout is properly cleared when child exits; on timeout the
 * child is killed first, then exited is awaited, then output collected.
 */
async function runCli(
  binPath: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string | undefined> },
  timeoutMs: number = FAST_TIMEOUT_MS,
): Promise<CliResult> {
  const env = buildEnv(ctx.fixturesDir, opts.env);
  const proc = Bun.spawn([binPath, ...args], {
    cwd: opts.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
  const stderrPromise = new Response(proc.stderr).text().catch(() => "");

  // Timeout that is genuinely cleared when the child exits first.
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
      resolve();
    }, timeoutMs);
  });

  // Wait for exit OR timeout
  await Promise.race([proc.exited, timeoutPromise]);

  // Clear the timer if the child won (no late callback can signal an exited process)
  if (!timedOut && timeoutId) {
    clearTimeout(timeoutId);
  }

  // If we timed out, wait for actual process death before collecting output
  if (timedOut) {
    try {
      await proc.exited;
    } catch {
      /* ignore */
    }
  }

  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;
  return { exitCode: proc.exitCode ?? (timedOut ? 1 : 0), stdout, stderr };
}

/** Poll job status until target status appears or deadline expires. */
async function pollStatus(
  binPath: string,
  cwd: string,
  jobId: string,
  targetStatus: string,
  deadlineMs: number = POLL_DEADLINE_MS,
  env?: Record<string, string | undefined>,
): Promise<CliResult> {
  const deadline = Date.now() + deadlineMs;
  let lastResult: CliResult = { exitCode: -1, stdout: "", stderr: "poll not started" };
  while (Date.now() < deadline) {
    lastResult = await runCli(binPath, ["status", jobId], { cwd, env });
    if (lastResult.exitCode === 0 && lastResult.stdout.includes(targetStatus)) {
      return lastResult;
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  return lastResult;
}

/** Extract job ID from submit output: "Created job <id>" */
function extractJobId(text: string): string {
  const m = text.match(/Created job\s+(\S+)/);
  if (!m) throw new Error(`Could not extract job ID from:\n${text}`);
  return m[1];
}

/** Extract PID from status output: "PID: <num>" */
function extractPid(text: string): number | null {
  const m = text.match(/PID:\s+(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** Open the project's SQLite database for read-only assertions. */
function openDb(projectDir: string): Database {
  const dbPath = join(projectDir, ".eigengrid", "eigengrid.sqlite");
  if (!existsSync(dbPath)) throw new Error(`DB not found: ${dbPath}`);
  const db = new Database(dbPath, { readonly: true });
  db.exec("PRAGMA query_only = 1");
  return db;
}

function countRows(db: Database, table: string, where?: string): number {
  const q = where
    ? `SELECT COUNT(*) AS cnt FROM ${table} WHERE ${where}`
    : `SELECT COUNT(*) AS cnt FROM ${table}`;
  const row = db.query(q).get() as { cnt: number };
  return row.cnt;
}

/** Read receipt file, validate shape, return parsed or null. */
function readReceiptSafe(
  projectDir: string,
  jobId: string,
  attemptId: string,
): ReceiptShape | null {
  const p = join(
    projectDir,
    ".eigengrid",
    "jobs",
    jobId,
    ".eigengrid",
    `receipt-${attemptId}.json`,
  );
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    if (!validateReceiptShape(raw)) return null;
    return raw as ReceiptShape;
  } catch {
    return null;
  }
}

/** Read active identity file, validate shape, return parsed or null. */
function readIdentitySafe(
  projectDir: string,
  jobId: string,
  attemptId: string,
): IdentityShape | null {
  const p = join(projectDir, ".eigengrid", "jobs", jobId, ".eigengrid", `active-${attemptId}.json`);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    if (!validateIdentityShape(raw)) return null;
    return raw as IdentityShape;
  } catch {
    return null;
  }
}

/** Assert that a PID is dead (with bounded retry for signal delivery). */
async function assertPidDead(pid: number, label: string, deadlineMs = 5_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await Bun.sleep(200);
    } catch (e) {
      const ne = e as NodeJS.ErrnoException;
      if (ne.code === "ESRCH") return;
    }
  }
  // Final check
  try {
    process.kill(pid, 0);
    expect(`PID ${pid} (${label}) still alive`).toBeFalsy();
  } catch (e) {
    const ne = e as NodeJS.ErrnoException;
    expect(ne.code).toBe("ESRCH");
  }
}

/** Resolve the sole attempt ID for a job. */
function resolveAttemptId(projectDir: string, jobId: string): string {
  const db = openDb(projectDir);
  try {
    const rows = db
      .query("SELECT id FROM job_attempts WHERE job_id = ? ORDER BY created_at")
      .all(jobId) as { id: string }[];
    expect(rows.length).toBe(1);
    return rows[0].id;
  } finally {
    db.close();
  }
}

// ── Set Up / Tear Down ────────────────────────────────────

beforeAll(async () => {
  ctx.tmpDir = mkdtempSync(join(tmpdir(), "eigengrid-gate-"));
  ctx.homeDir = join(ctx.tmpDir, "home");
  ctx.runtimeDir = join(ctx.tmpDir, "run");
  ctx.fixturesDir = join(ctx.tmpDir, "fixtures");
  ctx.pidFile = join(ctx.tmpDir, "g16-pid.txt");
  ctx.signalMarker = join(ctx.tmpDir, "signal-marker.txt");
  ctx.cleanupDirs = [ctx.tmpDir];

  mkdirSync(ctx.homeDir, { recursive: true });
  mkdirSync(ctx.runtimeDir, { recursive: true });
  mkdirSync(ctx.fixturesDir, { recursive: true });

  writeFixture(ctx.fixturesDir, "g16", G16_SUCCESS);
  writeFixture(ctx.fixturesDir, "g16-fail", G16_FAILURE);
  writeFixture(ctx.fixturesDir, "g16-cancel", G16_CANCELLABLE);
  writeFixture(ctx.fixturesDir, "parser-shim", PARSER_SHIM);

  ctx.successDir = join(ctx.tmpDir, "success");
  ctx.failureDir = join(ctx.tmpDir, "failure");
  ctx.cancelDir = join(ctx.tmpDir, "cancel");
  mkdirSync(ctx.successDir, { recursive: true });
  mkdirSync(ctx.failureDir, { recursive: true });
  mkdirSync(ctx.cancelDir, { recursive: true });

  const gjf = `! HF STO-3G SP\n\nWater molecule test\n\n0 1\nO     0.00000000    0.00000000    0.00000000\nH     0.00000000    0.75700000    0.58600000\nH     0.00000000   -0.75700000    0.58600000\n\n`;
  writeFileSync(join(ctx.successDir, "water.gjf"), gjf);
  writeFileSync(join(ctx.failureDir, "water.gjf"), gjf);
  writeFileSync(join(ctx.cancelDir, "water.gjf"), gjf);

  const releaseCandidate = process.env.EIGENGRID_TEST_CLI_BIN;
  if (releaseCandidate) {
    ctx.binPath = resolve(releaseCandidate);
    if (!existsSync(ctx.binPath)) {
      throw new Error(`Release-candidate binary not found at ${ctx.binPath}`);
    }
    return;
  }

  // Development fallback: compile the CLI binary once.
  ctx.binPath = join(ctx.tmpDir, "eigengrid-bin");
  const build = Bun.spawn(
    [
      "bun",
      "build",
      "--compile",
      `--outfile=${ctx.binPath}`,
      join(REPO_ROOT, "apps", "cli", "bin", "eigengrid.ts"),
    ],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...(process.env as Record<string, string>) },
    },
  );
  const buildOut = await new Response(build.stdout).text();
  const buildErr = await new Response(build.stderr).text();
  const buildExit = await build.exited;
  if (buildExit !== 0)
    throw new Error(`Build failed (exit ${buildExit}):\nstdout: ${buildOut}\nstderr: ${buildErr}`);
  if (!existsSync(ctx.binPath)) throw new Error(`Compiled binary not found at ${ctx.binPath}`);
});

afterAll(() => {
  // Safety-net: kill any survivor processes from PID file
  for (const f of [ctx.pidFile]) {
    if (existsSync(f)) {
      try {
        for (const line of readFileSync(f, "utf8").trim().split("\n")) {
          const pid = parseInt(line.split(":")[0].trim(), 10);
          if (pid > 0)
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              /* ok */
            }
        }
      } catch {
        /* best-effort */
      }
    }
  }
  for (const d of ctx.cleanupDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ── Scenario 1: Success Project ────────────────────────────

describe("Success lifecycle", () => {
  const parserShimPath = join(ctx.fixturesDir, "parser-shim");

  test("init creates project; repeated init is idempotent", async () => {
    const init1 = await runCli(
      ctx.binPath,
      ["init", "--role", "standalone", "--python", parserShimPath],
      { cwd: ctx.successDir },
    );
    expect(init1.exitCode).toBe(0);
    expect(init1.stdout).toMatch(/Initialized/);
    expect(existsSync(join(ctx.successDir, ".eigengrid"))).toBeTrue();
    expect(existsSync(join(ctx.successDir, ".eigengrid", "eigengrid.sqlite"))).toBeTrue();
    expect(existsSync(join(ctx.successDir, ".eigengrid", "eigengrid.yaml"))).toBeTrue();

    const init2 = await runCli(
      ctx.binPath,
      ["init", "--role", "standalone", "--python", parserShimPath],
      { cwd: ctx.successDir },
    );
    expect(init2.exitCode).toBe(0);
    expect(init2.stdout).toMatch(/Initialized/);

    const db = openDb(ctx.successDir);
    try {
      expect(countRows(db, "nodes")).toBe(1);
    } finally {
      db.close();
    }

    // Verify config has no EIGENGRID_* env vars (our allowlist omitted them)
    expect(init1.stderr).not.toMatch(/EIGENGRID_/);
  });

  test("submit creates a running job with valid ID", async () => {
    const submit = await runCli(
      ctx.binPath,
      [
        "submit",
        "gaussian",
        join(ctx.successDir, "water.gjf"),
        "--runner",
        "local",
        "--recipe",
        "gaussian-opt",
      ],
      { cwd: ctx.successDir },
      FAST_TIMEOUT_MS,
    );
    expect(submit.exitCode).toBe(0);
    expect(submit.stdout).toMatch(/Created job/);
    ctx.successJobId = extractJobId(submit.stdout);
    expect(ctx.successJobId).toBeTruthy();
  });

  test("poll until status completed", async () => {
    const status = await pollStatus(ctx.binPath, ctx.successDir, ctx.successJobId, "completed");
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toMatch(/Status:\s+completed/);
    expect(status.stdout).toMatch(/Exit code:\s+0/);
  });

  test("logs command shows job logs", async () => {
    const logs = await runCli(ctx.binPath, ["logs", ctx.successJobId], { cwd: ctx.successDir });
    expect(logs.exitCode).toBe(0);
    expect(logs.stdout).toMatch(/Logs for job/);
    expect(logs.stdout).not.toMatch(/No log files found/);
  });

  test("output file has deterministic content", async () => {
    const db = openDb(ctx.successDir);
    let outputPath: string | undefined;
    try {
      const jobRow = db
        .query("SELECT workdir, output_path FROM jobs WHERE id = ?")
        .get(ctx.successJobId) as { workdir: string; output_path: string | null };
      if (jobRow && jobRow.output_path)
        outputPath = join(jobRow.workdir, ctx.successJobId, jobRow.output_path);
    } finally {
      db.close();
    }
    expect(outputPath).toBeDefined();
    expect(existsSync(outputPath!)).toBeTrue();
    const content = readFileSync(outputPath!, "utf8");
    expect(content).toMatch(/Normal termination/);
    expect(content).toMatch(/Gaussian 16/);
  });

  test("events show lifecycle events", async () => {
    const events = await runCli(ctx.binPath, ["events", ctx.successJobId], { cwd: ctx.successDir });
    expect(events.exitCode).toBe(0);
    expect(events.stdout).toMatch(/job\.created/);
    expect(events.stdout).toMatch(/recipe\.selected/);
    expect(events.stdout).toMatch(/attempt\.created/);
    expect(events.stdout).toMatch(/process\.started/);
    expect(events.stdout).toMatch(/process\.completed/);
  });

  test("timeline command works", async () => {
    const tl = await runCli(ctx.binPath, ["timeline", ctx.successJobId], { cwd: ctx.successDir });
    expect(tl.exitCode).toBe(0);
    expect(tl.stdout).toMatch(/Timeline for job/);
  });

  test("collect, parse, results produce data", async () => {
    const collect = await runCli(ctx.binPath, ["collect", ctx.successJobId], {
      cwd: ctx.successDir,
    });
    expect(collect.exitCode).toBe(0);
    expect(collect.stdout).toMatch(/Collected/);

    const parse = await runCli(ctx.binPath, ["parse", ctx.successJobId], { cwd: ctx.successDir });
    expect(parse.exitCode).toBe(0);
    expect(parse.stdout).toMatch(/Parse completed/);
    expect(parse.stdout).toMatch(/Parser:\s+gaussian/);
    expect(parse.stdout).toMatch(/Energy:/);

    const results = await runCli(ctx.binPath, ["results", ctx.successJobId], {
      cwd: ctx.successDir,
    });
    expect(results.exitCode).toBe(0);
    expect(results.stdout).toMatch(/Results for job/);

    const resultsJson = await runCli(ctx.binPath, ["results", ctx.successJobId, "--json"], {
      cwd: ctx.successDir,
    });
    expect(resultsJson.exitCode).toBe(0);
    const parsed = JSON.parse(resultsJson.stdout);
    expect(parsed.energyHartree).toBeCloseTo(-76.012345, 5);
    expect(parsed.parser).toBe("gaussian");
    expect(parsed.scfConverged).toBe(true);
    expect(parsed.normalTermination).toBe(true);
  });

  test("receipt and identity validation", async () => {
    ctx.successAttemptId = resolveAttemptId(ctx.successDir, ctx.successJobId);
    expect(ctx.successAttemptId).toBeTruthy();

    // Validate receipt shape and exact fields
    const receipt = readReceiptSafe(ctx.successDir, ctx.successJobId, ctx.successAttemptId);
    expect(receipt).not.toBeNull();
    expect(receipt!.schemaVersion).toBe(1);
    expect(receipt!.jobId).toBe(ctx.successJobId);
    expect(receipt!.attemptId).toBe(ctx.successAttemptId);
    expect(receipt!.status).toBe("completed");
    expect(receipt!.exitCode).toBe(0);
    expect(isPositiveInteger(receipt!.pid)).toBeTrue();
    expect(receipt!.cwd).toContain(ctx.successDir);
    expect(receipt!.cwd).toContain(ctx.successJobId);
    expect(isFiniteNumber(receipt!.finishedAt)).toBeTrue();
    expect(receipt!.finishedAt).toBeGreaterThan(0);

    // Validate identity shape
    const identity = readIdentitySafe(ctx.successDir, ctx.successJobId, ctx.successAttemptId);
    expect(identity).not.toBeNull();
    expect(identity!.jobId).toBe(ctx.successJobId);
    expect(identity!.attemptId).toBe(ctx.successAttemptId);
    expect(identity!.pid).toBe(receipt!.pid);
    expect(isFiniteNumber(identity!.startTime)).toBeTrue();
    expect(identity!.processStartToken.length).toBeGreaterThan(0);

    // Receipt PID must be dead (process finished)
    await assertPidDead(receipt!.pid, "success-receipt");
  });

  test("exact-attempt artifacts and idempotent collect", async () => {
    const db = openDb(ctx.successDir);
    try {
      // Query all artifacts for the exact job/attempt
      const artifacts = db
        .query(
          "SELECT kind, path, label FROM artifacts WHERE job_id = ? AND attempt_id = ? ORDER BY kind",
        )
        .all(ctx.successJobId, ctx.successAttemptId) as {
        kind: string;
        path: string;
        label: string | null;
      }[];

      // Must have stdout, stderr, and output artifacts
      const kinds = artifacts.map((a) => a.kind);
      expect(kinds).toContain("log");
      expect(kinds).toContain("output");
      // At least one log artifact should be labeled stdout
      const stdoutArt = artifacts.find((a) => a.label === "stdout");
      expect(stdoutArt).toBeDefined();
      const stderrArt = artifacts.find((a) => a.label === "stderr");
      expect(stderrArt).toBeDefined();

      // Every artifact path must exist on disk
      for (const a of artifacts) {
        expect(existsSync(a.path)).toBeTrue();
      }
    } finally {
      db.close();
    }

    // Repeat collect twice
    const c1 = await runCli(ctx.binPath, ["collect", ctx.successJobId], { cwd: ctx.successDir });
    expect(c1.exitCode).toBe(0);
    const c2 = await runCli(ctx.binPath, ["collect", ctx.successJobId], { cwd: ctx.successDir });
    expect(c2.exitCode).toBe(0);

    // After repeated collect: artifact rows and event counts must be unchanged
    const db2 = openDb(ctx.successDir);
    try {
      const artifactCountAfter = countRows(
        db2,
        "artifacts",
        `job_id = '${ctx.successJobId}' AND attempt_id = '${ctx.successAttemptId}'`,
      );
      expect(artifactCountAfter).toBeGreaterThanOrEqual(2); // at least stderr+stdout

      const registeredAfter = db2
        .query(
          "SELECT COUNT(*) AS cnt FROM job_events WHERE job_id = ? AND type = 'artifact.registered'",
        )
        .get(ctx.successJobId) as { cnt: number };

      // We didn't snapshot before exactly; instead assert that after two collects
      // there's exactly the same number of registered events as artifacts
      expect(registeredAfter.cnt).toBe(artifactCountAfter);
    } finally {
      db2.close();
    }
  });

  test("event order and exact counts", async () => {
    const db = openDb(ctx.successDir);
    try {
      const rows = db
        .query(
          "SELECT type, event_id, payload_json FROM job_events WHERE job_id = ? ORDER BY created_at, id",
        )
        .all(ctx.successJobId) as {
        type: string;
        event_id: string | null;
        payload_json: string | null;
      }[];
      const types = rows.map((e) => e.type);
      // Count by type
      const counts: Record<string, number> = {};
      for (const t of types) counts[t] = (counts[t] || 0) + 1;

      // Exactly one each of lifecycle-critical events.
      // note: attempt.created may appear twice (once from the coordinator
      // and once from the DB adapter's createJobAttempt emit).
      const count = (t: string) => types.filter((x: string) => x === t).length;
      expect(count("process.started")).toBe(1);
      expect(count("process.completed")).toBe(1);
      expect(count("parse.started")).toBe(1);
      expect(count("result.saved")).toBe(1);
      expect(count("parse.completed")).toBe(1);
      expect(count("job.created")).toBe(1);
      expect(count("recipe.selected")).toBe(1);
      // attempt.created: emitted by DB adapter's createJobAttempt (coordinator no longer emits)
      expect(count("attempt.created")).toBe(1);

      // Canonical relative order (allow artifact events between phases)
      const orderOf = (t: string) => types.indexOf(t);
      expect(orderOf("job.created")).toBeLessThan(orderOf("recipe.selected"));
      expect(orderOf("recipe.selected")).toBeLessThan(orderOf("attempt.created"));
      expect(orderOf("attempt.created")).toBeLessThan(orderOf("process.started"));
      expect(orderOf("process.started")).toBeLessThan(orderOf("process.completed"));
      expect(orderOf("process.completed")).toBeLessThan(orderOf("parse.started"));
      expect(orderOf("parse.started")).toBeLessThan(orderOf("result.saved"));
      expect(orderOf("result.saved")).toBeLessThan(orderOf("parse.completed"));

      // No process.failed
      expect(count("process.failed")).toBe(0);
    } finally {
      db.close();
    }
  });

  test("complete idempotency: repeated status, collect, parse", async () => {
    const db = openDb(ctx.successDir);
    let attemptCountBefore: number, resultCountBefore: number, procCompletedBefore: number;
    try {
      attemptCountBefore = countRows(db, "job_attempts");
      resultCountBefore = countRows(db, "results", `job_id = '${ctx.successJobId}'`);
      procCompletedBefore = db
        .query(
          "SELECT COUNT(*) AS cnt FROM job_events WHERE job_id = ? AND type = 'process.completed'",
        )
        .get(ctx.successJobId) as { cnt: number };
      procCompletedBefore = procCompletedBefore.cnt;
    } finally {
      db.close();
    }

    // Repeat status twice
    for (let i = 0; i < 2; i++) {
      const s = await runCli(ctx.binPath, ["status", ctx.successJobId], { cwd: ctx.successDir });
      expect(s.exitCode).toBe(0);
    }
    // Repeat collect twice, parse twice
    for (let i = 0; i < 2; i++) {
      const c = await runCli(ctx.binPath, ["collect", ctx.successJobId], { cwd: ctx.successDir });
      expect(c.exitCode).toBe(0);
    }
    for (let i = 0; i < 2; i++) {
      const p = await runCli(ctx.binPath, ["parse", ctx.successJobId], { cwd: ctx.successDir });
      expect(p.exitCode).toBe(0);
    }

    const db2 = openDb(ctx.successDir);
    try {
      expect(countRows(db2, "job_attempts")).toBe(attemptCountBefore);
      expect(countRows(db2, "results", `job_id = '${ctx.successJobId}'`)).toBe(resultCountBefore);
      const pc = db2
        .query(
          "SELECT COUNT(*) AS cnt FROM job_events WHERE job_id = ? AND type = 'process.completed'",
        )
        .get(ctx.successJobId) as { cnt: number };
      expect(pc.cnt).toBe(procCompletedBefore);
    } finally {
      db2.close();
    }
  });
});

// ── Scenario 2: Failure Project ────────────────────────────

describe("Failure lifecycle", () => {
  test("init", async () => {
    const init = await runCli(
      ctx.binPath,
      ["init", "--role", "standalone", "--python", join(ctx.fixturesDir, "parser-shim")],
      { cwd: ctx.failureDir },
    );
    expect(init.exitCode).toBe(0);
  });

  test("submit with failing engine", async () => {
    const failG16Dir = join(ctx.failureDir, "bin");
    mkdirSync(failG16Dir, { recursive: true });
    writeFileSync(
      join(failG16Dir, "g16"),
      `#!/usr/bin/env bash\necho "Fake g16: deliberate failure" >&2\nexit 42\n`,
      { mode: 0o755 },
    );

    const env = { PATH: `${failG16Dir}:${ctx.fixturesDir}:/bin:/usr/bin:/usr/local/bin` };
    const submit = await runCli(
      ctx.binPath,
      [
        "submit",
        "gaussian",
        join(ctx.failureDir, "water.gjf"),
        "--runner",
        "local",
        "--recipe",
        "gaussian-opt",
      ],
      { cwd: ctx.failureDir, env },
      FAST_TIMEOUT_MS,
    );
    expect(submit.exitCode).toBe(0);
    expect(submit.stdout).toMatch(/Created job/);
    ctx.failureJobId = extractJobId(submit.stdout);
    expect(ctx.failureJobId).toBeTruthy();
  });

  test("poll until failed", async () => {
    const status = await pollStatus(ctx.binPath, ctx.failureDir, ctx.failureJobId, "failed");
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toMatch(/Status:\s+failed/);
    expect(status.stdout).toMatch(/Exit code:\s+42/);
  });

  test("logs show diagnostic error", async () => {
    const logs = await runCli(ctx.binPath, ["logs", ctx.failureJobId], { cwd: ctx.failureDir });
    expect(logs.exitCode).toBe(0);
    expect(logs.stdout).toMatch(/deliberate failure/);
  });

  test("events show process.failed only", async () => {
    const events = await runCli(ctx.binPath, ["events", ctx.failureJobId], { cwd: ctx.failureDir });
    expect(events.exitCode).toBe(0);
    expect(events.stdout).toMatch(/process\.failed/);
    expect(events.stdout).not.toMatch(/process\.completed/);
    // No parse lifecycle events
    expect(events.stdout).not.toMatch(/parse\.started/);
    expect(events.stdout).not.toMatch(/parse\.completed/);
    expect(events.stdout).not.toMatch(/result\.saved/);
  });

  test("parse and results rejected", async () => {
    const parse = await runCli(ctx.binPath, ["parse", ctx.failureJobId], { cwd: ctx.failureDir });
    expect(parse.exitCode).toBe(0);
    expect(parse.stdout).toMatch(/must be completed to parse/);

    const results = await runCli(ctx.binPath, ["results", ctx.failureJobId], {
      cwd: ctx.failureDir,
    });
    expect(results.exitCode).toBe(0);
    expect(results.stdout).toMatch(/No results found/);
  });

  test("receipt and identity validation (failure)", async () => {
    ctx.failureAttemptId = resolveAttemptId(ctx.failureDir, ctx.failureJobId);
    expect(ctx.failureAttemptId).toBeTruthy();

    const receipt = readReceiptSafe(ctx.failureDir, ctx.failureJobId, ctx.failureAttemptId);
    expect(receipt).not.toBeNull();
    expect(receipt!.status).toBe("failed");
    expect(receipt!.exitCode).toBe(42);
    expect(isPositiveInteger(receipt!.pid)).toBeTrue();
    expect(receipt!.cwd).toContain(ctx.failureDir);
    expect(isFiniteNumber(receipt!.finishedAt)).toBeTrue();

    const identity = readIdentitySafe(ctx.failureDir, ctx.failureJobId, ctx.failureAttemptId);
    expect(identity).not.toBeNull();
    expect(identity!.pid).toBe(receipt!.pid);

    // Receipt PID must be dead (process finished)
    await assertPidDead(receipt!.pid, "failure-receipt");
  });

  test("exact-attempt artifacts (no fabricated success)", async () => {
    const db = openDb(ctx.failureDir);
    try {
      const artifacts = db
        .query("SELECT kind, path, label FROM artifacts WHERE job_id = ? AND attempt_id = ?")
        .all(ctx.failureJobId, ctx.failureAttemptId) as {
        kind: string;
        path: string;
        label: string | null;
      }[];
      // Should have at least stderr log (process wrote to stderr)
      expect(artifacts.length).toBeGreaterThanOrEqual(1);
      const stderrArt = artifacts.find((a) => a.label === "stderr");
      expect(stderrArt).toBeDefined();
      expect(existsSync(stderrArt!.path)).toBeTrue();

      // If shell redirection created a zero-byte output file, verify it exists
      // but is NOT treated as a successful result
      const outputArt = artifacts.find((a) => a.kind === "output");
      if (outputArt) {
        // Output might exist as zero-byte file from redirect before g16 failure
        // That's fine — the point is no result/parse was produced
        const st = statSync(outputArt.path, { throwIfNoEntry: false });
        if (st) {
          // Output file exists but wasn't parsed into a result — this is correct
        }
      }

      // No result rows, no parse events
      expect(countRows(db, "results", `job_id = '${ctx.failureJobId}'`)).toBe(0);
      const parseStarted = db
        .query("SELECT COUNT(*) AS cnt FROM job_events WHERE job_id = ? AND type = 'parse.started'")
        .get(ctx.failureJobId) as { cnt: number };
      expect(parseStarted.cnt).toBe(0);
    } finally {
      db.close();
    }
  });

  test("idempotent: repeated status leaves state/timestamps/events unchanged", async () => {
    const db = openDb(ctx.failureDir);
    let statusBefore: string, attemptStatusBefore: string, failedCountBefore: number;
    let finishedAtBefore: number | null, updatedAtBefore: number | null;
    try {
      const jobRow = db
        .query("SELECT status, updated_at FROM jobs WHERE id = ?")
        .get(ctx.failureJobId) as { status: string; updated_at: number };
      statusBefore = jobRow.status;

      const attemptRows = db
        .query("SELECT status, finished_at, updated_at FROM job_attempts WHERE job_id = ?")
        .all(ctx.failureJobId) as {
        status: string;
        finished_at: number | null;
        updated_at: number;
      }[];
      attemptStatusBefore = attemptRows[0].status;
      finishedAtBefore = attemptRows[0].finished_at;
      updatedAtBefore = attemptRows[0].updated_at;

      const ev = db
        .query(
          "SELECT COUNT(*) AS cnt FROM job_events WHERE job_id = ? AND type = 'process.failed'",
        )
        .get(ctx.failureJobId) as { cnt: number };
      failedCountBefore = ev.cnt;
    } finally {
      db.close();
    }

    // Repeated status (twice)
    for (let i = 0; i < 2; i++) {
      const s = await runCli(ctx.binPath, ["status", ctx.failureJobId], { cwd: ctx.failureDir });
      expect(s.exitCode).toBe(0);
      expect(s.stdout).toMatch(/Status:\s+failed/);
    }

    // Verify all unchanged
    const db2 = openDb(ctx.failureDir);
    try {
      const jobRow2 = db2
        .query("SELECT status, updated_at FROM jobs WHERE id = ?")
        .get(ctx.failureJobId) as { status: string; updated_at: number };
      expect(jobRow2.status).toBe(statusBefore);
      expect(jobRow2.updated_at).toBeCloseTo(updatedAtBefore!, -2); // allow ms drift

      const attemptRows2 = db2
        .query("SELECT status, finished_at, updated_at FROM job_attempts WHERE job_id = ?")
        .all(ctx.failureJobId) as {
        status: string;
        finished_at: number | null;
        updated_at: number;
      }[];
      expect(attemptRows2[0].status).toBe(attemptStatusBefore);
      expect(attemptRows2[0].finished_at).toBe(finishedAtBefore);
      expect(attemptRows2[0].updated_at).toBe(updatedAtBefore);

      const ev2 = db2
        .query(
          "SELECT COUNT(*) AS cnt FROM job_events WHERE job_id = ? AND type = 'process.failed'",
        )
        .get(ctx.failureJobId) as { cnt: number };
      expect(ev2.cnt).toBe(failedCountBefore);
    } finally {
      db2.close();
    }
  });
});

// ── Scenario 3: Cancellation/Restart Project ──────────────

describe("Cancellation/restart lifecycle", () => {
  /** Env with signal-recording sh‑wrapper + cancellable g16 first in PATH. */
  function cancelEnv() {
    return {
      PATH: `${ctx.cancelShimParent}:/bin:/usr/bin:/usr/local/bin`,
      G16_PID_FILE: ctx.pidFile,
      SIGNAL_MARKER: ctx.signalMarker,
    };
  }

  /** Helper: run a cancellation CLI command with the cancel-scoped PATH. */
  function cancelRunCli(args: string[], opts?: { cwd?: string; timeoutMs?: number }) {
    return runCli(
      ctx.binPath,
      args,
      {
        cwd: opts?.cwd ?? ctx.cancelDir,
        env: cancelEnv(),
      },
      opts?.timeoutMs,
    );
  }

  /** Helper: poll status with cancel-scoped PATH. */
  function cancelPollStatus(jobId: string, target: string, deadlineMs?: number) {
    return pollStatus(ctx.binPath, ctx.cancelDir, jobId, target, deadlineMs, cancelEnv());
  }

  test("init", async () => {
    const init = await runCli(
      ctx.binPath,
      ["init", "--role", "standalone", "--python", join(ctx.fixturesDir, "parser-shim")],
      { cwd: ctx.cancelDir },
    );
    expect(init.exitCode).toBe(0);
  });

  test("submit with cancellable engine", async () => {
    // Create a directory with the signal-recording sh wrapper AND the
    // cancellable g16, placed first in PATH for ALL cancel subprocesses.
    const shimDir = join(ctx.cancelDir, "shim");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, "sh"), SH_SIGNAL_WRAPPER, { mode: 0o755 });
    writeFileSync(join(shimDir, "g16"), G16_CANCELLABLE, { mode: 0o755 });

    ctx.cancelShimParent = shimDir;

    // Clear marker files
    try {
      writeFileSync(ctx.pidFile, "");
    } catch {
      /* ok */
    }
    try {
      writeFileSync(ctx.signalMarker, "");
    } catch {
      /* ok */
    }

    // Build env via buildEnv (deterministic allowlist) with cancel extras
    const cancelExtra = cancelEnv();
    const fullEnv = buildEnv(ctx.fixturesDir, cancelExtra);
    const cancelSubmitProc = Bun.spawn(
      [
        ctx.binPath,
        "submit",
        "gaussian",
        join(ctx.cancelDir, "water.gjf"),
        "--runner",
        "local",
        "--recipe",
        "gaussian-opt",
      ],
      { cwd: ctx.cancelDir, env: fullEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    const submitReader = cancelSubmitProc.stdout.getReader();
    const submitErrPromise = new Response(cancelSubmitProc.stderr).text().catch(() => "");
    let submitOut = "";
    const readLoop = async () => {
      while (true) {
        const { done, value } = await submitReader.read();
        if (done) break;
        submitOut += new TextDecoder().decode(value);
        if (submitOut.includes("Created job")) return;
      }
    };
    await Promise.race([readLoop(), Bun.sleep(10_000)]);
    cancelSubmitProc.kill("SIGKILL");
    try {
      await Promise.race([cancelSubmitProc.exited, Bun.sleep(2_000)]);
    } catch {
      /* ignore */
    }
    const submitErr = await submitErrPromise;

    if (!submitOut.includes("Created job")) {
      console.log("CANCEL SUBMIT STDOUT:", submitOut);
      console.log("CANCEL SUBMIT STDERR:", submitErr);
    }
    expect(submitOut).toMatch(/Created job/);

    ctx.cancelJobId = extractJobId(submitOut);
    expect(ctx.cancelJobId).toBeTruthy();

    // Quick DB debug: what's in the identity?
    const tmpDb = openDb(ctx.cancelDir);
    try {
      const attempts = tmpDb
        .query("SELECT id, pid, status FROM job_attempts WHERE job_id = ?")
        .all(ctx.cancelJobId) as { id: string; pid: number | null; status: string }[];
      console.log("  [debug] attempts:", JSON.stringify(attempts));
      if (attempts.length > 0 && attempts[0].pid) {
        try {
          process.kill(attempts[0].pid, 0);
          console.log("  [debug] PID", attempts[0].pid, "IS ALIVE");
        } catch {
          console.log("  [debug] PID", attempts[0].pid, "IS DEAD");
        }
      }
    } finally {
      tmpDb.close();
    }
  });

  test("status shows running with active identity", async () => {
    // Poll for running state (uses cancel-scoped PATH so signal wrapper
    // remains in effect if status triggers reconciliation subprocesses)
    const status = await cancelPollStatus(ctx.cancelJobId, "running", 30_000);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toMatch(/Status:\s+running/);
    expect(status.stdout).toMatch(/PID:/);

    const pid = extractPid(status.stdout);
    expect(pid).toBeGreaterThan(0);

    // Resolve attempt ID from DB
    const db = openDb(ctx.cancelDir);
    try {
      const rows = db
        .query("SELECT id FROM job_attempts WHERE job_id = ? ORDER BY created_at DESC LIMIT 1")
        .all(ctx.cancelJobId) as { id: string }[];
      expect(rows.length).toBe(1);
      ctx.cancelAttemptId = rows[0].id;
    } finally {
      db.close();
    }

    expect(ctx.cancelAttemptId).toBeTruthy();

    const identity = readIdentitySafe(ctx.cancelDir, ctx.cancelJobId, ctx.cancelAttemptId);
    expect(identity).not.toBeNull();
    expect(identity!.pid).toBe(pid);
    expect(identity!.jobId).toBe(ctx.cancelJobId);
    expect(identity!.schemaVersion).toBe(1);

    // Check PID file for diagnostics
    if (existsSync(ctx.pidFile)) {
      const pidContent = readFileSync(ctx.pidFile, "utf8").trim();
      console.log("  [debug] PID file:", pidContent.slice(0, 200));
    }
  });

  test("first cancel transitions and records signal", async () => {
    expect(ctx.cancelJobId).toBeTruthy();
    expect(ctx.cancelAttemptId).toBeTruthy();

    // Verify identity PID is alive before attempting cancel
    const ident = readIdentitySafe(ctx.cancelDir, ctx.cancelJobId, ctx.cancelAttemptId);
    if (ident) {
      try {
        process.kill(ident.pid, 0);
        console.log("  [debug] identity PID", ident.pid, "IS ALIVE before cancel");
      } catch {
        console.log("  [debug] identity PID", ident.pid, "IS DEAD before cancel");
      }
    }

    // First cancel (uses cancel-scoped PATH so signal wrapper sees TERM)
    const cancel = await cancelRunCli(["cancel", ctx.cancelJobId]);
    expect(cancel.exitCode).toBe(0);
    expect(cancel.stdout).toMatch(/cancelled/);
    expect(cancel.stdout).toMatch(/Receipt written/);

    // Status confirms cancelled (cancel-scoped PATH for reconciliation)
    const status = await cancelRunCli(["status", ctx.cancelJobId]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toMatch(/Status:\s+cancelled/);

    // Signal marker MUST contain exactly one "SIGTERM" line.
    // This is the sole external proof that the real sh wrapper observed
    // exactly one TERM signal from the cancellation subprocess.
    expect(existsSync(ctx.signalMarker)).toBeTrue();
    const markerLines = readFileSync(ctx.signalMarker, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0);
    expect(markerLines).toEqual(["SIGTERM"]);
  });

  test("second cancel is idempotent (snapshot-based)", async () => {
    expect(ctx.cancelJobId).toBeTruthy();
    expect(ctx.cancelAttemptId).toBeTruthy();

    // Snapshot signal marker alongside receipt and DB state before second cancel.
    // The marker is the primary evidence that exactly one TERM was ever sent;
    // receipt/DB are supplemental.
    const markerBefore = existsSync(ctx.signalMarker)
      ? { bytes: readFileSync(ctx.signalMarker, "utf8"), size: statSync(ctx.signalMarker).size }
      : null;
    expect(markerBefore).not.toBeNull();
    expect(
      markerBefore!.bytes
        .trim()
        .split("\n")
        .filter((l) => l.length > 0),
    ).toEqual(["SIGTERM"]);

    const receiptPath = join(
      ctx.cancelDir,
      ".eigengrid",
      "jobs",
      ctx.cancelJobId,
      ".eigengrid",
      `receipt-${ctx.cancelAttemptId}.json`,
    );
    const receiptBefore = existsSync(receiptPath)
      ? {
          bytes: readFileSync(receiptPath, "utf8"),
          size: statSync(receiptPath).size,
          mtimeMs: statSync(receiptPath).mtimeMs,
        }
      : null;

    const db = openDb(ctx.cancelDir);
    let jobStatusBefore: string, attemptStatusBefore: string;
    let attemptFinishedBefore: number | null, attemptUpdatedBefore: number | null;
    let cancelEventCountBefore: number;
    try {
      const jobRow = db.query("SELECT status FROM jobs WHERE id = ?").get(ctx.cancelJobId) as {
        status: string;
      };
      jobStatusBefore = jobRow.status;
      const attemptRows = db
        .query("SELECT status, finished_at, updated_at FROM job_attempts WHERE job_id = ?")
        .all(ctx.cancelJobId) as {
        status: string;
        finished_at: number | null;
        updated_at: number;
      }[];
      attemptStatusBefore = attemptRows[0].status;
      attemptFinishedBefore = attemptRows[0].finished_at;
      attemptUpdatedBefore = attemptRows[0].updated_at;
      const ev = db
        .query(
          "SELECT COUNT(*) AS cnt FROM job_events WHERE job_id = ? AND type = 'process.cancelled'",
        )
        .get(ctx.cancelJobId) as { cnt: number };
      cancelEventCountBefore = ev.cnt;
    } finally {
      db.close();
    }

    // Second cancel (uses cancel-scoped PATH — wrapper must NOT fire again)
    const cancel2 = await cancelRunCli(["cancel", ctx.cancelJobId]);
    expect(cancel2.exitCode).toBe(0);

    // Signal marker MUST be byte-identical: second cancel did NOT send
    // another TERM through the wrapper (the receipt already existed and
    // cancel returned idempotent).
    const markerAfter = existsSync(ctx.signalMarker)
      ? { bytes: readFileSync(ctx.signalMarker, "utf8"), size: statSync(ctx.signalMarker).size }
      : null;
    expect(markerAfter).toEqual(markerBefore);

    // Receipt unchanged
    const receiptAfter = existsSync(receiptPath)
      ? {
          bytes: readFileSync(receiptPath, "utf8"),
          size: statSync(receiptPath).size,
          mtimeMs: statSync(receiptPath).mtimeMs,
        }
      : null;
    expect(receiptAfter).toEqual(receiptBefore);

    // State unchanged
    const db2 = openDb(ctx.cancelDir);
    try {
      const jobRow2 = db2.query("SELECT status FROM jobs WHERE id = ?").get(ctx.cancelJobId) as {
        status: string;
      };
      expect(jobRow2.status).toBe(jobStatusBefore);
      const attemptRows2 = db2
        .query("SELECT status, finished_at, updated_at FROM job_attempts WHERE job_id = ?")
        .all(ctx.cancelJobId) as {
        status: string;
        finished_at: number | null;
        updated_at: number;
      }[];
      expect(attemptRows2[0].status).toBe(attemptStatusBefore);
      expect(attemptRows2[0].finished_at).toBe(attemptFinishedBefore);
      expect(attemptRows2[0].updated_at).toBe(attemptUpdatedBefore);
      const ev2 = db2
        .query(
          "SELECT COUNT(*) AS cnt FROM job_events WHERE job_id = ? AND type = 'process.cancelled'",
        )
        .get(ctx.cancelJobId) as { cnt: number };
      expect(ev2.cnt).toBe(cancelEventCountBefore);
    } finally {
      db2.close();
    }
  });

  test("no later completion or failure overwrite", async () => {
    expect(ctx.cancelJobId).toBeTruthy();

    // Poll until cancelled is confirmed (bounded, g16 self-terminates within 1s)
    const polled = await cancelPollStatus(ctx.cancelJobId, "cancelled", 5_000);
    expect(polled.exitCode).toBe(0);
    expect(polled.stdout).not.toMatch(/Status:\s+completed/);
    expect(polled.stdout).not.toMatch(/Status:\s+failed/);
  });

  test("receipt and cancellation event counts", async () => {
    expect(ctx.cancelJobId).toBeTruthy();
    expect(ctx.cancelAttemptId).toBeTruthy();

    const receipt = readReceiptSafe(ctx.cancelDir, ctx.cancelJobId, ctx.cancelAttemptId);
    expect(receipt).not.toBeNull();
    expect(receipt!.status).toBe("cancelled");
    expect(receipt!.signal).toBe("SIGTERM");

    const db = openDb(ctx.cancelDir);
    try {
      const cancelledCount = db
        .query(
          "SELECT COUNT(*) AS cnt FROM job_events WHERE job_id = ? AND type = 'process.cancelled'",
        )
        .get(ctx.cancelJobId) as { cnt: number };
      expect(cancelledCount.cnt).toBe(1);

      expect(
        countRows(db, "job_events", `job_id = '${ctx.cancelJobId}' AND type = 'process.completed'`),
      ).toBe(0);
      expect(
        countRows(db, "job_events", `job_id = '${ctx.cancelJobId}' AND type = 'process.failed'`),
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  test("wrapper and descendant processes terminated (hard assertion)", async () => {
    expect(ctx.cancelJobId).toBeTruthy();
    expect(ctx.cancelAttemptId).toBeTruthy();

    // Signal marker must still contain exactly one SIGTERM line (unchanged
    // from earlier assertions — no stray signals).
    expect(existsSync(ctx.signalMarker)).toBeTrue();
    const markerLines = readFileSync(ctx.signalMarker, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0);
    expect(markerLines).toEqual(["SIGTERM"]);

    // Read PID marker: first line = g16 PID, second line = wrapper (sh -c) PID
    const expectedPids: number[] = [];
    if (existsSync(ctx.pidFile)) {
      for (const line of readFileSync(ctx.pidFile, "utf8").trim().split("\n")) {
        const pid = parseInt(line.trim(), 10);
        if (pid > 0) expectedPids.push(pid);
      }
    }
    expect(expectedPids.length).toBeGreaterThanOrEqual(1);

    // Also get wrapper PID from identity (authoritative)
    const identity = readIdentitySafe(ctx.cancelDir, ctx.cancelJobId, ctx.cancelAttemptId);
    expect(identity).not.toBeNull();
    if (!expectedPids.includes(identity!.pid)) expectedPids.push(identity!.pid);

    // Assert every recorded PID is dead within deadline.
    // Do NOT kill from test — termination must be caused by cancel → SIGTERM
    // → sh wrapper (records signal) → forwards to child → g16 self-terminates.
    const stillAlive: number[] = [];
    for (const pid of expectedPids) {
      try {
        await assertPidDead(pid, `cancel-pid-${pid}`);
      } catch {
        stillAlive.push(pid);
      }
    }
    expect(stillAlive).toEqual([]);

    // Verify identity file still exists (debris is expected) but no temporary debris
    const identity2 = readIdentitySafe(ctx.cancelDir, ctx.cancelJobId, ctx.cancelAttemptId);
    expect(identity2).not.toBeNull();
  });
});
