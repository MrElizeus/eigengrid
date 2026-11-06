# Web workspace

EigenGrid's React interface runs on the Bun backend included in `eigengrid web`.
The backend uses the same native agent, configuration reader, account renewal and
scientific tool registry as the CLI. HTTP APIs carry JSON and streamed NDJSON.
No separate Node or Python application server is required. Python scientific tools
remain part of the existing runtime.

## Local preview

```bash
bun install --frozen-lockfile
bun run eigengrid web --connection-dir ~
```

The server listens on `127.0.0.1:4317`. Use `--port 0` for a free port and
`--no-open` to suppress browser launch. The compiled CLI embeds the frontend;
source checkouts also work when launched from another project directory.

The first launch prints a private setup link. Open it to create the administrator
account, choosing a username and a password of at least 12 characters. After setup,
use your username and password. The setup code cannot create another administrator.
Model API keys and ChatGPT credentials are never login passwords for the web.

Local development defaults to SQLite under
`$XDG_STATE_HOME/eigengrid/web/<workspace-hash>/chats.sqlite`, or
`~/.local/state/eigengrid/web/...`. Pre-login prototype conversations in this local
database are assigned to the first administrator. Existing SQLite data is not
automatically transferred to PostgreSQL.

## Multiple accounts over the network

Use PostgreSQL and a TLS reverse proxy for network access. This is one shared
scientific workspace with separate private conversation histories, not separate
scientific projects per user. Every invited operator can inspect the configured
project through the allowed read tools. Administrators cannot read another user's
conversation through the web API.

1. Provision a dedicated PostgreSQL database and owner role for the web. Supply its
   connection string through `EIGENGRID_WEB_DATABASE_URL`, not command-line arguments.
   Startup creates the `eigengrid_web` schema with users, invitations and chats. It
   never changes the scientific job database or its migrations.
2. Configure the service account's model connection with the CLI's `/connect`,
   `/models` and `/variants`, in the directory selected by `--connection-dir`.
   Project tools use the configuration of the service's working directory.
3. Start the server with the exact public HTTPS origin:

   ```bash
   eigengrid web --no-open --port 4317 \
     --origin https://grid.example.org \
     --connection-dir /srv/eigengrid/model-connection
   ```

4. Route that hostname through a TLS reverse proxy to `127.0.0.1:4317`, preserving
   `Host` and disabling response buffering for the stream. Keep port 4317 private.
   The listener stays on loopback; `--origin` requires PostgreSQL and rejects HTTP,
   paths, credentials and ambiguous origins. Untrusted forwarded headers do not
   decide the allowed origin.
5. Use the initial setup link from the service log to create the administrator.
   Protect that log as it contains the first-use capability. In the web header,
   **Invitar usuario** creates a link that expires in 24 hours and can be redeemed
   once. Share it with the intended teammate. The teammate chooses their own
   username and password; open self-registration is disabled.

Deployment templates: [Caddyfile](../deploy/web/Caddyfile.example),
[systemd service](../deploy/web/eigengrid-web.service),
[environment file](../deploy/web/web.env.example). Replace the example hostname,
paths and database credentials before installation. Use a service account that can
read the intended project and its CLI-owned model configuration. Do not install the
example environment file with the placeholder password. No service is installed or
exposed merely by checking out this repository.

## Authentication and privacy

Passwords are stored as Argon2id hashes. Sessions use random opaque values in
HttpOnly, SameSite=Strict cookies; network sessions additionally use Secure and the
`__Host-` prefix. Session hashes live only in the Bun process, expire after 12 hours,
and are revoked on logout. Restarting the service requires signing in again but
preserves accounts and chats. Failed sign-ins are throttled per username and
concurrent password verification is bounded.

All chat reads, writes, deletion, forks, cancellation and steering are scoped to the
authenticated owner in the server and store queries. Invitation creation requires
an administrator. Invitation redemption and first-administrator creation are atomic.
Browser requests cannot supply owners, system messages, model context or tool receipts.
Mutations require the exact configured Origin and JSON content type. Login and setup
have the same origin checks. No CORS access is enabled.

This version runs one Bun application process. Sessions, throttling and active
inference coordination are process-local: do not put multiple instances behind a
load balancer. Back up the dedicated PostgreSQL database with your normal database
backup procedure. Password reset, account removal and organization SSO are not
implemented in this version; do not present this as an enterprise identity service.

## Model connection and permissions

Configure providers, accounts, models and reasoning variants in the CLI. The web
reads that connection again before each turn. ChatGPT sign-in does not fall back to
an API key. Secrets remain server-side; the browser receives connection status only.
Missing or disconnected model configuration does not prevent account login, but
blocks inference with instructions for the administrator.

The web supports inspection and assistance. Its file reader is confined to visible
workspace files, excluding credentials, hidden paths and database files, even when
the CLI uses Full Access. Shared CLI episodic memory is not read or written by web
conversations. Additional deny rules prevent scientific
submission, cancellation, parsing with effects, file writes and shell execution even
when CLI permissions are broader. Continue those actions and approvals in the CLI.
An administrator role controls invitations, not scientific execution authority.
There is one inference at a time across the workspace to preserve shared runtime and
model configuration isolation. Other users can still log in and read their histories.

## Conversation controls

- Answers and tool events stream while the composer remains editable. Enter sends;
  Shift+Enter inserts a newline. Send another message during inference to steer at
  the native agent's next sequential boundary, preserving observed tool results.
  A late instruction becomes a following turn after the current turn settles.
- Stop or Escape aborts further generation after any active tool settles. Partial
  text remains visible and is labeled as incomplete; it is never a successful result.
- Editing a message or retrying creates a branch. Context comes from server-owned
  visible text; the original remains available. Rename, search, copy and export chats.
- Drafts and the selected chat survive reload in the current browser tab. Logout
  removes drafts from that tab. Scrolling upward suspends auto-follow; **Ir al final**
  resumes it. Pending instructions interrupted by shutdown remain recoverable.
- Light, Dark and System themes, a responsive history panel, a searchable `/` command
  menu and keyboard shortcuts are included. Ctrl/Command+K opens commands, +B toggles
  history, +Shift+O starts a chat and +Shift+F searches history.

Markdown escapes HTML and does not fetch remote images. The interface is Spanish.
Transcripts and tool context are sent to the configured model provider when chatting;
local storage does not imply local inference.

## Verification

```bash
bun run typecheck
bun run lint
bun run build
bash scripts/release/test-postgres.sh apps/cli/src/web
```

Tests use disposable state and a temporary PostgreSQL database. They cover real native
agent tool round trips through an offline fixture provider, source assets outside the
checkout, restart persistence, authentication, invitation replay, TLS cookie flags,
origin checks, steering, cancellation and cross-user read/write isolation.
