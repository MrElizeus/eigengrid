/**
 * Versioned persistence for the durable scientific mission kernel.
 *
 * The two dialects intentionally keep the same table and constraint names. The
 * mission runtime only depends on this relational contract; provider-specific
 * locking and placeholder handling stay inside the database adapters.
 */
export const SCIENTIFIC_MIGRATION_VERSION = 11;
export const SCIENTIFIC_MIGRATION_NAME = "scientific_mission_kernel";

const states = {
  mission:
    "'created','scoping','planning','awaiting_approval','ready','executing','observing','diagnosing','replanning','validating','completed','paused','blocked','failed','cancel_requested','cancelling','cancelled'",
  plan: "'draft','under_review','approved','rejected','superseded'",
  workUnit:
    "'created','ready','awaiting_approval','claimed','executing','observing','succeeded','retryable_failed','failed','blocked','cancel_requested','cancelling','cancelled'",
  approval: "'pending','approved','rejected','expired','superseded'",
  operation:
    "'intent','effect_started','acknowledged','confirmed','failed','ambiguous','abandoned'",
} as const;

function scientificSql(options: {
  real: string;
  boolean: string;
  trueValue: string;
  missionBudgetReference: string;
  missionPlanReference: string;
  operationReceiptReference: string;
  deferredConstraints: string;
}): string {
  const {
    real,
    boolean,
    trueValue,
    missionBudgetReference,
    missionPlanReference,
    operationReceiptReference,
    deferredConstraints,
  } = options;
  return `
    CREATE TABLE IF NOT EXISTS scientific_missions (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision > 0),
      state TEXT NOT NULL CHECK (state IN (${states.mission})),
      budget_id TEXT NOT NULL UNIQUE${missionBudgetReference},
      active_plan_id TEXT${missionPlanReference},
      objective_digest TEXT NOT NULL CHECK (length(objective_digest) = 64),
      payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminal_at TEXT
    );

    CREATE TABLE IF NOT EXISTS scientific_mission_budgets (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL UNIQUE REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK (revision > 0),
      limits_json TEXT NOT NULL,
      consumed_json TEXT NOT NULL,
      payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scientific_skill_resolutions (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      graph_digest TEXT NOT NULL CHECK (length(graph_digest) = 64),
      resolver_version TEXT NOT NULL,
      environment_digest TEXT NOT NULL CHECK (length(environment_digest) = 64),
      payload_json TEXT NOT NULL,
      resolved_at TEXT NOT NULL,
      UNIQUE (mission_id, graph_digest)
    );

    CREATE TABLE IF NOT EXISTS scientific_plans (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL CHECK (version > 0),
      revision INTEGER NOT NULL CHECK (revision > 0),
      status TEXT NOT NULL CHECK (status IN (${states.plan})),
      skill_resolution_id TEXT NOT NULL REFERENCES scientific_skill_resolutions(id) ON DELETE RESTRICT,
      skill_graph_digest TEXT NOT NULL CHECK (length(skill_graph_digest) = 64),
      protocol_digest TEXT NOT NULL CHECK (length(protocol_digest) = 64),
      plan_digest TEXT NOT NULL CHECK (length(plan_digest) = 64),
      parent_plan_id TEXT REFERENCES scientific_plans(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (mission_id, version),
      UNIQUE (mission_id, plan_digest)
    );

    CREATE TABLE IF NOT EXISTS scientific_work_units (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      plan_id TEXT NOT NULL REFERENCES scientific_plans(id) ON DELETE RESTRICT,
      plan_version INTEGER NOT NULL CHECK (plan_version > 0),
      kind TEXT NOT NULL CHECK (kind IN ('structure_validation','optimization','frequency','collection','parsing','validation','assessment','diagnosis')),
      state TEXT NOT NULL CHECK (state IN (${states.workUnit})),
      revision INTEGER NOT NULL CHECK (revision > 0),
      claim_owner TEXT,
      claim_expires_at TEXT,
      job_id TEXT,
      attempt_id TEXT,
      payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((claim_owner IS NULL AND claim_expires_at IS NULL) OR
             (claim_owner IS NOT NULL AND claim_expires_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS scientific_work_unit_dependencies (
      work_unit_id TEXT NOT NULL REFERENCES scientific_work_units(id) ON DELETE RESTRICT,
      depends_on_work_unit_id TEXT NOT NULL REFERENCES scientific_work_units(id) ON DELETE RESTRICT,
      PRIMARY KEY (work_unit_id, depends_on_work_unit_id),
      CHECK (work_unit_id <> depends_on_work_unit_id)
    );

    CREATE TABLE IF NOT EXISTS scientific_work_unit_claims (
      id TEXT PRIMARY KEY,
      work_unit_id TEXT NOT NULL REFERENCES scientific_work_units(id) ON DELETE RESTRICT,
      owner_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      released_at TEXT,
      release_reason TEXT,
      active ${boolean} NOT NULL DEFAULT ${trueValue}
    );

    CREATE UNIQUE INDEX IF NOT EXISTS scientific_one_active_work_unit_claim
      ON scientific_work_unit_claims(work_unit_id) WHERE active = ${trueValue};

    CREATE TABLE IF NOT EXISTS scientific_checkpoints (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      plan_id TEXT NOT NULL REFERENCES scientific_plans(id) ON DELETE RESTRICT,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      context_digest TEXT NOT NULL CHECK (length(context_digest) = 64),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (mission_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS scientific_decisions (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      plan_id TEXT NOT NULL REFERENCES scientific_plans(id) ON DELETE RESTRICT,
      category TEXT NOT NULL,
      risk_class INTEGER NOT NULL CHECK (risk_class BETWEEN 0 AND 4),
      requires_approval ${boolean} NOT NULL,
      payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scientific_approval_requests (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      subject_type TEXT NOT NULL CHECK (subject_type IN ('plan','decision','operation','result')),
      subject_id TEXT NOT NULL,
      subject_version INTEGER NOT NULL CHECK (subject_version > 0),
      subject_revision INTEGER NOT NULL CHECK (subject_revision > 0),
      state TEXT NOT NULL CHECK (state IN (${states.approval})),
      requested_from_role TEXT NOT NULL,
      payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
      policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
      payload_json TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS scientific_approval_responses (
      id TEXT PRIMARY KEY,
      approval_request_id TEXT NOT NULL UNIQUE REFERENCES scientific_approval_requests(id) ON DELETE RESTRICT,
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

    CREATE TABLE IF NOT EXISTS scientific_budget_reservations (
      id TEXT PRIMARY KEY,
      budget_id TEXT NOT NULL REFERENCES scientific_mission_budgets(id) ON DELETE RESTRICT,
      work_unit_id TEXT REFERENCES scientific_work_units(id) ON DELETE RESTRICT,
      operation_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('external_operation','model_tokens','wall_time_seconds','cost')),
      amount ${real} NOT NULL CHECK (amount >= 0),
      state TEXT NOT NULL CHECK (state IN ('reserved','consumed','released','ambiguous')),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scientific_external_operations (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      work_unit_id TEXT NOT NULL REFERENCES scientific_work_units(id) ON DELETE RESTRICT,
      idempotency_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('local_execution','collect','parse','cancel','model_invocation')),
      state TEXT NOT NULL CHECK (state IN (${states.operation})),
      request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
      policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
      budget_reservation_id TEXT REFERENCES scientific_budget_reservations(id) ON DELETE RESTRICT,
      receipt_id TEXT${operationReceiptReference},
      revision INTEGER NOT NULL CHECK (revision > 0),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scientific_operation_receipts (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL UNIQUE REFERENCES scientific_external_operations(id) ON DELETE RESTRICT,
      request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
      status TEXT NOT NULL CHECK (status IN ('confirmed','failed','ambiguous')),
      detail_digest TEXT NOT NULL CHECK (length(detail_digest) = 64),
      payload_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scientific_evidence (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      work_unit_id TEXT REFERENCES scientific_work_units(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL CHECK (kind IN ('objective','structure','rendered_input','environment','operation_receipt','artifact','parser_output','skill_fragment','human_review')),
      uri TEXT NOT NULL,
      content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
      immutable ${boolean} NOT NULL,
      source_id TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (mission_id, kind, uri, content_digest)
    );

    CREATE TABLE IF NOT EXISTS scientific_observations (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      work_unit_id TEXT NOT NULL REFERENCES scientific_work_units(id) ON DELETE RESTRICT,
      type TEXT NOT NULL CHECK (type IN ('structure_validity','normal_termination','electronic_convergence','geometry_convergence','imaginary_frequencies','energy','failure_signature','artifact_integrity')),
      payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
      payload_json TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scientific_validation_results (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      work_unit_id TEXT NOT NULL REFERENCES scientific_work_units(id) ON DELETE RESTRICT,
      criterion_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('passed','failed','inconclusive','not_applicable')),
      payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (work_unit_id, criterion_id)
    );

    CREATE TABLE IF NOT EXISTS scientific_model_invocations (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      plan_id TEXT REFERENCES scientific_plans(id) ON DELETE RESTRICT,
      role TEXT NOT NULL CHECK (role IN ('planner','critic','diagnostician','assessment_composer')),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('succeeded','failed','unavailable','invalid_output')),
      request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
      response_digest TEXT CHECK (response_digest IS NULL OR length(response_digest) = 64),
      context_digest TEXT NOT NULL CHECK (length(context_digest) = 64),
      payload_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scientific_assessments (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK (revision > 0),
      status TEXT NOT NULL CHECK (status IN ('supported','partially_supported','inconclusive','refuted')),
      payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (mission_id, revision)
    );

    CREATE TABLE IF NOT EXISTS scientific_work_unit_inputs (
      work_unit_id TEXT NOT NULL REFERENCES scientific_work_units(id) ON DELETE RESTRICT,
      evidence_id TEXT NOT NULL REFERENCES scientific_evidence(id) ON DELETE RESTRICT,
      PRIMARY KEY (work_unit_id, evidence_id)
    );

    CREATE TABLE IF NOT EXISTS scientific_checkpoint_evidence (
      checkpoint_id TEXT NOT NULL REFERENCES scientific_checkpoints(id) ON DELETE RESTRICT,
      evidence_id TEXT NOT NULL REFERENCES scientific_evidence(id) ON DELETE RESTRICT,
      PRIMARY KEY (checkpoint_id, evidence_id)
    );

    CREATE TABLE IF NOT EXISTS scientific_decision_evidence (
      decision_id TEXT NOT NULL REFERENCES scientific_decisions(id) ON DELETE RESTRICT,
      evidence_id TEXT NOT NULL REFERENCES scientific_evidence(id) ON DELETE RESTRICT,
      PRIMARY KEY (decision_id, evidence_id)
    );

    CREATE TABLE IF NOT EXISTS scientific_observation_evidence (
      observation_id TEXT NOT NULL REFERENCES scientific_observations(id) ON DELETE RESTRICT,
      evidence_id TEXT NOT NULL REFERENCES scientific_evidence(id) ON DELETE RESTRICT,
      PRIMARY KEY (observation_id, evidence_id)
    );

    CREATE TABLE IF NOT EXISTS scientific_validation_observations (
      validation_id TEXT NOT NULL REFERENCES scientific_validation_results(id) ON DELETE RESTRICT,
      observation_id TEXT NOT NULL REFERENCES scientific_observations(id) ON DELETE RESTRICT,
      PRIMARY KEY (validation_id, observation_id)
    );

    CREATE TABLE IF NOT EXISTS scientific_validation_evidence (
      validation_id TEXT NOT NULL REFERENCES scientific_validation_results(id) ON DELETE RESTRICT,
      evidence_id TEXT NOT NULL REFERENCES scientific_evidence(id) ON DELETE RESTRICT,
      PRIMARY KEY (validation_id, evidence_id)
    );

    CREATE TABLE IF NOT EXISTS scientific_assessment_decisions (
      assessment_id TEXT NOT NULL REFERENCES scientific_assessments(id) ON DELETE RESTRICT,
      decision_id TEXT NOT NULL REFERENCES scientific_decisions(id) ON DELETE RESTRICT,
      PRIMARY KEY (assessment_id, decision_id)
    );

    CREATE TABLE IF NOT EXISTS scientific_assessment_evidence (
      assessment_id TEXT NOT NULL REFERENCES scientific_assessments(id) ON DELETE RESTRICT,
      evidence_id TEXT NOT NULL REFERENCES scientific_evidence(id) ON DELETE RESTRICT,
      PRIMARY KEY (assessment_id, evidence_id)
    );

    CREATE TABLE IF NOT EXISTS scientific_assessment_validations (
      assessment_id TEXT NOT NULL REFERENCES scientific_assessments(id) ON DELETE RESTRICT,
      validation_id TEXT NOT NULL REFERENCES scientific_validation_results(id) ON DELETE RESTRICT,
      PRIMARY KEY (assessment_id, validation_id)
    );

    CREATE TABLE IF NOT EXISTS scientific_critic_findings (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      plan_id TEXT NOT NULL REFERENCES scientific_plans(id) ON DELETE RESTRICT,
      severity TEXT NOT NULL CHECK (severity IN ('info','warning','error','blocking')),
      code TEXT NOT NULL,
      payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scientific_mission_transitions (
      mission_id TEXT NOT NULL REFERENCES scientific_missions(id) ON DELETE RESTRICT,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      from_state TEXT,
      to_state TEXT NOT NULL CHECK (to_state IN (${states.mission})),
      from_revision INTEGER NOT NULL CHECK (from_revision >= 0),
      to_revision INTEGER NOT NULL CHECK (to_revision > 0),
      reason TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      PRIMARY KEY (mission_id, sequence),
      CHECK (to_revision = from_revision + 1)
    );

    CREATE INDEX IF NOT EXISTS scientific_missions_state_idx
      ON scientific_missions(state, updated_at);
    CREATE INDEX IF NOT EXISTS scientific_work_units_runnable_idx
      ON scientific_work_units(mission_id, state, created_at);
    CREATE INDEX IF NOT EXISTS scientific_operations_reconcile_idx
      ON scientific_external_operations(mission_id, state, updated_at);
    CREATE INDEX IF NOT EXISTS scientific_evidence_mission_idx
      ON scientific_evidence(mission_id, created_at);

    ${deferredConstraints}
  `;
}

