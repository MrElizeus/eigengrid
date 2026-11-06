import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, missionPath } from "./api.browser.js";
import { announceSessionChange, watchSessionChanges } from "./session.browser.js";
import type { Session, ScientificProjectSummary, ScientificMissionSummary } from "./contracts";
import { parseAddress, route } from "./navigation";
import { Action, Badge, Empty, errorText, date, Field, UiProvider } from "./ui";
import { MissionWorkspace } from "./mission";
import { CreateMission } from "./create";
import { Recovery } from "./recovery";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const checks = useRef(0);
  const check = useCallback(async () => {
    const sequence = ++checks.current;
    try {
      const current = await api.bootstrap();
      if (sequence !== checks.current) return;
      setSession(current);
      setError("");
    } catch (cause) {
      if (sequence !== checks.current) return;
      setSession(null);
      if (!(cause instanceof ApiError && cause.status === 401)) setError(errorText(cause));
    } finally {
      if (sequence === checks.current) setReady(true);
    }
  }, []);
  useEffect(() => {
    void check();
    const expired = () => {
      setSession(null);
      setError("Your session expired or access changed. Sign in to continue.");
    };
    window.addEventListener("eigengrid:session-expired", expired);
    const stop = watchSessionChanges(window, (event) => {
      if (event.type === "storage") {
        api.invalidateSession();
        setSession(null);
        setReady(false);
      }
      // Ordinary focus revalidates access while keeping the current user's drafts.
      void check();
    });
    return () => {
      stop();
      window.removeEventListener("eigengrid:session-expired", expired);
    };
  }, [check]);
  if (!ready)
    return (
      <main className="boot" role="status">
        Connecting to EigenGrid…
      </main>
    );
  return (
    <UiProvider key={session ? `${session.actor.id}/${session.csrfToken}` : "signed-out"}>
      {session ? (
        <Workspace
          session={session}
          signOut={async () => {
            await api.logout();
            announceSessionChange();
            setSession(null);
          }}
        />
      ) : (
        <Login
          error={error}
          onLogin={async (credential) => {
            await api.login(credential);
            announceSessionChange();
            await check();
          }}
        />
      )}
    </UiProvider>
  );
}
function Login({
  error,
  onLogin,
}: {
  error: string;
  onLogin: (credential: string) => Promise<void>;
}) {
  const [credential, setCredential] = useState("");
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main id="main" className="login">
      <div className="login-card">
        <span className="wordmark">EigenGrid</span>
        <h1>Sign in to your workspace</h1>
        <p className="muted">Your projects, scientific work and agent in one place.</p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            setFailure("");
            const value = credential.trim();
            setCredential("");
            try {
              await onLogin(value);
            } catch (cause) {
              setFailure(errorText(cause));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Access credential" hint="Use the credential issued by your administrator.">
            <input
              type="password"
              autoComplete="current-password"
              required
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
              autoFocus
            />
          </Field>
          <button className="primary" disabled={busy || !credential.trim()}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          {(failure || error) && (
            <p className="error-text" role="alert">
              {failure || error}
            </p>
          )}
        </form>
      </div>
    </main>
  );
}
function Workspace({ session, signOut }: { session: Session; signOut: () => Promise<void> }) {
  const [projects, setProjects] = useState<ScientificProjectSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [hash, setHash] = useState(location.hash);
  const [revision, setRevision] = useState(0);
  const [agentOpen, setAgentOpen] = useState(true);
  const refresh = useCallback(async () => {
    setRevision((value) => value + 1);
  }, []);
  useEffect(() => {
    const change = () => setHash(location.hash);
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void api
      .list<ScientificProjectSummary>("/projects", controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setProjects(value);
          setLoaded(true);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(errorText(cause));
          setLoaded(true);
        }
      });
    return () => controller.abort();
  }, [revision]);
  let address;
  try {
    address = parseAddress(hash, projects[0]?.id);
  } catch {
    return (
      <Empty title="Invalid workspace address">
        <a href="#/">Open workspace</a>
      </Empty>
    );
  }
  const project = projects.find((item) => item.id === address.projectId);
  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="wordmark" href={route(address.projectId)}>
          EigenGrid
        </a>
        <label className="project-picker">
          <span className="sr-only">Current project</span>
          <select
            value={project?.id ?? ""}
            disabled={!projects.length}
            onChange={(event) => {
              location.hash = route(event.target.value);
            }}
          >
            {!projects.length && <option value="">No projects</option>}
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <span className="header-spacer" />
        <span className="account-label" title={session.roles.join(", ")}>
          {session.actor.displayName ?? session.actor.id}
        </span>
        <Action run={signOut}>Sign out</Action>
      </header>
      <div className="workspace-bar">
        <nav aria-label="Workspace navigation">
          <a aria-current={!address.create ? "page" : undefined} href={route(address.projectId)}>
            Missions
          </a>
          {project && (
            <a aria-current={address.create ? "page" : undefined} href={`${route(project.id)}/new`}>
              New mission
            </a>
          )}
        </nav>
        <button
          aria-expanded={agentOpen}
          aria-controls="agent-panel"
          onClick={() => setAgentOpen((value) => !value)}
        >
          {agentOpen ? "Hide agent" : "Show agent"}
        </button>
      </div>
      {error ? (
        <main id="main">
          <Empty title="Workspace unavailable">
            <p>{error}</p>
            <Action run={refresh}>Try again</Action>
          </Empty>
        </main>
      ) : !loaded ? (
        <main id="main" className="boot" role="status">
          Loading projects…
        </main>
      ) : !project ? (
        <main id="main">
          <Empty title={projects.length ? "Project unavailable" : "No accessible projects"}>
            <p>
              {projects.length
                ? "Choose a project you have access to."
                : "Ask your administrator to assign project membership and access."}
            </p>
            <Action run={refresh}>Check again</Action>
          </Empty>
        </main>
      ) : address.missionId ? (
        <MissionWorkspace
          key={`${session.actor.id}/${project.id}/${address.missionId}`}
          address={address}
          agentOpen={agentOpen}
          closeAgent={() => setAgentOpen(false)}
        />
      ) : (
        <div className={`workspace-grid ${agentOpen ? "with-agent" : ""}`}>
          <main id="main" tabIndex={-1}>
            {address.create ? (
              <CreateMission key={project.id} projectId={project.id} refresh={refresh} />
            ) : (
              <Dashboard key={project.id} project={project} refresh={refresh} revision={revision} />
            )}
          </main>
          {agentOpen && (
            <aside id="agent-panel" className="agent-panel">
              <header>
                <h2>Agent</h2>
                <button aria-label="Close agent panel" onClick={() => setAgentOpen(false)}>
                  Close
                </button>
              </header>
              <Empty title="Work with your mission agent">
                <p>
                  Open a mission to plan, inspect evidence or analyze results with its full context.
                </p>
                <p>The agent stays alongside your work as you switch views.</p>
                {!address.create && (
                  <a className="button primary" href={`${route(project.id)}/new`}>
                    Create a mission
                  </a>
                )}
              </Empty>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
function Dashboard({
  project,
  refresh,
  revision,
}: {
  project: ScientificProjectSummary;
  refresh: () => Promise<void>;
  revision: number;
}) {
  const [missions, setMissions] = useState<ScientificMissionSummary[] | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  useEffect(() => {
    const controller = new AbortController();
    void api
      .list<ScientificMissionSummary>(missionPath(project.id), controller.signal)
      .then(setMissions)
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorText(cause));
      });
    return () => controller.abort();
  }, [project.id, revision]);
  const items = (missions ?? [])
    .filter(
      (item) =>
        (filter === "all" || item.state === filter) &&
        `${item.id} ${item.statement} ${item.targetProperties.join(" ")}`
          .toLowerCase()
          .includes(search.toLowerCase().trim()),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{project.name}</p>
          <h1>Missions</h1>
          <p className="muted">Define a question. Follow the work and its evidence.</p>
        </div>
        <a className="button primary" href={`${route(project.id)}/new`}>
          New mission
        </a>
      </div>
      <Recovery projectId={project.id} refresh={refresh} />
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      <div className="catalog-toolbar">
        <input
          type="search"
          aria-label="Search missions"
          placeholder="Search missions…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          aria-label="Filter mission state"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          <option value="all">All states</option>
          {[...new Set((missions ?? []).map((item) => item.state))].sort().map((state) => (
            <option key={state}>{state}</option>
          ))}
        </select>
        <Action run={refresh}>Refresh</Action>
      </div>
      <p className="muted catalog-count" role="status">
        {missions ? `${items.length} of ${missions.length} missions` : "Loading missions…"}
      </p>
      {!!items.length && (
        <div className="mission-list">
          {items.map((item) => (
            <a className="mission-row" key={item.id} href={route(project.id, item.id)}>
              <div>
                <h2>{item.statement}</h2>
                <p className="muted">{item.targetProperties.join(" · ")}</p>
                <small>{item.id}</small>
              </div>
              <div>
                <Badge value={item.state} />
                <time dateTime={item.updatedAt}>{date(item.updatedAt)}</time>
              </div>
            </a>
          ))}
        </div>
      )}
      {missions && !items.length && (
        <Empty title={missions.length ? "No matching missions" : "No missions yet"}>
          {missions.length ? (
            <button
              onClick={() => {
                setSearch("");
                setFilter("all");
              }}
            >
              Clear filters
            </button>
          ) : (
            <p>Create a mission to define its objective, structure and budget.</p>
          )}
        </Empty>
      )}
    </div>
  );
}
