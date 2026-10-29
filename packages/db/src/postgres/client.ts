// ────────────────────────────────────────────────────────────
// PostgreSQL adapter — implements DatabaseLike for Postgres
// ────────────────────────────────────────────────────────────

import type {
  DatabaseLike,
  ListEventsFilter,
  TimelineRow,
  ProposalRow,
  ProposalStatus,
  CreateProposalInput,
  SaveResultInput,
  LogLine,
  DbTransaction,
  EventRecord,
  JobRecord,
  UserRecord,
  ProjectRecord,
  NodeRecord,
  NodeUpdateInput,
  MembershipRecord,
  QuotaRecord,
  UsageRecord,
  StoredResultRecord,
  TerminalAttemptEvidence,
} from "../client";
import {
  mapEventRow,
  mapJobRow,
  mapUserRow,
  mapProjectRow,
  mapNodeRow,
  mapMembershipRow,
  mapQuotaRow,
  mapUsageRow,
  mapStoredResultRow,
  VALID_ATTEMPT_TRANSITIONS,
  isValidAttemptTransition,
} from "../rows";
import {
  DbError,
  DbErrorCode,
  DbNotFoundError,
  DbInvalidTransitionError,
  DbAmbiguousPrefixError,
  DbQueryError,
} from "../errors";
import { redactDatabaseUrl } from "../provider";
import { resultEvidenceFingerprint } from "../queries/results";
import {
  POSTGRES_MIGRATIONS,
  postgresMigrationChecksum,
  type PostgresMigration,
} from "./migrations";
import { splitSqlStatements } from "../migration-utils";
import {
  generateId,
  canTransitionJobStatus,
  type Artifact,
  type JobAttempt,
  type JobAttemptStatus,
  type JobStatus,
  type RunnerKind,
  type PermissionEffect,
  VALID_TRANSITIONS,
} from "@eigengrid/core";
import type { EigenGridEvent, EigenGridEventBase } from "@eigengrid/events";

// ── SQL parameter style ──────────────────────────────────────
// PostgreSQL uses $1, $2, … positional params.
// We convert named params ($name) to positional ($1, $2, …)
// internally based on the order they appear in the query.

// ── Types ────────────────────────────────────────────────────

interface PgRow {
  [key: string]: unknown;
}

// ── Helpers ──────────────────────────────────────────────────

const JOB_ATTEMPT_STATUSES = new Set<JobAttemptStatus>([
  "created",
  "queued",
  "staged",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

function isJobAttemptStatus(value: string): value is JobAttemptStatus {
  return JOB_ATTEMPT_STATUSES.has(value as JobAttemptStatus);
}

function isJobStatus(value: string): value is JobStatus {
  return value in VALID_TRANSITIONS;
}

const VALID_PROPOSAL_TRANSITIONS: Record<ProposalStatus, readonly ProposalStatus[]> = {
  pending: ["approved", "rejected"],
  approved: ["executed"],
  rejected: [],
  executed: [],
};

// `EIGE` / `MIGR` as signed 32-bit advisory-lock keys. The lock is session
// scoped and intentionally held across history validation and every migration
// transaction so separate Head pools cannot make independent apply decisions.
const POSTGRES_MIGRATION_LOCK_NAMESPACE = 0x45494745;
const POSTGRES_MIGRATION_LOCK_RESOURCE = 0x4d494752;
const POSTGRES_MIGRATION_CHECKSUM = /^sha256:[a-f0-9]{64}$/;

interface AppliedPostgresMigration {
  version: number;
  name: string;
  checksum: string | null;
}

function migrationDescriptorsByVersion(): Map<number, PostgresMigration> {
  const descriptors = new Map<number, PostgresMigration>();
  let previousVersion = 0;
  for (const migration of POSTGRES_MIGRATIONS) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= 0) {
      throw new DbError(
        `PostgreSQL migration descriptor has an invalid version: ${String(migration.version)}`,
        DbErrorCode.MIGRATION,
      );
    }
    if (migration.version <= previousVersion || descriptors.has(migration.version)) {
      throw new DbError(
        `PostgreSQL migration descriptors are not strictly ordered at v${migration.version}`,
        DbErrorCode.MIGRATION,
      );
    }
    if (!migration.name || !migration.sql) {
      throw new DbError(
        `PostgreSQL migration v${migration.version} has an empty name or SQL body`,
        DbErrorCode.MIGRATION,
      );
    }
    descriptors.set(migration.version, migration);
    previousVersion = migration.version;
  }
  return descriptors;
}

