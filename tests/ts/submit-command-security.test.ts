import { describe, expect, test, mock } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { submitJob } from "../../apps/cli/src/services/submit-service";
import { runSubmit } from "../../apps/cli/src/commands/submit";
import { ApplicationContext } from "../../apps/cli/src/composition";
import type { BackendRegistry, RecipeRegistry } from "../../apps/cli/src/composition";
import type { Recipe } from "@eigengrid/recipes";

const recipe: Recipe = {
  id: "gaussian-safe",
  software: "gaussian",
  description: "test",
  inputExtensions: [".gjf"],
  commands: { local: { run: "g16 < {{input}} > {{output}}" } },
  outputs: { mainLog: "{{basename}}.log" },
  parser: { name: "gaussian" },
  resources: { defaultCores: 1, defaultMemoryGb: 1 },
};

function dependencies() {
  return {
    db: {
      createJob: mock(async () => {}),
      appendEvent: mock(async () => {}),
    } as any,
    config: { jobsDir: "/tmp" } as any,
    recipes: [recipe],
    runnerFactory: mock(async () => ({ ok: true })),
  };
}

function makeContext(db: Record<string, unknown>, root: string) {
  const backends: BackendRegistry = {
    runners: new Map(),
    get: () => undefined,
    available: () => [],
  };
  const recipeRegistry: RecipeRegistry = {
    recipes: [recipe],
    find: (id: string) => (recipe.id === id ? recipe : undefined),
    findRunnable: (sw: string, _rn: string, _ext: string, recipeId?: string) =>
      recipeId
        ? recipe.id === recipeId
          ? recipe
          : undefined
        : sw === recipe.software
          ? recipe
          : undefined,
  };
  const bridge = {
    parse: async () => ({ ok: true, parser: "gaussian", status: "completed" as const, data: {} }),
    generate: async () => ({ ok: true }),
    conformers: async () => ({ ok: true, conformers: [] }),
    run: async () => ({ ok: true, stdout: "", stderr: "" }),
  };
  return new ApplicationContext(
    { databasePath: join(root, "db"), dbProvider: "sqlite", jobsDir: root } as any,
    db as any,
    backends,
    bridge,
    recipeRegistry,
  );
}

