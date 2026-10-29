import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ApplicationContext } from "../../apps/cli/src/composition";
import type { BackendRegistry, RecipeRegistry } from "../../apps/cli/src/composition";

const suiteRoot = mkdtempSync(join(tmpdir(), "eigengrid-command-submit-slurm-suite-"));
afterAll(() => rmSync(suiteRoot, { recursive: true, force: true }));

const state = {
  createdJobs: [] as Array<{
    id: string;
    name: string;
    software: string;
    inputPath: string;
    workdir: string;
    projectId?: string;
    backend?: string;
  }>,
  externalMetadata: [] as Array<{ jobId: string; metadata: Record<string, unknown> }>,
  events: [] as Array<Record<string, unknown>>,
  attempts: [] as Array<Record<string, unknown>>,
  scriptPaths: [] as string[],
  buildCalls: [] as Array<{ command: string; opts: Record<string, unknown> }>,
  consoleLogs: [] as string[],
  jobId: "",
  jobsDir: join(suiteRoot, "jobs"),
};

function resetState(): void {
  state.createdJobs = [];
  state.externalMetadata = [];
  state.events = [];
  state.attempts = [];
  state.scriptPaths = [];
  state.buildCalls = [];
  state.consoleLogs = [];
  state.jobId = "";
}

const slurmRecipe = {
  id: "orca-opt",
  software: "orca",
  description: "ORCA geometry optimization",
  inputExtensions: [".inp"],
  commands: {
    local: { run: "orca {{input}} > {{output}}" },
    slurm: { run: "orca {{input}} > {{output}}" },
  },
  outputs: { mainLog: "{{basename}}.out" },
  parser: { name: "orca" },
  resources: { defaultCores: 8, defaultMemoryGb: 16 },
};

function createFakeDatabase() {
  return {
    _provider: "sqlite" as const,
    async init() {},
    async close() {},
    async runMigrations() {},
    async getMigrationVersion() {
      return 0;
    },
    async getProject(projectId: string) {
      return projectId === "proj-slurm" ? { id: "proj-slurm", name: "slurm-accounting" } : null;
    },
    async getProjectByName(name: string) {
      return name === "slurm-accounting" ? { id: "proj-slurm", name } : null;
    },
    async resolveProjectId(prefix: string) {
      if (prefix === "proj-slurm") return "proj-slurm";
      throw new Error(`Project not found: ${prefix}`);
    },
    async createJob(job: {
      id: string;
      name: string;
      software: string;
      inputPath: string;
      workdir: string;
      projectId?: string;
      backend?: string;
    }) {
      state.createdJobs.push(job);
      state.jobId = job.id;
    },
    async appendEvent(event: Record<string, unknown>) {
      state.events.push(event);
    },
    async updateJobExternalMetadata(jobId: string, metadata: Record<string, unknown>) {
      state.externalMetadata.push({ jobId, metadata });
    },
    // DatabaseLike stubs
    async getJob() {
      return null;
    },
    async resolveJobId(id: string) {
      return id;
    },
    async listJobs() {
      return [];
    },
    async updateJobStatus() {},
    async listJobAttempts() {
      return state.attempts;
    },
    async createJobAttempt(attempt: Record<string, unknown>) {
      state.attempts.push({ ...attempt, status: attempt.status ?? "created" });
    },
    async updateJobAttemptStatus(
      attemptId: string,
      status: string,
      updates: Record<string, unknown> = {},
    ) {
      const attempt = state.attempts.find((entry) => entry.id === attemptId);
      if (attempt) Object.assign(attempt, { status, ...updates });
    },
    async createArtifact() {},
    async listArtifacts() {
      return [];
    },
    async getLogs() {
      return [];
    },
    async insertEvent() {},
    async getEvents() {
      return [];
    },
    async listEvents() {
      return [];
    },
    async listJobEvents() {
      return [];
    },
    async listAttemptEvents() {
      return [];
    },
    async getTimeline() {
      return [];
    },
    async saveResult() {
      return "";
    },
    async listResults() {
      return [];
    },
    async getLatestResult() {
      return null;
    },
    async createProposal() {
      return "";
    },
    async getProposal() {
      return null;
    },
    async listProposals() {
      return [];
    },
    async updateProposalStatus() {},
    async listPermissions() {
      return [];
    },
    async createPermission() {},
    async removePermission() {},
    async createUser() {},
    async getUser() {
      return null;
    },
    async getUserByUsername() {
      return null;
    },
    async listUsers() {
      return [];
    },
    async disableUser() {},
    async enableUser() {},
    async createProject() {},
    // Note: getProject and getProjectByName are defined above with real impls
    async listProjects() {
      return [];
    },
    async archiveProject() {},
    async addProjectMember() {},
    async removeProjectMember() {},
    async listProjectMembers() {
      return [];
    },
    async listUserProjects() {
      return [];
    },
    async getProjectQuota() {
      return null;
    },
    async setProjectQuota() {},
    async recordUsage() {},
    async getProjectUsage() {
      return [];
    },
    async getUserUsage() {
      return [];
    },
    async getProjectAggregatedUsage() {
      return {
        totalCpuThreads: 0,
        totalMemoryMb: 0,
        totalScratchMb: 0,
        totalWalltimeMs: 0,
        jobCount: 0,
      };
    },
    async isUserDisabled() {
      return false;
    },
    async createNode() {},
    async getNode() {
      return null;
    },
    async listNodes() {
      return [];
    },
    async removeNode() {},
    async resolveNodeId(id: string) {
      return id;
    },
    async getNodeByName() {
      return null;
    },
  };
}

