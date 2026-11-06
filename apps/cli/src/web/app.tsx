import { useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ToolActivity } from "./store";
import { commands, filterCommands, resolveTheme, type Command, type Theme } from "./commands";

interface Chat {
  id: string;
  title: string;
  updatedAt: string;
  messages: ChatMessage[];
  pendingPrompt?: string;
}
interface Settings {
  configured: boolean;
  model: string | null;
  provider: string | null;
  authMode: string | null;
  reason: string | null;
}
interface State {
  project: string;
  projectPath: string;
  connectionDirectory: string;
  chats: Omit<Chat, "messages">[];
  settings: Settings;
  activeId?: string;
}
const accessHash = new URLSearchParams(location.hash.slice(1));
const setupCode = accessHash.get("setup") ?? "";
const invitationCode = accessHash.get("invite") ?? "";
if (location.hash) history.replaceState(null, "", location.pathname);
sessionStorage.removeItem("eigengrid-access");
async function api(path: string, method = "GET", data?: unknown) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...(method !== "GET" && data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("eigengrid-session-expired"));
    const error = await response.json();
    throw new Error(error.error ?? "No se pudo conectar");
  }
  return response;
}
function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    moon: <path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10Z" />,
    sun: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
      </>
    ),
    monitor: (
      <>
        <rect x="3" y="4" width="18" height="13" rx="2" />
        <path d="M8 21h8m-4-4v4" />
      </>
    ),
    edit: (
      <>
        <path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-4-4L5 15Z" />
      </>
    ),
    retry: (
      <>
        <path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
      </>
    ),
    steer: (
      <>
        <path d="M5 20v-6a5 5 0 0 1 5-5h9m-5-5 5 5-5 5" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="M12 19V5m-6 6 6-6 6 6" />,
    chat: <path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2 1.7-5A8 8 0 1 1 20 11.5Z" />,
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="3" />
        <circle cx="15" cy="17" r="3" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    trash: (
      <>
        <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7" />
      </>
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
    book: (
      <>
        <path d="M12 5v15M3 4c5-1 9 1 9 1s4-2 9-1v14c-5-1-9 2-9 2s-4-3-9-2Z" />
      </>
    ),
    activity: <path d="M2 12h4l3-8 6 16 3-8h4" />,
    terminal: (
      <>
        <path d="m5 6 6 6-6 6m9 0h6" />
      </>
    ),
    copy: (
      <>
        <rect x="8" y="8" width="12" height="12" rx="2" />
        <path d="M16 8V4H4v12h4" />
      </>
    ),
    panel: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.chat}
    </svg>
  );
}
function Mark({ small = false }: { small?: boolean }) {
  return (
    <span className={`mark ${small ? "small" : ""}`} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
function Copy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy"
      aria-label="Copiar respuesta"
      onClick={() =>
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          })
          .catch(() => setCopied(false))
      }
    >
      <Icon name={copied ? "check" : "copy"} size={15} />
      {copied ? "Copiado" : "Copiar"}
    </button>
  );
}
function CodeBlock({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>CÓDIGO</span>
        <button
          className="text-button"
          onClick={() =>
            void navigator.clipboard.writeText(ref.current?.innerText ?? "").then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            })
          }
        >
          <Icon name={copied ? "check" : "copy"} size={13} />
          {copied ? "Copiado" : "Copiar código"}
        </button>
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}
function Tools({ tools }: { tools: ToolActivity[] }) {
  return (
    <div className="tools">
      {tools.map((t, i) => (
        <details key={i}>
          <summary>
            <Icon name="terminal" size={15} />
            <span>{t.name}</span>
            <span className={t.ok === false ? "tool-error" : "tool-state"}>
              {t.ok === undefined ? "En curso" : t.ok ? "Completado" : "No completado"}
            </span>
          </summary>
          <pre>{JSON.stringify(t.result ?? t.args, null, 2)}</pre>
        </details>
      ))}
    </div>
  );
}
function SettingsDialog({
  settings,
  directory,
  close,
  saved,
}: {
  settings: Settings;
  directory: string;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} onCancel={close}>
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">CONFIGURACIÓN DEL CLI</span>
          <h2>Una sola conexión</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Cerrar configuración"
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </div>
      <p>
        La web utiliza el proveedor, la cuenta y el modelo seleccionados en EigenGrid CLI. No
        necesitas introducir claves aquí.
      </p>
      <dl className="connection-details">
        <dt>Modelo</dt>
        <dd>{settings.model ?? "Sin configurar"}</dd>
        <dt>Acceso</dt>
        <dd>
          {settings.authMode === "chatgpt"
            ? "Cuenta de ChatGPT"
            : settings.authMode === "api-key"
              ? "Conexión API del CLI"
              : "Sin configurar"}
        </dd>
        <dt>Directorio de conexión</dt>
        <dd>
          <code>{directory}</code>
        </dd>
      </dl>
      <p>
        Para cambiarlo, abre <code>eigengrid</code> desde ese directorio y usa <code>/connect</code>{" "}
        y <code>/models</code>.
      </p>
      <p className="hint">
        Los cambios se leen antes de cada mensaje. Las credenciales y la renovación de la sesión
        siguen a cargo del CLI.
      </p>
      {settings.reason && <p className="error">{settings.reason}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button className="primary" onClick={() => void saved().catch((e) => setError(e.message))}>
        Actualizar estado del CLI
      </button>
    </dialog>
  );
}
const starters = [
  {
    icon: "activity",
    title: "Revisa mi proyecto",
    text: "Consulta trabajos, nodos y resultados.",
    prompt:
      "Revisa el estado actual del proyecto: trabajos, nodos y resultados disponibles. Distingue lo observado de lo que aún falta verificar.",
  },
  {
    icon: "book",
    title: "Explora un protocolo",
    text: "Encuentra un punto de partida científico.",
    prompt:
      "¿Qué protocolos científicos están disponibles? Muéstrame sus usos, límites y estado de revisión.",
  },
  {
    icon: "terminal",
    title: "Entiende un resultado",
    text: "Inspecciona evidencias y registros.",
    prompt:
      "Ayúdame a inspeccionar los resultados y registros disponibles. Identifica errores y próximos pasos sin ejecutar cambios.",
  },
];
function Dialog({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} onCancel={close} aria-label={title}>
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label="Cerrar diálogo"
          title="Cerrar · Esc"
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function AuthGate() {
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
    if (!response.ok) throw new Error("No se pudo conectar con EigenGrid.");
    setSession(await response.json());
  }
  useEffect(() => {
    void refreshSession().catch((e) => setError(e.message));
    const expired = () => {
      setSession((previous) => ({ ...previous, authenticated: false, setupRequired: false }));
      setPassword("");
      setError("Tu sesión terminó. Vuelve a iniciar sesión para continuar.");
    };
    window.addEventListener("eigengrid-session-expired", expired);
    return () => window.removeEventListener("eigengrid-session-expired", expired);
  }, []);
  async function login(event: FormEvent) {
    event.preventDefault();
    if (busy || !session) return;
    if (registering && password !== confirmation) {
      setError("Las contraseñas no coinciden.");
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
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (session?.authenticated)
    return (
      <App
        username={session.username ?? "Operador"}
        admin={session.role === "admin"}
        onLogout={() => {
          setSession({ authenticated: false, setupRequired: false });
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
          <span className="eyebrow">TU ESPACIO DE INVESTIGACIÓN</span>
          <h1>
            Una pregunta.
            <br />
            Un nuevo <em>camino.</em>
          </h1>
          <p>
            Conecta las ideas con la evidencia. Explora tu proyecto y conversa con tu asistente de
            química computacional.
          </p>
          <div className="auth-features">
            <span>
              <Icon name="chat" />
              Conversaciones que continúan
            </span>
            <span>
              <Icon name="activity" />
              Tu proyecto, en contexto
            </span>
            <span>
              <Icon name="book" />
              Protocolos y resultados a mano
            </span>
          </div>
        </div>
        <div className="auth-footnote">
          <span className="status-dot" />
          EigenGrid · Espacio de investigación
        </div>
      </section>
      <section className="auth-panel" aria-label="Acceso a EigenGrid">
        <div className="auth-card">
          <span className="eyebrow">BIENVENIDO A EIGENGRID</span>
          <h2>
            {invited
              ? "Activa tu cuenta"
              : session?.setupRequired
                ? "Prepara tu espacio"
                : "Continúa tu investigación"}
          </h2>
          <p>
            {registering
              ? "Crea tu cuenta para guardar tus conversaciones y acceder al proyecto."
              : "Inicia sesión para volver a tus conversaciones."}
          </p>
          {!session ? (
            <>
              <p role="status">Conectando con tu espacio…</p>
              {error && (
                <>
                  <p role="alert" className="error">
                    {error}
                  </p>
                  <button
                    className="primary"
                    onClick={() => void refreshSession().catch((e) => setError(e.message))}
                  >
                    Reintentar
                  </button>
                </>
              )}
            </>
          ) : (
            <form className="auth-form" onSubmit={(event) => void login(event)}>
              {session.setupRequired && !setupCode && (
                <label>
                  Código de configuración
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    type="password"
                    autoComplete="off"
                    required
                    placeholder="Código del enlace de la terminal"
                  />
                </label>
              )}
              <label>
                Usuario
                <input
                  name="username"
                  autoComplete="username"
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  maxLength={64}
                  placeholder="Tu usuario"
                />
              </label>
              <label>
                Contraseña
                <input
                  name="password"
                  type="password"
                  autoComplete={registering ? "new-password" : "current-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={registering ? 12 : 1}
                  maxLength={256}
                  placeholder={registering ? "Al menos 12 caracteres" : "Tu contraseña"}
                />
              </label>
              {registering && (
                <label>
                  Repite la contraseña
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
                {busy ? "Un momento…" : registering ? "Crear cuenta y entrar" : "Iniciar sesión"}
                <Icon name="chevron" size={18} />
              </button>
            </form>
          )}
          <p className="auth-note">
            Esta cuenta protege tu espacio EigenGrid. La conexión con tu modelo se configura por
            separado desde la CLI.
          </p>
        </div>
      </section>
    </main>
  );
}

function App({
  username,
  admin,
  onLogout,
}: {
  username: string;
  admin: boolean;
  onLogout: () => void;
}) {
  const [state, setState] = useState<State>();
  const [chat, setChat] = useState<Chat>();
  const [draft, setDraft] = useState(() => sessionStorage.getItem("eigengrid-draft:new") ?? "");
  const [busy, setBusy] = useState(false);
  const [steering, setSteering] = useState("");
  const [sendingSteer, setSendingSteer] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modal, setModal] = useState<"help" | "rename" | "delete" | null>(null);
  const [rename, setRename] = useState("");
  const [invitation, setInvitation] = useState<{ url: string; expires: string }>();
  const [sidebar, setSidebar] = useState(() => matchMedia("(min-width: 900px)").matches);
  const [search, setSearch] = useState("");
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("eigengrid-theme");
    return saved === "dark" || saved === "light" ? saved : "system";
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [editing, setEditing] = useState<number>();
  const [follow, setFollow] = useState(true);
  const [online, setOnline] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const initialized = useRef(false);
  const chatRef = useRef<Chat>();
  const editDraft = useRef("");
  const turnStarted = useRef(Date.now());
  const effectiveBusy = busy || !!(chat && state?.activeId === chat.id);
  const messages = chat?.messages ?? [];
  const palette = !menuDismissed && (menuOpen || (draft.startsWith("/") && !draft.includes("\n")));
  const query = draft.startsWith("/") ? draft.split(" ")[0]!.slice(1) : "";
  const choices = filterCommands(query);
  const visibleChats =
    state?.chats.filter((c) => c.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ??
    [];
  function showChat(value: Chat | undefined) {
    chatRef.current = value;
    setChat(value);
    if (value) sessionStorage.setItem("eigengrid-last-chat", value.id);
    else sessionStorage.removeItem("eigengrid-last-chat");
  }
  function notify(value: string) {
    setToast(value);
  }
  async function refresh() {
    const value = (await (await api("/state")).json()) as State;
    setState(value);
    setOnline(true);
    return value;
  }
  async function select(id: string) {
    if (lock.current) return;
    try {
      const value = await (await api(`/chats/${id}`)).json();
      showChat(value);
      setDraft(sessionStorage.getItem(`eigengrid-draft:${id}`) ?? "");
      setEditing(undefined);
      setError("");
      setFollow(true);
      if (matchMedia("(max-width: 899px)").matches) setSidebar(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function newChat() {
    if (effectiveBusy) {
      notify("Detén la respuesta antes de abrir una nueva conversación.");
      return;
    }
    showChat(undefined);
    setDraft("");
    sessionStorage.removeItem("eigengrid-draft:new");
    setEditing(undefined);
    setError("");
    setMenuOpen(false);
    setFollow(true);
    textarea.current?.focus();
  }
  async function stop() {
    if (!chatRef.current) return;
    try {
      await api(`/chats/${chatRef.current.id}/cancel`, "POST", {});
      setSteering("");
      notify("Se solicitó detener la respuesta.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function exportChat() {
    if (!chat) {
      notify("Abre una conversación para exportarla.");
      return;
    }
    const text =
      `# ${chat.title}\n\n` +
      chat.messages
        .map(
          (m) =>
            `## ${m.role === "user" ? "Tú" : "EigenGrid"}\n\n${m.content}${m.status === "redirected" ? "\n\n_Respuesta redirigida._" : ""}`,
        )
        .join("\n\n---\n\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${chat.title.replace(/[^\p{L}\p{N} -]/gu, "").slice(0, 60) || "eigengrid"}.md`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify("Conversación exportada en Markdown.");
  }
  function choose(command: Command) {
    if (draft.startsWith("/")) setDraft("");
    setMenuOpen(false);
    if (command.action === "prompt") {
      setDraft(command.prompt);
      textarea.current?.focus();
      return;
    }
    if (command.action === "new") newChat();
    if (command.action === "connection") setSettingsOpen(true);
    if (command.action === "help") setModal("help");
    if (command.action === "theme") setTheme((t) => (t === "dark" ? "light" : "dark"));
    if (command.action === "export") exportChat();
    if (command.action === "stop") void stop();
    if (command.action === "rename") {
      if (chat && !effectiveBusy) {
        setRename(chat.title);
        setModal("rename");
      } else notify("Abre una conversación sin respuesta en curso para renombrarla.");
    }
  }
  useEffect(() => {
    const layout = matchMedia("(min-width: 900px)");
    const changed = () => setSidebar(layout.matches);
    layout.addEventListener("change", changed);
    return () => layout.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    const sync = () => {
      void refresh()
        .then((value) => {
          if (!initialized.current) {
            initialized.current = true;
            const id = sessionStorage.getItem("eigengrid-last-chat");
            if (id && value.chats.some((c) => c.id === id)) void select(id);
          }
        })
        .catch((e) => {
          setOnline(false);
          setError(e.message);
        });
    };
    sync();
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, []);
  useEffect(() => {
    if (!state?.activeId || busy) return;
    const timer = setInterval(() => {
      void refresh()
        .then(async () => {
          const id = chatRef.current?.id;
          if (id) {
            const value = await (await api(`/chats/${id}`)).json();
            showChat(value);
            setSteering(value.pendingPrompt ?? "");
          }
        })
        .catch(() => setOnline(false));
    }, 1200);
    return () => clearInterval(timer);
  }, [state?.activeId, busy]);
  useEffect(() => {
    sessionStorage.setItem(`eigengrid-draft:${chat?.id ?? "new"}`, draft);
    if (textarea.current) {
      textarea.current.style.height = "auto";
      textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 200)}px`;
    }
  }, [draft, chat?.id]);
  useEffect(() => {
    const system = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(theme, system.matches);
    };
    localStorage.setItem("eigengrid-theme", theme);
    apply();
    system.addEventListener("change", apply);
    return () => system.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    if (follow) end.current?.scrollIntoView({ block: "end", behavior: "instant" });
  }, [chat?.messages, follow, steering]);
  useEffect(() => {
    setMenuIndex(0);
  }, [query]);
  useEffect(() => {
    if (!palette) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target as Element).closest(".composer")) {
        setMenuOpen(false);
        setMenuDismissed(true);
      }
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [palette]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - turnStarted.current) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey) {
        if (event.key.toLowerCase() === "k") {
          event.preventDefault();
          setMenuDismissed(palette);
          setMenuOpen(!palette);
          textarea.current?.focus();
        }
        if (event.key.toLowerCase() === "b") {
          event.preventDefault();
          setSidebar((v) => !v);
        }
        if (event.shiftKey && event.key.toLowerCase() === "o") {
          event.preventDefault();
          newChat();
        }
        if (event.shiftKey && event.key.toLowerCase() === "f") {
          event.preventDefault();
          setSidebar(true);
          searchInput.current?.focus();
        }
      }
      if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
        if (palette) {
          setMenuOpen(false);
          setMenuDismissed(true);
        } else if (effectiveBusy) void stop();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  async function send(event?: FormEvent, override?: string, forkIndex?: number) {
    event?.preventDefault();
    const prompt = (override ?? draft).trim();
    if (!prompt) return;
    if (prompt.startsWith("/") && !override) {
      const cmd = commands.find((c) => `/${c.name}` === prompt.split(/\s/)[0]);
      if (cmd) choose(cmd);
      else {
        setError("Comando no reconocido. Escribe / para ver los disponibles.");
        setMenuDismissed(false);
        setMenuOpen(true);
      }
      return;
    }
    if (effectiveBusy) {
      if (sendingSteer || steering || !chatRef.current) return;
      setSendingSteer(true);
      setError("");
      try {
        await api(`/chats/${chatRef.current.id}/steer`, "POST", { prompt });
        setDraft((current) => (current.trim() === prompt ? "" : current));
        if (!busy) setSteering(prompt);
        setFollow(true);
      } catch (e) {
        setError((e as Error).message);
        void refresh().catch(() => {});
      } finally {
        setSendingSteer(false);
        textarea.current?.focus();
      }
      return;
    }
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setElapsed(0);
    turnStarted.current = Date.now();
    setError("");
    setMenuOpen(false);
    setFollow(true);
    setDraft("");
    let current = chatRef.current;
    try {
      const branch = forkIndex ?? editing;
      if (branch !== undefined && current)
        current = (await (
          await api(`/chats/${current.id}/fork`, "POST", { messageIndex: branch })
        ).json()) as Chat;
      if (!current) current = (await (await api("/chats", "POST", {})).json()) as Chat;
      setEditing(undefined);
      sessionStorage.removeItem("eigengrid-draft:new");
      let rows: ChatMessage[] = [
        ...current.messages,
        { role: "user", content: prompt },
        { role: "assistant", content: "", tools: [] },
      ];
      let answer = rows.at(-1)!;
      showChat({ ...current, messages: [...rows] });
      const response = await api(`/chats/${current.id}/messages`, "POST", { prompt });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let pending = "",
        complete = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop()!;
        for (const line of lines) {
          if (!line) continue;
          const item = JSON.parse(line);
          if (item.type === "heartbeat") continue;
          if (item.type === "done") {
            showChat(item.chat);
            complete = true;
            continue;
          }
          if (item.type === "steering") {
            setSteering(item.prompt);
            continue;
          }
          if (item.type === "turn") {
            current = item.chat as Chat;
            rows = [...current.messages, { role: "assistant", content: "", tools: [] }];
            answer = rows.at(-1)!;
            setSteering("");
            turnStarted.current = Date.now();
            setElapsed(0);
          }
          if (item.type === "text") answer.content += item.text;
          if (item.type === "tool-call") answer.tools!.push({ name: item.name, args: item.args });
          if (item.type === "tool-result") {
            const tool = [...answer.tools!]
              .reverse()
              .find((t) => t.name === item.name && t.ok === undefined);
            if (tool) {
              tool.result = item.result;
              tool.ok = item.ok;
            }
          }
          showChat({ ...current!, messages: [...rows] });
        }
      }
      if (!complete)
        throw new Error(
          "Se perdió la conexión. Tu conversación sigue guardada; vuelve a abrirla para consultar su estado.",
        );
    } catch (e) {
      setError((e as Error).message);
      if (current) {
        try {
          showChat(await (await api(`/chats/${current.id}`)).json());
        } catch {
          setOnline(false);
        }
      }
      setDraft((value) => value || prompt);
    } finally {
      lock.current = false;
      setBusy(false);
      setSteering("");
      void refresh().catch(() => setOnline(false));
      textarea.current?.focus();
    }
  }
  function edit(index: number) {
    if (effectiveBusy) return;
    editDraft.current = draft;
    setEditing(index);
    setDraft(messages[index]!.content);
    textarea.current?.focus();
    setFollow(true);
  }
  async function renameChat(event: FormEvent) {
    event.preventDefault();
    if (!chat) return;
    try {
      showChat(await (await api(`/chats/${chat.id}`, "PATCH", { title: rename })).json());
      setModal(null);
      await refresh();
      notify("Nombre actualizado.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function remove() {
    if (!chat || effectiveBusy) return;
    try {
      await api(`/chats/${chat.id}`, "DELETE", {});
      sessionStorage.removeItem(`eigengrid-draft:${chat.id}`);
      showChat(undefined);
      setDraft("");
      setModal(null);
      await refresh();
      notify("Conversación eliminada.");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function retry(index: number) {
    const target = messages
      .slice(0, index)
      .map((m, i) => (m.role === "user" ? i : -1))
      .filter((i) => i >= 0)
      .at(-1);
    if (target !== undefined) void send(undefined, messages[target]!.content, target);
  }
  return (
    <div className={`app ${sidebar ? "sidebar-open" : ""}`}>
      <aside
        className={`sidebar ${sidebar ? "visible" : ""}`}
        aria-label="Historial de conversaciones"
      >
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            newChat();
          }}
        >
          <Mark small />
          <span>
            eigengrid<span className="brand-dot">.</span>
          </span>
          <span className="beta">WEB</span>
        </a>
        <button
          className="new-chat"
          disabled={effectiveBusy}
          title="Nueva conversación · Ctrl+Shift+O"
          onClick={newChat}
        >
          <Icon name="plus" size={18} />
          Nueva conversación<kbd>⌘ O</kbd>
        </button>
        <div className="history-heading">
          CONVERSACIONES<span>{state?.chats.length ?? 0}</span>
        </div>
        <input
          ref={searchInput}
          className="search"
          aria-label="Buscar conversaciones"
          placeholder="Buscar en el historial…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <nav className="history">
          {visibleChats.map((c) => (
            <button
              key={c.id}
              title={c.title}
              aria-current={chat?.id === c.id ? "page" : undefined}
              className={chat?.id === c.id ? "selected" : ""}
              disabled={busy}
              onClick={() => void select(c.id)}
            >
              <Icon name="chat" size={16} />
              <span>
                {c.title}
                <small>
                  {new Date(c.updatedAt).toLocaleDateString("es", {
                    day: "numeric",
                    month: "short",
                  })}
                </small>
              </span>
            </button>
          ))}
          {!visibleChats.length && (
            <div className="empty-history">
              <Icon name="chat" size={25} />
              <p>{search ? "Sin coincidencias" : "Tus ideas empiezan aquí."}</p>
              <span>{search ? "Prueba con otro nombre." : "Tu historial es privado."}</span>
            </div>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-note">
            <span className={`status-dot ${online ? "" : "offline"}`} />
            <div>
              {online ? "Espacio conectado" : "Servidor sin conexión"}
              <small>
                {state?.settings.configured
                  ? `${state.settings.authMode === "chatgpt" ? "ChatGPT" : "API"} · conexión del CLI`
                  : "Configura /connect en el CLI"}
              </small>
            </div>
          </div>
          <button
            className="settings-button"
            onClick={() => {
              setMenuDismissed(false);
              setMenuOpen(true);
              textarea.current?.focus();
            }}
          >
            <Icon name="terminal" size={18} />
            Comandos y acciones<kbd>⌘ K</kbd>
          </button>
          <button
            className="settings-button"
            disabled={!state}
            onClick={() => setSettingsOpen(true)}
          >
            <Icon name="settings" size={18} />
            Conexión del CLI
            <Icon name="chevron" size={14} />
          </button>
          <div className="sidebar-footer">
            <span>EigenGrid · Experimental</span>
            <button className="text-button" onClick={() => setModal("help")}>
              Atajos ↗
            </button>
          </div>
        </div>
      </aside>
      {sidebar && (
        <button
          className="sidebar-scrim"
          aria-label="Cerrar menú lateral"
          onClick={() => setSidebar(false)}
        />
      )}
      {invitation && (
        <Dialog title="Invitar a tu equipo" close={() => setInvitation(undefined)}>
          <p>
            Comparte este enlace con la persona que quieras invitar al proyecto. Podrá crear su
            cuenta y tendrá su propio historial privado.
          </p>
          <input
            className="search"
            aria-label="Enlace de invitación"
            readOnly
            value={invitation.url}
            onFocus={(e) => e.target.select()}
          />
          <p className="hint">
            El enlace sirve una vez y caduca el {new Date(invitation.expires).toLocaleString("es")}.
          </p>
          <button
            className="primary"
            onClick={() =>
              void navigator.clipboard
                .writeText(invitation.url)
                .then(() => notify("Invitación copiada."))
                .catch(() => notify("Selecciona el enlace y cópialo."))
            }
          >
            Copiar invitación
          </button>
        </Dialog>
      )}
      <main>
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button"
              title="Mostrar u ocultar historial · Ctrl+B"
              aria-label="Mostrar u ocultar historial"
              onClick={() => setSidebar(!sidebar)}
            >
              <Icon name="panel" />
            </button>
            <div>
              <span className="project-label" title={state?.projectPath}>
                {state?.project ?? "EigenGrid"}
              </span>
              <strong title={chat?.title}>{chat?.title ?? "Nueva conversación"}</strong>
            </div>
          </div>
          <div className="top-actions">
            {admin && (
              <button
                className="icon-button"
                aria-label="Invitar usuario"
                title="Invitar usuario"
                onClick={() =>
                  void api("/admin/invitations", "POST", {})
                    .then(async (response) => setInvitation(await response.json()))
                    .catch((e) => setError(e.message))
                }
              >
                <Icon name="plus" size={17} />
              </button>
            )}
            <button
              className="text-button logout-button"
              title={`Cerrar sesión de ${username}`}
              onClick={() =>
                void api("/auth/logout", "POST", {})
                  .then(() => {
                    for (const key of Object.keys(sessionStorage))
                      if (key.startsWith("eigengrid-draft:") || key === "eigengrid-last-chat")
                        sessionStorage.removeItem(key);
                    onLogout();
                  })
                  .catch((e) => setError(e.message))
              }
            >
              Cerrar sesión
            </button>
            <label className="theme-control">
              <Icon
                name={theme === "dark" ? "moon" : theme === "light" ? "sun" : "monitor"}
                size={17}
              />
              <select
                aria-label="Tema"
                value={theme}
                onChange={(e) => setTheme(e.target.value as Theme)}
              >
                <option value="system">Sistema</option>
                <option value="light">Claro</option>
                <option value="dark">Oscuro</option>
              </select>
            </label>
            {chat && (
              <>
                <button
                  className="icon-button"
                  title="Renombrar conversación"
                  aria-label="Renombrar conversación"
                  disabled={effectiveBusy}
                  onClick={() => {
                    setRename(chat.title);
                    setModal("rename");
                  }}
                >
                  <Icon name="edit" size={17} />
                </button>
                <button
                  className="icon-button"
                  title="Exportar Markdown"
                  aria-label="Exportar conversación"
                  onClick={exportChat}
                >
                  <Icon name="download" size={17} />
                </button>
                <button
                  className="icon-button danger"
                  title="Eliminar conversación"
                  aria-label="Eliminar conversación"
                  disabled={effectiveBusy}
                  onClick={() => setModal("delete")}
                >
                  <Icon name="trash" size={17} />
                </button>
              </>
            )}
          </div>
        </header>
        <div
          className="conversation"
          ref={scroller}
          onScroll={() => {
            const el = scroller.current!;
            setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 100);
          }}
        >
          <div className={`content ${messages.length ? "has-messages" : "welcome"}`}>
            {!messages.length ? (
              <>
                <div className="welcome-mark">
                  <Mark />
                  <span className="orbit orbit-one" />
                  <span className="orbit orbit-two" />
                </div>
                <div className="eyebrow">TU ASISTENTE DE QUÍMICA COMPUTACIONAL</div>
                <h1>
                  De la pregunta
                  <br />
                  al siguiente <em>paso.</em>
                </h1>
                <p className="intro">
                  Explora protocolos, entiende tus resultados y consulta
                  <br className="desktop-break" /> tu proyecto. Una conversación, todas tus
                  herramientas.
                </p>
                <div className="starters">
                  {starters.map((s) => (
                    <button
                      key={s.title}
                      onClick={() => {
                        setDraft(s.prompt);
                        textarea.current?.focus();
                      }}
                    >
                      <span className="starter-icon">
                        <Icon name={s.icon} />
                      </span>
                      <strong>{s.title}</strong>
                      <span>{s.text}</span>
                      <span className="starter-arrow">↗</span>
                    </button>
                  ))}
                </div>
                <button
                  className="discover-commands"
                  onClick={() => {
                    setMenuDismissed(false);
                    setMenuOpen(true);
                    textarea.current?.focus();
                  }}
                >
                  <kbd>/</kbd>Descubre los comandos disponibles
                  <Icon name="chevron" size={14} />
                </button>
              </>
            ) : (
              <div className="messages">
                {messages.map((message, i) => (
                  <article className={`message ${message.role}`} key={i}>
                    {message.role === "assistant" && (
                      <div className="assistant-label">
                        <Mark small />
                        <strong>EigenGrid</strong>
                        <span>
                          {message.status === "redirected"
                            ? "REDIRIGIDO"
                            : message.status === "stopped"
                              ? "DETENIDO"
                              : "ASISTENTE"}
                        </span>
                        {message.durationMs !== undefined && (
                          <small>{(message.durationMs / 1000).toFixed(1)} s</small>
                        )}
                      </div>
                    )}
                    <div className="message-body">
                      {message.tools && <Tools tools={message.tools} />}
                      <div className="markdown">
                        <Markdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            a: ({ children, href }) => (
                              <a href={href} target="_blank" rel="noopener noreferrer">
                                {children}
                              </a>
                            ),
                            img: ({ alt }) => <span>[Imagen externa: {alt ?? "imagen"}]</span>,
                            pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
                          }}
                        >
                          {message.content}
                        </Markdown>
                      </div>
                      {message.error && (
                        <div
                          className={`message-notice ${message.status === "redirected" || message.status === "stopped" ? "neutral" : ""}`}
                        >
                          {message.status === "redirected"
                            ? "La respuesta se interrumpió para incorporar tu nueva indicación."
                            : message.status === "stopped"
                              ? "Detuviste esta respuesta. Puedes continuar cuando quieras."
                              : /approval|aprobaci[oó]n/i.test(message.content)
                                ? "Continúa esta acción con aprobación desde el CLI."
                                : /api key|credential|auth|unauthorized|401|403/i.test(
                                      message.content,
                                    )
                                  ? "Revisa /connect en el CLI y vuelve a intentarlo."
                                  : "No se pudo completar la respuesta. Puedes reintentar en una nueva rama."}
                        </div>
                      )}
                      {effectiveBusy &&
                        i === messages.length - 1 &&
                        message.role === "assistant" && (
                          <div className="thinking" role="status">
                            <i />
                            <i />
                            <i />
                            <span>
                              {steering
                                ? "Aplicando tu nueva indicación…"
                                : message.content
                                  ? "Respondiendo…"
                                  : "Preparando respuesta…"}{" "}
                              {busy ? `${elapsed} s` : ""}
                            </span>
                          </div>
                        )}
                      <div className="message-actions">
                        {message.content && <Copy text={message.content} />}
                        <button
                          className="text-button"
                          disabled={effectiveBusy}
                          title={
                            message.role === "user"
                              ? "Editar crea una nueva rama y conserva el original"
                              : "Reintentar crea una nueva rama"
                          }
                          onClick={() => (message.role === "user" ? edit(i) : retry(i))}
                        >
                          <Icon name={message.role === "user" ? "edit" : "retry"} size={14} />
                          {message.role === "user" ? "Editar" : "Reintentar"}
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
            <div ref={end} />
          </div>
        </div>
        <div className="composer-area">
          {!follow && messages.length > 0 && (
            <button
              className="jump-bottom"
              onClick={() => {
                setFollow(true);
                end.current?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              ↓ Ir al final
            </button>
          )}
          {error && (
            <div role="alert" className="error-banner">
              <span>{error}</span>
              <button
                className="text-button"
                onClick={() =>
                  void refresh()
                    .then(() => setError(""))
                    .catch((e) => setError(e.message))
                }
              >
                Reconectar
              </button>
              <button
                className="icon-button"
                aria-label="Cerrar aviso"
                onClick={() => setError("")}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          )}
          {editing !== undefined && (
            <div className="edit-banner">
              <Icon name="edit" size={16} />
              <span>Editando mensaje · se creará una nueva rama</span>
              <button
                className="text-button"
                onClick={() => {
                  setEditing(undefined);
                  setDraft(editDraft.current);
                }}
              >
                Cancelar
              </button>
            </div>
          )}
          {(steering || chat?.pendingPrompt) && (
            <div className="steering-banner" role="status">
              <Icon name="steer" size={16} />
              <span>
                {effectiveBusy ? "Nueva indicación:" : "Indicación guardada:"}{" "}
                {steering || chat?.pendingPrompt}
              </span>
              {!effectiveBusy && (
                <button
                  className="text-button"
                  onClick={() => {
                    setDraft(chat?.pendingPrompt ?? "");
                    textarea.current?.focus();
                  }}
                >
                  Recuperar
                </button>
              )}
            </div>
          )}
          {effectiveBusy && !busy && (
            <div className="edit-banner" role="status">
              Respuesta activa · recuperando el estado del servidor…
            </div>
          )}
          <form
            className={`composer ${effectiveBusy ? "generating" : ""}`}
            onSubmit={(event) => void send(event)}
          >
            {palette && (
              <div
                className="command-menu"
                role="listbox"
                id="command-menu"
                aria-label="Comandos disponibles"
              >
                <div className="command-menu-heading">
                  <span>COMANDOS</span>
                  <span>↑ ↓ navegar · Enter elegir · Esc cerrar</span>
                </div>
                {choices.length ? (
                  choices.map((command, i) => (
                    <button
                      type="button"
                      role="option"
                      id={`command-${i}`}
                      aria-selected={i === menuIndex}
                      className={i === menuIndex ? "active" : ""}
                      key={command.name}
                      onMouseEnter={() => setMenuIndex(i)}
                      onClick={() => choose(command)}
                    >
                      <span className="command-name">/{command.name}</span>
                      <span>
                        <strong>{command.label}</strong>
                        <small>{command.detail}</small>
                      </span>
                      <span className="command-group">{command.group}</span>
                    </button>
                  ))
                ) : (
                  <div className="command-empty">Sin comandos para “/{query}”. Prueba /help.</div>
                )}
              </div>
            )}
            <textarea
              ref={textarea}
              role="combobox"
              aria-label="Mensaje"
              aria-autocomplete="list"
              aria-expanded={palette}
              aria-controls={palette ? "command-menu" : undefined}
              aria-activedescendant={palette && choices.length ? `command-${menuIndex}` : undefined}
              placeholder={
                effectiveBusy
                  ? "Añade una indicación para redirigir la respuesta…"
                  : "Escribe un mensaje, o / para ver comandos…"
              }
              value={draft}
              rows={2}
              maxLength={16000}
              onChange={(e) => {
                setDraft(e.target.value);
                setMenuOpen(false);
                setMenuDismissed(false);
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (
                  palette &&
                  choices.length &&
                  ["ArrowDown", "ArrowUp", "Tab", "Enter"].includes(e.key) &&
                  !e.shiftKey
                ) {
                  e.preventDefault();
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    const next =
                      (menuIndex + (e.key === "ArrowDown" ? 1 : -1) + choices.length) %
                      choices.length;
                    setMenuIndex(next);
                    document
                      .getElementById(`command-${next}`)
                      ?.scrollIntoView({ block: "nearest" });
                  } else choose(choices[menuIndex] ?? choices[0]!);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-bottom">
              <div className="composer-left">
                <button
                  type="button"
                  className="command-trigger"
                  aria-label="Mostrar comandos"
                  title="Comandos · / o Ctrl+K"
                  aria-expanded={palette}
                  onClick={() => {
                    setMenuDismissed(palette);
                    setMenuOpen(!palette);
                    textarea.current?.focus();
                  }}
                >
                  /
                </button>
                <button
                  type="button"
                  className="model-picker"
                  disabled={!state}
                  onClick={() => setSettingsOpen(true)}
                  title="Configuración compartida con el CLI"
                >
                  <span className={`model-dot ${state?.settings.configured ? "" : "offline"}`} />
                  <span>{state?.settings.model ?? "Conectar CLI"}</span>
                  <span className="model-access">
                    {state?.settings.authMode === "chatgpt" ? "ChatGPT" : "CLI"}
                  </span>
                </button>
              </div>
              <div className="composer-actions">
                {draft.length > 14000 && <span className="char-count">{draft.length}/16000</span>}
                {effectiveBusy && (
                  <button
                    type="button"
                    className="stop-button"
                    title="Detener · Esc"
                    aria-label="Detener respuesta"
                    onClick={() => void stop()}
                  >
                    <Icon name="stop" size={16} />
                    Detener
                  </button>
                )}
                <button
                  className={`send ${effectiveBusy ? "steer-send" : ""}`}
                  aria-label={
                    effectiveBusy
                      ? "Redirigir respuesta"
                      : editing !== undefined
                        ? "Enviar edición en nueva rama"
                        : "Enviar mensaje"
                  }
                  title={
                    effectiveBusy
                      ? "Interrumpir e incorporar esta indicación · Enter"
                      : "Enviar · Enter"
                  }
                  disabled={!draft.trim() || !state || sendingSteer || !!steering}
                >
                  <Icon name={effectiveBusy ? "steer" : "arrow"} />
                </button>
              </div>
            </div>
          </form>
          <div className="composer-footnote">
            <span>
              {effectiveBusy
                ? "Puedes escribir mientras responde. Enter interrumpe y aplica tu indicación."
                : "Enter enviar · Shift+Enter nueva línea · / comandos"}
            </span>
            <span>
              Conexión del CLI ·{" "}
              {state?.settings.authMode === "chatgpt" ? "ChatGPT" : "Proveedor configurado"}
            </span>
          </div>
        </div>
      </main>
      {toast && (
        <div className="toast" role="status">
          <Icon name="check" size={16} />
          {toast}
        </div>
      )}
      {settingsOpen && state && (
        <SettingsDialog
          settings={state.settings}
          directory={state.connectionDirectory}
          close={() => setSettingsOpen(false)}
          saved={async () => {
            await refresh();
          }}
        />
      )}
      {modal === "help" && (
        <Dialog title="Comandos y atajos" close={() => setModal(null)}>
          <p>
            Escribe <kbd>/</kbd> o pulsa <kbd>Ctrl / ⌘ K</kbd> para abrir el menú. Las consultas
            preparan un mensaje; tú decides cuándo enviarlo.
          </p>
          <div className="help-shortcuts">
            {[
              ["Enter", "Enviar o redirigir"],
              ["Shift + Enter", "Nueva línea"],
              ["Esc", "Cerrar menú o detener respuesta"],
              ["Ctrl / ⌘ B", "Mostrar u ocultar historial"],
              ["Ctrl / ⌘ Shift O", "Nueva conversación"],
              ["Ctrl / ⌘ Shift F", "Buscar en el historial"],
            ].map(([key, label]) => (
              <div key={key}>
                <span>{label}</span>
                <kbd>{key}</kbd>
              </div>
            ))}
          </div>
          <p>
            Mientras responde puedes escribir una corrección. Al enviarla, se interrumpe la
            generación y se retoma la solicitud original con tu nueva indicación. Editar o
            reintentar crea una rama y conserva la conversación original.
          </p>
          <p>
            La cuenta, el modelo y las variantes siguen configurándose en el CLI. El chat web
            permite consulta y análisis; las acciones con efectos se continúan desde el CLI.
          </p>
        </Dialog>
      )}
      {modal === "rename" && (
        <Dialog title="Renombrar conversación" close={() => setModal(null)}>
          <form onSubmit={(e) => void renameChat(e)}>
            <label>
              Nombre
              <input
                autoFocus
                aria-label="Nombre de la conversación"
                value={rename}
                onChange={(e) => setRename(e.target.value)}
                maxLength={100}
                required
              />
            </label>
            <button className="primary" disabled={!rename.trim()}>
              Guardar nombre
            </button>
          </form>
        </Dialog>
      )}
      {modal === "delete" && (
        <Dialog title="Eliminar conversación" close={() => setModal(null)}>
          <p>Se eliminará “{chat?.title}” del historial local. Esta acción no se puede deshacer.</p>
          <div className="dialog-actions">
            <button className="secondary" onClick={() => setModal(null)}>
              Conservar
            </button>
            <button className="destructive" onClick={() => void remove()}>
              Eliminar conversación
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<AuthGate />);
