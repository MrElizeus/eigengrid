// ────────────────────────────────────────────────────────────
// ApplicationContext — canonical explicit composition root
// ────────────────────────────────────────────────────────────

import type { Config, RunnerKind } from "@eigengrid/core";
import { LocalRunner } from "@eigengrid/runners";
import type { Runner } from "@eigengrid/runners";
import type {
  DatabaseLike,
  SaveResultInput,
  JobRecord,
  EventRecord,
  StoredResultRecord,
} from "@eigengrid/db";
import type { PythonBridge } from "@eigengrid/python-bridge";
import type { Recipe, RecipeRunnerKind } from "@eigengrid/recipes";

import { loadConfig } from "@eigengrid/config";
import { createDatabaseFromConfig, SqliteDatabase, PostgresDatabase } from "@eigengrid/db";
import { createPythonBridge } from "@eigengrid/python-bridge";
import { loadBuiltinRecipes, findRunnableRecipe } from "@eigengrid/recipes";
import { generateId } from "@eigengrid/core";
import { clusterNodeRecords } from "../services/cluster-inventory";
import { loadOperatorPermissions } from "../services/operator-permission-store";
import { operatorSandboxCommand } from "@eigengrid/runners/operator-sandbox";

import type {
  BackendRegistry,
  ContextOverrides,
  CreateJobInput,
  DashboardDataSource,
  DashboardFetchOptions,
  DashboardSnapshot,
  EventsQueryService,
  JobExternalMetadata,
  JobService,
  QueryService,
  RecipeRegistry,
  ResultsQueryService,
} from "./types";
import {
  ExecutionCoordinator,
  type ExecutionCoordinatorDeps,
  type LocalExecutionBackendFactory,
} from "../services/execution-coordinator";

// ── DefaultBackendRegistry ──────────────────────────────────

class DefaultBackendRegistry implements BackendRegistry {
  readonly #runners: Map<RunnerKind, Runner>;

  constructor(runners?: Map<RunnerKind, Runner>) {
    this.#runners = new Map(runners);
  }

  get runners(): ReadonlyMap<RunnerKind, Runner> {
    return this.#runners;
  }

  get(kind: RunnerKind): Runner | undefined {
    return this.#runners.get(kind);
  }

  available(): RunnerKind[] {
    return [...this.#runners.keys()];
  }
}

// ── DefaultRecipeRegistry ───────────────────────────────────

class DefaultRecipeRegistry implements RecipeRegistry {
  readonly #recipes: readonly Recipe[];

  constructor(recipes?: readonly Recipe[]) {
    this.#recipes = recipes ?? loadBuiltinRecipes();
  }

  get recipes(): readonly Recipe[] {
    return this.#recipes;
  }

  find(id: string): Recipe | undefined {
    return this.#recipes.find((r) => r.id === id);
  }

  findRunnable(
    software: string,
    runner: RecipeRunnerKind,
    inputExtension: string,
    recipeId?: string,
  ): Recipe | undefined {
    // findRunnableRecipe in recipes expects RecipeRunnerKind, not the full list
    const recipes = [...this.#recipes];
    return findRunnableRecipe(recipes, software, runner, inputExtension, recipeId);
  }
}

// ── JobService (narrow typed boundary) ──────────────────────

class DbJobService implements JobService {
  constructor(private readonly db: DatabaseLike) {}

  async create(input: CreateJobInput): Promise<void> {
    // DatabaseLike.createJob accepts the same shape — delegate directly
    await this.db.createJob(input);
  }

  async get(jobId: string): Promise<JobRecord | null> {
    return this.db.getJob(jobId);
  }

  async list(): Promise<JobRecord[]> {
    return this.db.listJobs();
  }

  async updateStatus(jobId: string, status: string): Promise<void> {
    await this.db.updateJobStatus(jobId, status);
  }

  async updateExternalMetadata(jobId: string, metadata: JobExternalMetadata): Promise<void> {
    if (this.db.updateJobExternalMetadata) {
      await this.db.updateJobExternalMetadata(jobId, metadata);
    }
  }

  async resolveId(prefix: string): Promise<string> {
    return this.db.resolveJobId(prefix);
  }
}

// ── QueryService (narrow typed boundary) ────────────────────

class DbEventsQueryService implements EventsQueryService {
  constructor(private readonly db: DatabaseLike) {}

