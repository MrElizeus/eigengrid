import { mkdirSync } from "fs";
import { dirname } from "path";
import {
  canTransitionJobStatus,
  generateId,
  type Artifact,
  type JobAttempt,
  type JobAttemptStatus,
  type JobStatus,
  type RunnerKind,
  VALID_TRANSITIONS,
} from "@eigengrid/core";
import type { EigenGridEvent, EigenGridEventBase } from "@eigengrid/events";
import type { PermissionEffect } from "@eigengrid/core";
import type {
  DatabaseLike,
  EventRecord,
  JobRecord,
  UserRecord,
  ProjectRecord,
  NodeRecord,
  NodeUpdateInput,
  MembershipRecord,
  QuotaRecord,
  UsageRecord,
  PermissionRecord,
  StoredResultRecord,
  DbTransaction as DbTransactionInterface,
  ProposalRow,
  ProposalStatus,
  CreateProposalInput,
  SaveResultInput,
  LogLine,
  ListEventsFilter,
  TimelineRow,
  TerminalAttemptEvidence,
} from "./client";
import {
  DbError,
  DbErrorCode,
  DbNotFoundError,
  DbInvalidTransitionError,
  DbAmbiguousPrefixError,
} from "./errors";
import { JOB_ATTEMPT_STATUSES, VALID_ATTEMPT_TRANSITIONS, isValidAttemptTransition } from "./rows";
import { SCIENTIFIC_SQLITE_MIGRATION } from "./scientific-migrations";
import { MD_SQLITE_MIGRATIONS } from "./md-migrations";
import { OPERATION_OUTBOX_SQLITE_MIGRATION } from "./operation-outbox-migration";
import { EFFECT_DELIVERY_SQLITE_MIGRATION } from "./effect-delivery-migration";
import { MD_PREPARATION_SQLITE_MIGRATION } from "./md-preparation-migration";
import { splitSqlStatements } from "./migration-utils";
import {
  mapJobAttemptRow as mapJobAttemptRowHelper,
  mapArtifactRow as mapArtifactRowHelper,
  mapEventRow,
  mapJobRow,
  mapUserRow,
  mapProjectRow,
  mapNodeRow,
  mapMembershipRow,
  mapQuotaRow,
  mapUsageRow,
  isJobAttemptStatus,
  readString,
  readNumber,
} from "./rows";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "create_initial_tables",
    sql: `
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        software TEXT NOT NULL,
        input_path TEXT NOT NULL,
        workdir TEXT NOT NULL,
        output_path TEXT,
        node_id TEXT,
        status TEXT NOT NULL DEFAULT 'created',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_attempts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        runner TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        command TEXT NOT NULL,
        cwd TEXT NOT NULL,
        pid INTEGER,
        exit_code INTEGER,
        started_at INTEGER,
        finished_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        label TEXT,
        mime_type TEXT,
        size_bytes INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        user TEXT NOT NULL,
        runner TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        tags_json TEXT NOT NULL DEFAULT '[]',
        max_jobs INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        line TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS results (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        parser TEXT NOT NULL,
        status TEXT NOT NULL,
        energy_hartree TEXT,
        scf_converged INTEGER,
        imaginary_frequencies INTEGER,
        normal_termination INTEGER,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        errors_json TEXT NOT NULL DEFAULT '[]',
        raw_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "create_permissions_table",
    sql: `
      CREATE TABLE IF NOT EXISTS permissions (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        resource TEXT NOT NULL DEFAULT '*',
        effect TEXT NOT NULL DEFAULT 'allow' CHECK(effect IN ('allow', 'deny', 'ask')),
        project_id TEXT,
        label TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: "harden_event_log",
    sql: `
      ALTER TABLE job_events ADD COLUMN event_id TEXT;
      ALTER TABLE job_events ADD COLUMN source TEXT NOT NULL DEFAULT 'system';
      ALTER TABLE job_events ADD COLUMN attempt_id TEXT;
      ALTER TABLE job_events ADD COLUMN artifact_id TEXT;
      ALTER TABLE job_events ADD COLUMN result_id TEXT;
      ALTER TABLE job_events ADD COLUMN sequence INTEGER;
      ALTER TABLE job_events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
      CREATE INDEX IF NOT EXISTS idx_job_events_job_created ON job_events(job_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_job_events_type_created ON job_events(type, created_at);
      CREATE INDEX IF NOT EXISTS idx_job_events_attempt ON job_events(attempt_id);
      CREATE INDEX IF NOT EXISTS idx_job_events_artifact ON job_events(artifact_id);
    `,
  },
  {
    version: 4,
    name: "add_ssh_node_fields",
    sql: `
      ALTER TABLE nodes ADD COLUMN port INTEGER NOT NULL DEFAULT 22;
      ALTER TABLE nodes ADD COLUMN private_key_path TEXT;
      ALTER TABLE nodes ADD COLUMN remote_scratch_dir TEXT NOT NULL DEFAULT '/scratch/eigengrid';
    `,
  },
  {
    version: 5,
    name: "create_proposals_table",
    sql: `
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT NOT NULL,
        proposed_changes TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'executed')),
        diagnosis_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 6,
    name: "add_capacity_and_resource_fields",
    sql: `
      ALTER TABLE nodes ADD COLUMN engines TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE nodes ADD COLUMN cpu_threads_total INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE nodes ADD COLUMN memory_mb_total INTEGER NOT NULL DEFAULT 1024;
      ALTER TABLE nodes ADD COLUMN scratch_mb_total INTEGER NOT NULL DEFAULT 10240;
      ALTER TABLE nodes ADD COLUMN draining INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE nodes ADD COLUMN thermal_state TEXT NOT NULL DEFAULT 'unknown';
      ALTER TABLE nodes ADD COLUMN last_seen_at INTEGER;
      ALTER TABLE jobs ADD COLUMN cpu_threads INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE jobs ADD COLUMN memory_mb INTEGER NOT NULL DEFAULT 1024;
      ALTER TABLE jobs ADD COLUMN scratch_mb INTEGER NOT NULL DEFAULT 1024;
      ALTER TABLE jobs ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';
      ALTER TABLE jobs ADD COLUMN job_family TEXT;
    `,
  },
  {
    version: 7,
    name: "add_power_management_fields",
    sql: `
      ALTER TABLE nodes ADD COLUMN is_head INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE nodes ADD COLUMN power_mode TEXT NOT NULL DEFAULT 'manual';
      ALTER TABLE nodes ADD COLUMN mac_address TEXT;
      ALTER TABLE nodes ADD COLUMN broadcast_address TEXT;
      ALTER TABLE nodes ADD COLUMN wol_port INTEGER;
      ALTER TABLE nodes ADD COLUMN allow_wake INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE nodes ADD COLUMN allow_power_down INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE nodes ADD COLUMN idle_power_down_after_sec INTEGER;
      ALTER TABLE nodes ADD COLUMN last_wake_at INTEGER;
      ALTER TABLE nodes ADD COLUMN last_power_down_at INTEGER;
    `,
  },
  {
    version: 8,
    name: "add_users_projects_quotas",
    sql: `
      -- Users table
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT,
        email TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Projects table
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        max_concurrent_jobs INTEGER NOT NULL DEFAULT 10,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Project memberships
      CREATE TABLE IF NOT EXISTS project_memberships (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Project quotas
      CREATE TABLE IF NOT EXISTS project_quotas (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL UNIQUE,
        max_cpu_threads INTEGER NOT NULL DEFAULT 0,
        max_memory_mb INTEGER NOT NULL DEFAULT 0,
        max_scratch_mb INTEGER NOT NULL DEFAULT 0,
        max_jobs_total INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Usage records
      CREATE TABLE IF NOT EXISTS usage_records (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        cpu_threads INTEGER NOT NULL DEFAULT 1,
        memory_mb INTEGER NOT NULL DEFAULT 1024,
        scratch_mb INTEGER NOT NULL DEFAULT 1024,
        walltime_ms INTEGER,
        recorded_at INTEGER NOT NULL
      );

      -- Add owner_user_id and project_id to jobs
      ALTER TABLE jobs ADD COLUMN owner_user_id TEXT;
      ALTER TABLE jobs ADD COLUMN project_id TEXT;

      -- Create default user and default project
      INSERT OR IGNORE INTO users (id, username, display_name, status, created_at, updated_at)
        VALUES ('local', 'local', 'Local User', 'active', 0, 0);
      INSERT OR IGNORE INTO projects (id, name, description, status, max_concurrent_jobs, created_at, updated_at)
        VALUES ('default', 'default', 'Default project', 'active', 100, 0, 0);

      -- Backfill existing jobs: owner_user_id = 'local', project_id = 'default'
      UPDATE jobs SET owner_user_id = 'local', project_id = 'default' WHERE owner_user_id IS NULL AND project_id IS NULL;
    `,
  },
  {
    version: 9,
    name: "add_slurm_backend_fields",
    sql: `
      ALTER TABLE jobs ADD COLUMN backend TEXT;
      ALTER TABLE jobs ADD COLUMN external_job_id TEXT;
      ALTER TABLE jobs ADD COLUMN external_state TEXT;
      ALTER TABLE jobs ADD COLUMN last_sync_at INTEGER;
      ALTER TABLE jobs ADD COLUMN native_detail TEXT;
      ALTER TABLE jobs ADD COLUMN node_name TEXT;
    `,
  },
  {
    version: 10,
    name: "add_job_events_sequence_unique",
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_job_events_job_sequence ON job_events(job_id, sequence);
    `,
  },
  SCIENTIFIC_SQLITE_MIGRATION,
  {
    version: 12,
    name: "bind_results_to_attempts",
    sql: `
      ALTER TABLE results RENAME TO results_legacy_v11;
      CREATE TABLE results (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        parser TEXT NOT NULL,
        status TEXT NOT NULL,
        energy_hartree TEXT,
        scf_converged INTEGER,
        imaginary_frequencies INTEGER,
        normal_termination INTEGER,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        errors_json TEXT NOT NULL DEFAULT '[]',
        raw_json TEXT,
        created_at INTEGER NOT NULL
      );
      INSERT INTO results
        (id, job_id, attempt_id, parser, status, energy_hartree, scf_converged,
         imaginary_frequencies, normal_termination, warnings_json, errors_json,
         raw_json, created_at)
      WITH single_attempts AS (
        SELECT job_id, MIN(id) AS attempt_id
        FROM job_attempts
        GROUP BY job_id
        HAVING COUNT(*) = 1
      ), ranked_results AS (
        SELECT legacy.*, single_attempts.attempt_id,
               ROW_NUMBER() OVER (
                 PARTITION BY legacy.job_id, legacy.parser
                 ORDER BY legacy.created_at DESC, legacy.id DESC
               ) AS canonical_rank
        FROM results_legacy_v11 AS legacy
        JOIN single_attempts ON single_attempts.job_id = legacy.job_id
      )
      SELECT id, job_id, attempt_id, parser, status, energy_hartree, scf_converged,
             imaginary_frequencies, normal_termination, warnings_json, errors_json,
             raw_json, created_at
      FROM ranked_results
      WHERE canonical_rank = 1;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_results_job_attempt_parser
        ON results(job_id, attempt_id, parser);
    `,
  },
  ...MD_SQLITE_MIGRATIONS,
  OPERATION_OUTBOX_SQLITE_MIGRATION,
  EFFECT_DELIVERY_SQLITE_MIGRATION,
  MD_PREPARATION_SQLITE_MIGRATION,
];

function isJobStatus(value: string): value is JobStatus {
  return value in VALID_TRANSITIONS;
}

interface SqliteStatement {
  run(params?: Record<string, unknown>): unknown;
  get(params?: Record<string, unknown>): Record<string, unknown> | undefined;
  all(params?: Record<string, unknown>): Record<string, unknown>[];
}

interface SqliteConnection {
  query(sql: string): SqliteStatement;
}

function runStatements(db: SqliteConnection, sql: string): void {
  for (const statement of splitSqlStatements(sql)) {
    db.query(statement).run();
  }
}

// ── Transaction wrapper for SQLite ─────────────────────────

class SqliteTransaction implements DbTransactionInterface {
  private finalized = false;

  constructor(
    private db: SqliteConnection,
    private onEnd: () => void,
  ) {
    db.query("BEGIN IMMEDIATE").run();
  }

  async commit(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.db.query("COMMIT").run();
    this.onEnd();
  }

  async rollback(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    this.db.query("ROLLBACK").run();
    this.onEnd();
  }

  async query(sql: string, params?: Record<string, unknown> | unknown[]): Promise<unknown> {
    const stmt = this.db.query(sql);
    if (params) {
      if (Array.isArray(params)) {
        // Convert positional to named for SQLite compatibility
        const named: Record<string, unknown> = {};
        params.forEach((p, i) => {
          named[`$${i + 1}`] = p;
        });
        return stmt.run(named);
      }
      return stmt.run(params);
    }
    return stmt.run();
  }

  async queryRows<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: Record<string, unknown> | unknown[],
  ): Promise<T[]> {
    const stmt = this.db.query(sql);
    if (Array.isArray(params)) {
      const named: Record<string, unknown> = {};
      params.forEach((param, index) => {
        named[`$${index + 1}`] = param;
      });
      return stmt.all(named) as T[];
    }
    return stmt.all(params) as T[];
  }
}

