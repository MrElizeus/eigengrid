import { randomUUID } from "node:crypto";
import type {
  Artifact,
  Job,
  JobAttempt,
  RemoteProcessStatus,
  RunnerResult,
  SshRunnerConfig,
  StartedProcess,
} from "@eigengrid/core";
import { generateId } from "@eigengrid/core";
import type { EigenGridEventBase } from "@eigengrid/events";
import type { Runner } from "./runner";
import { type CommandExecutor, DefaultCommandExecutor } from "./executor";
import { generateBashWrapper, quotePosixShellWord } from "./wrapper";
import { basename, dirname, join } from "path";
import { existsSync, rmSync, statSync } from "fs";
import { effectRequestDigest, persistEffectIntent, readEffectIntent } from "./effect-intent";
import {
  assertRegularRunnerFile,
  atomicPromoteRunnerFile,
  atomicWriteRunnerFile,
  ensurePrivateRunnerDirectory,
} from "./safe-path";

// ────────────────────────────────────────────────────────────
// SSH Options
// ────────────────────────────────────────────────────────────

const SSH_OPTS: string[] = [
  "-o",
  "ControlMaster=auto",
  "-o",
  "ControlPath=/tmp/eigengrid-ssh-%r@%h:%p",
  "-o",
  "ControlPersist=30",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "ConnectTimeout=10",
];

function strictSshOptions(config: SshRunnerConfig, testExecutorConfigured: boolean): string[] {
  const knownHosts = config.knownHostsPath ?? process.env.EIGENGRID_KNOWN_HOSTS;
  // A custom executor is an explicit test seam. Production (the default
  // executor) refuses to run without a configured host-key database.
  if (!knownHosts && !testExecutorConfigured) {
    throw new Error(
      "SSH host identity is not configured; set knownHostsPath or EIGENGRID_KNOWN_HOSTS",
    );
  }
  return [...SSH_OPTS, "-o", `UserKnownHostsFile=${knownHosts ?? "/dev/null"}`];
}

function assertSafeRemoteScratchDir(remoteScratchDir: string): void {
  if (
    !remoteScratchDir.startsWith("/") ||
    !remoteScratchDir ||
    remoteScratchDir.includes(String.fromCharCode(0)) ||
    /[\r\n\s'"`$;&|<>*?[\]()\\]/.test(remoteScratchDir) ||
    remoteScratchDir.split("/").includes("..")
  ) {
    throw new Error(`Unsafe SSH remote scratch directory: ${remoteScratchDir}`);
  }
}

function assertSafeJobId(jobId: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(jobId)) {
    throw new Error(`Unsafe job identifier for SSH execution: ${jobId}`);
  }
}

function isDefinitivePreConnectionFailure(message: string): boolean {
  return /(?:connection refused|could not resolve hostname|name or service not known|no route to host|unknown host|host key verification failed)/iu.test(
    message,
  );
}

function assertSafeRemoteName(name: string, label: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes(String.fromCharCode(0)) ||
    /[\r\n]/u.test(name)
  ) {
    throw new Error(`Unsafe SSH remote ${label}: ${name}`);
  }
}

// ────────────────────────────────────────────────────────────
// Database Interface
// ────────────────────────────────────────────────────────────

