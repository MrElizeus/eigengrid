import { route } from "./navigation";

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
    ? route(entry.projectId, entry.missionId, "overview", sessionId)
    : null;
}
