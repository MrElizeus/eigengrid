import { api, missionPath, canonical, sha256 } from "./api.browser.js";
import {
  el,
  button,
  busy,
  field,
  panel,
  inspect,
  badge,
  fact,
  route,
  confirmAction,
  notify,
} from "./dom.browser.js";

/** @param {import('./contracts').MissionView} view @param {HTMLElement} host @param {string} [sessionId] */
export async function renderAgent(view, host, sessionId) {
  const base = `${missionPath(view.projectId, view.missionId)}/agent-sessions`;
  const prompt = el("textarea", {
    rows: 3,
    required: true,
    maxlength: 100000,
    placeholder: "Describe the planning or analysis task for this mission.",
  });
  const openForm = el("form", {});
  const open = el("button", { type: "submit", class: "button primary" }, "Open agent session");
  openForm.append(field("Task", prompt), open);
  openForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void busy(open, async () => {
      if (!prompt.value.trim()) throw new Error("Describe a task for the agent.");
      const response = await view.mutate(
        "agent.open",
        { prompt: prompt.value.trim() },
        0,
        "/agent-sessions",
      );
      const state = /** @type {import('./contracts').AgentSession} */ (response.result);
      location.hash = `${route(view.projectId, view.missionId, "agent")}/${encodeURIComponent(state.sessionId)}`;
      notify("Session opened. Resume when ready to begin the task.");
    });
  });
  const existingId = el("input", {
    value: sessionId ?? "",
    placeholder: "Session UUID",
    required: true,
    pattern: "[a-fA-F0-9-]{36}",
  });
  const attach = el(
    "form",
    { class: "inline-form" },
    field("Open an existing session", existingId),
    el("button", { type: "submit", class: "button secondary" }, "Open session"),
  );
  attach.addEventListener("submit", (event) => {
    event.preventDefault();
    location.hash = `${route(view.projectId, view.missionId, "agent")}/${encodeURIComponent(existingId.value.trim())}`;
  });
  const content = el("div", { class: "stack" });
  host.replaceChildren(
    el(
      "div",
      { class: "stack" },
      panel(
        "Mission agent",
        el(
          "p",
          { class: "hint" },
          "Sessions are durable and scoped to this mission. Tool approvals are separate from scientific plan approvals.",
        ),
        attach,
        el("details", { open: !sessionId }, el("summary", {}, "New session"), openForm),
      ),
      content,
    ),
  );
  if (!sessionId) return;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(sessionId))
    throw new Error("Enter a valid session UUID.");
  /** @type {import('./contracts').AgentSession & { cancellationRequested?: boolean }} */
  const state = await api.get(`${base}/${encodeURIComponent(sessionId)}`, view.signal);
  if (view.signal.aborted) return;
  const action = (/** @type {string} */ operation, /** @type {unknown} */ request = {}) =>
    view.mutate(
      `agent.${operation}`,
      request,
      state.cursor.sequence,
      `/agent-sessions/${encodeURIComponent(sessionId)}/${operation}`,
    );
  const actions = el("div", { class: "actions" });
  if (["ready", "awaiting_approval"].includes(state.phase))
    actions.append(
      button(
        "Resume session",
        async () => {
          if (
            await confirmAction(
              "Resume this session?",
              el(
                "p",
                {},
                "The agent may use model tokens and perform permitted tools within the current mission and approval boundaries.",
              ),
              "Resume session",
            )
          )
            await action("resume");
        },
        "primary",
      ),
    );
  if (["uncertain_effect", "inference_pending", "tool_pending"].includes(state.phase))
    actions.append(
      button("Reconcile session", async () => {
        await action("reconcile");
      }),
    );
  if (!["completed", "failed", "aborted", "budget_exhausted"].includes(state.phase))
    actions.append(
      button(
        "Cancel session",
        async () => {
          if (
            await confirmAction(
              "Cancel this agent session?",
              el(
                "p",
                {},
                "This requests agent cancellation. Scientific work already admitted follows its own recorded lifecycle.",
              ),
              "Request cancellation",
            )
          )
            await action("cancel");
        },
        "danger",
      ),
    );
  content.append(
    panel(
      "Session state",
      el("div", { class: "split" }, el("code", {}, state.sessionId), badge(state.phase)),
      el("p", {}, state.prompt),
      el(
        "dl",
        { class: "facts" },
        fact("Steps", `${state.steps} / ${state.limits.maximumSteps}`),
        fact("Input / output tokens", `${state.inputTokens} / ${state.outputTokens}`),
        fact("Cost", String(state.cost)),
        fact("Journal sequence", String(state.cursor.sequence)),
      ),
      state.cancellationRequested ? el("p", { class: "hint" }, "Cancellation requested") : null,
      state.text ? el("p", { class: "prose" }, state.text) : null,
      state.detail ? el("p", {}, state.detail) : null,
      actions,
    ),
  );
  if (state.phase === "awaiting_approval" && state.call) {
    const call = state.call;
    const inputDigest = await sha256(new TextEncoder().encode(canonical(call.input)).buffer);
    if (view.signal.aborted) return;
    content.append(
      panel(
        "Tool approval required",
        el("h3", {}, call.name),
        inspect("Exact tool input", call.input, true),
        inspect("Approval binding", { callId: call.id, inputDigest, cursor: state.cursor }),
        button(
          "Approve this tool call",
          async () => {
            if (
              !(await confirmAction(
                "Approve this exact tool input?",
                el(
                  "div",
                  {},
                  el(
                    "p",
                    {},
                    "Approval expires after 5 minutes and applies only to this call and journal position. Resume the session separately.",
                  ),
                  inspect(call.name, call.input, true),
                ),
                "Approve tool call",
              ))
            )
              return;
            await action("approve", {
              callId: call.id,
              inputDigest,
              cursor: state.cursor,
              ttlSeconds: 300,
            });
            notify("Tool approval recorded.");
          },
          "primary",
        ),
      ),
    );
  }
  const events = el("div", { class: "stack" });
  let after = 0;
  let loading = false;
  const more = button("Load journal records", async () => {
    if (loading) return;
    loading = true;
    try {
      const response = await api.transport(
        `/api/v1${base}/${encodeURIComponent(sessionId)}/events?after=${after}&maximum=64`,
        { credentials: "same-origin", cache: "no-store", redirect: "error", signal: view.signal },
      );
      if (!response.ok)
        throw new Error(`The journal could not be read (${response.status}). Refresh the session.`);
      const text = await response.text();
      if (view.signal.aborted) return;
      const records = text
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            /** @type {{ cursor: number; record: import('./contracts').AgentRecord }} */ (
              JSON.parse(line)
            ),
        );
      for (const { cursor, record } of records) {
        events.append(inspect(`${record.sequence} · ${record.event.type}`, record.event));
        after = cursor;
      }
      more.textContent = records.length === 64 ? "Load more records" : "Check for newer records";
      if (!records.length) notify("No newer journal records.");
    } finally {
      loading = false;
    }
  });
  content.append(
    panel(
      "Agent journal",
      el("p", { class: "hint" }, "Read the persisted event history in pages of 64 records."),
      events,
      more,
    ),
    inspect("Full session record", state),
  );
}
