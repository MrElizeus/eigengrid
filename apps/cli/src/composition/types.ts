// ────────────────────────────────────────────────────────────
// ApplicationContext types — provider-neutral composition root
// ────────────────────────────────────────────────────────────

import type { Config, RunnerKind } from "@eigengrid/core";
import type { Runner } from "@eigengrid/runners";
import type {
  DatabaseLike,
  SaveResultInput,
  JobRecord,
  EventRecord,
  StoredResultRecord,
  NodeRecord,
  LogLine,
  TimelineRow,
} from "@eigengrid/db";
import type { Artifact } from "@eigengrid/core";
import type { PythonBridge } from "@eigengrid/python-bridge";
import type { Recipe, RecipeRunnerKind } from "@eigengrid/recipes";

// ── Errors ─────────────────────────────────────────────────

export class ContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextError";
  }
}

export class ProviderConflictError extends ContextError {
  constructor(
    public readonly configured: "sqlite" | "postgres",
    public readonly overridden: "sqlite" | "postgres",
  ) {
    super(
      `Provider conflict: config selects "${configured}" but override provides "${overridden}". ` +
        "PostgreSQL and SQLite cannot be silently mixed.",
    );
    this.name = "ProviderConflictError";
  }
}

// ── Backend registry (typed narrow boundary) ────────────────

export interface BackendRegistry {
  /** All registered runners, keyed by RunnerKind. */
  readonly runners: ReadonlyMap<RunnerKind, Runner>;

  /** Look up a runner by kind. */
  get(kind: RunnerKind): Runner | undefined;

  /** List all registered runner kinds. */
  available(): RunnerKind[];
}

// ── Recipe registry ─────────────────────────────────────────

export interface RecipeRegistry {
  readonly recipes: readonly Recipe[];
  find(id: string): Recipe | undefined;
  findRunnable(
    software: string,
    runner: RecipeRunnerKind,
    inputExtension: string,
    recipeId?: string,
  ): Recipe | undefined;
}

// ── Job service (typed narrow boundary over DatabaseLike) ───

export type CreateJobInput = {
  id: string;
  name: string;
  software: string;
  inputPath: string;
  workdir: string;
  outputPath?: string;
  ownerUserId?: string;
  projectId?: string;
  backend?: string;
};

export type JobExternalMetadata = {
  backend?: string;
  externalJobId?: string;
  externalState?: string;
  lastSyncAt?: number;
  nativeDetail?: string;
  nodeName?: string;
};

export interface JobService {
  create(input: CreateJobInput): Promise<void>;
  get(jobId: string): Promise<JobRecord | null>;
  list(): Promise<JobRecord[]>;
  updateStatus(jobId: string, status: string): Promise<void>;
  updateExternalMetadata(jobId: string, metadata: JobExternalMetadata): Promise<void>;
  resolveId(prefix: string): Promise<string>;
}

// ── Query service (typed narrow boundary over DatabaseLike) ─

export interface EventsQueryService {
  list(jobId?: string): Promise<EventRecord[]>;
  listJobEvents(jobId: string): Promise<EventRecord[]>;
  getTimeline(jobId: string): Promise<{ at: string; type: string; details: string }[]>;
}

export interface ResultsQueryService {
  list(jobId?: string, attemptId?: string): Promise<StoredResultRecord[]>;
  getLatest(jobId: string, attemptId: string): Promise<StoredResultRecord | null>;
  save(input: SaveResultInput): Promise<string>;
}

export interface QueryService {
  events: EventsQueryService;
  results: ResultsQueryService;
  logs: {
    get(
      jobId: string,
      stream?: string,
      tail?: number,
    ): Promise<{ stream: string; line: string; createdAt: number }[]>;
  };
  artifacts: {
    list(jobId?: string): Promise<Artifact[]>;
  };
}

// ── Dashboard query boundary (read-only) ────────────────────

/**
 * A single read-only snapshot of operational dashboard data.
 * Provider-neutral records only — never raw SQL or adapter handles.
 */
export interface DashboardSnapshot {
  readonly jobs: readonly JobRecord[];
  readonly nodes: readonly NodeRecord[];
  readonly logs: readonly LogLine[];
  readonly events: readonly EventRecord[];
  readonly timeline: readonly TimelineRow[];
  readonly fetchedAt: number;
}

export interface DashboardFetchOptions {
  /** Selected job — when set, logs/events/timeline are scoped to it. */
  readonly jobId?: string;
  /** Bounded log tail per stream (default 50). */
  readonly logTail?: number;
}

/**
 * Narrow typed query boundary owned by ApplicationContext for the
 * operational dashboard. The only operation is `fetch` (read-only).
 * Components never see a concrete DB adapter, raw SQL, or provider
 * selection through this boundary.
 */
export interface DashboardDataSource {
  fetch(options?: DashboardFetchOptions): Promise<DashboardSnapshot>;
}

// ── Overrides for isolated tests ────────────────────────────

export interface ContextOverrides {
  /** In-memory / fake database (overrides provider config). */
  db?: DatabaseLike;

  /** Pre-configured runner map. */
  runners?: Map<RunnerKind, Runner>;

  /** Explicit recipe set for an isolated composition (for example, executable fixtures). */
  recipes?: readonly Recipe[];

  /** Fake Python bridge. */
  bridge?: PythonBridge;

  /** Clock factory (defaults to Date.now). */
  clock?: () => number;

  /** ID generator (defaults to @eigengrid/core generateId). */
  idGenerator?: (prefix: string) => string;

  /** Partial config overrides (merged atop loaded config). */
  config?: Partial<Config>;

  /** Local backend factory override (for test injection). */
  localBackendFactory?: import("../services/execution-coordinator").LocalExecutionBackendFactory;

  /** Execution coordinator override (for test injection, typed via interface). */
  execution?: import("../services/execution-coordinator").ExecutionService;
}
