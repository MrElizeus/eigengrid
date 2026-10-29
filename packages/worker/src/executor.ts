import { spawn } from "child_process";
import {
  closeSync,
  constants,
  createWriteStream,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "fs";
import { randomUUID } from "crypto";
import { extname, join } from "path";
import { findRunnableRecipe, loadBuiltinRecipes, renderRecipePlan } from "@eigengrid/recipes";
import { parseManifest } from "./manifest";
import { writeStatusFile } from "./status-file";
import { atomicWriteFileSync } from "./persistence";
import {
  collectArtifactDigests,
  commandDigest,
  createWorkerReceipt,
  manifestDigest,
  writeWorkerReceipt,
} from "./receipt";
import type { WorkerJobManifest } from "./types";

// ────────────────────────────────────────────────────────────
// Execute a Worker Job Bundle
// ────────────────────────────────────────────────────────────

export interface ExecutorResult {
  ok: boolean;
  pid?: number;
  exitCode?: number | null;
  error?: string;
}

export type SpawnAdapter = typeof spawn;

type PhaseObserver = (phase: "directories-opened" | "source-opened") => void;
type HeldLayout = {
  input: number;
  work: number;
  logs: number;
  artifacts: number;
  paths: Record<string, string>;
};

function settleLogStream(
  stream: ReturnType<typeof createWriteStream>,
  destroy = false,
): Promise<void> {
  if (stream.closed || (!destroy && stream.writableFinished)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      stream.off("error", failed);
      resolve();
    };
    const failed = (error: Error) => {
      stream.off(destroy ? "close" : "finish", done);
      reject(error);
    };
    stream.once("error", failed);
    stream.once(destroy ? "close" : "finish", done);
    if (destroy) stream.destroy();
    else stream.end();
  });
}

function settleLogs(
  stdout: ReturnType<typeof createWriteStream>,
  stderr: ReturnType<typeof createWriteStream>,
  destroy = false,
): Promise<void> {
  return Promise.all([settleLogStream(stdout, destroy), settleLogStream(stderr, destroy)]).then(
    () => undefined,
  );
}

function anchor(fd: number, name = ""): string {
  for (const root of ["/proc/self/fd", "/dev/fd"]) {
    if (existsSync(join(root, String(fd)))) return join(root, String(fd), name);
  }
  throw new Error("descriptor-anchored paths require /proc/self/fd or /dev/fd support");
}

function openDirectory(path: string, name: string, create: boolean): number {
  if (!existsSync(path)) {
    if (!create)
      throw new Error(`expected ${name} to be an existing real directory inside the bundle`);
    mkdirSync(path, { recursive: true });
  }
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0),
  );
  if (!fstatSync(fd).isDirectory()) {
    closeSync(fd);
    throw new Error(`expected ${name} to be a real directory inside the bundle`);
  }
  try {
    anchor(fd);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

function verifyDirectory(fd: number, path: string, name: string): void {
  const held = fstatSync(fd);
  const current = lstatSync(path);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== held.dev ||
    current.ino !== held.ino
  ) {
    throw new Error(`${name} changed after descriptor validation`);
  }
}

function closeLayout(layout: HeldLayout): void {
  for (const fd of [layout.input, layout.work, layout.logs, layout.artifacts])
    if (fd >= 0) closeSync(fd);
}

function materializeInput(
  bundleDir: string,
  inputName: string,
  observe?: PhaseObserver,
): HeldLayout {
  const paths = Object.fromEntries(
    ["input", "work", "logs", "artifacts"].map((name) => [name, join(bundleDir, name)]),
  );
  const layout: HeldLayout = {
    input: openDirectory(paths.input, "input/", false),
    work: -1,
    logs: -1,
    artifacts: -1,
    paths,
  };
  try {
    layout.work = openDirectory(paths.work, "work/", true);
    layout.logs = openDirectory(paths.logs, "logs/", true);
    layout.artifacts = openDirectory(paths.artifacts, "artifacts/", true);
    observe?.("directories-opened");
    const source = openSync(
      anchor(layout.input, inputName),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const sourceStat = fstatSync(source);
      if (!sourceStat.isFile() || sourceStat.nlink !== 1)
        throw new Error(
          `expected input/${inputName} to be a regular non-symlink file with link count 1`,
        );
      observe?.("source-opened");
      const temporary = `.${inputName}.${process.pid}.${randomUUID()}.tmp`;
      const temp = openSync(
        anchor(layout.work, temporary),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let read: number;
        while ((read = readSync(source, buffer, 0, buffer.length, null)) > 0)
          writeSync(temp, buffer, 0, read);
      } finally {
        closeSync(temp);
      }
      try {
        const destination = anchor(layout.work, inputName);
        if (existsSync(destination) && lstatSync(destination).isDirectory())
          throw new Error(`expected work/${inputName} not to be a directory`);
        renameSync(anchor(layout.work, temporary), destination);
      } finally {
        rmSync(anchor(layout.work, temporary), { force: true });
      }
    } finally {
      closeSync(source);
    }
    return layout;
  } catch (error) {
    closeLayout(layout);
    throw error;
  }
}

