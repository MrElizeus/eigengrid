# Qualification and agent journal recovery captures

`operational-backup.py` creates an outer, private
`eigengrid.operational-backup/v1` directory. Its `database/` child is the existing
strict PostgreSQL/CAS backup v1, unchanged and independently verified. The outer
manifest separately inventories the copied agent journals with SHA-256, sizes,
counts and capture timestamps. No extra journal files are inserted into the
strict database component's manifest.

The online capture is **not atomic across PostgreSQL and journals**. PostgreSQL
uses its own snapshot, then copies immutable published CAS objects and checks all
CAS references found in that dump. Journal files must remain unchanged during
their individual descriptor-bound reads; changing files fail the capture rather
than publish a partial result. Different journal files and PostgreSQL can still
represent different instants. File hashes prove preservation, not scientific
acceptance or a globally consistent execution checkpoint.

The root-only Monster Queen site adapter `qualification-backup.sh` captures:

- DB `eigengrid_qualification` and its verified CAS at
  `/var/lib/eigengrid/head-qualification/artifacts` and the main CAS at
  `/var/lib/eigengrid/head/artifacts`, because the isolated qualification database
  can reference either namespace;
- the real production namespace source `/var/lib/eigengrid/head/agent-sessions`,
  the legacy host directory `/var/lib/eigengrid/agent-sessions`, and
  `/var/lib/eigengrid/head-qualification/agent-sessions`, including scope, journal,
  open-request and any stop/lock records present;
- private bounded inventories: at most 10,000 files and 64 MiB per journal root,
  16 MiB per journal file, and 1,024 directories (including the root) per journal
  root. Symlinks, regular-file source roots, and multiply linked files are rejected.

The production journals in this wrapper are captured beside the **qualification**
database component. They do not form a production checkpoint and must not be used
as a replacement for a production database backup. Production recovery separately
requires a verified `eigengrid` DB/main-CAS snapshot from the existing
`cluster-backup`/`backup-snapshot.py` operation. Record both timestamps explicitly;
those independent captures and the journals are not an atomic set.

Published snapshots live beneath
`/home/cluster/backups/eigengrid-operational-snapshots/`. The adapter backs up this
verified snapshot with encrypted Restic, then encrypts it with the existing
protected offnode key and sends it through the bounded receiver to
`worker-01:/var/backups/eigengrid-operational-secondary/`. It reads the remote
ciphertext back, decrypts into a private temporary directory, and verifies both
the outer inventory and the strict database/CAS component. The worker's storage
must be local rather than NFS; the receiver retains its existing byte and free
space reservations. No backups are automatically deleted by this operation.
The worker copy protects against a head-disk failure; it is not an offsite backup.

Install the Python wrapper and shell adapter into
`/usr/local/lib/eigengrid-deploy/` alongside the existing backup and storage
helpers. Keep the installed files root-owned. Run the adapter as root to create
and verify a capture. Its systemd service and daily timer are provided separately;
activate the timer only after a manual encrypted offnode capture and disposable
restore have passed. No Head or API stop is performed by the adapter.

## Restore without replaying effects

1. Set `umask 077`, then fetch the selected remote encrypted archive and decrypt it
   using the protected key into a new private quarantine directory. Use safe tar extraction; reject
   links and path traversal. Preserve the snapshot directory's private mode.
2. Run `operational-backup.py verify --backup /absolute/quarantine/snapshot`.
   Keep the recovered journals read-only and separate from live agent directories.
3. Create a new, empty PostgreSQL database named `eigengrid_restore_*`. Configure
   its connection only in a protected environment variable, then use the existing
   `production-backup.py verify-restore --backup /absolute/quarantine/snapshot/database
--database-env RESTORE_DATABASE --postgres-os-user postgres`. This checks the
   dump, all restored CAS references and the strict database component. Never
   point this command at the live qualification or production databases.
4. Inspect mission state, external operation IDs, confirmed receipts, journal hash
   chains, original HTTP idempotency keys and current authority. An online capture
   may require canonical reconciliation or may lack enough evidence. Preserve
   pending fences. Do not invent a new key, discard an uncertain intent or retry a
   scientific submission to make restoration appear successful.
5. Do not auto-start recovered sessions or overwrite live journals. Any eventual
   return to service needs an explicitly coordinated checkpoint and the existing
   scoped approval/reconciliation workflow. Retain quarantine evidence for audit.

A coordinated window with all relevant writers quiesced can produce a stronger
checkpoint, but this online operation does not claim one. Such a window must be
agreed with the pilot operator; never stop an active scientific run unexpectedly.

## Retention limitation

This operation does not prune staging, remote encrypted archives, or Restic
history. Each capture is submitted with its own snapshot path, so Restic's default
path grouping does not establish a useful daily retention policy for these
captures. The existing cluster backup retention command must not be assumed to
remove them. Review operational retention explicitly by the `eigengrid-operational`
tag and intended host grouping, inventory the retained remote and local bytes, and
keep the storage reserve guards enabled. Do not delete historical captures during
the pilot merely to make a space check pass.
