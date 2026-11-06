import type { Job, StartedProcess } from "@eigengrid/core";
import { join } from "path";
import {
  buildDurableSupervisorInvocation,
  readDurableExitStatus,
} from "../durable-local-supervisor";
import { DEFAULT_TIMEOUT_MS, type RunOptions, type SpawnHandle } from "../process-utils";
import { quotePosixShellWord } from "../wrapper";
import { LocalRunnerContext } from "./context";
import { type TrackedProcess } from "./contracts";
import { assertSafeFileTarget, ensurePrivateJobDirectory, resolveExecutablePath } from "./paths";
import {
  localFinalizeAttempt,
  localFinalizeSpawnError,
  localPersistTerminalAttempt,
} from "./terminal";

export async function localStartAttempt(
  runner: LocalRunnerContext,
  job: Job,
  attemptId: string,
): Promise<StartedProcess> {
  const engine = runner.getEngine(job);
  const jobDir = runner.jobDir(job);
  ensurePrivateJobDirectory(jobDir);
  const stdoutPath = join(jobDir, "stdout.log");
  const stderrPath = join(jobDir, "stderr.log");
  assertSafeFileTarget(stdoutPath, "stdout target");
  assertSafeFileTarget(stderrPath, "stderr target");

  const restrictedUser = await runner.shouldUseRestrictedUser();
  let cmd: string;
  let cmdArgs: string[];
  if (restrictedUser) {
    const cmdStr = [engine.command, ...(engine.args ?? [])].map(quotePosixShellWord).join(" ");
    cmd = "su";
    cmdArgs = ["-", runner.options.sandboxUser!, "-c", cmdStr];
  } else {
    cmd = engine.command;
    cmdArgs = engine.args ?? [];
  }

  const runOpts: RunOptions = {
    ...runner.options.defaultRunOptions,
    cwd: jobDir,
  };
  if (runner.options.maxWallTime != null) {
    runOpts.timeout = runner.options.maxWallTime;
  }

  if (runner.options.isolateCommand) {
    const isolated = runner.options.isolateCommand(cmd, cmdArgs, jobDir);
    cmd = isolated.command;
    cmdArgs = isolated.args;
  }
  if (runner.options.durableCompletion) {
    // The durable wrapper itself is always /bin/sh, so spawning it cannot
    // report an unavailable engine. Resolve the trusted recipe executable
    // before launching the wrapper to preserve confirmed-start semantics.
    const resolvedCommand = resolveExecutablePath(cmd, runOpts.cwd ?? process.cwd(), runOpts.env);
    if (!resolvedCommand) {
      const error = Object.assign(new Error(`Executable not found: ${cmd}`), {
        code: "ENOENT",
      });
      await localFinalizeSpawnError(runner, job, { attemptId, stdoutPath, stderrPath }, error);
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
    handle = runner.executor.spawn(cmd, cmdArgs, runOpts);
  } catch (error) {
    const spawnError = error instanceof Error ? error : new Error(String(error));
    await localFinalizeSpawnError(
      runner,
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
      const currentToken = runner.tokenReader.readToken(handle.pid);
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
        const candidate = runner.tokenReader.readToken(handle.pid);
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
      Date.now() + (runner.options.cancellationConfirmationTimeoutMs ?? 3_000);
    let terminationConfirmed = false;
    while (Date.now() <= confirmationDeadline) {
      const processDead = spawnedProcessIsConfirmedDead();
      const durableCleanupConfirmed =
        !runner.options.durableCompletion || readDurableExitStatus(jobDir, attemptId) !== null;
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
      if (hasValidPid) runner.processes.set(job.id, record);
      return {
        ok: false,
        message: `${message}; spawned process termination is safely-unknown`,
        failureDisposition: "termination-unknown",
      };
    }

    record.settled = true;
    runner.processes.delete(job.id);
    const finishedAt = Date.now();
    await localPersistTerminalAttempt(runner, {
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
  runner.processes.set(job.id, record);

  // ── Persist running state ─────────────────────────────
  try {
    await runner.db.updateJobAttemptStatus(attemptId, "running", {
      pid: handle.pid,
      startedAt: now,
    });
  } catch (err) {
    return persistFail(
      err instanceof Error ? err.message : "Failed to persist attempt running state",
    );
  }

  try {
    await runner.db.updateJobStatus(job.id, "running");
  } catch (err) {
    return persistFail(err instanceof Error ? err.message : "Failed to persist job running state");
  }

  // ── Capture process start token BEFORE writing identity ──
  // PID is guaranteed valid at this point by the guard above.
  if (handle.pid) {
    try {
      processStartToken = runner.tokenReader.readToken(handle.pid);
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
      runner.supervisor.writeActiveIdentity(jobDir, attemptId, {
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
      return persistFail(err instanceof Error ? err.message : "Failed to persist active identity");
    }
  }

  try {
    await runner.emitRunnerEvent({
      type: "process.started",
      jobId: job.id,
      attemptId,
      payload: { pid: handle.pid, command: cmd, cwd: jobDir },
    });
  } catch (err) {
    return persistFail(err instanceof Error ? err.message : "Failed to emit process.started event");
  }

  // ── Background completion ─────────────────────────────
  // Install AFTER all persistence succeeds. The callback
  // checks `settled` which is set true by cancel before
  // any awaits, preventing completion from overwriting cancel.
  void handle.result
    .then((result) =>
      localFinalizeAttempt(runner, job, record, {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      }),
    )
    .catch(async (error) => {
      if (!record.settled) {
        const failure = error instanceof Error ? error : new Error(String(error));
        await localFinalizeSpawnError(
          runner,
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