export class SqliteDatabase implements DatabaseLike {
  readonly _provider = "sqlite";
  private db: SqliteConnection | null = null;
  private lastTimestamp = 0;
  private transactionCount = 0;
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(private dbPath: string) {}

  async init(): Promise<void> {
    const { Database } = await import("bun:sqlite");
    mkdirSync(dirname(this.dbPath), { recursive: true });
    const d = new Database(this.dbPath);
    this.db = d as SqliteConnection;
    d.query("PRAGMA journal_mode = WAL").run();
    d.query("PRAGMA foreign_keys = ON").run();
    d.query("PRAGMA busy_timeout = 5000").run();
    this.runPendingMigrations();
  }

  private runPendingMigrations(): void {
    const db = this.ensureDb();
    db.query(
      "CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    ).run();
    const applied = db
      .query("SELECT version FROM _migrations")
      .all()
      .map((r: Record<string, unknown>) => r.version as number);
    for (const m of MIGRATIONS) {
      if (!applied.includes(m.version)) {
        // Apply migration inside a transaction for atomicity
        db.query("BEGIN").run();
        try {
          runStatements(db, m.sql);
          db.query(
            "INSERT INTO _migrations (version, name, applied_at) VALUES ($version, $name, $appliedAt)",
          ).run({
            $version: m.version,
            $name: m.name,
            $appliedAt: Date.now(),
          });
          db.query("COMMIT").run();
        } catch (err) {
          db.query("ROLLBACK").run();
          throw new DbError(
            `Migration v${m.version} (${m.name}) failed: ${err instanceof Error ? err.message : String(err)}`,
            DbErrorCode.MIGRATION,
          );
        }
      }
    }
  }

  private ensureDb(): SqliteConnection {
    if (!this.db)
      throw new DbError(
        "Database not initialized. Call init() first.",
        DbErrorCode.NOT_INITIALIZED,
      );
    return this.db;
  }

  private nextTimestamp(): number {
    const now = Date.now();
    this.lastTimestamp = Math.max(now, this.lastTimestamp + 1);
    return this.lastTimestamp;
  }

  // ── Transaction support ──────────────────────────────────

  async beginTransaction(): Promise<DbTransactionInterface> {
    const db = this.ensureDb();
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.transactionCount++;
    try {
      return new SqliteTransaction(db, () => {
        this.transactionCount--;
        release();
      });
    } catch (error) {
      this.transactionCount--;
      release();
      throw error;
    }
  }

  private emitBaseEvent(
    event: Omit<EigenGridEventBase, "id" | "at" | "source"> & {
      source?: EigenGridEventBase["source"];
    },
  ): void {
    const db = this.ensureDb();
    const fullEvent: EigenGridEventBase = {
      id: generateId("evt"),
      at: this.nextTimestamp(),
      source: event.source ?? "db",
      ...event,
    };

    let sequence: number | null = null;
    if (fullEvent.jobId) {
      const row = db
        .query(
          "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM job_events WHERE job_id = $jobId",
        )
        .get({ $jobId: fullEvent.jobId }) as { next_seq: number } | undefined;
      sequence = row?.next_seq ?? null;
    }

    db.query(
      `INSERT INTO job_events (job_id, type, event_id, source, attempt_id, artifact_id, result_id, sequence, schema_version, payload_json, created_at)
       VALUES ($jobId, $type, $eventId, $source, $attemptId, $artifactId, $resultId, $sequence, $schemaVersion, $payloadJson, $createdAt)`,
    ).run({
      $jobId: fullEvent.jobId ?? "system",
      $type: fullEvent.type,
      $eventId: fullEvent.id,
      $source: fullEvent.source,
      $attemptId: fullEvent.attemptId ?? null,
      $artifactId: fullEvent.artifactId ?? null,
      $resultId: fullEvent.resultId ?? null,
      $sequence: sequence,
      $schemaVersion: 1,
      $payloadJson: fullEvent.payload ? JSON.stringify(fullEvent.payload) : null,
      $createdAt: fullEvent.at,
    });
  }

  async createJob(job: {
    id: string;
    name: string;
    software: string;
    inputPath: string;
    workdir: string;
    outputPath?: string;
    ownerUserId?: string;
    projectId?: string;
    backend?: string;
  }): Promise<void> {
    const db = this.ensureDb();
    const now = this.nextTimestamp();
    db.query(
      "INSERT INTO jobs (id, name, software, input_path, workdir, output_path, owner_user_id, project_id, backend, status, created_at, updated_at) VALUES ($id, $name, $software, $inputPath, $workdir, $outputPath, $ownerUserId, $projectId, $backend, $status, $createdAt, $updatedAt)",
    ).run({
      $id: job.id,
      $name: job.name,
      $software: job.software,
      $inputPath: job.inputPath,
      $workdir: job.workdir,
      $outputPath: job.outputPath ?? null,
      $ownerUserId: job.ownerUserId ?? null,
      $projectId: job.projectId ?? null,
      $backend: job.backend ?? null,
      $status: "created",
      $createdAt: now,
      $updatedAt: now,
    });
  }

  async createJobAttempt(attempt: {
    id: string;
    jobId: string;
    runner: RunnerKind;
    command: string;
    cwd: string;
    status?: JobAttemptStatus;
    pid?: number;
    exitCode?: number;
    startedAt?: number;
    finishedAt?: number;
  }): Promise<void> {
    const db = this.ensureDb();
    const status = attempt.status ?? "created";
    if (!isJobAttemptStatus(status)) {
      throw new DbError(`Invalid job attempt status: ${status}`, DbErrorCode.INVALID_TRANSITION);
    }

    // Wrap state insert + event emission in a transaction for atomicity
    db.query("BEGIN IMMEDIATE").run();
    try {
      const now = this.nextTimestamp();
      db.query(
        "INSERT INTO job_attempts (id, job_id, runner, status, command, cwd, pid, exit_code, started_at, finished_at, created_at, updated_at) VALUES ($id, $jobId, $runner, $status, $command, $cwd, $pid, $exitCode, $startedAt, $finishedAt, $createdAt, $updatedAt)",
      ).run({
        $id: attempt.id,
        $jobId: attempt.jobId,
        $runner: attempt.runner,
        $status: status,
        $command: attempt.command,
        $cwd: attempt.cwd,
        $pid: attempt.pid ?? null,
        $exitCode: attempt.exitCode ?? null,
        $startedAt: attempt.startedAt ?? null,
        $finishedAt: attempt.finishedAt ?? null,
        $createdAt: now,
        $updatedAt: now,
      });

      // Emit event after creating attempt
      this.emitBaseEvent({
        type: "attempt.created",
        jobId: attempt.jobId,
        attemptId: attempt.id,
        payload: { runner: attempt.runner, command: attempt.command, cwd: attempt.cwd },
      });
      db.query("COMMIT").run();
    } catch (err) {
      db.query("ROLLBACK").run();
      throw err;
    }
  }

  async updateJobAttemptStatus(
    attemptId: string,
    status: JobAttemptStatus,
    updates?: {
      pid?: number;
      startedAt?: number;
      exitCode?: number;
      finishedAt?: number;
    },
  ): Promise<void> {
    const db = this.ensureDb();
    if (!isJobAttemptStatus(status)) {
      throw new DbInvalidTransitionError("job_attempt", "", status, [...JOB_ATTEMPT_STATUSES]);
    }

    db.query("BEGIN IMMEDIATE").run();
    try {
      const current = db
        .query("SELECT * FROM job_attempts WHERE id = $attemptId")
        .get({ $attemptId: attemptId });
      if (!current) throw new DbNotFoundError("JobAttempt", attemptId);

      const previousStatus = String(current.status) as JobAttemptStatus;

      // Same-state no-op: no updated_at rewrite, no status event
      if (previousStatus === status) {
        db.query("COMMIT").run();
        return;
      }

      if (!isValidAttemptTransition(previousStatus, status)) {
        const allowed = [...(VALID_ATTEMPT_TRANSITIONS[previousStatus] ?? [])];
        throw new DbInvalidTransitionError(
          "job_attempt",
          previousStatus,
          status,
          allowed.map(String),
        );
      }

      const fields = ["status = $status", "updated_at = $updatedAt"];
      const params: Record<string, unknown> = {
        $attemptId: attemptId,
        $status: status,
        $updatedAt: this.nextTimestamp(),
      };

      if (updates?.pid !== undefined) {
        fields.push("pid = $pid");
        params.$pid = updates.pid;
      }
      if (updates?.startedAt !== undefined) {
        fields.push("started_at = $startedAt");
        params.$startedAt = updates.startedAt;
      }
      if (updates?.exitCode !== undefined) {
        fields.push("exit_code = $exitCode");
        params.$exitCode = updates.exitCode;
      }
      if (updates?.finishedAt !== undefined) {
        fields.push("finished_at = $finishedAt");
        params.$finishedAt = updates.finishedAt;
      }

      params.$previousStatus = previousStatus;
      const transitioned = db
        .query(
          `UPDATE job_attempts SET ${fields.join(", ")}
           WHERE id = $attemptId AND status = $previousStatus`,
        )
        .run(params) as { changes: number };
      if (transitioned.changes !== 1) {
        throw new DbError(
          `Concurrent job attempt transition for ${attemptId}`,
          DbErrorCode.CONSTRAINT,
        );
      }

      // Emit event after successful transition
      this.emitBaseEvent({
        type: "attempt.status.changed",
        jobId: String(current.job_id),
        attemptId,
        payload: {
          from: previousStatus,
          to: status,
          ...(updates?.pid !== undefined ? { pid: updates.pid } : {}),
          ...(updates?.exitCode !== undefined ? { exitCode: updates.exitCode } : {}),
        },
      });
      db.query("COMMIT").run();
    } catch (err) {
      db.query("ROLLBACK").run();
      throw err;
    }
  }

  async listJobAttempts(jobId?: string): Promise<JobAttempt[]> {
    const db = this.ensureDb();
    const rows = jobId
      ? db
          .query("SELECT * FROM job_attempts WHERE job_id = $jobId ORDER BY created_at ASC")
          .all({ $jobId: jobId })
      : db.query("SELECT * FROM job_attempts ORDER BY created_at ASC").all();

    return rows.map((row: Record<string, unknown>) => mapJobAttemptRowHelper(row));
  }

  async createArtifact(artifact: Omit<Artifact, "createdAt">): Promise<void> {
    const db = this.ensureDb();

    // Wrap state insert + event emission in a transaction for atomicity
    db.query("BEGIN IMMEDIATE").run();
    try {
      const now = this.nextTimestamp();
      db.query(
        "INSERT INTO artifacts (id, job_id, attempt_id, kind, path, label, mime_type, size_bytes, created_at) VALUES ($id, $jobId, $attemptId, $kind, $path, $label, $mimeType, $sizeBytes, $createdAt)",
      ).run({
        $id: artifact.id,
        $jobId: artifact.jobId,
        $attemptId: artifact.attemptId,
        $kind: artifact.kind,
        $path: artifact.path,
        $label: artifact.label ?? null,
        $mimeType: artifact.mimeType ?? null,
        $sizeBytes: artifact.sizeBytes ?? null,
        $createdAt: now,
      });

      // Emit event after registering artifact
      this.emitBaseEvent({
        type: "artifact.registered",
        jobId: artifact.jobId,
        attemptId: artifact.attemptId,
        artifactId: artifact.id,
        payload: {
          kind: artifact.kind,
          path: artifact.path,
          label: artifact.label ?? null,
          mimeType: artifact.mimeType ?? null,
          sizeBytes: artifact.sizeBytes ?? null,
        },
      });
      db.query("COMMIT").run();
    } catch (err) {
      db.query("ROLLBACK").run();
      throw err;
    }
  }

  async createArtifactIfAbsent(artifact: Omit<Artifact, "createdAt">): Promise<boolean> {
    const db = this.ensureDb();
    db.query("BEGIN IMMEDIATE").run();
    try {
      const existing = db
        .query(
          `SELECT id FROM artifacts
           WHERE job_id = $jobId AND attempt_id = $attemptId AND kind = $kind AND path = $path
           LIMIT 1`,
        )
        .get({
          $jobId: artifact.jobId,
          $attemptId: artifact.attemptId,
          $kind: artifact.kind,
          $path: artifact.path,
        });
      if (existing) {
        db.query("COMMIT").run();
        return false;
      }

      const now = this.nextTimestamp();
      db.query(
        "INSERT INTO artifacts (id, job_id, attempt_id, kind, path, label, mime_type, size_bytes, created_at) VALUES ($id, $jobId, $attemptId, $kind, $path, $label, $mimeType, $sizeBytes, $createdAt)",
      ).run({
        $id: artifact.id,
        $jobId: artifact.jobId,
        $attemptId: artifact.attemptId,
        $kind: artifact.kind,
        $path: artifact.path,
        $label: artifact.label ?? null,
        $mimeType: artifact.mimeType ?? null,
        $sizeBytes: artifact.sizeBytes ?? null,
        $createdAt: now,
      });
      this.emitBaseEvent({
        type: "artifact.registered",
        jobId: artifact.jobId,
        attemptId: artifact.attemptId,
        artifactId: artifact.id,
        payload: {
          kind: artifact.kind,
          path: artifact.path,
          label: artifact.label ?? null,
          mimeType: artifact.mimeType ?? null,
          sizeBytes: artifact.sizeBytes ?? null,
        },
      });
      db.query("COMMIT").run();
      return true;
    } catch (err) {
      db.query("ROLLBACK").run();
      throw err;
    }
  }

  async listArtifacts(jobId?: string): Promise<Artifact[]> {
    const db = this.ensureDb();
    const rows = jobId
      ? db
          .query("SELECT * FROM artifacts WHERE job_id = $jobId ORDER BY created_at ASC")
          .all({ $jobId: jobId })
      : db.query("SELECT * FROM artifacts ORDER BY created_at ASC").all();

    return rows.map((row: Record<string, unknown>) => mapArtifactRowHelper(row));
  }

  async materializeTerminalAttempt(evidence: TerminalAttemptEvidence): Promise<void> {
    const db = this.ensureDb();
    db.query("BEGIN IMMEDIATE").run();
    try {
      const attempt = db
        .query(
          `SELECT status, exit_code, finished_at FROM job_attempts
           WHERE id = $attemptId AND job_id = $jobId`,
        )
        .get({ $attemptId: evidence.attemptId, $jobId: evidence.jobId });
      if (!attempt) throw new DbNotFoundError("JobAttempt", evidence.attemptId);

      const job = db
        .query("SELECT status FROM jobs WHERE id = $jobId")
        .get({ $jobId: evidence.jobId });
      if (!job) throw new DbNotFoundError("Job", evidence.jobId);

      const terminalType =
        evidence.status === "completed"
          ? "process.completed"
          : evidence.status === "cancelled"
            ? "process.cancelled"
            : "process.failed";
      const terminalEvents = db
        .query(
          `SELECT type, payload_json FROM job_events
           WHERE job_id = $jobId AND attempt_id = $attemptId
             AND type IN ('process.completed', 'process.failed', 'process.cancelled')`,
        )
        .all({ $jobId: evidence.jobId, $attemptId: evidence.attemptId });
      const conflictingEvent = terminalEvents.find((event) => String(event.type) !== terminalType);
      if (conflictingEvent) {
        throw new DbError(
          `Conflicting terminal evidence for attempt ${evidence.attemptId}`,
          DbErrorCode.CONSTRAINT,
        );
      }
      for (const event of terminalEvents) {
        if (event.payload_json == null || evidence.exitCode === undefined) continue;
        let payload: Record<string, unknown> | null = null;
        try {
          payload = JSON.parse(String(event.payload_json)) as Record<string, unknown>;
        } catch {
          throw new DbError(
            `Malformed terminal evidence for attempt ${evidence.attemptId}`,
            DbErrorCode.CONSTRAINT,
          );
        }
        if (payload.exitCode != null && Number(payload.exitCode) !== evidence.exitCode) {
          throw new DbError(
            `Conflicting terminal metadata for attempt ${evidence.attemptId}`,
            DbErrorCode.CONSTRAINT,
          );
        }
      }

      const previousAttemptStatus = String(attempt.status) as JobAttemptStatus;
      if (previousAttemptStatus === evidence.status) {
        const storedExitCode = attempt.exit_code == null ? undefined : Number(attempt.exit_code);
        const storedFinishedAt =
          attempt.finished_at == null ? undefined : Number(attempt.finished_at);
        if (storedExitCode !== evidence.exitCode || storedFinishedAt !== evidence.finishedAt) {
          throw new DbError(
            `Conflicting terminal metadata for attempt ${evidence.attemptId}`,
            DbErrorCode.CONSTRAINT,
          );
        }
      }
      if (
        previousAttemptStatus !== evidence.status &&
        !isValidAttemptTransition(previousAttemptStatus, evidence.status)
      ) {
        throw new DbInvalidTransitionError(
          "job_attempt",
          previousAttemptStatus,
          evidence.status,
          [...(VALID_ATTEMPT_TRANSITIONS[previousAttemptStatus] ?? [])].map(String),
        );
      }

      const attemptStatusChanged = previousAttemptStatus !== evidence.status;
      if (attemptStatusChanged) {
        const fields = ["status = $status", "finished_at = $finishedAt", "updated_at = $updatedAt"];
        const params: Record<string, unknown> = {
          $status: evidence.status,
          $finishedAt: evidence.finishedAt,
          $updatedAt: this.nextTimestamp(),
          $attemptId: evidence.attemptId,
          $jobId: evidence.jobId,
        };
        if (evidence.exitCode !== undefined) {
          fields.push("exit_code = $exitCode");
          params.$exitCode = evidence.exitCode;
        }
        db.query(
          `UPDATE job_attempts SET ${fields.join(", ")}
           WHERE id = $attemptId AND job_id = $jobId`,
        ).run(params);
      }
      if (attemptStatusChanged) {
        this.emitBaseEvent({
          type: "attempt.status.changed",
          jobId: evidence.jobId,
          attemptId: evidence.attemptId,
          payload: {
            from: previousAttemptStatus,
            to: evidence.status,
            ...(evidence.exitCode !== undefined ? { exitCode: evidence.exitCode } : {}),
          },
        });
      }

      const previousJobStatus = String(job.status);
      if (previousJobStatus !== evidence.status) {
        if (
          !isJobStatus(previousJobStatus) ||
          !canTransitionJobStatus(previousJobStatus, evidence.status)
        ) {
          const allowed = VALID_TRANSITIONS[previousJobStatus as JobStatus] ?? [];
          throw new DbInvalidTransitionError("job", previousJobStatus, evidence.status, [
            ...allowed,
          ]);
        }
        db.query("UPDATE jobs SET status = $status, updated_at = $updatedAt WHERE id = $jobId").run(
          {
            $status: evidence.status,
            $updatedAt: this.nextTimestamp(),
            $jobId: evidence.jobId,
          },
        );
        this.emitBaseEvent({
          type: "job.status.changed",
          jobId: evidence.jobId,
          payload: { from: previousJobStatus, to: evidence.status },
        });
      }

      if (terminalEvents.length === 0) {
        this.emitBaseEvent({
          type: terminalType,
          jobId: evidence.jobId,
          attemptId: evidence.attemptId,
          source: evidence.source,
          payload: evidence.payload,
        });
      }

      db.query("COMMIT").run();
    } catch (err) {
      db.query("ROLLBACK").run();
      throw err;
    }
  }

  async updateJobStatus(jobId: string, status: string): Promise<void> {
    const db = this.ensureDb();
    db.query("BEGIN IMMEDIATE").run();
    try {
      const current = db.query("SELECT status FROM jobs WHERE id = $jobId").get({ $jobId: jobId });
      if (!current) throw new DbNotFoundError("Job", jobId);

      const currentStatus = String(current.status ?? "");

      // Same-state no-op: no updated_at rewrite, no status event
      if (currentStatus === status) {
        db.query("COMMIT").run();
        return;
      }

      if (
        !isJobStatus(currentStatus) ||
        !isJobStatus(status) ||
        !canTransitionJobStatus(currentStatus, status)
      ) {
        const allowed = VALID_TRANSITIONS[currentStatus as JobStatus] ?? [];
        throw new DbInvalidTransitionError("job", currentStatus, status, [...allowed]);
      }

      const transitioned = db
        .query(
          `UPDATE jobs SET status = $status, updated_at = $updatedAt
           WHERE id = $jobId AND status = $currentStatus`,
        )
        .run({
          $status: status,
          $updatedAt: this.nextTimestamp(),
          $jobId: jobId,
          $currentStatus: currentStatus,
        }) as { changes: number };
      if (transitioned.changes !== 1) {
        throw new DbError(`Concurrent job transition for ${jobId}`, DbErrorCode.CONSTRAINT);
      }

      // Emit event after successful transition
      this.emitBaseEvent({
        type: "job.status.changed",
        jobId,
        payload: { from: currentStatus, to: status },
      });
      db.query("COMMIT").run();
    } catch (err) {
      db.query("ROLLBACK").run();
      throw err;
    }
  }

  async updateJobExternalMetadata(
    jobId: string,
    metadata: {
      backend?: string;
      externalJobId?: string;
      externalState?: string;
      lastSyncAt?: number;
      nativeDetail?: string;
      nodeName?: string;
    },
  ): Promise<void> {
    const db = this.ensureDb();
    const sets: string[] = [];
    const params: Record<string, unknown> = { $id: jobId };

    if (metadata.backend !== undefined) {
      sets.push("backend = $backend");
      params.$backend = metadata.backend;
    }
    if (metadata.externalJobId !== undefined) {
      sets.push("external_job_id = $externalJobId");
      params.$externalJobId = metadata.externalJobId;
    }
    if (metadata.externalState !== undefined) {
      sets.push("external_state = $externalState");
      params.$externalState = metadata.externalState;
    }
    if (metadata.lastSyncAt !== undefined) {
      sets.push("last_sync_at = $lastSyncAt");
      params.$lastSyncAt = metadata.lastSyncAt;
    }
    if (metadata.nativeDetail !== undefined) {
      sets.push("native_detail = $nativeDetail");
      params.$nativeDetail = metadata.nativeDetail;
    }
    if (metadata.nodeName !== undefined) {
      sets.push("node_name = $nodeName");
      params.$nodeName = metadata.nodeName;
    }

    if (sets.length === 0) return;
    sets.push("updated_at = $updatedAt");
    params.$updatedAt = Date.now();

    db.query(`UPDATE jobs SET ${sets.join(", ")} WHERE id = $id`).run(params);
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    const db = this.ensureDb();
    const row = db.query("SELECT * FROM jobs WHERE id = $jobId").get({ $jobId: jobId });
    if (!row) return null;
    return mapJobRow(row as Record<string, unknown>);
  }

  async resolveJobId(prefix: string): Promise<string> {
    const db = this.ensureDb();
    const rows = db
      .query("SELECT id FROM jobs WHERE id LIKE $prefix")
      .all({ $prefix: `${prefix}%` });
    if (rows.length === 0) throw new DbNotFoundError("Job", prefix);
    if (rows.length > 1) throw new DbAmbiguousPrefixError("job", prefix, rows.length);
    return String(rows[0].id);
  }

  async listJobs(): Promise<JobRecord[]> {
    const db = this.ensureDb();
    return db
      .query("SELECT * FROM jobs ORDER BY created_at DESC")
      .all()
      .map((r: Record<string, unknown>) => mapJobRow(r));
  }

  async appendEvent(event: EigenGridEventBase): Promise<void> {
    const { appendEvent: queryAppendEvent } = await import("./queries/events");
    await queryAppendEvent(this, event);
  }

  /** @deprecated Use appendEvent instead */
  async insertEvent(event: EigenGridEvent): Promise<void> {
    const db = this.ensureDb();
    const payloadJson = JSON.stringify(event);
    db.query(
      "INSERT INTO job_events (job_id, type, payload_json, created_at) VALUES ($jobId, $type, $payloadJson, $createdAt)",
    ).run({
      $jobId: "jobId" in event && event.jobId ? event.jobId : "system",
      $type: event.type,
      $payloadJson: payloadJson,
      $createdAt: event.at ?? this.nextTimestamp(),
    });
  }

  async getLogs(jobId: string, stream?: string, tail?: number): Promise<LogLine[]> {
    const db = this.ensureDb();
    const params: Record<string, unknown> = { $jobId: jobId };

    let whereClause = "WHERE job_id = $jobId";
    if (stream) {
      whereClause += " AND stream = $stream";
      params.$stream = stream;
    }

    if (tail != null) {
      const sql = `SELECT stream, line, created_at FROM job_logs ${whereClause} ORDER BY id DESC LIMIT ${tail}`;
      const rows = db.query(sql).all(params);
      return rows.reverse().map((r: Record<string, unknown>) => ({
        stream: readString(r, "stream"),
        line: readString(r, "line"),
        createdAt: readNumber(r, "created_at"),
      }));
    }

    const sql = `SELECT stream, line, created_at FROM job_logs ${whereClause} ORDER BY id ASC`;
    const rows = db.query(sql).all(params);
    return rows.map((r: Record<string, unknown>) => ({
      stream: readString(r, "stream"),
      line: readString(r, "line"),
      createdAt: readNumber(r, "created_at"),
    }));
  }

  async getEvents(jobId?: string): Promise<EventRecord[]> {
    const db = this.ensureDb();
    const rows: Record<string, unknown>[] = jobId
      ? db
          .query(
            "SELECT * FROM job_events WHERE job_id = $jobId ORDER BY sequence ASC, created_at ASC",
          )
          .all({ $jobId: jobId })
      : db.query("SELECT * FROM job_events ORDER BY sequence ASC, created_at ASC LIMIT 100").all();
    return rows.map((row) => mapEventRow(row));
  }

  // ── Permission Methods ─────────────────────────────────

  async listPermissions(projectId?: string): Promise<PermissionRecord[]> {
    const db = this.ensureDb();
    const rows = projectId
      ? db
          .query("SELECT * FROM permissions WHERE project_id = $projectId ORDER BY created_at ASC")
          .all({ $projectId: projectId })
      : db.query("SELECT * FROM permissions ORDER BY created_at ASC").all();
    return rows.map((row: Record<string, unknown>) => ({
      id: String(row.id),
      action: String(row.action),
      resource: String(row.resource),
      effect: String(row.effect) as PermissionEffect,
      ...(typeof row.project_id === "string" ? { projectId: row.project_id } : {}),
      ...(typeof row.label === "string" ? { label: row.label } : {}),
    })) as unknown as PermissionRecord[];
  }

  // ── Users ─────────────────────────────────

  async createUser(user: {
    id: string;
    username: string;
    displayName?: string;
    email?: string;
  }): Promise<void> {
    const db = this.ensureDb();
    const now = this.nextTimestamp();
    db.query(
      "INSERT INTO users (id, username, display_name, email, status, created_at, updated_at) VALUES ($id, $username, $displayName, $email, 'active', $createdAt, $updatedAt)",
    ).run({
      $id: user.id,
      $username: user.username,
      $displayName: user.displayName ?? null,
      $email: user.email ?? null,
      $createdAt: now,
      $updatedAt: now,
    });
  }

  async getUser(userId: string): Promise<UserRecord | null> {
    const row = this.ensureDb().query("SELECT * FROM users WHERE id = $id").get({ $id: userId });
    if (!row) return null;
    return mapUserRow(row as Record<string, unknown>);
  }

  async getUserByUsername(username: string): Promise<UserRecord | null> {
    const row = this.ensureDb()
      .query("SELECT * FROM users WHERE username = $username")
      .get({ $username: username });
    if (!row) return null;
    return mapUserRow(row as Record<string, unknown>);
  }

  async listUsers(): Promise<UserRecord[]> {
    const rows = this.ensureDb().query("SELECT * FROM users ORDER BY created_at ASC").all();
    return rows.map((r: Record<string, unknown>) => mapUserRow(r));
  }

  async disableUser(userId: string): Promise<void> {
    this.ensureDb()
      .query("UPDATE users SET status = 'disabled', updated_at = $updatedAt WHERE id = $id")
      .run({
        $id: userId,
        $updatedAt: Date.now(),
      });
  }

  async enableUser(userId: string): Promise<void> {
    this.ensureDb()
      .query("UPDATE users SET status = 'active', updated_at = $updatedAt WHERE id = $id")
      .run({
        $id: userId,
        $updatedAt: Date.now(),
      });
  }

  // ── Projects ─────────────────────────────

  async createProject(project: {
    id: string;
    name: string;
    description?: string;
    maxConcurrentJobs?: number;
  }): Promise<void> {
    const db = this.ensureDb();
    const now = this.nextTimestamp();
    db.query(
      "INSERT INTO projects (id, name, description, status, max_concurrent_jobs, created_at, updated_at) VALUES ($id, $name, $description, 'active', $maxConcurrentJobs, $createdAt, $updatedAt)",
    ).run({
      $id: project.id,
      $name: project.name,
      $description: project.description ?? null,
      $maxConcurrentJobs: project.maxConcurrentJobs ?? 10,
      $createdAt: now,
      $updatedAt: now,
    });
  }

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    const row = this.ensureDb()
      .query("SELECT * FROM projects WHERE id = $id")
      .get({ $id: projectId });
    if (!row) return null;
    return mapProjectRow(row as Record<string, unknown>);
  }

