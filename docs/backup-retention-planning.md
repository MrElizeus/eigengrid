# Backup redundancy and reserve planning

`backup-retention.py` produces a private inventory and a **dry-run redundancy
plan**. It has no apply or deletion command. It is not a complete retention system:
it does not delete old restore points, manage Restic retention, schedule captures,
or reclaim disk space. The existing publishers and timers are unchanged.

By default it protects every copy from the last 14 days and all copies of the three
newest distinct verified restore points in each scope/kind. Outside that window,
it can propose removing redundant copies only when at least two restore-verified
copies of that same point remain in distinct declared failure domains/filesystems.
It evaluates proposals sequentially so two proposed removals cannot rely on each
other as surviving replicas. No proposal reduces a restore point below two verified copies; existing unique
points remain protected. This conservative rule
may produce no candidates at all and does not bound total history growth.

Failure domains are **operator assertions**, not hardware discovery. Different
filesystems, mountpoints or directory names do not prove different disks, hosts or
failure risks. Machine/filesystem identities prevent obvious alias double-counts;
the operator must provide correct physical failure-domain labels. Reclaimable
`st_blocks` is an upper-bound estimate, not a guarantee with reflinks, deduplication
or concurrent filesystem changes.

## Private inventory and exact proof binding

Use directories owned by the operator with mode0700; metadata files are mode0600
and must remain outside Git and public audit artifacts. Inventory reads known
snapshot formats using their existing verifiers. Unknown names, in-progress
captures, symlinks, traversal failures, changing files and unproved ciphertexts
are protected. Directory traversal and entry counts are bounded. No credential
contents are included in inventory output or stdout.

Example commands, executed separately on each storage location:

```sh
python3 scripts/operations/backup-retention.py inventory \
  --directory /private/head/operational \
  --scope qualification --kind operational --failure-domain head-storage \
  --proofs /private/head/proofs --output /private/review/head.json
python3 scripts/operations/backup-retention.py plan \
  --inventory /private/review/head.json --inventory /private/review/worker.json \
  --keep-days 14 --minimum-points 3 \
  --minimum-copies 2 --incoming-bytes 1073741824 \
  --output /private/review/plan.json
```

A matching proof is named `<snapshot-entry-name>.verification.json`, for example
`20260101T000000Z.tar.gpg.verification.json`. Its strict schema is:

```json
{
  "schemaVersion": "eigengrid.backup-retention-proof/v1",
  "scope": "qualification",
  "kind": "operational",
  "snapshot": "20260101T000000Z.tar.gpg",
  "copySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "contentSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "verifiedAt": "2026-11-14T11:00:00Z",
  "restoreVerified": true,
  "recoveryKeyVerified": true
}
```

These are example digests, not a usable proof. A trusted operator must supply the
proof only after actual decrypt/readback and relevant restore/quarantine checks.
`copySha256` binds the exact ciphertext bytes; `contentSha256` identifies the
verified plaintext manifest, enabling comparison with a plaintext snapshot. For
directory entries both digests must equal the verified manifest digest. Scope and
kind must match exactly. Proof time cannot precede snapshot time.

A proof is a trusted manual attestation, not a signature or an automatic inference
from a receipt. This tool does not convert existing heterogeneous receipts, assume
that a Restic copy still exists, discover provider snapshots, or verify decryption
keys itself. A filename, matching timestamp or successful upload is insufficient.
Inventories and proofs older than 24 hours, or timestamps in the future, cannot
support removal proposals. Every actual deletion would require a separate reviewed
operation and fresh verification; this tool intentionally cannot perform it.

## Space and automation limits

The plan reports free space after the explicit incoming-byte estimate against
100 GiB and 20% reserves. Stale capacity observations report no reserve verdict.
This is a projection, not a write reservation. Local backup creation currently
checks available space before capture but does not reserve the complete incoming
PG/CAS copy or temporary decrypt workspace. The bounded worker receiver separately
checks capacity before and during encrypted writes. No failed reserve check should
be worked around by deleting unique or unverified copies.

The repository provides a qualification backup timer, but `recovery-sidecar.py`
is only a capture/verifier utility: no sidecar publisher/timer is installed by
this change. Prior manual encrypted sidecar readbacks do not establish a recurring
schedule. Fresh configuration inventories are needed after service/key rotation;
never assume that a static file list captures new client state maps or drop-ins.
Remote installed state requires a fresh site inspection; this offline review does
not establish it.
