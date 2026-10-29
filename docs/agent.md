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

## Model configuration

The TUI `/models` selects an optional provider/model. `/models set` accepts `baseUrl`, `model`,
`apiKey`, `temperature`, `maxTokens`, `costPerInputToken` and `costPerOutputToken`. Explicit
free local inference uses both per-token costs set to zero. Provider, endpoint or model
changes clear inherited explicit pricing. `/key --forget` removes only the saved key.

Saved `.eigengrid/llm.json` must be a regular file owned by the current user with mode 0600,
in a directory that other users cannot write. Symlinks, named pipes, oversized, unsafe or
malformed configurations block inference. Credentials are never accepted through mission
HTTP request JSON. A configured model must support structured tool calls.

Mission-bound inference reserves tokens and cost in the parent mission's durable ledger.
Missing prices block preparation; missing usage after a possibly started call preserves an
ambiguous reservation. Declared rates estimate spend and do not certify a provider invoice.
No model is needed for manual mission creation, review, approval, compilation or observation.

## Recovery

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