  async getProjectByName(name: string): Promise<ProjectRecord | null> {
    const row = this.ensureDb()
      .query("SELECT * FROM projects WHERE name = $name")
      .get({ $name: name });
    if (!row) return null;
    return mapProjectRow(row as Record<string, unknown>);
  }

  async listProjects(): Promise<ProjectRecord[]> {
    const rows = this.ensureDb().query("SELECT * FROM projects ORDER BY created_at ASC").all();
    return rows.map((r: Record<string, unknown>) => mapProjectRow(r));
  }

  async archiveProject(projectId: string): Promise<void> {
    this.ensureDb()
      .query("UPDATE projects SET status = 'archived', updated_at = $updatedAt WHERE id = $id")
      .run({
        $id: projectId,
        $updatedAt: Date.now(),
      });
  }

  async resolveProjectId(prefix: string): Promise<string> {
    const db = this.ensureDb();
    const rows = db
      .query("SELECT id FROM projects WHERE id LIKE $prefix")
      .all({ $prefix: `${prefix}%` });
    if (rows.length === 0) {
      const nameRows = db
        .query("SELECT id FROM projects WHERE name = $name")
        .all({ $name: prefix });
      if (nameRows.length === 0) throw new DbNotFoundError("Project", prefix);
      if (nameRows.length > 1) throw new DbAmbiguousPrefixError("project", prefix, nameRows.length);
      return String(nameRows[0].id);
    }
    if (rows.length > 1) throw new DbAmbiguousPrefixError("project", prefix, rows.length);
    return String(rows[0].id);
  }

