import { spawn, type ChildProcess } from "child_process";
import { platform } from "os";

// ────────────────────────────────────────────────────────────
// Configuration Constants
// ────────────────────────────────────────────────────────────

/** Default timeout for a single command execution: 2 minutes. */
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000;

/** Absolute maximum timeout: 10 minutes. */
export const MAX_TIMEOUT_MS = 10 * 60 * 1_000;

/** In-memory safety limit for stdout capture: 1 MB. */
export const MAX_CAPTURE_BYTES = 1024 * 1024;

/** In-memory safety limit for stderr capture: 512 KB. */
export const MAX_ERROR_BYTES = 512 * 1024;

/** Grace period after SIGTERM before SIGKILL: 3 seconds. */
export const FORCE_KILL_DELAY_MS = 3_000;

// ────────────────────────────────────────────────────────────
// Result & Options Types
// ────────────────────────────────────────────────────────────

/**
 * Structured result from a single command execution.
 */
export interface RunResult {
  /** The command string that was executed. */
  command: string;
  /** Exit code. Undefined if the process was killed by signal. */
  exitCode: number | undefined;
  /** Captured stdout content (may be truncated). */
  stdout: string;
  /** Captured stderr content (may be truncated). */
  stderr: string;
  /** true if stdout exceeded MAX_CAPTURE_BYTES. */
  stdoutTruncated: boolean;
  /** true if stderr exceeded MAX_ERROR_BYTES. */
  stderrTruncated: boolean;
  /** true if the process was terminated by timeout. */
  timedOut: boolean;
  /** Signal that killed the process, if any. */
  signal?: string;
}

/**
 * Options for executing a command.
 */
export interface RunOptions {
  /** Working directory for the process. */
  cwd?: string;
  /** Environment variables (key=value). Merged with process.env. */
  env?: Record<string, string>;
  /** Maximum stdout capture in bytes (default: MAX_CAPTURE_BYTES). */
  maxOutputBytes?: number;
  /** Maximum stderr capture in bytes (default: MAX_ERROR_BYTES). */
  maxErrorBytes?: number;
  /** Timeout in milliseconds (default: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS). */
  timeout?: number;
  /**
   * Disable this process helper's timeout timer. Reserved for trusted durable
   * supervisors that enforce their own timeout after the parent exits.
   */
  disableTimeout?: boolean;
  /** AbortSignal for external cancellation. */
  signal?: AbortSignal;
  /** POSIX shell executable used only to apply configured resource limits. */
  shell?: string;
  /**
   * POSIX RLIMIT_NPROC: max number of child processes.
   * Implemented via `ulimit -u` when spawning through a POSIX shell.
   * Future hardening: native `setrlimit` for non-shell spawns.
   */
  maxProcesses?: number;
  /**
   * POSIX RLIMIT_FSIZE: max file size in bytes a process may write.
   * Implemented via `ulimit -f` (512-byte block units).
   * Future hardening: native `setrlimit` for non-shell spawns.
   */
  maxFileSize?: number;
  /**
   * POSIX RLIMIT_AS: max address space / virtual memory in bytes.
   * Implemented via `ulimit -v` (KB units).
   * Future hardening: native `setrlimit` for non-shell spawns.
   */
  maxMemory?: number;
  /** Start the process in its own process group. */
  detached?: boolean;
  /** Disable parent-owned pipes when a trusted wrapper redirects output durably. */
  stdio?: "pipe" | "ignore";
  /** Allow a detached supervised process to outlive the launching process. */
  unref?: boolean;
}

// ────────────────────────────────────────────────────────────
// Error Types
// ────────────────────────────────────────────────────────────

/**
 * Typed error for process execution failures.
 */
export class ProcessError extends Error {
  public readonly command: string;
  public readonly exitCode?: number;
  public readonly stderr?: string;
  public readonly cause?: Error;

  constructor(opts: {
    command: string;
    exitCode?: number;
    stderr?: string;
    cause?: Error;
    message?: string;
  }) {
    super(opts.message ?? `Process exited with code ${opts.exitCode ?? "unknown"}`);
    this.name = "ProcessError";
    this.command = opts.command;
    this.exitCode = opts.exitCode;
    this.stderr = opts.stderr;
    this.cause = opts.cause;
  }
}

function formatSpawnError(error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  return code && !error.message.includes(code) ? `${error.message} (${code})` : error.message;
}

// ────────────────────────────────────────────────────────────
// Byte-Bounded Stream Collection
// ────────────────────────────────────────────────────────────

interface CollectedBuffer {
  buffer: string;
  truncated: boolean;
}

