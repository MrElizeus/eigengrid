// ────────────────────────────────────────────────────────────
// LocalRunner — local process execution with identity/
// receipt persistence for context-independent lifecycle.
// ────────────────────────────────────────────────────────────
// Uses an injectable ProcessSupervisor to write active identity
// before start and a durable terminal receipt after completion.
// The receipt survives the originating CLI/context exiting,
// enabling a new context to safely reconcile/cancel/collect.
// ────────────────────────────────────────────────────────────

import type {
  Artifact,
  Job,
  JobAttempt,
  RemoteProcessStatus,
  RunnerResult,
  StartedProcess,
} from "@eigengrid/core";
import type { EigenGridEventBase } from "@eigengrid/events";
import type { Runner } from "./runner";
import { basename, delimiter, isAbsolute, join, resolve, sep } from "path";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "fs";
import { generateId } from "@eigengrid/core";
import { DEFAULT_TIMEOUT_MS, type SpawnHandle, type RunOptions } from "./process-utils";
import { type CommandExecutor, DefaultCommandExecutor } from "./executor";
import { quotePosixShellWord } from "./wrapper";
import { writeReceipt, readReceipt } from "./local-receipt";
import type { LocalReceipt, LocalReceiptV1 } from "./local-receipt";
import {
  writeActiveIdentity,
  readActiveIdentity,
  verifyActiveIdentity,
  LinuxProcTokenReader,
} from "./local-identity";
import type {
  LocalActiveIdentity,
  LocalActiveIdentityV1,
  ProcessStartTokenReader,
  IdentityVerification,
} from "./local-identity";
import {
  buildDurableSupervisorInvocation,
  readDurableExitStatus,
} from "./durable-local-supervisor";
import { atomicCopyRunnerFile, atomicWriteRunnerFile } from "./safe-path";

// ────────────────────────────────────────────────────────────
// ProcessSupervisor — injectable boundary for identity/receipt
// ────────────────────────────────────────────────────────────
// Separates the IO of writing identity files and terminal
// receipts from the runner's process tracking. Real impl uses
// local-identity.ts / local-receipt.ts; tests inject a fake.

export interface ProcessSupervisor {
  /** Write active identity BEFORE the process is considered started. */
  writeActiveIdentity(
    jobDir: string,
    attemptId: string,
    identity: LocalActiveIdentityV1,
    tokenReader?: ProcessStartTokenReader,
  ): void;

  /** Write terminal receipt after the process completes. */
  writeTerminalReceipt(jobDir: string, attemptId: string, receipt: LocalReceiptV1): void;

  /** Read and verify a receipt with identity match. */
  readReceipt(
    jobDir: string,
    attemptId: string,
    match?: { jobId?: string; attemptId?: string; cwd?: string },
  ): LocalReceipt | null;

  /** Verify active identity against live process. */
  verifyActiveIdentity(jobDir: string, attemptId: string): IdentityVerification;

  /** Read active identity (null if absent/malformed). */
  readActiveIdentity(jobDir: string, attemptId: string): LocalActiveIdentity | null;
}

export class DefaultProcessSupervisor implements ProcessSupervisor {
  writeActiveIdentity(jobDir: string, attemptId: string, identity: LocalActiveIdentityV1): void {
    writeActiveIdentity(jobDir, attemptId, identity);
  }

  writeTerminalReceipt(jobDir: string, attemptId: string, receipt: LocalReceiptV1): void {
    writeReceipt(jobDir, attemptId, receipt);
  }

  readReceipt(
    jobDir: string,
    attemptId: string,
    match?: { jobId?: string; attemptId?: string; cwd?: string },
  ): LocalReceipt | null {
    return readReceipt(jobDir, attemptId, match);
  }

  verifyActiveIdentity(jobDir: string, attemptId: string): IdentityVerification {
    return verifyActiveIdentity(jobDir, attemptId);
  }

  readActiveIdentity(jobDir: string, attemptId: string): LocalActiveIdentity | null {
    return readActiveIdentity(jobDir, attemptId);
  }
}

// ────────────────────────────────────────────────────────────
// Database Interface
// ────────────────────────────────────────────────────────────

interface LocalTerminalAttemptEvidence {
  jobId: string;
  attemptId: string;
  status: "completed" | "failed" | "cancelled";
  exitCode?: number;
  finishedAt: number;
  source: EigenGridEventBase["source"];
  payload?: Record<string, unknown>;
}

interface LocalRunnerDatabase {
  createJobAttempt(attempt: {
    id: string;
    jobId: string;
    runner: "local";
    command: string;
    cwd: string;
    status?: JobAttempt["status"];
    pid?: number;
    exitCode?: number;
    startedAt?: number;
    finishedAt?: number;
  }): Promise<void>;
  updateJobStatus(jobId: string, status: Job["status"]): Promise<void>;
  updateJobAttemptStatus(
    attemptId: string,
    status: JobAttempt["status"],
    updates?: {
      pid?: number;
      startedAt?: number;
      exitCode?: number;
      finishedAt?: number;
    },
  ): Promise<void>;
  listJobAttempts(jobId?: string): Promise<JobAttempt[]>;
  createArtifact(artifact: Omit<Artifact, "createdAt">): Promise<void>;
  createArtifactIfAbsent(artifact: Omit<Artifact, "createdAt">): Promise<boolean>;
  listArtifacts(jobId?: string): Promise<Artifact[]>;
  materializeTerminalAttempt(evidence: LocalTerminalAttemptEvidence): Promise<void>;
  appendEvent?: (event: EigenGridEventBase) => Promise<void>;
}

// ────────────────────────────────────────────────────────────
// Engine & Options
// ────────────────────────────────────────────────────────────

interface LocalRunnerEngine {
  command: string;
  args?: string[];
  displayCommand?: string;
}

export interface LocalRunnerOptions {
  database?: LocalRunnerDatabase;
  engines?: Record<string, LocalRunnerEngine>;
  defaultRunOptions?: RunOptions;
  maxWallTime?: number;
  /** Required legacy UID switch when configured; not an OS sandbox by itself. */
  sandboxUser?: string;
  executor?: CommandExecutor;
  /** Injectable supervisor for identity/receipt persistence. */
  supervisor?: ProcessSupervisor;
  /** Injectable process-start token reader (default: LinuxProcTokenReader). */
  tokenReader?: ProcessStartTokenReader;
  /** Persist terminal status from a detached trusted wrapper, not the launcher. */
  durableCompletion?: boolean;
  /** Host-owned command transformation applied before the durable supervisor. */
  isolateCommand?: (
    command: string,
    args: string[],
    cwd: string,
  ) => { command: string; args: string[] };
  /** Maximum wait for confirmed process-tree termination during local cleanup. */
  cancellationConfirmationTimeoutMs?: number;
}