  // ── Memberships ──────────────────────────

  async addProjectMember(projectId: string, userId: string, role?: string): Promise<void> {
    const db = this.ensureDb();
    const now = this.nextTimestamp();
    const id = `mem-${projectId}-${userId}`;
    db.query(
      "INSERT OR IGNORE INTO project_memberships (id, project_id, user_id, role, created_at, updated_at) VALUES ($id, $projectId, $userId, $role, $createdAt, $updatedAt)",
    ).run({
      $id: id,
      $projectId: projectId,
      $userId: userId,
      $role: role ?? "member",
      $createdAt: now,
      $updatedAt: now,
    });
  }

  async removeProjectMember(projectId: string, userId: string): Promise<void> {
    this.ensureDb()
      .query("DELETE FROM project_memberships WHERE project_id = $projectId AND user_id = $userId")
      .run({ $projectId: projectId, $userId: userId });
  }

  async listProjectMembers(projectId: string): Promise<MembershipRecord[]> {
    const rows = this.ensureDb()
      .query(
        "SELECT * FROM project_memberships WHERE project_id = $projectId ORDER BY created_at ASC",
      )
      .all({ $projectId: projectId });
    return rows.map((r: Record<string, unknown>) => mapMembershipRow(r));
  }

  async listUserProjects(userId: string): Promise<ProjectRecord[]> {
    const rows = this.ensureDb()
      .query(
        `SELECT p.* FROM projects p
       JOIN project_memberships pm ON p.id = pm.project_id
       WHERE pm.user_id = $userId ORDER BY p.created_at ASC`,
      )
      .all({ $userId: userId });
    return rows.map((r: Record<string, unknown>) => mapProjectRow(r));
  }

