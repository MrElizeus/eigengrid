# Operation and recovery

Start with the [installation and workflow guide](getting-started.md) to choose between
local jobs and durable missions and reproduce the isolated recovery workflow.

## Local project

`eigengrid init --role head --no-gen-key` creates project-local configuration. Inspection,
schema rendering and local SQLite jobs are separate from protected multiuser missions.
Use `eigengrid --help` and each subcommand's `--help` for exact accepted options.

## Protected missions

Mission CLI/TUI and the HTTP listener share `MissionApplication`. Provision
`/etc/eigengrid/mission-client.json` as root-owned configuration using the schema printed by
`eigengrid mission schema client-config` (`MissionClientConfigSchema` in `apps/cli/src/services/mission-local-authority.ts`).
It defines the database, artifact root, authorized kernel UIDs/actors/roles, compiler
policy, environment and optional HTTP configuration. Request JSON cannot override them.
Provision a separate migration role and restricted runtime role; never use test DSNs
for production or silently migrate an existing database during application startup.

Obtain versioned request shapes from the executable:

```bash
eigengrid mission schema create
eigengrid mission schema import
eigengrid mission schema approve
eigengrid mission schema compile
eigengrid mission schema start
eigengrid mission schema cancel
```

Submit reviewed request files with `eigengrid mission <action> <request-file>`.
Start admits work for the separately provisioned persistent Head; it does not run MD
inside the CLI process. `eigengrid-head --help`, `eigengrid-amber-runner --help` and
`eigengrid-submit-backend --help` expose each role's configuration contract. The
submitter additionally requires protected site identity, signing verification,
exact executable/library digests and OS isolation. No default site profile is supplied.

## HTTP

`eigengrid serve` binds loopback only. Configure a TLS reverse proxy for the exact
protected HTTPS origin, an authorized service UID, HTTP schema and opaque credentials.
`eigengrid serve credential` generates a credential and its provisioning digest; keep
only the digest in protected configuration. `eigengrid serve --help` describes explicit
schema setup. Session revocation, CSRF, project access and idempotency are enforced in
the application; a reverse proxy is not an authorization substitute.

Configure the proxy to rate-limit unauthenticated login requests by the actual
client address before forwarding them to loopback. The application limits session
issuance to ten logins per provisioned credential per ten-minute window. Invalid
credentials never reserve database quota, and users sharing a proxy do not share
a login bucket. Forwarded headers are not trusted as client identity by the API;
the proxy must overwrite them and derive its own rate-limit key from a trusted peer.

Version 1.0.0 serves the `/api/v1` backend API only. The web interface is deferred;
there are no embedded browser assets or `eigengrid web` command in this release.

## Failure handling

Preserve journals, database records, CAS objects and returned engine bytes. Inspect the
canonical operation before retrying. A timeout or lost acknowledgement does not prove an
effect failed. Reconciliation must establish submission/accounting identity, output
integrity and current policy. Unknown effects remain fenced until resolved.

Back up the database and content-addressed artifacts consistently. Rehearse restoration
on disposable infrastructure and validate lineage before reopening dispatch. Application
installation is not a backup, restore, high-availability or production-site certification.

## Distribution layout

The locked Zod 3.25.76 dependency carries a tracked Bun patch for
CVE-2023-54404: constrained collections reject oversized input before walking
elements. This retains the v3 schema and digest contracts while backporting the
size gate from the upstream correction. `bun install --frozen-lockfile` applies
the patch; CI runs its synchronous/asynchronous ESM/CommonJS regressions before
allowing this specific advisory exception. Do not install dependencies using a
tool that ignores Bun patches. A future Zod major upgrade still requires schema
and digest compatibility validation; unconstrained collections still require
caller-imposed input bounds.

Keep `bin/` beside `share/eigengrid/scientific-skills`. The executable resolves the corpus
relative to itself, independent of the working directory. A deliberately configured
`EIGENGRID_SCIENTIFIC_SKILLS_ROOT` overrides that location and is validated when loaded.
Use `EIGENGRID_PYTHON` to select the environment containing the installed scientific wheel.
Providers and scientific engines are external, optional components with separate credentials.

## Supported scheduler contract

The accounting adapter supports Slurm 23.11.x with data_parser/v0.0.40 and
Slurm 26.05.x with explicitly selected data_parser/v0.0.45. Terminal observations
require matching text/JSON allocation and step identities, states and exit codes.
The 26.05 adapter retains the full exit byte; the 23.11 adapter corroborates its
historical text truncation. Other release lines fail closed. Live 26.05.5 fixtures
cover successful/failed jobs, exit 137, cancellation and timeout; they do not
establish molecular scientific acceptance or OOM qualification.

## Production dispatch admission

The default service remains in standby until the site's complete submission,
accounting, result collection, restart recovery and cancellation paths have passed.
An administrator can then provision canonical, root-owned JSON for
`ProductionDispatchConfigSchema` in `apps/cli/src/services/production-dispatch.ts`:

