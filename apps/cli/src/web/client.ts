import type { ChatMessage } from "./store";
export interface Chat {
  id: string;
  title: string;
  updatedAt: string;
  messages: ChatMessage[];
  pendingPrompt?: string;
}
export interface Settings {
  configured: boolean;
  model: string | null;
  provider: string | null;
  authMode: string | null;
  reason: string | null;
}
export interface State {
  project: string;
  projectPath: string;
  connectionDirectory: string;
  chats: Omit<Chat, "messages">[];
  settings: Settings;
  activeId?: string;
}
export async function api(path: string, method = "GET", data?: unknown) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...(method !== "GET" && data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("eigengrid-session-expired"));
    const error = await response.json();
    throw new Error(error.error ?? "Unable to connect");
  }
  return response;
}
export function clearWebDrafts() {
  for (const key of Object.keys(sessionStorage))
    if (key.startsWith("eigengrid-draft:") || key === "eigengrid-last-chat")
      sessionStorage.removeItem(key);
}
export function announceSessionChange() {
  localStorage.setItem("eigengrid-session-event", crypto.randomUUID());
}
