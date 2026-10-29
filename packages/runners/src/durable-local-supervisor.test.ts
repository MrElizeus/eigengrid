import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDurableSupervisorInvocation,
  durableExitStatusPath,
  readDurableExitStatus,
} from "./durable-local-supervisor";

const PROCESS_TREE_FIXTURE = fileURLToPath(
  new URL("./fixtures/durable-process-tree.sh", import.meta.url),
);
const LAUNCHER_FIXTURE = fileURLToPath(new URL("./fixtures/durable-launcher.ts", import.meta.url));
const roots: string[] = [];
const wrapperPids = new Set<number>();
const processGroupIds = new Set<number>();

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "eigengrid-durable-supervisor-"));
  roots.push(root);
  return root;
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (child.pid) wrapperPids.delete(child.pid);
      resolve({ code, signal });
    });
  });
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function readPid(path: string): number {
  const pid = Number(readFileSync(path, "utf8").trim());
  if (!Number.isInteger(pid) || pid < 1) throw new Error(`Invalid fixture PID at ${path}`);
  return pid;
}

function isLiveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }

  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(") ") + 2).split(" ", 1)[0];
      return state !== "Z";
    } catch {
      return false;
    }
  }
  return true;
}

async function expectTreeStopped(stateDir: string): Promise<void> {
  const childPid = readPid(join(stateDir, "child.pid"));
  const grandchildPid = readPid(join(stateDir, "grandchild.pid"));
  processGroupIds.add(childPid);
  await waitFor(
    () => !isLiveProcess(childPid) && !isLiveProcess(grandchildPid),
    `Process tree remained alive: child=${childPid}, grandchild=${grandchildPid}`,
  );
  processGroupIds.delete(childPid);
}

function startSupervisor(input: {
  root: string;
  attemptId: string;
  mode: "natural" | "tree" | "linger" | "stubborn";
  timeoutMs: number;
  payload?: string;
  delay?: string;
}): {
  child: ChildProcess;
  exit: Promise<{ code: number | null; signal: string | null }>;
  stateDir: string;
} {
  const stateDir = join(input.root, "state");
  mkdirSync(stateDir);
  const invocation = buildDurableSupervisorInvocation({
    jobDir: input.root,
    attemptId: input.attemptId,
    stdoutPath: join(input.root, "stdout.log"),
    stderrPath: join(input.root, "stderr.log"),
    command: "/bin/sh",
    args: [PROCESS_TREE_FIXTURE, stateDir, input.mode, input.payload ?? "", input.delay ?? "0"],
    timeoutMs: input.timeoutMs,
  });
  const child = spawn(invocation.command, invocation.args, {
    detached: true,
    stdio: "ignore",
  });
  if (!child.pid) throw new Error("Durable supervisor received no PID");
  wrapperPids.add(child.pid);
  return { child, exit: waitForExit(child), stateDir };
}

