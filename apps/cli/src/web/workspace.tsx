import { HelpDialog } from "./help-dialog";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, clearWebDrafts } from "./client";
import { Icon, Mark } from "./icons";
import { Copy, CodeBlock, Tools } from "./messages";
import { SettingsDialog, Dialog } from "./dialogs";
import { starters } from "./starters";
import type { Theme } from "./commands";
import { useWorkspace } from "./use-workspace";
export function Workspace({
  username,
  admin,
  onLogout,
}: {
  username: string;
  admin: boolean;
  onLogout: () => void;
}) {
  const {
    state,
    chat,
    draft,
    setDraft,
    busy,
    steering,
    sendingSteer,
    error,
    setError,
    toast,
    settingsOpen,
    setSettingsOpen,
    modal,
    setModal,
    rename,
    setRename,
    invitation,
    setInvitation,
    sidebar,
    setSidebar,
    search,
    setSearch,
    theme,
    setTheme,
    setMenuOpen,
    setMenuDismissed,
    menuIndex,
    setMenuIndex,
    editing,
    setEditing,
    follow,
    setFollow,
    online,
    elapsed,
    textarea,
    scroller,
    end,
    searchInput,
    editDraft,
    effectiveBusy,
    messages,
    palette,
    query,
    choices,
    visibleChats,
    notify,
    refresh,
    select,
    newChat,
    stop,
    exportChat,
    choose,
    send,
    edit,
    renameChat,
    remove,
    retry,
  } = useWorkspace();
  return (
    <div className={`app ${sidebar ? "sidebar-open" : ""}`}>
      <aside className={`sidebar ${sidebar ? "visible" : ""}`} aria-label="Conversation history">
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
          title="New conversation · Ctrl+Shift+O"
          onClick={newChat}
        >
          <Icon name="plus" size={18} />
          New conversation<kbd>⌘ O</kbd>
        </button>
        <div className="history-heading">
          CONVERSATIONS<span>{state?.chats.length ?? 0}</span>
        </div>
        <input
          ref={searchInput}
          className="search"
          aria-label="Search conversations"
          placeholder="Search history…"
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
                  {new Date(c.updatedAt).toLocaleDateString("en", {
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
              <p>{search ? "No matches" : "Your ideas start here."}</p>
              <span>{search ? "Try another name." : "Your history is private."}</span>
            </div>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-note">
            <span className={`status-dot ${online ? "" : "offline"}`} />
            <div>
              {online ? "Workspace connected" : "Server offline"}
              <small>
                {state?.settings.configured
                  ? `${state.settings.authMode === "chatgpt" ? "ChatGPT" : "API"} · CLI connection`
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
            Commands and actions<kbd>⌘ K</kbd>
          </button>
          <button
            className="settings-button"
            disabled={!state}
            onClick={() => setSettingsOpen(true)}
          >
            <Icon name="settings" size={18} />
            CLI connection
            <Icon name="chevron" size={14} />
          </button>
          <div className="sidebar-footer">
            <span>EigenGrid · Experimental</span>
            <button className="text-button" onClick={() => setModal("help")}>
              Shortcuts ↗
            </button>
          </div>
        </div>
      </aside>
      {sidebar && (
        <button
          className="sidebar-scrim"
          aria-label="Close sidebar"
          onClick={() => setSidebar(false)}
        />
      )}
      {invitation && (
        <Dialog title="Invite your team" close={() => setInvitation(undefined)}>
          <p>
            Share this link with the person you want to invite to the project. They can create an
            account with their own private history.
          </p>
          <input
            className="search"
            aria-label="Invitation link"
            readOnly
            value={invitation.url}
            onFocus={(e) => e.target.select()}
          />
          <p className="hint">
            This link can be used once and expires on{" "}
            {new Date(invitation.expires).toLocaleString("en")}.
          </p>
          <button
            className="primary"
            onClick={() =>
              void navigator.clipboard
                .writeText(invitation.url)
                .then(() => notify("Invitation copied."))
                .catch(() => notify("Select the link and copy it."))
            }
          >
            Copy invitation
          </button>
        </Dialog>
      )}
      <main>
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button"
              title="Toggle history · Ctrl+B"
              aria-label="Toggle history"
              onClick={() => setSidebar(!sidebar)}
            >
              <Icon name="panel" />
            </button>
            <div>
              <span className="project-label" title={state?.projectPath}>
                {state?.project ?? "EigenGrid"}
              </span>
              <strong title={chat?.title}>{chat?.title ?? "New conversation"}</strong>
            </div>
          </div>
          <div className="top-actions">
            {admin && (
              <button
                className="icon-button"
                aria-label="Invite user"
                title="Invite user"
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
              title={`Sign out ${username}`}
              onClick={() =>
                void api("/auth/logout", "POST", {})
                  .then(() => {
                    clearWebDrafts();
                    onLogout();
                  })
                  .catch((e) => setError(e.message))
              }
            >
              Sign out
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
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            {chat && (
              <>
                <button
                  className="icon-button"
                  title="Rename conversation"
                  aria-label="Rename conversation"
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
                  title="Export Markdown"
                  aria-label="Export conversation"
                  onClick={exportChat}
                >
                  <Icon name="download" size={17} />
                </button>
                <button
                  className="icon-button danger"
                  title="Delete conversation"
                  aria-label="Delete conversation"
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
                <div className="eyebrow">YOUR COMPUTATIONAL CHEMISTRY ASSISTANT</div>
                <h1>
                  From the question
                  <br />
                  to the next <em>step.</em>
                </h1>
                <p className="intro">
                  Explore protocols, understand your results and inspect
                  <br className="desktop-break" /> your project. One conversation, all your tools.
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
                  <kbd>/</kbd>Explore available commands
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
                            ? "REDIRECTED"
                            : message.status === "stopped"
                              ? "STOPPED"
                              : "ASSISTANT"}
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
                            img: ({ alt }) => <span>[External image: {alt ?? "imagen"}]</span>,
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
                            ? "The response was interrupted to incorporate your new instruction."
                            : message.status === "stopped"
                              ? "You stopped this response. Continue whenever you are ready."
                              : /approval|aprobaci[oó]n/i.test(message.content)
                                ? "Continue this action with approval in the CLI."
                                : /api key|credential|auth|unauthorized|401|403/i.test(
                                      message.content,
                                    )
                                  ? "Revisa /connect en el CLI y vuelve a intentarlo."
                                  : "The response could not be completed. You can retry in a new branch."}
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
                                ? "Applying your new instruction…"
                                : message.content
                                  ? "Respondiendo…"
                                  : "Preparing response…"}{" "}
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
                              ? "Editing creates a new branch and preserves the original"
                              : "Retrying creates a new branch"
                          }
                          onClick={() => (message.role === "user" ? edit(i) : retry(i))}
                        >
                          <Icon name={message.role === "user" ? "edit" : "retry"} size={14} />
                          {message.role === "user" ? "Editar" : "Retry"}
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
              ↓ Jump to latest
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
                Reconnect
              </button>
              <button
                className="icon-button"
                aria-label="Dismiss notice"
                onClick={() => setError("")}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          )}
          {editing !== undefined && (
            <div className="edit-banner">
              <Icon name="edit" size={16} />
              <span>Editing message · a new branch will be created</span>
              <button
                className="text-button"
                onClick={() => {
                  setEditing(undefined);
                  setDraft(editDraft.current);
                }}
              >
                Cancel
              </button>
            </div>
          )}
          {(steering || chat?.pendingPrompt) && (
            <div className="steering-banner" role="status">
              <Icon name="steer" size={16} />
              <span>
                {effectiveBusy ? "New instruction:" : "Saved instruction:"}{" "}
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
                  Restore
                </button>
              )}
            </div>
          )}
          {effectiveBusy && !busy && (
            <div className="edit-banner" role="status">
              Response active · recovering server status…
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
                aria-label="Available commands"
              >
                <div className="command-menu-heading">
                  <span>COMMANDS</span>
                  <span>↑ ↓ navigate · Enter select · Esc close</span>
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
                  <div className="command-empty">No commands for “/{query}”. Try /help.</div>
                )}
              </div>
            )}
            <textarea
              ref={textarea}
              role="combobox"
              aria-label="Message"
              aria-autocomplete="list"
              aria-expanded={palette}
              aria-controls={palette ? "command-menu" : undefined}
              aria-activedescendant={palette && choices.length ? `command-${menuIndex}` : undefined}
              placeholder={
                effectiveBusy
                  ? "Add an instruction to redirect the response…"
                  : "Write a message, or / to see commands…"
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
                  aria-label="Show commands"
                  title="Commands · / or Ctrl+K"
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
                  title="Settings shared with the CLI"
                >
                  <span className={`model-dot ${state?.settings.configured ? "" : "offline"}`} />
                  <span>{state?.settings.model ?? "Connect CLI"}</span>
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
                    title="Stop · Esc"
                    aria-label="Stop response"
                    onClick={() => void stop()}
                  >
                    <Icon name="stop" size={16} />
                    Stop
                  </button>
                )}
                <button
                  className={`send ${effectiveBusy ? "steer-send" : ""}`}
                  aria-label={
                    effectiveBusy
                      ? "Redirect response"
                      : editing !== undefined
                        ? "Send edit in a new branch"
                        : "Send message"
                  }
                  title={
                    effectiveBusy ? "Interrupt and apply this instruction · Enter" : "Send · Enter"
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
                ? "You can type during a response. Enter interrupts and applies your instruction."
                : "Enter send · Shift+Enter new line · / commands"}
            </span>
            <span>
              CLI connection ·{" "}
              {state?.settings.authMode === "chatgpt" ? "ChatGPT" : "Configured provider"}
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
      {modal === "help" && <HelpDialog close={() => setModal(null)} />}
      {modal === "rename" && (
        <Dialog title="Rename conversation" close={() => setModal(null)}>
          <form onSubmit={(e) => void renameChat(e)}>
            <label>
              Name
              <input
                autoFocus
                aria-label="Conversation name"
                value={rename}
                onChange={(e) => setRename(e.target.value)}
                maxLength={100}
                required
              />
            </label>
            <button className="primary" disabled={!rename.trim()}>
              Save name
            </button>
          </form>
        </Dialog>
      )}
      {modal === "delete" && (
        <Dialog title="Delete conversation" close={() => setModal(null)}>
          <p>Delete “{chat?.title}” from your history? This action cannot be undone.</p>
          <div className="dialog-actions">
            <button className="secondary" onClick={() => setModal(null)}>
              Keep conversation
            </button>
            <button className="destructive" onClick={() => void remove()}>
              Delete conversation
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
