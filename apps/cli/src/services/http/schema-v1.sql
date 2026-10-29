-- A5/HTTP: apply only through an authorized database migration on a staging
-- or production Head. Never execute from an HTTP request, prompt or CLI JSON.
-- On a restart, a pending reservation is deliberately NOT retried.
CREATE TABLE IF NOT EXISTS eigengrid_a5_http_operations (
  actor_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create','import','approve','compile','start','cancel','agent.open','agent.approve','agent.resume','agent.cancel','agent.reconcile')),
  idempotency_key TEXT NOT NULL,
  operation_id UUID NOT NULL UNIQUE,
  request_digest CHAR(64) NOT NULL,
  expected_revision BIGINT NOT NULL CHECK (expected_revision >= 0),
  request_json JSONB,
  status TEXT NOT NULL CHECK (status IN ('pending','complete')),
  output_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY(actor_id,project_id,operation,idempotency_key),
  CHECK ((status='pending' AND output_json IS NULL AND completed_at IS NULL)
    OR (status='complete' AND output_json IS NOT NULL AND completed_at IS NOT NULL))
);
COMMENT ON TABLE eigengrid_a5_http_operations IS
  'A5 HTTP transport reservation; not a scientific outbox, receipt or Slurm authority';
ALTER TABLE eigengrid_a5_http_operations ADD COLUMN IF NOT EXISTS request_json JSONB;
ALTER TABLE eigengrid_a5_http_operations DROP CONSTRAINT IF EXISTS eigengrid_a5_http_operations_operation_check;
ALTER TABLE eigengrid_a5_http_operations ADD CONSTRAINT eigengrid_a5_http_operations_operation_check
  CHECK(operation IN ('create','import','approve','compile','start','cancel','agent.open','agent.approve','agent.resume','agent.cancel','agent.reconcile'));
CREATE TABLE IF NOT EXISTS eigengrid_a5_http_schema (
  version INTEGER PRIMARY KEY,
  checksum CHAR(64) NOT NULL,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS eigengrid_a5_http_sessions (
  token_digest CHAR(64) PRIMARY KEY,
  csrf_digest CHAR(64) NOT NULL,
  actor_id TEXT NOT NULL,
  config_digest CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS eigengrid_a5_http_login_limits (
  bucket CHAR(64) NOT NULL,
  window_id BIGINT NOT NULL,
  attempts INTEGER NOT NULL,
  PRIMARY KEY(bucket, window_id)
);
CREATE TABLE IF NOT EXISTS eigengrid_a5_http_artifact_grants (
  actor_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  content_digest CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(actor_id,project_id,content_digest)
);
