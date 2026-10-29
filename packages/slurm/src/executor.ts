export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the process was terminated by the bounded executor timeout. */
  timedOut?: boolean;
  /** True when stdout exceeded the configured capture limit. */
  stdoutTruncated?: boolean;
  /** True when stderr exceeded the configured capture limit. */
  stderrTruncated?: boolean;
}

export interface CliExecutionOptions {
  timeout?: number;
  env?: Record<string, string>;
  /** Production gateways replace, rather than extend, the login environment. */
  inheritEnv?: boolean;
  cwd?: string;
  stdin?: Uint8Array;
  maxOutputBytes?: number;
  maxErrorBytes?: number;
}

export interface CliExecutor {
  run(cmd: string, args: string[], opts?: CliExecutionOptions): Promise<CliResult>;
}

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_ERROR_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

async function readBounded(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
  onLimit: () => void,
  deadline: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: "", truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  const cancelRead = () => void reader.cancel().catch(() => {});
  deadline.addEventListener("abort", cancelRead, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = Math.max(0, maxBytes - bytes);
      if (remaining > 0) {
        const take = Math.min(remaining, value.byteLength);
        chunks.push(value.subarray(0, take));
        bytes += take;
      }
      if (value.byteLength > remaining && !truncated) {
        truncated = true;
        onLimit();
      }
    }
  } finally {
    deadline.removeEventListener("abort", cancelRead);
    reader.releaseLock();
  }
  return {
    text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"),
    truncated,
  };
}

export class BunExecutor implements CliExecutor {
  /** Parent mode is only for an already isolated, supervised backend child.
   * Its Python owner terminates that whole group, including scheduler clients.
   * Ordinary callers retain the historical isolated-group default.
   */
  constructor(private readonly processGroup: "isolated" | "parent" = "isolated") {
    if (!["isolated", "parent"].includes(processGroup))
      throw new Error("Invalid process group mode");
  }

  async run(cmd: string, args: string[], opts?: CliExecutionOptions): Promise<CliResult> {
    const timeout = opts?.timeout ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = opts?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const maxErrorBytes = opts?.maxErrorBytes ?? DEFAULT_MAX_ERROR_BYTES;
    for (const [value, maximum] of [
      [timeout, 300_000],
      [maxOutputBytes, 64 * 1024 * 1024],
      [maxErrorBytes, 64 * 1024 * 1024],
    ]) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
        throw new Error("Invalid bounded CLI execution limit");
      }
    }
    const grouped = process.platform !== "win32" && this.processGroup === "isolated";
    const proc = Bun.spawn([cmd, ...args], {
      stdin: opts?.stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
      cwd: opts?.cwd,
      detached: grouped,
      env:
        opts?.inheritEnv === false
          ? { ...opts.env }
          : { ...(process.env as Record<string, string>), ...opts?.env },
    });

    const deadline = new AbortController();
    let timedOut = false;
    let killedForOutput = false;
    const terminate = () => {
      try {
        // A child retaining stdout must not defeat the timeout after its parent
        // exits. Only this invocation's newly created process group is targeted.
        if (grouped) process.kill(-proc.pid, "SIGKILL");
        else proc.kill("SIGKILL");
      } catch {
        // The process/group may already have exited.
      }
    };
    const terminateForOutput = () => {
      if (killedForOutput) return;
      killedForOutput = true;
      terminate();
    };
    const stdoutPromise = readBounded(
      proc.stdout,
      maxOutputBytes,
      terminateForOutput,
      deadline.signal,
    );
    const stderrPromise = readBounded(
      proc.stderr,
      maxErrorBytes,
      terminateForOutput,
      deadline.signal,
    );
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      terminate();
      deadline.abort();
    }, timeout);
    try {
      const [
        exitCode,
        { text: stdout, truncated: stdoutTruncated },
        { text: stderr, truncated: stderrTruncated },
      ] = await Promise.all([proc.exited, stdoutPromise, stderrPromise]);
      return {
        exitCode,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      };
    } catch (error) {
      terminate();
      deadline.abort();
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
