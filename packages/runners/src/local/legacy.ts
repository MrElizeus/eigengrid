import type { Job, RemoteProcessStatus, RunnerResult, StartedProcess } from "@eigengrid/core";
import { join } from "path";
import { type RunOptions, type SpawnHandle } from "../process-utils";
import { quotePosixShellWord } from "../wrapper";
import { localRegisterOutputArtifact } from "./artifacts";
import { LocalRunnerContext } from "./context";
import { type TrackedProcess } from "./contracts";
import { assertSafeFileTarget, ensurePrivateJobDirectory } from "./paths";
import { localEnsureAttempt } from "./staging";
import { localFinalizeAttempt, localFinalizeSpawnError } from "./terminal";

export async function localStart(runner: LocalRunnerContext, job: Job): Promise<StartedProcess> {
  const attempt = await localEnsureAttempt(runner, job);
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

  let handle: SpawnHandle;
  try {
    handle = runner.executor.spawn(cmd, cmdArgs, runOpts);
  } catch (error) {
    const spawnError = error instanceof Error ? error : new Error(String(error));
    await localFinalizeSpawnError(
      runner,
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
    await localFinalizeSpawnError(
      runner,
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

  runner.processes.set(job.id, record);

  await runner.db.updateJobAttemptStatus(attempt.id, "running", {
    pid: handle.pid,
    startedAt: now,
  });
  await runner.db.updateJobStatus(job.id, "running");

  // ── Capture process start token BEFORE writing identity ──
  // PID is guaranteed valid at this point by the guard above.
  let processStartToken: string | undefined;
  if (handle.pid) {
    try {
      processStartToken = runner.tokenReader.readToken(handle.pid);
    } catch {
      // Token capture failure with a valid PID — the process died before
      // we could read its identity. Safely terminate and fail.
      try {
        handle.kill("SIGTERM");
      } catch {
        /* best-effort */
      }
      runner.processes.delete(job.id);
      record.settled = true;
      await localFinalizeSpawnError(
        runner,
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
      runner.processes.delete(job.id);
      record.settled = true;
      await localFinalizeSpawnError(
        runner,
        job,
        { attemptId: attempt.id, stdoutPath: record.stdoutPath, stderrPath: record.stderrPath },
        new Error("Process start token is empty or malformed"),
      );
      return { ok: false, message: "Process start token is empty or malformed" };
    }

    // Write active identity with real token (only when PID is valid)
    // Identity write failure is FATAL: running process must have durable identity.
    try {
      runner.supervisor.writeActiveIdentity(jobDir, attempt.id, {
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
      runner.processes.delete(job.id);
      record.settled = true;
      await localFinalizeSpawnError(
        runner,
        job,
        { attemptId: attempt.id, stdoutPath: record.stdoutPath, stderrPath: record.stderrPath },
        new Error("Failed to persist active identity"),
      );
      return { ok: false, message: "Failed to persist active identity" };
    }
  }

  await runner.emitRunnerEvent({
    type: "process.started",
    jobId: job.id,
    attemptId: attempt.id,
    payload: { pid: handle.pid, command: cmd, cwd: jobDir },
  });

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

export async function localStatus(
  runner: LocalRunnerContext,
  job: Job,
): Promise<RemoteProcessStatus> {
  const tracked = runner.processes.get(job.id);
  if (tracked && !tracked.settled && tracked.handle.pid) {
    try {
      process.kill(tracked.handle.pid, 0);
      return { status: "running", message: `PID ${tracked.handle.pid} is running` };
    } catch {
      /* fall through */
    }
  }

  const attempts = await runner.db.listJobAttempts(job.id);
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

export async function localStop(runner: LocalRunnerContext, job: Job): Promise<RunnerResult> {
  const tracked = runner.processes.get(job.id);
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

export async function localFetch(runner: LocalRunnerContext, job: Job): Promise<RunnerResult> {
  const tracked = runner.processes.get(job.id);
  if (tracked) await localRegisterOutputArtifact(runner, job, tracked);
  return { ok: true, message: "Local artifacts are available on disk" };
}