function fail(bundleDir: string, raw: unknown, message: string): ExecutorResult {
  const manifest = raw as Partial<WorkerJobManifest> | null;
  writeStatusFile(bundleDir, {
    schemaVersion: 1,
    jobId: typeof manifest?.jobId === "string" ? manifest.jobId : "unknown",
    attemptId: typeof manifest?.attemptId === "string" ? manifest.attemptId : "",
    state: "failed",
    command: "",
    finishedAt: Date.now(),
    message,
  });
  const parsed = parseManifest(raw);
  if (parsed.ok) {
    try {
      writeWorkerReceipt(
        bundleDir,
        createWorkerReceipt({
          jobId: parsed.manifest.jobId,
          attemptId: parsed.manifest.attemptId,
          manifestDigest: manifestDigest(parsed.manifest),
          state: "failed",
          commandDigest: commandDigest(""),
          finishedAt: Date.now(),
          artifactDigests: collectArtifactDigests(bundleDir),
        }),
      );
    } catch (error) {
      // A malformed bundle must remain failed. Record receipt persistence
      // failure explicitly instead of silently presenting a status with no
      // corresponding authoritative receipt.
      writeStatusFile(bundleDir, {
        schemaVersion: 1,
        jobId: typeof manifest?.jobId === "string" ? manifest.jobId : "unknown",
        attemptId: typeof manifest?.attemptId === "string" ? manifest.attemptId : "",
        state: "failed",
        command: "",
        finishedAt: Date.now(),
        message: `${message}; worker receipt persistence failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return { ok: false, error: message };
}

/** Resolves the only command form permitted by the worker runtime and queue. */
export function resolveRecipeCommand(manifest: WorkerJobManifest, workDir: string) {
  const recipe = findRunnableRecipe(
    loadBuiltinRecipes(),
    manifest.software,
    "local",
    extname(manifest.inputName),
    manifest.recipeId,
  );
  if (!recipe || !recipe.inputExtensions.includes(extname(manifest.inputName).toLowerCase())) {
    throw new Error("no registered recipe matches manifest");
  }
  const plan = renderRecipePlan(recipe, manifest.inputName, manifest.jobId, workDir);
  if (
    plan.inputName !== manifest.inputName ||
    plan.outputName !== manifest.outputName ||
    plan.command.shell
  ) {
    throw new Error("manifest names or recipe shell mode are not canonical");
  }
  return { ...manifest, command: plan.command };
}

/**
 * Execute the command described in the manifest within a running bundle directory.
 *
 * Layout expectations:
 *   <bundleDir>/
 *     manifest.json
 *     input/         – input files
 *     work/          – working directory for execution
 *     logs/          – stdout.log, stderr.log
 *     artifacts/     – output artifacts
 *     events.jsonl   – worker events
 *     status.json    – status file
 *     pid            – PID file
 *     exit.status    – exit code
 */
export async function executeBundle(
  bundleDir: string,
  suppliedManifest?: unknown,
  spawnAdapter: SpawnAdapter = spawn,
  testObserver?: PhaseObserver,
): Promise<ExecutorResult> {
  const workDir = join(bundleDir, "work");
  const exitStatusPath = join(bundleDir, "exit.status");

  let raw = suppliedManifest;
  if (raw === undefined) {
    try {
      raw = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf-8"));
    } catch (error) {
      return fail(bundleDir, raw, `cannot read manifest: ${(error as Error).message}`);
    }
  }

  const parsed = parseManifest(raw);
  if (!parsed.ok)
    return fail(bundleDir, raw, parsed.errors.map((error) => error.message).join("; "));
  let manifest: ReturnType<typeof resolveRecipeCommand>;
  try {
    manifest = resolveRecipeCommand(parsed.manifest, workDir);
  } catch (error) {
    return fail(bundleDir, raw, (error as Error).message);
  }
  let layout: HeldLayout | undefined;
  let stdoutStream: ReturnType<typeof createWriteStream> | undefined;
  let stderrStream: ReturnType<typeof createWriteStream> | undefined;
  let proc: ReturnType<SpawnAdapter>;
  try {
    layout = materializeInput(bundleDir, manifest.inputName, testObserver);
    verifyDirectory(layout.input, layout.paths.input, "input/");
    verifyDirectory(layout.work, layout.paths.work, "work/");
    verifyDirectory(layout.logs, layout.paths.logs, "logs/");
    verifyDirectory(layout.artifacts, layout.paths.artifacts, "artifacts/");
    const stdoutFd = openSync(
      anchor(layout.logs, "stdout.log"),
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600,
    );
    stdoutStream = createWriteStream("", { fd: stdoutFd, autoClose: true });
    const stderrFd = openSync(
      anchor(layout.logs, "stderr.log"),
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600,
    );
    stderrStream = createWriteStream("", { fd: stderrFd, autoClose: true });
    verifyDirectory(layout.work, layout.paths.work, "work/");
    verifyDirectory(layout.logs, layout.paths.logs, "logs/");
    const cwd = anchor(layout.work);
    writeStatusFile(bundleDir, {
      schemaVersion: 1,
      jobId: manifest.jobId,
      attemptId: manifest.attemptId,
      state: "running",
      command: manifest.command.display,
      startedAt: Date.now(),
    });
    proc = spawnAdapter(manifest.command.program, manifest.command.args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    closeLayout(layout);
    layout = undefined;
  } catch (error) {
    stdoutStream?.destroy();
    stderrStream?.destroy();
    if (layout) closeLayout(layout);
    return fail(bundleDir, raw, `unsafe worker layout: ${(error as Error).message}`);
  }

  const pid = proc.pid ?? undefined;

  // Write PID
  if (pid) {
    atomicWriteFileSync(join(bundleDir, "pid"), `${pid}\n`);
  }

  if (proc.stdout) {
    proc.stdout.pipe(stdoutStream!);
  }
  if (proc.stderr) {
    proc.stderr.pipe(stderrStream!);
  }

  return new Promise<ExecutorResult>((resolve, reject) => {
    let settled = false;
    const settle = (operation: () => Promise<ExecutorResult>) => {
      if (settled) return;
      settled = true;
      void operation().then(resolve, reject);
    };
    const writeFailedStatus = (message: string) => {
      writeStatusFile(bundleDir, {
        schemaVersion: 1,
        jobId: manifest.jobId,
        attemptId: manifest.attemptId,
        state: "failed",
        command: manifest.command.display,
        finishedAt: Date.now(),
        message,
      });
      try {
        writeWorkerReceipt(
          bundleDir,
          createWorkerReceipt({
            jobId: manifest.jobId,
            attemptId: manifest.attemptId,
            manifestDigest: manifestDigest(manifest),
            state: "failed",
            commandDigest: commandDigest(manifest.command.display),
            pid,
            finishedAt: Date.now(),
            artifactDigests: collectArtifactDigests(bundleDir),
          }),
        );
      } catch (error) {
        writeStatusFile(bundleDir, {
          schemaVersion: 1,
          jobId: manifest.jobId,
          attemptId: manifest.attemptId,
          state: "failed",
          command: manifest.command.display,
          finishedAt: Date.now(),
          message: `${message}; worker receipt persistence failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return { ok: false, pid, error: message };
    };
    proc.once("close", (exitCode) =>
      settle(async () => {
        try {
          await settleLogs(stdoutStream!, stderrStream!);
        } catch (error) {
          await settleLogs(stdoutStream!, stderrStream!, true).catch(() => {});
          return writeFailedStatus(`log stream failure: ${(error as Error).message}`);
        }
        const finishedAt = Date.now();

        // Write exit.status
        atomicWriteFileSync(exitStatusPath, `${exitCode ?? -1}\n`);

        // Close streams
        stdoutStream!.end();
        stderrStream!.end();

        const state = exitCode === 0 ? "completed" : "failed";

        // Write status
        writeStatusFile(bundleDir, {
          schemaVersion: 1,
          jobId: manifest.jobId,
          attemptId: manifest.attemptId,
          state,
          pid,
          exitCode: exitCode ?? undefined,
          command: manifest.command.display,
          startedAt: undefined,
          finishedAt,
        });
        writeWorkerReceipt(
          bundleDir,
          createWorkerReceipt({
            jobId: manifest.jobId,
            attemptId: manifest.attemptId,
            manifestDigest: manifestDigest(manifest),
            state,
            commandDigest: commandDigest(manifest.command.display),
            pid,
            exitCode: exitCode ?? undefined,
            finishedAt,
            artifactDigests: collectArtifactDigests(bundleDir),
          }),
        );

        return {
          ok: exitCode === 0,
          pid,
          exitCode,
        };
      }),
    );

    proc.once("error", (err) =>
      settle(async () => {
        await settleLogs(stdoutStream!, stderrStream!, true).catch(() => {});
        return writeFailedStatus(err.message);
      }),
    );
  });
}
