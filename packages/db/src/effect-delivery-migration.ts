// A delivery is immutable transport material for an existing admission, NOT a
// second execution lifecycle. No historical mission/operation is backfilled.
export const EFFECT_DELIVERY_MIGRATION_VERSION = 20;
export const EFFECT_DELIVERY_MIGRATION_NAME =
  "freeze_scientific_effect_deliveries_and_project_binding";
const tables = `
  CREATE TABLE scientific_mission_projects (
    mission_id TEXT PRIMARY KEY REFERENCES scientific_missions(id) ON DELETE RESTRICT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    association_digest TEXT NOT NULL CHECK (length(association_digest) = 64),
    payload_json TEXT NOT NULL CHECK (length(payload_json) BETWEEN 2 AND 8192),
    created_at TEXT NOT NULL
  );
  CREATE INDEX scientific_mission_projects_owner ON scientific_mission_projects(owner_user_id, project_id);
  CREATE TABLE scientific_effect_deliveries (
    operation_id TEXT PRIMARY KEY REFERENCES scientific_effect_admissions(operation_id) ON DELETE RESTRICT,
    mission_id TEXT NOT NULL REFERENCES scientific_mission_projects(mission_id) ON DELETE RESTRICT,
    work_unit_id TEXT NOT NULL REFERENCES scientific_work_units(id) ON DELETE RESTRICT,
    admission_digest TEXT NOT NULL CHECK (length(admission_digest) = 64),
    request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
    binding_digest TEXT NOT NULL CHECK (length(binding_digest) = 64),
    body_digest TEXT NOT NULL CHECK (length(body_digest) = 64),
    delivery_digest TEXT NOT NULL CHECK (length(delivery_digest) = 64),
    payload_json TEXT NOT NULL CHECK (length(payload_json) BETWEEN 2 AND 1048576),
    created_at TEXT NOT NULL
  );
`;
export const EFFECT_DELIVERY_SQLITE_MIGRATION = {
  version: EFFECT_DELIVERY_MIGRATION_VERSION,
  name: EFFECT_DELIVERY_MIGRATION_NAME,
  sql: tables,
};
export const EFFECT_DELIVERY_POSTGRES_MIGRATION = {
  version: EFFECT_DELIVERY_MIGRATION_VERSION,
  name: EFFECT_DELIVERY_MIGRATION_NAME,
  sql: `${tables}
    CREATE TRIGGER scientific_mission_projects_append_only
      BEFORE UPDATE OR DELETE OR TRUNCATE ON scientific_mission_projects
      FOR EACH STATEMENT EXECUTE FUNCTION scientific_reject_effect_history_mutation();
    CREATE TRIGGER scientific_effect_deliveries_append_only
      BEFORE UPDATE OR DELETE OR TRUNCATE ON scientific_effect_deliveries
      FOR EACH STATEMENT EXECUTE FUNCTION scientific_reject_effect_history_mutation();
  `,
};
