# Web console

The English browser console is served at the root of the protected HTTPS origin by
`eigengrid serve`. It is part of the CLI executable, including native releases; it
does not require a separate frontend runtime, CDN, build server or asset directory.
It uses the same mission application, PostgreSQL authority, CAS, approvals and
durable agent sessions as the CLI.

## Connect

Provision the installation as described in [operations](operations.md) and
[getting started](getting-started.md#prepare-a-protected-installation). The server
still binds only to `127.0.0.1`; terminate TLS at the configured reverse proxy and
forward both `/` and `/api/v1/` to the same listener. Preserve request bodies,
cookies, `Origin`, `X-CSRF-Token` and `Idempotency-Key`. Disable caching for this
origin. The public origin must exactly match protected configuration.

Run `eigengrid serve credential` to generate an opaque credential and its digest.
The administrator provisions the digest, actor, roles and allowed project IDs in
protected configuration; share the credential with that operator through your
existing secure channel. Do not put it in a URL. Open the configured HTTPS origin
and enter the credential on the sign-in screen. User and project membership must
also be active in the canonical database.

Authentication uses a Secure, HttpOnly, SameSite=Strict host cookie. Reloads and
independent tabs recover the session-bound CSRF token through authenticated
bootstrap. Credentials, CSRF tokens, prompts and scientific request bodies are
never stored in localStorage or sessionStorage. Sign out revokes the server session.
Current account status and protected authority are rechecked on requests.

Use a current browser with native JavaScript modules, Web Crypto, dialog elements,
AbortSignal timeout/combination and sessionStorage. Browser storage is needed for
mutation recovery metadata. Blocking it disables submissions while reads remain
available. There are no external fonts, scripts, analytics or network dependencies.

## Mission workflow

1. Choose an authorized project. The mission list contains your own bound missions;
   another member's missions and historical unbound local jobs are excluded. Search
   by question, ID or target property, and filter by lifecycle state.
2. Select **New mission**. Enter the scientific question, target properties,
   confidence and explicit acceptance criteria. Upload the structure, select its
   format, and specify charge/multiplicity only when known. Set allowed engines and
   explicit budget limits. Review the summary before creating the mission. Creation
   stores the objective and evidence; it does not launch a calculation.
3. Under **Plan & review**, import a candidate JSON in the existing
   `eigengrid.mission-candidate/v1` format. Upload any new evidence files referenced
   by its digests. The CLI's `eigengrid mission schema import` describes the envelope;
   the file picker expects its `candidate` object. The server validates the complete
   candidate and current policy. You can also prepare candidates through the agent.
4. Inspect the exact protocol, material decisions, risks, limitations and approval
   bindings. An authorized reviewer supplies a reason and explicitly approves or
   rejects each applicable revision. Expired approvals cannot be granted. A changed
   revision or policy requires a fresh review.
5. **Compile work units**, then **Request execution**. Both use the reviewed
   candidate digest and mission revision; the backend rechecks admission. Execution
   belongs to the separately provisioned Head and remains subject to its dispatch
   controls and installation qualification.
6. Follow **Work units**, **Evidence**, **Activity** and the separate scientific
   assessment in **Overview**. Downloads use the exact CAS digest and revalidate
   mission access. **Cancel mission** records a cancellation request with a reason;
   completion depends on canonical reconciliation of admitted work.

The mission page checks status every 15 seconds while visible. It announces updates
without replacing a review form or silently changing its reviewed revision. Use
**Refresh view** to load new records. Dashboard counts describe execution lifecycle,
not scientific acceptance. Large catalogs are paged in requests of at most 100;
the console bounds its loaded catalog to 10,000 records.

## Durable agent sessions

The **Agent** view can open a task or attach to an existing session UUID. Its URL
identifies the session, so bookmark it to return later. Opening a session does not
resume it. Review the task, then explicitly resume. The page exposes the current
phase, usage, response, tool input, exact journal cursor and paged event history.
Refresh the view for newer session state.

Tool approval applies to one call, its canonical input digest and exact cursor,
expires after five minutes, and requires a separate resume action. Scientific plan
approval remains independent. Reconcile uncertain sessions against their journal;
do not repeat an unconfirmed tool effect. Agent cancellation and mission cancellation
have separate controls and lifecycles.

## Interrupted requests

Before sending a mutation, the console saves only the actor/project/mission IDs,
operation name, random idempotency key and timestamp in sessionStorage. A received
rejection can additionally record that a response arrived. No scientific payload or
authentication secret is retained there. A request without a confirmed outcome
blocks further console mutations for that mission in the tab, including after reload.
Keep that tab and its request reference until recovery finishes.

Use **Check saved result** in the outstanding-request panel. A completed response is
read back without re-execution. For a pending operation, **Reconcile with recorded
state** invokes the existing canonical reconciliation service. An error response
followed by an authorized absent lookup establishes that the rejected request was
not reserved. Absence after a disconnected request does not establish failure: it
may still be in flight. Unresolved requests retain their reference for operator
investigation; the console never silently retries them with a new key.

These controls supplement backend idempotency and fencing; browser metadata is not
authority. Clearing browser storage does not clear server reservations, undo an
effect or justify resubmission.

## Development and verification

Browser modules are in `apps/web/src`, with JSDoc checked by
`bun run typecheck:web`; `bun run typecheck` includes it. Shared types are imported
only for checking and do not ship server code to the browser. The UI is divided
into navigation, mission creation, review, records, agent and recovery modules.
Use the existing protected local installation to preview with `bun run eigengrid serve`.
There is no development authentication bypass or production demo-data fallback.

`tests/ts/web-console.test.ts` exercises exact request shapes, digest parity, CSRF
headers, recovery across reload, lost responses and unavailable storage.
`web-assets.test.ts` verifies the closed asset graph, restrictive response headers
and compilation into an executable that serves assets from an unrelated directory.
PostgreSQL integration tests cover discovery isolation, revoked membership, session
bootstrap and the existing create/review/approve/compile/start/recovery workflows.
Browser layout, keyboard navigation and mobile rendering also need a browser QA
pass before release promotion; transport and compilation tests do not replace it.
