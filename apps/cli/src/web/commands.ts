export const commands = [
  {
    name: "new",
    label: "New conversation",
    detail: "Start with an empty context",
    group: "Conversation",
    action: "new",
  },
  {
    name: "rename",
    label: "Rename",
    detail: "Change this conversation's title",
    group: "Conversation",
    action: "rename",
  },
  {
    name: "export",
    label: "Export conversation",
    detail: "Download history as Markdown",
    group: "Conversation",
    action: "export",
  },
  {
    name: "stop",
    label: "Stop response",
    detail: "Cancel the current generation",
    group: "Conversation",
    action: "stop",
  },
  {
    name: "theme",
    label: "Change appearance",
    detail: "Light, dark or system theme",
    group: "Interface",
    action: "theme",
  },
  {
    name: "help",
    label: "Commands and shortcuts",
    detail: "Learn how to work in chat",
    group: "Interface",
    action: "help",
  },
  {
    name: "connect",
    label: "CLI connection",
    detail: "Inspect the account and how to change it in the CLI",
    group: "Connection",
    action: "connection",
  },
  {
    name: "models",
    label: "CLI model",
    detail: "Inspect the model; select it with /models in the CLI",
    group: "Connection",
    action: "connection",
  },
  {
    name: "variants",
    label: "CLI reasoning",
    detail: "Configure with /variants in the CLI",
    group: "Connection",
    action: "connection",
  },
  {
    name: "status",
    label: "Project status",
    detail: "Prepare a query about jobs and nodes",
    group: "Agent queries",
    action: "prompt",
    prompt:
      "Inspect the project status, jobs and nodes. Describe only what you can verify without making changes.",
  },
  {
    name: "protocols",
    label: "Available protocols",
    detail: "Prepare a scientific catalog query",
    group: "Agent queries",
    action: "prompt",
    prompt: "List available scientific protocols with their uses, limitations and review status.",
  },
  {
    name: "results",
    label: "Results and logs",
    detail: "Prepare an evidence query",
    group: "Agent queries",
    action: "prompt",
    prompt:
      "Inspect available results and logs and explain the evidence without modifying files or running calculations.",
  },
] as const;
export type Command = (typeof commands)[number];
export function filterCommands(query: string) {
  const needle = query.replace(/^\//, "").trim().toLocaleLowerCase();
  return commands
    .filter((c) => `${c.name} ${c.label} ${c.group}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => Number(b.name.startsWith(needle)) - Number(a.name.startsWith(needle)));
}
export type Theme = "light" | "dark" | "system";
export function resolveTheme(theme: Theme, darkSystem: boolean) {
  return theme === "system" ? (darkSystem ? "dark" : "light") : theme;
}
