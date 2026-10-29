// ────────────────────────────────────────────────────────────
// PostgreSQL-compatible migrations matching SQLite semantics
// ────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { SCIENTIFIC_POSTGRES_MIGRATION } from "../scientific-migrations";
import { MD_POSTGRES_MIGRATIONS } from "../md-migrations";
import { OPERATION_OUTBOX_POSTGRES_MIGRATION } from "../operation-outbox-migration";
import { EFFECT_DELIVERY_POSTGRES_MIGRATION } from "../effect-delivery-migration";
import { MD_PREPARATION_POSTGRES_MIGRATION } from "../md-preparation-migration";
import { EVIDENCE_AUTHORITY_POSTGRES_MIGRATION } from "../evidence-authority-migration";

export interface PostgresMigration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Immutable identity for an applied PostgreSQL migration.
 *
 * The source SQL is intentionally hashed byte-for-byte as compiled into this
 * release. Changes as small as whitespace are therefore treated as migration
 * drift rather than silently accepted against an already-applied version.
 */
export function postgresMigrationChecksum(migration: Pick<PostgresMigration, "sql">): string {
  return `sha256:${createHash("sha256").update(migration.sql, "utf8").digest("hex")}`;
}

export const POSTGRES_MIGRATIONS: PostgresMigration[] = [
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
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
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
        started_at BIGINT,
        finished_at BIGINT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        label TEXT,
        mime_type TEXT,
        size_bytes BIGINT,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        "user" TEXT NOT NULL,
        runner TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        tags_json TEXT NOT NULL DEFAULT '[]',
        max_jobs INTEGER NOT NULL DEFAULT 1,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_events (
        id SERIAL PRIMARY KEY,
        job_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_logs (
        id SERIAL PRIMARY KEY,
        job_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        line TEXT NOT NULL,
        created_at BIGINT NOT NULL
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
        created_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'active',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at BIGINT NOT NULL
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
        effect TEXT NOT NULL DEFAULT 'allow',
        project_id TEXT,
        label TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      -- PostgreSQL CHECK constraint for effect
      ALTER TABLE permissions DROP CONSTRAINT IF EXISTS permissions_effect_check;
      ALTER TABLE permissions ADD CONSTRAINT permissions_effect_check
        CHECK (effect IN ('allow', 'deny', 'ask'));
    `,
  },
  {
    version: 3,
    name: "harden_event_log",
    sql: `
      ALTER TABLE job_events ADD COLUMN IF NOT EXISTS event_id TEXT;
      ALTER TABLE job_events ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'system';
      ALTER TABLE job_events ADD COLUMN IF NOT EXISTS attempt_id TEXT;
      ALTER TABLE job_events ADD COLUMN IF NOT EXISTS artifact_id TEXT;
      ALTER TABLE job_events ADD COLUMN IF NOT EXISTS result_id TEXT;
      ALTER TABLE job_events ADD COLUMN IF NOT EXISTS sequence INTEGER;
      ALTER TABLE job_events ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1;

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
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS port INTEGER NOT NULL DEFAULT 22;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS private_key_path TEXT;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS remote_scratch_dir TEXT NOT NULL DEFAULT '/scratch/eigengrid';
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
        status TEXT NOT NULL DEFAULT 'pending',
        diagnosis_json TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_status_check;
      ALTER TABLE proposals ADD CONSTRAINT proposals_status_check
        CHECK (status IN ('pending', 'approved', 'rejected', 'executed'));
    `,
  },
  {
    version: 6,
    name: "add_capacity_and_resource_fields",
    sql: `
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS engines TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS cpu_threads_total INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS memory_mb_total INTEGER NOT NULL DEFAULT 1024;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS scratch_mb_total INTEGER NOT NULL DEFAULT 10240;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS draining BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS thermal_state TEXT NOT NULL DEFAULT 'unknown';
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS last_seen_at BIGINT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cpu_threads INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS memory_mb INTEGER NOT NULL DEFAULT 1024;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS scratch_mb INTEGER NOT NULL DEFAULT 1024;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_family TEXT;
    `,
  },
  {
    version: 7,
    name: "add_power_management_fields",
    sql: `
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS is_head BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS power_mode TEXT NOT NULL DEFAULT 'manual';
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS mac_address TEXT;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS broadcast_address TEXT;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS wol_port INTEGER;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS allow_wake BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS allow_power_down BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS idle_power_down_after_sec INTEGER;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS last_wake_at BIGINT;
      ALTER TABLE nodes ADD COLUMN IF NOT EXISTS last_power_down_at BIGINT;
    `,
  },
  {
    version: 8,
    name: "add_users_projects_quotas",
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT,
        email TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        max_concurrent_jobs INTEGER NOT NULL DEFAULT 10,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_memberships (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_quotas (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL UNIQUE,
        max_cpu_threads INTEGER NOT NULL DEFAULT 0,
        max_memory_mb INTEGER NOT NULL DEFAULT 0,
        max_scratch_mb INTEGER NOT NULL DEFAULT 0,
        max_jobs_total INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_records (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        cpu_threads INTEGER NOT NULL DEFAULT 1,
        memory_mb INTEGER NOT NULL DEFAULT 1024,
        scratch_mb INTEGER NOT NULL DEFAULT 1024,
        walltime_ms BIGINT,
        recorded_at BIGINT NOT NULL
      );

      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS project_id TEXT;

      INSERT INTO users (id, username, display_name, status, created_at, updated_at)
        VALUES ('local', 'local', 'Local User', 'active', 0, 0)
        ON CONFLICT (id) DO NOTHING;
      INSERT INTO projects (id, name, description, status, max_concurrent_jobs, created_at, updated_at)
        VALUES ('default', 'default', 'Default project', 'active', 100, 0, 0)
        ON CONFLICT (id) DO NOTHING;

      UPDATE jobs SET owner_user_id = 'local', project_id = 'default' WHERE owner_user_id IS NULL AND project_id IS NULL;
    `,
  },
  {
    version: 9,
    name: "add_slurm_backend_fields",
    sql: `
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS backend TEXT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS external_job_id TEXT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS external_state TEXT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_sync_at BIGINT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS native_detail TEXT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS node_name TEXT;
    `,
  },
  {
    version: 10,
    name: "add_job_events_sequence_unique",
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_job_events_job_sequence ON job_events(job_id, sequence);
    `,
  },
  SCIENTIFIC_POSTGRES_MIGRATION,
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
        created_at BIGINT NOT NULL
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
  ...MD_POSTGRES_MIGRATIONS,
  OPERATION_OUTBOX_POSTGRES_MIGRATION,
  EFFECT_DELIVERY_POSTGRES_MIGRATION,
  MD_PREPARATION_POSTGRES_MIGRATION,
  EVIDENCE_AUTHORITY_POSTGRES_MIGRATION,
];
