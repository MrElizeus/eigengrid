# Native release packages

Source and release artifacts follow [the publication policy](publication.md).
Run `bun run verify:publication` before building and publishing any release.

Version **1.0.3** adds shared model defaults, Slurm 26.05 accounting and explicit
release-bound Head admission. See the [1.0.3 notes](release-notes/v1.0.3.md) and
[production admission procedure](operations.md#production-dispatch-admission).

Version **1.0.2** completes the scientific planning conversation and corrects command recovery:

- `/plan` calls the configured model, retains conversation and tool context, inspects
  relevant protocol versions and dependencies, and asks structured scientific questions.
  Choices include explanations, an optional recommendation and free-text input.
- Long proposals are assembled in sections within the configured response token limit.
  Complete proposals include stages, dependencies, parameters, resources, validation,
  recovery and limitations, and are stored as immutable revisions.
- Planning can search RCSB and acquire bounded public HTTPS inputs with provenance and
  hashes. It cannot run shell commands, submit calculations or install software.
- Ordinary operator command failures retain their diagnostics instead of producing a
  misleading success followed by an uncertain-effect serialization error.
- Release publication reads reviewed notes from the exact source commit.

See the [1.0.2 release notes](release-notes/v1.0.2.md) and
[interactive planning guide](interactive-scientific-planning.md). Database migrations,
scientific execution approvals and private catalog contents remain unchanged.

Version **1.0.1** introduced catalog preservation and agent memory corrections:

- The cluster installer preserves the selected external scientific catalog in both
  the shared client launcher and Lmod module. Preparation verifies the catalog through
  the installed client; activation rejects a changed catalog digest or launcher.
  A site whose selection was already lost can explicitly pin its existing catalog
  root and digest in the installation plan. Catalog files remain outside the release.
- `eigengrid retrieval compose` prepares a private site view containing public
  updates and existing site protocols. It deduplicates identical versions, retains
  distinct versions, and stops on identity conflicts, dependency errors or evaluation
  regressions. Explicit source digests are required before writing a new view.
- Scientific discovery preserves adjacent concepts in IDs, titles and summaries
  when ranking protocols from multiple catalogs. Phrase matches do not suppress
  ambiguity between otherwise plausible alternatives or grant execution authority.
- Tool observations redact credentials inside nested JSON file contents before
  retaining evidence. Existing append-only evidence is not rewritten; installations
  with older captured credentials need their own data review and credential rotation.
- Long prompts retain scientific retrieval context instead of failing the experience
  search length limit. The original prompt sent to the model is unchanged.
- Experience search handles accented and unaccented text consistently, including
  existing Spanish lessons, without changing their review state or stored history.

This patch leaves database migrations and scientific execution contracts unchanged.
The web interface remains separate. The release controller still admits only its
existing RC channel; stable patch installation requires a site administration decision.
See [catalog upgrade and recovery](continuous-delivery.md#scientific-catalog-preservation).

Version **1.0.0** introduced the stable software release:

- Domain modules extracted from the database, migrations, scientific schemas,
  model gateway, runners and execution coordinator, preserving their public contracts.
- The authenticated `/api/v1` HTTP API with protected account/session boundaries,
  project discovery, mission operations and durable request recovery.
- Durable agent task discovery scoped to actor, project, mission and current policy;
  tool approvals, budget accounting and uncertain-request recovery remain canonical.
- Agent catalog pagination, provider compatibility, permission diagnostics and
  runtime fixes for the native agent.
- A 31-entry versioned planning catalog, including molecular/periodic DFT and
  magnetic-response protocols. These remain draft knowledge, without new engine
  execution authority or installation qualification.
- [Experiential memory](experiential-memory.md) for local CLI/TUI observations,
  evidence-backed candidates, contradictions and exact-revision human review.
  Memory promotion does not approve scientific protocols or tool execution.

The web interface is deferred and developed separately from 1.0.0. No browser
assets or web server alias are included in this release; `eigengrid serve` exposes
the backend API. Existing database migration bytes remain unchanged.
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

The package includes the core runtime, CLI, generic engine adapters and the
versioned knowledge entries listed in the [scientific catalog](scientific-capabilities.md).

Commit the source and build the Linux x64 distribution before packaging it:

```bash
bun run build:native
node scripts/release/package.mjs
node scripts/release/verify-package.mjs dist/packages/eigengrid-1.0.2-linux-x64.tar.gz --source dist/native
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
