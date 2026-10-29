#!/usr/bin/env bash
# A temporary database for tests; never accepts an external database address.
set -euo pipefail
[[ "$(id -u)" != 0 ]] || { echo 'Run as an unprivileged user' >&2; exit 1; }
[[ -z "${EIGENGRID_TEST_POSTGRES_URL:-}" ]] || { echo 'Unset external test DSN; this script creates its own database' >&2; exit 1; }
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
test_dir="$(mktemp -d /tmp/eg-pg.XXXXXXXX)"
cleanup() {
  pg_ctl -D "$test_dir/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf -- "$test_dir"
}
trap cleanup EXIT
initdb -D "$test_dir/data" -U eigengrid_test --auth-local=trust --auth-host=trust --no-instructions >/dev/null
test_port="$(python -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
pg_ctl -D "$test_dir/data" -o "-c listen_addresses=127.0.0.1 -c port=$test_port -c unix_socket_directories=$test_dir" -l "$test_dir/postgres.log" -w start >/dev/null
createdb -h 127.0.0.1 -p "$test_port" -U eigengrid_test eigengrid_test
export EIGENGRID_TEST_POSTGRES_URL="postgresql://eigengrid_test@127.0.0.1:$test_port/eigengrid_test"
export EIGENGRID_CI_EXTENDED_TIMEOUTS=1
cd "$root"
bun test --timeout 20000 "$@"