  // ── Quotas ───────────────────────────────

  async getProjectQuota(projectId: string): Promise<QuotaRecord | null> {
    const row = this.ensureDb()
      .query("SELECT * FROM project_quotas WHERE project_id = $projectId")
      .get({ $projectId: projectId });
    if (!row) return null;
    return mapQuotaRow(row as Record<string, unknown>);
  }

  async setProjectQuota(
    projectId: string,
    quota: {
      maxCpuThreads?: number;
      maxMemoryMb?: number;
      maxScratchMb?: number;
      maxJobsTotal?: number;
    },
  ): Promise<void> {
    const db = this.ensureDb();
    const now = this.nextTimestamp();
    const existing = await this.getProjectQuota(projectId);
    if (existing) {
      const fields: string[] = ["updated_at = $updatedAt"];
      const params: Record<string, unknown> = { $projectId: projectId, $updatedAt: now };
      if (quota.maxCpuThreads !== undefined) {
        fields.push("max_cpu_threads = $maxCpu");
        params.$maxCpu = quota.maxCpuThreads;
      }
      if (quota.maxMemoryMb !== undefined) {
        fields.push("max_memory_mb = $maxMem");
        params.$maxMem = quota.maxMemoryMb;
      }
      if (quota.maxScratchMb !== undefined) {
        fields.push("max_scratch_mb = $maxScratch");
        params.$maxScratch = quota.maxScratchMb;
      }
      if (quota.maxJobsTotal !== undefined) {
        fields.push("max_jobs_total = $maxJobs");
        params.$maxJobs = quota.maxJobsTotal;
      }
      db.query(`UPDATE project_quotas SET ${fields.join(", ")} WHERE project_id = $projectId`).run(
        params,
      );
    } else {
      db.query(
        "INSERT INTO project_quotas (id, project_id, max_cpu_threads, max_memory_mb, max_scratch_mb, max_jobs_total, created_at, updated_at) VALUES ($id, $projectId, $maxCpu, $maxMem, $maxScratch, $maxJobs, $createdAt, $updatedAt)",
      ).run({
        $id: `quota-${projectId}`,
        $projectId: projectId,
        $maxCpu: quota.maxCpuThreads ?? 0,
        $maxMem: quota.maxMemoryMb ?? 0,
        $maxScratch: quota.maxScratchMb ?? 0,
        $maxJobs: quota.maxJobsTotal ?? 0,
        $createdAt: now,
        $updatedAt: now,
      });
    }
  }

