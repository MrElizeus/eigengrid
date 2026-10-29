/** Immutable pre-admission bundle locator. No legacy WorkUnit is backfilled. */
export const MD_PREPARATION_MIGRATION_VERSION = 21;
export const MD_PREPARATION_MIGRATION_NAME = "freeze_md_preparation_publications";

const tables = `
  CREATE TABLE scientific_md_preparation_publications (
    work_unit_id TEXT PRIMARY KEY REFERENCES scientific_work_units(id) ON DELETE RESTRICT,
    mission_id TEXT NOT NULL REFERENCES scientific_mission_projects(mission_id) ON DELETE RESTRICT,
    plan_id TEXT NOT NULL REFERENCES scientific_plans(id) ON DELETE RESTRICT,
    plan_version INTEGER NOT NULL CHECK (plan_version > 0),
    plan_revision INTEGER NOT NULL CHECK (plan_revision > 0),
    approval_ref TEXT NOT NULL REFERENCES scientific_approval_requests(id) ON DELETE RESTRICT,
    binding_digest TEXT NOT NULL CHECK (length(binding_digest) = 64),
    request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
    bundle_digest TEXT NOT NULL CHECK (length(bundle_digest) = 64),
    publication_digest TEXT NOT NULL CHECK (length(publication_digest) = 64),
    payload_json TEXT NOT NULL CHECK (length(payload_json) BETWEEN 2 AND 8388608),
    created_at TEXT NOT NULL
  );
  CREATE INDEX scientific_md_preparation_publications_mission
    ON scientific_md_preparation_publications(mission_id, plan_id);
`;

export const MD_PREPARATION_SQLITE_MIGRATION = {
  version: MD_PREPARATION_MIGRATION_VERSION,
  name: MD_PREPARATION_MIGRATION_NAME,
  // SQLite is a compatibility projection only; publication admission is PostgreSQL-only.
  sql: tables,
};

export const MD_PREPARATION_POSTGRES_MIGRATION = {
  version: MD_PREPARATION_MIGRATION_VERSION,
  name: MD_PREPARATION_MIGRATION_NAME,
  sql: `${tables}
    CREATE TRIGGER scientific_md_preparation_publications_append_only
      BEFORE UPDATE OR DELETE OR TRUNCATE ON scientific_md_preparation_publications
      FOR EACH STATEMENT EXECUTE FUNCTION scientific_reject_effect_history_mutation();
  `,
};