// ────────────────────────────────────────────────────────────
// Tracked Process
// ────────────────────────────────────────────────────────────

interface TrackedProcess {
  handle: SpawnHandle;
  attemptId: string;
  jobDir: string;
  stdoutPath: string;
  stderrPath: string;
  settled: boolean;
  startedAt: number;
}

function assertSafeJobId(jobId: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(jobId)) {
    throw new Error(`Unsafe job identifier for local execution: ${jobId}`);
  }
}

function ensurePrivateJobDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Local job directory is not a real directory: ${path}`);
  }
  chmodSync(path, 0o700);
}

function assertSafeFileTarget(path: string, label: string): void {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Local ${label} is not a regular file: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}

function resolveExecutablePath(
  command: string,
  cwd: string,
  env: Record<string, string> | undefined,
): string | null {
  const candidates = command.includes("/")
    ? [resolve(cwd, command)]
    : (env?.PATH ?? process.env.PATH ?? "")
        .split(delimiter)
        .map((directory) => resolve(cwd, directory || ".", command));

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue searching PATH. The eventual failure is materialized below.
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────
// LocalRunner
// ────────────────────────────────────────────────────────────

export class LocalRunner implements Runner {
  readonly kind = "local" as const;
  private processes = new Map<string, TrackedProcess>();

  constructor(private readonly options: LocalRunnerOptions = {}) {}

  private get db(): LocalRunnerDatabase {
    if (!this.options.database) {
      throw new Error("LocalRunner requires a database instance");
    }
    return this.options.database;
  }

  private get executor(): CommandExecutor {
    return this.options.executor ?? new DefaultCommandExecutor();
  }

  private get supervisor(): ProcessSupervisor {
    return this.options.supervisor ?? new DefaultProcessSupervisor();
  }

  private get tokenReader(): ProcessStartTokenReader {
    return this.options.tokenReader ?? new LinuxProcTokenReader();
  }

  private getEngine(job: Job): LocalRunnerEngine {
    const engine = this.options.engines?.[job.software];
    if (!engine) {
      throw new Error(`No local engine configured for ${job.software}`);
    }
    return engine;
  }

  private async emitRunnerEvent(
    event: Omit<EigenGridEventBase, "id" | "at" | "source">,
  ): Promise<void> {
    if (!this.db.appendEvent) return;
    const fullEvent: EigenGridEventBase = {
      id: generateId("evt"),
      at: Date.now(),
      source: "runner",
      ...event,
    };
    await this.db.appendEvent(fullEvent);
  }

  private jobDir(job: Job): string {
    assertSafeJobId(job.id);
    return join(job.workdir, job.id);
  }

  private stagedInputPath(job: Job): string {
    return join(this.jobDir(job), basename(job.inputPath));
  }

  private resolvePath(jobDir: string, pathValue: string): string {
    const resolvedPath = resolve(isAbsolute(pathValue) ? pathValue : join(jobDir, pathValue));
    const resolvedJobDir = resolve(jobDir);
    if (resolvedPath !== resolvedJobDir && !resolvedPath.startsWith(`${resolvedJobDir}${sep}`)) {
      throw new Error(`Output path escapes the job directory: ${pathValue}`);
    }
    return resolvedPath;
  }

  // ── Artifact Helpers ────────────────────────────────────

  private async registerArtifactOnce(artifact: Omit<Artifact, "createdAt">): Promise<boolean> {
    const canonPath = resolve(artifact.path);
    return this.db.createArtifactIfAbsent({ ...artifact, path: canonPath });
  }

  private async writeLogArtifacts(
    jobId: string,
    record: Pick<TrackedProcess, "attemptId" | "stdoutPath" | "stderrPath">,
    stdout: string,
    stderr: string,
  ): Promise<void> {
    assertSafeFileTarget(record.stdoutPath, "stdout target");
    assertSafeFileTarget(record.stderrPath, "stderr target");
    atomicWriteRunnerFile(record.stdoutPath, stdout);
    atomicWriteRunnerFile(record.stderrPath, stderr);

    await this.registerArtifactOnce({
      id: generateId("artifact"),
      jobId,
      attemptId: record.attemptId,
      kind: "log",
      path: record.stdoutPath,
      label: "stdout",
      mimeType: "text/plain",
      sizeBytes: statSync(record.stdoutPath).size,
    });

    await this.registerArtifactOnce({
      id: generateId("artifact"),
      jobId,
      attemptId: record.attemptId,
      kind: "log",
      path: record.stderrPath,
      label: "stderr",
      mimeType: "text/plain",
      sizeBytes: statSync(record.stderrPath).size,
    });
  }

  private async registerOutputArtifact(
    job: Job,
    record: Pick<TrackedProcess, "attemptId" | "jobDir">,
  ): Promise<void> {
    if (!job.outputPath) return;
    const outputPath = this.resolvePath(record.jobDir, job.outputPath);
    if (!existsSync(outputPath)) return;
    assertSafeFileTarget(outputPath, "output artifact");
    await this.registerArtifactOnce({
      id: generateId("artifact"),
      jobId: job.id,
      attemptId: record.attemptId,
      kind: "output",
      path: outputPath,
      mimeType: "text/plain",
      sizeBytes: statSync(outputPath).size,
    });
  }

  /**
   * Materialize the database evidence derived from an authoritative terminal
   * receipt. The detached durable supervisor can outlive the CLI process, so
   * this work must also be available to a later reconciliation context.
   *
   * Every operation is idempotent: artifacts are deduplicated by their exact
   * attempt/path identity and the terminal event is appended only when the
   * durable event log does not already contain it.
   */
  private async materializeTerminalEvidence(
    job: Job,
    attempt: JobAttempt,
    receipt: LocalReceipt,
  ): Promise<void> {
    await this.collectAttempt(job, attempt.id, { requiredOutput: false });

    const evidence: LocalTerminalAttemptEvidence = {
      jobId: job.id,
      attemptId: attempt.id,
      status: receipt.status,
      exitCode: receipt.exitCode ?? undefined,
      finishedAt: receipt.finishedAt,
      source: "runner",
      payload:
        receipt.status === "cancelled"
          ? { pid: receipt.pid, signal: receipt.signal ?? "SIGTERM" }
          : {
              pid: receipt.pid,
              exitCode: receipt.exitCode ?? 1,
              durationMs: attempt.startedAt
                ? Math.max(0, receipt.finishedAt - attempt.startedAt)
                : undefined,
            },
    };
    await this.persistTerminalAttempt(evidence);
  }

  private async persistTerminalAttempt(evidence: LocalTerminalAttemptEvidence): Promise<void> {
    await this.db.materializeTerminalAttempt(evidence);
  }

  // ── Lifecycle Finalization ──────────────────────────────
  // Writes a durable terminal receipt + DB state + events.
  // The receipt survives the originating context, enabling a
  // new process to recover the outcome.

  private async finalizeAttempt(
    job: Job,
    record: TrackedProcess,
    result: { exitCode: number | undefined; stdout: string; stderr: string },
  ): Promise<void> {
    if (record.settled) return;
    record.settled = true;

    const stdout =
      this.options.durableCompletion && existsSync(record.stdoutPath)
        ? readFileSync(record.stdoutPath, "utf8")
        : result.stdout;
    const stderr =
      this.options.durableCompletion && existsSync(record.stderrPath)
        ? readFileSync(record.stderrPath, "utf8")
        : result.stderr;
    await this.writeLogArtifacts(job.id, record, stdout, stderr);
    await this.registerOutputArtifact(job, record);

    const exitCode = result.exitCode ?? 1;
    const now = Date.now();
    const status = exitCode === 0 ? "completed" : "failed";

    // Write durable terminal receipt (survives context exit)
    const receipt: LocalReceiptV1 = {
      schemaVersion: 1,
      jobId: job.id,
      attemptId: record.attemptId,
      pid: record.handle.pid ?? 0,
      command: "",
      args: [],
      cwd: record.jobDir,
      exitCode,
      signal: null,
      finishedAt: now,
      status,
    };
    try {
      this.supervisor.writeTerminalReceipt(record.jobDir, record.attemptId, receipt);
    } catch {
      // Non-fatal if receipt write fails — state is still persisted in DB
    }

    await this.persistTerminalAttempt({
      jobId: job.id,
      attemptId: record.attemptId,
      status,
      exitCode,
      finishedAt: now,
      source: "runner",
      payload: {
        pid: record.handle.pid ?? null,
        exitCode,
        durationMs: now - record.startedAt,
      },
    });
  }

  private async finalizeSpawnError(
    job: Job,
    record: Pick<TrackedProcess, "attemptId" | "stdoutPath" | "stderrPath">,
    error: Error & { code?: string },
  ): Promise<void> {
    const now = Date.now();
    await this.writeLogArtifacts(job.id, record, "", `${error.message}\n`);

    const exitCode = error.code === "ENOENT" ? 127 : 1;

    // Write receipt for spawn errors too
    const receipt: LocalReceiptV1 = {
      schemaVersion: 1,
      jobId: job.id,
      attemptId: record.attemptId,
      pid: 0,
      command: "",
      args: [],
      cwd: "",
      exitCode,
      signal: null,
      finishedAt: now,
      status: "failed",
    };
    try {
      this.supervisor.writeTerminalReceipt(join(job.workdir, job.id), record.attemptId, receipt);
    } catch {
      /* best-effort */
    }

    await this.persistTerminalAttempt({
      jobId: job.id,
      attemptId: record.attemptId,
      status: "failed",
      exitCode,
      finishedAt: now,
      source: "runner",
      payload: { pid: null, exitCode, error: error.message },
    });
  }

  // ── Required Restricted-User Execution ──────────────────

  private async shouldUseRestrictedUser(): Promise<boolean> {
    const user = this.options.sandboxUser;
    if (user === undefined) return false;
    if (typeof user !== "string" || user.length === 0 || user !== user.trim())
      throw new Error(
        "Required restricted-user execution has an invalid Linux account; refusing current-user fallback",
      );
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    if (!isRoot)
      throw new Error(
        "Required restricted-user execution cannot be established without root; refusing current-user fallback",
      );
    try {
      const result = await this.executor.run("/usr/bin/id", ["-u", "--", user], { timeout: 5_000 });
      if (result.exitCode !== 0 || !/^[1-9][0-9]*$/.test(result.stdout.trim()))
        throw new Error("Restricted account is unavailable or has root privileges");
      return true;
    } catch {
      throw new Error(
        "Required restricted-user execution could not verify a non-root account; refusing current-user fallback",
      );
    }
  }

  // ── Attempt Lifecycle ───────────────────────────────────

  private async ensureAttempt(job: Job): Promise<JobAttempt> {
    const attempts = await this.db.listJobAttempts(job.id);
    if (attempts.length > 0) return attempts[attempts.length - 1];
    await this.stage(job);
    const stagedAttempts = await this.db.listJobAttempts(job.id);
    const attempt = stagedAttempts[stagedAttempts.length - 1];
    if (!attempt) throw new Error(`Failed to create a local attempt for job ${job.id}`);
    return attempt;
  }

  // ── Coordinator-Driven Explicit-Attempt Methods ─────────

  async stageAttempt(job: Job, attemptId: string): Promise<RunnerResult> {
    const jobDir = this.jobDir(job);
    ensurePrivateJobDirectory(jobDir);

    await this.db.updateJobStatus(job.id, "queued");
    await this.db.updateJobAttemptStatus(attemptId, "queued");

    const stagedInput = this.stagedInputPath(job);
    assertSafeFileTarget(stagedInput, "staged input target");
    atomicCopyRunnerFile(job.inputPath, stagedInput);

    await this.registerArtifactOnce({
      id: generateId("artifact"),
      jobId: job.id,
      attemptId,
      kind: "input",
      path: stagedInput,
      mimeType: "text/plain",
      sizeBytes: statSync(stagedInput).size,
    });

    await this.db.updateJobAttemptStatus(attemptId, "staged");
    await this.db.updateJobStatus(job.id, "staged");

    return {
      ok: true,
      message: `Staged ${job.name} in ${jobDir}`,
      metadata: { attemptId, cwd: jobDir, inputPath: stagedInput },
    };
  }

  async startAttempt(job: Job, attemptId: string): Promise<StartedProcess> {
    const engine = this.getEngine(job);
    const jobDir = this.jobDir(job);
    ensurePrivateJobDirectory(jobDir);
    const stdoutPath = join(jobDir, "stdout.log");
    const stderrPath = join(jobDir, "stderr.log");
    assertSafeFileTarget(stdoutPath, "stdout target");
    assertSafeFileTarget(stderrPath, "stderr target");

    const restrictedUser = await this.shouldUseRestrictedUser();
    let cmd: string;
    let cmdArgs: string[];
    if (restrictedUser) {
      const cmdStr = [engine.command, ...(engine.args ?? [])].map(quotePosixShellWord).join(" ");
      cmd = "su";
      cmdArgs = ["-", this.options.sandboxUser!, "-c", cmdStr];
    } else {
      cmd = engine.command;
      cmdArgs = engine.args ?? [];
    }

    const runOpts: RunOptions = {
      ...this.options.defaultRunOptions,
      cwd: jobDir,
    };
    if (this.options.maxWallTime != null) {
      runOpts.timeout = this.options.maxWallTime;
    }

    if (this.options.isolateCommand) {
      const isolated = this.options.isolateCommand(cmd, cmdArgs, jobDir);
      cmd = isolated.command;
      cmdArgs = isolated.args;
    }
    if (this.options.durableCompletion) {
      // The durable wrapper itself is always /bin/sh, so spawning it cannot
      // report an unavailable engine. Resolve the trusted recipe executable
      // before launching the wrapper to preserve confirmed-start semantics.
      const resolvedCommand = resolveExecutablePath(cmd, runOpts.cwd ?? process.cwd(), runOpts.env);
      if (!resolvedCommand) {
        const error = Object.assign(new Error(`Executable not found: ${cmd}`), {
          code: "ENOENT",
        });
        await this.finalizeSpawnError(job, { attemptId, stdoutPath, stderrPath }, error);
        return { ok: false, message: error.message };
      }

      const invocation = buildDurableSupervisorInvocation({
        jobDir,
        attemptId,
        stdoutPath,
        stderrPath,
        command: resolvedCommand,
        args: cmdArgs,
        timeoutMs: runOpts.timeout ?? DEFAULT_TIMEOUT_MS,
      });
      cmd = invocation.command;
      cmdArgs = invocation.args;
      runOpts.detached = true;
      runOpts.stdio = "ignore";
      runOpts.unref = true;
      // The detached wrapper owns the durable timeout after launcher exit.
      runOpts.disableTimeout = true;
      delete runOpts.timeout;
    }

    // ── Spawn ─────────────────────────────────────────────
    let handle: SpawnHandle;
    try {
      handle = this.executor.spawn(cmd, cmdArgs, runOpts);
    } catch (error) {
      const spawnError = error instanceof Error ? error : new Error(String(error));
      await this.finalizeSpawnError(
        job,
        { attemptId, stdoutPath, stderrPath },
        spawnError as Error & { code?: string },
      );
      return { ok: false, message: spawnError.message };
    }

    const now = Date.now();
    const record: TrackedProcess = {
      handle,
      attemptId,
      jobDir,
      stdoutPath,
      stderrPath,
      settled: false,
      startedAt: now,
    };

    const hasValidPid = handle.pid !== undefined && Number.isInteger(handle.pid) && handle.pid >= 1;
    let processStartToken: string | undefined;
    let handleSettled = false;
    void handle.result.then(
      () => {
        handleSettled = true;
      },
      () => {
        // A rejected result still means the exact spawned handle settled.
        handleSettled = true;
      },
    );

    const spawnedProcessIsConfirmedDead = (): boolean => {
      if (handleSettled) return true;
      if (!hasValidPid || handle.pid === undefined) return false;

      try {
        process.kill(handle.pid, 0);
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }

      if (!processStartToken) return false;
      try {
        const currentToken = this.tokenReader.readToken(handle.pid);
        return currentToken.length > 0 && currentToken !== processStartToken;
      } catch {
        // The PID still exists, so an unreadable token is safely-unknown.
        return false;
      }
    };

    // A failed post-spawn persistence step is not terminal evidence by itself.
    // Signal the exact spawned process, then publish failure only after the
    // handle/PID is confirmed gone. In durable mode, the wrapper's status is
    // additionally required because it is written after process-group cleanup.
    const persistFail = async (message: string): Promise<StartedProcess> => {
      if (hasValidPid && handle.pid !== undefined && !processStartToken) {
        try {
          const candidate = this.tokenReader.readToken(handle.pid);
          if (candidate.length > 0) processStartToken = candidate;
        } catch {
          // Handle settlement or PID absence can still prove termination below.
        }
      }

      try {
        handle.kill("SIGTERM");
      } catch {
        // A throwing signal does not authorize terminal materialization.
      }

      const confirmationDeadline =
        Date.now() + (this.options.cancellationConfirmationTimeoutMs ?? 3_000);
      let terminationConfirmed = false;
      while (Date.now() <= confirmationDeadline) {
        const processDead = spawnedProcessIsConfirmedDead();
        const durableCleanupConfirmed =
          !this.options.durableCompletion || readDurableExitStatus(jobDir, attemptId) !== null;
        if (processDead && durableCleanupConfirmed) {
          terminationConfirmed = true;
          break;
        }
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
      }

      if (!terminationConfirmed) {
        // Keep a valid live handle cancellable/reconcilable. No terminal state,
        // event, or capacity release is allowed while cleanup is ambiguous.
        record.settled = false;
        if (hasValidPid) this.processes.set(job.id, record);
        return {
          ok: false,
          message: `${message}; spawned process termination is safely-unknown`,
          failureDisposition: "termination-unknown",
        };
      }

      record.settled = true;
      this.processes.delete(job.id);
      const finishedAt = Date.now();
      await this.persistTerminalAttempt({
        jobId: job.id,
        attemptId,
        status: "failed",
        exitCode: 1,
        finishedAt,
        source: "runner",
        payload: { pid: null, exitCode: 1, error: message },
      });
      return { ok: false, message, failureDisposition: "terminal-confirmed" };
    };

    // ── Guard: valid PID required before running-state persistence ──
    if (!hasValidPid) {
      return persistFail("Spawn returned no valid PID");
    }

    // Track BEFORE persistence so kill API is available if persistence fails
    this.processes.set(job.id, record);

    // ── Persist running state ─────────────────────────────
    try {
      await this.db.updateJobAttemptStatus(attemptId, "running", {
        pid: handle.pid,
        startedAt: now,
      });
    } catch (err) {
      return persistFail(
        err instanceof Error ? err.message : "Failed to persist attempt running state",
      );
    }

    try {
      await this.db.updateJobStatus(job.id, "running");
    } catch (err) {
      return persistFail(
        err instanceof Error ? err.message : "Failed to persist job running state",
      );
    }

    // ── Capture process start token BEFORE writing identity ──
    // PID is guaranteed valid at this point by the guard above.
    if (handle.pid) {
      try {
        processStartToken = this.tokenReader.readToken(handle.pid);
      } catch {
        return persistFail("Failed to read process start token");
      }
      if (!processStartToken || processStartToken.length === 0) {
        return persistFail("Process start token is empty or malformed");
      }
    }

    // ── Write active identity with real token (only when PID is valid) ──
    // This creates a durable record that survives context exit.
    // Identity write/SERIALIZATION/containment failure is FATAL:
    // an accepted running process must have durable identity.
    if (processStartToken) {
      try {
        this.supervisor.writeActiveIdentity(jobDir, attemptId, {
          schemaVersion: 1,
          jobId: job.id,
          attemptId,
          pid: handle.pid!,
          command: cmd,
          args: cmdArgs,
          cwd: jobDir,
          startTime: now,
          processStartToken,
        });
      } catch (err) {
        return persistFail(
          err instanceof Error ? err.message : "Failed to persist active identity",
        );
      }
    }

    try {
      await this.emitRunnerEvent({
        type: "process.started",
        jobId: job.id,
        attemptId,
        payload: { pid: handle.pid, command: cmd, cwd: jobDir },
      });
    } catch (err) {
      return persistFail(
        err instanceof Error ? err.message : "Failed to emit process.started event",
      );
    }

    // ── Background completion ─────────────────────────────
    // Install AFTER all persistence succeeds. The callback
    // checks `settled` which is set true by cancel before
    // any awaits, preventing completion from overwriting cancel.
    void handle.result
      .then((result) =>
        this.finalizeAttempt(job, record, {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        }),
      )
      .catch(async (error) => {
        if (!record.settled) {
          const failure = error instanceof Error ? error : new Error(String(error));
          await this.finalizeSpawnError(
            job,
            {
              attemptId: record.attemptId,
              stdoutPath: record.stdoutPath,
              stderrPath: record.stderrPath,
            },
            failure as Error & { code?: string },
          );
        }
      });

    return {
      ok: true,
      pid: handle.pid,
      command: `${engine.command} ${(engine.args ?? []).join(" ")}`.trim(),
    };
  }

  // ── Runner Interface ────────────────────────────────────

  async stage(job: Job): Promise<RunnerResult> {
    const engine = this.getEngine(job);
    const jobDir = this.jobDir(job);
    const attemptId = generateId("attempt");

    ensurePrivateJobDirectory(jobDir);

    await this.db.updateJobStatus(job.id, "queued");
    await this.db.createJobAttempt({
      id: attemptId,
      jobId: job.id,
      runner: "local",
      command: engine.displayCommand ?? engine.command,
      cwd: jobDir,
    });

    const stagedInput = this.stagedInputPath(job);
    assertSafeFileTarget(stagedInput, "staged input target");
    atomicCopyRunnerFile(job.inputPath, stagedInput);

    await this.registerArtifactOnce({
      id: generateId("artifact"),
      jobId: job.id,
      attemptId,
      kind: "input",
      path: stagedInput,
      mimeType: "text/plain",
      sizeBytes: statSync(stagedInput).size,
    });

    await this.db.updateJobAttemptStatus(attemptId, "queued");
    await this.db.updateJobAttemptStatus(attemptId, "staged");
    await this.db.updateJobStatus(job.id, "staged");

    return {
      ok: true,
      message: `Staged ${job.name} in ${jobDir}`,
      metadata: { attemptId, cwd: jobDir, inputPath: stagedInput },
    };
  }

  async start(job: Job): Promise<StartedProcess> {
    const attempt = await this.ensureAttempt(job);
    const engine = this.getEngine(job);
    const jobDir = this.jobDir(job);
    ensurePrivateJobDirectory(jobDir);
    const stdoutPath = join(jobDir, "stdout.log");
    const stderrPath = join(jobDir, "stderr.log");
    assertSafeFileTarget(stdoutPath, "stdout target");
    assertSafeFileTarget(stderrPath, "stderr target");

    const restrictedUser = await this.shouldUseRestrictedUser();
    let cmd: string;
    let cmdArgs: string[];
    if (restrictedUser) {
      const cmdStr = [engine.command, ...(engine.args ?? [])].map(quotePosixShellWord).join(" ");
      cmd = "su";
      cmdArgs = ["-", this.options.sandboxUser!, "-c", cmdStr];
    } else {
      cmd = engine.command;
      cmdArgs = engine.args ?? [];
    }

    const runOpts: RunOptions = {
      ...this.options.defaultRunOptions,
      cwd: jobDir,
    };
    if (this.options.maxWallTime != null) {
      runOpts.timeout = this.options.maxWallTime;
    }

    if (this.options.isolateCommand) {
      const isolated = this.options.isolateCommand(cmd, cmdArgs, jobDir);
      cmd = isolated.command;
      cmdArgs = isolated.args;
    }

    let handle: SpawnHandle;
    try {
      handle = this.executor.spawn(cmd, cmdArgs, runOpts);
    } catch (error) {
      const spawnError = error instanceof Error ? error : new Error(String(error));
      await this.finalizeSpawnError(
        job,
        { attemptId: attempt.id, stdoutPath, stderrPath },
        spawnError as Error & { code?: string },
      );
      return { ok: false, message: spawnError.message };
    }

    const now = Date.now();
    const record: TrackedProcess = {
      handle,
      attemptId: attempt.id,
      jobDir,
      stdoutPath,
      stderrPath,
      settled: false,
      startedAt: now,
    };

    // ── Guard: valid PID required before running-state persistence ──
    if (!handle.pid || !Number.isInteger(handle.pid) || handle.pid < 1) {
      record.settled = true;
      await this.finalizeSpawnError(
        job,
        {
          attemptId: record.attemptId,
          stdoutPath: record.stdoutPath,
          stderrPath: record.stderrPath,
        },
        new Error("Spawn returned no valid PID"),
      );
      return { ok: false, message: "Spawn returned no valid PID" };
    }

    this.processes.set(job.id, record);

    await this.db.updateJobAttemptStatus(attempt.id, "running", {
      pid: handle.pid,
      startedAt: now,
    });
    await this.db.updateJobStatus(job.id, "running");

    // ── Capture process start token BEFORE writing identity ──
    // PID is guaranteed valid at this point by the guard above.
    let processStartToken: string | undefined;
    if (handle.pid) {
      try {
        processStartToken = this.tokenReader.readToken(handle.pid);
      } catch {
        // Token capture failure with a valid PID — the process died before
        // we could read its identity. Safely terminate and fail.
        try {
          handle.kill("SIGTERM");
        } catch {
          /* best-effort */
        }
        this.processes.delete(job.id);
        record.settled = true;
        await this.finalizeSpawnError(
          job,
          { attemptId: attempt.id, stdoutPath: record.stdoutPath, stderrPath: record.stderrPath },
          new Error("Failed to read process start token"),
        );
        return { ok: false, message: "Failed to read process start token" };
      }
      if (!processStartToken || processStartToken.length === 0) {
        try {
          handle.kill("SIGTERM");
        } catch {
          /* best-effort */
        }
        this.processes.delete(job.id);
        record.settled = true;
        await this.finalizeSpawnError(
          job,
          { attemptId: attempt.id, stdoutPath: record.stdoutPath, stderrPath: record.stderrPath },
          new Error("Process start token is empty or malformed"),
        );
        return { ok: false, message: "Process start token is empty or malformed" };
      }

      // Write active identity with real token (only when PID is valid)
      // Identity write failure is FATAL: running process must have durable identity.
      try {
        this.supervisor.writeActiveIdentity(jobDir, attempt.id, {
          schemaVersion: 1,
          jobId: job.id,
          attemptId: attempt.id,
          pid: handle.pid,
          command: cmd,
          args: cmdArgs,
          cwd: jobDir,
          startTime: now,
          processStartToken,
        });
      } catch {
        try {
          handle.kill("SIGTERM");
        } catch {
          /* best-effort */
        }
        this.processes.delete(job.id);
        record.settled = true;
        await this.finalizeSpawnError(
          job,
          { attemptId: attempt.id, stdoutPath: record.stdoutPath, stderrPath: record.stderrPath },
          new Error("Failed to persist active identity"),
        );
        return { ok: false, message: "Failed to persist active identity" };
      }
    }

    await this.emitRunnerEvent({
      type: "process.started",
      jobId: job.id,
      attemptId: attempt.id,
      payload: { pid: handle.pid, command: cmd, cwd: jobDir },
    });

    void handle.result
      .then((result) =>
        this.finalizeAttempt(job, record, {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        }),
      )
      .catch(async (error) => {
        if (!record.settled) {
          const failure = error instanceof Error ? error : new Error(String(error));
          await this.finalizeSpawnError(
            job,
            {
              attemptId: record.attemptId,
              stdoutPath: record.stdoutPath,
              stderrPath: record.stderrPath,
            },
            failure as Error & { code?: string },
          );
        }
      });

    return {
      ok: true,
      pid: handle.pid,
      command: `${engine.command} ${(engine.args ?? []).join(" ")}`.trim(),
    };
  }

  async status(job: Job): Promise<RemoteProcessStatus> {
    const tracked = this.processes.get(job.id);
    if (tracked && !tracked.settled && tracked.handle.pid) {
      try {
        process.kill(tracked.handle.pid, 0);
        return { status: "running", message: `PID ${tracked.handle.pid} is running` };
      } catch {
        /* fall through */
      }
    }

    const attempts = await this.db.listJobAttempts(job.id);
    const latest = attempts[attempts.length - 1];
    if (!latest) return { status: "unknown", message: "No process tracked" };

    if (latest.status === "completed") {
      return { status: "completed", exitCode: latest.exitCode, message: "Process completed" };
    }
    if (latest.status === "failed") {
      return { status: "failed", exitCode: latest.exitCode, message: "Process failed" };
    }
    return { status: "running", message: `Attempt ${latest.id} is ${latest.status}` };
  }

  async stop(job: Job): Promise<RunnerResult> {
    const tracked = this.processes.get(job.id);
    if (!tracked) return { ok: false, message: "No tracked process for this job" };
    try {
      tracked.handle.kill("SIGTERM");
      return { ok: true, message: `Sent SIGTERM to PID ${tracked.handle.pid}` };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Could not stop process",
      };
    }
  }

  async fetch(job: Job): Promise<RunnerResult> {
    const tracked = this.processes.get(job.id);
    if (tracked) await this.registerOutputArtifact(job, tracked);
    return { ok: true, message: "Local artifacts are available on disk" };
  }

  // ── Coordinator-Driven Explicit-Attempt Methods ─────────

  private async readAttempt(jobDir: string, attemptId: string): Promise<JobAttempt | null> {
    const allAttempts = await this.db.listJobAttempts();
    return allAttempts.find((a) => a.id === attemptId) ?? null;
  }

  /**
   * Reconcile the durable truth about an attempt.
   *
   * 1. Check identity + receipt (most authoritative)
   * 2. Check in-memory tracked process
   * 3. Check persisted attempt PID with identity verification
   * 4. Use persisted terminal state if available
   *
   * Never infers running from status or PID existence alone.
   * Applies receipt-confirmed terminal state to DB.
   */
  async reconcileAttempt(
    job: Job,
    attemptId: string,
  ): Promise<{
    status: "running" | "completed" | "failed" | "cancelled" | "safely-unknown";
    receipt?: LocalReceipt;
    exitCode?: number;
    message: string;
  }> {
    const jobDir = this.jobDir(job);
    const attempt = await this.readAttempt(jobDir, attemptId);

    // A terminal file inside the writable job directory is not authoritative
    // while the exact persisted process identity is still alive. Check the
    // in-memory handle and anti-PID-reuse identity before reading either file.
    const tracked = this.processes.get(job.id);
    if (tracked && !tracked.settled && tracked.handle.pid) {
      try {
        process.kill(tracked.handle.pid, 0);
        return { status: "running", message: `PID ${tracked.handle.pid} verified alive` };
      } catch {
        /* fall through to durable identity verification */
      }
    }

    let identity: LocalActiveIdentity | null = null;
    try {
      const candidate = this.supervisor.readActiveIdentity(jobDir, attemptId);
      if (
        candidate &&
        candidate.jobId === job.id &&
        candidate.attemptId === attemptId &&
        candidate.cwd === jobDir
      ) {
        identity = candidate;
      }
    } catch {
      // Malformed or unreadable identity is never enough to trust terminal files.
    }
    const identityStatus = identity
      ? this.supervisor.verifyActiveIdentity(jobDir, attemptId)
      : "absent";
    if (identityStatus === "valid") {
      return {
        status: "running",
        message: `PID ${identity!.pid} identity verified; terminal files are not yet authoritative`,
      };
    }
    const terminalFilesTrusted = identityStatus === "dead";

    // Terminal files are trusted only after the exact supervisor identity died.
    const receipt = terminalFilesTrusted
      ? this.supervisor.readReceipt(jobDir, attemptId, {
          jobId: job.id,
          attemptId,
          cwd: jobDir,
        })
      : null;
    if (receipt) {
      // Persist all receipt-confirmed evidence. This must run even when status
      // is already terminal because a previous process may have exited between
      // the status write and artifact/event materialization.
      if (attempt) {
        try {
          await this.materializeTerminalEvidence(job, attempt, receipt);
        } catch {
          return {
            status: "safely-unknown",
            message: `Terminal receipt exists for ${attemptId}, but durable evidence materialization failed`,
          };
        }
      }
      return {
        status: receipt.status,
        receipt,
        exitCode: receipt.exitCode ?? undefined,
        message: `Receipt confirms ${receipt.status} (exit ${receipt.exitCode ?? "signal"})`,
      };
    }

    // The detached wrapper can finish after its launching Bun process is
    // killed. Convert its narrow terminal status into the canonical receipt,
    // anchored to the already persisted active process identity.
    if (this.options.durableCompletion && terminalFilesTrusted) {
      const exitStatus = readDurableExitStatus(jobDir, attemptId);
      if (
        exitStatus &&
        identity &&
        identity.jobId === job.id &&
        identity.attemptId === attemptId &&
        identity.cwd === jobDir
      ) {
        const recoveredReceipt: LocalReceiptV1 = {
          schemaVersion: 1,
          jobId: job.id,
          attemptId,
          pid: identity.pid,
          command: identity.command,
          args: identity.args,
          cwd: identity.cwd,
          exitCode: exitStatus.exitCode,
          signal: null,
          finishedAt: exitStatus.finishedAt,
          status: exitStatus.exitCode === 0 ? "completed" : "failed",
        };
        try {
          this.supervisor.writeTerminalReceipt(jobDir, attemptId, recoveredReceipt);
          if (attempt) {
            await this.materializeTerminalEvidence(job, attempt, recoveredReceipt);
          }
        } catch {
          return {
            status: "safely-unknown",
            message: `Durable exit status exists for ${attemptId}, but receipt reconciliation failed`,
          };
        }
        return {
          status: recoveredReceipt.status,
          receipt: recoveredReceipt,
          exitCode: recoveredReceipt.exitCode ?? undefined,
          message: `Durable supervisor confirms ${recoveredReceipt.status} (exit ${recoveredReceipt.exitCode})`,
        };
      }
    }

    // Persisted terminal DB state remains authoritative independently of files.
    if (attempt) {
      const terminalStates = ["completed", "failed", "cancelled"] as const;
      if (terminalStates.includes(attempt.status as (typeof terminalStates)[number])) {
        return {
          status: attempt.status as "completed" | "failed" | "cancelled",
          exitCode: attempt.exitCode,
          message: `From persisted state: ${attempt.status}`,
        };
      }
    }

    return { status: "safely-unknown", message: "No process evidence found" };
  }

  /**
   * Cancel a local attempt.
   *
   * The DB terminal materializer owns cancellation state and event atomically;
   * the backend returns whether this call initiated the cancellation.
   *
   * Race-safe: marks settled and removes in-memory tracking
   * BEFORE any awaits (signal → mark → await DB/receipt).
   */
  async cancelAttempt(
    job: Job,
    attemptId: string,
  ): Promise<
    | { ok: true; transitioned: boolean; receipt: LocalReceipt; message: string }
    | { ok: false; message: string }
  > {
    const jobDir = this.jobDir(job);
    const attempt = await this.readAttempt(jobDir, attemptId);

    let activeIdentity: LocalActiveIdentity | null = null;
    try {
      const candidate = this.supervisor.readActiveIdentity(jobDir, attemptId);
      if (
        candidate &&
        candidate.jobId === job.id &&
        candidate.attemptId === attemptId &&
        candidate.cwd === jobDir
      ) {
        activeIdentity = candidate;
      }
    } catch {
      // Cancellation requires an exact readable identity below.
    }
    const initialIdentityStatus = activeIdentity
      ? this.supervisor.verifyActiveIdentity(jobDir, attemptId)
      : "absent";

    // A receipt is idempotent evidence only after the exact identity died.
    const existingReceipt =
      initialIdentityStatus === "dead"
        ? this.supervisor.readReceipt(jobDir, attemptId, {
            jobId: job.id,
            attemptId,
            cwd: jobDir,
          })
        : null;
    if (existingReceipt) {
      if (!attempt) {
        return {
          ok: false,
          message: `Terminal receipt exists for ${attemptId}, but its database attempt is missing`,
        };
      }
      try {
        // A previous cancellation/reconciliation may have written the receipt
        // before a DB write failed. Replay the canonical evidence before the
        // idempotent early return so partial persistence heals on retry.
        await this.materializeTerminalEvidence(job, attempt, existingReceipt);
      } catch {
        return {
          ok: false,
          message: `Terminal receipt exists for ${attemptId}, but durable evidence materialization failed`,
        };
      }
      if (existingReceipt.status === "cancelled") {
        return {
          ok: true,
          transitioned: false,
          receipt: existingReceipt,
          message: "Already cancelled",
        };
      }
      return {
        ok: false,
        message: `Attempt ${attemptId} is already ${existingReceipt.status} (cannot cancel)`,
      };
    }

    // Terminal states cannot be cancelled
    const terminalStates = ["completed", "failed", "cancelled", "parsed"] as const;
    if (attempt && terminalStates.includes(attempt.status as (typeof terminalStates)[number])) {
      return {
        ok: false,
        message: `Attempt ${attemptId} is already ${attempt.status} (cannot cancel)`,
      };
    }

    // Find process — prefer in-memory, fall back to identity-verified PID
    let targetPid: number | undefined;
    let identityVerified = false;

    const tracked = this.processes.get(job.id);
    if (tracked && !tracked.settled && tracked.handle.pid) {
      targetPid = tracked.handle.pid;
      identityVerified = true;
    }

    // Fall back to active-identity verified PID (supports restart)
    if (!identityVerified && attempt?.pid) {
      if (initialIdentityStatus === "valid" && activeIdentity?.pid === attempt.pid) {
        targetPid = activeIdentity.pid;
        identityVerified = true;
      } else if (initialIdentityStatus === "absent") {
        return {
          ok: false,
          message: `PID-only cancellation refused for attempt ${attemptId}: no identity/receipt. Use SIGTERM manually if safe.`,
        };
      } else {
        return {
          ok: false,
          message: `Cancellation refused for attempt ${attemptId}: identity verification failed (${initialIdentityStatus})`,
        };
      }
    }

    if (!targetPid) {
      return { ok: false, message: `No tracked process or identity for attempt ${attemptId}` };
    }

    // ── Race-safe cancellation protocol ────────────────────
    // 1. Mark settled FIRST to suppress completion callback.
    // 2. Remove from tracking to prevent double-kill.
    // 3. Signal the process.
    // 4. THEN do awaits for receipt/DB/events.

    if (tracked) {
      tracked.settled = true;
      this.processes.delete(job.id);
    }

    // Signal
    try {
      process.kill(targetPid, "SIGTERM");
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ESRCH") {
        // Process already dead — write receipt for cancelled
      } else {
        return { ok: false, message: `Failed to signal PID ${targetPid}: ${nodeErr.message}` };
      }
    }

    // Do not release capacity until the exact PID is dead. In durable mode the
    // status file is written only after the wrapper's TERM→KILL group cleanup.
    const confirmationDeadline =
      Date.now() + (this.options.cancellationConfirmationTimeoutMs ?? 3_000);
    let durableStatus = this.options.durableCompletion
      ? readDurableExitStatus(jobDir, attemptId)
      : null;
    let confirmed = false;
    while (Date.now() <= confirmationDeadline) {
      const verification = this.supervisor.verifyActiveIdentity(jobDir, attemptId);
      if (this.options.durableCompletion) {
        durableStatus = readDurableExitStatus(jobDir, attemptId);
      }
      if (verification === "dead" && (!this.options.durableCompletion || durableStatus)) {
        confirmed = true;
        break;
      }
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    if (!confirmed) {
      return {
        ok: false,
        message: `Cancellation signal sent to PID ${targetPid}, but termination is safely-unknown; durable state remains non-terminal`,
      };
    }

    // A natural completion may win the signal race. Preserve its real status.
    if (durableStatus && ![129, 130, 143].includes(durableStatus.exitCode)) {
      const completedReceipt: LocalReceiptV1 = {
        schemaVersion: 1,
        jobId: job.id,
        attemptId,
        pid: targetPid,
        command: activeIdentity?.command ?? attempt?.command ?? "",
        args: activeIdentity?.args ?? [],
        cwd: jobDir,
        exitCode: durableStatus.exitCode,
        signal: null,
        finishedAt: durableStatus.finishedAt,
        status: durableStatus.exitCode === 0 ? "completed" : "failed",
      };
      this.supervisor.writeTerminalReceipt(jobDir, attemptId, completedReceipt);
      if (attempt) await this.materializeTerminalEvidence(job, attempt, completedReceipt);
      return {
        ok: false,
        message: `Attempt ${attemptId} finished before cancellation was confirmed`,
      };
    }

    const now = durableStatus?.finishedAt ?? Date.now();
    const receipt: LocalReceiptV1 = {
      schemaVersion: 1,
      jobId: job.id,
      attemptId,
      pid: targetPid,
      command: activeIdentity?.command ?? attempt?.command ?? "",
      args: activeIdentity?.args ?? [],
      cwd: jobDir,
      exitCode: null,
      signal: "SIGTERM",
      finishedAt: now,
      status: "cancelled",
    };

    this.supervisor.writeTerminalReceipt(jobDir, attemptId, receipt);

    if (!attempt) {
      return {
        ok: false,
        message: `Cancellation receipt was written for ${attemptId}, but its database attempt is missing`,
      };
    }
    await this.materializeTerminalEvidence(job, attempt, receipt);

    return {
      ok: true,
      transitioned: true,
      receipt,
      message: `Cancelled PID ${targetPid} for attempt ${attemptId}`,
    };
  }

  /**
   * Collect artifacts for a specific attempt.
   * Deduplicates by jobId + attemptId + kind + canonical path.
   */
  async collectAttempt(
    job: Job,
    attemptId: string,
    options?: { requiredOutput?: boolean },
  ): Promise<
    | { ok: true; artifacts: string[]; message: string }
    | { ok: false; artifacts: string[]; message: string }
  > {
    const jobDir = this.jobDir(job);
    const registered: string[] = [];
    const errors: string[] = [];
    const requiredOutput = options?.requiredOutput ?? true;

    const stdoutPath = join(jobDir, "stdout.log");
    const stderrPath = join(jobDir, "stderr.log");

    const register = async (
      kind: Artifact["kind"],
      path: string,
      label: string,
      required: boolean,
    ): Promise<void> => {
      if (!existsSync(path)) {
        if (required) errors.push(`Required ${label} not found: ${path}`);
        return;
      }
      assertSafeFileTarget(path, `${label} artifact`);

      const created = await this.registerArtifactOnce({
        id: generateId("artifact"),
        jobId: job.id,
        attemptId,
        kind,
        path,
        label,
        mimeType: kind === "log" ? "text/plain" : undefined,
        sizeBytes: statSync(path).size,
      });
      if (created) registered.push(path);
    };

    await register("log", stdoutPath, "stdout", false);
    await register("log", stderrPath, "stderr", false);

    if (job.outputPath) {
      const outputPath = this.resolvePath(jobDir, job.outputPath);
      await register("output", outputPath, "output", requiredOutput);
    }

    const ok = errors.length === 0;
    return {
      ok,
      artifacts: registered,
      message: ok
        ? `Collected ${registered.length} artifact(s) for attempt ${attemptId}`
        : `Collection partial: ${errors.join("; ")}`,
    };
  }
}