const gaussSlurmRecipe = {
  id: "gaussian-opt",
  software: "gaussian",
  description: "Gaussian geometry optimization",
  inputExtensions: [".gjf"],
  commands: {
    local: { run: "g16 < {{input}} > {{output}}" },
    slurm: { run: "g16 < {{input}} > {{output}}" },
  },
  outputs: { mainLog: "{{basename}}.log" },
  parser: { name: "gaussian" },
  resources: { defaultCores: 8, defaultMemoryGb: 16 },
};

function createSlurmContext(
  db: ReturnType<typeof createFakeDatabase>,
  config: Record<string, unknown>,
) {
  const backends: BackendRegistry = {
    runners: new Map(),
    get: () => undefined,
    available: () => [],
  };
  const allRecipes = [slurmRecipe, gaussSlurmRecipe];
  const recipeRegistry: RecipeRegistry = {
    recipes: allRecipes,
    find: (id: string) => allRecipes.find((r) => r.id === id),
    findRunnable: (sw: string, rn: string, _ext: string, recipeId?: string) => {
      if (recipeId) return allRecipes.find((r) => r.id === recipeId && r.software === sw);
      return allRecipes.find((r) => r.software === sw && r.commands[rn]?.run);
    },
  };
  const bridge = {
    parse: async () => ({ ok: true, parser: "orca", status: "completed" as const, data: {} }),
    generate: async () => ({ ok: true }),
    conformers: async () => ({ ok: true, conformers: [] }),
    run: async () => ({ ok: true, stdout: "", stderr: "" }),
  };
  return new ApplicationContext(
    {
      databasePath: join(suiteRoot, "state.sqlite"),
      dbProvider: "sqlite",
      ...config,
    } as any,
    db as any,
    backends,
    bridge,
    recipeRegistry,
  );
}

const { extractOrcaNprocs, runSubmit } = await import("../../apps/cli/src/commands/submit");

