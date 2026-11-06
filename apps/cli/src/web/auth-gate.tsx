import { useEffect, useState, type FormEvent } from "react";
import { api, clearWebDrafts, announceSessionChange } from "./client";
import { Icon, Mark } from "./icons";
import { Workspace } from "./workspace";
const accessHash = new URLSearchParams(location.hash.slice(1));
const setupCode = accessHash.get("setup") ?? "";
const invitationCode = accessHash.get("invite") ?? "";
if (location.hash) history.replaceState(null, "", location.pathname);
sessionStorage.removeItem("eigengrid-access");
export function AuthGate() {
  const [session, setSession] = useState<{
    authenticated: boolean;
    setupRequired: boolean;
    username?: string;
    role?: "admin" | "operator";
  }>();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [code, setCode] = useState(invitationCode || setupCode);
  const [invited, setInvited] = useState(!!invitationCode);
  const registering = invited || !!session?.setupRequired;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function refreshSession() {
    const response = await fetch("/api/auth/session", { credentials: "same-origin" });
    if (!response.ok) throw new Error("Unable to connect to EigenGrid.");
    setSession(await response.json());
  }
  useEffect(() => {
    void refreshSession().catch((e) => setError(e.message));
    const expired = () => {
      clearWebDrafts();
      setSession((previous) => ({ ...previous, authenticated: false, setupRequired: false }));
      setPassword("");
      setError("Your session ended. Sign in again to continue.");
    };
    const sync = () => {
      void refreshSession().catch((e) => setError(e.message));
    };
    const changed = (event: StorageEvent) => {
      if (event.key === "eigengrid-session-event") {
        clearWebDrafts();
        sync();
      }
    };
    window.addEventListener("focus", sync);
    window.addEventListener("storage", changed);
    window.addEventListener("eigengrid-session-expired", expired);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("storage", changed);
      window.removeEventListener("eigengrid-session-expired", expired);
    };
  }, []);
  async function login(event: FormEvent) {
    event.preventDefault();
    if (busy || !session) return;
    if (registering && password !== confirmation) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(
        invited ? "/auth/register" : session.setupRequired ? "/auth/setup" : "/auth/login",
        "POST",
        {
          username,
          password,
          ...(registering ? { code } : {}),
        },
      );
      setPassword("");
      setConfirmation("");
      setCode("");
      setInvited(false);
      await refreshSession();
      announceSessionChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (session?.authenticated)
    return (
      <Workspace
        key={session.username}
        username={session.username ?? "Operator"}
        admin={session.role === "admin"}
        onLogout={() => {
          setSession({ authenticated: false, setupRequired: false });
          clearWebDrafts();
          announceSessionChange();
          setError("");
        }}
      />
    );
  return (
    <main className="auth-page">
      <section className="auth-story">
        <a className="brand" href="/" aria-label="EigenGrid">
          <Mark />
          EigenGrid<span className="brand-dot">.</span>
        </a>
        <div className="auth-intro">
          <span className="eyebrow">YOUR RESEARCH WORKSPACE</span>
          <h1>
            One question.
            <br />A new <em>path.</em>
          </h1>
          <p>
            Connect ideas with evidence. Explore your project and talk to your computational
            chemistry assistant.
          </p>
          <div className="auth-features">
            <span>
              <Icon name="chat" />
              Conversations that continue
            </span>
            <span>
              <Icon name="activity" />
              Your project, in context
            </span>
            <span>
              <Icon name="book" />
              Protocols and results at hand
            </span>
          </div>
        </div>
        <div className="auth-footnote">
          <span className="status-dot" />
          EigenGrid · Research workspace
        </div>
      </section>
      <section className="auth-panel" aria-label="Sign in to EigenGrid">
        <div className="auth-card">
          <span className="eyebrow">WELCOME TO EIGENGRID</span>
          <h2>
            {invited
              ? "Activate your account"
              : session?.setupRequired
                ? "Set up your workspace"
                : "Continue your research"}
          </h2>
          <p>
            {registering
              ? "Create your account to save conversations and access the project."
              : "Sign in to return to your conversations."}
          </p>
          {!session ? (
            <>
              <p role="status">Connecting to your workspace…</p>
              {error && (
                <>
                  <p role="alert" className="error">
                    {error}
                  </p>
                  <button
                    className="primary"
                    onClick={() => void refreshSession().catch((e) => setError(e.message))}
                  >
                    Retry
                  </button>
                </>
              )}
            </>
          ) : (
            <form className="auth-form" onSubmit={(event) => void login(event)}>
              {session.setupRequired && !setupCode && (
                <label>
                  Setup code
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    type="password"
                    autoComplete="off"
                    required
                    placeholder="Code from the terminal link"
                  />
                </label>
              )}
              <label>
                Username
                <input
                  name="username"
                  autoComplete="username"
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  maxLength={64}
                  placeholder="Your username"
                />
              </label>
              <label>
                Password
                <input
                  name="password"
                  type="password"
                  autoComplete={registering ? "new-password" : "current-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={registering ? 12 : 1}
                  maxLength={256}
                  placeholder={registering ? "At least 12 characters" : "Your password"}
                />
              </label>
              {registering && (
                <label>
                  Confirm password
                  <input
                    name="confirmation"
                    type="password"
                    autoComplete="new-password"
                    value={confirmation}
                    onChange={(e) => setConfirmation(e.target.value)}
                    required
                    minLength={12}
                    maxLength={256}
                  />
                </label>
              )}
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              <button className="primary auth-submit" disabled={busy}>
                {busy ? "One moment…" : registering ? "Create account and sign in" : "Sign in"}
                <Icon name="chevron" size={18} />
              </button>
            </form>
          )}
          <p className="auth-note">
            This account protects your EigenGrid workspace. Configure your model connection
            separately in the CLI.
          </p>
        </div>
      </section>
    </main>
  );
}
