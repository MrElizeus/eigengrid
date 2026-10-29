// Additive migration. Historical intents are deliberately NOT backfilled:
// the absence of a dispatch record is not evidence that no external effect ran.
export const OPERATION_OUTBOX_MIGRATION_VERSION = 19;
export const OPERATION_OUTBOX_MIGRATION_NAME = "add_atomic_operation_outbox_and_admissions";

const tables = `
  CREATE TABLE scientific_operation_outbox (
    operation_id TEXT PRIMARY KEY REFERENCES scientific_external_operations(id) ON DELETE RESTRICT,
    mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
    work_unit_id TEXT NOT NULL REFERENCES scientific_work_units(id) ON DELETE RESTRICT,
    request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
    envelope_digest TEXT NOT NULL CHECK (length(envelope_digest) = 64),
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX scientific_operation_outbox_mission_order
    ON scientific_operation_outbox(mission_id, created_at, operation_id);

  CREATE TABLE scientific_effect_admissions (
    operation_id TEXT PRIMARY KEY REFERENCES scientific_operation_outbox(operation_id) ON DELETE RESTRICT,
    work_unit_id TEXT NOT NULL REFERENCES scientific_work_units(id) ON DELETE RESTRICT,
    claim_id TEXT NOT NULL REFERENCES scientific_work_unit_claims(id) ON DELETE RESTRICT,
    fencing_generation INTEGER NOT NULL CHECK (fencing_generation > 0),
    approval_id TEXT NOT NULL REFERENCES scientific_approval_requests(id) ON DELETE RESTRICT,
    approval_response_id TEXT NOT NULL REFERENCES scientific_approval_responses(id) ON DELETE RESTRICT,
    policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
    admission_digest TEXT NOT NULL CHECK (length(admission_digest) = 64),
    payload_json TEXT NOT NULL,
    admitted_at TEXT NOT NULL
  );
`;

export const OPERATION_OUTBOX_SQLITE_MIGRATION = {
  version: OPERATION_OUTBOX_MIGRATION_VERSION,
  name: OPERATION_OUTBOX_MIGRATION_NAME,
  sql: tables,
};

export const OPERATION_OUTBOX_POSTGRES_MIGRATION = {
  version: OPERATION_OUTBOX_MIGRATION_VERSION,
  name: OPERATION_OUTBOX_MIGRATION_NAME,
  sql: `${tables}
    CREATE FUNCTION scientific_reject_effect_history_mutation()
    RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS '
    BEGIN
      RAISE EXCEPTION ''Scientific effect history is append-only'' USING ERRCODE = ''55000'';
    END;';
    CREATE TRIGGER scientific_operation_outbox_append_only
      BEFORE UPDATE OR DELETE OR TRUNCATE ON scientific_operation_outbox
      FOR EACH STATEMENT EXECUTE FUNCTION scientific_reject_effect_history_mutation();
    CREATE TRIGGER scientific_effect_admissions_append_only
      BEFORE UPDATE OR DELETE OR TRUNCATE ON scientific_effect_admissions
      FOR EACH STATEMENT EXECUTE FUNCTION scientific_reject_effect_history_mutation();
  `,
};