function mapJobAttemptRow(row: PgRow): JobAttempt {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    runner: String(row.runner) as RunnerKind,
    status: String(row.status) as JobAttemptStatus,
    command: String(row.command),
    cwd: String(row.cwd),
    ...(row.pid != null ? { pid: Number(row.pid) } : {}),
    ...(row.exit_code != null ? { exitCode: Number(row.exit_code) } : {}),
    ...(row.started_at != null ? { startedAt: Number(row.started_at) } : {}),
    ...(row.finished_at != null ? { finishedAt: Number(row.finished_at) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapArtifactRow(row: PgRow): Artifact {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    attemptId: String(row.attempt_id),
    kind: String(row.kind) as Artifact["kind"],
    path: String(row.path),
    ...(typeof row.label === "string" ? { label: row.label } : {}),
    ...(typeof row.mime_type === "string" ? { mimeType: row.mime_type } : {}),
    ...(row.size_bytes != null ? { sizeBytes: Number(row.size_bytes) } : {}),
    createdAt: Number(row.created_at),
  };
}

function mapProposalRow(row: PgRow): ProposalRow {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    action: String(row.action),
    reason: String(row.reason),
    proposedChanges: String(row.proposed_changes),
    status: String(row.status) as ProposalStatus,
    diagnosisJson: row.diagnosis_json != null ? String(row.diagnosis_json) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function tryParseJson(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── PostgresDatabase ─────────────────────────────────────────

export class PostgresTransaction implements DbTransaction {
  private client: import("pg").PoolClient;
  private finalized = false;

  constructor(client: import("pg").PoolClient) {
    this.client = client;
  }

  async commit(): Promise<void> {
    if (this.finalized) return;
    try {
      await this.client.query("COMMIT");
      this.finalized = true;
      this.client.release();
    } catch (err) {
      this.client.release();
      this.finalized = true;
      throw new DbError(
        "PostgreSQL transaction commit failed",
        DbErrorCode.TRANSACTION,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async rollback(): Promise<void> {
    if (this.finalized) return;
    try {
      await this.client.query("ROLLBACK");
      this.finalized = true;
      this.client.release();
    } catch (err) {
      this.client.release();
      this.finalized = true;
      throw new DbError(
        "PostgreSQL transaction rollback failed",
        DbErrorCode.TRANSACTION,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async query(sql: string, params?: unknown[]): Promise<unknown> {
    return this.client.query(sql, params ?? []);
  }

  async queryRows<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: Record<string, unknown> | unknown[],
  ): Promise<T[]> {
    if (params && !Array.isArray(params)) {
      throw new DbError(
        "PostgreSQL transactions require positional parameters",
        DbErrorCode.QUERY_FAILED,
      );
    }
    const result = await this.client.query(sql, params ?? []);
    return (result.rows ?? []) as T[];
  }
}

export interface PostgresDatabaseOptions {
  /** Applying DDL is an explicit migration capability, not a runtime requirement. */
  migrations?: "apply" | "validate";
}

export class PostgresDatabase implements DatabaseLike {
  readonly _provider = "postgres";
  private pool: import("pg").Pool | null = null;
  private lastTimestamp = 0;
  private dbUrl: string;
  private _pg: typeof import("pg") | null = null;
  private readonly migrationMode: "apply" | "validate";
  private initialization: Promise<void> | null = null;

  constructor(dbUrl: string, options: PostgresDatabaseOptions = {}) {
    // Redact password for any logging
    this.dbUrl = dbUrl;
    this.migrationMode = options.migrations ?? "apply";
  }

  async init(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = this.initialize();
    try {
      await this.initialization;
    } finally {
      this.initialization = null;
    }
  }

  private async initialize(): Promise<void> {
    if (this.pool) return;
    try {
      this._pg = await import("pg");
    } catch {
      throw new DbError(
        "pg module not found. Install it with: bun add pg",
        DbErrorCode.CONNECTION_FAILED,
        "pg package missing",
      );
    }

    const { Pool } = this._pg;
    const safeUrl = redactDatabaseUrl(this.dbUrl);
    this.pool = new Pool({
      connectionString: this.dbUrl,
      max: this.migrationMode === "apply" ? 2 : 4,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: this.migrationMode === "apply" ? 300_000 : 30_000,
      lock_timeout: 30_000,
      application_name: `eigengrid-${this.migrationMode === "apply" ? "migrator" : "app"}`,
    });
    // pg removes failed idle clients. Handle this event so a PostgreSQL restart
    // does not terminate the Head; subsequent operations still fail/reconnect.
    this.pool.on("error", (error) => {
      console.error("EigenGrid PostgreSQL idle connection lost", {
        code: "code" in error ? error.code : "CONNECTION_LOST",
      });
    });

    // Test connection
    const pool = this.pool;
    let testClient: import("pg").PoolClient | null = null;
    try {
      testClient = await pool.connect();
      await testClient.query("SELECT 1");
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      // Never leak the full connection string
      if (testClient) {
        testClient.release();
        testClient = null;
      }
      await this.close();
      throw new DbError(
        `PostgreSQL connection failed: ${safeUrl}`,
        DbErrorCode.CONNECTION_FAILED,
        detail,
      );
    } finally {
      if (testClient) testClient.release();
    }

    try {
      if (this.migrationMode === "apply") await this.runMigrations();
      else await this.validateMigrations();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async beginTransaction(): Promise<DbTransaction> {
    if (!this.pool)
      throw new DbError(
        "Database not initialized. Call init() first.",
        DbErrorCode.NOT_INITIALIZED,
      );
    let client: import("pg").PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      return new PostgresTransaction(client);
    } catch (err: unknown) {
      client?.release(err instanceof Error ? err : true);
      throw new DbError(
        "PostgreSQL transaction begin failed",
        DbErrorCode.TRANSACTION,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // ── Query helper ──────────────────────────────────────────

  private async query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: PgRow[]; rowCount: number }> {
    if (!this.pool) {
      throw new DbError(
        "Database not initialized. Call init() first.",
        DbErrorCode.NOT_INITIALIZED,
      );
    }
    try {
      const result = await this.pool.query(text, params ?? []);
      return { rows: result.rows ?? [], rowCount: result.rowCount ?? 0 };
    } catch (err: unknown) {
      throw new DbQueryError(err instanceof Error ? err.message : String(err), err);
    }
  }

  private async queryOne(text: string, params?: unknown[]): Promise<PgRow | null> {
    const { rows } = await this.query(text, params);
    return rows.length > 0 ? rows[0] : null;
  }

  // ── Timestamp ─────────────────────────────────────────────

  private nextTimestamp(): number {
    const now = Date.now();
    this.lastTimestamp = Math.max(now, this.lastTimestamp + 1);
    return this.lastTimestamp;
  }

  // ── Event emission helper ─────────────────────────────────

  private async emitBaseEvent(
    event: Omit<EigenGridEventBase, "id" | "at" | "source"> & {
      source?: EigenGridEventBase["source"];
    },
  ): Promise<void> {
    const fullEvent: EigenGridEventBase = {
      id: generateId("evt"),
      at: this.nextTimestamp(),
      source: event.source ?? "db",
      ...event,
    } as EigenGridEventBase;
    await this.appendEvent(fullEvent);
  }

  /**
   * Same as emitBaseEvent but uses a provided client connection,
   * allowing the event to be appended within an existing transaction.
   */
  private async emitClientEvent(
    client: import("pg").PoolClient,
    event: Omit<EigenGridEventBase, "id" | "at" | "source"> & {
      source?: EigenGridEventBase["source"];
    },
  ): Promise<void> {
    const fullEvent: EigenGridEventBase = {
      id: generateId("evt"),
      at: this.nextTimestamp(),
      source: event.source ?? "db",
      ...event,
    } as EigenGridEventBase;

    // Direct INSERT into job_events on the provided client
    let sequence: number | null = null;
    if (fullEvent.jobId) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [fullEvent.jobId]);
      const row = (
        await client.query(
          "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM job_events WHERE job_id = $1",
          [fullEvent.jobId],
        )
      ).rows[0] as { next_seq: number | null } | undefined;
      sequence = row?.next_seq != null ? Number(row.next_seq) : null;
    }

    await client.query(
      `INSERT INTO job_events (job_id, type, event_id, source, attempt_id, artifact_id, result_id, sequence, schema_version, payload_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        fullEvent.jobId ?? "system",
        fullEvent.type,
        fullEvent.id,
        fullEvent.source,
        fullEvent.attemptId ?? null,
        fullEvent.artifactId ?? null,
        fullEvent.resultId ?? null,
        sequence,
        1,
        fullEvent.payload ? JSON.stringify(fullEvent.payload) : null,
        this.nextTimestamp(),
      ],
    );
  }

  // ── Migration ─────────────────────────────────────────────

  /** Read-only startup validation. Never bootstraps, adopts or repairs history. */
  async validateMigrations(): Promise<void> {
    if (!this.pool) throw new DbError("Database not initialized", DbErrorCode.NOT_INITIALIZED);
    const descriptors = migrationDescriptorsByVersion();
    const client = await this.pool.connect();
    let failure: unknown;
    let releaseError: Error | undefined;
    try {
      await client.query("BEGIN READ ONLY");
      // A shared lock coordinates with the migrator's exclusive session lock.
      // Transaction scope guarantees release even when validation fails.
      await client.query("SELECT pg_advisory_xact_lock_shared($1::integer, $2::integer)", [
        POSTGRES_MIGRATION_LOCK_NAMESPACE,
        POSTGRES_MIGRATION_LOCK_RESOURCE,
      ]);
      const result = await client.query(
        "SELECT version, name, checksum FROM _migrations ORDER BY version",
      );
      const history = result.rows as AppliedPostgresMigration[];
      if (history.length !== descriptors.size) {
        throw new Error(
          "Migration history is incomplete or contains unsupported versions; run the matching release migrator",
        );
      }
      for (const row of history) {
        const descriptor = descriptors.get(Number(row.version));
        if (
          !descriptor ||
          row.name !== descriptor.name ||
          row.checksum !== postgresMigrationChecksum(descriptor)
        ) {
          throw new Error(
            `Migration history identity/checksum mismatch at v${String(row.version)}`,
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      failure = error;
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        releaseError =
          rollbackError instanceof Error ? rollbackError : new Error("Rollback failed");
      }
    } finally {
      client.release(releaseError);
    }
    if (failure) {
      throw new DbError(
        `PostgreSQL schema validation failed: ${failure instanceof Error ? failure.message : String(failure)}`,
        DbErrorCode.MIGRATION,
      );
    }
  }

  async runMigrations(): Promise<void> {
    if (this.migrationMode !== "apply") {
      throw new DbError(
        "Runtime database cannot apply migrations; use the migration role and explicit apply mode",
        DbErrorCode.MIGRATION,
      );
    }
    if (!this.pool) throw new DbError("Database not initialized", DbErrorCode.NOT_INITIALIZED);

    const descriptors = migrationDescriptorsByVersion();
    const client = await this.pool.connect();
    let lockHeld = false;
    let failure: DbError | null = null;
    let unlockFailure: unknown;

    try {
      await client.query("SELECT pg_advisory_lock($1::integer, $2::integer) AS locked", [
        POSTGRES_MIGRATION_LOCK_NAMESPACE,
        POSTGRES_MIGRATION_LOCK_RESOURCE,
      ]);
      lockHeld = true;

      // Bootstrap and validate the migration history under the same exclusive
      // session lock as application. A legacy tracking table has no checksum;
      // its exact known name is verified before a one-time checksum adoption.
      // That explicit upgrade establishes integrity from this release onward;
      // it cannot retroactively attest historical source bytes.
      let transactionOpen = false;
      const applied = new Set<number>();
      try {
        await client.query("BEGIN");
        transactionOpen = true;
        await client.query(`
          CREATE TABLE IF NOT EXISTS _migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            checksum TEXT,
            applied_at BIGINT NOT NULL
          )
        `);
        await client.query("ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum TEXT");

        const historyResult = await client.query(
          "SELECT version, name, checksum FROM _migrations ORDER BY version",
        );
        const history = historyResult.rows as AppliedPostgresMigration[];
        for (const row of history) {
          const version = Number(row.version);
          const migration = descriptors.get(version);
          if (!Number.isSafeInteger(version) || !migration) {
            throw new DbError(
              `PostgreSQL migration history contains unknown version ${String(row.version)}`,
              DbErrorCode.MIGRATION,
            );
          }
          if (typeof row.name !== "string" || row.name !== migration.name) {
            throw new DbError(
              `PostgreSQL migration history name mismatch at v${version}: expected ${migration.name}`,
              DbErrorCode.MIGRATION,
            );
          }

          const expectedChecksum = postgresMigrationChecksum(migration);
          if (row.checksum === null) {
            await client.query(
              "UPDATE _migrations SET checksum = $1 WHERE version = $2 AND checksum IS NULL",
              [expectedChecksum, version],
            );
          } else if (
            typeof row.checksum !== "string" ||
            !POSTGRES_MIGRATION_CHECKSUM.test(row.checksum) ||
            row.checksum !== expectedChecksum
          ) {
            throw new DbError(
              `PostgreSQL migration history checksum mismatch at v${version} (${migration.name})`,
              DbErrorCode.MIGRATION,
            );
          }
          applied.add(version);
        }

        await client.query("ALTER TABLE _migrations ALTER COLUMN checksum SET NOT NULL");
        await client.query("COMMIT");
        transactionOpen = false;
      } catch (err) {
        if (transactionOpen) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // The migration authority operation already fails closed below.
          }
        }
        throw err;
      }

      for (const migration of POSTGRES_MIGRATIONS) {
        if (applied.has(migration.version)) continue;

        let transactionOpen = false;
        try {
          await client.query("BEGIN");
          transactionOpen = true;
          for (const statement of splitSqlStatements(migration.sql)) {
            await client.query(statement);
          }
          await client.query(
            "INSERT INTO _migrations (version, name, checksum, applied_at) VALUES ($1, $2, $3, $4)",
            [migration.version, migration.name, postgresMigrationChecksum(migration), Date.now()],
          );
          await client.query("COMMIT");
          transactionOpen = false;
          applied.add(migration.version);
        } catch (err) {
          if (transactionOpen) {
            try {
              await client.query("ROLLBACK");
            } catch {
              // The authoritative outcome is ambiguous; never continue applying.
            }
          }
          throw new DbError(
            `PostgreSQL migration v${migration.version} (${migration.name}) failed: ${err instanceof Error ? err.message : String(err)}`,
            DbErrorCode.MIGRATION,
          );
        }
      }
    } catch (err) {
      failure =
        err instanceof DbError
          ? err
          : new DbError(
              `PostgreSQL migration authority failed: ${err instanceof Error ? err.message : String(err)}`,
              DbErrorCode.MIGRATION,
            );
    } finally {
      try {
        if (lockHeld) {
          const unlockResult = await client.query(
            "SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked",
            [POSTGRES_MIGRATION_LOCK_NAMESPACE, POSTGRES_MIGRATION_LOCK_RESOURCE],
          );
          if ((unlockResult.rows[0] as { unlocked?: unknown } | undefined)?.unlocked !== true) {
            unlockFailure = new Error(
              "PostgreSQL migration advisory lock release was not confirmed",
            );
          }
        }
      } catch (err) {
        unlockFailure = err;
      } finally {
        if (unlockFailure) {
          client.release(
            unlockFailure instanceof Error
              ? unlockFailure
              : new Error(`PostgreSQL migration lock release failed: ${String(unlockFailure)}`),
          );
        } else {
          client.release();
        }
      }
    }
    if (failure) throw failure;
    if (unlockFailure) {
      throw new DbError(
        `PostgreSQL migration advisory lock release failed: ${unlockFailure instanceof Error ? unlockFailure.message : String(unlockFailure)}`,
        DbErrorCode.MIGRATION,
      );
    }
  }

  async getMigrationVersion(): Promise<number> {
    const { rows } = await this.query("SELECT COALESCE(MAX(version), 0) AS v FROM _migrations");
    return Number(rows[0]?.v ?? 0);
  }

  // ── Jobs ──────────────────────────────────────────────────

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
    const now = this.nextTimestamp();
    await this.query(
      `INSERT INTO jobs (id, name, software, input_path, workdir, output_path, owner_user_id, project_id, backend, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        job.id,
        job.name,
        job.software,
        job.inputPath,
        job.workdir,
        job.outputPath ?? null,
        job.ownerUserId ?? null,
        job.projectId ?? null,
        job.backend ?? null,
        "created",
        now,
        now,
      ],
    );
  }

  async updateJobStatus(jobId: string, status: string): Promise<void> {
    if (!this.pool) throw new DbError("Database not initialized", DbErrorCode.NOT_INITIALIZED);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const current = (
        await client.query("SELECT status FROM jobs WHERE id = $1 FOR UPDATE", [jobId])
      ).rows[0] as { status: string } | undefined;
      if (!current) throw new DbNotFoundError("Job", jobId);

      const currentStatus = String(current.status ?? "");

      // Same-state no-op: no updated_at rewrite, no status event
      if (currentStatus === status) {
        await client.query("COMMIT");
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

      const transitioned = await client.query(
        "UPDATE jobs SET status = $1, updated_at = $2 WHERE id = $3 AND status = $4 RETURNING id",
        [status, this.nextTimestamp(), jobId, currentStatus],
      );
      if (transitioned.rowCount !== 1) {
        throw new DbError(`Concurrent job transition for ${jobId}`, DbErrorCode.CONSTRAINT);
      }

      await this.emitClientEvent(client, {
        type: "job.status.changed",
        jobId,
        payload: { from: currentStatus, to: status },
      });

      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* best-effort */
      }
      throw err;
    } finally {
      client.release();
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
    const current = await this.getJob(jobId);
    if (!current) {
      throw new DbNotFoundError("Job", jobId);
    }

    const setFields: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (metadata.backend !== undefined) {
      setFields.push(`backend = $${paramIdx++}`);
      params.push(metadata.backend);
    }
    if (metadata.externalJobId !== undefined) {
      setFields.push(`external_job_id = $${paramIdx++}`);
      params.push(metadata.externalJobId);
    }
    if (metadata.externalState !== undefined) {
      setFields.push(`external_state = $${paramIdx++}`);
      params.push(metadata.externalState);
    }
    if (metadata.lastSyncAt !== undefined) {
      setFields.push(`last_sync_at = $${paramIdx++}`);
      params.push(metadata.lastSyncAt);
    }
    if (metadata.nativeDetail !== undefined) {
      setFields.push(`native_detail = $${paramIdx++}`);
      params.push(metadata.nativeDetail);
    }
    if (metadata.nodeName !== undefined) {
      setFields.push(`node_name = $${paramIdx++}`);
      params.push(metadata.nodeName);
    }

    if (setFields.length === 0) {
      return;
    }

    setFields.push(`updated_at = $${paramIdx++}`);
    params.push(Date.now(), jobId);

    await this.query(`UPDATE jobs SET ${setFields.join(", ")} WHERE id = $${paramIdx}`, params);
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    const row = await this.queryOne("SELECT * FROM jobs WHERE id = $1", [jobId]);
    return row ? mapJobRow(row as Record<string, unknown>) : null;
  }

  async resolveJobId(prefix: string): Promise<string> {
    const { rows } = await this.query("SELECT id FROM jobs WHERE id LIKE $1", [`${prefix}%`]);
    if (rows.length === 0) {
      throw new DbNotFoundError("Job", prefix);
    }
    if (rows.length > 1) {
      throw new DbAmbiguousPrefixError("job", prefix, rows.length);
    }
    return String(rows[0].id);
  }

  async listJobs(): Promise<JobRecord[]> {
    const { rows } = await this.query("SELECT * FROM jobs ORDER BY created_at DESC");
    return rows.map((r: PgRow) => mapJobRow(r as Record<string, unknown>));
  }

  // ── Attempts ──────────────────────────────────────────────

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
    const status = attempt.status ?? "created";
    if (!isJobAttemptStatus(status)) {
      throw new DbInvalidTransitionError("job_attempt", "", status, [...JOB_ATTEMPT_STATUSES]);
    }

    // Wrap state insert + event emission in a transaction for atomicity
    if (!this.pool) throw new DbError("Database not initialized", DbErrorCode.NOT_INITIALIZED);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const now = this.nextTimestamp();
      await client.query(
        `INSERT INTO job_attempts (id, job_id, runner, status, command, cwd, pid, exit_code, started_at, finished_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          attempt.id,
          attempt.jobId,
          attempt.runner,
          status,
          attempt.command,
          attempt.cwd,
          attempt.pid ?? null,
          attempt.exitCode ?? null,
          attempt.startedAt ?? null,
          attempt.finishedAt ?? null,
          now,
          now,
        ],
      );

      await this.emitClientEvent(client, {
        type: "attempt.created",
        jobId: attempt.jobId,
        attemptId: attempt.id,
        payload: { runner: attempt.runner, command: attempt.command, cwd: attempt.cwd },
      });

      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* best-effort */
      }
      throw err;
    } finally {
      client.release();
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
    if (!isJobAttemptStatus(status)) {
      throw new DbInvalidTransitionError("job_attempt", "", status, [...JOB_ATTEMPT_STATUSES]);
    }

    if (!this.pool) throw new DbError("Database not initialized", DbErrorCode.NOT_INITIALIZED);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const current = (
        await client.query("SELECT * FROM job_attempts WHERE id = $1 FOR UPDATE", [attemptId])
      ).rows[0] as Record<string, unknown> | undefined;
      if (!current) throw new DbNotFoundError("JobAttempt", attemptId);

      const previousStatus = String(current.status) as JobAttemptStatus;

      // Same-state no-op: no updated_at rewrite, no status event
      if (previousStatus === status) {
        await client.query("COMMIT");
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

      const now = this.nextTimestamp();
      const setFields = ["status = $1", "updated_at = $2"];
      const params: unknown[] = [status, now];
      let paramIdx = 3;

      if (updates?.pid !== undefined) {
        setFields.push(`pid = $${paramIdx++}`);
        params.push(updates.pid);
      }
      if (updates?.startedAt !== undefined) {
        setFields.push(`started_at = $${paramIdx++}`);
        params.push(updates.startedAt);
      }
      if (updates?.exitCode !== undefined) {
        setFields.push(`exit_code = $${paramIdx++}`);
        params.push(updates.exitCode);
      }
      if (updates?.finishedAt !== undefined) {
        setFields.push(`finished_at = $${paramIdx++}`);
        params.push(updates.finishedAt);
      }

      params.push(attemptId, previousStatus);
      const transitioned = await client.query(
        `UPDATE job_attempts SET ${setFields.join(", ")}
         WHERE id = $${paramIdx} AND status = $${paramIdx + 1}
         RETURNING id`,
        params,
      );
      if (transitioned.rowCount !== 1) {
        throw new DbError(
          `Concurrent job attempt transition for ${attemptId}`,
          DbErrorCode.CONSTRAINT,
        );
      }

      // Use same client to append event inside the transaction
      await this.emitClientEvent(client, {
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

      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* best-effort */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async listJobAttempts(jobId?: string): Promise<JobAttempt[]> {
    let sql: string;
    let params: unknown[] = [];
    if (jobId) {
      sql = "SELECT * FROM job_attempts WHERE job_id = $1 ORDER BY created_at ASC";
      params = [jobId];
    } else {
      sql = "SELECT * FROM job_attempts ORDER BY created_at ASC";
    }
    const { rows } = await this.query(sql, params);
    return rows.map(mapJobAttemptRow);
  }

  // ── Artifacts ─────────────────────────────────────────────

  async createArtifact(artifact: Omit<Artifact, "createdAt">): Promise<void> {
    if (!this.pool) throw new DbError("Database not initialized", DbErrorCode.NOT_INITIALIZED);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const now = this.nextTimestamp();
      await client.query(
        `INSERT INTO artifacts (id, job_id, attempt_id, kind, path, label, mime_type, size_bytes, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          artifact.id,
          artifact.jobId,
          artifact.attemptId,
          artifact.kind,
          artifact.path,
          artifact.label ?? null,
          artifact.mimeType ?? null,
          artifact.sizeBytes ?? null,
          now,
        ],
      );

      await this.emitClientEvent(client, {
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

      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* best-effort */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async createArtifactIfAbsent(artifact: Omit<Artifact, "createdAt">): Promise<boolean> {
    if (!this.pool) throw new DbError("Database not initialized", DbErrorCode.NOT_INITIALIZED);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Keep the state-writer lock order: owned rows first, job event lock
      // second. This also rejects a mismatched attempt/job pair explicitly.
      const owner = (
        await client.query(
          `SELECT a.id
           FROM job_attempts a
           JOIN jobs j ON j.id = a.job_id
           WHERE a.id = $1 AND a.job_id = $2
           FOR UPDATE OF a, j`,
          [artifact.attemptId, artifact.jobId],
        )
      ).rows[0];
      if (!owner) throw new DbNotFoundError("JobAttempt", artifact.attemptId);

      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [artifact.jobId]);

      const existing = (
        await client.query(
          `SELECT id FROM artifacts
           WHERE job_id = $1 AND attempt_id = $2 AND kind = $3 AND path = $4
           LIMIT 1`,
          [artifact.jobId, artifact.attemptId, artifact.kind, artifact.path],
        )
      ).rows[0];
      if (existing) {
        await client.query("COMMIT");
        return false;
      }

      const now = this.nextTimestamp();
      await client.query(
        `INSERT INTO artifacts (id, job_id, attempt_id, kind, path, label, mime_type, size_bytes, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          artifact.id,
          artifact.jobId,
          artifact.attemptId,
          artifact.kind,
          artifact.path,
          artifact.label ?? null,
          artifact.mimeType ?? null,
          artifact.sizeBytes ?? null,
          now,
        ],
      );
      await this.emitClientEvent(client, {
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
      await client.query("COMMIT");
      return true;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* best-effort */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async listArtifacts(jobId?: string): Promise<Artifact[]> {
    let sql: string;
    let params: unknown[] = [];
    if (jobId) {
      sql = "SELECT * FROM artifacts WHERE job_id = $1 ORDER BY created_at ASC";
      params = [jobId];
    } else {
      sql = "SELECT * FROM artifacts ORDER BY created_at ASC";
    }
    const { rows } = await this.query(sql, params);
    return rows.map(mapArtifactRow);
  }

  async materializeTerminalAttempt(evidence: TerminalAttemptEvidence): Promise<void> {
    if (!this.pool) throw new DbError("Database not initialized", DbErrorCode.NOT_INITIALIZED);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = (
        await client.query(
          `SELECT a.status AS attempt_status, a.exit_code, a.finished_at,
                  j.status AS job_status
           FROM job_attempts a
           JOIN jobs j ON j.id = a.job_id
           WHERE a.id = $1 AND a.job_id = $2
           FOR UPDATE OF a, j`,
          [evidence.attemptId, evidence.jobId],
        )
      ).rows[0] as Record<string, unknown> | undefined;
      if (!current) throw new DbNotFoundError("JobAttempt", evidence.attemptId);

      // Keep lock ordering consistent with the other state writers: row lock
      // first, event advisory lock second. The advisory lock must precede the
      // evidence query so concurrent appendEvent calls are visible here.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [evidence.jobId]);

      const terminalType =
        evidence.status === "completed"
          ? "process.completed"
          : evidence.status === "cancelled"
            ? "process.cancelled"
            : "process.failed";
      const terminalEvents = (
        await client.query(
          `SELECT type, payload_json FROM job_events
           WHERE job_id = $1 AND attempt_id = $2
             AND type IN ('process.completed', 'process.failed', 'process.cancelled')`,
          [evidence.jobId, evidence.attemptId],
        )
      ).rows as Array<{ type: string; payload_json: string | null }>;
      if (terminalEvents.some((event) => event.type !== terminalType)) {
        throw new DbError(
          `Conflicting terminal evidence for attempt ${evidence.attemptId}`,
          DbErrorCode.CONSTRAINT,
        );
      }
      for (const event of terminalEvents) {
        if (event.payload_json == null || evidence.exitCode === undefined) continue;
        let payload: Record<string, unknown> | null = null;
        try {
          payload = JSON.parse(event.payload_json) as Record<string, unknown>;
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

      const previousAttemptStatus = String(current.attempt_status) as JobAttemptStatus;
      if (previousAttemptStatus === evidence.status) {
        const storedExitCode = current.exit_code == null ? undefined : Number(current.exit_code);
        const storedFinishedAt =
          current.finished_at == null ? undefined : Number(current.finished_at);
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
        await client.query(
          `UPDATE job_attempts
           SET status = $1, exit_code = COALESCE($2, exit_code), finished_at = $3, updated_at = $4
           WHERE id = $5 AND job_id = $6`,
          [
            evidence.status,
            evidence.exitCode ?? null,
            evidence.finishedAt,
            this.nextTimestamp(),
            evidence.attemptId,
            evidence.jobId,
          ],
        );
      }
      if (attemptStatusChanged) {
        await this.emitClientEvent(client, {
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

      const previousJobStatus = String(current.job_status);
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
        await client.query("UPDATE jobs SET status = $1, updated_at = $2 WHERE id = $3", [
          evidence.status,
          this.nextTimestamp(),
          evidence.jobId,
        ]);
        await this.emitClientEvent(client, {
          type: "job.status.changed",
          jobId: evidence.jobId,
          payload: { from: previousJobStatus, to: evidence.status },
        });
      }

      if (terminalEvents.length === 0) {
        await this.emitClientEvent(client, {
          type: terminalType,
          jobId: evidence.jobId,
          attemptId: evidence.attemptId,
          source: evidence.source,
          payload: evidence.payload,
        });
      }

      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* best-effort */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Logs ──────────────────────────────────────────────────

  async getLogs(jobId: string, stream?: string, tail?: number): Promise<LogLine[]> {
    let sql: string;
    let params: unknown[];

    if (tail != null) {
      if (stream) {
        sql = `SELECT stream, line, created_at FROM job_logs WHERE job_id = $1 AND stream = $2 ORDER BY id DESC LIMIT $3`;
        params = [jobId, stream, tail];
      } else {
        sql = `SELECT stream, line, created_at FROM job_logs WHERE job_id = $1 ORDER BY id DESC LIMIT $2`;
        params = [jobId, tail];
      }
      const { rows } = await this.query(sql, params);
      return rows.reverse().map((r) => ({
        stream: String(r.stream),
        line: String(r.line),
        createdAt: Number(r.created_at),
      }));
    }

    if (stream) {
      sql =
        "SELECT stream, line, created_at FROM job_logs WHERE job_id = $1 AND stream = $2 ORDER BY id ASC";
      params = [jobId, stream];
    } else {
      sql = "SELECT stream, line, created_at FROM job_logs WHERE job_id = $1 ORDER BY id ASC";
      params = [jobId];
    }
    const { rows } = await this.query(sql, params);
    return rows.map((r) => ({
      stream: String(r.stream),
      line: String(r.line),
      createdAt: Number(r.created_at),
    }));
  }

  // ── Events ────────────────────────────────────────────────

  async insertEvent(event: EigenGridEvent): Promise<void> {
    const payloadJson = JSON.stringify(event);
    await this.query(
      `INSERT INTO job_events (job_id, type, payload_json, created_at)
       VALUES ($1, $2, $3, $4)`,
      [
        "jobId" in event && event.jobId ? event.jobId : "system",
        event.type,
        payloadJson,
        event.at ?? this.nextTimestamp(),
      ],
    );
  }

  async appendEvent(event: EigenGridEventBase): Promise<void> {
    if (!this.pool) throw new DbError("Database not initialized", DbErrorCode.NOT_INITIALIZED);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      let sequence: number | null = null;
      if (event.jobId) {
        // Use pg_advisory_xact_lock for concurrency-safe sequence allocation
        // Hash the jobId to an int8 for the advisory lock key
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [event.jobId]);
        const row = (
          await client.query(
            "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM job_events WHERE job_id = $1",
            [event.jobId],
          )
        ).rows[0] as { next_seq: number | null } | undefined;
        sequence = row?.next_seq != null ? Number(row.next_seq) : null;
      }

      await client.query(
        `INSERT INTO job_events (job_id, type, event_id, source, attempt_id, artifact_id, result_id, sequence, schema_version, payload_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          event.jobId ?? "system",
          event.type,
          event.id,
          event.source,
          event.attemptId ?? null,
          event.artifactId ?? null,
          event.resultId ?? null,
          sequence,
          1,
          event.payload ? JSON.stringify(event.payload) : null,
          this.nextTimestamp(),
        ],
      );

      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* best-effort */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async getEvents(jobId?: string): Promise<EventRecord[]> {
    let sql: string;
    let params: unknown[];
    if (jobId) {
      sql = "SELECT * FROM job_events WHERE job_id = $1 ORDER BY sequence ASC, created_at ASC";
      params = [jobId];
    } else {
      sql = "SELECT * FROM job_events ORDER BY sequence ASC, created_at ASC LIMIT 100";
      params = [];
    }
    const { rows } = await this.query(sql, params);
    return rows.map((row) => mapEventRow(row as Record<string, unknown>));
  }

  async listEvents(filters?: ListEventsFilter): Promise<EventRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filters?.jobId) {
      conditions.push(`job_id = $${paramIdx++}`);
      params.push(filters.jobId);
    }
    if (filters?.type) {
      conditions.push(`type = $${paramIdx++}`);
      params.push(filters.type);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = filters?.limit != null ? `LIMIT ${filters.limit}` : "LIMIT 100";

    const { rows } = await this.query(
      `SELECT * FROM job_events ${whereClause} ORDER BY sequence ASC, created_at ASC ${limitClause}`,
      params,
    );
    return rows.map((r: PgRow) => mapEventRow(r as Record<string, unknown>));
  }

  async listJobEvents(jobId: string): Promise<EventRecord[]> {
    return this.listEvents({ jobId });
  }

  async listAttemptEvents(attemptId: string): Promise<EventRecord[]> {
    const { rows } = await this.query(
      "SELECT * FROM job_events WHERE attempt_id = $1 ORDER BY sequence ASC, created_at ASC",
      [attemptId],
    );
    return rows.map((r: PgRow) => mapEventRow(r as Record<string, unknown>));
  }

  async getTimeline(jobId: string): Promise<TimelineRow[]> {
    const events = await this.listJobEvents(jobId);
    return events.map((row) => {
      const ts = new Date(Number(row.createdAt)).toISOString().replace("T", " ").slice(0, 19);
      const type = String(row.type);
      const payload = row.payloadJson ? tryParseJson(String(row.payloadJson)) : null;

      let details = "";
      if (type === "job.status.changed" && payload?.from && payload?.to) {
        details = `${payload.from} → ${payload.to}`;
      } else if (type === "attempt.created" && payload?.command) {
        details = `command: ${payload.command}`;
      } else if (type === "attempt.status.changed" && payload?.from && payload?.to) {
        details = `${payload.from} → ${payload.to}`;
        if (payload.exitCode != null) details += ` (exit=${payload.exitCode})`;
      } else if (type === "process.started" && payload?.pid) {
        details = `pid=${payload.pid}`;
      } else if (type === "process.completed" && payload?.exitCode != null) {
        details = `exit=${payload.exitCode} (${payload.durationMs ?? "?"}ms)`;
      } else if (type === "process.failed" && payload?.exitCode != null) {
        details = `exit=${payload.exitCode} (${payload.durationMs ?? "?"}ms) [FAILED]`;
      } else if (type === "artifact.registered" && payload?.path) {
        details = `${payload.kind ?? "file"}: ${payload.path}`;
      } else if (
        type === "parse.started" ||
        type === "parse.completed" ||
        type === "parse.failed"
      ) {
        details = payload ? JSON.stringify(payload) : "";
      } else if (type === "result.saved") {
        details = payload ? `parser=${payload.parser ?? "?"}` : "";
      } else if (payload) {
        details = JSON.stringify(payload).slice(0, 80);
      }

      return { at: ts, type, details };
    });
  }

  // ── Results ───────────────────────────────────────────────

  async saveResult(input: SaveResultInput): Promise<string> {
    const now = Date.now();

    const ownedAttempt = await this.queryOne(
      "SELECT id FROM job_attempts WHERE id = $1 AND job_id = $2",
      [input.attemptId, input.jobId],
    );
    if (!ownedAttempt) {
      throw new DbError(
        `Result attempt ${input.attemptId} is not owned by job ${input.jobId}`,
        DbErrorCode.CONSTRAINT,
      );
    }

    const resultId = generateId("result");
    const { rows } = await this.query(
      `INSERT INTO results (id, job_id, attempt_id, parser, status, energy_hartree, scf_converged, imaginary_frequencies, normal_termination, warnings_json, errors_json, raw_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (job_id, attempt_id, parser) DO NOTHING
       RETURNING id`,
      [
        resultId,
        input.jobId,
        input.attemptId,
        input.parser,
        input.status,
        input.energyHartree != null ? String(input.energyHartree) : null,
        input.scfConverged != null ? (input.scfConverged ? 1 : 0) : null,
        input.imaginaryFrequencies ?? null,
        input.normalTermination != null ? (input.normalTermination ? 1 : 0) : null,
        JSON.stringify(input.warnings ?? []),
        JSON.stringify(input.errors ?? []),
        input.raw ? JSON.stringify(input.raw) : null,
        now,
      ],
    );

    const storedId = rows[0]?.id;
    if (storedId) return String(storedId);

    const existing = await this.queryOne(
      `SELECT * FROM results
       WHERE job_id = $1 AND attempt_id = $2 AND parser = $3
       LIMIT 1`,
      [input.jobId, input.attemptId, input.parser],
    );
    if (!existing) {
      throw new DbError(
        "Canonical result disappeared after uniqueness conflict",
        DbErrorCode.CONSTRAINT,
      );
    }
    const existingRecord = mapStoredResultRow(existing);
    if (resultEvidenceFingerprint(existingRecord) !== resultEvidenceFingerprint(input)) {
      throw new DbError(
        `Conflicting immutable result evidence for ${input.jobId}/${input.attemptId}/${input.parser}`,
        DbErrorCode.CONSTRAINT,
      );
    }
    return existingRecord.id;
  }

  async listResults(jobId?: string, attemptId?: string): Promise<StoredResultRecord[]> {
    let sql: string;
    let params: unknown[];
    if (attemptId && !jobId) {
      throw new DbError("Result attempt filtering requires a job ID", DbErrorCode.CONSTRAINT);
    }
    if (jobId && attemptId) {
      sql = "SELECT * FROM results WHERE job_id = $1 AND attempt_id = $2 ORDER BY created_at ASC";
      params = [jobId, attemptId];
    } else if (jobId) {
      sql =
        "SELECT * FROM results WHERE job_id = $1 AND attempt_id IS NOT NULL ORDER BY created_at ASC";
      params = [jobId];
    } else {
      sql = "SELECT * FROM results WHERE attempt_id IS NOT NULL ORDER BY created_at ASC";
      params = [];
    }
    const { rows } = await this.query(sql, params);
    return rows.map((r: PgRow) => mapStoredResultRow(r as Record<string, unknown>));
  }

  async getLatestResult(jobId: string, attemptId: string): Promise<StoredResultRecord | null> {
    const sql = `SELECT * FROM results
       WHERE job_id = $1 AND attempt_id = $2
       ORDER BY created_at DESC, id DESC LIMIT 1`;
    const row = await this.queryOne(sql, [jobId, attemptId]);
    return row ? mapStoredResultRow(row as Record<string, unknown>) : null;
  }

  // ── Proposals ─────────────────────────────────────────────

  async createProposal(input: CreateProposalInput): Promise<string> {
    const id = generateId("prop");
    const now = Date.now();

    await this.query(
      `INSERT INTO proposals (id, job_id, action, reason, proposed_changes, status, diagnosis_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        input.jobId,
        input.action,
        input.reason,
        input.proposedChanges,
        "pending",
        input.diagnosis ? JSON.stringify(input.diagnosis) : null,
        now,
        now,
      ],
    );

    return id;
  }

  async getProposal(proposalId: string): Promise<ProposalRow | null> {
    const row = await this.queryOne("SELECT * FROM proposals WHERE id = $1", [proposalId]);
    return row ? mapProposalRow(row) : null;
  }

  async listProposals(filters?: {
    jobId?: string;
    status?: ProposalStatus;
  }): Promise<ProposalRow[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filters?.jobId) {
      conditions.push(`job_id = $${paramIdx++}`);
      params.push(filters.jobId);
    }
    if (filters?.status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(filters.status);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await this.query(
      `SELECT * FROM proposals ${whereClause} ORDER BY created_at DESC`,
      params,
    );
    return rows.map(mapProposalRow);
  }

  async updateProposalStatus(proposalId: string, status: ProposalStatus): Promise<void> {
    const current = await this.queryOne("SELECT status FROM proposals WHERE id = $1", [proposalId]);
    if (!current) {
      throw new DbNotFoundError("Proposal", proposalId);
    }

    const currentStatus = current.status as ProposalStatus;
    const allowed = VALID_PROPOSAL_TRANSITIONS[currentStatus];

    if (!allowed || !allowed.includes(status)) {
      throw new DbInvalidTransitionError("proposal", currentStatus, status, [...(allowed ?? [])]);
    }

    await this.query("UPDATE proposals SET status = $1, updated_at = $2 WHERE id = $3", [
      status,
      Date.now(),
      proposalId,
    ]);
  }

  // ── Permissions ───────────────────────────────────────────

  async listPermissions(projectId?: string): Promise<
    Array<{
      id: string;
      action: string;
      resource: string;
      effect: PermissionEffect;
      projectId?: string;
      label?: string;
    }>
  > {
    let sql: string;
    let params: unknown[];
    if (projectId) {
      sql = "SELECT * FROM permissions WHERE project_id = $1 ORDER BY created_at ASC";
      params = [projectId];
    } else {
      sql = "SELECT * FROM permissions ORDER BY created_at ASC";
      params = [];
    }
    const { rows } = await this.query(sql, params);
    return rows.map((row) => ({
      id: String(row.id),
      action: String(row.action),
      resource: String(row.resource),
      effect: String(row.effect) as PermissionEffect,
      ...(typeof row.project_id === "string" ? { projectId: row.project_id } : {}),
      ...(typeof row.label === "string" ? { label: row.label } : {}),
    }));
  }

  async createPermission(permission: {
    id: string;
    action: string;
    resource?: string;
    effect: PermissionEffect;
    projectId?: string;
    label?: string;
  }): Promise<void> {
    const now = this.nextTimestamp();
    await this.query(
      `INSERT INTO permissions (id, action, resource, effect, project_id, label, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        permission.id,
        permission.action,
        permission.resource ?? "*",
        permission.effect,
        permission.projectId ?? null,
        permission.label ?? null,
        now,
        now,
      ],
    );
  }

  async removePermission(id: string): Promise<void> {
    await this.query("DELETE FROM permissions WHERE id = $1", [id]);
  }

  // ── Users ─────────────────────────────────

  async createUser(user: {
    id: string;
    username: string;
    displayName?: string;
    email?: string;
  }): Promise<void> {
    const now = this.nextTimestamp();
    await this.query(
      `INSERT INTO users (id, username, display_name, email, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', $5, $6)`,
      [user.id, user.username, user.displayName ?? null, user.email ?? null, now, now],
    );
  }

  async getUser(userId: string): Promise<UserRecord | null> {
    const row = await this.queryOne("SELECT * FROM users WHERE id = $1", [userId]);
    return row ? mapUserRow(row as Record<string, unknown>) : null;
  }

  async getUserByUsername(username: string): Promise<UserRecord | null> {
    const row = await this.queryOne("SELECT * FROM users WHERE username = $1", [username]);
    return row ? mapUserRow(row as Record<string, unknown>) : null;
  }

  async listUsers(): Promise<UserRecord[]> {
    const { rows } = await this.query("SELECT * FROM users ORDER BY created_at ASC");
    return rows.map((r: PgRow) => mapUserRow(r as Record<string, unknown>));
  }

  async disableUser(userId: string): Promise<void> {
    await this.query("UPDATE users SET status = 'disabled', updated_at = $1 WHERE id = $2", [
      Date.now(),
      userId,
    ]);
  }

  async enableUser(userId: string): Promise<void> {
    await this.query("UPDATE users SET status = 'active', updated_at = $1 WHERE id = $2", [
      Date.now(),
      userId,
    ]);
  }

  // ── Projects ─────────────────────────────

  async createProject(project: {
    id: string;
    name: string;
    description?: string;
    maxConcurrentJobs?: number;
  }): Promise<void> {
    const now = this.nextTimestamp();
    await this.query(
      `INSERT INTO projects (id, name, description, status, max_concurrent_jobs, created_at, updated_at)
       VALUES ($1, $2, $3, 'active', $4, $5, $6)`,
      [
        project.id,
        project.name,
        project.description ?? null,
        project.maxConcurrentJobs ?? 10,
        now,
        now,
      ],
    );
  }

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    const row = await this.queryOne("SELECT * FROM projects WHERE id = $1", [projectId]);
    return row ? mapProjectRow(row as Record<string, unknown>) : null;
  }

  async getProjectByName(name: string): Promise<ProjectRecord | null> {
    const row = await this.queryOne("SELECT * FROM projects WHERE name = $1", [name]);
    return row ? mapProjectRow(row as Record<string, unknown>) : null;
  }

  async listProjects(): Promise<ProjectRecord[]> {
    const { rows } = await this.query("SELECT * FROM projects ORDER BY created_at ASC");
    return rows.map((r: PgRow) => mapProjectRow(r as Record<string, unknown>));
  }

  async archiveProject(projectId: string): Promise<void> {
    await this.query("UPDATE projects SET status = 'archived', updated_at = $1 WHERE id = $2", [
      Date.now(),
      projectId,
    ]);
  }

  async resolveProjectId(prefix: string): Promise<string> {
    const { rows } = await this.query("SELECT id FROM projects WHERE id LIKE $1", [`${prefix}%`]);
    if (rows.length === 0) {
      const nameRows = await this.query("SELECT id FROM projects WHERE name = $1", [prefix]);
      if (nameRows.rows.length === 0) throw new DbNotFoundError("Project", prefix);
      if (nameRows.rows.length > 1)
        throw new DbAmbiguousPrefixError("project", prefix, nameRows.rows.length);
      return String(nameRows.rows[0].id);
    }
    if (rows.length > 1) throw new DbAmbiguousPrefixError("project", prefix, rows.length);
    return String(rows[0].id);
  }

  // ── Memberships ──────────────────────────

  async addProjectMember(projectId: string, userId: string, role?: string): Promise<void> {
    const now = this.nextTimestamp();
    const id = `mem-${projectId}-${userId}`;
    await this.query(
      `INSERT INTO project_memberships (id, project_id, user_id, role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [id, projectId, userId, role ?? "member", now, now],
    );
  }

  async removeProjectMember(projectId: string, userId: string): Promise<void> {
    await this.query("DELETE FROM project_memberships WHERE project_id = $1 AND user_id = $2", [
      projectId,
      userId,
    ]);
  }

  async listProjectMembers(projectId: string): Promise<MembershipRecord[]> {
    const { rows } = await this.query(
      "SELECT * FROM project_memberships WHERE project_id = $1 ORDER BY created_at ASC",
      [projectId],
    );
    return rows.map((r: PgRow) => mapMembershipRow(r as Record<string, unknown>));
  }

  async listUserProjects(userId: string): Promise<ProjectRecord[]> {
    const { rows } = await this.query(
      `SELECT p.* FROM projects p
       JOIN project_memberships pm ON p.id = pm.project_id
       WHERE pm.user_id = $1 ORDER BY p.created_at ASC`,
      [userId],
    );
    return rows.map((r: PgRow) => mapProjectRow(r as Record<string, unknown>));
  }

  // ── Quotas ───────────────────────────────

  async getProjectQuota(projectId: string): Promise<QuotaRecord | null> {
    const row = await this.queryOne("SELECT * FROM project_quotas WHERE project_id = $1", [
      projectId,
    ]);
    return row ? mapQuotaRow(row as Record<string, unknown>) : null;
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
    const now = this.nextTimestamp();
    const existing = await this.getProjectQuota(projectId);
    if (existing) {
      const setFields: string[] = ["updated_at = $1"];
      const params: unknown[] = [now];
      let paramIdx = 2;
      if (quota.maxCpuThreads !== undefined) {
        setFields.push(`max_cpu_threads = $${paramIdx++}`);
        params.push(quota.maxCpuThreads);
      }
      if (quota.maxMemoryMb !== undefined) {
        setFields.push(`max_memory_mb = $${paramIdx++}`);
        params.push(quota.maxMemoryMb);
      }
      if (quota.maxScratchMb !== undefined) {
        setFields.push(`max_scratch_mb = $${paramIdx++}`);
        params.push(quota.maxScratchMb);
      }
      if (quota.maxJobsTotal !== undefined) {
        setFields.push(`max_jobs_total = $${paramIdx++}`);
        params.push(quota.maxJobsTotal);
      }
      params.push(projectId);
      await this.query(
        `UPDATE project_quotas SET ${setFields.join(", ")} WHERE project_id = $${paramIdx}`,
        params,
      );
    } else {
      await this.query(
        `INSERT INTO project_quotas (id, project_id, max_cpu_threads, max_memory_mb, max_scratch_mb, max_jobs_total, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          `quota-${projectId}`,
          projectId,
          quota.maxCpuThreads ?? 0,
          quota.maxMemoryMb ?? 0,
          quota.maxScratchMb ?? 0,
          quota.maxJobsTotal ?? 0,
          now,
          now,
        ],
      );
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
    await this.query(
      `INSERT INTO usage_records (id, project_id, user_id, job_id, cpu_threads, memory_mb, scratch_mb, walltime_ms, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        usage.id,
        usage.projectId,
        usage.userId,
        usage.jobId,
        usage.cpuThreads ?? 1,
        usage.memoryMb ?? 1024,
        usage.scratchMb ?? 1024,
        usage.walltimeMs ?? null,
        now,
      ],
    );
  }

  async getProjectUsage(projectId: string): Promise<UsageRecord[]> {
    const { rows } = await this.query(
      "SELECT * FROM usage_records WHERE project_id = $1 ORDER BY recorded_at DESC LIMIT 1000",
      [projectId],
    );
    return rows.map((r: PgRow) => mapUsageRow(r as Record<string, unknown>));
  }

  async getUserUsage(userId: string): Promise<UsageRecord[]> {
    const { rows } = await this.query(
      "SELECT * FROM usage_records WHERE user_id = $1 ORDER BY recorded_at DESC LIMIT 1000",
      [userId],
    );
    return rows.map((r: PgRow) => mapUsageRow(r as Record<string, unknown>));
  }

  async getProjectAggregatedUsage(projectId: string): Promise<{
    totalCpuThreads: number;
    totalMemoryMb: number;
    totalScratchMb: number;
    totalWalltimeMs: number;
    jobCount: number;
  }> {
    const row = await this.queryOne(
      `SELECT
        COALESCE(SUM(cpu_threads), 0) AS total_cpu,
        COALESCE(SUM(memory_mb), 0) AS total_mem,
        COALESCE(SUM(scratch_mb), 0) AS total_scratch,
        COALESCE(SUM(walltime_ms), 0) AS total_walltime,
        COUNT(DISTINCT job_id) AS job_count
      FROM usage_records WHERE project_id = $1`,
      [projectId],
    );
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
    const row = await this.queryOne("SELECT status FROM users WHERE id = $1", [userId]);
    return String(row?.status ?? "") === "disabled";
  }

  // ── Nodes ─────────────────────────────────────────────────

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
    const now = this.nextTimestamp();
    await this.query(
      `INSERT INTO nodes (id, name, host, "user", port, runner, status, tags_json, max_jobs, private_key_path, remote_scratch_dir, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        node.id,
        node.name,
        node.host,
        node.user,
        node.port ?? 22,
        node.runner,
        "unknown",
        JSON.stringify(node.tags ?? []),
        node.maxJobs ?? 1,
        node.privateKeyPath ?? null,
        node.remoteScratchDir ?? "/scratch/eigengrid",
        now,
        now,
      ],
    );
  }

  async getNode(nodeId: string): Promise<NodeRecord | null> {
    const row = await this.queryOne("SELECT * FROM nodes WHERE id = $1", [nodeId]);
    return row ? mapNodeRow(row as Record<string, unknown>) : null;
  }

  async listNodes(): Promise<NodeRecord[]> {
    const { rows } = await this.query("SELECT * FROM nodes ORDER BY created_at ASC");
    return rows.map((r: PgRow) => mapNodeRow(r as Record<string, unknown>));
  }

  async updateNode(nodeId: string, updates: NodeUpdateInput): Promise<void> {
    const values: unknown[] = [];
    const fields: string[] = [];
    const add = (column: string, value: unknown): void => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };

    if (updates.name !== undefined) add("name", updates.name);
    if (updates.host !== undefined) add("host", updates.host);
    if (updates.user !== undefined) add('"user"', updates.user);
    if (updates.port !== undefined) add("port", updates.port);
    if (updates.runner !== undefined) add("runner", updates.runner);
    if (updates.status !== undefined) add("status", updates.status);
    if (updates.tags !== undefined) add("tags_json", JSON.stringify(updates.tags));
    if (updates.maxJobs !== undefined) add("max_jobs", updates.maxJobs);
    if (updates.engines !== undefined) add("engines", JSON.stringify(updates.engines));
    if (updates.cpuThreadsTotal !== undefined) add("cpu_threads_total", updates.cpuThreadsTotal);
    if (updates.memoryMbTotal !== undefined) add("memory_mb_total", updates.memoryMbTotal);
    if (updates.scratchMbTotal !== undefined) add("scratch_mb_total", updates.scratchMbTotal);
    if (updates.draining !== undefined) add("draining", updates.draining);
    if (updates.thermalState !== undefined) add("thermal_state", updates.thermalState);
    if (updates.lastSeenAt !== undefined) add("last_seen_at", updates.lastSeenAt);
    if (updates.isHead !== undefined) add("is_head", updates.isHead);
    if (updates.powerMode !== undefined) add("power_mode", updates.powerMode);
    if (updates.macAddress !== undefined) add("mac_address", updates.macAddress);
    if (updates.broadcastAddress !== undefined) add("broadcast_address", updates.broadcastAddress);
    if (updates.wolPort !== undefined) add("wol_port", updates.wolPort);
    if (updates.allowWake !== undefined) add("allow_wake", updates.allowWake);
    if (updates.allowPowerDown !== undefined) add("allow_power_down", updates.allowPowerDown);
    if (updates.idlePowerDownAfterSec !== undefined)
      add("idle_power_down_after_sec", updates.idlePowerDownAfterSec);
    if (updates.lastWakeAt !== undefined) add("last_wake_at", updates.lastWakeAt);
    if (updates.lastPowerDownAt !== undefined) add("last_power_down_at", updates.lastPowerDownAt);
    if (updates.privateKeyPath !== undefined) add("private_key_path", updates.privateKeyPath);
    if (updates.remoteScratchDir !== undefined) add("remote_scratch_dir", updates.remoteScratchDir);

    values.push(this.nextTimestamp(), nodeId);
    fields.push(`updated_at = $${values.length - 1}`);
    await this.query(`UPDATE nodes SET ${fields.join(", ")} WHERE id = $${values.length}`, values);
  }

  async removeNode(nodeId: string): Promise<void> {
    await this.query("DELETE FROM nodes WHERE id = $1", [nodeId]);
  }

  async resolveNodeId(prefix: string): Promise<string> {
    const { rows } = await this.query("SELECT id FROM nodes WHERE id LIKE $1", [`${prefix}%`]);
    if (rows.length === 0) {
      const nameRows = await this.query("SELECT id FROM nodes WHERE name = $1", [prefix]);
      if (nameRows.rows.length === 0) {
        throw new DbNotFoundError("Node", prefix);
      }
      if (nameRows.rows.length > 1) {
        throw new DbAmbiguousPrefixError("node", prefix, nameRows.rows.length);
      }
      return String(nameRows.rows[0].id);
    }
    if (rows.length > 1) {
      throw new DbAmbiguousPrefixError("node", prefix, rows.length);
    }
    return String(rows[0].id);
  }

  async getNodeByName(name: string): Promise<NodeRecord | null> {
    const row = await this.queryOne("SELECT * FROM nodes WHERE name = $1", [name]);
    return row ? mapNodeRow(row as Record<string, unknown>) : null;
  }

  // ── Scheduler Dispatch ──────────────────────────────────────

  async claimJobForDispatch(
    jobId: string,
    nodeId: string,
    attemptId: string,
    runner: import("@eigengrid/core").RunnerKind,
    command: string,
    cwd: string,
  ): Promise<import("../client").ClaimDispatchResult> {
    if (!this.pool) throw new DbError("Database not initialized", DbErrorCode.NOT_INITIALIZED);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Mutual exclusion for same-job claims: row-level lock on job
      // 1. Verify job exists and is claimable (with FOR UPDATE to serialize concurrent claims)
      const jobRow = (await client.query("SELECT * FROM jobs WHERE id = $1 FOR UPDATE", [jobId]))
        .rows[0] as Record<string, unknown> | undefined;
      if (!jobRow) {
        await client.query("ROLLBACK");
        client.release();
        return { claimed: false, reason: "not_found", message: `Job ${jobId} not found` };
      }
      const jobStatus = String(jobRow.status ?? "");
      if (jobStatus !== "queued") {
        await client.query("ROLLBACK");
        client.release();
        return {
          claimed: false,
          reason: "not_queued",
          message: `Job ${jobId} has status "${jobStatus}", expected "queued"`,
        };
      }

      // 2. Check for existing nonterminal attempts (under same transaction, after FOR UPDATE on job)
      const attemptRows = (
        await client.query("SELECT id, status FROM job_attempts WHERE job_id = $1", [jobId])
      ).rows as Record<string, unknown>[];
      const nonTerminal = attemptRows.find((a) => {
        const s = String(a.status ?? "");
        return s === "created" || s === "queued" || s === "staged" || s === "running";
      });
      if (nonTerminal) {
        await client.query("ROLLBACK");
        client.release();
        return {
          claimed: false,
          reason: "has_nonterminal_attempt",
          message: `Job ${jobId} has nonterminal attempt ${String(nonTerminal.id)} (${String(nonTerminal.status)})`,
        };
      }

      // 3. Verify node exists and is enabled under node-key advisory lock
      //    Serialize same-node claims so maxJobs/capacity checks are accurate
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [nodeId]);
      const nodeRow = (await client.query("SELECT * FROM nodes WHERE id = $1 FOR UPDATE", [nodeId]))
        .rows[0] as Record<string, unknown> | undefined;
      if (!nodeRow) {
        await client.query("ROLLBACK");
        client.release();
        return { claimed: false, reason: "node_invalid", message: `Node ${nodeId} not found` };
      }
      const nodeStatus = String(nodeRow.status ?? "");
      const nodeDraining =
        nodeStatus === "draining" ||
        nodeRow.draining === true ||
        Number(nodeRow.draining ?? 0) === 1;
      if (nodeStatus === "offline" || nodeStatus === "error" || nodeDraining) {
        await client.query("ROLLBACK");
        client.release();
        return {
          claimed: false,
          reason: "node_invalid",
          message: nodeDraining ? `Node ${nodeId} is draining` : `Node ${nodeId} is ${nodeStatus}`,
        };
      }

      // ── Capacity revalidation: count existing reservations on this node ──
      // Count jobs with node_id = target node and non-terminal status (running, staged, queued)
      // Exclude the current job being claimed
      const capResult = (
        await client.query(
          `SELECT
           COUNT(*) AS existing_jobs,
           COALESCE(SUM(cpu_threads), 0) AS used_cpu,
           COALESCE(SUM(memory_mb), 0) AS used_mem,
           COALESCE(SUM(scratch_mb), 0) AS used_scratch
         FROM jobs WHERE node_id = $1 AND id != $2 AND status IN ('queued','staged','running')`,
          [nodeId, jobId],
        )
      ).rows[0] as Record<string, unknown>;
      const existingJobs = Number(capResult?.existing_jobs ?? 0);
      const usedCpu = Number(capResult?.used_cpu ?? 0);
      const usedMem = Number(capResult?.used_mem ?? 0);
      const usedScratch = Number(capResult?.used_scratch ?? 0);
      const jobCpu = Number(jobRow.cpu_threads ?? 1);
      const jobMem = Number(jobRow.memory_mb ?? 1024);
      const jobScratch = Number(jobRow.scratch_mb ?? 1024);
      const nodeMaxJobs = Number(nodeRow.max_jobs ?? 1);
      const nodeCpuTotal = Number(nodeRow.cpu_threads_total ?? 1);
      const nodeMemTotal = Number(nodeRow.memory_mb_total ?? 1024);
      const nodeScratchTotal = Number(nodeRow.scratch_mb_total ?? 10240);

      if (existingJobs >= nodeMaxJobs) {
        await client.query("ROLLBACK");
        client.release();
        return {
          claimed: false,
          reason: "insufficient_capacity",
          message: `Node ${nodeId} at maxJobs (${nodeMaxJobs})`,
        };
      }
      if (usedCpu + jobCpu > nodeCpuTotal) {
        await client.query("ROLLBACK");
        client.release();
        return {
          claimed: false,
          reason: "insufficient_capacity",
          message: `Node ${nodeId} insufficient CPU (used ${usedCpu} + need ${jobCpu} > ${nodeCpuTotal})`,
        };
      }
      if (usedMem + jobMem > nodeMemTotal) {
        await client.query("ROLLBACK");
        client.release();
        return {
          claimed: false,
          reason: "insufficient_capacity",
          message: `Node ${nodeId} insufficient memory (used ${usedMem} + need ${jobMem} > ${nodeMemTotal})`,
        };
      }
      if (usedScratch + jobScratch > nodeScratchTotal) {
        await client.query("ROLLBACK");
        client.release();
        return {
          claimed: false,
          reason: "insufficient_capacity",
          message: `Node ${nodeId} insufficient scratch (used ${usedScratch} + need ${jobScratch} > ${nodeScratchTotal})`,
        };
      }

      // 4. Create attempt with status "created"
      const now = this.nextTimestamp();
      await client.query(
        "INSERT INTO job_attempts (id, job_id, runner, status, command, cwd, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [attemptId, jobId, runner, "created", command, cwd, now, now],
      );

      // 5. Assign node_id on job
      await client.query("UPDATE jobs SET node_id = $1, updated_at = $2 WHERE id = $3", [
        nodeId,
        now,
        jobId,
      ]);

      // 6. Emit attempt.created event
      await this.emitClientEvent(client, {
        type: "attempt.created",
        jobId,
        attemptId,
        payload: { runner, command, cwd, nodeId },
      });

      await client.query("COMMIT");
      client.release();
      return { claimed: true, jobId, attemptId, nodeId };
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* best-effort */
      }
      client.release();
      return {
        claimed: false,
        reason: "concurrent_claim",
        message: `Claim failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async releaseJobDispatch(jobId: string, attemptId: string, errorMessage: string): Promise<void> {
    if (!this.pool) throw new DbError("Database not initialized", DbErrorCode.NOT_INITIALIZED);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Lock the exact attempt/job ownership pair before deciding whether to
      // transition it.
      const current = (
        await client.query(
          `SELECT a.status AS attempt_status, j.status AS job_status, j.node_id
           FROM job_attempts a
           JOIN jobs j ON j.id = a.job_id
           WHERE a.id = $1 AND a.job_id = $2
           FOR UPDATE OF a, j`,
          [attemptId, jobId],
        )
      ).rows[0] as Record<string, unknown> | undefined;

      if (!current) {
        // Branch 4: Missing attempt OR Branch 5: job_id mismatch
        await client.query("COMMIT");
        return;
      }

      // Match the row-lock-then-advisory-lock ordering used by all state
      // writers, and serialize against direct event appenders before reading
      // terminal evidence.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [jobId]);

      const status = String(current.attempt_status ?? "");

      if (status === "running" || status === "completed" || status === "cancelled") {
        // Branch 3: Exact owner + running/completed/cancelled — no mutation at all
        await client.query("COMMIT");
        return;
      }

      const terminalEvents = (
        await client.query(
          `SELECT type FROM job_events
           WHERE job_id = $1 AND attempt_id = $2
             AND type IN ('process.completed', 'process.failed')`,
          [jobId, attemptId],
        )
      ).rows as Array<{ type: string }>;
      if (terminalEvents.some((event) => event.type === "process.completed")) {
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
          const transitioned = await client.query(
            `UPDATE job_attempts
             SET status = 'failed', exit_code = 1, finished_at = $1, updated_at = $2
             WHERE id = $3 AND job_id = $4 AND status = $5
             RETURNING id`,
            [now, now, attemptId, jobId, status],
          );
          if (transitioned.rowCount !== 1) {
            await client.query("ROLLBACK");
            return;
          }
          await this.emitClientEvent(client, {
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
          await client.query(
            "UPDATE jobs SET status = 'failed', node_id = NULL, updated_at = $1 WHERE id = $2",
            [now, jobId],
          );
        }
        if (jobStatus !== "failed") {
          await this.emitClientEvent(client, {
            type: "job.status.changed",
            jobId,
            payload: { from: jobStatus, to: "failed" },
          });
        }

        if (!terminalEvents.some((event) => event.type === "process.failed")) {
          await this.emitClientEvent(client, {
            type: "process.failed",
            jobId,
            attemptId,
            payload: { error: errorMessage, pid: null, exitCode: 1 },
          });
        }
        await client.query("COMMIT");
        return;
      }

      // Unknown status — no mutation
      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* best-effort */
      }
      throw err;
    } finally {
      try {
        client.release();
      } catch {
        /* best-effort */
      }
    }
  }
}
