#!/usr/bin/env bash
# Run only against an explicitly provisioned dedicated NFS scratch directory.
# No mounting, privilege escalation, external services or scientific engines.
set -euo pipefail
if [[ $# -ne 1 ]]; then
  printf 'Usage: %s /absolute/private/nfs-scratch\n' "$0" >&2
  exit 2
fi
root=$(realpath -e -- "$1")
if [[ "$1" != "$root" || ! -d "$root" || -L "$1" ]]; then
  printf 'Expected an existing canonical directory.\n' >&2
  exit 2
fi
if [[ "$(stat -f -c %t -- "$root")" != 6969 ]]; then
  printf 'Refusing: scratch is not an NFS filesystem.\n' >&2
  exit 2
fi
if [[ "$(stat -c %u:%a -- "$root")" != "$(id -u):700" ]]; then
  printf 'Refusing: scratch must be owned by the current user with mode 0700.\n' >&2
  exit 2
fi
if [[ -n "$(find "$root" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  printf 'Refusing: use an empty dedicated NFS scratch directory.\n' >&2
  exit 2
fi
work=$(mktemp -d -- "$root/eigengrid-nfs-test.XXXXXXXX")
cleanup() {
  if ! rmdir -- "$work" 2>/dev/null; then
    printf 'Test scratch remains for inspection: %s\n' "$work" >&2
  fi
}
trap cleanup EXIT
export TMPDIR="$work" EIGENGRID_NFS_INTEGRATION=1
bun test tests/integration/nfs/amber-spool.nfs.test.ts
