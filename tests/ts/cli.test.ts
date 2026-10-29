import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import type { Config } from "@eigengrid/core";
import { tmpdir } from "os";
import { join } from "path";
import { ApplicationContext } from "../../apps/cli/src/composition";
import type { BackendRegistry, RecipeRegistry } from "../../apps/cli/src/composition";

const suiteRoot = mkdtempSync(join(tmpdir(), "eigengrid-command-suite-"));
afterAll(() => rmSync(suiteRoot, { recursive: true, force: true }));

const state = {
  jobs: [] as Record<string, unknown>[],
  attempts: [] as Record<string, unknown>[],
  artifacts: [] as Record<string, unknown>[],
  pendingCreateJobResolve: null as null | (() => void),
  pendingListJobsResolve: null as null | (() => void),
  pythonBridgeCalls: [] as string[],
  parseCalls: [] as Array<{ software: string; outputPath: string }>,
};

function resetState(): void {
  state.jobs = [
    {
      id: "job-1",
      name: "water.in",
      software: "gaussian",
      inputPath: "water.in",
      workdir: join(suiteRoot, "custom", ".eigengrid", "jobs"),
      status: "created",
    },
  ];
  state.attempts = [];
  state.artifacts = [];
  state.pendingCreateJobResolve = null;
  state.pendingListJobsResolve = null;
  state.pythonBridgeCalls = [];
  state.parseCalls = [];
}

