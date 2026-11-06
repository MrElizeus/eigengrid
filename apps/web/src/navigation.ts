export const tabs = [
  ["overview", "Overview"],
  ["review", "Plan & review"],
  ["work", "Work units"],
  ["evidence", "Results & evidence"],
  ["activity", "Activity"],
] as const;
export type Tab = (typeof tabs)[number][0];
export interface Address {
  projectId: string;
  missionId?: string;
  tab: Tab;
  create: boolean;
  sessionId?: string;
}
export function parseAddress(hash: string, fallback = ""): Address {
  const [path, search] = hash.replace(/^#\/?/u, "").split("?");
  const parts = (path ?? "").split("/").map(decodeURIComponent);
  const tab = tabs.some(([id]) => id === parts[4]) ? (parts[4] as Tab) : "overview";
  return {
    projectId: parts[0] === "projects" ? (parts[1] ?? fallback) : fallback,
    missionId: parts[2] === "missions" ? parts[3] : undefined,
    create: parts[2] === "new",
    tab,
    sessionId:
      new URLSearchParams(search).get("session") ?? (parts[4] === "agent" ? parts[5] : undefined),
  };
}
export function route(projectId: string, missionId?: string, tab = "overview", sessionId?: string) {
  return `#/projects/${encodeURIComponent(projectId)}${missionId ? `/missions/${encodeURIComponent(missionId)}/${tab}` : ""}${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ""}`;
}
export function sessionRoute(projectId: string, missionId: string, sessionId: string) {
  const address = parseAddress(location.hash);
  return route(projectId, missionId, address.tab, sessionId);
}
