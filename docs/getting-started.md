# Install and verify EigenGrid

Choose the interface by the work you need to do:

| Need                                       | Interface                                                | State and authority                                                        |
| ------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| Inspect schemas or render inputs           | `mission schema`, `amber schema`, engine render commands | No model or engine execution                                               |
| Existing local jobs and workers            | `init`, `submit`, `status`, `worker`                     | Project-local configuration; separate from reviewed MD missions            |
| Reviewed scientific execution and recovery | `mission`, persistent Head, protected submitter          | PostgreSQL, exact approvals and site-owned identity                        |
| Conversational assistance                  | `agent`, mission-scoped agent sessions                   | Optional external model; scientific authority stays in the mission service |

The local job interface does not turn a template into an approved biomolecular protocol.
Use durable missions for reviewed MD work, budget reservations and parent-bound continuation.

## Connect a model provider

Start `eigengrid` and enter `/connect`. Use the arrow keys to select a provider,
type to filter and press Enter to open its authentication menu. Escape returns to
the previous menu. `/providers` is an alias. `/connect search <name>` searches the
directory; `/connect <id>` opens that provider's authentication menu directly.

OpenAI offers **Continue with ChatGPT** and **Use API key**. The ChatGPT option opens
an account picker, then the system browser for OpenAI sign-in and plan permission.
After authorization, choose a model from that account's catalog. Existing accounts
can be selected again or signed out with `d` in the account picker. `/connect logout`
signs out the current ChatGPT account; `/connect usage` opens ChatGPT's usage controls.
Selecting a verified account activates ChatGPT access before loading models. A failed
model-list request keeps that account selected, so `/models` can retry without falling
back to the API key connection.
This uses the official [open-source sign-in flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
with eligibility and limits determined by OpenAI and the selected account/workspace.

ChatGPT credentials are stored outside projects and release directories in
`$XDG_DATA_HOME/eigengrid/auth` (default `~/.local/share/eigengrid/auth`), with owner-only
permissions. `EIGENGRID_AUTH_DIR` can select another private runtime directory.
Project settings save only the authentication method, profile reference and model.
Tokens renew automatically, and each account keeps its own registration and credentials.
If a process dies while holding the credential lock, close other sign-in attempts before
removing the stale `chatgpt.lock` directory from that private directory.

The provider directory comes from `https://models.dev/api.json`, cached in memory for five minutes.
EigenGrid filters it to text models with a usable endpoint and an implemented protocol
(OpenAI, OpenAI compatible or Anthropic). Mixed providers can have fewer compatible
models than their full catalog. Entries requiring other integrations or endpoint
templates are omitted.

Catalog compatibility does not verify credentials, account permissions, quota or live
availability. **Use API key** opens private key entry; a catalogued environment variable
can also supply the key. Select a model with `/models <model-id>` and send a prompt to
verify access. `/models` opens a keyboard model picker with a distinct account or API
key heading. ChatGPT mode uses the selected account's authorized catalog. API key mode
requests `/models` from the configured provider with that API credential; it never
borrows a saved ChatGPT session. Missing credentials open a connection choice rather
than showing a public directory. Providers without a live listing endpoint report that
limitation instead of presenting cached entries as available.

Live catalogs supply availability. Directory metadata can supply names and capabilities.
Shutdown dates and lifecycle flags exclude retired or deprecated entries; image,
embedding, realtime and other non-conversational models are omitted from the agent picker.
Direct `/models <model-id>` selections use the same live validation.
Selecting a model opens its reasoning-variant menu before saving. `/variants` opens
that same menu for the current model, with arrow keys, Enter and Escape. The choice
is saved together with the model. `/variants high` selects an explicitly supported
effort and `/variants default` clears the override. Escape from the variant menu
returns to models without changing the saved model or effort.

ChatGPT variants use that account's `supported_reasoning_levels`. API connections use
advertised levels where available, with a documented native OpenAI capability fallback
for the GPT-6 family. Unknown capabilities offer only **Provider default**, which sends
no reasoning override. Client orchestration modes are not passed as model API efforts.
Changing model, account or access method clears the previous effort unless a new one
is selected explicitly. Effort uses the existing output-token and cost budgets.
See [OpenAI reasoning efforts](https://developers.openai.com/api/docs/guides/reasoning).

A completed response verifies access to that model for that
request. ChatGPT plan requests use streaming Responses with storage disabled; failures
never switch silently to API billing. The monetary API estimate is zero in this mode,
while token limits and ChatGPT plan limits still apply.

Requests can consume the provider's quota. Switching providers clears the previous
provider's saved key; `LLM_API_KEY` is a generic override only in API key mode.
Software tests use offline catalog fixtures and local fake providers.

## Browse scientific protocols

Ask the Operator to show the installed protocols, filter by an engine or scientific
objective, or inspect an exact ID such as `amber.production-md`. For a general overview
it lists the catalog without applying a text filter. Short scientific searches support
common Spanish terms and normalizes diacritics.

The catalog reports installed, matched and returned counts separately. A filtered zero
does not mean that the installed catalog is empty. Results include the exact available
domain and engine keys; unsuccessful searches include a recovery hint. Up to 100 entries
can be requested, and exact protocol IDs rank ahead of broader text matches. Inspection
shows the canonical version, methodological inputs and maturity/review status. Selecting
guidance does not approve or launch a calculation.

The interactive Operator and `eigengrid agent` allow eight inference rounds by default,
including a final answer round with tools disabled. That round receives the tool
observations already collected and must explain the result or missing evidence. The
executor rejects tool calls in that reserved round, including after replay. Token, cost
and cancellation limits still apply; the final answer does not authorize extra provider
calls beyond the configured limit. Durable mission sessions retain their own budgets.

## Choose execution permissions

Enter `/permissions` to open the execution and approval picker. Use arrows or Tab,
Enter to select and Escape to return without changing the active preset. There is
no singular alias. The active preset remains visible below the conversation.

| Preset                 | Approval policy                                                                            | Execution scope                                     |
| ---------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Read Only              | Mutations denied                                                                           | Inspect workspace files and operational evidence    |
| Ask for Approval       | Human approval before mutations and execution                                              | Registered tools under the current OS user          |
| Auto Review            | Independent deterministic review of eligible input edits; human approval for other changes | Same scope as Ask for Approval                      |
| Autonomous (Sandboxed) | Automatic permitted workflow steps; human approval for destructive actions                 | Workspace files and isolated local calculations     |
| Full Access            | No per-action approval prompts                                                             | Programs and files available to the current OS user |

New workspaces default to **Ask for Approval**. Selecting Full Access explicitly
allows the Operator to run programs with the existing user's privileges. It never
changes Unix identity or grants additional OS privileges. Scientific mission,
site-owned authority and durable approval requirements remain independently enforced.

Ask prompts show the exact action and input digest, default to **Deny**, and offer
**Approve once**. Long inputs remain fully reviewable with Page Up and Page Down.
Approvals expire after two minutes and are bound to the session,
call, arguments, current permission revision and referenced file contents. Changed
inputs or permissions invalidate approval. The final tool executor rechecks authority;
model instructions and fields such as `approved: true` grant no permission.
Noninteractive `eigengrid agent` cannot supply human approval: use the interactive
Operator to review a pending action. The old `--allow-actions` flag remains disabled.

Auto Review is a separate host module with no tool execution or credential access.
It automatically approves text edits of at most 1 MiB to scientific input extensions
inside the workspace. Scripts, configuration changes, calculations, cancellation and
arbitrary commands require human approval. Unknown or failed review never grants access.
Input-file tools cannot edit credentials, permission settings or repository metadata.
Reading those protected files or kernel/device files requires Full Access.

The sandbox preset requires a successful local check of Linux namespaces, bubblewrap
and a working user systemd manager. Missing isolation blocks activation and execution;
there is no fallback to an unrestricted process. Calculation processes see system
libraries and read-only workspace inputs, with only their job directory writable.
Home credentials, project connection settings, inherited secrets and host networking
are unavailable. Per-job limits are 200% CPU, 4 GiB memory, 256 processes, one hour and
64 MiB per output file. These are per-job and per-file limits, not an aggregate disk
quota or a shared budget across multiple calculations. Required software and data must
be available in the system installation or workspace. Arbitrary commands and remote
submissions are disabled in this preset until a separately bounded remote executor exists.
Trusted host services still own job staging, parsing and persistence.

This is filesystem, namespace, network and resource isolation for local calculation
processes. It is not a complete hardened sandbox for hostile arbitrary code: this
launcher does not install a seccomp filter or require an EigenGrid-specific AppArmor
profile. The kernel, system packages, Operator host and orchestration services remain
trusted. Full Access intentionally runs outside this isolation. The separate legacy
`sandboxUser` option only requests a Linux account switch; if that switch cannot be
established, execution is refused rather than falling back to the current user.

Settings are workspace-specific, stored outside the repository under
`$XDG_DATA_HOME/eigengrid/permissions` (default `~/.local/share/eigengrid/permissions`)
with owner-only permissions. Authorized mutation decisions are audited there without
logging raw arguments, file contents or credentials. `EIGENGRID_PERMISSIONS_DIR` can
select another private directory. Connection preferences and permission-menu changes
are explicit user settings, independent of scientific workspace mutations.
The preset governs Operator tools, `/agent`, and operational slash commands; manually
invoked administrator CLI/API services retain their own authentication and policies.

## Reproduce the software workflow

Use Linux x86_64, Bun 1.3.14, Node.js 22 or later and Python 3.13. PostgreSQL tools
(`initdb`, `pg_ctl`, `createdb`) and a working rootless Podman or Docker installation
are needed for the isolated integration workflow. Run as a non-root user.

```bash
bun install --frozen-lockfile
python3.13 -m venv .venv
. .venv/bin/activate
python -m pip install --require-hashes -r python/requirements-linux-x64-py313.lock
python -m pip install --no-deps --no-build-isolation -e ./python
bun run eigengrid --help
bun run eigengrid mission schema create
bun run eigengrid mission schema client-config
bun run verify:workflow
```

`verify:workflow` builds the CLI, creates disposable PostgreSQL databases and exercises
protected publication/submission, output collection, terminal recovery and continuation.
The container fixture uses synthetic engine effects. It checks lost acknowledgements,
competing Heads, revocation, rollback and parent/result integrity. It does not submit a
real Slurm job, invoke a licensed engine or require personal model credentials.
The image is pinned by digest and may need to be downloaded on the first run.

The command fails when a required dependency is missing. Set
`EIGENGRID_TEST_CONTAINER_RUNTIME=podman` or `docker` to select the container runtime.
Do not supply `EIGENGRID_TEST_POSTGRES_URL` to this command: its database wrapper creates
and removes its own disposable cluster. A successful command ends with an explicit
software-workflow result. Keep its log when qualifying a checkout.

For the complete software checks:

```bash
bun run typecheck
bun run lint
bun run format:check
bun run build
bash scripts/release/test-postgres.sh
bun run test:py
python scripts/release/scan.py .
```

ORCA/SSH tests are optional and report skips without their external prerequisites.
A skip is not successful verification of that service.

## Verify an installed distribution

Build from a clean committed checkout. Use a new output directory; the builder preserves
existing distributions:

```bash
release_dir=$(mktemp -d /tmp/eigengrid-install-check.XXXXXXXX)
export EIGENGRID_RELEASE_PYTHON="$PWD/.venv/bin/python"
node scripts/release/build.mjs "$release_dir/native"
bun scripts/release/smoke.ts "$release_dir/native"
node scripts/release/package.mjs "$release_dir/native" "$release_dir/packages"
```

The smoke check runs all six executables from an unrelated directory, inspects no-model
schemas, exercises a local fake-provider tool/result exchange and installs the Python
wheel into a temporary target. It does not use external model credentials. Packaging
verifies file digests and exact source provenance. See [release verification](releases.md)
for archive verification and reproducibility checks.

Install `bin/` and `share/` together. Install the wheel in the Python environment selected
by `EIGENGRID_PYTHON`. A service deployment's `/opt/eigengrid/current` points at that
complete distribution root, not at its `bin/` directory.

## Prepare a protected installation

The software fixture is the reproducible starting point. A real site additionally needs
its own reviewed configuration, credentials and scientific inputs. Provision in this order:

1. Create separate PostgreSQL migration and runtime roles; rehearse database and CAS
   backup/restore on disposable storage. Apply the database migrations using the migration
   role before starting the runtime. Do not point test helpers at an existing site database.
2. Use `eigengrid mission schema client-config` to obtain the current configuration shape.
   Provision `/etc/eigengrid/mission-client.json` as root-owned configuration with the
   runtime database URL, canonical artifact root, operator UIDs/actors/roles, compiler
   policy and environment. JSON Schema describes shape; runtime validation also checks
   exact policy/environment digests and relationships.
3. Provision the submitter's protected site identity, signing verification, executable
   and library digests, and OS isolation. Configure Head MD authority, private CAS and
   postprocessing authority through the options reported by `eigengrid-head --help`.
   Scientific engines and their licenses are installed separately.
4. Install and adapt the [service templates](../packaging/README.md). Start with dispatch
   disabled and inspect `eigengrid-head --health --dispatch-disabled`. Health is a
   dependency check, not scientific acceptance. The production deployment profile
   currently requires dispatch to remain disabled; this guide does not qualify or unlock it.
5. If HTTP is needed, provision the exact HTTPS origin and authenticated operators,
   explicitly run `eigengrid serve init-schema` with the protected admin role, then start
   `eigengrid serve` behind the TLS reverse proxy. Preserve the published HTTP migration
   and existing session/idempotency records when upgrading.

The supported scheduler contract is Slurm 23.11.x. An unsupported scheduler or engine tuple
needs its own adapter qualification. Never bypass a version, digest or authority check to
make a health check pass. See [operation and recovery](operations.md) for the boundaries.

## Qualify a real scientific workflow

Keep installation qualification separate from synthetic software results. On an eligible
reviewed installation, retain evidence for a two-segment workflow submitted through the
mission application, including an interruption and recovery. Record:

- Source commit, package digest, engine/build/environment identity and scheduler version.
- Approved system/protocol revisions, AtomMap and exact input digests.
- Mission, work-unit, attempt, allocation, receipt and collected output identities.
- Verified parent restart, QC, assessment and the single authorized successor.
- Wall time, peak memory, output bytes, collection/analysis throughput and recovery time.

Use `mission schema` to obtain each request shape, then create/import, review, approve,
compile and start the exact reviewed candidate. Preserve journals and inspect canonical
operation evidence after an interruption before deciding whether anything may be retried.
A missing acknowledgement alone never authorizes another submission.

This repository cannot supply the site's licensed engines, molecular inputs or scientific
review. Record unperformed steps as pending. See [scientific capabilities](scientific-capabilities.md)
for engine profiles, sampling limits and the two-segment acceptance boundary.

## Diagnose failures

| Symptom                           | Next check                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------- |
| Schema rendering fails            | Runtime/dependency versions and executable layout; it needs no database or model  |
| Protected configuration rejected  | File ownership/mode, exported schema, canonical paths and exact digests           |
| Mission access denied             | Current kernel UID, actor, role and project membership in protected configuration |
| Head starts without dispatch      | Dispatch flag and deployment profile; do not treat monitoring as engine execution |
| Operation stays ambiguous         | Canonical submitter/accounting evidence and receipt identity before retry         |
| HTTP refuses startup              | Explicit schema initialization, protected origin and authorized service identity  |
| Integration container fails       | Rootless runtime, pinned image availability and readable source/Bun mounts        |
| Large trajectory analysis is slow | Measured bytes, memory and throughput on the target installation                  |
