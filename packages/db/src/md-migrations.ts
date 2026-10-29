/**
 * Immutable biomolecular/MD projections beneath the scientific mission kernel.
 *
 * These tables never become a second lifecycle owner. Work-unit and external-
 * operation state remain canonical; MD bindings identify those records and
 * results are appended only with their authoritative operation receipt.
 */
export const MD_BASE_MIGRATION_VERSION = 13;
export const MD_BASE_MIGRATION_NAME = "biomolecular_md_projections";

function mdSql(options: { integer: string; real: string; ifNotExists: string }): string {
  const { integer, real, ifNotExists } = options;
  return `
    ALTER TABLE scientific_work_units ADD COLUMN ${ifNotExists}capability_id TEXT NOT NULL DEFAULT 'legacy.unknown';
    UPDATE scientific_work_units SET capability_id = kind WHERE capability_id = 'legacy.unknown';
    ALTER TABLE scientific_external_operations ADD COLUMN ${ifNotExists}operation_kind_id TEXT NOT NULL DEFAULT 'legacy.unknown';
    UPDATE scientific_external_operations SET operation_kind_id = kind WHERE operation_kind_id = 'legacy.unknown';
    ALTER TABLE scientific_evidence ADD COLUMN ${ifNotExists}evidence_kind_id TEXT NOT NULL DEFAULT 'legacy.unknown';
    UPDATE scientific_evidence SET evidence_kind_id = kind WHERE evidence_kind_id = 'legacy.unknown';
    ALTER TABLE scientific_observations ADD COLUMN ${ifNotExists}observation_type_id TEXT NOT NULL DEFAULT 'legacy.unknown';
    UPDATE scientific_observations SET observation_type_id = type WHERE observation_type_id = 'legacy.unknown';
    ALTER TABLE scientific_model_invocations ADD COLUMN ${ifNotExists}model_role_id TEXT NOT NULL DEFAULT 'legacy.unknown';
    UPDATE scientific_model_invocations SET model_role_id = role WHERE model_role_id = 'legacy.unknown';

    CREATE TABLE IF NOT EXISTS scientific_biomolecular_system_manifests (
      id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      operation_id TEXT NOT NULL REFERENCES scientific_external_operations(id) ON DELETE RESTRICT,
      manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
      topology_digest TEXT NOT NULL CHECK (length(topology_digest) = 64),
      coordinate_digest TEXT NOT NULL CHECK (length(coordinate_digest) = 64),
      atom_map_digest TEXT NOT NULL CHECK (length(atom_map_digest) = 64),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (id, revision),
      UNIQUE (mission_id, manifest_digest)
    );

    CREATE TABLE IF NOT EXISTS scientific_md_protocols (
      id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      plan_id TEXT NOT NULL REFERENCES scientific_plans(id) ON DELETE RESTRICT,
      system_manifest_id TEXT NOT NULL,
      system_manifest_revision INTEGER NOT NULL CHECK (system_manifest_revision > 0),
      protocol_digest TEXT NOT NULL CHECK (length(protocol_digest) = 64),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (id, revision),
      FOREIGN KEY (system_manifest_id, system_manifest_revision)
        REFERENCES scientific_biomolecular_system_manifests(id, revision) ON DELETE RESTRICT,
      UNIQUE (mission_id, protocol_digest)
    );

    CREATE TABLE IF NOT EXISTS scientific_md_replica_sets (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      protocol_id TEXT NOT NULL,
      protocol_revision INTEGER NOT NULL CHECK (protocol_revision > 0),
      decision_id TEXT NOT NULL REFERENCES scientific_decisions(id) ON DELETE RESTRICT,
      replica_count INTEGER NOT NULL CHECK (replica_count > 0),
      seed_policy_digest TEXT NOT NULL CHECK (length(seed_policy_digest) = 64),
      payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (protocol_id, protocol_revision)
        REFERENCES scientific_md_protocols(id, revision) ON DELETE RESTRICT,
      UNIQUE (mission_id, protocol_id, protocol_revision)
    );

    CREATE TABLE IF NOT EXISTS scientific_md_stage_bindings (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      protocol_id TEXT NOT NULL,
      protocol_revision INTEGER NOT NULL CHECK (protocol_revision > 0),
      work_unit_id TEXT NOT NULL UNIQUE REFERENCES scientific_work_units(id) ON DELETE RESTRICT,
      operation_id TEXT NOT NULL UNIQUE REFERENCES scientific_external_operations(id) ON DELETE RESTRICT,
      stage_id TEXT NOT NULL,
      replica_id TEXT,
      segment_index INTEGER CHECK (segment_index IS NULL OR segment_index >= 0),
      request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (protocol_id, protocol_revision)
        REFERENCES scientific_md_protocols(id, revision) ON DELETE RESTRICT,
      UNIQUE (mission_id, protocol_id, protocol_revision, stage_id, replica_id, segment_index),
      CHECK ((replica_id IS NULL AND segment_index IS NULL) OR replica_id IS NOT NULL)
    );

    CREATE TABLE IF NOT EXISTS scientific_md_stage_results (
      id TEXT PRIMARY KEY,
      stage_binding_id TEXT NOT NULL UNIQUE REFERENCES scientific_md_stage_bindings(id) ON DELETE RESTRICT,
      operation_receipt_id TEXT NOT NULL UNIQUE REFERENCES scientific_operation_receipts(id) ON DELETE RESTRICT,
      result_digest TEXT NOT NULL CHECK (length(result_digest) = 64),
      terminal_reason TEXT NOT NULL CHECK (terminal_reason IN ('completed','cancelled','timeout','signal','engine_failure','validation_failure','ambiguous')),
      exit_code INTEGER,
      payload_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scientific_md_trajectory_segments (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      stage_binding_id TEXT NOT NULL UNIQUE REFERENCES scientific_md_stage_bindings(id) ON DELETE RESTRICT,
      replica_id TEXT NOT NULL,
      segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
      parent_restart_digest TEXT NOT NULL CHECK (length(parent_restart_digest) = 64),
      start_step ${integer} NOT NULL CHECK (start_step >= 0),
      end_step ${integer} NOT NULL CHECK (end_step > start_step),
      start_time_ps ${real} NOT NULL CHECK (start_time_ps >= 0),
      end_time_ps ${real} NOT NULL CHECK (end_time_ps > start_time_ps),
      frame_count INTEGER NOT NULL CHECK (frame_count > 0),
      trajectory_digest TEXT NOT NULL CHECK (length(trajectory_digest) = 64),
      restart_digest TEXT NOT NULL CHECK (length(restart_digest) = 64),
      continuity_status TEXT NOT NULL CHECK (continuity_status IN ('verified','failed','indeterminate')),
      payload_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      UNIQUE (mission_id, replica_id, segment_index)
    );

    CREATE TABLE IF NOT EXISTS scientific_md_analysis_results (
      id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      system_manifest_id TEXT NOT NULL,
      system_manifest_revision INTEGER NOT NULL CHECK (system_manifest_revision > 0),
      operation_id TEXT NOT NULL REFERENCES scientific_external_operations(id) ON DELETE RESTRICT,
      operation_receipt_id TEXT NOT NULL UNIQUE REFERENCES scientific_operation_receipts(id) ON DELETE RESTRICT,
      analysis_kind TEXT NOT NULL,
      result_digest TEXT NOT NULL CHECK (length(result_digest) = 64),
      payload_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (id, revision),
      FOREIGN KEY (system_manifest_id, system_manifest_revision)
        REFERENCES scientific_biomolecular_system_manifests(id, revision) ON DELETE RESTRICT,
      UNIQUE (mission_id, result_digest)
    );

    CREATE TABLE IF NOT EXISTS scientific_md_metric_series (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      stage_result_id TEXT REFERENCES scientific_md_stage_results(id) ON DELETE RESTRICT,
      analysis_result_id TEXT,
      analysis_result_revision INTEGER,
      metric_name TEXT NOT NULL,
      units TEXT NOT NULL,
      artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
      payload_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      FOREIGN KEY (analysis_result_id, analysis_result_revision)
        REFERENCES scientific_md_analysis_results(id, revision) ON DELETE RESTRICT,
      CHECK ((stage_result_id IS NULL) <> (analysis_result_id IS NULL)),
      CHECK ((analysis_result_id IS NULL AND analysis_result_revision IS NULL) OR
             (analysis_result_id IS NOT NULL AND analysis_result_revision IS NOT NULL)),
      UNIQUE (mission_id, metric_name, artifact_digest)
    );

    CREATE INDEX IF NOT EXISTS scientific_biomolecular_manifests_mission_idx
      ON scientific_biomolecular_system_manifests(mission_id, created_at);
    CREATE INDEX IF NOT EXISTS scientific_md_stage_bindings_mission_idx
      ON scientific_md_stage_bindings(mission_id, protocol_id, protocol_revision);
    CREATE INDEX IF NOT EXISTS scientific_md_segments_replica_idx
      ON scientific_md_trajectory_segments(mission_id, replica_id, segment_index);
    CREATE INDEX IF NOT EXISTS scientific_md_analysis_mission_idx
      ON scientific_md_analysis_results(mission_id, analysis_kind, recorded_at);
    CREATE INDEX IF NOT EXISTS scientific_work_units_capability_idx
      ON scientific_work_units(mission_id, capability_id, state);
    CREATE INDEX IF NOT EXISTS scientific_operations_kind_id_idx
      ON scientific_external_operations(mission_id, operation_kind_id, state);
    CREATE INDEX IF NOT EXISTS scientific_evidence_kind_id_idx
      ON scientific_evidence(mission_id, evidence_kind_id, created_at);
  `;
}