  // ── Usage ────────────────────────────────

  async recordUsage(usage: {
    id: string;
    projectId: string;
    userId: string;
    jobId: string;
    cpuThreads?: number;
    memoryMb?: number;
    scratchMb?: number;
    walltimeMs?: number;
  }): Promise<void> {
    const now = this.nextTimestamp();
    this.ensureDb()
      .query(
        "INSERT INTO usage_records (id, project_id, user_id, job_id, cpu_threads, memory_mb, scratch_mb, walltime_ms, recorded_at) VALUES ($id, $projectId, $userId, $jobId, $cpu, $mem, $scratch, $walltime, $recordedAt)",
      )
      .run({
        $id: usage.id,
        $projectId: usage.projectId,
        $userId: usage.userId,
        $jobId: usage.jobId,
        $cpu: usage.cpuThreads ?? 1,
        $mem: usage.memoryMb ?? 1024,
        $scratch: usage.scratchMb ?? 1024,
        $walltime: usage.walltimeMs ?? null,
        $recordedAt: now,
      });
  }

  async getProjectUsage(projectId: string): Promise<UsageRecord[]> {
    const rows = this.ensureDb()
      .query(
        "SELECT * FROM usage_records WHERE project_id = $projectId ORDER BY recorded_at DESC LIMIT 1000",
      )
      .all({ $projectId: projectId });
    return rows.map((r: Record<string, unknown>) => mapUsageRow(r));
  }

  async getUserUsage(userId: string): Promise<UsageRecord[]> {
    const rows = this.ensureDb()
      .query(
        "SELECT * FROM usage_records WHERE user_id = $userId ORDER BY recorded_at DESC LIMIT 1000",
      )
      .all({ $userId: userId });
    return rows.map((r: Record<string, unknown>) => mapUsageRow(r));
  }

  async getProjectAggregatedUsage(projectId: string): Promise<{
    totalCpuThreads: number;
    totalMemoryMb: number;
    totalScratchMb: number;
    totalWalltimeMs: number;
    jobCount: number;
  }> {
    const row = this.ensureDb()
      .query(
        `SELECT
        COALESCE(SUM(cpu_threads), 0) AS total_cpu,
        COALESCE(SUM(memory_mb), 0) AS total_mem,
        COALESCE(SUM(scratch_mb), 0) AS total_scratch,
        COALESCE(SUM(walltime_ms), 0) AS total_walltime,
        COUNT(DISTINCT job_id) AS job_count
      FROM usage_records WHERE project_id = $projectId`,
      )
      .get({ $projectId: projectId }) as Record<string, unknown>;
    return {
      totalCpuThreads: Number(row?.total_cpu ?? 0),
      totalMemoryMb: Number(row?.total_mem ?? 0),
      totalScratchMb: Number(row?.total_scratch ?? 0),
      totalWalltimeMs: Number(row?.total_walltime ?? 0),
      jobCount: Number(row?.job_count ?? 0),
    };
  }

  // ── Privilege Checks ─────────────────────

  async isUserDisabled(userId: string): Promise<boolean> {
    const row = this.ensureDb()
      .query("SELECT status FROM users WHERE id = $id")
      .get({ $id: userId }) as Record<string, unknown> | undefined;
    return row != null && String(row.status ?? "") === "disabled";
  }

  async createPermission(permission: {
    id: string;
    action: string;
    resource?: string;
    effect: PermissionEffect;
    projectId?: string;
    label?: string;
  }): Promise<void> {
    const db = this.ensureDb();
    const now = this.nextTimestamp();
    db.query(
      "INSERT INTO permissions (id, action, resource, effect, project_id, label, created_at, updated_at) VALUES ($id, $action, $resource, $effect, $projectId, $label, $createdAt, $updatedAt)",
    ).run({
      $id: permission.id,
      $action: permission.action,
      $resource: permission.resource ?? "*",
      $effect: permission.effect,
      $projectId: permission.projectId ?? null,
      $label: permission.label ?? null,
      $createdAt: now,
      $updatedAt: now,
    });
  }

  async removePermission(id: string): Promise<void> {
    this.ensureDb().query("DELETE FROM permissions WHERE id = $id").run({ $id: id });
  }

  // ── Node Methods ──────────────────────────────────────

  async createNode(node: {
    id: string;
    name: string;
    host: string;
    user: string;
    runner: string;
    port?: number;
    maxJobs?: number;
    tags?: string[];
    privateKeyPath?: string;
    remoteScratchDir?: string;
  }): Promise<void> {
    const db = this.ensureDb();
    const now = this.nextTimestamp();
    db.query(
      "INSERT INTO nodes (id, name, host, user, port, runner, status, tags_json, max_jobs, private_key_path, remote_scratch_dir, created_at, updated_at) VALUES ($id, $name, $host, $user, $port, $runner, $status, $tagsJson, $maxJobs, $privateKeyPath, $remoteScratchDir, $createdAt, $updatedAt)",
    ).run({
      $id: node.id,
      $name: node.name,
      $host: node.host,
      $user: node.user,
      $port: node.port ?? 22,
      $runner: node.runner,
      $status: "unknown",
      $tagsJson: JSON.stringify(node.tags ?? []),
      $maxJobs: node.maxJobs ?? 1,
      $privateKeyPath: node.privateKeyPath ?? null,
      $remoteScratchDir: node.remoteScratchDir ?? "/scratch/eigengrid",
      $createdAt: now,
      $updatedAt: now,
    });
  }

  async getNode(nodeId: string): Promise<NodeRecord | null> {
    const row = this.ensureDb().query("SELECT * FROM nodes WHERE id = $id").get({ $id: nodeId });
    if (!row) return null;
    return mapNodeRow(row as Record<string, unknown>);
  }

  async listNodes(): Promise<NodeRecord[]> {
    const rows = this.ensureDb().query("SELECT * FROM nodes ORDER BY created_at ASC").all();
    return rows.map((r: Record<string, unknown>) => mapNodeRow(r));
  }

