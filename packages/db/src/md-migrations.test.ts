import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  MD_BASE_POSTGRES_MIGRATION,
  MD_BASE_SQLITE_MIGRATION,
  MD_EFFECT_AUTHORITY_POSTGRES_MIGRATION,
  MD_EFFECT_AUTHORITY_SQLITE_MIGRATION,
  MD_INTEGRITY_POSTGRES_MIGRATION,
  MD_INTEGRITY_SQLITE_MIGRATION,
  MD_MATERIAL_IDENTITY_POSTGRES_MIGRATION,
  MD_MATERIAL_IDENTITY_SQLITE_MIGRATION,
  MD_MIGRATION_VERSION,
  MD_MODEL_AUTHORITY_MIGRATION_VERSION,
  MD_POSTGRES_MIGRATION,
  MD_POSTGRES_MIGRATIONS,
  MD_SQLITE_MIGRATION,
  MD_SQLITE_MIGRATIONS,
} from "./md-migrations";
import { splitSqlStatements } from "./migration-utils";
import { PostgresDatabase } from "./postgres/client";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations";
import { SCIENTIFIC_SQLITE_MIGRATION } from "./scientific-migrations";
import { canRunPostgres, startEphemeralPostgres } from "../../../tests/ts/helpers/postgres";

const DIGEST = "a".repeat(64);
const AT = "2026-08-23T00:00:00.000Z";
const SUBJECT_TYPES = [
  "plan",
  "decision",
  "operation",
  "result",
  "biomolecular_system_manifest",
  "md_protocol",
  "md_stage",
  "replica_set",
  "md_assessment",
] as const;

function execute(db: Database, sql: string): void {
  for (const statement of splitSqlStatements(sql)) db.exec(statement);
}