describe("submitJob local rejection", () => {
  test("rejects explicit runner local", async () => {
    const deps = dependencies();
    const result = await submitJob(
      { software: "gaussian", inputPath: "/tmp/test.gjf", runner: "local" },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("submitJob");
    expect(result.message).toContain("executeLocal");
  });

  test("rejects omitted runner", async () => {
    const deps = dependencies();
    const result = await submitJob({ software: "gaussian", inputPath: "/tmp/test.gjf" }, deps);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("submitJob");
  });

  test("accepts explicit ssh runner", async () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-submit-ssh-"));
    const input = join(root, "test.gjf");
    writeFileSync(input, "test");
    const deps = dependencies();
    try {
      const result = await submitJob(
        { software: "gaussian", inputPath: input, runner: "ssh" },
        deps,
      );
      expect(result.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("submitJob input boundary", () => {
  test("rejects malformed and non-file input before persistence or execution", async () => {
    const deps = dependencies();
    const result = await submitJob(
      { software: "gaussian", inputPath: "../missing.gjf", runner: "ssh" },
      deps,
    );

    expect(result.ok).toBe(false);
    expect(deps.db.createJob).not.toHaveBeenCalled();
    expect(deps.db.appendEvent).not.toHaveBeenCalled();
    expect(deps.runnerFactory).not.toHaveBeenCalled();
  });

  test("canonicalizes valid hostile-looking filenames before persistence and execution", async () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-submit-safe-"));
    const input = join(root, "naïve ; $(nope) `nope`.gjf");
    writeFileSync(input, "test");
    const deps = dependencies();
    try {
      const result = await submitJob(
        { software: "gaussian", inputPath: input, runner: "ssh" },
        deps,
      );
      expect(result.ok).toBe(true);
      expect(deps.db.createJob.mock.calls[0][0].inputPath).toBe(realpathSync(input));
      expect(deps.runnerFactory.mock.calls[0][0].job.inputPath).toBe(realpathSync(input));
      expect(deps.runnerFactory.mock.calls[0][0].args[1]).not.toContain("naïve");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("SSH submission path boundary", () => {
  function createFakeDb() {
    return {
      _provider: "sqlite" as const,
      init: mock(async () => {}),
      close: mock(async () => {}),
      runMigrations: mock(async () => {}),
      getMigrationVersion: mock(async () => 0),
      createJob: mock(async () => {}),
      appendEvent: mock(async () => {}),
      createJobAttempt: mock(async () => {}),
      getJob: mock(async () => null),
      resolveJobId: mock(async (id: string) => id),
      listJobs: mock(async () => []),
      updateJobStatus: mock(async () => {}),
      updateJobExternalMetadata: mock(async () => {}),
      listJobAttempts: mock(async () => []),
      createArtifact: mock(async () => {}),
      listArtifacts: mock(async () => []),
      getLogs: mock(async () => []),
      insertEvent: mock(async () => {}),
      getEvents: mock(async () => []),
      listEvents: mock(async () => []),
      listJobEvents: mock(async () => []),
      listAttemptEvents: mock(async () => []),
      getTimeline: mock(async () => []),
      saveResult: mock(async () => ""),
      listResults: mock(async () => []),
      getLatestResult: mock(async () => null),
      createProposal: mock(async () => ""),
      getProposal: mock(async () => null),
      listProposals: mock(async () => []),
      updateProposalStatus: mock(async () => {}),
      listPermissions: mock(async () => []),
      createPermission: mock(async () => {}),
      removePermission: mock(async () => {}),
      createUser: mock(async () => {}),
      getUser: mock(async () => null),
      getUserByUsername: mock(async () => null),
      listUsers: mock(async () => []),
      disableUser: mock(async () => {}),
      enableUser: mock(async () => {}),
      createProject: mock(async () => {}),
      getProject: mock(async () => null),
      getProjectByName: mock(async () => null),
      listProjects: mock(async () => []),
      archiveProject: mock(async () => {}),
      resolveProjectId: mock(async (id: string) => id),
      addProjectMember: mock(async () => {}),
      removeProjectMember: mock(async () => {}),
      listProjectMembers: mock(async () => []),
      listUserProjects: mock(async () => []),
      getProjectQuota: mock(async () => null),
      setProjectQuota: mock(async () => {}),
      recordUsage: mock(async () => {}),
      getProjectUsage: mock(async () => []),
      getUserUsage: mock(async () => []),
      getProjectAggregatedUsage: mock(async () => ({
        totalCpuThreads: 0,
        totalMemoryMb: 0,
        totalScratchMb: 0,
        totalWalltimeMs: 0,
        jobCount: 0,
      })),
      isUserDisabled: mock(async () => false),
      createNode: mock(async () => {}),
      getNode: mock(async () => null),
      listNodes: mock(async () => []),
      removeNode: mock(async () => {}),
      resolveNodeId: mock(async (id: string) => id),
      getNodeByName: mock(async () => null),
    };
  }

  test("rejects hostile canonical input before direct SSH or daemon DB/staging effects", async () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-ssh-safe-"));
    const input = join(root, "hostile;touch-sentinel.gjf");
    writeFileSync(input, "test");
    const db = createFakeDb();
    const ctx = makeContext(db, root);
    const originalLog = console.log;
    console.log = () => {};
    try {
      await runSubmit(
        { software: "gaussian", input: [input], runner: "ssh", "ssh-host": "example.test" } as any,
        { createContext: async () => ctx } as any,
      );
      await runSubmit(
        {
          software: "gaussian",
          input: [input],
          runner: "ssh",
          mode: "daemon",
          "ssh-host": "example.test",
        } as any,
        { createContext: async () => ctx } as any,
      );
      expect(db.createJob).not.toHaveBeenCalled();
      expect(db.appendEvent).not.toHaveBeenCalled();
      expect(db.createJobAttempt).not.toHaveBeenCalled();
    } finally {
      console.log = originalLog;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects unsafe remote scratch paths before daemon effects", async () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-ssh-remote-safe-"));
    const input = join(root, "safe.gjf");
    writeFileSync(input, "test");
    const db = createFakeDb();
    const ctx = makeContext(db, root);
    const originalLog = console.log;
    console.log = () => {};
    try {
      await runSubmit(
        {
          software: "gaussian",
          input: [input],
          runner: "ssh",
          mode: "daemon",
          "ssh-host": "example.test",
          "ssh-remote-dir": "/scratch/unsafe;touch",
        } as any,
        { createContext: async () => ctx } as any,
      );
      expect(db.createJob).not.toHaveBeenCalled();
      expect(db.appendEvent).not.toHaveBeenCalled();
      expect(db.createJobAttempt).not.toHaveBeenCalled();
    } finally {
      console.log = originalLog;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an invalid daemon node before durable effects or staging", async () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-daemon-manifest-"));
    const input = join(root, "safe.gjf");
    writeFileSync(input, "test");
    const db = createFakeDb();
    const ctx = makeContext(db, root);
    const originalLog = console.log;
    console.log = () => {};
    try {
      await runSubmit(
        {
          software: "gaussian",
          input: [input],
          runner: "ssh",
          mode: "daemon",
          "ssh-host": "invalid host",
          "ssh-remote-dir": "/scratch/eigengrid",
        } as any,
        { createContext: async () => ctx } as any,
      );
      expect(db.createJob).not.toHaveBeenCalled();
      expect(db.appendEvent).not.toHaveBeenCalled();
      expect(db.createJobAttempt).not.toHaveBeenCalled();
    } finally {
      console.log = originalLog;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