```json
{
  "schemaVersion": "eigengrid.production-dispatch/v1",
  "releaseCommit": "<exact installed 40-character commit>",
  "policyDigest": "<reviewed MD compiler policy digest>",
  "slurmVersion": "26.05.5",
  "mdSiteAuthority": "/etc/eigengrid/md-authority.json",
  "mdArtifactRoot": "/var/lib/eigengrid/head/artifacts",
  "mdPostprocessing": "/etc/eigengrid/md-postprocessing.json",
  "qualificationReport": "/etc/eigengrid/qualification.json",
  "qualificationSha256": "<SHA-256 of the canonical qualification JSON>"
}
```

The qualification report uses `eigengrid.production-qualification/v2` and binds the
release, Slurm version, policy digest, artifact root and the exact set of protected
site configuration files by canonical JSON SHA-256. Include the Head authority,
postprocessing configuration, each submitter service, policy and site profile, and
each referenced result-publication configuration. The site profiles bind the runner,
engine and environment digests. Record fixture digests, reviewer and UTC review time;
for each of `submission`, `accounting`, `resultCollection`, `restartRecovery` and
`cancellation`, record a concrete observation and SHA-256 digests of retained raw
evidence. The report identifies evidence; admission does not independently retrieve or
verify the raw evidence, so the reviewer must inspect and preserve it. Never mark an
unperformed site check as passed or substitute unit tests for the installed end-to-end
path. Version 1 reports are rejected and must be requalified.

Start `eigengrid-head --production-config /etc/eigengrid/dispatch.json` after
adapting the service's filesystem and AppArmor access to the protected configuration,
signing key, per-UID submitter sockets, publication roots and postprocessing Python.
First run the same confined configuration with `--health`. It validates release
identity, qualification, private artifact storage, the compiler/environment profile,
signing authority and admitted project memberships before reporting readiness.
The MD publication, execution and postprocessing route retains exact scientific
approvals, kernel identities, durable effect claims and per-mission budgets.

Standby is still available with `--dispatch-disabled`. A new software commit needs
a matching reviewed admission report; the previous release's report cannot silently
enable a different binary. Keep the previous binary, configuration, policies and
database backup together for rollback. The release installer preserves standby and
does not automatically widen an existing site's execution policy.

## Production diagnostics

`eigengrid doctor --production --json` inspects configuration file metadata and
systemd state without loading database credentials or changing services. It bypasses
project-local configuration. `absent` and `inaccessible` are distinct: run under the
appropriate authorized identity if permissions prevent inspection. `serviceObservable`
is false if systemctl is unavailable or fails. Raw service command lines are not printed.

Readiness is false for observed blocking conditions (standby, inactive service or
missing/invalid configuration) and null when execution readiness remains unverified.
The command exits 1 unless readiness has been positively verified; this presence check
never certifies execution. Run the protected Head's `--health` under its actual service
identity and confinement to evaluate configured execution dependencies.

## PostgreSQL and artifact backups

`scripts/operations/production-backup.py` creates a PostgreSQL custom-format dump,
then copies and verifies published immutable CAS objects. It requires every CAS reference
found in the frozen dump to exist in the backup. Coordinate retention so objects are not
removed while a backup runs. The command does not back up engine installations, protected
site configuration or arbitrary source inputs outside the specified CAS roots; preserve
those separately. Output is private and published only after verification.

The database connection is read from the named environment variable and is omitted from
arguments, manifests and diagnostics. With local peer authentication, an authorized root
operator can use `--postgres-os-user postgres`: only database subprocesses change identity;
the main process retains restricted access to artifacts. For example, with DATABASE_URL
already provisioned in a protected environment:

```bash
python3 scripts/operations/production-backup.py create \
  --database-env DATABASE_URL --postgres-os-user postgres \
  --artifact-root /var/lib/eigengrid/head/artifacts \
  --output /data/backups/new-private-snapshot
python3 scripts/operations/production-backup.py verify \
  --backup /data/backups/new-private-snapshot
```

`verify` checks hashes, dump readability and referenced objects without restoring.
For a real restoration rehearsal, provision a separate empty verification database named
`eigengrid_restore_<suffix>` and put its connection in a separate environment variable:

```bash
python3 scripts/operations/production-backup.py verify-restore \
  --backup /data/backups/new-private-snapshot \
  --database-env RESTORE_DATABASE_URL --postgres-os-user postgres
```

Restore refuses other names and nonempty databases, uses one transaction and never uses
`--clean`. Inspect recovered mission/provenance records and artifacts after restoring.
A copy on the same physical disk provides recovery from logical mistakes but does not
provide off-site or disk-failure protection. Schedule encrypted transfer to independently
stored media and test that copy's recovery. The script does not configure transfer,
retention, timers or credentials automatically.