function createPending<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flushMicrotasks(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

const cliTestRecipe = {
  id: "gaussian-opt",
  software: "gaussian",
  description: "Gaussian geometry optimization",
  inputExtensions: [".gjf"],
  commands: {
    local: {
      run: "printf 'stdout\\n'; printf 'stderr\\n' >&2; printf 'result\\n' > {{output}}",
    },
  },
  outputs: { mainLog: "{{basename}}.log" },
  parser: { name: "gaussian" },
  resources: { defaultCores: 8, defaultMemoryGb: 16 },
};

function makeFakeDb() {
  return {
    _provider: "sqlite" as const,
    init: async () => {},
    close: async () => {},
    runMigrations: async () => {},
    getMigrationVersion: async () => 0,
    getProject: async () => null,
    getProjectByName: async () => null,
    resolveProjectId: async () => {
      throw new Error("no");
    },
    createJob: async (job: Record<string, unknown>) => {
      const pending = createPending<void>();
      state.pendingCreateJobResolve = () => {
        state.jobs = [...state.jobs, { ...job, status: "created" }];
        pending.resolve();
      };
      return pending.promise;
    },
    appendEvent: async () => {},
    updateJobStatus: async (jobId: string, status: string) => {
      state.jobs = state.jobs.map((j: Record<string, unknown>) =>
        j.id === jobId ? { ...j, status } : j,
      );
    },
    getJob: async (jobId: string) =>
      state.jobs.find((j: Record<string, unknown>) => j.id === jobId) ?? null,
    listJobs: () => {
      const pending = createPending<Record<string, unknown>[]>();
      state.pendingListJobsResolve = () => pending.resolve([...state.jobs]);
      return pending.promise;
    },
    createJobAttempt: async (attempt: Record<string, unknown>) => {
      state.attempts = [
        ...state.attempts,
        {
          ...attempt,
          status: attempt.status ?? "created",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];
    },
    updateJobAttemptStatus: async (
      attemptId: string,
      status: string,
      updates?: Record<string, unknown>,
    ) => {
      state.attempts = state.attempts.map((a: Record<string, unknown>) =>
        a.id === attemptId ? { ...a, status, updatedAt: Date.now(), ...updates } : a,
      );
    },
    listJobAttempts: async (jobId?: string) =>
      state.attempts.filter((a: Record<string, unknown>) => (jobId ? a.jobId === jobId : true)),
    createArtifact: async (artifact: Record<string, unknown>) => {
      state.artifacts = [...state.artifacts, { ...artifact, createdAt: Date.now() }];
    },
    createArtifactIfAbsent: async (artifact: Record<string, unknown>) => {
      const exists = state.artifacts.some(
        (entry) =>
          entry.jobId === artifact.jobId &&
          entry.attemptId === artifact.attemptId &&
          entry.kind === artifact.kind &&
          entry.path === artifact.path,
      );
      if (exists) return false;
      state.artifacts = [...state.artifacts, { ...artifact, createdAt: Date.now() }];
      return true;
    },
    listArtifacts: async (jobId?: string) =>
      state.artifacts.filter((a: Record<string, unknown>) => (jobId ? a.jobId === jobId : true)),
    materializeTerminalAttempt: async (evidence: {
      jobId: string;
      attemptId: string;
      status: string;
      exitCode?: number;
      finishedAt: number;
    }) => {
      state.attempts = state.attempts.map((attempt) =>
        attempt.id === evidence.attemptId
          ? {
              ...attempt,
              status: evidence.status,
              exitCode: evidence.exitCode,
              finishedAt: evidence.finishedAt,
              updatedAt: Date.now(),
            }
          : attempt,
      );
      state.jobs = state.jobs.map((job) =>
        job.id === evidence.jobId ? { ...job, status: evidence.status } : job,
      );
    },
    resolveJobId: async (id: string) => id,
    // listJobs is defined above with the async-pending return
    updateJobExternalMetadata: async () => {},
    getLogs: async () => [],
    insertEvent: async () => {},
    getEvents: async () => [],
    listEvents: async () => [],
    listJobEvents: async () => [],
    listAttemptEvents: async () => [],
    getTimeline: async () => [],
    saveResult: async () => "",
    listResults: async () => [],
    getLatestResult: async () => null,
    createProposal: async () => "",
    getProposal: async () => null,
    listProposals: async () => [],
    updateProposalStatus: async () => {},
    listPermissions: async () => [],
    createPermission: async () => {},
    removePermission: async () => {},
    createUser: async () => {},
    getUser: async () => null,
    getUserByUsername: async () => null,
    listUsers: async () => [],
    disableUser: async () => {},
    enableUser: async () => {},
    createProject: async () => {},
    listProjects: async () => [],
    archiveProject: async () => {},
    addProjectMember: async () => {},
    removeProjectMember: async () => {},
    listProjectMembers: async () => [],
    listUserProjects: async () => [],
    getProjectQuota: async () => null,
    setProjectQuota: async () => {},
    recordUsage: async () => {},
    getProjectUsage: async () => [],
    getUserUsage: async () => [],
    getProjectAggregatedUsage: async () => ({
      totalCpuThreads: 0,
      totalMemoryMb: 0,
      totalScratchMb: 0,
      totalWalltimeMs: 0,
      jobCount: 0,
    }),
    isUserDisabled: async () => false,
    createNode: async () => {},
    getNode: async () => null,
    listNodes: async () => [],
    removeNode: async () => {},
    resolveNodeId: async (id: string) => id,
    getNodeByName: async () => null,
  };
}

function makeTestContext(db: ReturnType<typeof makeFakeDb>) {
  const backends: BackendRegistry = {
    runners: new Map(),
    get: () => undefined,
    available: () => [],
  };
  const recipeRegistry: RecipeRegistry = {
    recipes: [cliTestRecipe],
    find: (id: string) => (cliTestRecipe.id === id ? cliTestRecipe : undefined),
    findRunnable: (sw: string, rn: string) =>
      sw === cliTestRecipe.software && cliTestRecipe.commands[rn]?.run ? cliTestRecipe : undefined,
  };
  const bridge = {
    parse: async (software: string, outputPath: string) => {
      state.parseCalls.push({ software, outputPath });
      return { ok: true, parser: "gaussian", status: "completed" as const, data: { parsed: true } };
    },
    generate: async () => ({ ok: true }),
    conformers: async () => ({ ok: true, conformers: [] }),
    run: async () => ({ ok: true, stdout: "", stderr: "" }),
  };
  return new ApplicationContext(
    {
      databasePath: join(suiteRoot, "custom", ".eigengrid", "custom.sqlite"),
      dbProvider: "sqlite",
      jobsDir: join(suiteRoot, "custom", ".eigengrid", "jobs"),
      logsDir: join(suiteRoot, "custom", ".eigengrid", "logs"),
      outputsDir: join(suiteRoot, "custom", ".eigengrid", "outputs"),
      pythonCommand: "/opt/custom-python",
      sessionsDir: join(suiteRoot, "custom", ".eigengrid", "sessions"),
    } as Config,
    db,
    backends,
    bridge,
    recipeRegistry,
  );
}

resetState();

const [{ runSubmit }, { runStatus }, { runParse }, { runDoctor }] = await Promise.all([
  import("../../apps/cli/src/commands/submit"),
  import("../../apps/cli/src/commands/status"),
  import("../../apps/cli/src/commands/parse"),
  import("../../apps/cli/src/commands/doctor"),
]);

describe("CLI wiring", () => {
  it("submit awaits async db writes through context", async () => {
    resetState();
    const workspace = mkdtempSync(join(tmpdir(), "eigengrid-command-async-"));
    const inputPath = join(workspace, "water.gjf");
    writeFileSync(inputPath, "#p hf/sto-3g\nwater\n");

    const db = makeFakeDb();
    const ctx = makeTestContext(db);

    const handlerPromise = runSubmit(
      { software: "gaussian", input: [inputPath], runner: "local" },
      {
        createContext: async () => ctx,
        runnerFactory: async () => ({ ok: true, message: "started" }),
      },
    );
    let settled = false;
    void handlerPromise
      .finally(() => {
        settled = true;
      })
      .catch(() => {});

    await flushMicrotasks();

    // Recipe selection should create the job asynchronously.
    expect(settled).toBe(false);

    state.pendingCreateJobResolve?.();
    await handlerPromise;

    rmSync(workspace, { recursive: true, force: true });
  });

  it("submit wires local runner execution from builtin recipes", async () => {
    resetState();
    const workspace = mkdtempSync(join(tmpdir(), "eigengrid-command-local-"));
    const inputPath = join(workspace, "water.gjf");
    writeFileSync(inputPath, "#p hf/sto-3g\nwater\n");

    const db = makeFakeDb();
    const ctx = makeTestContext(db);

    const handlerPromise = runSubmit(
      { software: "gaussian", input: [inputPath], runner: "local" },
      {
        createContext: async () => ctx,
      },
    );
    let settled = false;
    void handlerPromise
      .finally(() => {
        settled = true;
      })
      .catch(() => {});

    await flushMicrotasks();

    expect(settled).toBe(false);

    state.pendingCreateJobResolve?.();
    await handlerPromise;

    for (let i = 0; i < 120 && state.attempts[0]?.status !== "completed"; i += 1) {
      await flushMicrotasks();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(state.jobs.some((job) => job.status === "completed")).toBe(true);
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]).toMatchObject({
      jobId: expect.any(String),
      runner: "local",
      status: "completed",
      exitCode: 0,
      startedAt: expect.any(Number),
      finishedAt: expect.any(Number),
    });
    expect(state.artifacts.some((artifact) => artifact.kind === "input")).toBe(true);
    expect(state.artifacts.some((artifact) => artifact.label === "stdout")).toBe(true);
    expect(state.artifacts.some((artifact) => artifact.label === "stderr")).toBe(true);

    rmSync(workspace, { recursive: true, force: true });
  });

  it("status awaits async db reads through context", async () => {
    resetState();

    const db = makeFakeDb();
    const ctx = makeTestContext(db);

    const handlerPromise = runStatus({}, { createContext: async () => ctx });
    let settled = false;
    void handlerPromise
      .finally(() => {
        settled = true;
      })
      .catch(() => {});

    await flushMicrotasks();

    expect(settled).toBe(false);

    state.pendingListJobsResolve?.();
    await handlerPromise;
  });

  it("parse delegates to the ApplicationContext parser bridge", async () => {
    resetState();

    const db = makeFakeDb();
    const ctx = makeTestContext(db);

    await runParse(
      { software: "gaussian", outputPath: "out.log" },
      {
        createContext: async () => ctx,
      },
    );

    // The fake bridge should have recorded exactly one parse call with the expected args
    expect(state.parseCalls).toHaveLength(1);
    expect(state.parseCalls[0]).toEqual({ software: "gaussian", outputPath: "out.log" });
  });

  it("doctor checks python with the configured command", async () => {
    resetState();

    const mockExecutor = {
      runSync(command: string, args: string[]) {
        state.pythonBridgeCalls.push(`${command} ${args.join(" ")}`);
        return {
          status: 0,
          stdout: Buffer.from("python3 --version"),
          stderr: Buffer.alloc(0),
        };
      },
      run: async () => {
        throw new Error("not implemented");
      },
      spawn: () => {
        throw new Error("not implemented");
      },
    };

    const mockConfig: Config = {
      databasePath: join(suiteRoot, "custom", ".eigengrid", "custom.sqlite"),
      dbProvider: "sqlite",
      jobsDir: join(suiteRoot, "custom", ".eigengrid", "jobs"),
      logsDir: join(suiteRoot, "custom", ".eigengrid", "logs"),
      outputsDir: join(suiteRoot, "custom", ".eigengrid", "outputs"),
      pythonCommand: "/opt/custom-python",
      sessionsDir: join(suiteRoot, "custom", ".eigengrid", "sessions"),
    };

    await runDoctor({}, {
      loadConfig: async () => mockConfig,
      executor: mockExecutor,
      readRoleFromConfig: () => undefined,
      getEigenGridDir: () => join(suiteRoot, "default", ".eigengrid"),
      createDatabase: () => ({
        async init() {},
        async close() {},
        async listNodes() {
          return [];
        },
      }),
    } as never);

    // Doctor legacy path calls loadConfig then runs pythonCommand --version via executor
    expect(state.pythonBridgeCalls).toContain("/opt/custom-python --version");
  });
});