  async updateNode(nodeId: string, updates: NodeUpdateInput): Promise<void> {
    const values: Record<string, unknown> = { $id: nodeId, $updatedAt: this.nextTimestamp() };
    const fields: string[] = ["updated_at = $updatedAt"];

    const add = (column: string, parameter: string, value: unknown): void => {
      fields.push(`${column} = ${parameter}`);
      values[parameter] = value;
    };

    if (updates.name !== undefined) add("name", "$name", updates.name);
    if (updates.host !== undefined) add("host", "$host", updates.host);
    if (updates.user !== undefined) add("user", "$user", updates.user);
    if (updates.port !== undefined) add("port", "$port", updates.port);
    if (updates.runner !== undefined) add("runner", "$runner", updates.runner);
    if (updates.status !== undefined) add("status", "$status", updates.status);
    if (updates.tags !== undefined) add("tags_json", "$tagsJson", JSON.stringify(updates.tags));
    if (updates.maxJobs !== undefined) add("max_jobs", "$maxJobs", updates.maxJobs);
    if (updates.engines !== undefined) add("engines", "$engines", JSON.stringify(updates.engines));
    if (updates.cpuThreadsTotal !== undefined)
      add("cpu_threads_total", "$cpuThreadsTotal", updates.cpuThreadsTotal);
    if (updates.memoryMbTotal !== undefined)
      add("memory_mb_total", "$memoryMbTotal", updates.memoryMbTotal);
    if (updates.scratchMbTotal !== undefined)
      add("scratch_mb_total", "$scratchMbTotal", updates.scratchMbTotal);
    if (updates.draining !== undefined) add("draining", "$draining", updates.draining ? 1 : 0);
    if (updates.thermalState !== undefined)
      add("thermal_state", "$thermalState", updates.thermalState);
    if (updates.lastSeenAt !== undefined) add("last_seen_at", "$lastSeenAt", updates.lastSeenAt);
    if (updates.isHead !== undefined) add("is_head", "$isHead", updates.isHead ? 1 : 0);
    if (updates.powerMode !== undefined) add("power_mode", "$powerMode", updates.powerMode);
    if (updates.macAddress !== undefined) add("mac_address", "$macAddress", updates.macAddress);
    if (updates.broadcastAddress !== undefined)
      add("broadcast_address", "$broadcastAddress", updates.broadcastAddress);
    if (updates.wolPort !== undefined) add("wol_port", "$wolPort", updates.wolPort);
    if (updates.allowWake !== undefined) add("allow_wake", "$allowWake", updates.allowWake ? 1 : 0);
    if (updates.allowPowerDown !== undefined)
      add("allow_power_down", "$allowPowerDown", updates.allowPowerDown ? 1 : 0);
    if (updates.idlePowerDownAfterSec !== undefined)
      add("idle_power_down_after_sec", "$idlePowerDownAfterSec", updates.idlePowerDownAfterSec);
    if (updates.lastWakeAt !== undefined) add("last_wake_at", "$lastWakeAt", updates.lastWakeAt);
    if (updates.lastPowerDownAt !== undefined)
      add("last_power_down_at", "$lastPowerDownAt", updates.lastPowerDownAt);
    if (updates.privateKeyPath !== undefined)
      add("private_key_path", "$privateKeyPath", updates.privateKeyPath);
    if (updates.remoteScratchDir !== undefined)
      add("remote_scratch_dir", "$remoteScratchDir", updates.remoteScratchDir);

    this.ensureDb()
      .query(`UPDATE nodes SET ${fields.join(", ")} WHERE id = $id`)
      .run(values);
  }

  async removeNode(nodeId: string): Promise<void> {
    this.ensureDb().query("DELETE FROM nodes WHERE id = $id").run({ $id: nodeId });
  }

  async resolveNodeId(prefix: string): Promise<string> {
    const db = this.ensureDb();
    const rows = db
      .query("SELECT id FROM nodes WHERE id LIKE $prefix")
      .all({ $prefix: `${prefix}%` });
    if (rows.length === 0) {
      const nameRows = db.query("SELECT id FROM nodes WHERE name = $name").all({ $name: prefix });
      if (nameRows.length === 0) throw new DbNotFoundError("Node", prefix);
      if (nameRows.length > 1) throw new DbAmbiguousPrefixError("node", prefix, nameRows.length);
      return String(nameRows[0].id);
    }
    if (rows.length > 1) throw new DbAmbiguousPrefixError("node", prefix, rows.length);
    return String(rows[0].id);
  }

  async getNodeByName(name: string): Promise<NodeRecord | null> {
    const row = this.ensureDb()
      .query("SELECT * FROM nodes WHERE name = $name")
      .get({ $name: name });
    if (!row) return null;
    return mapNodeRow(row as Record<string, unknown>);
  }

  // ── Scheduler Dispatch ──────────────────────────────────────