interface SshRunnerDatabase {
  createJobAttempt(attempt: {
    id: string;
    jobId: string;
    runner: "ssh";
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
  listArtifacts(jobId?: string): Promise<Artifact[]>;
  /** Emit a runtime event (available when SqliteDatabase is used). */
  appendEvent?: (event: EigenGridEventBase) => Promise<void>;
}

// ────────────────────────────────────────────────────────────
// Engine & Options
// ────────────────────────────────────────────────────────────

interface SshRunnerEngine {
  command: string;
  args?: string[];
  /** When set, persists this human-readable command string in the attempt record. */
  displayCommand?: string;
}

interface SshRunnerOptions {
  engines?: Record<string, SshRunnerEngine>;
  executor?: CommandExecutor;
}

// ────────────────────────────────────────────────────────────
// SshRunner
// ────────────────────────────────────────────────────────────

export class SshRunner implements Runner {
  readonly kind = "ssh" as const;

  constructor(
    private readonly config: SshRunnerConfig,
    private readonly database?: SshRunnerDatabase,
    private readonly options: SshRunnerOptions = {},
  ) {
    assertSafeRemoteScratchDir(config.remoteScratchDir);
  }

  private get db(): SshRunnerDatabase {
    if (!this.database) {
      throw new Error("SshRunner requires a database instance");
    }
    return this.database;
  }

  private get executor(): CommandExecutor {
    return this.options.executor ?? new DefaultCommandExecutor();
  }

  private connectionOptions(): string[] {
    return strictSshOptions(this.config, this.options.executor !== undefined);
  }

  private getEngine(job: Job): SshRunnerEngine {
    const engine = this.options.engines?.[job.software];
    if (!engine) {
      throw new Error(`No SSH engine configured for ${job.software}`);
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

  private sshHost(): string {
    return `${this.config.username}@${this.config.host}`;
  }

  private remoteDir(job: Job): string {
    assertSafeJobId(job.id);
    return join(this.config.remoteScratchDir, job.id);
  }

  private quotedRemotePath(path: string): string {
    return quotePosixShellWord(path);
  }

  private localJobDir(job: Job): string {
    assertSafeJobId(job.id);
    return join(job.workdir, job.id);
  }

  private stagedInputPath(job: Job): string {
    return join(this.localJobDir(job), basename(job.inputPath));
  }

  private wrapperPath(job: Job): string {
    return join(this.localJobDir(job), "wrapper.sh");
  }

  private intentPath(job: Job, attemptId?: string): string {
    return join(
      this.localJobDir(job),
      attemptId ? `effect-intent-${attemptId}.json` : "effect-intent.json",
    );
  }

  private buildSshArgs(remoteCmd: string): string[] {
    return ["-T", ...this.connectionOptions(), this.sshHost(), remoteCmd];
  }

  private buildScpArgs(local: string, remote: string): string[] {
    return [
      ...this.connectionOptions(),
      local,
      `${this.sshHost()}:${this.quotedRemotePath(remote)}`,
    ];
  }

  // ── Artifact Helpers ────────────────────────────────────

  private async registerArtifactOnce(artifact: Omit<Artifact, "createdAt">): Promise<void> {
    const artifacts = await this.db.listArtifacts(artifact.jobId);
    if (artifacts.some((entry) => entry.kind === artifact.kind && entry.path === artifact.path)) {
      return;
    }
    await this.db.createArtifact(artifact);
  }

  private async markAttemptFailed(
    jobId: string,
    attemptId: string,
    message: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const finishedAt = Date.now();
    const errors: string[] = [];
    try {
      await this.db.updateJobAttemptStatus(attemptId, "failed", {
        exitCode: 1,
        finishedAt,
      });
    } catch (error) {
      errors.push(
        `attempt failed transition: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      await this.db.updateJobStatus(jobId, "failed");
    } catch (error) {
      errors.push(
        `job failed transition: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (errors.length > 0) return { ok: false, message: errors.join("; ") };
    try {
      await this.emitRunnerEvent({
        type: "process.failed",
        jobId,
        attemptId,
        payload: { error: message, exitCode: 1, failedAt: finishedAt, host: this.config.host },
      });
    } catch (error) {
      return {
        ok: false,
        message: `failure state is durable but process.failed event persistence failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    return { ok: true };
  }

  // ── Core SSH/SCP execution (via executor for testability) ──

  /**
   * Execute an SSH command on the remote host.
   * Returns a simple { exitCode, stdout, stderr } object.
   */
  private async sshExec(
    remoteCmd: string,
    timeout = 30_000,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const result = await this.executor.run("ssh", this.buildSshArgs(remoteCmd), {
      timeout,
      maxOutputBytes: 1024,
    });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  /**
   * Copy a local file to the remote host via SCP.
   */
  private async scpCopy(
    local: string,
    remote: string,
    timeout = 30_000,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const result = await this.executor.run("scp", this.buildScpArgs(local, remote), {
      timeout,
      maxOutputBytes: 1024,
    });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  /**
   * Download into a private, unique temporary name and atomically publish the
   * result. Passing the final path directly to scp would let a target symlink
   * (or a replacement racing the preflight check) redirect the write.
   */
  private async scpCopyToFile(
    remote: string,
    local: string,
    timeout = 30_000,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const parent = dirname(local);
    ensurePrivateRunnerDirectory(parent);
    const temporary = join(parent, `.${basename(local)}.${process.pid}.${randomUUID()}.download`);
    try {
      const result = await this.executor.run(
        "scp",
        [
          ...this.connectionOptions(),
          `${this.sshHost()}:${this.quotedRemotePath(remote)}`,
          temporary,
        ],
        { timeout, maxOutputBytes: 1024 },
      );
      const normalized = {
        exitCode: result.exitCode ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
      };
      if (normalized.exitCode === 0) {
        atomicPromoteRunnerFile(temporary, local);
      }
      return normalized;
    } finally {
      // A failed scp or a failed publication must not leave an attacker-
      // controllable file in the runner directory.
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Preserve the primary transport/publication result.
      }
    }
  }

  // ── Runner Interface ────────────────────────────────────

  async stage(job: Job): Promise<RunnerResult> {
    const remote = this.remoteDir(job);
    const localDir = this.localJobDir(job);
    const inputName = basename(job.inputPath);
    assertSafeRemoteName(inputName, "input filename");

    ensurePrivateRunnerDirectory(localDir);
    const existingAttempts = await this.db.listJobAttempts(job.id);
    const latestAttempt = existingAttempts.at(-1);
    if (
      latestAttempt &&
      ["created", "queued", "staged", "running"].includes(latestAttempt.status)
    ) {
      if (latestAttempt.runner !== "ssh") {
        return {
          ok: false,
          failureDisposition: "termination-unknown",
          message: `Job already has an active ${latestAttempt.runner} attempt; refusing SSH replacement stage`,
        };
      }
      const existingIntent =
        readEffectIntent(this.intentPath(job, latestAttempt.id)) ??
        readEffectIntent(this.intentPath(job));
      if (
        existingIntent?.backend === "ssh" &&
        existingIntent.externalId === remote &&
        (existingIntent.state === "submitted" || existingIntent.state === "confirmed")
      ) {
        return {
          ok: true,
          message: `SSH bundle ${remote} is already durably staged`,
          metadata: { attemptId: latestAttempt.id, remoteDir: remote },
        };
      }
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message:
          "SSH stage has a prior active attempt without a confirmed durable bundle; reconcile before retrying",
      };
    }
    const attemptId = generateId("attempt");
    const stagedInput = this.stagedInputPath(job);
    assertRegularRunnerFile(stagedInput, "SSH staged input target");

    // Use displayCommand if available, otherwise build a descriptive SSH command
    const engine = this.options.engines?.[job.software];
    const displayCommand =
      engine?.displayCommand ??
      `${this.config.username}@${this.config.host}: ${engine?.command ?? job.software} ${(engine?.args ?? []).join(" ")}`;

    await this.db.updateJobStatus(job.id, "queued");
    await this.db.createJobAttempt({
      id: attemptId,
      jobId: job.id,
      runner: "ssh",
      command: displayCommand,
      cwd: remote,
    });

    const intentPath = this.intentPath(job, attemptId);
    const intentBase = {
      schema: "eigengrid.effect-intent.v1" as const,
      operationId: `ssh-${job.id}-${attemptId}`,
      jobId: job.id,
      attemptId,
      backend: "ssh" as const,
      requestDigest: effectRequestDigest({
        jobId: job.id,
        attemptId,
        remote,
        inputPath: job.inputPath,
        engine: this.options.engines?.[job.software],
      }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // The local intent is the durable authority record for the first remote
    // effect (mkdir/SCP). It must exist before crossing the SSH boundary.
    try {
      persistEffectIntent(intentPath, { ...intentBase, state: "intent_persisted" });
    } catch (error) {
      const failure = await this.markAttemptFailed(
        job.id,
        attemptId,
        `SSH effect intent could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        ok: false,
        message: failure.ok
          ? "SSH effect intent could not be persisted"
          : `SSH effect intent could not be persisted; ${failure.message}`,
      };
    }

    // Generate wrapper locally using the real engine command if available
    let wrapperCmd = "sh";
    let wrapperArgs = ["-c", `echo "no engine configured for ${job.software}"`];
    if (engine) {
      wrapperCmd = engine.command;
      wrapperArgs = engine.args ?? [];
    }
    const wrapperScript = generateBashWrapper(wrapperCmd, wrapperArgs);
    atomicWriteRunnerFile(this.wrapperPath(job), wrapperScript);
    // Once a remote command has been attempted, a timeout/unknown transport
    // result may have crossed the effect boundary even when no response was
    // received. Keep that possibility separate from the confirmed mkdir bit.
    let remoteEffectPossible = false;
    try {
      // Create remote scratch dir
      let mkdirResult: { exitCode: number; stdout: string; stderr: string };
      try {
        mkdirResult = await this.sshExec(`mkdir -p ${this.quotedRemotePath(remote)}`, 15_000);
      } catch (error) {
        remoteEffectPossible = true;
        throw error;
      }
      if (mkdirResult.exitCode !== 0) {
        if (!isDefinitivePreConnectionFailure(mkdirResult.stderr)) remoteEffectPossible = true;
        throw new Error(`Failed to create remote directory: ${mkdirResult.stderr.slice(0, 500)}`);
      }
      remoteEffectPossible = true;

      // Copy input file
      const inputRemote = `${remote}/${inputName}`;
      let scpInputResult: { exitCode: number; stdout: string; stderr: string };
      try {
        scpInputResult = await this.scpCopy(job.inputPath, inputRemote, 30_000);
      } catch (error) {
        remoteEffectPossible = true;
        throw error;
      }
      if (scpInputResult.exitCode !== 0) {
        if (!isDefinitivePreConnectionFailure(scpInputResult.stderr)) remoteEffectPossible = true;
        throw new Error(`Failed to copy input to remote: ${scpInputResult.stderr.slice(0, 500)}`);
      }
      remoteEffectPossible = true;

      // Register input artifact
      await this.registerArtifactOnce({
        id: generateId("artifact"),
        jobId: job.id,
        attemptId,
        kind: "input",
        path: job.inputPath,
        mimeType: "text/plain",
        sizeBytes: statSync(job.inputPath).size,
      });

      // Copy wrapper script
      const wrapperRemote = `${remote}/wrapper.sh`;
      let scpWrapperResult: { exitCode: number; stdout: string; stderr: string };
      try {
        scpWrapperResult = await this.scpCopy(this.wrapperPath(job), wrapperRemote, 15_000);
      } catch (error) {
        remoteEffectPossible = true;
        throw error;
      }
      if (scpWrapperResult.exitCode !== 0) {
        if (!isDefinitivePreConnectionFailure(scpWrapperResult.stderr)) remoteEffectPossible = true;
        throw new Error(
          `Failed to copy wrapper to remote: ${scpWrapperResult.stderr.slice(0, 500)}`,
        );
      }

      // The remote bundle identity is known before local lifecycle projection.
      // Persist it first so a crash cannot leave a staged remote effect with
      // no deterministic reconciliation handle.
      persistEffectIntent(intentPath, {
        ...intentBase,
        state: "submitted",
        externalId: remote,
        updatedAt: new Date().toISOString(),
      });

      await this.db.updateJobAttemptStatus(attemptId, "queued");
      await this.db.updateJobAttemptStatus(attemptId, "staged");
      await this.db.updateJobStatus(job.id, "staged");

      return {
        ok: true,
        message: `Staged ${job.name} on ${this.config.host}:${remote}`,
        metadata: { attemptId, remoteDir: remote },
      };
    } catch (err) {
      // Rollback: clean up remote dir on failure
      const message = err instanceof Error ? err.message : String(err);
      let cleanupError: string | undefined;
      let cleanupConfirmed = false;
      try {
        const cleanup = await this.sshExec(`rm -rf ${this.quotedRemotePath(remote)}`, 10_000);
        if (cleanup.exitCode !== 0) cleanupError = cleanup.stderr.slice(0, 200);
        else cleanupConfirmed = true;
      } catch (cleanupFailure) {
        cleanupError =
          cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure);
      }
      try {
        persistEffectIntent(intentPath, {
          ...intentBase,
          state: !remoteEffectPossible || cleanupConfirmed ? "failed" : "ambiguous",
          // Once a remote command may have run, retain its directory identity
          // even when cleanup was later confirmed. Dropping an already
          // durable externalId would violate the intent identity contract.
          externalId: remoteEffectPossible ? remote : undefined,
          updatedAt: new Date().toISOString(),
        });
      } catch (intentError) {
        cleanupError = [
          cleanupError,
          `effect intent update failed: ${intentError instanceof Error ? intentError.message : String(intentError)}`,
        ]
          .filter(Boolean)
          .join("; ");
      }
      const failure =
        !remoteEffectPossible || cleanupConfirmed
          ? await this.markAttemptFailed(job.id, attemptId, message)
          : { ok: false as const, message: "remote effect cleanup could not be confirmed" };
      const failureDisposition =
        !remoteEffectPossible || cleanupConfirmed
          ? ("terminal-confirmed" as const)
          : ("termination-unknown" as const);
      return {
        ok: false,
        failureDisposition,
        message: [
          message,
          failure.ok ? undefined : failure.message,
          cleanupError ? `remote cleanup failed: ${cleanupError}` : undefined,
        ]
          .filter(Boolean)
          .join("; "),
      };
    }
  }

  async start(job: Job): Promise<StartedProcess> {
    // Check database first (before engine) so error message mentions database
    this.db;

    const remote = this.remoteDir(job);
    const wrapperRemote = `${remote}/wrapper.sh`;
    const attempts = await this.db.listJobAttempts(job.id);
    const attempt = attempts.at(-1);
    if (!attempt) return { ok: false, message: "No staged SSH attempt found" };
    const intentPath = this.intentPath(job, attempt.id);
    const legacyIntentPath = this.intentPath(job);
    let intent = readEffectIntent(intentPath);
    if (!intent) intent = readEffectIntent(legacyIntentPath);
    if (!intent || intent.backend !== "ssh" || !intent.externalId) {
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message: "SSH start requires a durable staged effect intent; reconcile before launching",
      };
    }
    if (intent.state !== "submitted" && intent.state !== "confirmed") {
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message: `SSH start cannot proceed from durable intent state ${intent.state}`,
      };
    }

    // Get engine command and rebuild wrapper with real commands
    const engine = this.getEngine(job);
    const wrapperScript = generateBashWrapper(engine.command, engine.args ?? []);
    atomicWriteRunnerFile(this.wrapperPath(job), wrapperScript);

    const markStartAmbiguous = (message: string): StartedProcess => {
      let intentError: string | undefined;
      try {
        persistEffectIntent(intentPath, {
          ...intent,
          state: "ambiguous",
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        intentError = `effect intent update failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message: [message, intentError].filter(Boolean).join("; "),
      };
    };

    let scpResult: { exitCode: number; stdout: string; stderr: string };
    try {
      scpResult = await this.scpCopy(this.wrapperPath(job), wrapperRemote, 15_000);
    } catch (error) {
      return markStartAmbiguous(
        `Wrapper upload outcome is ambiguous: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (scpResult.exitCode !== 0) {
      // The remote bundle is already durable and a transport failure cannot
      // prove that no wrapper bytes arrived. Do not terminalize the attempt;
      // preserve capacity and require reconciliation before retrying.
      return markStartAmbiguous(`Failed to upload wrapper: ${scpResult.stderr.slice(0, 500)}`);
    }

    // Make wrapper executable and launch it detached
    const launchCmd = `cd ${this.quotedRemotePath(remote)} && chmod +x wrapper.sh && nohup bash wrapper.sh > /dev/null 2>&1 &`;
    let launchResult: { exitCode: number; stdout: string; stderr: string };
    try {
      launchResult = await this.sshExec(launchCmd, 15_000);
    } catch (error) {
      return markStartAmbiguous(
        `Remote launch outcome is ambiguous: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (launchResult.exitCode !== 0) {
      // The shell may have detached a process before reporting a non-zero
      // transport status. A failed local projection would falsely release
      // capacity, so leave the job staged/unknown for reconciliation.
      return markStartAmbiguous(
        `Failed to launch job on remote: ${launchResult.stderr.slice(0, 500)}`,
      );
    }

    const emitStarted = async (attemptId: string): Promise<void> => {
      await this.emitRunnerEvent({
        type: "process.started",
        jobId: job.id,
        attemptId,
        payload: {
          host: this.config.host,
          remoteDir: remote,
          command: engine.displayCommand ?? engine.command,
        },
      });
    };

    const legacyAttempt = await this.lastAttempt(job);
    if (this.config.legacyLifecycleForCharacterization && legacyAttempt) {
      // Deliberately reproduce the event-first ordering for the characterization
      // fixture only. The normal path below persists running first.
      await emitStarted(legacyAttempt.id);
    }

    // Small delay for the wrapper to write job.pid
    await new Promise((r) => setTimeout(r, 500));

    // Read the remote PID by checking job.pid
    let pidResult: { exitCode: number; stdout: string; stderr: string };
    try {
      pidResult = await this.sshExec(
        `cat ${this.quotedRemotePath(join(remote, "job.pid"))} 2>/dev/null || echo "unknown"`,
        10_000,
      );
    } catch (error) {
      return markStartAmbiguous(
        `Remote PID observation outcome is ambiguous: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const remotePid = pidResult.exitCode === 0 ? parseInt(pidResult.stdout.trim(), 10) : undefined;

    if (!remotePid || !Number.isInteger(remotePid) || remotePid < 1) {
      return markStartAmbiguous("Remote launch did not provide a valid PID");
    }

    persistEffectIntent(intentPath, {
      ...intent,
      state: "confirmed",
      externalId: intent.externalId,
      updatedAt: new Date().toISOString(),
    });
    if (attempt) {
      await this.db.updateJobAttemptStatus(attempt.id, "running", {
        pid: remotePid,
        startedAt: Date.now(),
      });
    }
    await this.db.updateJobStatus(job.id, "running");

    // The production ordering is intent/identity → running aggregate → event.
    // Characterization tests can opt into the historical event-first trace for characterization
    // only; that flag is never set by the application composition root.
    if (attempt && !this.config.legacyLifecycleForCharacterization) await emitStarted(attempt.id);

    // Start background completion watcher only after durable running state and
    // the semantic start event have both been persisted.
    void this.watchCompletion(job).catch((err) => {
      console.error(`[ssh runner] watch error for ${job.id}: ${err}`);
    });

    return {
      ok: true,
      pid: remotePid,
      command: engine.displayCommand ?? `${engine.command} ${(engine.args ?? []).join(" ")}`.trim(),
      message: `Launched on ${this.config.host}`,
    };
  }

  async status(job: Job): Promise<RemoteProcessStatus> {
    const remote = this.remoteDir(job);

    // Single idempotent SSH command to check remote state
    const checkCmd = [
      `cd ${this.quotedRemotePath(remote)}`,
      "if [ -f exit.status ]; then",
      '  echo "EXIT:$(cat exit.status)"',
      "elif [ -f job.pid ]; then",
      "  PID=$(cat job.pid)",
      '  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then',
      '    echo "RUNNING:$PID"',
      "  else",
      '    echo "CRASHED"',
      "  fi",
      "else",
      '  echo "PENDING"',
      "fi",
    ].join(" && ");

    const result = await this.sshExec(checkCmd, 15_000);

    if (result.exitCode !== 0) {
      return {
        status: "unknown",
        message: `SSH status check failed: ${result.stderr.slice(0, 200)}`,
      };
    }

    const output = result.stdout.trim();

    if (output.startsWith("EXIT:")) {
      const exitCode = parseInt(output.slice(5).trim(), 10);
      return {
        status: exitCode === 0 ? "completed" : "failed",
        exitCode,
        message: `Remote process exited with code ${exitCode}`,
      };
    }

    if (output.startsWith("RUNNING:")) {
      return { status: "running", message: `Remote PID ${output.slice(8)} is running` };
    }

    if (output === "CRASHED") {
      return { status: "failed", message: "Remote process crashed (PID no longer exists)" };
    }

    return { status: "unknown", message: "Remote process not yet started (PENDING)" };
  }

  async stop(job: Job): Promise<RunnerResult> {
    const remote = this.remoteDir(job);
    const attempts = await this.db.listJobAttempts(job.id);
    const attempt = attempts.at(-1);
    if (!attempt)
      return { ok: false, message: "SSH cancellation requires a durable effect intent" };
    const intentPath = this.intentPath(job, attempt.id);
    const legacyIntentPath = this.intentPath(job);
    let intent = readEffectIntent(intentPath);
    if (!intent) intent = readEffectIntent(legacyIntentPath);
    if (!intent) {
      // Older staged jobs may predate the intent file. Reconstruct a bounded
      // identity from the durable attempt before sending a cancellation
      // signal; never perform the remote effect without a new intent.
      const now = new Date().toISOString();
      intent = {
        schema: "eigengrid.effect-intent.v1",
        operationId: `ssh-${job.id}-${attempt.id}`,
        jobId: job.id,
        attemptId: attempt.id,
        backend: "ssh",
        state: "intent_persisted",
        requestDigest: effectRequestDigest({
          jobId: job.id,
          attemptId: attempt.id,
          remote,
          inputPath: job.inputPath,
          engine: this.options.engines?.[job.software],
        }),
        externalId: remote,
        createdAt: now,
        updatedAt: now,
      };
      persistEffectIntent(intentPath, intent);
      persistEffectIntent(intentPath, {
        ...intent,
        state: "submitted",
        updatedAt: new Date().toISOString(),
      });
      intent = readEffectIntent(intentPath)!;
    }
    if (intent.backend !== "ssh" || !intent.externalId) {
      return { ok: false, message: "SSH cancellation requires a durable effect intent" };
    }
    if (intent.attemptId !== attempt.id) {
      return {
        ok: false,
        message:
          "SSH cancellation intent belongs to a different attempt; reconcile before retrying",
      };
    }
    if (intent.state === "cancelled") {
      // A previous cancellation may have committed the remote outcome but
      // crashed before projecting local state. Reconcile that durable intent
      // idempotently; if the provider rejects the transition, leave the
      // aggregate untouched and report the conflict.
      try {
        await this.db.updateJobAttemptStatus(attempt.id, "cancelled", { finishedAt: Date.now() });
        await this.db.updateJobStatus(job.id, "cancelled");
        return { ok: true, message: `SSH attempt ${attempt.id} is already cancelled` };
      } catch (error) {
        return {
          ok: false,
          message: `SSH cancellation intent is terminal but local reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    persistEffectIntent(intentPath, {
      ...intent,
      state: "cancel_requested",
      updatedAt: new Date().toISOString(),
    });
    const killCmd = `cd ${this.quotedRemotePath(remote)} && PID=$(cat job.pid 2>/dev/null || true) && if [ -n "$PID" ]; then kill -TERM -- "$PID" 2>/dev/null; fi`;

    let result: { exitCode: number; stdout: string; stderr: string };
    try {
      result = await this.sshExec(killCmd, 15_000);
    } catch (error) {
      try {
        persistEffectIntent(intentPath, {
          ...intent,
          state: "ambiguous",
          updatedAt: new Date().toISOString(),
        });
      } catch {
        // Preserve the primary transport error; restart reconciliation remains
        // fail-closed if the intent could not be updated.
      }
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message: `Remote cancellation outcome is ambiguous: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (result.exitCode !== 0) {
      persistEffectIntent(intentPath, {
        ...intent,
        state: "ambiguous",
        updatedAt: new Date().toISOString(),
      });
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message: `Failed to stop remote process: ${result.stderr.slice(0, 200)}`,
      };
    }

    // Confirm the process is no longer alive before committing terminal
    // cancellation locally. A successful kill command only means the signal
    // was sent; it does not prove that the remote process stopped.
    let verification: { exitCode: number; stdout: string; stderr: string };
    try {
      verification = await this.sshExec(
        `cd ${this.quotedRemotePath(remote)} && PID=$(cat job.pid 2>/dev/null || true) && if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then echo RUNNING; else echo STOPPED; fi`,
        15_000,
      );
    } catch (error) {
      try {
        persistEffectIntent(intentPath, {
          ...intent,
          state: "ambiguous",
          updatedAt: new Date().toISOString(),
        });
      } catch {
        // The thrown transport error remains the primary outcome; restart
        // reconciliation will fail closed if the journal is unreadable.
      }
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message: `Cancellation verification outcome is ambiguous: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (verification.exitCode !== 0 || verification.stdout.trim() === "RUNNING") {
      persistEffectIntent(intentPath, {
        ...intent,
        state: "ambiguous",
        updatedAt: new Date().toISOString(),
      });
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message: "Remote process is still running; local state was not cancelled",
      };
    }

    // Commit the observed external cancellation before projecting local
    // terminal state.  If the journal write fails, do not claim cancellation
    // or release local capacity; reconciliation can retry from the durable
    // cancel_requested state.
    try {
      persistEffectIntent(intentPath, {
        ...intent,
        state: "cancelled",
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message: `Remote cancellation was observed but durable intent persistence failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    try {
      if (attempt) {
        await this.db.updateJobAttemptStatus(attempt.id, "cancelled", { finishedAt: Date.now() });
      }
      await this.db.updateJobStatus(job.id, "cancelled");
    } catch (error) {
      return {
        ok: false,
        message: `Remote cancellation is durable but local reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    return { ok: true, message: `Sent SIGTERM to remote PID on ${this.config.host}` };
  }

  async fetch(job: Job): Promise<RunnerResult> {
    const remote = this.remoteDir(job);
    const localDir = this.localJobDir(job);

    ensurePrivateRunnerDirectory(localDir);

    // Pull all standard output files
    const filesToPull = ["stdout.log", "stderr.log", "exit.status", "job.pid"];

    const attempts = await this.db.listJobAttempts(job.id);
    const attempt = attempts[attempts.length - 1];
    const attemptId = attempt?.id ?? "unknown";

    const errors: string[] = [];
    for (const file of filesToPull) {
      const remoteFile = `${remote}/${file}`;
      const localFile = join(localDir, file);
      assertRegularRunnerFile(localFile, "SSH fetched artifact target");

      let scpResult: { exitCode: number; stdout: string; stderr: string };
      try {
        scpResult = await this.scpCopyToFile(remoteFile, localFile, 30_000);
      } catch (error) {
        errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      if (scpResult.exitCode === 0 && existsSync(localFile)) {
        const artifact: Omit<Artifact, "createdAt"> = {
          id: generateId("artifact"),
          jobId: job.id,
          attemptId,
          kind: "log",
          path: localFile,
          label: file,
          mimeType: "text/plain",
          sizeBytes: statSync(localFile).size,
        };
        await this.registerArtifactOnce(artifact);

        await this.emitRunnerEvent({
          type: "artifact.registered",
          jobId: job.id,
          attemptId,
          artifactId: artifact.id,
          payload: { kind: "log", path: localFile, label: file },
        });
      } else {
        errors.push(`${file}: ${scpResult.stderr.slice(0, 200) || "remote file was not copied"}`);
      }
    }

    // Try to pull engine-specific output if configured
    if (job.outputPath) {
      const outputFileName = basename(job.outputPath);
      assertSafeRemoteName(outputFileName, "output filename");
      const remoteOutput = `${remote}/${outputFileName}`;
      const localOutput = join(localDir, outputFileName);
      assertRegularRunnerFile(localOutput, "SSH fetched output target");

      let scpOutput: { exitCode: number; stdout: string; stderr: string };
      try {
        scpOutput = await this.scpCopyToFile(remoteOutput, localOutput, 30_000);
      } catch (error) {
        errors.push(`${outputFileName}: ${error instanceof Error ? error.message : String(error)}`);
        scpOutput = { exitCode: 1, stdout: "", stderr: "copy failed" };
      }

      if (scpOutput.exitCode === 0 && existsSync(localOutput)) {
        const artifact: Omit<Artifact, "createdAt"> = {
          id: generateId("artifact"),
          jobId: job.id,
          attemptId,
          kind: "output",
          path: localOutput,
          mimeType: "text/plain",
          sizeBytes: statSync(localOutput).size,
        };
        await this.registerArtifactOnce(artifact);

        await this.emitRunnerEvent({
          type: "artifact.registered",
          jobId: job.id,
          attemptId,
          artifactId: artifact.id,
          payload: { kind: "output", path: localOutput },
        });
      } else {
        errors.push(
          `${outputFileName}: ${scpOutput.stderr.slice(0, 200) || "remote output was not copied"}`,
        );
      }
    }

    if (errors.length > 0) {
      return {
        ok: false,
        failureDisposition: "termination-unknown",
        message: `SSH artifact collection incomplete: ${errors.join("; ")}`,
      };
    }
    return {
      ok: true,
      message: `Fetched artifacts from ${this.config.host}:${remote} to ${localDir}`,
    };
  }

  // ── Background Completion Watcher ──────────────────────

  /**
   * Poll remote status until the job completes, then reconcile DB state.
   */
  private async watchCompletion(job: Job): Promise<void> {
    const pollIntervalMs = 5_000;
    const maxPolls = 720; // 1 hour

    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));

      const status = await this.status(job);

      if (status.status === "completed" || status.status === "failed") {
        const attempt = await this.lastAttempt(job);
        if (attempt && attempt.status !== "completed" && attempt.status !== "failed") {
          const now = Date.now();
          const newStatus =
            status.status === "completed" ? ("completed" as const) : ("failed" as const);

          await this.db.updateJobAttemptStatus(attempt.id, newStatus, {
            exitCode: status.exitCode ?? (status.status === "completed" ? 0 : 1),
            finishedAt: now,
          });
          await this.db.updateJobStatus(job.id, newStatus);

          if (status.exitCode === 0) {
            await this.emitRunnerEvent({
              type: "process.completed",
              jobId: job.id,
              attemptId: attempt.id,
              payload: { exitCode: status.exitCode, host: this.config.host },
            });
          } else {
            await this.emitRunnerEvent({
              type: "process.failed",
              jobId: job.id,
              attemptId: attempt.id,
              payload: { exitCode: status.exitCode ?? 1, host: this.config.host },
            });
          }

          // Auto-fetch on completion
          try {
            await this.fetch(job);
          } catch (fetchErr) {
            console.error(`[ssh runner] fetch failed for ${job.id}: ${fetchErr}`);
          }
        }
        return;
      }

      if (status.status === "unknown") {
        // Keep polling
        continue;
      }
    }

    // Exhausting the bounded observation window proves neither completion nor
    // failure.  Treat it as an explicitly ambiguous remote outcome and leave
    // the running aggregate untouched; marking failed here could release
    // capacity while the remote process is still alive.  Reconciliation can
    // retry the observation using the durable remote marker/intent.
    const attempt = await this.lastAttempt(job);
    if (attempt && (attempt.status === "running" || attempt.status === "staged")) {
      const attemptIntentPath = this.intentPath(job, attempt.id);
      const legacyIntentPath = this.intentPath(job);
      const attemptIntent = readEffectIntent(attemptIntentPath);
      const intent = attemptIntent ?? readEffectIntent(legacyIntentPath);
      const durableIntentPath = attemptIntent ? attemptIntentPath : legacyIntentPath;
      if (intent && (intent.state === "confirmed" || intent.state === "submitted")) {
        try {
          persistEffectIntent(durableIntentPath, {
            ...intent,
            state: "ambiguous",
            updatedAt: new Date().toISOString(),
          });
        } catch (error) {
          console.error(
            `[ssh runner] could not persist ambiguous observation for ${job.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
  }

  private async lastAttempt(job: Job): Promise<JobAttempt | undefined> {
    const attempts = await this.db.listJobAttempts(job.id);
    return attempts[attempts.length - 1];
  }
}