interface StreamCollection {
  result: Promise<CollectedBuffer>;
  finish(): CollectedBuffer;
}

/**
 * Collect a readable stream of Uint8Array chunks into a single
 * string, truncating at the specified byte limit. The
 * `truncated` flag is set to true if the source exceeded the
 * limit.
 */
function collectStream(
  stream: NodeJS.ReadableStream,
  maxBytes: number | undefined,
): StreamCollection {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  const limit = maxBytes ?? MAX_CAPTURE_BYTES;
  let resolveResult!: (value: CollectedBuffer) => void;
  let finished = false;

  const finish = (): CollectedBuffer => {
    const collected = { buffer: Buffer.concat(chunks).toString("utf-8"), truncated };
    if (!finished) {
      finished = true;
      resolveResult(collected);
    }
    return collected;
  };

  const result = new Promise<CollectedBuffer>((resolve) => {
    resolveResult = resolve;

    const onData = (chunk: Buffer) => {
      if (truncated) return;
      if (limit !== undefined && bytes + chunk.length > limit) {
        const remaining = limit - bytes;
        if (remaining > 0) {
          chunks.push(chunk.subarray(0, remaining));
        }
        bytes = limit;
        truncated = true;
        return;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    };

    const onEnd = () => {
      finish();
    };

    const onError = () => {
      finish();
    };

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });

  return { result, finish };
}

// ────────────────────────────────────────────────────────────
// Resource Limits Helper
// ────────────────────────────────────────────────────────────

/**
 * Build positional arguments for the fixed POSIX resource-limit wrapper.
 */
function buildRlimitArguments(options: RunOptions): string[] {
  return [
    options.maxProcesses === undefined ? "-" : String(Math.floor(options.maxProcesses)),
    options.maxFileSize === undefined
      ? "-"
      : String(Math.max(1, Math.floor(options.maxFileSize / 512))),
    options.maxMemory === undefined
      ? "-"
      : String(Math.max(1, Math.floor(options.maxMemory / 1024))),
  ];
}

/**
 * Determine whether any POSIX resource limits are configured.
 */
function hasRlimits(options: RunOptions): boolean {
  return (
    options.maxProcesses !== undefined ||
    options.maxFileSize !== undefined ||
    options.maxMemory !== undefined
  );
}

const POSIX_RLIMIT_SCRIPT = [
  'if [ "$1" != "-" ]; then ulimit -u "$1"; fi',
  "shift",
  'if [ "$1" != "-" ]; then ulimit -f "$1"; fi',
  "shift",
  'if [ "$1" != "-" ]; then ulimit -v "$1"; fi',
  "shift",
  'exec "$@"',
].join("; ");

function getCommandInvocation(
  command: string,
  args: string[],
  options: RunOptions,
): {
  executable: string;
  args: string[];
} {
  if (!hasRlimits(options)) {
    return { executable: command, args };
  }

  if (platform() === "win32") {
    throw new ProcessError({
      command,
      message: "POSIX resource limits are not supported on Windows",
    });
  }

  return {
    executable: options.shell ?? "/bin/sh",
    args: [
      "-c",
      POSIX_RLIMIT_SCRIPT,
      "eigengrid-rlimit",
      ...buildRlimitArguments(options),
      command,
      ...args,
    ],
  };
}

// ────────────────────────────────────────────────────────────
// Spawn Handle (PID-returning variant for LocalRunner)
// ────────────────────────────────────────────────────────────

/**
 * A spawned process handle that gives immediate access to the
 * PID and a `.result` promise that resolves when the process
 * exits with full output.
 */
export interface SpawnHandle {
  /** Process ID — available immediately after spawn. */
  pid: number | undefined;
  /** Promise that resolves when the process exits. */
  result: Promise<RunResult>;
  /** Send a signal to the process (default: SIGTERM). */
  kill(signal?: string): void;
}

/**
 * Spawn a command and return a handle immediately. The caller
 * receives the PID right away and can await `.result` for the
 * full RunResult when the process completes.
 *
 * This is the correct function for LocalRunner.start() which
 * needs to return a StartedProcess with a PID immediately
 * while capturing output in the background.
 *
 * @example
 * const handle = spawnCommand("g16", ["input.gjf"], { cwd: jobDir });
 * startedProcess = { ok: true, pid: handle.pid };
 *
 * const result = await handle.result;
 * console.log(`Exit: ${result.exitCode}, truncated: ${result.stdoutTruncated}`);
 */
export function spawnCommand(
  command: string,
  args: string[] = [],
  options: RunOptions = {},
): SpawnHandle {
  const cwd = options.cwd ?? process.cwd();
  const maxOut = options.maxOutputBytes ?? MAX_CAPTURE_BYTES;
  const maxErr = options.maxErrorBytes ?? MAX_ERROR_BYTES;
  const timeoutMs = Math.min(options.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const invocation = getCommandInvocation(command, args, options);

  const child: ChildProcess = spawn(invocation.executable, invocation.args, {
    cwd,
    shell: false,
    stdio: options.stdio === "ignore" ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"],
    env: options.env ? { ...process.env, ...options.env } : process.env,
    detached: options.detached ?? false,
  });

  if (options.unref) child.unref();

  const stdoutCollected = child.stdout
    ? collectStream(child.stdout, maxOut)
    : {
        result: Promise.resolve({ buffer: "", truncated: false }),
        finish: () => ({ buffer: "", truncated: false }),
      };

  const stderrCollected = child.stderr
    ? collectStream(child.stderr, maxErr)
    : {
        result: Promise.resolve({ buffer: "", truncated: false }),
        finish: () => ({ buffer: "", truncated: false }),
      };

  // ── Timeout ───────────────────────────────────────────
  let timedOut = false;
  const timer = options.disableTimeout
    ? undefined
    : setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");

        setTimeout(() => {
          if (child.exitCode === null) {
            child.kill("SIGKILL");
          }
        }, FORCE_KILL_DELAY_MS).unref();
      }, timeoutMs).unref();

  // ── External abort signal ─────────────────────────────
  const abortHandler = () => {
    child.kill("SIGTERM");
  };

  if (options.signal) {
    if (options.signal.aborted) {
      child.kill("SIGTERM");
    } else {
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  // ── Result promise ────────────────────────────────────
  const result = new Promise<RunResult>((resolve) => {
    let settled = false;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener("abort", abortHandler);
    };
    const settle = (result: RunResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    child.on("exit", (exitCode, signal) => {
      setImmediate(async () => {
        const [stdout, stderr] = await Promise.all([
          stdoutCollected.result,
          stderrCollected.result,
        ]);
        settle({
          command: `${command} ${args.join(" ")}`.trim(),
          exitCode: exitCode ?? undefined,
          stdout: stdout.buffer,
          stderr: stderr.buffer,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          timedOut,
          signal: signal ?? undefined,
        });
      });
    });

    child.on("error", (err) => {
      const stdout = stdoutCollected.finish();
      const stderr = stderrCollected.finish();
      const errorMessage = formatSpawnError(err);
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle({
        command: `${command} ${args.join(" ")}`.trim(),
        exitCode: undefined,
        stdout: stdout.buffer,
        stderr: `${stderr.buffer}\n${errorMessage}`,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut: false,
      });
    });
  });

  return {
    pid: child.pid ?? undefined,
    result,
    kill: (signal?: string) => child.kill(signal as NodeJS.Signals),
  };
}

// ────────────────────────────────────────────────────────────
// Core Command Runner (one-shot)
// ────────────────────────────────────────────────────────────

/**
 * Spawn a command, collect its output with byte limits, apply
 * timeout, and return a structured RunResult.
 *
 * This is the core process supervisor. All subprocess execution
 * in EigenGrid should route through this function.
 *
 * @example
 * const result = await runCommand("g16", ["input.gjf"], {
 *   cwd: "/tmp/jobs/abc",
 *   timeout: 30_000,
 *   maxOutputBytes: 1024 * 1024,
 * });
 *
 * if (result.timedOut) {
 *   console.error("Command timed out after 30s");
 * }
 * console.log(`Exit code: ${result.exitCode}`);
 * console.log(`Stdout (truncated: ${result.stdoutTruncated}):\n${result.stdout}`);
 */
export function runCommand(
  command: string,
  args: string[] = [],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const cwd = options.cwd ?? process.cwd();
    const maxOut = options.maxOutputBytes ?? MAX_CAPTURE_BYTES;
    const maxErr = options.maxErrorBytes ?? MAX_ERROR_BYTES;
    const timeoutMs = Math.min(options.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    let invocation: { executable: string; args: string[] };
    try {
      invocation = getCommandInvocation(command, args, options);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({
        command: `${command} ${args.join(" ")}`.trim(),
        exitCode: undefined,
        stdout: "",
        stderr: message,
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
      });
      return;
    }

    // ── Spawn ─────────────────────────────────────────────
    const child: ChildProcess = spawn(invocation.executable, invocation.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });

    // ── Collect stdout / stderr ───────────────────────────
    const stdoutCollected = child.stdout
      ? collectStream(child.stdout, maxOut)
      : {
          result: Promise.resolve({ buffer: "", truncated: false }),
          finish: () => ({ buffer: "", truncated: false }),
        };

    const stderrCollected = child.stderr
      ? collectStream(child.stderr, maxErr)
      : {
          result: Promise.resolve({ buffer: "", truncated: false }),
          finish: () => ({ buffer: "", truncated: false }),
        };

    // ── Timeout ───────────────────────────────────────────
    let timedOut = false;
    const timer = options.disableTimeout
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");

          // Grace period, then SIGKILL
          setTimeout(() => {
            if (child.exitCode === null) {
              child.kill("SIGKILL");
            }
          }, FORCE_KILL_DELAY_MS).unref();
        }, timeoutMs).unref();

    // ── External abort signal ─────────────────────────────
    const abortHandler = () => {
      child.kill("SIGTERM");
    };

    if (options.signal) {
      if (options.signal.aborted) {
        child.kill("SIGTERM");
      } else {
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    // ── Wait for exit ─────────────────────────────────────
    let settled = false;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener("abort", abortHandler);
    };
    const settle = (result: RunResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    child.on("exit", (exitCode, signal) => {
      // Wait a microtask for pending stream data
      setImmediate(async () => {
        const [stdout, stderr] = await Promise.all([
          stdoutCollected.result,
          stderrCollected.result,
        ]);

        settle({
          command: `${command} ${args.join(" ")}`.trim(),
          exitCode: exitCode ?? undefined,
          stdout: stdout.buffer,
          stderr: stderr.buffer,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          timedOut,
          signal: signal ?? undefined,
        });
      });
    });

    child.on("error", (err) => {
      const stdout = stdoutCollected.finish();
      const stderr = stderrCollected.finish();
      const errorMessage = formatSpawnError(err);
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle({
        command: `${command} ${args.join(" ")}`.trim(),
        exitCode: undefined,
        stdout: stdout.buffer,
        stderr: `${stderr.buffer}\n${errorMessage}`,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut: false,
      });
    });
  });
}