export const MD_BASE_SQLITE_MIGRATION = {
  version: MD_BASE_MIGRATION_VERSION,
  name: MD_BASE_MIGRATION_NAME,
  sql: mdSql({ integer: "INTEGER", real: "REAL", ifNotExists: "" }),
};

export const MD_BASE_POSTGRES_MIGRATION = {
  version: MD_BASE_MIGRATION_VERSION,
  name: MD_BASE_MIGRATION_NAME,
  sql: mdSql({ integer: "BIGINT", real: "DOUBLE PRECISION", ifNotExists: "IF NOT EXISTS " }),
};

export const MD_INTEGRITY_MIGRATION_VERSION = 14;
export const MD_INTEGRITY_MIGRATION_NAME = "biomolecular_md_projection_integrity";

const mdProjectionTablesSql = `
  CREATE TABLE IF NOT EXISTS scientific_biomolecular_decisions (
    id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
    decision_kind TEXT NOT NULL CHECK (decision_kind IN ('construct','microstate','pose')),
    review_status TEXT NOT NULL CHECK (review_status IN ('proposed','approved','rejected','superseded')),
    decision_digest TEXT NOT NULL CHECK (length(decision_digest) = 64),
    material_digest TEXT NOT NULL CHECK (length(material_digest) = 64),
    approval_ref TEXT REFERENCES scientific_approval_requests(id) ON DELETE RESTRICT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (id, revision),
    UNIQUE (mission_id, decision_digest)
  );

  CREATE TABLE IF NOT EXISTS scientific_md_stage_specs (
    id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
    protocol_id TEXT NOT NULL,
    protocol_revision INTEGER NOT NULL CHECK (protocol_revision > 0),
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    stage_kind TEXT NOT NULL CHECK (stage_kind IN ('minimization','heating','equilibration','production')),
    stage_digest TEXT NOT NULL CHECK (length(stage_digest) = 64),
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (id, revision),
    FOREIGN KEY (protocol_id, protocol_revision)
      REFERENCES scientific_md_protocols(id, revision) ON DELETE RESTRICT,
    UNIQUE (protocol_id, protocol_revision, sequence),
    UNIQUE (mission_id, stage_digest)
  );

  CREATE TABLE IF NOT EXISTS scientific_md_replica_set_revisions (
    id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
    protocol_id TEXT NOT NULL,
    protocol_revision INTEGER NOT NULL CHECK (protocol_revision > 0),
    protocol_digest TEXT NOT NULL CHECK (length(protocol_digest) = 64),
    decision_id TEXT NOT NULL,
    replica_count INTEGER NOT NULL CHECK (replica_count > 0),
    seed_policy_digest TEXT NOT NULL CHECK (length(seed_policy_digest) = 64),
    payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (id, revision),
    FOREIGN KEY (protocol_id, protocol_revision)
      REFERENCES scientific_md_protocols(id, revision) ON DELETE RESTRICT,
    UNIQUE (mission_id, payload_digest)
  );

  CREATE TABLE IF NOT EXISTS scientific_md_replica_segment_bindings (
    stage_binding_id TEXT PRIMARY KEY
      REFERENCES scientific_md_stage_bindings(id) ON DELETE RESTRICT,
    mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
    replica_set_id TEXT NOT NULL,
    replica_set_revision INTEGER NOT NULL CHECK (replica_set_revision > 0),
    replica_set_digest TEXT NOT NULL CHECK (length(replica_set_digest) = 64),
    replica_id TEXT NOT NULL,
    replica_index INTEGER NOT NULL CHECK (replica_index > 0),
    replica_seed INTEGER NOT NULL CHECK (replica_seed > 0 AND replica_seed < 2147483647),
    segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
    parent_restart_digest TEXT NOT NULL CHECK (length(parent_restart_digest) = 64),
    created_at TEXT NOT NULL,
    FOREIGN KEY (replica_set_id, replica_set_revision)
      REFERENCES scientific_md_replica_set_revisions(id, revision) ON DELETE RESTRICT,
    UNIQUE (mission_id, replica_set_id, replica_set_revision, replica_id, segment_index)
  );

  CREATE TABLE IF NOT EXISTS scientific_md_stage_result_artifacts (
    stage_result_id TEXT NOT NULL
      REFERENCES scientific_md_stage_results(id) ON DELETE RESTRICT,
    artifact_role TEXT NOT NULL,
    evidence_id TEXT NOT NULL REFERENCES scientific_evidence(id) ON DELETE RESTRICT,
    operation_receipt_id TEXT NOT NULL
      REFERENCES scientific_operation_receipts(id) ON DELETE RESTRICT,
    content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
    media_type TEXT NOT NULL,
    size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
    payload_json TEXT NOT NULL,
    PRIMARY KEY (stage_result_id, artifact_role),
    UNIQUE (stage_result_id, evidence_id)
  );

  CREATE TABLE IF NOT EXISTS scientific_md_assessments (
    id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
    assessment_kind TEXT NOT NULL CHECK (assessment_kind IN ('stage','replica_convergence','scientific')),
    subject_id TEXT NOT NULL,
    subject_revision INTEGER NOT NULL CHECK (subject_revision > 0),
    operation_id TEXT NOT NULL REFERENCES scientific_external_operations(id) ON DELETE RESTRICT,
    operation_receipt_id TEXT NOT NULL REFERENCES scientific_operation_receipts(id) ON DELETE RESTRICT,
    assessment_digest TEXT NOT NULL CHECK (length(assessment_digest) = 64),
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (id, revision),
    UNIQUE (mission_id, assessment_digest),
    UNIQUE (operation_receipt_id)
  );

  CREATE INDEX IF NOT EXISTS scientific_biomolecular_decisions_mission_idx
    ON scientific_biomolecular_decisions(mission_id, decision_kind, review_status);
  CREATE INDEX IF NOT EXISTS scientific_md_stage_specs_protocol_idx
    ON scientific_md_stage_specs(protocol_id, protocol_revision, sequence);
  CREATE INDEX IF NOT EXISTS scientific_md_replica_revisions_mission_idx
    ON scientific_md_replica_set_revisions(mission_id, protocol_id, protocol_revision);
  CREATE INDEX IF NOT EXISTS scientific_md_replica_segment_bindings_idx
    ON scientific_md_replica_segment_bindings(
      mission_id, replica_set_id, replica_set_revision, replica_id, segment_index
    );
  CREATE INDEX IF NOT EXISTS scientific_md_stage_result_artifacts_receipt_idx
    ON scientific_md_stage_result_artifacts(operation_receipt_id, stage_result_id);
  CREATE INDEX IF NOT EXISTS scientific_md_assessments_subject_idx
    ON scientific_md_assessments(mission_id, assessment_kind, subject_id, subject_revision);
  CREATE INDEX IF NOT EXISTS scientific_biomolecular_system_integrity_idx
    ON scientific_biomolecular_system_manifests(mission_id, revision, manifest_digest);
  CREATE INDEX IF NOT EXISTS scientific_md_protocol_integrity_idx
    ON scientific_md_protocols(mission_id, revision, protocol_digest);
  CREATE INDEX IF NOT EXISTS scientific_md_replica_sets_integrity_idx
    ON scientific_md_replica_sets(mission_id, revision, payload_digest);
  CREATE INDEX IF NOT EXISTS scientific_md_stage_bindings_integrity_idx
    ON scientific_md_stage_bindings(mission_id, stage_id, request_digest);
  CREATE INDEX IF NOT EXISTS scientific_md_stage_results_integrity_idx
    ON scientific_md_stage_results(mission_id, stage_id, stage_digest);
  CREATE INDEX IF NOT EXISTS scientific_md_trajectory_segments_integrity_idx
    ON scientific_md_trajectory_segments(mission_id, replica_id, segment_index);
  CREATE INDEX IF NOT EXISTS scientific_md_analysis_results_integrity_idx
    ON scientific_md_analysis_results(mission_id, revision, result_digest);
  CREATE INDEX IF NOT EXISTS scientific_md_metric_series_integrity_idx
    ON scientific_md_metric_series(mission_id, metric_name, series_digest);
`;

