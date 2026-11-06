import { api, ApiError } from "./api.browser.js";
import { el, button, inspect, date, notify, route, confirmAction } from "./dom.browser.js";

/** @param {string} projectId @param {() => Promise<void>} refresh @param {string} [missionId] */
export function recoveryPanel(projectId, refresh, missionId) {
  const entries = api.pending.filter(
    (item) =>
      item.actorId === api.session?.actor.id &&
      item.projectId === projectId &&
      (!missionId || item.missionId === missionId),
  );
  if (!entries.length) return null;
  return el(
    "section",
    { class: "recovery panel", "aria-label": "Outstanding requests" },
    el("h2", {}, "A request needs a result check"),
    el(
      "p",
      {},
      "The connection did not establish a final result. Check the saved request before submitting another operation for this mission.",
    ),
    ...entries.map((entry) => {
      const output = el("div", {});
      return el(
        "div",
        { class: "recovery-item" },
        el(
          "p",
          {},
          el("strong", {}, entry.operation),
          " · ",
          el("a", { href: route(projectId, entry.missionId) }, entry.missionId),
        ),
        el("small", {}, date(entry.createdAt)),
        inspect("Request reference", entry),
        button("Check saved result", async () => {
          try {
            const result = await api.recover(entry);
            if (result.status === "complete" || result.status === "not_recorded") {
              notify(
                result.status === "complete"
                  ? "The saved request completed. The mission has been refreshed."
                  : "The server rejected the request before recording an operation. Review the refreshed mission before a new attempt.",
              );
              const destination =
                result.status === "complete" ? recoveryDestination(entry, result.result) : null;
              if (destination && location.hash !== destination) location.hash = destination;
              else await refresh();
              return;
            }
            output.replaceChildren(
              el(
                "p",
                {},
                "The server recorded this request but has no final response. Reconciliation reads canonical records; it does not submit the operation again.",
              ),
              button("Reconcile with recorded state", async () => {
                if (
                  !(await confirmAction(
                    "Reconcile this request?",
                    el(
                      "p",
                      {},
                      "EigenGrid will look for the canonical result. An unresolved effect remains blocked for operator investigation.",
                    ),
                    "Reconcile",
                  ))
                )
                  return;
                const recovered = await api.reconcile(entry, result.operationId);
                notify("Request reconciled with canonical state.");
                const destination = recoveryDestination(entry, recovered.result);
                if (destination && location.hash !== destination) location.hash = destination;
                else await refresh();
              }),
            );
          } catch (error) {
            if (error instanceof ApiError && error.code === "NOT_FOUND")
              output.replaceChildren(
                el(
                  "p",
                  {},
                  "No matching request is currently recorded. A disconnected request may still be in flight. Keep this reference and check again; use the CLI or your operator to investigate before resubmission.",
                ),
              );
            else throw error;
          }
        }),
        output,
      );
    }),
  );
}

/** Preserve the session address when the response to opening it was lost.
 * @param {import('./contracts').PendingRequest} entry @param {unknown} result */
export function recoveryDestination(entry, result) {
  if (entry.operation === "create") return route(entry.projectId, entry.missionId);
  if (entry.operation !== "agent.open" || !result || typeof result !== "object") return null;
  let value = /** @type {Record<string, unknown>} */ (result);
  if (value.recoveredFromCanonical && value.observation && typeof value.observation === "object")
    value = /** @type {Record<string, unknown>} */ (value.observation);
  const sessionId = value.sessionId;
  return typeof sessionId === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(sessionId)
    ? `${route(entry.projectId, entry.missionId, "agent")}/${encodeURIComponent(sessionId)}`
    : null;
}
