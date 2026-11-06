# React workspace

This development branch contains one English React application, deferred from
EigenGrid 1.0.0 while integration and review continue. No release version is assigned.
In this branch, `eigengrid serve` and its
`eigengrid web` alias start the same protected HTTP listener. React and CSS are
embedded in the executable; installation needs no separate frontend runtime,
asset directory, CDN or Node service.

The interface uses a light background, a text-only EigenGrid wordmark and central
mission views. The agent is a persistent panel on the right. Hide it without
losing the in-memory task draft; drag the separator or use its arrow keys to resize
it. Home/End select the width limits. Small screens place the agent below the
mission. Only the width preference is stored in localStorage.

## Architecture and connection

React components in `apps/web/src` use the same-origin `/api/v1` HTTP API.
Scientific contracts are imported as TypeScript types only. Database access,
model credentials, agent execution and cluster authority stay in the backend.
The browser cannot choose a provider key, protected configuration path, actor or
execution identity.

The API composes the same MissionApplication, PostgreSQL state, content-addressed
artifacts, scientific approvals and durable agent service as the CLI. The
separately provisioned Head admits and coordinates scientific execution. One web
application does not combine the Head and browser server into one process.

Provision the installation as described in [operations](operations.md) and
[getting started](getting-started.md#prepare-a-protected-installation). The listener
binds only to `127.0.0.1`; terminate TLS at the exact HTTPS origin in protected
configuration. Forward `/` and `/api/v1/` to this listener, preserving cookies,
Origin, X-CSRF-Token, Idempotency-Key and request bodies. Disable proxy caching.
`deploy/web` contains illustrative proxy/service files; replace their account,
working directory and port with the provisioned installation values.

`eigengrid serve credential` generates an opaque credential and its digest. The
administrator provisions the digest, actor, roles and allowed project IDs in
protected configuration. Share the credential through your secure channel, never
in a URL. Sign in with that credential. User and project membership must also be
active in the canonical database. The former prototype password/invitation login
is retired; see [migration notes](web.md).

Authentication uses a Secure, HttpOnly, SameSite=Strict cookie. Bootstrap recovers
the session CSRF token after a reload. Credentials and tokens never enter browser
storage. Account and authority are rechecked on requests; sign-out revokes the
server session. Cross-tab sign-in/sign-out clears the current UI and fences old
responses. Ordinary window focus revalidates access while preserving drafts if the
same session remains active.

## Mission workflow

1. Select an authorized project. Search/filter your own bound missions; other
   members' missions and historical unbound local jobs are excluded.
2. Choose **New mission**. Define the question, properties, acceptance criteria,
   structure, known charge/multiplicity, allowed engines and explicit budget limits.
   Review the summary, then **Upload & create**. This records the objective and
   evidence without launching a calculation.
3. Use the agent panel to prepare a proposal or import a candidate under
   **Plan & review**. The JSON file must contain the candidate object in
   `eigengrid.mission-candidate/v1` format. Upload new referenced evidence files.
4. Inspect the protocol, decisions, risks, exact content digest and approval
   bindings. An authorized reviewer supplies a reason and approves or rejects each
   applicable revision. Expired or changed revisions require a new review.
5. **Compile work units**, then **Request execution**. Requests identify the exact
   candidate and revision. The backend rechecks policy, evidence and approvals;
   Head dispatch controls and installation qualification still apply.
6. Follow **Work units**, **Results & evidence** and **Activity**. **Overview**
   separates scientific assessment from execution state. Downloads require current
   mission access and the exact content digest.
7. **Mission controls** contains cancellation with a reason. This requests
   reconciliation of admitted work; it does not claim immediate termination.

Mission status is checked every 15 seconds while the document is visible. New
records are announced without replacing a review form or silently changing the
reviewed revision. **Refresh view** retrieves the new state. Catalogs are paged
in batches of 100, with a 10,000-record browser bound.

## Agent panel

The agent always works within the selected mission and its canonical budget.
**Start task** reviews the prompt, opens a durable session, then explicitly invokes
resume as part of that user action. The UI uses the returned session ID and journal
cursor. It does not infer successful execution from a lost response.

The history selector discovers the current actor's sessions for this project,
mission and policy through `GET /api/v1/projects/:projectId/missions/:missionId/agent-sessions`.
The endpoint accepts `limit` (1–100) and an optional `after` session UUID; it never
runs inference. History survives browser and server restarts. Opening a saved task
or an existing session UUID is read-only. A changed policy can make an old session
inaccessible; the service does not silently rebind its authority.

A session URL retains the selected central view and `?session=<uuid>` across
reloads. Switching mission tabs preserves the panel. Session state is checked every
three seconds while visible. Responses render safe Markdown without raw HTML or
remote images; copy the response or inspect the journal when needed. These are
persisted session updates, not a second in-memory conversational runtime.

**Resume task**, **Reconcile task** and **Cancel task** use the existing canonical
service. Tool approval binds one call, its exact input digest and cursor, expires
after five minutes, and requires a separate resume. Scientific plan approval is
independent. Agent cancellation and scientific mission cancellation are separate.
Missing model configuration or unavailable dependencies are shown as backend
errors; there are no simulated assistant responses or production demo fallbacks.

## Interrupted requests

Before a mutation, the client saves only actor/project/mission IDs, operation,
random idempotency key and timestamp in sessionStorage. A verified application
rejection can also record that a response arrived. Scientific payloads, prompts,
credentials and CSRF tokens are never saved there.

An uncertain outcome blocks further mutations for that mission in the tab, including
after reload. **Check saved result** retrieves a completed response without repeating
the operation. **Reconcile with recorded state** observes canonical results for a
pending operation. An unresolved effect stays blocked for investigation.

Absence after a disconnected request does not establish failure: the request may
still be in flight. Only a verified rejection followed by an authorized absent lookup
can clear that rejected request. Do not erase recovery references to justify a retry.
Browser metadata supplements server idempotency; it is never execution authority.
Blocking sessionStorage disables mutations while reads remain available.

## Development and verification

`bun install --frozen-lockfile` installs the React workspace dependencies. Run
`bun run typecheck:web` for the frontend or `bun run typecheck` for both layers.
The browser entry is `apps/web/src/main.tsx`; UI state and rendering are React.
The small JavaScript API/request helpers retain their contract and recovery tests.
The production asset allowlist exposes only HTML, bundled JavaScript and CSS.
A Bun build-time macro embeds the browser bundle in all native builds with no
runtime source-tree dependency and no build-time environment-variable inlining.

Use the provisioned local installation with `bun run eigengrid serve` for a real
preview. No protected authority bypass is part of the application.

Tests cover React navigation, agent persistence across tabs, keyboard resizing,
task API requests, safe response rendering, lost acknowledgements and sign-out;
API tests cover actor/project isolation, session discovery, real PostgreSQL workflows,
CSRF, exact request contracts and recovery. Asset tests compile a native executable
and serve the application without its checkout or runtime asset files.

Component DOM tests do not establish visual layout or actual browser compatibility.
A real-browser visual, keyboard and narrow-screen pass remains required before
release promotion. Scientific installation qualification remains separate.