const approvalSubjectTypes =
  "'plan','decision','operation','result','biomolecular_system_manifest','md_protocol','md_stage','replica_set','md_assessment'";

const sqliteApprovalRebuildSql = `
  CREATE TABLE scientific_approval_requests_v14 (
    id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
    subject_type TEXT NOT NULL CHECK (subject_type IN (${approvalSubjectTypes})),
    subject_id TEXT NOT NULL,
    subject_version INTEGER NOT NULL CHECK (subject_version > 0),
    subject_revision INTEGER NOT NULL CHECK (subject_revision > 0),
    state TEXT NOT NULL CHECK (state IN ('pending','approved','rejected','expired','superseded')),
    requested_from_role TEXT NOT NULL,
    payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
    policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
    payload_json TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    expires_at TEXT
  );
  INSERT INTO scientific_approval_requests_v14
    (id, mission_id, subject_type, subject_id, subject_version, subject_revision, state,
     requested_from_role, payload_digest, policy_digest, payload_json, requested_at, expires_at)
  SELECT id, mission_id, subject_type, subject_id, subject_version, subject_revision, state,
         requested_from_role, payload_digest, policy_digest, payload_json, requested_at, expires_at
  FROM scientific_approval_requests;

  CREATE TABLE scientific_approval_responses_v14 (
    id TEXT PRIMARY KEY,
    approval_request_id TEXT NOT NULL UNIQUE
      REFERENCES scientific_approval_requests_v14(id) ON DELETE RESTRICT,
    decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
    actor_id TEXT NOT NULL,
    role TEXT NOT NULL,
    subject_version INTEGER NOT NULL CHECK (subject_version > 0),
    subject_revision INTEGER NOT NULL CHECK (subject_revision > 0),
    payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
    policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
    payload_json TEXT NOT NULL,
    decided_at TEXT NOT NULL
  );
  INSERT INTO scientific_approval_responses_v14
    (id, approval_request_id, decision, actor_id, role, subject_version, subject_revision,
     payload_digest, policy_digest, payload_json, decided_at)
  SELECT id, approval_request_id, decision, actor_id, role, subject_version, subject_revision,
         payload_digest, policy_digest, payload_json, decided_at
  FROM scientific_approval_responses;

  DROP TABLE scientific_approval_responses;
  DROP TABLE scientific_approval_requests;
  ALTER TABLE scientific_approval_requests_v14 RENAME TO scientific_approval_requests;
  ALTER TABLE scientific_approval_responses_v14 RENAME TO scientific_approval_responses;
`;

