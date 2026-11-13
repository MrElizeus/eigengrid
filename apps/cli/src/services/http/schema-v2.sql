-- Add authenticated material publication commands without changing HTTP v1 bytes.
ALTER TABLE eigengrid_a5_http_operations DROP CONSTRAINT eigengrid_a5_http_operations_operation_check;
ALTER TABLE eigengrid_a5_http_operations ADD CONSTRAINT eigengrid_a5_http_operations_operation_check
  CHECK(operation IN ('create','import','approve','compile','start','cancel','agent.open','agent.approve','agent.resume','agent.cancel','agent.reconcile','material.apply','md.publish-stage'));
