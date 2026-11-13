# EigenGrid configuration recovery sidecar

`recovery-sidecar.py` captures an explicit, private root-owned policy into a bounded
quarantine bundle. It is separate from the strict PG/CAS backup format and from
agent journals. Never use it as an atomic database/configuration checkpoint or as
a command to restore over live files.

The reviewed site selection covers only EigenGrid configuration, global model
configuration, TLS/signing keys, opaque HTTP credentials and private client
profiles/state maps, protected submitter launch/journal files, EigenGrid units and
AppArmor rules, small deployment helpers and backup recovery secrets. No other
application directories, home directories, private SSH keys, caches, scientific
engines or runtime binaries are recursively captured. Source paths must belong
to the explicit EigenGrid namespaces accepted by the utility. A root-owned
mode-0600 policy supplies each exact filename, expected owner UID and semantic
role. Changing client state maps and service drop-ins require a fresh inventory;
a static policy must not be assumed to discover newly created files.

Capture limits are 512 files, 16 MiB per file, 32 MiB of payload and 4 MiB of
manifest metadata. Only protected, regular single-link files are copied. Reads
are bound to directory descriptors; the opened file and its directory entry are
checked before and after reading, and a changed file or parent identity fails the
capture. Original UID/GID/mode, parent metadata and POSIX access ACLs are recorded,
while quarantine payloads remain operator-owned mode0600 under mode0700
folders. Recorded permissions are never applied automatically.

The verification operation checks exact membership, SHA-256, stable sizes and
recovery policy. `verify --semantic` additionally checks the production TLS
certificate/key pair, parseability of the signing key and global model
configuration, and each selected actor's client credential and CA against the
recovered server-side files. It also requires exactly one matching protected operator
with the credential digest and the client's authorized project. These are structural/cryptographic checks: no model
provider call, HTTP authentication, service activation, database connection or
scientific submission occurs.

## Encrypted preservation and independent readback

The private site operation is:

1. Capture into a new mode0700 temporary directory and verify it.
2. Encrypt a safe tar archive with the established offnode recovery passphrase.
   Keep persistent head and worker copies encrypted; do not retain plaintext
   staging after verification.
3. Use the existing bounded receiver in a separate directory such as
   `/var/backups/eigengrid-config-secondary/`. Preserve its storage reservations;
   leave additional space for bounded decrypt/extract verification.
4. On the worker, decrypt using its existing root-owned recovery key, without
   consulting a Head key. Extract only regular files/directories into a new
   private quarantine directory, reject links/traversal, then run verification.
5. Retain an encrypted Restic copy and an audit receipt containing counts,
   ciphertext digest, timestamps and checks passed, never secret values. Delete
   both plaintext staging and restore-test quarantine.

The independent worker key and optional private operator escrow must be checked
without printing or replacing them. If existing copies disagree, preserve every
copy and resolve the discrepancy before claiming recoverability. A Head-only
key encrypted inside its own archive is not a recovery bootstrap.

Current site captures are online and have their own timestamp. Pair them explicitly
with independent main and qualification PG/CAS and journal snapshots; files may
represent different instants. Re-inventory and repeat after final service/key
rotation. Restored client states may contain pending requests and cookies: retain
uncertainty fences and require explicit current authorization before any return
to service. Never auto-start restored sessions or replay a submission.

Retain pilot history without automated deletion. Review a later daily/weekly/monthly
policy with a dry-run and storage accounting before pruning. The worker copy is
another disk/node, not an offsite backup. Runtime binaries and scientific engines
must be provisioned separately from verified releases and environment records.