const sqliteProjectionAlterSql = `
  ALTER TABLE scientific_md_protocols ADD COLUMN plan_version INTEGER;
  ALTER TABLE scientific_md_protocols ADD COLUMN material_digest TEXT;
  ALTER TABLE scientific_md_protocols ADD COLUMN review_status TEXT;
  ALTER TABLE scientific_md_protocols ADD COLUMN updated_at TEXT;
  ALTER TABLE scientific_md_replica_sets ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE scientific_md_stage_results ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE scientific_md_stage_results ADD COLUMN mission_id TEXT;
  ALTER TABLE scientific_md_stage_results ADD COLUMN stage_id TEXT;
  ALTER TABLE scientific_md_stage_results ADD COLUMN stage_revision INTEGER;
  ALTER TABLE scientific_md_stage_results ADD COLUMN stage_digest TEXT;
  ALTER TABLE scientific_md_stage_results ADD COLUMN protocol_id TEXT;
  ALTER TABLE scientific_md_stage_results ADD COLUMN protocol_revision INTEGER;
  ALTER TABLE scientific_md_stage_results ADD COLUMN protocol_digest TEXT;
  ALTER TABLE scientific_md_stage_results ADD COLUMN replica_set_id TEXT;
  ALTER TABLE scientific_md_stage_results ADD COLUMN replica_set_revision INTEGER;
  ALTER TABLE scientific_md_stage_results ADD COLUMN replica_set_digest TEXT;
  ALTER TABLE scientific_md_stage_results ADD COLUMN replica_id TEXT;
  ALTER TABLE scientific_md_stage_results ADD COLUMN segment_index INTEGER;
  ALTER TABLE scientific_md_stage_results ADD COLUMN parent_restart_digest TEXT;
  ALTER TABLE scientific_md_trajectory_segments ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE scientific_md_trajectory_segments ADD COLUMN segment_digest TEXT;
  ALTER TABLE scientific_md_metric_series ADD COLUMN series_digest TEXT;
`;