export const SCIENTIFIC_SQLITE_MIGRATION = {
  version: SCIENTIFIC_MIGRATION_VERSION,
  name: SCIENTIFIC_MIGRATION_NAME,
  sql: scientificSql({
    real: "REAL",
    boolean: "INTEGER",
    trueValue: "1",
    missionBudgetReference:
      " REFERENCES scientific_mission_budgets(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
    missionPlanReference:
      " REFERENCES scientific_plans(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
    operationReceiptReference:
      " REFERENCES scientific_operation_receipts(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
    deferredConstraints: "",
  }),
};

export const SCIENTIFIC_POSTGRES_MIGRATION = {
  version: SCIENTIFIC_MIGRATION_VERSION,
  name: SCIENTIFIC_MIGRATION_NAME,
  sql: scientificSql({
    real: "DOUBLE PRECISION",
    boolean: "BOOLEAN",
    trueValue: "TRUE",
    missionBudgetReference: "",
    missionPlanReference: "",
    operationReceiptReference: "",
    deferredConstraints: `
      ALTER TABLE scientific_missions
        ADD CONSTRAINT scientific_missions_budget_fk
        FOREIGN KEY (budget_id) REFERENCES scientific_mission_budgets(id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
      ALTER TABLE scientific_missions
        ADD CONSTRAINT scientific_missions_active_plan_fk
        FOREIGN KEY (active_plan_id) REFERENCES scientific_plans(id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
      ALTER TABLE scientific_external_operations
        ADD CONSTRAINT scientific_operations_receipt_fk
        FOREIGN KEY (receipt_id) REFERENCES scientific_operation_receipts(id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
    `,
  }),
};