  async claimJobForDispatch(
    jobId: string,
    nodeId: string,
    attemptId: string,
    runner: RunnerKind,
    command: string,
    cwd: string,
  ): Promise<import("./client").ClaimDispatchResult> {
    const db = this.ensureDb();

    db.query("BEGIN IMMEDIATE").run();
    try {
      // 1. Verify job exists and is queued (only queued, not "created")
      const jobRow = db.query("SELECT * FROM jobs WHERE id = $jobId").get({ $jobId: jobId }) as
        | Record<string, unknown>
        | undefined;
      if (!jobRow) {
        db.query("ROLLBACK").run();
        return { claimed: false, reason: "not_found", message: `Job ${jobId} not found` };
      }
      const jobStatus = String(jobRow.status ?? "");
      if (jobStatus !== "queued") {
        db.query("ROLLBACK").run();
        return {
          claimed: false,
          reason: "not_queued",
          message: `Job ${jobId} has status "${jobStatus}", expected "queued"`,
        };
      }

      // 2. Check for existing nonterminal attempts
      const existingAttempts = db
        .query("SELECT id, status FROM job_attempts WHERE job_id = $jobId")
        .all({ $jobId: jobId }) as Record<string, unknown>[];
      const nonTerminal = existingAttempts.find((a) => {
        const s = String(a.status ?? "");
        return s === "created" || s === "queued" || s === "staged" || s === "running";
      });
      if (nonTerminal) {
        db.query("ROLLBACK").run();
        return {
          claimed: false,
          reason: "has_nonterminal_attempt",
          message: `Job ${jobId} has nonterminal attempt ${nonTerminal.id} (${nonTerminal.status})`,
        };
      }

      // 3. Verify node exists and is enabled
      const nodeRow = db
        .query("SELECT * FROM nodes WHERE id = $nodeId")
        .get({ $nodeId: nodeId }) as Record<string, unknown> | undefined;
      if (!nodeRow) {
        db.query("ROLLBACK").run();
        return { claimed: false, reason: "node_invalid", message: `Node ${nodeId} not found` };
      }
      const nodeStatus = String(nodeRow.status ?? "");
      const nodeDraining =
        nodeStatus === "draining" ||
        nodeRow.draining === true ||
        Number(nodeRow.draining ?? 0) === 1;
      if (nodeStatus === "offline" || nodeStatus === "error" || nodeDraining) {
        db.query("ROLLBACK").run();
        return {
          claimed: false,
          reason: "node_invalid",
          message: nodeDraining ? `Node ${nodeId} is draining` : `Node ${nodeId} is ${nodeStatus}`,
        };
      }

      // ── Capacity revalidation: count existing reservations on this node ──
      // Count jobs with node_id = target node and non-terminal status (running, staged, queued)
      // Exclude the current job being claimed. Under BEGIN IMMEDIATE this is serialized.
      const capRow = db
        .query(
          `SELECT
           COUNT(*) AS existing_jobs,
           COALESCE(SUM(cpu_threads), 0) AS used_cpu,
           COALESCE(SUM(memory_mb), 0) AS used_mem,
           COALESCE(SUM(scratch_mb), 0) AS used_scratch
         FROM jobs WHERE node_id = $nodeId AND id != $jobId AND status IN ('queued','staged','running')`,
        )
        .get({ $nodeId: nodeId, $jobId: jobId }) as Record<string, unknown>;
      const existingJobs = Number(capRow?.existing_jobs ?? 0);
      const usedCpu = Number(capRow?.used_cpu ?? 0);
      const usedMem = Number(capRow?.used_mem ?? 0);
      const usedScratch = Number(capRow?.used_scratch ?? 0);
      const jobCpu = Number(jobRow.cpu_threads ?? 1);
      const jobMem = Number(jobRow.memory_mb ?? 1024);
      const jobScratch = Number(jobRow.scratch_mb ?? 1024);
      const nodeMaxJobs = Number(nodeRow.max_jobs ?? 1);
      const nodeCpuTotal = Number(nodeRow.cpu_threads_total ?? 1);
      const nodeMemTotal = Number(nodeRow.memory_mb_total ?? 1024);
      const nodeScratchTotal = Number(nodeRow.scratch_mb_total ?? 10240);

      if (existingJobs >= nodeMaxJobs) {
        db.query("ROLLBACK").run();
        return {
          claimed: false,
          reason: "insufficient_capacity",
          message: `Node ${nodeId} at maxJobs (${nodeMaxJobs})`,
        };
      }
      if (usedCpu + jobCpu > nodeCpuTotal) {
        db.query("ROLLBACK").run();
        return {
          claimed: false,
          reason: "insufficient_capacity",
          message: `Node ${nodeId} insufficient CPU (used ${usedCpu} + need ${jobCpu} > ${nodeCpuTotal})`,
        };
      }
      if (usedMem + jobMem > nodeMemTotal) {
        db.query("ROLLBACK").run();
        return {
          claimed: false,
          reason: "insufficient_capacity",
          message: `Node ${nodeId} insufficient memory (used ${usedMem} + need ${jobMem} > ${nodeMemTotal})`,
        };
      }
      if (usedScratch + jobScratch > nodeScratchTotal) {
        db.query("ROLLBACK").run();
        return {
          claimed: false,
          reason: "insufficient_capacity",
          message: `Node ${nodeId} insufficient scratch (used ${usedScratch} + need ${jobScratch} > ${nodeScratchTotal})`,
        };
      }

      // 4. Create attempt with status "created"
      const now = this.nextTimestamp();
      db.query(
        "INSERT INTO job_attempts (id, job_id, runner, status, command, cwd, created_at, updated_at) VALUES ($id, $jobId, $runner, $status, $command, $cwd, $createdAt, $updatedAt)",
      ).run({
        $id: attemptId,
        $jobId: jobId,
        $runner: runner,
        $status: "created",
        $command: command,
        $cwd: cwd,
        $createdAt: now,
        $updatedAt: now,
      });

      // 5. Assign node_id on job
      db.query("UPDATE jobs SET node_id = $nodeId, updated_at = $updatedAt WHERE id = $jobId").run({
        $nodeId: nodeId,
        $updatedAt: now,
        $jobId: jobId,
      });

      // 6. Emit attempt.created with the same per-job sequence allocator used
      // by every other durable event.
      this.emitBaseEvent({
        type: "attempt.created",
        jobId,
        attemptId,
        payload: { runner, command, cwd, nodeId },
      });

      db.query("COMMIT").run();
      return { claimed: true, jobId, attemptId, nodeId };
    } catch (err) {
      db.query("ROLLBACK").run();
      return {
        claimed: false,
        reason: "concurrent_claim",
        message: `Claim failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async releaseJobDispatch(jobId: string, attemptId: string, errorMessage: string): Promise<void> {
    const db = this.ensureDb();
    db.query("BEGIN IMMEDIATE").run();
    try {
      const current = db
        .query(
          `SELECT a.status AS attempt_status, j.status AS job_status, j.node_id
           FROM job_attempts a
           JOIN jobs j ON j.id = a.job_id
           WHERE a.id = $attemptId AND a.job_id = $jobId`,
        )
        .get({ $attemptId: attemptId, $jobId: jobId }) as Record<string, unknown> | undefined;

      if (!current) {
        // Branch 4: Missing attempt OR Branch 5: Attempt exists but job_id mismatch
        // No mutation of any kind — commit and return.
        db.query("COMMIT").run();
        return;
      }

      const status = String(current.attempt_status ?? "");

      if (status === "running" || status === "completed" || status === "cancelled") {
        // Branch 3: Exact owner + running/completed/cancelled — no mutation at all
        db.query("COMMIT").run();
        return;
      }

      const terminalEvents = db
        .query(
          `SELECT type FROM job_events
           WHERE job_id = $jobId AND attempt_id = $attemptId
             AND type IN ('process.completed', 'process.failed')`,
        )
        .all({ $jobId: jobId, $attemptId: attemptId });
      if (terminalEvents.some((event) => String(event.type) === "process.completed")) {
        throw new DbError(
          `Conflicting terminal evidence for attempt ${attemptId}`,
          DbErrorCode.CONSTRAINT,
        );
      }

      if (
        status === "created" ||
        status === "queued" ||
        status === "staged" ||
        status === "failed"
      ) {
        const now = this.nextTimestamp();
        if (status !== "failed") {
          if (!isValidAttemptTransition(status as JobAttemptStatus, "failed")) {
            const allowed = VALID_ATTEMPT_TRANSITIONS[status as JobAttemptStatus] ?? [];
            throw new DbInvalidTransitionError("job_attempt", status, "failed", [...allowed]);
          }
          // The dispatch never started, so this failure is terminal: retrying
          // the same deterministic launch on every scheduler tick is unsafe.
          db.query(
            `UPDATE job_attempts
             SET status = 'failed', exit_code = 1, finished_at = $finishedAt, updated_at = $updatedAt
             WHERE id = $attemptId AND job_id = $jobId AND status = $expectedStatus`,
          ).run({
            $attemptId: attemptId,
            $jobId: jobId,
            $expectedStatus: status,
            $finishedAt: now,
            $updatedAt: now,
          });
          this.emitBaseEvent({
            type: "attempt.status.changed",
            jobId,
            attemptId,
            payload: { from: status, to: "failed", exitCode: 1 },
          });
        }

        const jobStatus = String(current.job_status ?? "");
        const nodeAssigned = current.node_id != null;
        if (
          jobStatus !== "failed" &&
          (!isJobStatus(jobStatus) || !canTransitionJobStatus(jobStatus, "failed"))
        ) {
          const allowed = VALID_TRANSITIONS[jobStatus as JobStatus] ?? [];
          throw new DbInvalidTransitionError("job", jobStatus, "failed", [...allowed]);
        }
        if (jobStatus !== "failed" || nodeAssigned) {
          db.query(
            `UPDATE jobs SET status = 'failed', node_id = NULL, updated_at = $updatedAt
             WHERE id = $jobId`,
          ).run({ $jobId: jobId, $updatedAt: now });
        }
        if (jobStatus !== "failed") {
          this.emitBaseEvent({
            type: "job.status.changed",
            jobId,
            payload: { from: jobStatus, to: "failed" },
          });
        }

        if (!terminalEvents.some((event) => String(event.type) === "process.failed")) {
          this.emitBaseEvent({
            type: "process.failed",
            jobId,
            attemptId,
            payload: { error: errorMessage, pid: null, exitCode: 1 },
          });
        }
        db.query("COMMIT").run();
        return;
      }

      // Unknown status — no mutation
      db.query("COMMIT").run();
    } catch (err) {
      db.query("ROLLBACK").run();
      throw err;
    }
  }

  // ── Extended interface methods ─────────────────────────────

  async close(): Promise<void> {
    // No-op: SQLite connection is managed by bun's garbage collector.
    // Do NOT null this.db - background completion callbacks from spawned
    // processes may still call ensureDb() after ApplicationContext.close().
    // Nulling the connection caused the WU-05 regression where
    // finalizeAttempt → updateJobStatus → ensureDb() would throw
    // "Database not initialized", silently swallowed by the coordinator.
  }

  async runMigrations(): Promise<void> {
    this.runPendingMigrations();
  }

  async getMigrationVersion(): Promise<number> {
    const db = this.ensureDb();
    const rows = db.query("SELECT COALESCE(MAX(version), 0) AS v FROM _migrations").all();
    return Number((rows[0] as Record<string, unknown>)?.v ?? 0);
  }

  async listEvents(filters?: ListEventsFilter): Promise<EventRecord[]> {
    const { listEvents: queryListEvents } = await import("./queries/events");
    return queryListEvents(this, filters);
  }

  async listJobEvents(jobId: string): Promise<EventRecord[]> {
    const { listJobEvents: queryListJobEvents } = await import("./queries/events");
    return queryListJobEvents(this, jobId);
  }

  async listAttemptEvents(attemptId: string): Promise<EventRecord[]> {
    const { listAttemptEvents: queryListAttemptEvents } = await import("./queries/events");
    return queryListAttemptEvents(this, attemptId);
  }

  async getTimeline(jobId: string): Promise<TimelineRow[]> {
    const { getTimeline: queryGetTimeline } = await import("./queries/events");
    return queryGetTimeline(this, jobId);
  }

  async saveResult(input: SaveResultInput): Promise<string> {
    const { saveResult: querySaveResult } = await import("./queries/results");
    return querySaveResult(this, input);
  }

  async listResults(jobId?: string, attemptId?: string): Promise<StoredResultRecord[]> {
    const { listResults: queryListResults } = await import("./queries/results");
    return queryListResults(this, jobId, attemptId);
  }

  async getLatestResult(jobId: string, attemptId: string): Promise<StoredResultRecord | null> {
    const { getLatestResult: queryGetLatestResult } = await import("./queries/results");
    return queryGetLatestResult(this, jobId, attemptId);
  }

  async createProposal(input: CreateProposalInput): Promise<string> {
    const { createProposal: queryCreateProposal } = await import("./queries/proposals");
    return queryCreateProposal(this, input);
  }

  async getProposal(proposalId: string): Promise<ProposalRow | null> {
    const { getProposal: queryGetProposal } = await import("./queries/proposals");
    return queryGetProposal(this, proposalId);
  }

  async listProposals(filters?: {
    jobId?: string;
    status?: ProposalStatus;
  }): Promise<ProposalRow[]> {
    const { listProposals: queryListProposals } = await import("./queries/proposals");
    return queryListProposals(this, filters);
  }

  async updateProposalStatus(proposalId: string, status: ProposalStatus): Promise<void> {
    const { updateProposalStatus: queryUpdateProposalStatus } = await import("./queries/proposals");
    return queryUpdateProposalStatus(this, proposalId, status);
  }
}

export function createDatabase(dbPath: string): SqliteDatabase {
  return new SqliteDatabase(dbPath);
}
