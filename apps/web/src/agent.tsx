import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, canonical, missionPath, sha256 } from "./api.browser.js";
import type { AgentRecord, AgentSession, AgentSummary, MissionView } from "./contracts";
import { sessionRoute } from "./navigation";
import { Action, Badge, Empty, errorText, Field, Inspect, useUi } from "./ui";

type State = AgentSession & { cancellationRequested?: boolean };
export function AgentPanel({
  view,
  sessionId,
  close,
}: {
  view: MissionView;
  sessionId?: string;
  close: () => void;
}) {
  const { confirm, notify } = useUi();
  const [sessions, setSessions] = useState<AgentSummary[]>([]);
  const [state, setState] = useState<State>();
  const [prompt, setPrompt] = useState("");
  const [existing, setExisting] = useState("");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const base = `${missionPath(view.projectId, view.missionId)}/agent-sessions`;
  const validId = !sessionId || /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(sessionId);
  const displayed = state?.sessionId === sessionId ? state : undefined;
  const fenced = api.outstanding(view.projectId, view.missionId).length > 0;
  useEffect(() => {
    const controller = new AbortController();
    void api
      .list<AgentSummary>(base, AbortSignal.any([view.signal, controller.signal]))
      .then((items) => {
        if (!controller.signal.aborted)
          setSessions(items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      })
      .catch((cause) => {
        if (!controller.signal.aborted && !view.signal.aborted) setError(errorText(cause));
      });
    return () => controller.abort();
  }, [base, view.signal, revision, sessionId]);
  useEffect(() => {
    setState(undefined);
    setError("");
    if (!sessionId || !validId) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, view.signal]);
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (signal.aborted) return;
      if (!document.hidden)
        try {
          const next = await api.get<State>(`${base}/${encodeURIComponent(sessionId!)}`, signal);
          if (!signal.aborted) {
            setState((old) => (!old || next.cursor.sequence >= old.cursor.sequence ? next : old));
            setError("");
          }
        } catch (cause) {
          if (!signal.aborted) setError(errorText(cause));
        }
      if (!signal.aborted) timer = setTimeout(() => void poll(), 3000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [base, sessionId, validId, view.signal, revision]);
  async function action(operation: string, request: unknown = {}) {
    if (!displayed) return;
    const result = await view.mutate(
      `agent.${operation}`,
      request,
      displayed.cursor.sequence,
      `/agent-sessions/${encodeURIComponent(displayed.sessionId)}/${operation}`,
    );
    setRevision((value) => value + 1);
    return result;
  }
  return (
    <aside id="agent-panel" className="agent-panel" aria-label="Mission agent">
      <header>
        <div>
          <h2>Agent</h2>
          <span className="muted">Mission context</span>
        </div>
        <button onClick={close} aria-label="Close agent panel">
          Close
        </button>
      </header>
      <div className="agent-context" title={view.provenance.mission.objective.statement}>
        {view.provenance.mission.objective.statement}
      </div>
      <div className="agent-toolbar">
        <select
          aria-label="Agent task history"
          value={sessionId ?? ""}
          onChange={(event) => {
            location.hash = event.target.value
              ? sessionRoute(view.projectId, view.missionId, event.target.value)
              : sessionRoute(view.projectId, view.missionId, "").replace("?session=", "");
          }}
        >
          <option value="">New task</option>
          {sessionId && !sessions.some((item) => item.sessionId === sessionId) && (
            <option value={sessionId}>Current session</option>
          )}
          {sessions.map((item) => (
            <option key={item.sessionId} value={item.sessionId}>
              {item.prompt.slice(0, 80)} · {item.phase}
            </option>
          ))}
        </select>
        <Action
          run={async () => {
            setRevision((value) => value + 1);
          }}
        >
          Refresh
        </Action>
      </div>
      <div className="agent-body">
        {!validId && (
          <p role="alert" className="error-text">
            The session address is invalid. Choose a recorded task.
          </p>
        )}
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        {fenced && (
          <p className="agent-warning" role="status">
            An operation needs a result check. Resolve it in the mission before sending another
            request.
          </p>
        )}
        {!sessionId && (
          <>
            <Empty title="What should we work on?">
              <p>Ask the agent to prepare a plan, inspect evidence or analyze this mission.</p>
            </Empty>
            <details>
              <summary>Open a session by ID</summary>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  location.hash = sessionRoute(view.projectId, view.missionId, existing.trim());
                }}
              >
                <Field label="Session UUID">
                  <input
                    value={existing}
                    onChange={(event) => setExisting(event.target.value)}
                    required
                    pattern="[a-fA-F0-9]{8}-([a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}"
                  />
                </Field>
                <button>Open session</button>
              </form>
            </details>
          </>
        )}
        {sessionId && validId && !displayed && !error && (
          <p role="status">Loading agent session…</p>
        )}
        {displayed && (
          <>
            <div className="message user">
              <span className="message-role">You</span>
              <p>{displayed.prompt}</p>
            </div>
            <div className="session-status">
              <Badge value={displayed.phase} />
              <span>
                {displayed.inputTokens + displayed.outputTokens} tokens · {displayed.steps} steps
              </span>
            </div>
            {displayed.text && (
              <div className="message assistant">
                <span className="message-role">EigenGrid</span>
                <div className="markdown">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    skipHtml
                    components={{
                      img: () => null,
                      a: ({ href, children }) => (
                        <a href={href} target="_blank" rel="noopener noreferrer">
                          {children}
                        </a>
                      ),
                    }}
                  >
                    {displayed.text}
                  </ReactMarkdown>
                </div>
                <Action
                  run={async () => {
                    await navigator.clipboard.writeText(displayed.text!);
                    notify("Response copied.");
                  }}
                >
                  Copy response
                </Action>
              </div>
            )}
            {displayed.detail && <p className="agent-warning">{displayed.detail}</p>}
            {displayed.cancellationRequested && <p role="status">Cancellation requested.</p>}
            <fieldset disabled={busy || fenced} className="agent-actions">
              {["ready", "awaiting_approval"].includes(displayed.phase) && (
                <Action
                  className="primary"
                  run={async () => {
                    if (
                      await confirm(
                        "Resume this task?",
                        <p>
                          The agent may use model tokens and permitted tools within this mission’s
                          budget and approval boundaries.
                        </p>,
                        "Resume task",
                      )
                    )
                      await action("resume");
                  }}
                >
                  Resume task
                </Action>
              )}
              {["uncertain_effect", "inference_pending", "tool_pending"].includes(
                displayed.phase,
              ) && <Action run={() => action("reconcile")}>Reconcile task</Action>}
              {!["completed", "failed", "aborted", "budget_exhausted"].includes(
                displayed.phase,
              ) && (
                <Action
                  className="danger"
                  run={async () => {
                    if (
                      await confirm(
                        "Cancel this agent task?",
                        <p>
                          Stop further agent work. Calculations already admitted retain their own
                          lifecycle.
                        </p>,
                        "Cancel task",
                      )
                    )
                      await action("cancel");
                  }}
                >
                  Cancel task
                </Action>
              )}
            </fieldset>
            {displayed.phase === "awaiting_approval" && displayed.call && (
              <section className="tool-approval">
                <h3>Tool approval required</h3>
                <strong>{displayed.call.name}</strong>
                <Inspect label="Exact tool input" value={displayed.call.input} open />
                <Action
                  className="primary"
                  disabled={busy || fenced}
                  run={async () => {
                    const call = displayed.call!;
                    const inputDigest = await sha256(
                      new TextEncoder().encode(canonical(call.input)).buffer,
                    );
                    if (
                      await confirm(
                        "Approve this tool call?",
                        <>
                          <p>
                            This approval applies to this exact input and journal position for five
                            minutes. Resume the task separately.
                          </p>
                          <Inspect label={call.name} value={call.input} open />
                        </>,
                        "Approve tool call",
                      )
                    ) {
                      await action("approve", {
                        callId: call.id,
                        inputDigest,
                        cursor: displayed.cursor,
                        ttlSeconds: 300,
                      });
                      notify("Tool approval recorded. Resume the task when ready.");
                    }
                  }}
                >
                  Approve tool call
                </Action>
                <p className="muted">Scientific plan approvals remain separate.</p>
              </section>
            )}
            <details>
              <summary>Session details</summary>
              <p>
                Session <code>{displayed.sessionId}</code>
              </p>
              <p>
                Cost: {displayed.cost} · Step limit: {displayed.limits.maximumSteps}
              </p>
              <Inspect label="Full session record" value={displayed} />
              <Journal
                key={displayed.sessionId}
                base={`${base}/${encodeURIComponent(displayed.sessionId)}`}
                signal={view.signal}
              />
            </details>
            <a className="button" href={sessionRoute(view.projectId, view.missionId, "")}>
              New task
            </a>
          </>
        )}
      </div>
      {!sessionId && (
        <form
          className="agent-composer"
          onSubmit={async (event) => {
            event.preventDefault();
            if (running.current || !prompt.trim() || fenced) return;
            running.current = true;
            setBusy(true);
            const generation = api.generation;
            try {
              if (
                !(await confirm(
                  "Start this agent task?",
                  <>
                    <p>{prompt.trim()}</p>
                    <p>
                      Uses this mission’s model budget. Actions remain subject to tool and
                      scientific approvals.
                    </p>
                  </>,
                  "Start task",
                ))
              )
                return;
              if (view.signal.aborted || generation !== api.generation) return;
              const opened = await view.mutate(
                "agent.open",
                { prompt: prompt.trim() },
                0,
                "/agent-sessions",
              );
              const next = opened.result as AgentSession;
              if (view.signal.aborted || generation !== api.generation) return;
              location.hash = sessionRoute(view.projectId, view.missionId, next.sessionId);
              setPrompt("");
              await view.mutate(
                "agent.resume",
                {},
                next.cursor.sequence,
                `/agent-sessions/${encodeURIComponent(next.sessionId)}/resume`,
              );
            } catch (cause) {
              if (!view.signal.aborted && generation === api.generation)
                notify(errorText(cause), true);
            } finally {
              running.current = false;
              if (!view.signal.aborted) {
                setBusy(false);
                setRevision((value) => value + 1);
              }
            }
          }}
        >
          <label className="sr-only" htmlFor="agent-prompt">
            Agent task
          </label>
          <textarea
            id="agent-prompt"
            rows={4}
            maxLength={100000}
            placeholder="Describe a task for this mission…"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            disabled={busy || fenced}
          />
          <div className="split">
            <small>Planning and analysis</small>
            <button className="primary" disabled={busy || fenced || !prompt.trim()}>
              {busy ? "Starting…" : "Start task"}
            </button>
          </div>
        </form>
      )}
    </aside>
  );
}
function Journal({ base, signal }: { base: string; signal: AbortSignal }) {
  const [events, setEvents] = useState<{ cursor: number; record: AgentRecord }[]>([]);
  const cursor = useRef(0);
  return (
    <div className="journal">
      <h3>Recorded activity</h3>
      {events.map((item) => (
        <Inspect
          key={item.cursor}
          label={`${item.record.sequence} · ${item.record.event.type}`}
          value={item.record.event}
        />
      ))}
      <Action
        run={async () => {
          const generation = api.generation;
          const response = await api.transport(
            `/api/v1${base}/events?after=${cursor.current}&maximum=64`,
            {
              credentials: "same-origin",
              cache: "no-store",
              redirect: "error",
              signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
            },
          );
          if (!response.ok) {
            if (response.status === 401) {
              api.invalidateSession();
              window.dispatchEvent(new Event("eigengrid:session-expired"));
            }
            throw new Error(`The journal could not be read (${response.status}).`);
          }
          const text = await response.text();
          if (signal.aborted || generation !== api.generation) return;
          const next = text
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { cursor: number; record: AgentRecord });
          if (next.length) {
            cursor.current = next.at(-1)!.cursor;
            setEvents((old) => [...old, ...next]);
          }
        }}
      >
        Load more activity
      </Action>
    </div>
  );
}
