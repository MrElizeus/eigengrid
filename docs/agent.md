# Scientific agent

EigenGrid owns its agent loop. The model proposes structured tool calls; the native runtime
validates input, checks host-owned permissions, records intent, executes the permitted tool
and supplies its observed result to the next inference step. AI SDK is a transport adapter,
not the authority or loop owner.

## Two interfaces

`eigengrid agent "..." --json` and free-form TUI chat inspect the current project. They use
a bounded, process-owned loop and project-local episodic memory. Tools inspect jobs, logs,
nodes, artifacts, results, events, execution templates and the scientific protocol corpus.
Log reads are bounded to 64 KiB and report truncation; event type filters apply before
pagination. Procedural context loads the validated corpus by domain and capability,
retains its maturity/review metadata and has no authority to grant tool permissions.
`inspect-protocol` returns applicability, decisions, diagnostics and validation criteria.
`validate-md-protocol` checks a supplied MD protocol's schema and digest without effects.

`eigengrid agent-session` and TUI `/session` operate persistent, mission-bound sessions.
They expose `mission-status` and `mission-start` only. Starting requires an already reviewed
scientific candidate and a separate exact per-call approval. The session cannot approve its
own scientific plan, choose an actor, bypass project membership or invoke a shell/runner.
Use `agent-session --help` for open, observe, approve, resume, events, cancel and reconcile.

Each interface has a distinct system prompt that describes its actual tools. Scientific
language distinguishes an execution template from a reviewed protocol and an observed
quantity from an interpretation. Tool output and retrieved knowledge are data, not authority.

## Streaming conversation and steering

The TUI prints assistant output into the transcript as it arrives. Completed rows move into
terminal scrollback; the current row remains live above the composer. The composer stays
available while the operator works and preserves an unsent draft when the response finishes.
Press Enter during a turn to queue another user instruction. It is applied at the next
inference/tool boundary: a running tool settles once, unstarted proposals are superseded,
and the next inference uses the new instruction plus the observations already collected.
Steering stays inside the current step/token/cost limits and never grants permission. Input
arriving after the final boundary starts a follow-up turn after the current turn settles.
Slash commands remain available between turns. Esc stops further agent work; it does not
cancel a calculation already submitted. Queued, unapplied text is returned to the composer.

Steering is currently exposed by process-owned chat only. Its `steering_received` event is
recorded in that turn's in-memory journal for deterministic replay. Existing persistent
mission sessions do not enable this inbox; their approval and recovery interface is unchanged.

`doctor`, `list-nodes` and `inspect-node` share the live Slurm inventory when configured,
otherwise the local node registry. `get-job-status` explicitly reports a database snapshot.
It returns `eigengrid status <job-id>` as the canonical reconciliation command; running it
may update lifecycle state and remains subject to action permissions. A stored `running`
status alone does not establish process liveness.

## Model configuration

Administrators can install a shared default at `/etc/eigengrid/llm.json`, or select
a different protected path with `EIGENGRID_GLOBAL_LLM_CONFIG`. The JSON fields are
the same as private model preferences below. Use a root-owned regular file with
mode 0640, readable by the authorized user group, in root-owned directories that
other users cannot write. Do not put a personal ChatGPT login in shared configuration;
site defaults support API credentials and local model endpoints.

CLI, TUI, planning and mission inference load the shared default when there is no
private `.eigengrid/llm.json`. A private file replaces the entire shared selection,
including credentials. Invalid private configuration blocks inference instead of
falling back. Changing the endpoint/provider clears the active inherited key.
`/key --forget` removes only a private saved key. `eigengrid model-config` reports
the effective source and model; `eigengrid model-config --global` inspects site
defaults. Neither command prints credentials or invokes the provider.

The TUI `/models` selects an optional provider/model. `/models set` accepts `baseUrl`, `model`,
`apiKey`, `temperature`, `maxTokens`, `costPerInputToken` and `costPerOutputToken`. Explicit
free local inference uses both per-token costs set to zero. Provider, endpoint or model
changes clear inherited explicit pricing. `/key --forget` removes only the saved key.

Conversational model requests allow 300 seconds per inference by default, including reasoning
and streamed output. Set `timeoutMilliseconds` in the private model configuration to a positive
integer to override it. There is no additional five-minute cutoff for the entire TUI turn;
step/token/cost bounds and individual tool timeouts still apply. Timeout and cancellation
messages retain partial output and explicitly report unconfirmed usage; they never turn an
incomplete response into a successful result or automatically retry an uncertain operation.

Saved `.eigengrid/llm.json` must be a regular file owned by the current user with mode 0600,
in a directory that other users cannot write. Symlinks, named pipes, oversized, unsafe or
malformed configurations block inference. Credentials are never accepted through mission
HTTP request JSON. A configured model must support structured tool calls.

Mission-bound inference reserves tokens and cost in the parent mission's durable ledger.
Missing prices block preparation; missing usage after a possibly started call preserves an
ambiguous reservation. Declared rates estimate spend and do not certify a provider invoice.
No model is needed for manual mission creation, review, approval, compilation or observation.

## Recovery

Local Operator turns also capture tool observations and unreviewed lessons in
[experiential memory](experiential-memory.md). Its evidence checks and human review
are separate from session recovery and scientific execution approval. Multi-user
hosts must disable CLI-local memory; the web interface is deferred beyond 1.0.0.

Observe a session before resuming it. Approval binds actor, project, mission, session, call,
input digest, journal cursor, current policy and expiry. Expired or revoked approval cannot
be replayed. An interrupted effect requires `reconcile`; that action checks canonical
receipts and never resubmits the tool. Canceling a session stops further agent calls and is
separate from canceling an engine allocation. Missing evidence remains visible as unknown.

Recovery rechecks tool-call uniqueness across inference steps before accepting further
effects. Approval and intent records bind the complete proposed tool name and input, not
only its ID. A committed answer, including an empty answer, is reused after restart.
Cancellation is checked again after asynchronous authorization, immediately before tool
execution. Usage returned after cancellation is still recorded; an already started effect
with a lost acknowledgement remains uncertain and requires reconciliation.

If a provider advertises sampling support but rejects `temperature`, set
`"supportsTemperature": false` in that exact model's protected global or private
LLM configuration. This omits the parameter in generation, streaming and mission
inference without changing the price or other advertised capabilities. Reopen the
agent after changing configuration. The override is cleared when selecting a
different model or connection, and cannot enable sampling denied by the catalog.
A rejected request is not automatically retried by this override.
