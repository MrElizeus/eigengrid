import { afterEach, describe, expect, test, mock } from "bun:test";
import { generateBashWrapper, readEffectIntent, SshRunner } from "@eigengrid/runners";
import type { SshRunnerConfig, Job, RunResult } from "@eigengrid/core";
import { mkdtempSync, writeFileSync, rmSync, existsSync, chmodSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

const temporaryJobRoots: string[] = [];
afterEach(() => {
  for (const directory of temporaryJobRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeJob(overrides: Partial<Job> = {}): Job {
  const workdir = overrides.workdir ?? mkdtempSync(join(tmpdir(), "eigengrid-ssh-job-"));
  if (overrides.workdir === undefined) temporaryJobRoots.push(workdir);
  return {
    id: "test-job-001",
    name: "test-input.gjf",
    software: "gaussian",
    inputPath: join(workdir, "test-input.gjf"),
    workdir,
    outputPath: join(workdir, "test-input.log"),
    status: "created",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeConfig(): SshRunnerConfig {
  return {
    host: "remote-node-1",
    port: 22,
    username: "eigengrid-run",
    remoteScratchDir: "/scratch/eigengrid",
  };
}

function makeStubDb() {
  const attempts: Record<string, unknown>[] = [];
  const artifacts: Record<string, unknown>[] = [];

  return {
    createJobAttempt: mock(async (a: Record<string, unknown>) => {
      attempts.push(a);
    }),
    updateJobStatus: mock(async () => {}),
    updateJobAttemptStatus: mock(async () => {}),
    listJobAttempts: mock(async () => attempts),
    createArtifact: mock(async (a: Record<string, unknown>) => {
      artifacts.push(a);
    }),
    listArtifacts: mock(async () => artifacts),
    appendEvent: mock(async () => {}),
  };
}

/**
 * Create a mock executor that returns success for all SSH/SCP operations.
 */
function makeMockExecutor(
  overrides: Record<string, (cmd: string, args: string[]) => Promise<Partial<RunResult>>> = {},
) {
  const defaultHandler = async (_cmd: string, _args: string[]) => ({
    exitCode: 0,
    stdout: "ok",
    stderr: "",
  });

  return {
    run: mock(async (cmd: string, args?: string[], _opts?: any): Promise<RunResult> => {
      const handler = overrides[cmd] ?? defaultHandler;
      const result = await handler(cmd, args ?? []);
      return {
        command: cmd,
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout ?? "ok",
        stderr: result.stderr ?? "",
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
      };
    }),
    spawn: mock(() => {
      throw new Error("not implemented");
    }),
    runSync: mock(() => ({ status: 0, stdout: Buffer.from("ok"), stderr: Buffer.alloc(0) })),
  };
}

// ────────────────────────────────────────────────────────────
// wrapper.ts
// ────────────────────────────────────────────────────────────

describe("generateBashWrapper", () => {
  test("produces a valid bash script with exec + trap", () => {
    const script = generateBashWrapper("g16", ["input.gjf"]);
    expect(script).toContain("#!/bin/bash");
    expect(script).toContain("set -u");
    expect(script).toContain('echo "$$" >');
    expect(script).toContain("job.pid");
    expect(script).toContain("cleanup()");
    expect(script).toContain("exit.status");
    expect(script).toContain("trap cleanup EXIT");
    expect(script).toContain("exec 'g16' 'input.gjf' >");
    expect(script).toContain("stdout.log");
    expect(script).toContain("stderr.log");
  });

  test("escapes double quotes in args", () => {
    const script = generateBashWrapper("orca", ["input with spaces.inp"]);
    expect(script).toContain("'input with spaces.inp'");
  });

  test("handles command with no args", () => {
    const script = generateBashWrapper("xtb", []);
    expect(script).toContain("exec 'xtb' >");
    expect(script).not.toContain("' '");
  });

  test("treats shell syntax in command arguments as data", () => {
    const workspace = mkdtempSync(join(tmpdir(), "eigengrid-wrapper-safe-"));
    const sentinel = join(workspace, "sentinel");
    const wrapper = join(workspace, "run.sh");
    const hostile = `value $(touch ${sentinel}) \`touch ${sentinel}\`; semicolon`;
    writeFileSync(wrapper, generateBashWrapper("printf", ["%s", hostile]));
    chmodSync(wrapper, 0o700);
    try {
      const result = Bun.spawnSync([wrapper]);
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(workspace, "stdout.log"), "utf8")).toBe(hostile);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────
// SshRunner
// ────────────────────────────────────────────────────────────

describe("SshRunner", () => {
  test("constructor stores config", () => {
    const config = makeConfig();
    const runner = new SshRunner(config);
    expect(runner.kind).toBe("ssh");
  });

  test("stage throws if no database provided", async () => {
    const runner = new SshRunner(makeConfig());
    await expect(runner.stage(makeJob())).rejects.toThrow("database");
  });

  test("start returns error if no database provided", async () => {
    const runner = new SshRunner(makeConfig());
    await expect(runner.start(makeJob())).rejects.toThrow("database");
  });

  test("stage creates attempt with displayCommand when engine is configured", async () => {
    const db = makeStubDb();
    const executor = makeMockExecutor();

    // Need to simulate a real SCP operation for stage to copy files
    const runner = new SshRunner(makeConfig(), db, {
      engines: {
        gaussian: {
          command: "g16",
          args: ["input.gjf"],
          displayCommand: "g16 input.gjf > output.log",
        },
      },
      executor: executor as any,
    });

    const workspace = mkdtempSync(join(tmpdir(), "eigengrid-ssh-test-"));
    const inputPath = join(workspace, "water.gjf");
    writeFileSync(inputPath, "#p hf/sto-3g\nwater\n");

    try {
      const job = makeJob({ inputPath, workdir: workspace });
      const result = await runner.stage(job);

      expect(result.ok).toBe(true);

      // Check that the attempt was created with displayCommand
      const attemptCalls = db.createJobAttempt.mock.calls;
      expect(attemptCalls.length).toBeGreaterThanOrEqual(1);
      const attemptArg = attemptCalls[0]?.[0] as Record<string, unknown>;
      expect(attemptArg.command).toBe("g16 input.gjf > output.log");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("stage with engine registers input artifact", async () => {
    const db = makeStubDb();
    const executor = makeMockExecutor();

    const runner = new SshRunner(makeConfig(), db, {
      engines: {
        gaussian: {
          command: "g16",
          args: ["input.gjf"],
          displayCommand: "g16 input.gjf > output.log",
        },
      },
      executor: executor as any,
    });

    const workspace = mkdtempSync(join(tmpdir(), "eigengrid-ssh-artifact-"));
    const inputPath = join(workspace, "water.gjf");
    writeFileSync(inputPath, "#p hf/sto-3g\nwater\n");

    try {
      const job = makeJob({ inputPath, workdir: workspace });
      const result = await runner.stage(job);

      expect(result.ok).toBe(true);

      // Check that input artifact was registered
      const artifactCalls = db.createArtifact.mock.calls;
      const inputArtifacts = artifactCalls.filter((call: any) => call[0]?.kind === "input");
      expect(inputArtifacts.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("start uses engine command and succeeds via mocked executor", async () => {
    const db = makeStubDb();
    const executor = makeMockExecutor({
      ssh: async (_cmd, args) => ({
        exitCode: 0,
        stdout: args.at(-1)?.includes("job.pid") ? "12345" : "ok",
        stderr: "",
      }),
    });

    const runner = new SshRunner(makeConfig(), db, {
      engines: {
        gaussian: {
          command: "g16",
          args: ["water.gjf"],
          displayCommand: "g16 water.gjf > water.out",
        },
      },
      executor: executor as any,
    });

    const workspace = mkdtempSync(join(tmpdir(), "eigengrid-ssh-start-"));
    const inputPath = join(workspace, "water.gjf");
    writeFileSync(inputPath, "#p hf/sto-3g\nwater\n");

    try {
      // Need to stage first to create the directory and attempt
      const job = makeJob({ inputPath, workdir: workspace });
      const stageResult = await runner.stage(job);
      expect(stageResult.ok).toBe(true);

      const result = await runner.start(job);
      expect(result.ok).toBe(true);
      expect(result.command).toContain("g16");
      expect(result.command).toContain("water.gjf");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 10_000);

  test("fetch downloads remote files and returns ok", async () => {
    const db = makeStubDb();
    const executor = makeMockExecutor({
      scp: async (_cmd, args) => {
        const destination = args.at(-1);
        if (destination) writeFileSync(destination, "artifact\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const runner = new SshRunner(makeConfig(), db, {
      engines: {
        gaussian: {
          command: "g16",
          args: ["input.gjf"],
        },
      },
      executor: executor as any,
    });

    const workspace = mkdtempSync(join(tmpdir(), "eigengrid-ssh-fetch-"));
    const inputPath = join(workspace, "water.gjf");
    writeFileSync(inputPath, "#p hf/sto-3g\nwater\n");

    try {
      const job = makeJob({ inputPath, workdir: workspace });
      const result = await runner.fetch(job);

      // With mocked executor returning success, fetch should succeed
      expect(result.ok).toBe(true);

      // Check local dir was created
      const localDir = join(workspace, job.id);
      expect(existsSync(localDir)).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("fetch fails closed when a required remote artifact cannot be copied", async () => {
    const db = makeStubDb();
    const executor = makeMockExecutor({
      scp: async () => ({ exitCode: 1, stdout: "", stderr: "remote file missing" }),
    });
    const runner = new SshRunner(makeConfig(), db, {
      engines: { gaussian: { command: "g16", args: ["input.gjf"] } },
      executor: executor as any,
    });
    const workspace = mkdtempSync(join(tmpdir(), "eigengrid-ssh-fetch-fail-"));
    const inputPath = join(workspace, "water.gjf");
    writeFileSync(inputPath, "#p hf/sto-3g\nwater\n");
    try {
      const result = await runner.fetch(makeJob({ inputPath, workdir: workspace }));
      expect(result).toMatchObject({ ok: false, failureDisposition: "termination-unknown" });
      expect(result.message).toContain("artifact collection incomplete");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("status returns pending for fresh job", async () => {
    const db = makeStubDb();
    const executor = makeMockExecutor({
      ssh: async (_cmd, _args) => ({
        exitCode: 0,
        stdout: "PENDING",
        stderr: "",
      }),
    });

    const runner = new SshRunner(makeConfig(), db, {
      engines: { gaussian: { command: "g16", args: ["input.gjf"] } },
      executor: executor as any,
    });

    const status = await runner.status(makeJob());
    expect(status.status).toBe("unknown");
    expect(status.message).toContain("PENDING");
  });

  test("status returns completed with exit code 0", async () => {
    const db = makeStubDb();
    const executor = makeMockExecutor({
      ssh: async (_cmd, _args) => ({
        exitCode: 0,
        stdout: "EXIT:0",
        stderr: "",
      }),
    });

    const runner = new SshRunner(makeConfig(), db, {
      engines: { gaussian: { command: "g16", args: ["input.gjf"] } },
      executor: executor as any,
    });

    const status = await runner.status(makeJob());
    expect(status.status).toBe("completed");
    expect(status.exitCode).toBe(0);
  });

  test("status returns failed with non-zero exit code", async () => {
    const db = makeStubDb();
    const executor = makeMockExecutor({
      ssh: async (_cmd, _args) => ({
        exitCode: 0,
        stdout: "EXIT:1",
        stderr: "",
      }),
    });

    const runner = new SshRunner(makeConfig(), db, {
      engines: { gaussian: { command: "g16", args: ["input.gjf"] } },
      executor: executor as any,
    });

    const status = await runner.status(makeJob());
    expect(status.status).toBe("failed");
    expect(status.exitCode).toBe(1);
  });

  test("status returns running when PID is active", async () => {
    const db = makeStubDb();
    const executor = makeMockExecutor({
      ssh: async (_cmd, _args) => ({
        exitCode: 0,
        stdout: "RUNNING:12345",
        stderr: "",
      }),
    });

    const runner = new SshRunner(makeConfig(), db, {
      engines: { gaussian: { command: "g16", args: ["input.gjf"] } },
      executor: executor as any,
    });

    const status = await runner.status(makeJob());
    expect(status.status).toBe("running");
    expect(status.message).toContain("12345");
  });

  test("stop kills remote process and cancels attempt", async () => {
    const db = makeStubDb();
    const executor = makeMockExecutor({
      ssh: async (_cmd, _args) => ({
        exitCode: 0,
        stdout: "killed",
        stderr: "",
      }),
    });

    // Add an attempt so stop can find it
    await db.createJobAttempt({
      id: "attempt-1",
      jobId: "test-job-001",
      runner: "ssh",
      command: "g16 input.gjf",
      cwd: "/scratch/eigengrid/test-job-001",
    });

    const runner = new SshRunner(makeConfig(), db, {
      engines: { gaussian: { command: "g16", args: ["input.gjf"] } },
      executor: executor as any,
    });

    const result = await runner.stop(makeJob());
    expect(result.ok).toBe(true);

    // Check that attempt status was updated to cancelled
    const updateCalls = db.updateJobAttemptStatus.mock.calls;
    const cancelledCall = updateCalls.find(
      (call: any) => call[0] === "attempt-1" && call[1] === "cancelled",
    );
    expect(cancelledCall).toBeDefined();
  });

  test("stop does not cancel local state when the remote signal fails", async () => {
    const db = makeStubDb();
    const executor = makeMockExecutor({
      ssh: async (_cmd, _args) => ({
        exitCode: 1,
        stdout: "",
        stderr: "permission denied",
      }),
    });

    await db.createJobAttempt({
      id: "attempt-stop-failed",
      jobId: "test-job-001",
      runner: "ssh",
      command: "g16 input.gjf",
      cwd: "/scratch/eigengrid/test-job-001",
    });

    const runner = new SshRunner(makeConfig(), db, {
      engines: { gaussian: { command: "g16", args: ["input.gjf"] } },
      executor: executor as any,
    });

    const result = await runner.stop(makeJob());
    expect(result.ok).toBe(false);
    expect(db.updateJobAttemptStatus).not.toHaveBeenCalled();
    expect(db.updateJobStatus).not.toHaveBeenCalled();
  });

  test("does not terminalize a remote attempt when launch acknowledgement is ambiguous", async () => {
    const db = makeStubDb();
    const executor = makeMockExecutor({
      ssh: async (_cmd, args) => {
        const remoteCommand = args.at(-1) ?? "";
        if (remoteCommand.includes("nohup bash")) {
          return { exitCode: 1, stdout: "", stderr: "transport lost after launch" };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    });
    const runner = new SshRunner(makeConfig(), db, {
      engines: { gaussian: { command: "g16", args: ["input.gjf"] } },
      executor: executor as any,
    });
    const workspace = mkdtempSync(join(tmpdir(), "eigengrid-ssh-ambiguous-"));
    const inputPath = join(workspace, "water.gjf");
    writeFileSync(inputPath, "#p hf/sto-3g\nwater\n");
    try {
      const job = makeJob({ inputPath, workdir: workspace });
      expect((await runner.stage(job)).ok).toBe(true);
      const result = await runner.start(job);
      expect(result).toMatchObject({ ok: false, failureDisposition: "termination-unknown" });
      expect(db.updateJobAttemptStatus.mock.calls.some((call: any) => call[1] === "failed")).toBe(
        false,
      );
      expect(db.updateJobStatus.mock.calls.some((call: any) => call[1] === "failed")).toBe(false);
      const attempts = await db.listJobAttempts(job.id);
      const intent = readEffectIntent(
        join(workspace, job.id, `effect-intent-${attempts[0]!.id}.json`),
      );
      expect(intent?.state).toBe("ambiguous");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 10_000);

  test("stage fails gracefully when SSH connection fails", async () => {
    const db = makeStubDb();
    const executor = makeMockExecutor({
      ssh: async (_cmd, _args) => ({
        exitCode: 1,
        stdout: "",
        stderr: "ssh: connect to host remote-node-1 port 22: Connection refused",
      }),
    });

    const runner = new SshRunner(makeConfig(), db, {
      engines: {
        gaussian: {
          command: "g16",
          args: ["input.gjf"],
        },
      },
      executor: executor as any,
    });

    const workspace = mkdtempSync(join(tmpdir(), "eigengrid-ssh-fail-"));
    const inputPath = join(workspace, "water.gjf");
    writeFileSync(inputPath, "#p hf/sto-3g\nwater\n");

    try {
      const job = makeJob({ inputPath, workdir: workspace });
      const result = await runner.stage(job);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Connection refused");
      expect(
        db.updateJobAttemptStatus.mock.calls.some((call: any) => call[0] && call[1] === "failed"),
      ).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
