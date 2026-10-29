import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Config } from "@eigengrid/core";
import { ApplicationContext } from "../../apps/cli/src/composition";
import type { BackendRegistry, RecipeRegistry } from "../../apps/cli/src/composition";

const state = {
  createdJobs: [] as Array<{ id: string; projectId?: string; backend?: string }>,
  events: [] as Array<Record<string, unknown>>,
};

function resetState(): void {
  state.createdJobs = [];
  state.events = [];
}

function createWorkspace(): { root: string; jobsDir: string; inputPath: string } {
  const root = mkdtempSync(join(tmpdir(), "eigengrid-submit-"));
  const jobsDir = join(root, "jobs");
  const inputPath = join(root, "water.inp");
  writeFileSync(inputPath, "* xyz 0 1\nH 0 0 0\nH 0 0 1\n*");
  return { root, jobsDir, inputPath };
}

const testRecipe = {
  id: "orca-opt",
  software: "orca",
  description: "ORCA geometry optimization",
  inputExtensions: [".inp"],
  commands: { local: { run: "orca {{input}} > {{output}}" } },
  outputs: { mainLog: "{{basename}}.out" },
  parser: { name: "orca" },
  resources: { defaultCores: 8, defaultMemoryGb: 16 },
};

/** In-memory fake that tracks parameters via instance fields. */
class FakeDatabase {
  _provider = "sqlite" as const;
  projectById: Record<string, unknown> | null = null;
  projectByName: Record<string, unknown> | null = null;

  constructor(byId: Record<string, unknown> | null, byName: Record<string, unknown> | null) {
    this.projectById = byId;
    this.projectByName = byName;
  }

  async init() {}
  async close() {}
  async runMigrations() {}
  async getMigrationVersion() {
    return 0;
  }
  async getProject(projectId: string) {
    return this.projectById && String(this.projectById.id) === projectId ? this.projectById : null;
  }
  async getProjectByName(name: string) {
    return this.projectByName && String(this.projectByName.name) === name
      ? this.projectByName
      : null;
  }
  async resolveProjectId(prefix: string) {
    if (this.projectById && String(this.projectById.id).startsWith(prefix))
      return String(this.projectById.id);
    throw new Error(`Project not found: ${prefix}`);
  }
  async createJob(job: { id: string; projectId?: string; backend?: string }) {
    state.createdJobs.push(job);
  }
  async appendEvent(event: Record<string, unknown>) {
    state.events.push(event);
  }
  async getJob() {
    return null;
  }
  async resolveJobId(id: string) {
    return id;
  }
  async listJobs() {
    return [];
  }
  async updateJobStatus() {}
  async updateJobExternalMetadata() {}
  async listJobAttempts() {
    return [];
  }
  async createJobAttempt() {}
  async updateJobAttemptStatus() {}
  async createArtifact() {}
  async listArtifacts() {
    return [];
  }
  async getLogs() {
    return [];
  }
  async insertEvent() {}
  async getEvents() {
    return [];
  }
  async listEvents() {
    return [];
  }
  async listJobEvents() {
    return [];
  }
  async listAttemptEvents() {
    return [];
  }
  async getTimeline() {
    return [];
  }
  async saveResult() {
    return "";
  }
  async listResults() {
    return [];
  }
  async getLatestResult() {
    return null;
  }
  async createProposal() {
    return "";
  }
  async getProposal() {
    return null;
  }
  async listProposals() {
    return [];
  }
  async updateProposalStatus() {}
  async listPermissions() {
    return [];
  }
  async createPermission() {}
  async removePermission() {}
  async createUser() {}
  async getUser() {
    return null;
  }
  async getUserByUsername() {
    return null;
  }
  async listUsers() {
    return [];
  }
  async disableUser() {}
  async enableUser() {}
  async createProject() {}
  // Note: getProject and getProjectByName are defined above with real impls
  async listProjects() {
    return [];
  }
  async archiveProject() {}
  async addProjectMember() {}
  async removeProjectMember() {}
  async listProjectMembers() {
    return [];
  }
  async listUserProjects() {
    return [];
  }
  async getProjectQuota() {
    return null;
  }
  async setProjectQuota() {}
  async recordUsage() {}
  async getProjectUsage() {
    return [];
  }
  async getUserUsage() {
    return [];
  }
  async getProjectAggregatedUsage() {
    return {
      totalCpuThreads: 0,
      totalMemoryMb: 0,
      totalScratchMb: 0,
      totalWalltimeMs: 0,
      jobCount: 0,
    };
  }
  async isUserDisabled() {
    return false;
  }
  async createNode() {}
  async getNode() {
    return null;
  }
  async listNodes() {
    return [];
  }
  async removeNode() {}
  async resolveNodeId(id: string) {
    return id;
  }
  async getNodeByName() {
    return null;
  }
}

function createContext(config: Config, db: FakeDatabase) {
  const backends: BackendRegistry = {
    runners: new Map(),
    get: () => undefined,
    available: () => [],
  };
  const recipeRegistry: RecipeRegistry = {
    recipes: [testRecipe],
    find: (id: string) => (testRecipe.id === id ? testRecipe : undefined),
    findRunnable: (_sw: string, _rn: string, _ext: string, recipeId?: string) =>
      recipeId ? (testRecipe.id === recipeId ? testRecipe : undefined) : testRecipe,
  };
  const bridge = {
    parse: async () => ({ ok: true, parser: "orca", status: "completed" as const, data: {} }),
    generate: async () => ({ ok: true }),
    conformers: async () => ({ ok: true, conformers: [] }),
    run: async () => ({ ok: true, stdout: "", stderr: "" }),
  };
  return new ApplicationContext(config, db, backends, bridge, recipeRegistry);
}

const { runSubmit } = await import("../../apps/cli/src/commands/submit");

describe("submit --project", () => {
  it("persists project_id when resolving by project name", async () => {
    resetState();
    const { root, jobsDir, inputPath } = createWorkspace();

    try {
      const ctx = createContext(
        {
          databasePath: "/tmp/eigengrid-submit-project.sqlite",
          dbProvider: "sqlite",
          jobsDir,
          logsDir: join(root, "logs"),
          outputsDir: join(root, "outputs"),
          pythonCommand: "python",
          sessionsDir: join(root, "sessions"),
        } as Config,
        new FakeDatabase(null, { id: "proj-chem", name: "chemistry" }),
      );

      await runSubmit(
        { software: "orca", input: [inputPath], runner: "local", project: "chemistry" },
        {
          createContext: async () => ctx,
          runnerFactory: async () => ({ ok: true, message: "started" }),
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    expect(state.createdJobs).toHaveLength(1);
    expect(state.createdJobs[0]).toMatchObject({ projectId: "proj-chem" });
  });

  it("persists project_id when resolving by project id", async () => {
    resetState();
    const { root, jobsDir, inputPath } = createWorkspace();

    try {
      const ctx = createContext(
        {
          databasePath: "/tmp/eigengrid-submit-project.sqlite",
          dbProvider: "sqlite",
          jobsDir,
          logsDir: join(root, "logs"),
          outputsDir: join(root, "outputs"),
          pythonCommand: "python",
          sessionsDir: join(root, "sessions"),
        } as Config,
        new FakeDatabase({ id: "proj-42", name: "analysis" }, null),
      );

      await runSubmit(
        { software: "orca", input: [inputPath], runner: "local", project: "proj-42" },
        {
          createContext: async () => ctx,
          runnerFactory: async () => ({ ok: true, message: "started" }),
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    expect(state.createdJobs).toHaveLength(1);
    expect(state.createdJobs[0]).toMatchObject({ projectId: "proj-42" });
  });
});
