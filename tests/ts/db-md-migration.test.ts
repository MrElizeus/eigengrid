import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  MD_MODEL_AUTHORITY_MIGRATION_VERSION,
  MIGRATIONS,
  POSTGRES_MIGRATIONS,
  SqliteDatabase,
} from "@eigengrid/db";

const opened: SqliteDatabase[] = [];

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
});

async function migratedDatabase(): Promise<Database> {
  const wrapper = new SqliteDatabase(":memory:");
  await wrapper.init();
  opened.push(wrapper);
  return (wrapper as unknown as { db: Database }).db;
}

function tableNames(db: Database): Set<string> {
  return new Set(
    db
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String((row as { name: unknown }).name)),
  );
}

describe("biomolecular/MD migrations v13-v18", () => {
  it("keeps both providers aligned and exposes the cumulative projection DDL", () => {
    const sqlite = MIGRATIONS.find(
      (migration) => migration.version === MD_MODEL_AUTHORITY_MIGRATION_VERSION,
    )!;
    const postgres = POSTGRES_MIGRATIONS.find(
      (migration) => migration.version === MD_MODEL_AUTHORITY_MIGRATION_VERSION,
    )!;
    const sqliteDecisionAuthority = MIGRATIONS.find((migration) => migration.version === 17)!;
    const postgresDecisionAuthority = POSTGRES_MIGRATIONS.find(
      (migration) => migration.version === 17,
    )!;
    const sqliteEffectAuthority = MIGRATIONS.find((migration) => migration.version === 15)!;
    const postgresEffectAuthority = POSTGRES_MIGRATIONS.find(
      (migration) => migration.version === 15,
    )!;
    const sqliteMaterialIdentity = MIGRATIONS.find((migration) => migration.version === 16)!;
    const postgresMaterialIdentity = POSTGRES_MIGRATIONS.find(
      (migration) => migration.version === 16,
    )!;
    const sqliteMdSql = MIGRATIONS.filter(
      (migration) =>
        migration.version >= 13 && migration.version <= MD_MODEL_AUTHORITY_MIGRATION_VERSION,
    )
      .map((migration) => migration.sql)
      .join("\n");
    const postgresMdSql = POSTGRES_MIGRATIONS.filter(
      (migration) =>
        migration.version >= 13 && migration.version <= MD_MODEL_AUTHORITY_MIGRATION_VERSION,
    )
      .map((migration) => migration.sql)
      .join("\n");

    expect(sqlite.version).toBe(MD_MODEL_AUTHORITY_MIGRATION_VERSION);
    expect(postgres.version).toBe(MD_MODEL_AUTHORITY_MIGRATION_VERSION);
    expect(postgres.name).toBe(sqlite.name);
    for (const table of [
      "scientific_biomolecular_system_manifests",
      "scientific_md_protocols",
      "scientific_md_replica_sets",
      "scientific_md_stage_bindings",
      "scientific_md_stage_results",
      "scientific_md_trajectory_segments",
      "scientific_md_analysis_results",
      "scientific_md_metric_series",
    ]) {
      expect(sqliteMdSql).toContain(table);
      expect(postgresMdSql).toContain(table);
    }
    for (const table of [
      "scientific_biomolecular_manifest_effects",
      "scientific_biomolecular_manifest_artifacts",
      "scientific_md_work_unit_completion_gates",
    ]) {
      expect(sqliteEffectAuthority.sql).toContain(table);
      expect(postgresEffectAuthority.sql).toContain(table);
    }
    for (const table of [
      "scientific_biomolecular_material_effects",
      "scientific_biomolecular_material_artifact_claims",
      "scientific_force_field_stack_revisions",
      "scientific_force_field_stack_evidence",
      "scientific_atom_map_revisions",
    ]) {
      expect(sqliteMaterialIdentity.sql).toContain(table);
      expect(postgresMaterialIdentity.sql).toContain(table);
      expect(sqliteMdSql).toContain(table);
      expect(postgresMdSql).toContain(table);
    }
    for (const kind of ["force_field_stack", "membrane_model", "protonation"]) {
      expect(sqliteDecisionAuthority.sql).toContain(kind);
      expect(postgresDecisionAuthority.sql).toContain(kind);
    }
  });

  it("creates the complete projection topology on SQLite", async () => {
    const db = await migratedDatabase();
    const names = tableNames(db);

    for (const table of [
      "scientific_biomolecular_system_manifests",
      "scientific_md_protocols",
      "scientific_md_replica_sets",
      "scientific_md_stage_bindings",
      "scientific_md_stage_results",
      "scientific_md_trajectory_segments",
      "scientific_md_analysis_results",
      "scientific_md_metric_series",
      "scientific_biomolecular_manifest_effects",
      "scientific_biomolecular_manifest_artifacts",
      "scientific_md_work_unit_completion_gates",
      "scientific_biomolecular_material_effects",
      "scientific_biomolecular_material_artifact_claims",
      "scientific_force_field_stack_revisions",
      "scientific_force_field_stack_evidence",
      "scientific_atom_map_revisions",
    ]) {
      expect(names.has(table)).toBe(true);
    }

    for (const [table, column] of [
      ["scientific_work_units", "capability_id"],
      ["scientific_external_operations", "operation_kind_id"],
      ["scientific_evidence", "evidence_kind_id"],
      ["scientific_observations", "observation_type_id"],
      ["scientific_model_invocations", "model_role_id"],
    ]) {
      const columns = db
        .query(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => String((row as { name: unknown }).name));
      expect(columns).toContain(column);
    }
  });

  it("enforces digest and segment continuity boundaries in SQLite", async () => {
    const db = await migratedDatabase();
    db.exec("PRAGMA foreign_keys = OFF");

    expect(() =>
      db
        .query(
          `INSERT INTO scientific_biomolecular_system_manifests
           (id, revision, mission_id, operation_id, manifest_digest, topology_digest,
            coordinate_digest, atom_map_digest, payload_json, created_at)
           VALUES ('system', 1, 'mission', 'operation', 'short', $digest, $digest, $digest, '{}', $at)`,
        )
        .run({ $digest: "a".repeat(64), $at: "2026-08-23T00:00:00.000Z" }),
    ).toThrow();

    expect(() =>
      db
        .query(
          `INSERT INTO scientific_md_trajectory_segments
           (id, mission_id, stage_binding_id, replica_id, segment_index,
            parent_restart_digest, start_step, end_step, start_time_ps, end_time_ps,
            frame_count, trajectory_digest, restart_digest, continuity_status,
            payload_json, recorded_at)
           VALUES ('segment', 'mission', 'binding', 'replica', 0,
                   $digest, 100, 99, 1.0, 2.0, 1, $digest, $digest,
                   'verified', '{}', $at)`,
        )
        .run({ $digest: "b".repeat(64), $at: "2026-08-23T00:00:00.000Z" }),
    ).toThrow();
  });
});
