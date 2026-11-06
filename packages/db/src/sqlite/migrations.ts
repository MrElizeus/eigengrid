import { EFFECT_DELIVERY_SQLITE_MIGRATION } from "../effect-delivery-migration";
import { MD_SQLITE_MIGRATIONS } from "../md-migrations";
import { MD_PREPARATION_SQLITE_MIGRATION } from "../md-preparation-migration";
import { OPERATION_OUTBOX_SQLITE_MIGRATION } from "../operation-outbox-migration";
import { SCIENTIFIC_SQLITE_MIGRATION } from "../scientific-migrations";
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
