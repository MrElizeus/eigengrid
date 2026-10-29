import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { POSTGRES_MIGRATIONS, SqliteDatabase, MIGRATIONS } from "@eigengrid/db";

function applyStatements(db: Database, sql: string): void {
  for (const statement of sql
    .split(";")
    .map((chunk) => chunk.trim())
    .filter(Boolean)) {
    db.query(statement).run();
  }
}

function applyMigration(db: Database, version: number): void {
  const migration = MIGRATIONS[version - 1]!;
  applyStatements(db, migration.sql);
  db.query(
    "INSERT INTO _migrations (version, name, applied_at) VALUES ($version, $name, $appliedAt)",
  ).run({
    $version: migration.version,
    $name: migration.name,
    $appliedAt: Date.now(),
  });
}

function getJobColumns(db: Database): string[] {
  return db
    .query("PRAGMA table_info(jobs)")
    .all()
    .map((row: any) => String(row.name));
}

describe("jobs table migration v9", () => {
  let db: Database;
  let sqlite: SqliteDatabase;

  beforeAll(() => {
    db = new Database(":memory:");
    sqlite = new SqliteDatabase(":memory:");
    (sqlite as any).db = db;

    for (let version = 1; version <= 8; version++) {
      applyMigration(db, version);
    }
  });

  afterAll(() => {
    db.close();
  });

  it("does not have slurm metadata columns before v9", () => {
    const columns = new Set(getJobColumns(db));

    expect(columns.has("backend")).toBe(false);
    expect(columns.has("external_job_id")).toBe(false);
    expect(columns.has("external_state")).toBe(false);
    expect(columns.has("last_sync_at")).toBe(false);
    expect(columns.has("native_detail")).toBe(false);
    expect(columns.has("node_name")).toBe(false);
  });

  it("adds slurm metadata columns in v9", () => {
    applyMigration(db, 9);

    const columns = new Set(getJobColumns(db));

    expect(columns.has("backend")).toBe(true);
    expect(columns.has("external_job_id")).toBe(true);
    expect(columns.has("external_state")).toBe(true);
    expect(columns.has("last_sync_at")).toBe(true);
    expect(columns.has("native_detail")).toBe(true);
    expect(columns.has("node_name")).toBe(true);
  });

  it("stores slurm metadata through updateJobExternalMetadata", async () => {
    await sqlite.createJob({
      id: "job-1",
      name: "water.in",
      software: "gaussian",
      inputPath: "water.in",
      workdir: "/work",
    });

    await sqlite.updateJobExternalMetadata("job-1", {
      backend: "slurm",
      externalJobId: "123456",
      externalState: "RUNNING",
      lastSyncAt: 1234567890,
      nativeDetail: JSON.stringify({ partition: "debug", qos: "normal" }),
      nodeName: "node-a",
    });

    const row = db.query("SELECT * FROM jobs WHERE id = $id").get({ $id: "job-1" }) as Record<
      string,
      unknown
    >;

    expect(row.backend).toBe("slurm");
    expect(row.external_job_id).toBe("123456");
    expect(row.external_state).toBe("RUNNING");
    expect(row.last_sync_at).toBe(1234567890);
    expect(row.native_detail).toBe(JSON.stringify({ partition: "debug", qos: "normal" }));
    expect(row.node_name).toBe("node-a");
    expect(Number(row.updated_at)).toBeGreaterThan(0);
  });
});

