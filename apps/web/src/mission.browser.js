import { api, missionPath } from "./api.browser.js";
import { el, button, badge, field, route, confirmAction, notify } from "./dom.browser.js";
import { overview, workUnits, evidence, activity } from "./records.browser.js";
import { renderReview } from "./review.browser.js";
import { renderAgent } from "./agent.browser.js";
import { recoveryPanel } from "./recovery.browser.js";

/** @param {string} projectId @param {string} missionId @param {string} tab @param {string | undefined} sessionId @param {HTMLElement} host @param {AbortSignal} signal @param {() => Promise<void>} refresh */
export async function renderMission(projectId, missionId, tab, sessionId, host, signal, refresh) {
  /** @type {import('./contracts').MissionProvenance} */
  const provenance = await api.get(missionPath(projectId, missionId), signal);
  if (signal.aborted) return;
  const mission = provenance.mission;
  /** @type {import('./contracts').MissionView} */
  const view = {
    projectId,
    missionId,
    provenance,
    signal,
    refresh,
    async mutate(
      operation,
      request,
      expectedRevision = mission.revision,
      suffix = `/${operation}`,
    ) {
      try {
        return await api.mutate(
          `${missionPath(projectId, missionId)}${suffix}`,
          projectId,
          missionId,
          operation,
          expectedRevision,
          request,
        );
      } finally {
        await refresh();
      }
    },
  };
  const tabs = [
    ["overview", "Overview"],
    ["review", "Plan & review"],
    ["work", "Work units"],
    ["evidence", "Evidence"],
    ["activity", "Activity"],
    ["agent", "Agent"],
  ];
  if (!tabs.some(([key]) => key === tab)) tab = "overview";
  const updates = el(
    "div",
    { class: "update-status", role: "status" },
    "Viewing the latest fetched record",
  );
  const controls = el("div", { class: "actions" }, button("Refresh", refresh));
  if (
    !["completed", "failed", "cancelled", "cancelling", "cancel_requested"].includes(mission.state)
  )
    controls.append(
      button(
        "Cancel mission",
        async () => {
          const reason = el("textarea", {
            rows: 3,
            maxlength: 2048,
            placeholder: "Explain why this mission should stop.",
          });
          if (
            !(await confirmAction(
              "Request mission cancellation?",
              el(
                "div",
                {},
                el(
                  "p",
                  {},
                  "The coordinator will record the request and reconcile admitted work. Cancellation may take time.",
                ),
                field("Cancellation reason", reason),
              ),
              "Request cancellation",
            ))
          )
            return;
          if (!reason.value.trim()) throw new Error("A cancellation reason is required.");
          await view.mutate("cancel", {
            projectId,
            missionId,
            schemaVersion: "eigengrid.mission-cancel/v1",
            expectedRevision: mission.revision,
            reason: reason.value.trim(),
          });
          notify("Cancellation requested.");
        },
        "danger",
      ),
    );
  const content = el("div", { class: "tab-content", id: "mission-content" });
  host.replaceChildren(
    el("a", { class: "back-link", href: route(projectId) }, "← All missions"),
    el(
      "div",
      { class: "page-heading" },
      el(
        "div",
        {},
        el("p", { class: "eyebrow" }, "Mission workspace"),
        el("h1", {}, mission.objective.statement),
        el(
          "div",
          { class: "heading-meta" },
          badge(mission.state),
          el("code", {}, mission.id),
          el("span", {}, `Revision ${mission.revision}`),
        ),
      ),
      controls,
    ),
    recoveryPanel(projectId, refresh, missionId) ?? el("span"),
    el(
      "nav",
      { class: "tabs", "aria-label": "Mission views" },
      ...tabs.map(([key, label]) =>
        el(
          "a",
          {
            href: route(projectId, missionId, key),
            class: tab === key ? "selected" : "",
            "aria-current": tab === key ? "page" : false,
          },
          label,
        ),
      ),
    ),
    updates,
    content,
  );
  if (tab === "review") await renderReview(view, content);
  else if (tab === "agent") await renderAgent(view, content, sessionId);
  else content.append(({ overview, work: workUnits, evidence, activity }[tab] ?? overview)(view));
  // Observe in the background without replacing a focused review form or
  // treating an unchanged mission revision as unchanged work-unit state.
  let baseline = "";
  let changed = false;
  const poll = async () => {
    if (signal.aborted) return;
    if (!document.hidden) {
      try {
        const result = await api.get(`${missionPath(projectId, missionId)}/status`, signal);
        if (signal.aborted) return;
        const value = JSON.stringify(result);
        changed ||= Boolean(baseline && baseline !== value) || result.revision !== mission.revision;
        if (changed)
          updates.replaceChildren(
            el("span", {}, "New recorded state is available."),
            button("Refresh view", refresh, "text"),
          );
        else
          updates.textContent = `Connection checked at ${new Date().toLocaleTimeString("en")}. Forms keep their reviewed revision.`;
        baseline = value;
      } catch {
        if (!signal.aborted)
          updates.textContent = "Live checks are unavailable. Refresh before making a decision.";
      }
    }
    if (!signal.aborted) timer = setTimeout(() => void poll(), 15000);
  };
  let timer = setTimeout(() => void poll(), 1000);
  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
}
