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

## Failure handling

Preserve journals, database records, CAS objects and returned engine bytes. Inspect the
canonical operation before retrying. A timeout or lost acknowledgement does not prove an
effect failed. Reconciliation must establish submission/accounting identity, output
integrity and current policy. Unknown effects remain fenced until resolved.

Back up the database and content-addressed artifacts consistently. Rehearse restoration
on disposable infrastructure and validate lineage before reopening dispatch. Application
installation is not a backup, restore, high-availability or production-site certification.

## Distribution layout

Keep `bin/` beside `share/eigengrid/scientific-skills`. The executable resolves the corpus
relative to itself, independent of the working directory. A deliberately configured
`EIGENGRID_SCIENTIFIC_SKILLS_ROOT` overrides that location and is validated when loaded.
Use `EIGENGRID_PYTHON` to select the environment containing the installed scientific wheel.
Providers and scientific engines are external, optional components with separate credentials.

## Supported scheduler contract

The current strict accounting and submission contract supports Slurm 23.11.x.
A newer scheduler release requires an adapter contract with its own real-format
fixtures and qualification. Slurm 26.05.x is rejected by the existing version guard;
changing the reported version or bypassing that guard is not a supported migration.