describe("migration definitions", () => {
  it("keeps shared migrations aligned through v21 and PostgreSQL evidence authority at v22", () => {
    const sqliteLatest = MIGRATIONS[MIGRATIONS.length - 1]!;
    const postgresLatest = POSTGRES_MIGRATIONS[POSTGRES_MIGRATIONS.length - 1]!;

    expect(POSTGRES_MIGRATIONS.length).toBe(MIGRATIONS.length + 1);
    expect(sqliteLatest.version).toBe(21);
    expect(postgresLatest.version).toBe(22);
    expect(postgresLatest.name).toBe("bind_evidence_uniqueness_to_exact_authority");
    expect(postgresLatest.sql).toContain("scientific_evidence_authority_identity");
    expect(MIGRATIONS.find((migration) => migration.version === 18)?.sql).toContain(
      "scientific_planning_claims",
    );
    expect(POSTGRES_MIGRATIONS.find((migration) => migration.version === 18)?.sql).toContain(
      "scientific_model_invocation_intents",
    );
    for (const migration of [MIGRATIONS[18]!, POSTGRES_MIGRATIONS[18]!]) {
      expect(migration.sql).toContain("scientific_operation_outbox");
      expect(migration.sql).toContain("scientific_effect_admissions");
      expect(migration.sql).not.toMatch(/INSERT\s+INTO/i);
    }
    for (const migration of [MIGRATIONS[19]!, POSTGRES_MIGRATIONS[19]!]) {
      expect(migration.sql).toContain("scientific_effect_deliveries");
      expect(migration.sql).toContain("scientific_mission_projects");
      expect(migration.sql).not.toMatch(/INSERT\s+INTO/i);
    }
    for (const migration of [
      sqliteLatest,
      POSTGRES_MIGRATIONS.find((migration) => migration.version === 21)!,
    ]) {
      expect(migration.sql).toContain("scientific_md_preparation_publications");
      expect(migration.sql).not.toMatch(/INSERT\s+INTO/i);
    }
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual(
      POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 21).map(
        (migration) => migration.version,
      ),
    );
    expect(MIGRATIONS.find((migration) => migration.version === 17)?.sql).toContain(
      "force_field_stack",
    );
    expect(POSTGRES_MIGRATIONS.find((migration) => migration.version === 17)?.sql).toContain(
      "membrane_model",
    );
    const materialIdentityMigration = POSTGRES_MIGRATIONS.find(
      (migration) => migration.version === 16,
    )!;
    expect(materialIdentityMigration.sql).toContain("scientific_force_field_stack_revisions");
    expect(materialIdentityMigration.sql).toContain("scientific_atom_map_revisions");
    const effectAuthorityMigration = POSTGRES_MIGRATIONS.find(
      (migration) => migration.version === 15,
    )!;
    expect(effectAuthorityMigration.sql).toContain("scientific_biomolecular_manifest_effects");
    expect(effectAuthorityMigration.sql).toContain("scientific_md_work_unit_completion_gates");
    const mdProjectionMigration = POSTGRES_MIGRATIONS.find(
      (migration) => migration.version === 13,
    )!;
    expect(mdProjectionMigration.sql).toContain("scientific_md_trajectory_segments");
    const resultBindingMigration = POSTGRES_MIGRATIONS.find(
      (migration) => migration.version === 12,
    )!;
    expect(resultBindingMigration.sql).toContain("idx_results_job_attempt_parser");
    const scientificMigration = POSTGRES_MIGRATIONS.find((migration) => migration.version === 11)!;
    expect(scientificMigration.sql).toContain("scientific_missions");
    const eventSequenceMigration = POSTGRES_MIGRATIONS.find(
      (migration) => migration.version === 10,
    )!;
    expect(eventSequenceMigration.sql).toContain("idx_job_events_job_sequence");
    expect(eventSequenceMigration.sql).toContain("ON job_events(job_id, sequence)");
  });
});

describe("result attempt binding migration v12", () => {
  it("backfills only unambiguous legacy results and hides ambiguous evidence", async () => {
    const db = new Database(":memory:");
    const sqlite = new SqliteDatabase(":memory:");
    (sqlite as any).db = db;
    try {
      applyMigration(db, 1);
      for (const jobId of ["legacy-one", "legacy-many"]) {
        db.query(
          `INSERT INTO jobs
           (id, name, software, input_path, workdir, status, created_at, updated_at)
           VALUES ($id, $id, 'orca', 'input.inp', '/tmp', 'completed', 1, 1)`,
        ).run({ $id: jobId });
      }
      for (const [attemptId, jobId] of [
        ["legacy-one-attempt", "legacy-one"],
        ["legacy-many-attempt-1", "legacy-many"],
        ["legacy-many-attempt-2", "legacy-many"],
      ]) {
        db.query(
          `INSERT INTO job_attempts
           (id, job_id, runner, status, command, cwd, created_at, updated_at)
           VALUES ($id, $jobId, 'local', 'completed', 'orca input.inp', '/tmp', 1, 1)`,
        ).run({ $id: attemptId, $jobId: jobId });
      }
      for (const jobId of ["legacy-one", "legacy-many"]) {
        db.query(
          `INSERT INTO results
           (id, job_id, parser, status, created_at)
           VALUES ($id, $jobId, 'orca', 'completed', 1)`,
        ).run({ $id: `${jobId}-result`, $jobId: jobId });
      }

      applyMigration(db, 12);

      const unambiguous = db
        .query("SELECT attempt_id FROM results WHERE job_id = 'legacy-one'")
        .get() as { attempt_id: string | null };
      const ambiguous = db
        .query("SELECT COUNT(*) AS count FROM results WHERE job_id = 'legacy-many'")
        .get() as { count: number };
      const archived = db
        .query("SELECT COUNT(*) AS count FROM results_legacy_v11 WHERE job_id = 'legacy-many'")
        .get() as { count: number };
      expect(unambiguous.attempt_id).toBe("legacy-one-attempt");
      expect(ambiguous.count).toBe(0);
      expect(archived.count).toBe(1);
      expect(await sqlite.listResults("legacy-many")).toHaveLength(0);
      expect(await sqlite.getLatestResult("legacy-many", "legacy-many-attempt-2")).toBeNull();
    } finally {
      db.close();
    }
  });
});