afterEach(async () => {
  const cleanupGroupIds = new Set(processGroupIds);
  for (const root of roots) {
    const childPidPath = join(root, "state", "child.pid");
    if (existsSync(childPidPath)) cleanupGroupIds.add(readPid(childPidPath));
  }
  for (const processGroupId of cleanupGroupIds) {
    try {
      process.kill(-processGroupId, "SIGKILL");
    } catch {
      // The process group already exited.
    }
  }
  for (const wrapperPid of wrapperPids) {
    try {
      process.kill(wrapperPid, "SIGKILL");
    } catch {
      // The wrapper already exited.
    }
  }
  processGroupIds.clear();
  wrapperPids.clear();
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable local supervisor", () => {
  test("preserves positional scientific arguments and natural terminal status", async () => {
    const root = createRoot();
    const injectionPath = join(root, "must-not-exist");
    const payload = `$(touch ${injectionPath}); \`quoted\` $HOME ' "`;
    const running = startSupervisor({
      root,
      attemptId: "natural",
      mode: "natural",
      timeoutMs: 5_000,
      payload,
      delay: "0.05",
    });

    const result = await running.exit;

    expect(result).toEqual({ code: 7, signal: null });
    expect(readFileSync(join(running.stateDir, "payload.txt"), "utf8")).toBe(payload);
    expect(existsSync(injectionPath)).toBe(false);
    expect(existsSync(join(running.stateDir, "child.completed"))).toBe(true);
    expect(existsSync(join(running.stateDir, "grandchild.completed"))).toBe(true);
    expect(readFileSync(join(root, "stdout.log"), "utf8")).toBe("result");
    expect(readFileSync(join(root, "stderr.log"), "utf8")).toBe("warning");
    await expectTreeStopped(running.stateDir);
    expect(readDurableExitStatus(root, "natural")).toMatchObject({
      version: 1,
      exitCode: 7,
    });
  });

  test("times out and terminates the complete process group", async () => {
    const root = createRoot();
    const running = startSupervisor({
      root,
      attemptId: "timeout",
      mode: "tree",
      timeoutMs: 100,
    });
    await waitFor(() => existsSync(join(running.stateDir, "ready")), "Fixture never became ready");

    const result = await running.exit;

    expect(result).toEqual({ code: 124, signal: null });
    expect(existsSync(join(running.stateDir, "child.terminated"))).toBe(true);
    expect(existsSync(join(running.stateDir, "grandchild.terminated"))).toBe(true);
    await expectTreeStopped(running.stateDir);
    expect(readDurableExitStatus(root, "timeout")).toMatchObject({ exitCode: 124 });
  }, 8_000);

  test("SIGTERM cancellation terminates descendants before writing status", async () => {
    const root = createRoot();
    const running = startSupervisor({
      root,
      attemptId: "cancel",
      mode: "tree",
      timeoutMs: 5_000,
    });
    await waitFor(() => existsSync(join(running.stateDir, "ready")), "Fixture never became ready");
    if (!running.child.pid) throw new Error("Durable supervisor received no PID");

    process.kill(running.child.pid, "SIGTERM");
    const result = await running.exit;

    expect(result).toEqual({ code: 143, signal: null });
    await expectTreeStopped(running.stateDir);
    expect(readDurableExitStatus(root, "cancel")).toMatchObject({ exitCode: 143 });
  });

  test("escalates to SIGKILL when the process tree ignores SIGTERM", async () => {
    const root = createRoot();
    const running = startSupervisor({
      root,
      attemptId: "stubborn",
      mode: "stubborn",
      timeoutMs: 100,
    });
    await waitFor(() => existsSync(join(running.stateDir, "ready")), "Fixture never became ready");

    const result = await running.exit;

    expect(result).toEqual({ code: 124, signal: null });
    await expectTreeStopped(running.stateDir);
    expect(readDurableExitStatus(root, "stubborn")).toMatchObject({ exitCode: 124 });
  }, 8_000);

  test("cleans up a descendant left behind by natural child completion", async () => {
    const root = createRoot();
    const running = startSupervisor({
      root,
      attemptId: "linger",
      mode: "linger",
      timeoutMs: 5_000,
    });
    await waitFor(
      () => existsSync(join(running.stateDir, "grandchild.pid")),
      "Grandchild PID was not recorded",
    );

    const result = await running.exit;

    expect(result).toEqual({ code: 0, signal: null });
    expect(existsSync(join(running.stateDir, "grandchild.terminated"))).toBe(true);
    await expectTreeStopped(running.stateDir);
    expect(readDurableExitStatus(root, "linger")).toMatchObject({ exitCode: 0 });
  }, 8_000);

  test("survives launcher death and records terminal status", async () => {
    const root = createRoot();
    const stateDir = join(root, "state");
    const wrapperPidPath = join(root, "wrapper.pid");
    mkdirSync(stateDir);
    const invocation = buildDurableSupervisorInvocation({
      jobDir: root,
      attemptId: "launcher-death",
      stdoutPath: join(root, "stdout.log"),
      stderrPath: join(root, "stderr.log"),
      command: "/bin/sh",
      args: [PROCESS_TREE_FIXTURE, stateDir, "natural", "launcher-payload", "0.5"],
      timeoutMs: 5_000,
    });
    const launcher = spawn(
      process.execPath,
      [LAUNCHER_FIXTURE, wrapperPidPath, invocation.command, ...invocation.args],
      { stdio: "ignore" },
    );
    if (!launcher.pid) throw new Error("Launcher received no PID");
    wrapperPids.add(launcher.pid);
    const launcherExit = waitForExit(launcher);
    await waitFor(() => existsSync(wrapperPidPath), "Launcher did not record the wrapper PID");

    const wrapperPid = readPid(wrapperPidPath);
    wrapperPids.add(wrapperPid);
    expect(isLiveProcess(wrapperPid)).toBe(true);
    launcher.kill("SIGKILL");
    const launcherResult = await launcherExit;
    expect(launcherResult).toEqual({ code: null, signal: "SIGKILL" });

    await waitFor(
      () => readDurableExitStatus(root, "launcher-death")?.exitCode === 7,
      "Detached supervisor did not write terminal status",
    );
    await waitFor(() => !isLiveProcess(wrapperPid), "Detached supervisor remained alive");
    wrapperPids.delete(wrapperPid);
    await expectTreeStopped(stateDir);
  }, 8_000);

  test("uses Python os.setsid when the setsid utility is unavailable", async () => {
    const root = createRoot();
    const stateDir = join(root, "state");
    const toolDir = join(root, "tools-with-python-setsid");
    mkdirSync(stateDir);
    mkdirSync(toolDir);
    symlinkSync("/usr/bin/python3", join(toolDir, "python3"));
    symlinkSync("/bin/date", join(toolDir, "date"));
    symlinkSync("/bin/mkdir", join(toolDir, "mkdir"));
    symlinkSync("/bin/mv", join(toolDir, "mv"));
    symlinkSync("/bin/sleep", join(toolDir, "sleep"));
    const invocation = buildDurableSupervisorInvocation({
      jobDir: root,
      attemptId: "python-setsid",
      stdoutPath: join(root, "stdout.log"),
      stderrPath: join(root, "stderr.log"),
      command: "/bin/sh",
      args: [PROCESS_TREE_FIXTURE, stateDir, "natural", "python-fallback", "0.05"],
      timeoutMs: 5_000,
    });
    const child = spawn(invocation.command, invocation.args, {
      detached: true,
      env: { PATH: toolDir },
      stdio: "ignore",
    });

    const result = await waitForExit(child);

    expect(result).toEqual({ code: 7, signal: null });
    expect(readDurableExitStatus(root, "python-setsid")).toMatchObject({ exitCode: 7 });
    await expectTreeStopped(stateDir);
  });

  test("fails closed with terminal status when POSIX session support is unavailable", async () => {
    const root = createRoot();
    const toolDir = join(root, "tools-without-setsid");
    mkdirSync(toolDir);
    symlinkSync("/bin/date", join(toolDir, "date"));
    symlinkSync("/bin/mv", join(toolDir, "mv"));
    const invocation = buildDurableSupervisorInvocation({
      jobDir: root,
      attemptId: "no-setsid",
      stdoutPath: join(root, "stdout.log"),
      stderrPath: join(root, "stderr.log"),
      command: "/bin/false",
      args: [],
      timeoutMs: 5_000,
    });
    const child = spawn(invocation.command, invocation.args, {
      env: { PATH: toolDir },
      stdio: "ignore",
    });

    const result = await waitForExit(child);

    expect(result).toEqual({ code: 125, signal: null });
    expect(readDurableExitStatus(root, "no-setsid")).toMatchObject({ exitCode: 125 });
    expect(readFileSync(join(root, "stderr.log"), "utf8")).toContain(
      "requires setsid or Python os.setsid",
    );
  });

  test("rejects traversal before constructing a status path", () => {
    const root = createRoot();
    expect(() => durableExitStatusPath(root, "../escape")).toThrow("Unsafe attempt ID");
  });
});
