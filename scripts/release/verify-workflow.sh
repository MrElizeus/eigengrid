#!/usr/bin/env bash
# Reproduce the durable MD software boundary with disposable state and fake engines.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
for executable in bun python initdb pg_ctl createdb; do
  command -v "$executable" >/dev/null || { echo "Missing prerequisite: $executable" >&2; exit 1; }
done
runtime="${EIGENGRID_TEST_CONTAINER_RUNTIME:-}"
if [[ -z "$runtime" ]]; then
  if command -v podman >/dev/null; then runtime=podman; else runtime=docker; fi
fi
command -v "$runtime" >/dev/null || { echo "Install rootless Podman or Docker" >&2; exit 1; }
export EIGENGRID_TEST_CONTAINER_RUNTIME="$runtime"
bun run build
bash scripts/release/test-postgres.sh \
  tests/e2e/canonical-md-pg-submitter.test.ts \
  tests/e2e/md-result-collection-pg.test.ts \
  tests/e2e/md-stage-lifecycle-pg.test.ts \
  tests/e2e/md-continuation-pg.test.ts
printf '%s\n' 'PASS: durable MD software workflow; real engine/site/scientific qualification remains separate.'