const postgresApprovalAndProjectionAlterSql = `
  ALTER TABLE scientific_approval_requests
    DROP CONSTRAINT IF EXISTS scientific_approval_requests_subject_type_check;
  ALTER TABLE scientific_approval_requests
    ADD CONSTRAINT scientific_approval_requests_subject_type_check
    CHECK (subject_type IN (${approvalSubjectTypes}));

  ALTER TABLE scientific_md_protocols ADD COLUMN IF NOT EXISTS plan_version INTEGER;
  ALTER TABLE scientific_md_protocols ADD COLUMN IF NOT EXISTS material_digest TEXT;
  ALTER TABLE scientific_md_protocols ADD COLUMN IF NOT EXISTS review_status TEXT;
  ALTER TABLE scientific_md_protocols ADD COLUMN IF NOT EXISTS updated_at TEXT;
  ALTER TABLE scientific_md_replica_sets ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE scientific_md_stage_results ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE scientific_md_stage_results ADD COLUMN IF NOT EXISTS mission_id TEXT;
  ALTER TABLE scientific_md_stage_results ADD COLUMN IF NOT EXISTS stage_id TEXT;
  ALTER TABLE scientific_md_stage_results ADD COLUMN IF NOT EXISTS stage_revision INTEGER;
  ALTER TABLE scientific_md_stage_results ADD COLUMN IF NOT EXISTS stage_digest TEXT;
  ALTER TABLE scientific_md_stage_results ADD COLUMN IF NOT EXISTS protocol_id TEXT;
  ALTER TABLE scientific_md_stage_results ADD COLUMN IF NOT EXISTS protocol_revision INTEGER;
  ALTER TABLE scientific_md_stage_results ADD COLUMN IF NOT EXISTS protocol_digest TEXT;
  ALTER TABLE scientific_md_stage_results ADD COLUMN IF NOT EXISTS replica_set_id TEXT;
  ALTER TABLE scientific_md_stage_results ADD COLUMN IF NOT EXISTS replica_set_revision INTEGER;
  ALTER TABLE scientific_md_stage_results ADD COLUMN IF NOT EXISTS replica_set_digest TEXT;
  ALTER TABLE scientific_md_stage_results ADD COLUMN IF NOT EXISTS replica_id TEXT;
  ALTER TABLE scientific_md_stage_results ADD COLUMN IF NOT EXISTS segment_index INTEGER;
  ALTER TABLE scientific_md_stage_results ADD COLUMN IF NOT EXISTS parent_restart_digest TEXT;
  ALTER TABLE scientific_md_trajectory_segments ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE scientific_md_trajectory_segments ADD COLUMN IF NOT EXISTS segment_digest TEXT;
  ALTER TABLE scientific_md_metric_series ADD COLUMN IF NOT EXISTS series_digest TEXT;
`;

export const MD_INTEGRITY_SQLITE_MIGRATION = {
  version: MD_INTEGRITY_MIGRATION_VERSION,
  name: MD_INTEGRITY_MIGRATION_NAME,
  sql: `${sqliteApprovalRebuildSql}\n${sqliteProjectionAlterSql}\n${mdProjectionTablesSql}`,
};

export const MD_INTEGRITY_POSTGRES_MIGRATION = {
  version: MD_INTEGRITY_MIGRATION_VERSION,
  name: MD_INTEGRITY_MIGRATION_NAME,
  sql: `${postgresApprovalAndProjectionAlterSql}\n${mdProjectionTablesSql}`,
};

export const MD_EFFECT_AUTHORITY_MIGRATION_VERSION = 15;
export const MD_EFFECT_AUTHORITY_MIGRATION_NAME = "biomolecular_md_effect_and_completion_authority";

const mdV15UnsafeRowCountSql = `
  SELECT
    (SELECT COUNT(*) FROM scientific_biomolecular_system_manifests) +
    (SELECT COUNT(*) FROM scientific_md_protocols) +
    (SELECT COUNT(*) FROM scientific_md_replica_sets) +
    (SELECT COUNT(*) FROM scientific_md_stage_bindings) +
    (SELECT COUNT(*) FROM scientific_md_stage_results) +
    (SELECT COUNT(*) FROM scientific_md_trajectory_segments) +
    (SELECT COUNT(*) FROM scientific_md_analysis_results) +
    (SELECT COUNT(*) FROM scientific_md_metric_series) +
    (SELECT COUNT(*) FROM scientific_biomolecular_decisions) +
    (SELECT COUNT(*) FROM scientific_md_stage_specs) +
    (SELECT COUNT(*) FROM scientific_md_replica_set_revisions) +
    (SELECT COUNT(*) FROM scientific_md_stage_result_artifacts) +
    (SELECT COUNT(*) FROM scientific_md_assessments)
`;

function mdV15GuardSql(integer: string): string {
  return `
    CREATE TEMP TABLE scientific_md_v15_upgrade_guard (
      unsafe_row_count ${integer} NOT NULL CHECK (unsafe_row_count = 0)
    );
    INSERT INTO scientific_md_v15_upgrade_guard (unsafe_row_count)
      ${mdV15UnsafeRowCountSql};
    DROP TABLE scientific_md_v15_upgrade_guard;
  `;
}