describe("biomolecular/MD projection integrity migration", () => {
  test("keeps ordered SQLite/PostgreSQL migrations and exact subject identities in parity", () => {
    expect(MD_SQLITE_MIGRATIONS.map((migration) => migration.version)).toEqual([
      13, 14, 15, 16, 17, 18,
    ]);
    expect(MD_POSTGRES_MIGRATIONS.map((migration) => migration.version)).toEqual([
      13, 14, 15, 16, 17, 18,
    ]);
    expect(MD_BASE_SQLITE_MIGRATION.name).toBe(MD_BASE_POSTGRES_MIGRATION.name);
    expect(MD_SQLITE_MIGRATION.name).toBe(MD_POSTGRES_MIGRATION.name);
    expect(MD_SQLITE_MIGRATION.version).toBe(MD_MIGRATION_VERSION);
    expect(MD_POSTGRES_MIGRATION.version).toBe(MD_MIGRATION_VERSION);

    for (const subjectType of SUBJECT_TYPES) {
      expect(MD_INTEGRITY_SQLITE_MIGRATION.sql).toContain(`'${subjectType}'`);
      expect(MD_INTEGRITY_POSTGRES_MIGRATION.sql).toContain(`'${subjectType}'`);
    }
    for (const table of [
      "scientific_biomolecular_decisions",
      "scientific_md_stage_specs",
      "scientific_md_replica_set_revisions",
      "scientific_md_replica_segment_bindings",
      "scientific_md_stage_result_artifacts",
      "scientific_md_assessments",
    ]) {
      expect(MD_INTEGRITY_SQLITE_MIGRATION.sql).toContain(table);
      expect(MD_INTEGRITY_POSTGRES_MIGRATION.sql).toContain(table);
    }
    for (const column of [
      "plan_version",
      "material_digest",
      "review_status",
      "stage_digest",
      "segment_digest",
      "series_digest",
    ]) {
      expect(MD_INTEGRITY_SQLITE_MIGRATION.sql).toContain(column);
      expect(MD_INTEGRITY_POSTGRES_MIGRATION.sql).toContain(column);
    }
    for (const table of [
      "scientific_biomolecular_manifest_effects",
      "scientific_biomolecular_manifest_artifacts",
      "scientific_md_work_unit_completion_gates",
    ]) {
      expect(MD_EFFECT_AUTHORITY_SQLITE_MIGRATION.sql).toContain(table);
      expect(MD_EFFECT_AUTHORITY_POSTGRES_MIGRATION.sql).toContain(table);
    }
    for (const table of [
      "scientific_biomolecular_material_effects",
      "scientific_biomolecular_material_artifact_claims",
      "scientific_force_field_stack_revisions",
      "scientific_force_field_stack_evidence",
      "scientific_atom_map_revisions",
    ]) {
      expect(MD_MATERIAL_IDENTITY_SQLITE_MIGRATION.sql).toContain(table);
      expect(MD_MATERIAL_IDENTITY_POSTGRES_MIGRATION.sql).toContain(table);
    }
    expect(MD_EFFECT_AUTHORITY_POSTGRES_MIGRATION.sql).toContain(
      "ALTER COLUMN size_bytes TYPE BIGINT",
    );
    expect(MD_MATERIAL_IDENTITY_POSTGRES_MIGRATION.sql).toContain("size_bytes BIGINT");
    for (const kind of ["force_field_stack", "membrane_model", "protonation"]) {
      expect(MD_INTEGRITY_SQLITE_MIGRATION.sql).not.toContain(`'${kind}'`);
      expect(MD_SQLITE_MIGRATION.sql).toContain(`'${kind}'`);
      expect(MD_POSTGRES_MIGRATION.sql).toContain(`'${kind}'`);
    }
    for (const incompatibleV16Projection of [
      "scientific_biomolecular_system_manifests",
      "scientific_md_protocols",
      "scientific_md_stage_bindings",
      "scientific_md_stage_results",
      "scientific_biomolecular_decisions",
      "scientific_atom_map_revisions",
    ]) {
      expect(MD_SQLITE_MIGRATION.sql).toContain(incompatibleV16Projection);
      expect(MD_POSTGRES_MIGRATION.sql).toContain(incompatibleV16Projection);
    }
  });

  test("rebuilds the SQLite approval CHECK without losing legacy requests or responses", () => {
    const db = new Database(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      execute(db, SCIENTIFIC_SQLITE_MIGRATION.sql);
      execute(db, MD_BASE_SQLITE_MIGRATION.sql);
      db.exec("BEGIN");
      db.query(
        `INSERT INTO scientific_missions
         (id, revision, state, budget_id, active_plan_id, objective_digest, payload_digest,
          payload_json, created_at, updated_at, terminal_at)
         VALUES ('mission-1', 1, 'awaiting_approval', 'budget-1', NULL, $digest, $digest,
                 '{}', $at, $at, NULL)`,
      ).run({ $digest: DIGEST, $at: AT });
      db.query(
        `INSERT INTO scientific_mission_budgets
         (id, mission_id, revision, limits_json, consumed_json, payload_digest, payload_json)
         VALUES ('budget-1', 'mission-1', 1, '{}', '{}', $digest, '{}')`,
      ).run({ $digest: DIGEST });
      db.query(
        `INSERT INTO scientific_approval_requests
         (id, mission_id, subject_type, subject_id, subject_version, subject_revision, state,
          requested_from_role, payload_digest, policy_digest, payload_json, requested_at, expires_at)
         VALUES ('legacy-approval', 'mission-1', 'plan', 'plan-1', 1, 1, 'approved',
                 'scientific_reviewer', $digest, $digest, '{}', $at, NULL)`,
      ).run({ $digest: DIGEST, $at: AT });
      db.query(
        `INSERT INTO scientific_approval_responses
         (id, approval_request_id, decision, actor_id, role, subject_version,
          subject_revision, payload_digest, policy_digest, payload_json, decided_at)
         VALUES ('legacy-response', 'legacy-approval', 'approved', 'reviewer-1',
                 'scientific_reviewer', 1, 1, $digest, $digest, '{}', $at)`,
      ).run({ $digest: DIGEST, $at: AT });
      db.exec("COMMIT");

      execute(db, MD_INTEGRITY_SQLITE_MIGRATION.sql);

      expect(
        db
          .query("SELECT subject_type FROM scientific_approval_requests WHERE id = ?")
          .get("legacy-approval"),
      ).toEqual({ subject_type: "plan" });
      expect(
        db
          .query("SELECT approval_request_id FROM scientific_approval_responses WHERE id = ?")
          .get("legacy-response"),
      ).toEqual({ approval_request_id: "legacy-approval" });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

      for (const [index, subjectType] of SUBJECT_TYPES.entries()) {
        db.query(
          `INSERT INTO scientific_approval_requests
           (id, mission_id, subject_type, subject_id, subject_version, subject_revision, state,
            requested_from_role, payload_digest, policy_digest, payload_json, requested_at, expires_at)
           VALUES ($id, 'mission-1', $subjectType, $subjectId, 1, 1, 'pending',
                   'scientific_reviewer', $digest, $digest, '{}', $at, NULL)`,
        ).run({
          $id: `approval-${index}`,
          $subjectType: subjectType,
          $subjectId: `subject-${index}`,
          $digest: DIGEST,
          $at: AT,
        });
      }
      expect(db.query("SELECT COUNT(*) AS count FROM scientific_approval_requests").get()).toEqual({
        count: 10,
      });
      expect(() =>
        db
          .query(
            `INSERT INTO scientific_approval_requests
           (id, mission_id, subject_type, subject_id, subject_version, subject_revision, state,
            requested_from_role, payload_digest, policy_digest, payload_json, requested_at)
           VALUES ('bad', 'mission-1', 'raw_shell', 'subject', 1, 1, 'pending',
                   'scientific_reviewer', $digest, $digest, '{}', $at)`,
          )
          .run({ $digest: DIGEST, $at: AT }),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  test("creates explicit revisioned stage, replica, and assessment projections", () => {
    const db = new Database(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      execute(db, SCIENTIFIC_SQLITE_MIGRATION.sql);
      for (const migration of MD_SQLITE_MIGRATIONS) execute(db, migration.sql);

      const replicaColumns = db
        .query("PRAGMA table_info(scientific_md_replica_set_revisions)")
        .all()
        .map((row) => String((row as { name: unknown }).name));
      expect(replicaColumns).toContain("revision");
      expect(replicaColumns).toContain("protocol_digest");

      const stageColumns = db
        .query("PRAGMA table_info(scientific_md_stage_specs)")
        .all()
        .map((row) => String((row as { name: unknown }).name));
      expect(stageColumns).toContain("stage_digest");

      const assessmentColumns = db
        .query("PRAGMA table_info(scientific_md_assessments)")
        .all()
        .map((row) => String((row as { name: unknown }).name));
      expect(assessmentColumns).toContain("subject_revision");
      expect(assessmentColumns).toContain("operation_receipt_id");

      const segmentBindingColumns = db
        .query("PRAGMA table_info(scientific_md_replica_segment_bindings)")
        .all()
        .map((row) => String((row as { name: unknown }).name));
      expect(segmentBindingColumns).toContain("replica_index");
      expect(segmentBindingColumns).toContain("replica_seed");

      const manifestEffectColumns = db
        .query("PRAGMA table_info(scientific_biomolecular_manifest_effects)")
        .all()
        .map((row) => String((row as { name: unknown }).name));
      expect(manifestEffectColumns).toContain("operation_receipt_id");
      expect(manifestEffectColumns).toContain("request_digest");
      expect(manifestEffectColumns).toContain("manifest_digest");

      const completionGateColumns = db
        .query("PRAGMA table_info(scientific_md_work_unit_completion_gates)")
        .all()
        .map((row) => String((row as { name: unknown }).name));
      expect(completionGateColumns).toContain("stage_result_digest");
      expect(completionGateColumns).toContain("assessment_digest");
    } finally {
      db.close();
    }
  });

  test("fails closed instead of silently upgrading pre-v15 MD projections", () => {
    const db = new Database(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      execute(db, SCIENTIFIC_SQLITE_MIGRATION.sql);
      execute(db, MD_BASE_SQLITE_MIGRATION.sql);
      execute(db, MD_INTEGRITY_SQLITE_MIGRATION.sql);
      db.exec("BEGIN");
      db.query(
        `INSERT INTO scientific_missions
         (id, revision, state, budget_id, active_plan_id, objective_digest, payload_digest,
          payload_json, created_at, updated_at, terminal_at)
         VALUES ('mission-legacy-md', 1, 'created', 'budget-legacy-md', NULL, $digest, $digest,
                 '{}', $at, $at, NULL)`,
      ).run({ $digest: DIGEST, $at: AT });
      db.query(
        `INSERT INTO scientific_mission_budgets
         (id, mission_id, revision, limits_json, consumed_json, payload_digest, payload_json)
         VALUES ('budget-legacy-md', 'mission-legacy-md', 1, '{}', '{}', $digest, '{}')`,
      ).run({ $digest: DIGEST });
      db.query(
        `INSERT INTO scientific_biomolecular_decisions
         (id, revision, mission_id, decision_kind, review_status, decision_digest,
          material_digest, approval_ref, payload_json, created_at, updated_at)
         VALUES ('legacy-decision', 1, 'mission-legacy-md', 'construct', 'proposed',
                 $digest, $digest, NULL, '{}', $at, $at)`,
      ).run({ $digest: DIGEST, $at: AT });
      db.exec("COMMIT");

      expect(() => execute(db, MD_EFFECT_AUTHORITY_SQLITE_MIGRATION.sql)).toThrow();
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scientific_md_work_unit_completion_gates'",
          )
          .get(),
      ).toBeNull();
      expect(
        db.query("SELECT COUNT(*) AS count FROM scientific_biomolecular_decisions").get(),
      ).toEqual({
        count: 1,
      });
    } finally {
      db.close();
    }
  });

  test("fails v16 closed when any v15 system manifest still lacks reingested identity authority", () => {
    const db = new Database(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      execute(db, SCIENTIFIC_SQLITE_MIGRATION.sql);
      execute(db, MD_BASE_SQLITE_MIGRATION.sql);
      execute(db, MD_INTEGRITY_SQLITE_MIGRATION.sql);
      execute(db, MD_EFFECT_AUTHORITY_SQLITE_MIGRATION.sql);
      db.exec("BEGIN");
      db.query(
        `INSERT INTO scientific_missions
         (id, revision, state, budget_id, active_plan_id, objective_digest, payload_digest,
          payload_json, created_at, updated_at, terminal_at)
         VALUES ('mission-v15', 1, 'created', 'budget-v15', NULL, $digest, $digest,
                 '{}', $at, $at, NULL)`,
      ).run({ $digest: DIGEST, $at: AT });
      db.query(
        `INSERT INTO scientific_mission_budgets
         (id, mission_id, revision, limits_json, consumed_json, payload_digest, payload_json)
         VALUES ('budget-v15', 'mission-v15', 1, '{}', '{}', $digest, '{}')`,
      ).run({ $digest: DIGEST });
      db.query(
        `INSERT INTO scientific_skill_resolutions
         (id, mission_id, graph_digest, resolver_version, environment_digest, payload_json, resolved_at)
         VALUES ('skills-v15', 'mission-v15', $digest, '1.0.0', $digest, '{}', $at)`,
      ).run({ $digest: DIGEST, $at: AT });
      db.query(
        `INSERT INTO scientific_plans
         (id, mission_id, version, revision, status, skill_resolution_id, skill_graph_digest,
          protocol_digest, plan_digest, parent_plan_id, payload_json, created_at, updated_at)
         VALUES ('plan-v15', 'mission-v15', 1, 1, 'draft', 'skills-v15', $digest,
                 $digest, $digest, NULL, '{}', $at, $at)`,
      ).run({ $digest: DIGEST, $at: AT });
      db.query(
        `INSERT INTO scientific_work_units
         (id, mission_id, plan_id, plan_version, kind, capability_id, state, revision,
          claim_owner, claim_expires_at, job_id, attempt_id, payload_digest, payload_json,
          created_at, updated_at)
         VALUES ('work-v15', 'mission-v15', 'plan-v15', 1, 'validation',
                 'biomolecular.build-system', 'observing', 1, NULL, NULL, NULL, NULL,
                 $digest, '{}', $at, $at)`,
      ).run({ $digest: DIGEST, $at: AT });
      db.query(
        `INSERT INTO scientific_external_operations
         (id, mission_id, work_unit_id, idempotency_key, kind, operation_kind_id, state,
          request_digest, policy_digest, budget_reservation_id, receipt_id, revision,
          payload_json, created_at, updated_at)
         VALUES ('operation-v15', 'mission-v15', 'work-v15', 'idem-v15', 'local_execution',
                 'system_preparation', 'confirmed', $digest, $digest, NULL, NULL, 1,
                 '{}', $at, $at)`,
      ).run({ $digest: DIGEST, $at: AT });
      db.query(
        `INSERT INTO scientific_biomolecular_system_manifests
         (id, revision, mission_id, operation_id, manifest_digest, topology_digest,
          coordinate_digest, atom_map_digest, payload_json, created_at)
         VALUES ('manifest-v15', 1, 'mission-v15', 'operation-v15', $digest, $digest,
                 $digest, $digest, '{}', $at)`,
      ).run({ $digest: DIGEST, $at: AT });
      db.exec("COMMIT");

      expect(() => execute(db, MD_MATERIAL_IDENTITY_SQLITE_MIGRATION.sql)).toThrow();
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scientific_force_field_stack_revisions'",
          )
          .get(),
      ).toBeNull();
      expect(
        db.query("SELECT COUNT(*) AS count FROM scientific_biomolecular_system_manifests").get(),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  test("widens decision kinds only in v17 and fails closed with v16 decision rows", () => {
    const db = new Database(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      execute(db, SCIENTIFIC_SQLITE_MIGRATION.sql);
      for (const migration of MD_SQLITE_MIGRATIONS.slice(0, 4)) execute(db, migration.sql);

      db.exec("BEGIN");
      db.query(
        `INSERT INTO scientific_missions
         (id, revision, state, budget_id, active_plan_id, objective_digest, payload_digest,
          payload_json, created_at, updated_at, terminal_at)
         VALUES ('mission-v16-decision', 1, 'created', 'budget-v16-decision', NULL,
                 $digest, $digest, '{}', $at, $at, NULL)`,
      ).run({ $digest: DIGEST, $at: AT });
      db.query(
        `INSERT INTO scientific_mission_budgets
         (id, mission_id, revision, limits_json, consumed_json, payload_digest, payload_json)
         VALUES ('budget-v16-decision', 'mission-v16-decision', 1, '{}', '{}', $digest, '{}')`,
      ).run({ $digest: DIGEST });
      db.query(
        `INSERT INTO scientific_biomolecular_decisions
         (id, revision, mission_id, decision_kind, review_status, decision_digest,
          material_digest, approval_ref, payload_json, created_at, updated_at)
         VALUES ('legacy-v16-decision', 1, 'mission-v16-decision', 'construct', 'proposed',
                 $digest, $digest, NULL, '{}', $at, $at)`,
      ).run({ $digest: DIGEST, $at: AT });
      db.exec("COMMIT");

      expect(() => execute(db, MD_SQLITE_MIGRATION.sql)).toThrow();
      expect(db.query("SELECT decision_kind FROM scientific_biomolecular_decisions").get()).toEqual(
        { decision_kind: "construct" },
      );
      expect(() =>
        db
          .query(
            `INSERT INTO scientific_biomolecular_decisions
           (id, revision, mission_id, decision_kind, review_status, decision_digest,
            material_digest, approval_ref, payload_json, created_at, updated_at)
           VALUES ('not-backported', 1, 'mission-v16-decision', 'protonation', 'proposed',
                   $digest, $digest, NULL, '{}', $at, $at)`,
          )
          .run({ $digest: DIGEST, $at: AT }),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  test("fails v17 closed when a v16 published manifest would bypass v2 decisions", () => {
    const db = new Database(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      execute(db, SCIENTIFIC_SQLITE_MIGRATION.sql);
      for (const migration of MD_SQLITE_MIGRATIONS.slice(0, 4)) execute(db, migration.sql);
      db.exec("PRAGMA foreign_keys = OFF");
      db.query(
        `INSERT INTO scientific_biomolecular_system_manifests
         (id, revision, mission_id, operation_id, manifest_digest, topology_digest,
          coordinate_digest, atom_map_digest, payload_json, created_at)
         VALUES ('legacy-v16-manifest', 1, 'legacy-mission', 'legacy-operation',
                 $digest, $digest, $digest, $digest,
                 '{"schemaVersion":"eigengrid.biomolecular-system-manifest/v1"}', $at)`,
      ).run({ $digest: DIGEST, $at: AT });

      expect(() => execute(db, MD_SQLITE_MIGRATION.sql)).toThrow();
      expect(
        db.query("SELECT payload_json FROM scientific_biomolecular_system_manifests").get(),
      ).toEqual({
        payload_json: '{"schemaVersion":"eigengrid.biomolecular-system-manifest/v1"}',
      });
    } finally {
      db.close();
    }
  });
});

describe.skipIf(!canRunPostgres)("PostgreSQL biomolecular/MD projection parity", () => {
  test("retains v18 typed scientific decisions and BIGINT artifact sizes in the current schema", async () => {
    const cluster = await startEphemeralPostgres();
    const database = new PostgresDatabase(cluster.url);
    try {
      await database.init();
      expect(await database.getMigrationVersion()).toBe(POSTGRES_MIGRATIONS.at(-1)!.version);
      const tx = await database.beginTransaction();
      try {
        if (!tx.queryRows) throw new Error("PostgreSQL transaction lacks row-query support");
        const queryRows = tx.queryRows.bind(tx);
        expect(
          await queryRows<{ version: number }>(
            "SELECT version FROM _migrations WHERE version = $1",
            [MD_MODEL_AUTHORITY_MIGRATION_VERSION],
          ),
        ).toEqual([{ version: MD_MODEL_AUTHORITY_MIGRATION_VERSION }]);
        const tables = await queryRows<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
          [
            [
              "scientific_biomolecular_decisions",
              "scientific_md_stage_specs",
              "scientific_md_replica_set_revisions",
              "scientific_md_replica_segment_bindings",
              "scientific_md_stage_result_artifacts",
              "scientific_md_assessments",
              "scientific_biomolecular_manifest_effects",
              "scientific_biomolecular_manifest_artifacts",
              "scientific_md_work_unit_completion_gates",
              "scientific_biomolecular_material_effects",
              "scientific_biomolecular_material_artifact_claims",
              "scientific_force_field_stack_revisions",
              "scientific_force_field_stack_evidence",
              "scientific_atom_map_revisions",
            ],
          ],
        );
        expect(new Set(tables.map((row) => row.table_name))).toEqual(
          new Set([
            "scientific_biomolecular_decisions",
            "scientific_md_stage_specs",
            "scientific_md_replica_set_revisions",
            "scientific_md_replica_segment_bindings",
            "scientific_md_stage_result_artifacts",
            "scientific_md_assessments",
            "scientific_biomolecular_manifest_effects",
            "scientific_biomolecular_manifest_artifacts",
            "scientific_md_work_unit_completion_gates",
            "scientific_biomolecular_material_effects",
            "scientific_biomolecular_material_artifact_claims",
            "scientific_force_field_stack_revisions",
            "scientific_force_field_stack_evidence",
            "scientific_atom_map_revisions",
          ]),
        );
        const artifactSizes = await queryRows<{ table_name: string; data_type: string }>(
          `SELECT table_name, data_type FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = ANY($1::text[])
             AND column_name = 'size_bytes'
           ORDER BY table_name`,
          [
            [
              "scientific_biomolecular_manifest_artifacts",
              "scientific_biomolecular_material_artifact_claims",
              "scientific_force_field_stack_evidence",
              "scientific_md_stage_result_artifacts",
            ],
          ],
        );
        expect(artifactSizes).toEqual([
          { table_name: "scientific_biomolecular_manifest_artifacts", data_type: "bigint" },
          {
            table_name: "scientific_biomolecular_material_artifact_claims",
            data_type: "bigint",
          },
          { table_name: "scientific_force_field_stack_evidence", data_type: "bigint" },
          { table_name: "scientific_md_stage_result_artifacts", data_type: "bigint" },
        ]);
        const constraint = await queryRows<{ definition: string }>(
          `SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
           WHERE conname = 'scientific_approval_requests_subject_type_check'`,
        );
        expect(constraint).toHaveLength(1);
        const decisionConstraint = await queryRows<{ definition: string }>(
          `SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
           WHERE conname = 'scientific_biomolecular_decisions_decision_kind_check'`,
        );
        expect(decisionConstraint).toHaveLength(1);
        for (const kind of ["force_field_stack", "membrane_model", "protonation"]) {
          expect(decisionConstraint[0]!.definition).toContain(kind);
        }
        for (const subjectType of SUBJECT_TYPES) {
          expect(constraint[0]!.definition).toContain(subjectType);
        }
        await tx.commit();
      } catch (error) {
        await tx.rollback();
        throw error;
      }
    } finally {
      await database.close();
      cluster.cleanup();
    }
  });
});