describe("CLI submit --runner slurm", () => {
  it("parses inline and multiline ORCA %pal blocks", () => {
    expect(extractOrcaNprocs("%pal nprocs 8 end")).toBe(8);
    expect(extractOrcaNprocs("%PAL\n  NPROCS 16\nEND")).toBe(16);
    expect(extractOrcaNprocs("%pal\n  nprocs eight\nend")).toBeUndefined();
    expect(extractOrcaNprocs("* xyz 0 1\nH 0 0 0\n*")).toBeUndefined();
  });

  it("creates a slurm script, submits via sbatch, and persists metadata", async () => {
    resetState();
    const workspace = mkdtempSync(join(tmpdir(), "eigengrid-command-slurm-"));
    const inputPath = join(workspace, "water.inp");
    writeFileSync(inputPath, "* xyz 0 1\nH 0 0 0\nH 0 0 1\n*");

    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      state.consoleLogs.push(args.map(String).join(" "));
    };

    try {
      const db = createFakeDatabase();
      const ctx = createSlurmContext(db, {
        jobsDir: state.jobsDir,
        logsDir: join(suiteRoot, "logs"),
        outputsDir: join(suiteRoot, "outputs"),
        pythonCommand: "python",
        sessionsDir: join(suiteRoot, "sessions"),
      });
      await runSubmit(
        { software: "orca", input: [inputPath], runner: "slurm", project: "proj-slurm" },
        {
          createContext: async () => ctx,
          buildSlurmScript: (command: string, opts: Record<string, unknown>) => {
            state.buildCalls.push({ command, opts });
            return "#!/bin/bash\n# mocked slurm script\n";
          },
          createSlurmClient: () => ({
            async submitJob(scriptPath: string) {
              state.scriptPaths.push(scriptPath);
              return { success: true, slurmJobId: "123456" };
            },
          }),
        },
      );
    } finally {
      console.log = originalLog;
      rmSync(workspace, { recursive: true, force: true });
    }

    expect(state.createdJobs).toHaveLength(1);
    expect(state.createdJobs[0]).toMatchObject({ projectId: "proj-slurm", backend: "slurm" });
    expect(state.buildCalls).toHaveLength(1);
    expect(state.buildCalls[0]).toMatchObject({
      command: expect.stringContaining("'sh' '-c' 'orca \"$1\" > \"$2\"'"),
      opts: {
        jobName: inputPath,
        time: "01:00:00",
        cpusPerTask: 1,
        nodes: 1,
        ntasks: 1,
      },
    });
    expect(state.scriptPaths).toHaveLength(1);
    expect(state.scriptPaths[0]).toBe(join(state.jobsDir, state.jobId, "submit.slurm"));
    expect(readFileSync(state.scriptPaths[0], "utf8")).toBe("#!/bin/bash\n# mocked slurm script\n");
    expect(state.externalMetadata).toHaveLength(1);
    expect(state.externalMetadata[0]).toMatchObject({
      jobId: state.jobId,
      metadata: {
        backend: "slurm",
        externalJobId: "123456",
        externalState: "PENDING",
      },
    });
    expect(state.events.some((event) => event.type === "slurm.job.submitted")).toBe(true);
    expect(state.consoleLogs.some((line) => line.includes("SLURM job 123456"))).toBe(true);
  });

  it("warns on ORCA nprocs mismatch but still submits", async () => {
    resetState();
    const workspace = mkdtempSync(join(tmpdir(), "eigengrid-command-slurm-orca-warn-"));
    const inputPath = join(workspace, "water.inp");
    writeFileSync(inputPath, "%pal nprocs 8 end\n* xyz 0 1\nH 0 0 0\n*");

    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      state.consoleLogs.push(args.map(String).join(" "));
    };

    try {
      const db = createFakeDatabase();
      const ctx = createSlurmContext(db, {
        jobsDir: state.jobsDir,
        logsDir: join(suiteRoot, "logs"),
        outputsDir: join(suiteRoot, "outputs"),
        pythonCommand: "python",
        sessionsDir: join(suiteRoot, "sessions"),
      });
      await runSubmit(
        { software: "orca", input: [inputPath], runner: "slurm", "slurm-cpus": 4 },
        {
          createContext: async () => ctx,
          buildSlurmScript: (command: string, opts: Record<string, unknown>) => {
            state.buildCalls.push({ command, opts });
            return "#!/bin/bash\n# mocked slurm script\n";
          },
          createSlurmClient: () => ({
            async submitJob(scriptPath: string) {
              state.scriptPaths.push(scriptPath);
              return { success: true, slurmJobId: "123456" };
            },
          }),
        },
      );
    } finally {
      console.log = originalLog;
      rmSync(workspace, { recursive: true, force: true });
    }

    expect(state.buildCalls).toHaveLength(1);
    expect(state.buildCalls[0].opts).toMatchObject({ cpusPerTask: 4 });
    expect(
      state.consoleLogs.some((line) =>
        line.includes(
          "Warning: ORCA input requests %pal nprocs 8, but --slurm-cpus is 4. Slurm and ORCA CPU counts should match.",
        ),
      ),
    ).toBe(true);
    expect(state.scriptPaths).toHaveLength(1);
  });

  it("uses ORCA %pal nprocs as Slurm cpus-per-task when unset", async () => {
    resetState();
    const workspace = mkdtempSync(join(tmpdir(), "eigengrid-command-slurm-orca-cpus-"));
    const inputPath = join(workspace, "water.inp");
    writeFileSync(inputPath, "%pal nprocs 8 end\n* xyz 0 1\nH 0 0 0\n*");

    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      state.consoleLogs.push(args.map(String).join(" "));
    };

    try {
      const db = createFakeDatabase();
      const ctx = createSlurmContext(db, {
        jobsDir: state.jobsDir,
        logsDir: join(suiteRoot, "logs"),
        outputsDir: join(suiteRoot, "outputs"),
        pythonCommand: "python",
        sessionsDir: join(suiteRoot, "sessions"),
      });
      await runSubmit(
        { software: "orca", input: [inputPath], runner: "slurm" },
        {
          createContext: async () => ctx,
          // No buildSlurmScript mock → uses real buildSlurmScript from @eigengrid/slurm
          createSlurmClient: () => ({
            async submitJob(scriptPath: string) {
              state.scriptPaths.push(scriptPath);
              return { success: true, slurmJobId: "123456" };
            },
          }),
        },
      );
    } finally {
      console.log = originalLog;
      rmSync(workspace, { recursive: true, force: true });
    }

    expect(state.scriptPaths).toHaveLength(1);
    expect(readFileSync(state.scriptPaths[0], "utf8")).toContain("#SBATCH --cpus-per-task=8");
    expect(
      state.consoleLogs.some((line) =>
        line.includes("Using ORCA %pal nprocs 8 as Slurm CPUs per task."),
      ),
    ).toBe(true);
  });

  it("passes custom slurm options to the script builder", async () => {
    resetState();
    const workspace = mkdtempSync(join(tmpdir(), "eigengrid-command-slurm-opts-"));
    const inputPath = join(workspace, "water.inp");
    writeFileSync(inputPath, "* xyz 0 1\nH 0 0 0\nH 0 0 1\n*");

    try {
      const db = createFakeDatabase();
      const ctx = createSlurmContext(db, {
        jobsDir: state.jobsDir,
        logsDir: join(suiteRoot, "logs"),
        outputsDir: join(suiteRoot, "outputs"),
        pythonCommand: "python",
        sessionsDir: join(suiteRoot, "sessions"),
      });
      await runSubmit(
        {
          software: "orca",
          input: [inputPath],
          runner: "slurm",
          "slurm-partition": "debug",
          "slurm-account": "chem",
          "slurm-qos": "normal",
          "slurm-time": "02:00:00",
          "slurm-cpus": 4,
          "slurm-mem": "8G",
          "slurm-nodes": 2,
          "slurm-ntasks": 8,
        },
        {
          createContext: async () => ctx,
          buildSlurmScript: (command: string, opts: Record<string, unknown>) => {
            state.buildCalls.push({ command, opts });
            return "#!/bin/bash\n# mocked slurm script\n";
          },
          createSlurmClient: () => ({
            async submitJob(scriptPath: string) {
              state.scriptPaths.push(scriptPath);
              return { success: true, slurmJobId: "123456" };
            },
          }),
        },
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }

    expect(state.buildCalls).toHaveLength(1);
    expect(state.buildCalls[0].opts).toMatchObject({
      partition: "debug",
      account: "chem",
      qos: "normal",
      time: "02:00:00",
      cpusPerTask: 4,
      mem: "8G",
      nodes: 2,
      ntasks: 8,
    });
  });

  it("keeps explicit Slurm CPUs for non-ORCA inputs", async () => {
    resetState();
    const workspace = mkdtempSync(join(tmpdir(), "eigengrid-command-slurm-nonorca-"));
    const inputPath = join(workspace, "water.gjf");
    writeFileSync(inputPath, "#p hf/sto-3g\n\nwater\n\n0 1\nH 0 0 0\nH 0 0 1\n");

    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      state.consoleLogs.push(args.map(String).join(" "));
    };

    try {
      const db = createFakeDatabase();
      const ctx = createSlurmContext(db, {
        jobsDir: state.jobsDir,
        logsDir: join(suiteRoot, "logs"),
        outputsDir: join(suiteRoot, "outputs"),
        pythonCommand: "python",
        sessionsDir: join(suiteRoot, "sessions"),
      });
      await runSubmit(
        { software: "gaussian", input: [inputPath], runner: "slurm", "slurm-cpus": 4 },
        {
          createContext: async () => ctx,
          buildSlurmScript: (command: string, opts: Record<string, unknown>) => {
            state.buildCalls.push({ command, opts });
            return "#!/bin/bash\n# mocked slurm script\n";
          },
          createSlurmClient: () => ({
            async submitJob(scriptPath: string) {
              state.scriptPaths.push(scriptPath);
              return { success: true, slurmJobId: "123456" };
            },
          }),
        },
      );
    } finally {
      console.log = originalLog;
      rmSync(workspace, { recursive: true, force: true });
    }

    expect(state.buildCalls).toHaveLength(1);
    expect(state.buildCalls[0].opts).toMatchObject({ cpusPerTask: 4 });
    expect(state.consoleLogs.some((line) => line.includes("ORCA"))).toBe(false);
  });
});
