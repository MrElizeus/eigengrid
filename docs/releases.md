# Native release packages

Source and release artifacts follow [the publication policy](publication.md).
Run `bun run verify:publication` before building and publishing any release.

Version **1.0.0** prepares the stable software release, subject to PR review and
passing CI. It includes:

- Domain modules extracted from the database, migrations, scientific schemas,
  model gateway, runners and execution coordinator, preserving their public contracts.
- The English [mission console](web-console.md) embedded in `eigengrid serve`:
  discovery, guided creation, exact candidate review, evidence and durable agent controls.
- The [assistant workspace](web.md) in `eigengrid web`: authenticated private chat,
  streaming, steering and read-only tools. Network use requires PostgreSQL and HTTPS.
  This command has its own account/session service; it is separate from mission control.
- Agent catalog pagination, provider compatibility, permission diagnostics and
  runtime fixes integrated with the web interfaces.

Both browser interfaces are embedded in the native executables; no frontend runtime
is required at the installation. Existing database migration bytes remain unchanged.
Software stability does not certify scientific correctness or an installation's
AMBER/Slurm configuration. Site qualification remains pending per installation.

Version **1.0.0-rc.3** improves interactive operator conversations and diagnostics:

- Assistant output enters the transcript as it streams. Completed rows scroll into
  history while the composer remains available, including during long tool batches.
- Enter during a turn queues steering for the next inference/tool boundary. Completed
  observations and budgets are preserved; unstarted proposals are superseded. Esc
  stops further work without cancelling an already submitted calculation.
- Conversational requests allow 300 seconds per inference by default, configurable
  with `timeoutMilliseconds`. Timeout and cancellation retain partial output and
  report unconfirmed usage explicitly; the TUI no longer imposes a separate
  five-minute cutoff across the entire turn.
- Job, node, log and error summaries follow their actual tool result contracts.
  Environment diagnostics and node tools share the configured live Slurm inventory.
- Stored job status is identified as a database snapshot and exposes the canonical
  reconciliation command under the existing action permissions. General job
  inventory starts with an unfiltered query.

Existing database migrations and scientific approval contracts are unchanged.
Steering is available in process-owned chat; persistent mission sessions retain
those sessions' existing approval and recovery interface.

Version **1.0.0-rc.2** fixes two provider connection issues:

- OpenCode Go model selection queries the shared live catalog even when the saved
  inference endpoint uses the OpenAI, Anthropic or legacy Go route. Custom proxy
  endpoints retain their own catalog route.
- The ChatGPT sign-in URL uses OSC 8 hyperlinks so every wrapped row opens the
  complete authorization URL in supported terminals, preserving the visible layout.

The package includes the core runtime, CLI, generic engine adapters and a reviewed
publication selection of 15 basic knowledge entries. Catalog content remains
scientifically unreviewed; advanced catalogs are not bundled.

Commit the source and build the Linux x64 distribution before packaging it:

```bash
bun run build:native
node scripts/release/package.mjs
node scripts/release/verify-package.mjs dist/packages/eigengrid-1.0.0-linux-x64.tar.gz --source dist/native
```

Packaging requires a clean checkout and a distribution built from its exact commit and
version. It verifies the build inventory, then produces a deterministic `.tar.gz`,
`release.json` and `SHA256SUMS` in a new output directory. Existing output directories
are preserved; pass another directory as the second packaging argument for another run.
Archive paths, ownership, permissions and modification timestamps are normalized; access
and change timestamps are omitted. The Python wheel's internal permissions and timestamps
are normalized independently of the build host's umask. The manifest lists
the six executables, scientific corpus, Python wheel and component inventory with file
sizes and SHA-256 digests. Verification checks every archived file without extracting it;
`--source` also compares the original distribution.

Checksums detect corruption and changes relative to the manifest. They do not authenticate
a publisher; obtain packages and their commit identities through a trusted channel.

The distribution schema retains qualification `software-candidate` to describe its
installation qualification status, including for stable software version 1.0.0.
This field is independent of the release's SemVer stability. Neither an RC nor a
stable software package certifies a Slurm installation, engine tuple, scientific
system, recovery objective or production campaign. Scientific use still requires
the corresponding installation and acceptance evidence. See
[capabilities](scientific-capabilities.md) and [operations](operations.md).
