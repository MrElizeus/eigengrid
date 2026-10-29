# Architecture

Scientific identity and execution authority are explicit, persisted data. Conversation
history and provider output never grant permission to run an engine.

| Layer               | Responsibility                                                                      | Main code                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Scientific schemas  | Chemical identity, protocols, decisions, approvals, evidence and digests            | `packages/scientific-schema`                                                              |
| Protocol compiler   | Deterministic work-unit DAGs, exact revisions, capability compatibility, replay     | `packages/protocol-core`                                                                  |
| Engine adapters     | Typed AMBER input rendering, engine mapping and parsers                             | `packages/amber-adapter`, `packages/md-analysis`                                          |
| Mission runtime     | Durable work, budgets, leases, finalization and continuation                        | `packages/mission-runtime`, `packages/db`                                                 |
| Effect boundary     | Intent before effect, receipts, idempotency, protected submitter and reconciliation | `packages/effect-journal`, `packages/security-boundary`, `python/src/eigengrid_submitter` |
| Native agent        | Bounded inference steps, validated tools, approval interrupts and journal replay    | `packages/agent-runtime`, `packages/tool-registry`                                        |
| Inference transport | Optional provider adapters and usage accounting                                     | `packages/model-gateway`                                                                  |
| Application         | Shared CLI, TUI and authenticated HTTP mission services                             | `apps/cli/src/services/mission-application.ts`                                            |

`protocol-core` depends on scientific schemas and validation libraries, not a model,
agent or scheduler. `scientific-agent` re-exports compiler interfaces for compatibility.
Keep persisted schema/compiler versions distinct from the application version. Existing
records are verified under their supported producer versions rather than silently upgraded.

The canonical execution path is:

```text
scientific objective -> reviewed plan and exact approval -> deterministic compilation
-> durable work unit -> admission and budget reservation -> execution coordinator
-> protected submitter -> engine -> collected bytes and receipt
-> parser/QC -> stage result -> scientific assessment -> approved continuation
```

Successful dispatch is not successful computation; successful computation is not scientific
acceptance. A lost acknowledgement remains uncertain until canonical evidence reconciles it.
Neither a model nor a second process may create an alternative scheduler or retry an uncertain
effect merely because the original caller disappeared.

The older local job/worker subsystem remains available for its existing use cases. Its
execution templates do not constitute reviewed biomolecular protocols. Legacy proposal
`agent approve/execute` and global `--allow-actions` remain disabled; durable scientific
work uses the mission application and mission-scoped approvals.

## Persistence domains

`ScientificStore` and `MdProjectionStore` are stable public facades. They delegate to
internal repositories with one responsibility each; they do not open transactions.
Each repository owns the complete transaction for its operation, including dependent
checks and writes. Passing the existing transaction to a helper preserves rollback,
row-lock order and the original atomic approval/admission boundaries.

| Domain                                            | Implementation             |
| ------------------------------------------------- | -------------------------- |
| Mission creation, project access and state        | `scientific-missions.ts`   |
| Reservations and model usage                      | `scientific-budgets.ts`    |
| Planning claims, skill resolutions and plans      | `scientific-plans.ts`      |
| Work-unit DAGs, claims and completion             | `scientific-work-units.ts` |
| Exact approvals and decision requirements         | `scientific-approvals.ts`  |
| Effect intents, receipts and reconciliation       | `scientific-operations.ts` |
| Evidence, observations and assessments            | `scientific-evidence.ts`   |
| Provenance reconstruction                         | `scientific-provenance.ts` |
| MD material publication                           | `md-material-store.ts`     |
| MD protocols, stages and replicas                 | `md-protocol-store.ts`     |
| MD results, trajectories, metrics and assessments | `md-result-store.ts`       |

These files live in `packages/mission-runtime/src`. The `*-store-validation` modules
contain pure validation and digest operations. Store contexts contain transaction and
persistence primitives; MD query, authority, subject, binding and completion modules
accept the caller's transaction. Internal repositories are not exported from the package
index. New operations belong in their domain, keeping the facades as delegation only.

The refactor does not change database migrations, protocol versions or digest formats.
A transaction must never be replaced with a series of public repository calls: those
calls may commit independently. Cross-domain invariants use transaction-scoped helpers.

## Journal cost and integrity

`EffectJournal` supports an optional `readAfter(cursor)` port for stores with an immutable,
append-only history. A warm instance validates only the complete suffix after its last
verified sequence and digest. It checks continuity, the reported head, transitions,
identity and outbox bindings before using the new state. Failed refreshes discard the
projection; a restart rebuilds it from retained frames. Concurrent writers still use
atomic compare-and-append.

The in-memory adapter implements this port. Mutable adapters, including the JSONL fault-test
store, retain full replay on every operation: an unchanged final digest cannot prove that
an earlier file record was not rewritten. Do not implement the incremental port on a
mutable file merely to obtain a faster benchmark.

For an immutable store, sequential appends process a linear number of historical frames
instead of repeatedly processing the complete prefix. Indexed lookups have constant
history-processing cost after refresh. Public snapshots and initial recovery remain
linear in history size, and retained indexes consume linear memory. This optimization
is not a throughput claim for PostgreSQL mission execution or scientific trajectories.
Run `bun run benchmark:journal` for synthetic timing and frame-read counts.

A local Linux x64/Bun 1.3.14 run on 2026-10-25, with other verification running,
processed 24,100 frames with full replay versus 200 with incremental replay for
200 appends, one snapshot and 20 lookups. Appends plus the snapshot took 30.12 s
versus 0.75 s; the 20 lookups took 5.74 s versus 0.0035 s. These are synthetic
in-memory measurements, not installation service-level targets. Frame counts are
the reproducible scaling result; timings depend on load and hardware.

## Release compatibility

Active services and tests use responsibility-based names. The published HTTP SQL migration
is retained byte-for-byte in `apps/cli/src/services/http/schema-v1.sql`; existing databases
store its checksum. Its table names and advisory-lock identity remain compatibility
contracts, as does the original persisted MD byte-integrity criterion. Changing those
identities requires an explicit migration, not a text replacement.

Autonomy-level enum values are versioned domain data, not development-phase names.
This repository has an independent public history; native manifests identify the actual
build commit. The source guard checks untracked additions as well as tracked files,
rejects retired module filenames and repository links, and excludes private/generated
material from the source distribution.