  async list(jobId?: string): Promise<EventRecord[]> {
    return this.db.getEvents(jobId);
  }

  async listJobEvents(jobId: string): Promise<EventRecord[]> {
    return this.db.listJobEvents(jobId);
  }

  async getTimeline(jobId: string): Promise<{ at: string; type: string; details: string }[]> {
    return this.db.getTimeline(jobId);
  }
}

class DbResultsQueryService implements ResultsQueryService {
  constructor(private readonly db: DatabaseLike) {}

  async list(jobId?: string, attemptId?: string): Promise<StoredResultRecord[]> {
    return this.db.listResults(jobId, attemptId);
  }

  async getLatest(jobId: string, attemptId: string): Promise<StoredResultRecord | null> {
    return this.db.getLatestResult(jobId, attemptId);
  }

  async save(input: SaveResultInput): Promise<string> {
    return this.db.saveResult(input);
  }
}

class DbQueryService implements QueryService {
  readonly events: EventsQueryService;
  readonly results: ResultsQueryService;
  readonly logs: QueryService["logs"];
  readonly artifacts: QueryService["artifacts"];

  constructor(private readonly db: DatabaseLike) {
    this.events = new DbEventsQueryService(db);
    this.results = new DbResultsQueryService(db);
    this.logs = {
      get: (jobId, stream, tail) => db.getLogs(jobId, stream, tail),
    };
    this.artifacts = {
      list: (jobId) => db.listArtifacts(jobId),
    };
  }
}

// ── DashboardDataSource (narrow read-only query boundary) ───

class DbDashboardDataSource implements DashboardDataSource {
  constructor(
    private readonly db: DatabaseLike,
    private readonly jobs: JobService,
    private readonly queries: QueryService,
    private readonly clock: () => number,
  ) {}

  async fetch(options: DashboardFetchOptions = {}): Promise<DashboardSnapshot> {
    const jobId = options.jobId;
    const logTail = options.logTail ?? 50;

    if (!jobId) {
      const [jobs, nodes] = await Promise.all([this.jobs.list(), this.#nodes()]);
      return { jobs, nodes, logs: [], events: [], timeline: [], fetchedAt: this.clock() };
    }

    const [jobs, nodes, logs, events, timeline] = await Promise.all([
      this.jobs.list(),
      this.#nodes(),
      this.queries.logs.get(jobId, undefined, logTail),
      this.queries.events.list(jobId),
      this.queries.events.getTimeline(jobId),
    ]);
    return { jobs, nodes, logs, events, timeline, fetchedAt: this.clock() };
  }

  async #nodes() {
    return (await clusterNodeRecords()) ?? this.db.listNodes();
  }
}

// ── ApplicationContext ──────────────────────────────────────

export class ApplicationContext {
  /** Resolved effective config (immutable after construction). */
  public readonly config: Config;

  /** Database adapter — SQLite or PostgreSQL instance. */
  public readonly db: DatabaseLike;

  /** Runner/backend registry. */
  public readonly backends: BackendRegistry;

  /** Python bridge for parse/generate/conformer operations. */
  public readonly parsers: PythonBridge;

  /** Loaded recipe registry. */
  public readonly recipes: RecipeRegistry;

  /** Job operations (narrow typed boundary over db). */
  public readonly jobs: JobService;

  /** Query operations (narrow typed boundary over db). */
  public readonly queries: QueryService;

  /** Read-only dashboard query boundary (provider-neutral, no mutations). */
  public readonly dashboard: DashboardDataSource;

  /** Clock used for timestamps. */
  public readonly clock: () => number;

  /** ID generator. */
  public readonly idGenerator: (prefix: string) => string;

  /** Execution coordinator — typed local lifecycle orchestrator. */
  public readonly execution: import("../services/execution-coordinator").ExecutionService;

  #closed: boolean = false;