function mdV15TablesSql(integer: string): string {
  return `
    CREATE TABLE scientific_biomolecular_manifest_effects (
      manifest_id TEXT NOT NULL,
      manifest_revision INTEGER NOT NULL CHECK (manifest_revision > 0),
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      operation_id TEXT NOT NULL UNIQUE
        REFERENCES scientific_external_operations(id) ON DELETE RESTRICT,
      operation_receipt_id TEXT NOT NULL UNIQUE
        REFERENCES scientific_operation_receipts(id) ON DELETE RESTRICT,
      request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
      manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (manifest_id, manifest_revision),
      FOREIGN KEY (manifest_id, manifest_revision)
        REFERENCES scientific_biomolecular_system_manifests(id, revision) ON DELETE RESTRICT
    );

    CREATE TABLE scientific_biomolecular_manifest_artifacts (
      manifest_id TEXT NOT NULL,
      manifest_revision INTEGER NOT NULL CHECK (manifest_revision > 0),
      artifact_role TEXT NOT NULL CHECK (artifact_role IN ('topology','coordinates','atom_map')),
      evidence_id TEXT NOT NULL UNIQUE REFERENCES scientific_evidence(id) ON DELETE RESTRICT,
      operation_receipt_id TEXT NOT NULL
        REFERENCES scientific_operation_receipts(id) ON DELETE RESTRICT,
      content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
      media_type TEXT NOT NULL,
      size_bytes ${integer} CHECK (size_bytes IS NULL OR size_bytes >= 0),
      payload_json TEXT NOT NULL,
      PRIMARY KEY (manifest_id, manifest_revision, artifact_role),
      FOREIGN KEY (manifest_id, manifest_revision)
        REFERENCES scientific_biomolecular_system_manifests(id, revision) ON DELETE RESTRICT
    );

    CREATE TABLE scientific_md_work_unit_completion_gates (
      work_unit_id TEXT PRIMARY KEY REFERENCES scientific_work_units(id) ON DELETE RESTRICT,
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      stage_result_id TEXT NOT NULL UNIQUE
        REFERENCES scientific_md_stage_results(id) ON DELETE RESTRICT,
      stage_result_digest TEXT NOT NULL CHECK (length(stage_result_digest) = 64),
      assessment_id TEXT NOT NULL,
      assessment_revision INTEGER NOT NULL CHECK (assessment_revision > 0),
      assessment_digest TEXT NOT NULL CHECK (length(assessment_digest) = 64),
      payload_json TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      FOREIGN KEY (assessment_id, assessment_revision)
        REFERENCES scientific_md_assessments(id, revision) ON DELETE RESTRICT,
      UNIQUE (assessment_id, assessment_revision)
    );

    CREATE INDEX scientific_biomolecular_manifest_effects_mission_idx
      ON scientific_biomolecular_manifest_effects(mission_id, manifest_id, manifest_revision);
    CREATE INDEX scientific_md_completion_gates_mission_idx
      ON scientific_md_work_unit_completion_gates(mission_id, completed_at);
  `;
}

export const MD_EFFECT_AUTHORITY_SQLITE_MIGRATION = {
  version: MD_EFFECT_AUTHORITY_MIGRATION_VERSION,
  name: MD_EFFECT_AUTHORITY_MIGRATION_NAME,
  sql: `${mdV15GuardSql("INTEGER")}\n${mdV15TablesSql("INTEGER")}`,
};

export const MD_EFFECT_AUTHORITY_POSTGRES_MIGRATION = {
  version: MD_EFFECT_AUTHORITY_MIGRATION_VERSION,
  name: MD_EFFECT_AUTHORITY_MIGRATION_NAME,
  sql: `${mdV15GuardSql("BIGINT")}
    ALTER TABLE scientific_md_stage_result_artifacts
      ALTER COLUMN size_bytes TYPE BIGINT;
    ${mdV15TablesSql("BIGINT")}`,
};

export const MD_MATERIAL_IDENTITY_MIGRATION_VERSION = 16;
export const MD_MATERIAL_IDENTITY_MIGRATION_NAME = "biomolecular_material_identity_authority";

const mdV16UnsafeRowCountSql = `
  SELECT
    (SELECT COUNT(*) FROM scientific_biomolecular_system_manifests) +
    (SELECT COUNT(*) FROM scientific_md_protocols) +
    (SELECT COUNT(*) FROM scientific_md_replica_sets) +
    (SELECT COUNT(*) FROM scientific_md_stage_bindings) +
    (SELECT COUNT(*) FROM scientific_md_stage_results) +
    (SELECT COUNT(*) FROM scientific_md_trajectory_segments) +
    (SELECT COUNT(*) FROM scientific_md_analysis_results) +
    (SELECT COUNT(*) FROM scientific_md_metric_series) +
    (SELECT COUNT(*) FROM scientific_md_stage_specs) +
    (SELECT COUNT(*) FROM scientific_md_replica_set_revisions) +
    (SELECT COUNT(*) FROM scientific_md_stage_result_artifacts) +
    (SELECT COUNT(*) FROM scientific_md_assessments)
`;

function mdV16GuardSql(integer: string): string {
  return `
    CREATE TEMP TABLE scientific_md_v16_upgrade_guard (
      unsafe_row_count ${integer} NOT NULL CHECK (unsafe_row_count = 0)
    );
    INSERT INTO scientific_md_v16_upgrade_guard (unsafe_row_count)
      ${mdV16UnsafeRowCountSql};
    DROP TABLE scientific_md_v16_upgrade_guard;
  `;
}