`scripts/operations/receive_backup.py` can receive an encrypted stream into an
existing private directory on another node. Require a conservative `--max-bytes`
bound for the entire incoming archive. The receiver reserves capacity for that
bound before writing, rechecks available space during transfer and retains at least
100 GiB and 20% free by default. It rejects oversized or empty streams and existing
snapshot names, publishes atomically, and does not delete historical backups.
Receivers serialize their capacity checks with a directory lock. Other writers on
the filesystem still require site monitoring or quotas; this check cannot reserve
space against unrelated processes. After an uncertain transfer, inspect the existing
destination and verify it before any retry; never overwrite it to hide the failure.
Its receipt proves storage only: the sender must still retrieve, decrypt and verify
the backup before declaring success. Provision authenticated transport and a physical
destination independent of the source separately.

## Authenticated material publication API

HTTP schema version 2 adds these mission-scoped authenticated commands:

- `POST /api/v1/projects/{projectId}/missions/{missionId}/materials` accepts an
  `AmberMaterialRequestSchema` request, including its explicit material action.
- `POST /api/v1/projects/{projectId}/missions/{missionId}/md-stage-publications`
  accepts an `AmberMdPreparationRequestSchema` request for an approved stage.

Both use the standard JSON envelope `{ "expectedRevision": 1, "request": ... }`,
exact origin, session cookie, session-bound `X-CSRF-Token`, and an `Idempotency-Key`.
Project and mission in the body must match the path. The existing application
checks scientific roles, exact approvals, durable work, material digests and protected
publication authority; HTTP does not grant direct filesystem or scheduler access.
Material preparation and MD-stage publication remain distinct operations from dispatch.
A cached response still requires current session and mission access.

Apply the explicit HTTP schema upgrade through the protected admin migration command
before starting the new listener. Version 1 SQL and its checksum remain unchanged;
version 2 has its own checksum and expands only the allowed durable HTTP operation
identities. Reapplying the upgrade validates history and preserves completed and pending
requests. Runtime startup validates both installed schema versions and performs no DDL.
The main scientific database migration sequence is unchanged by this HTTP-only upgrade.

An acknowledgement lost after material publication leaves its HTTP intent pending.
Use `POST /api/v1/projects/{projectId}/missions/{missionId}/operations/{operationId}/reconcile`
with the original HTTP operation UUID, current session and CSRF protection. For a material
execute request only, the server can finalize the exact already-confirmed publication
projection after verifying the original owner, approval, current policy, request and receipt.
This bounded recovery creates no new intent and submits no engine or chemistry work. It
then records an explicitly labeled canonical recovery observation under the original key;
concurrent recovery and subsequent replay use that same durable record.

Unconfirmed/ambiguous effects, mismatched policy or receipt, other material actions, and
MD-stage publication remain fenced unless
another complete canonical proof is implemented. Never repeat a pending operation under
a fresh key merely to bypass its uncertainty fence. Recovery does not establish scientific
acceptance or substitute for independent scientific review.

### Private HTTPS agent sessions

The CLI and TUI can use the protected HTTP service without PostgreSQL peer access.
Place a current-user-owned mode-0600 file at `~/.eigengrid/mission-http.json`, inside
an owned mode-0700 directory. Symlink ancestors and peer-writable ancestors are
rejected. Its strict fields are `schemaVersion: "eigengrid.mission-http-client/v1"`,
`origin` (an exact HTTPS origin), `caCertificate` (trusted PEM certificate),
`credential` (the provisioned opaque HTTP credential), `actorId`, `projectId`, and
`missionId`. Provision credentials through the site's protected administrative
process; never paste them into an agent prompt or journal. TLS verification is
mandatory. There is no automatic local fallback when a present configuration is
invalid. With no configuration, the existing local service mode remains available.

`agent-session` commands and TUI `/session` commands share this transport. A client
can only operate on session IDs opened or recovered in its configured actor,
origin, project and mission. `agent-session remote-status` (TUI `/session remote-status`)
reports that scope and any pending request without authentication secrets.

Every mutation is recorded privately before transmission. A lost response fences
further mutations; the client never automatically repeats an effect. Run
`agent-session recover-remote` (TUI `/session recover-remote`) to look up the original
request and reconcile its original HTTP operation from canonical evidence. Credential
or CA rotation preserves this fence. If lookup returns NOT_FOUND or evidence is
insufficient, the fence remains: retain the private state and ask the site operator
to inspect the original key, server operation and journal. A 404 does not prove that
an in-flight request cannot arrive later. Do not delete the state or manufacture a
new key to bypass uncertainty. A process lock left by a crash likewise requires
checking that the original process has stopped before operator recovery.

The mission tools expose review, capabilities, immutable evidence and prepared
candidate/material/stage requests. Large scientific structures must come from
verified prepared artifacts, not model-invented digests. Mutations require the
existing agent call approval; scientific material `approve` is deliberately not a
model tool. Prepared request revision checks are preflight observations, while the
canonical application enforces current mission state, plan, approval and policy at
its durable mutation boundaries. This workflow does not constitute independent
scientific validation.