// ────────────────────────────────────────────────────────────
// Convenience Validators
// ────────────────────────────────────────────────────────────

/**
 * Verify that the process exited with code 0. Throws
 * ProcessError otherwise.
 */
export function requireSuccess(result: RunResult): RunResult {
  if (result.exitCode !== 0) {
    throw new ProcessError({
      command: result.command,
      exitCode: result.exitCode,
      stderr: result.stderr,
      message: `Command failed with exit code ${result.exitCode}: ${result.stderr.slice(0, 500)}`,
    });
  }
  return result;
}

/**
 * Verify that the process exited with one of the specified
 * codes. Throws ProcessError otherwise.
 */
export function requireExitIn(codes: number[]): (result: RunResult) => RunResult {
  return (result: RunResult) => {
    if (result.exitCode === undefined || !codes.includes(result.exitCode)) {
      throw new ProcessError({
        command: result.command,
        exitCode: result.exitCode,
        stderr: result.stderr,
        message: `Command exited with code ${result.exitCode}, expected one of [${codes.join(", ")}]: ${result.stderr.slice(0, 500)}`,
      });
    }
    return result;
  };
}

// ────────────────────────────────────────────────────────────
// Head+Tail Preview Builder
// ────────────────────────────────────────────────────────────

/**
 * Build a compact head+tail preview of truncated output.
 * If the text fits within the limit, returns the full text.
 * Otherwise returns `headLines` lines from the start and
 * `tailLines` lines from the end with a truncation notice.
 */
export function previewOutput(
  text: string,
  maxLines: number = 100,
  maxBytes: number = 50 * 1024,
): { output: string; truncated: boolean } {
  const lines = text.split("\n");

  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return { output: text, truncated: false };
  }

  const headLines = Math.ceil(maxLines / 2);
  const tailLines = Math.floor(maxLines / 2);
  const head = lines.slice(0, headLines).join("\n");
  const tail = lines.slice(Math.max(0, lines.length - tailLines)).join("\n");

  const preview = `${head}\n\n... [${lines.length - headLines - tailLines} lines suppressed] ...\n\n${tail}`;

  // If even the preview exceeds maxBytes, trim further
  if (Buffer.byteLength(preview, "utf-8") > maxBytes) {
    const truncated = preview.slice(0, maxBytes);
    return { output: `${truncated}\n\n[output truncated at ${maxBytes} bytes]`, truncated: true };
  }

  return { output: preview, truncated: true };
}