function mdV16TablesSql(integer: string): string {
  return `
    CREATE TABLE scientific_biomolecular_material_effects (
      subject_type TEXT NOT NULL
        CHECK (subject_type IN ('system_manifest','force_field_stack','atom_map')),
      subject_id TEXT NOT NULL,
      subject_revision INTEGER NOT NULL CHECK (subject_revision > 0),
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      operation_id TEXT NOT NULL UNIQUE
        REFERENCES scientific_external_operations(id) ON DELETE RESTRICT,
      operation_receipt_id TEXT NOT NULL UNIQUE
        REFERENCES scientific_operation_receipts(id) ON DELETE RESTRICT,
      request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
      content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (subject_type, subject_id, subject_revision)
    );

    CREATE TABLE scientific_biomolecular_material_artifact_claims (
      evidence_id TEXT PRIMARY KEY REFERENCES scientific_evidence(id) ON DELETE RESTRICT,
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      subject_type TEXT NOT NULL CHECK (subject_type IN ('system_manifest','force_field_stack')),
      subject_id TEXT NOT NULL,
      subject_revision INTEGER NOT NULL CHECK (subject_revision > 0),
      artifact_role TEXT NOT NULL
        CHECK (artifact_role IN ('topology','coordinates','atom_map','force_field_stack')),
      operation_receipt_id TEXT NOT NULL
        REFERENCES scientific_operation_receipts(id) ON DELETE RESTRICT,
      content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
      media_type TEXT NOT NULL,
      size_bytes ${integer} CHECK (size_bytes IS NULL OR size_bytes >= 0),
      payload_json TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      UNIQUE (subject_type, subject_id, subject_revision, artifact_role)
    );

    CREATE TABLE scientific_force_field_stack_revisions (
      id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      stack_digest TEXT NOT NULL CHECK (length(stack_digest) = 64),
      artifact_evidence_id TEXT NOT NULL UNIQUE
        REFERENCES scientific_evidence(id) ON DELETE RESTRICT,
      operation_id TEXT NOT NULL UNIQUE
        REFERENCES scientific_external_operations(id) ON DELETE RESTRICT,
      operation_receipt_id TEXT NOT NULL UNIQUE
        REFERENCES scientific_operation_receipts(id) ON DELETE RESTRICT,
      request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (id, revision),
      UNIQUE (mission_id, stack_digest)
    );

    CREATE TABLE scientific_force_field_stack_evidence (
      stack_id TEXT NOT NULL,
      stack_revision INTEGER NOT NULL CHECK (stack_revision > 0),
      evidence_id TEXT NOT NULL REFERENCES scientific_evidence(id) ON DELETE RESTRICT,
      evidence_roles_json TEXT NOT NULL,
      content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
      media_type TEXT NOT NULL,
      size_bytes ${integer} CHECK (size_bytes IS NULL OR size_bytes >= 0),
      payload_json TEXT NOT NULL,
      PRIMARY KEY (stack_id, stack_revision, evidence_id),
      FOREIGN KEY (stack_id, stack_revision)
        REFERENCES scientific_force_field_stack_revisions(id, revision) ON DELETE RESTRICT
    );

    CREATE TABLE scientific_atom_map_revisions (
      id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      system_manifest_id TEXT NOT NULL,
      system_manifest_revision INTEGER NOT NULL CHECK (system_manifest_revision > 0),
      map_digest TEXT NOT NULL CHECK (length(map_digest) = 64),
      topology_digest TEXT NOT NULL CHECK (length(topology_digest) = 64),
      coordinate_digest TEXT NOT NULL CHECK (length(coordinate_digest) = 64),
      atom_count ${integer} NOT NULL CHECK (atom_count > 0),
      artifact_evidence_id TEXT NOT NULL UNIQUE
        REFERENCES scientific_evidence(id) ON DELETE RESTRICT,
      operation_id TEXT NOT NULL UNIQUE
        REFERENCES scientific_external_operations(id) ON DELETE RESTRICT,
      operation_receipt_id TEXT NOT NULL UNIQUE
        REFERENCES scientific_operation_receipts(id) ON DELETE RESTRICT,
      request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (id, revision),
      FOREIGN KEY (system_manifest_id, system_manifest_revision)
        REFERENCES scientific_biomolecular_system_manifests(id, revision) ON DELETE RESTRICT,
      UNIQUE (mission_id, system_manifest_id, system_manifest_revision, map_digest)
    );

    CREATE INDEX scientific_biomolecular_material_effects_mission_idx
      ON scientific_biomolecular_material_effects(mission_id, subject_type, subject_id);
    CREATE INDEX scientific_biomolecular_material_artifacts_mission_idx
      ON scientific_biomolecular_material_artifact_claims(mission_id, subject_type, subject_id);
    CREATE INDEX scientific_force_field_stack_revisions_mission_idx
      ON scientific_force_field_stack_revisions(mission_id, created_at);
    CREATE INDEX scientific_atom_map_revisions_system_idx
      ON scientific_atom_map_revisions(mission_id, system_manifest_id, system_manifest_revision);
  `;
}

export const MD_MATERIAL_IDENTITY_SQLITE_MIGRATION = {
  version: MD_MATERIAL_IDENTITY_MIGRATION_VERSION,
  name: MD_MATERIAL_IDENTITY_MIGRATION_NAME,
  sql: `${mdV16GuardSql("INTEGER")}\n${mdV16TablesSql("INTEGER")}`,
};

export const MD_MATERIAL_IDENTITY_POSTGRES_MIGRATION = {
  version: MD_MATERIAL_IDENTITY_MIGRATION_VERSION,
  name: MD_MATERIAL_IDENTITY_MIGRATION_NAME,
  sql: `${mdV16GuardSql("BIGINT")}\n${mdV16TablesSql("BIGINT")}`,
};

export const MD_MIGRATION_VERSION = 17;
export const MD_MIGRATION_NAME = "biomolecular_scientific_decision_authority";

const MD_DECISION_KINDS =
  "'construct','microstate','pose','force_field_stack','membrane_model','protonation'";

const mdV17UnsafeRowCountSql = `
  ${mdV16UnsafeRowCountSql} +
  (SELECT COUNT(*) FROM scientific_biomolecular_decisions) +
  (SELECT COUNT(*) FROM scientific_md_replica_segment_bindings) +
  (SELECT COUNT(*) FROM scientific_biomolecular_manifest_effects) +
  (SELECT COUNT(*) FROM scientific_biomolecular_manifest_artifacts) +
  (SELECT COUNT(*) FROM scientific_md_work_unit_completion_gates) +
  (SELECT COUNT(*) FROM scientific_biomolecular_material_effects) +
  (SELECT COUNT(*) FROM scientific_biomolecular_material_artifact_claims) +
  (SELECT COUNT(*) FROM scientific_force_field_stack_revisions) +
  (SELECT COUNT(*) FROM scientific_force_field_stack_evidence) +
  (SELECT COUNT(*) FROM scientific_atom_map_revisions)
`;