  constructor(
    config: Config,
    db: DatabaseLike,
    backends: BackendRegistry,
    parsers: PythonBridge,
    recipes: RecipeRegistry,
    overrides: ContextOverrides = {},
  ) {
    this.config = config;
    this.db = db;
    this.backends = backends;
    this.parsers = parsers;
    this.recipes = recipes;
    this.clock = overrides.clock ?? Date.now;
    this.idGenerator = overrides.idGenerator ?? generateId;

    // Create narrow-boundary services that delegate to the real db
    this.jobs = new DbJobService(db);
    this.queries = new DbQueryService(db);
    this.dashboard = new DbDashboardDataSource(db, this.jobs, this.queries, this.clock);

    // Create execution coordinator with default or injected backend factory
    const defaultLocalBackendFactory: LocalExecutionBackendFactory = (plan, db_, executor) => {
      const permissions = loadOperatorPermissions();
      return new LocalRunner({
        database: db_,
        engines: {
          [plan.job.software]: {
            command: plan.program,
            args: plan.args,
            displayCommand: plan.displayCommand,
          },
        },
        executor,
        durableCompletion: true,
        ...(permissions.preset === "sandboxed"
          ? {
              maxWallTime: 3600000,
              isolateCommand: (command: string, args: string[], cwd: string) =>
                operatorSandboxCommand(command, args, permissions.workspace, cwd),
            }
          : {}),
      });
    };

    const coordDeps: ExecutionCoordinatorDeps = {
      db,
      config,
      recipes,
      clock: this.clock,
      idGenerator: this.idGenerator,
      localBackendFactory: overrides.localBackendFactory ?? defaultLocalBackendFactory,
      parser: parsers,
      allowLegacyExecution:
        process.env.EIGENGRID_DEPLOYMENT_PROFILE !== "production" &&
        !process.env.EIGENGRID_CLUSTER_PROFILE,
    };
    this.execution = overrides.execution ?? new ExecutionCoordinator(coordDeps);
  }

  /**
   * Idempotent close — releases owned resources including
   * PostgreSQL connection pools.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.db.close();
  }

  /** True if close() has been called. */
  get isClosed(): boolean {
    return this.#closed;
  }
}

// ── createApplicationContext — factory function ─────────────

export interface CreateContextOptions {
  /** Working directory for config resolution. */
  cwd?: string;
}

/**
 * Create the application composition root.
 *
 * Config is resolved from:
 *   1. Default values
 *   2. `.eigengrid/eigengrid.yaml` (if it exists)
 *   3. Environment variable overrides
 *   4. Explicit `overrides.config` (highest priority)
 *
 * Provider selection:
 *   - `sqlite` → SQLite adapter using `config.databasePath`
 *   - `postgres` → PostgreSQL adapter using `config.databaseUrl`
 *
 * The two providers cannot be silently mixed — if overrides provide
 * a database of one type but config selects the other, a
 * ProviderConflictError is thrown.
 *
 * @param overrides - Optional test injections (fake DB, runners, bridge, config partials)
 * @param opts - Factory options (cwd for config resolution)
 */
export async function createApplicationContext(
  overrides: ContextOverrides = {},
  opts: CreateContextOptions = {},
): Promise<ApplicationContext> {
  // 1. Resolve effective config
  const config = await loadConfig(opts.cwd);
  const effectiveConfig: Config = overrides.config ? { ...config, ...overrides.config } : config;

  // 2. Resolve database
  let db: DatabaseLike;
  if (overrides.db) {
    // Validate no silent provider mixing when both sides specify a provider
    const overrideProvider = inferProvider(overrides.db);
    const configProvider = effectiveConfig.dbProvider;
    if (overrideProvider && configProvider && overrideProvider !== configProvider) {
      const { ProviderConflictError } = await import("./types");
      throw new ProviderConflictError(configProvider, overrideProvider);
    }
    db = overrides.db;
  } else {
    db = await createDatabaseFromConfig(effectiveConfig);
  }

  // 3. Resolve Python bridge
  const bridge: PythonBridge =
    overrides.bridge ?? createPythonBridge(effectiveConfig.pythonCommand);

  // 4. Resolve backend registry
  const backends = new DefaultBackendRegistry(overrides.runners);

  // 5. Resolve recipe registry
  const recipes = new DefaultRecipeRegistry(overrides.recipes);

  return new ApplicationContext(effectiveConfig, db, backends, bridge, recipes, overrides);
}

// ── Provider inference helper ───────────────────────────────

/** Optional brand for test fakes to declare their provider kind. */
export interface ProviderMarked {
  readonly _provider?: "sqlite" | "postgres";
}

function inferProvider(db: DatabaseLike): "sqlite" | "postgres" | null {
  if (db instanceof SqliteDatabase) return "sqlite";
  if (db instanceof PostgresDatabase) return "postgres";
  const marked = db as DatabaseLike & ProviderMarked;
  return marked._provider ?? null;
}