function mdV17GuardSql(integer: string): string {
  return `
    CREATE TEMP TABLE scientific_md_v17_upgrade_guard (
      unsafe_row_count ${integer} NOT NULL CHECK (unsafe_row_count = 0)
    );
    INSERT INTO scientific_md_v17_upgrade_guard (unsafe_row_count)
      ${mdV17UnsafeRowCountSql};
    DROP TABLE scientific_md_v17_upgrade_guard;
  `;
}

const mdV17DecisionTableSql = `
  CREATE TABLE scientific_biomolecular_decisions (
    id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
    decision_kind TEXT NOT NULL CHECK (decision_kind IN (${MD_DECISION_KINDS})),
    review_status TEXT NOT NULL
      CHECK (review_status IN ('proposed','approved','rejected','superseded')),
    decision_digest TEXT NOT NULL CHECK (length(decision_digest) = 64),
    material_digest TEXT NOT NULL CHECK (length(material_digest) = 64),
    approval_ref TEXT REFERENCES scientific_approval_requests(id) ON DELETE RESTRICT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (id, revision),
    UNIQUE (mission_id, decision_digest)
  );
  CREATE INDEX scientific_biomolecular_decisions_mission_idx
    ON scientific_biomolecular_decisions(mission_id, decision_kind, review_status);
`;

const mdV17SqliteSql = `
  ${mdV17GuardSql("INTEGER")}
  DROP TABLE scientific_biomolecular_decisions;
  ${mdV17DecisionTableSql}
`;

const mdV17PostgresSql = `
  ${mdV17GuardSql("BIGINT")}
  ALTER TABLE scientific_biomolecular_decisions
    DROP CONSTRAINT scientific_biomolecular_decisions_decision_kind_check;
  ALTER TABLE scientific_biomolecular_decisions
    ADD CONSTRAINT scientific_biomolecular_decisions_decision_kind_check
    CHECK (decision_kind IN (${MD_DECISION_KINDS}));
`;

export const MD_SQLITE_MIGRATION = {
  version: MD_MIGRATION_VERSION,
  name: MD_MIGRATION_NAME,
  sql: mdV17SqliteSql,
};

export const MD_POSTGRES_MIGRATION = {
  version: MD_MIGRATION_VERSION,
  name: MD_MIGRATION_NAME,
  sql: mdV17PostgresSql,
};

export const MD_MODEL_AUTHORITY_MIGRATION_VERSION = 18;
export const MD_MODEL_AUTHORITY_MIGRATION_NAME = "durable_model_invocation_and_planning_claims";

function mdModelAuthoritySql(integer: string): string {
  return `
    CREATE TABLE IF NOT EXISTS scientific_planning_claims (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      expected_mission_revision ${integer} NOT NULL CHECK (expected_mission_revision > 0),
      parent_plan_id TEXT REFERENCES scientific_plans(id) ON DELETE RESTRICT,
      proposed_next_version ${integer} NOT NULL CHECK (proposed_next_version > 0),
      owner_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','expired','completed','released')),
      released_at TEXT,
      release_reason TEXT,
      payload_json TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS scientific_one_active_planning_claim
      ON scientific_planning_claims(mission_id, expected_mission_revision)
      WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS scientific_model_invocation_intents (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      plan_id TEXT REFERENCES scientific_plans(id) ON DELETE RESTRICT,
      planning_claim_id TEXT REFERENCES scientific_planning_claims(id) ON DELETE RESTRICT,
      role TEXT NOT NULL CHECK (role IN ('planner','critic','diagnostician','assessment_composer')),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      capability_digest TEXT NOT NULL CHECK (length(capability_digest) = 64),
      request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
      context_digest TEXT NOT NULL CHECK (length(context_digest) = 64),
      status TEXT NOT NULL CHECK (status IN ('invoking','observed','unavailable','ambiguous')),
      budget_model_reservation_id TEXT NOT NULL REFERENCES scientific_budget_reservations(id) ON DELETE RESTRICT,
      budget_cost_reservation_id TEXT NOT NULL REFERENCES scientific_budget_reservations(id) ON DELETE RESTRICT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS scientific_model_invocation_intents_mission_idx
      ON scientific_model_invocation_intents(mission_id, created_at, id);
    CREATE INDEX IF NOT EXISTS scientific_model_invocation_intents_claim_idx
      ON scientific_model_invocation_intents(planning_claim_id, created_at);
  `;
}

export const MD_MODEL_AUTHORITY_SQLITE_MIGRATION = {
  version: MD_MODEL_AUTHORITY_MIGRATION_VERSION,
  name: MD_MODEL_AUTHORITY_MIGRATION_NAME,
  sql: mdModelAuthoritySql("INTEGER"),
};

export const MD_MODEL_AUTHORITY_POSTGRES_MIGRATION = {
  version: MD_MODEL_AUTHORITY_MIGRATION_VERSION,
  name: MD_MODEL_AUTHORITY_MIGRATION_NAME,
  sql: mdModelAuthoritySql("BIGINT"),
};

export const MD_SQLITE_MIGRATIONS = [
  MD_BASE_SQLITE_MIGRATION,
  MD_INTEGRITY_SQLITE_MIGRATION,
  MD_EFFECT_AUTHORITY_SQLITE_MIGRATION,
  MD_MATERIAL_IDENTITY_SQLITE_MIGRATION,
  MD_SQLITE_MIGRATION,
  MD_MODEL_AUTHORITY_SQLITE_MIGRATION,
] as const;
export const MD_POSTGRES_MIGRATIONS = [
  MD_BASE_POSTGRES_MIGRATION,
  MD_INTEGRITY_POSTGRES_MIGRATION,
  MD_EFFECT_AUTHORITY_POSTGRES_MIGRATION,
  MD_MATERIAL_IDENTITY_POSTGRES_MIGRATION,
  MD_POSTGRES_MIGRATION,
  MD_MODEL_AUTHORITY_POSTGRES_MIGRATION,
] as const;
