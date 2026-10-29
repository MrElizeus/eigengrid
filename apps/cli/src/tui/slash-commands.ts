// ────────────────────────────────────────────────────────────
// Slash Commands — Map and utilities
// ────────────────────────────────────────────────────────────

export const SlashCommands = new Map<string, string>([
  ["help", "Show this help message"],
  ["init", "Initialize a project"],
  ["doctor", "Run environment diagnostics"],
  ["status", "Show job status"],
  ["submit", "Submit a job (software input)"],
  ["parse", "Parse output files (software file)"],
  ["logs", "View job logs (job-id)"],
  ["artifacts", "List artifacts for a job"],
  ["results", "Show job results"],
  ["events", "View job events"],
  ["timeline", "Show job timeline"],
  ["node", "Manage compute nodes"],
  ["recipes", "List available recipes"],
  ["collect", "Collect job outputs"],
  ["worker", "Manage workers"],
  ["agent", "Run the AI agent (prompt)"],
  ["plan", "Create a durable zero-effect scientific plan"],
  ["mission", "Canonical mission action using a reviewed JSON request file"],
  ["session", "Open, observe, approve, resume, cancel or reconcile a durable agent session"],
  ["connect", "Connect an LLM provider"],
  ["providers", "Alias for /connect"],
  ["models", "Choose a model for the current account or API key"],
  ["variants", "Choose a reasoning variant for the current model"],
  ["permissions", "Choose an execution and approval preset"],
  ["key", "Set API key in a private input"],
  ["configure", "Configure API key privately"],
  ["endpoint", "Set API endpoint for current provider"],
  ["clear", "Clear the terminal screen"],
  ["exit", "Exit the application"],
]);

// ────────────────────────────────────────────────────────────
// getHelpText — Format all commands as a help listing
// ────────────────────────────────────────────────────────────

export function getHelpText(): string {
  const lines: string[] = ["Available slash commands:"];
  let maxLen = 0;
  for (const name of SlashCommands.keys()) {
    if (name.length > maxLen) maxLen = name.length;
  }

  for (const [name, desc] of SlashCommands) {
    const padded = `/${name}`.padEnd(maxLen + 2);
    lines.push(`  ${padded}  ${desc}`);
  }

  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────
// getCompletions — Tab completion for partial / commands
// ────────────────────────────────────────────────────────────

export function getCompletions(partial: string): string[] {
  const search = partial.startsWith("/") ? partial.slice(1) : partial;
  const lower = search.toLowerCase();

  const matches: string[] = [];
  for (const name of SlashCommands.keys()) {
    if (name.toLowerCase().startsWith(lower)) {
      matches.push(`/${name}`);
    }
  }

  return matches.sort();
}

// ────────────────────────────────────────────────────────────
// getSuggestions — Live suggestion data for the TUI panel
// ────────────────────────────────────────────────────────────

export interface SlashSuggestion {
  name: string;
  description: string;
}

export function getSuggestions(input: string, max = 0): SlashSuggestion[] {
  if (!input.startsWith("/") || input.includes(" ")) return [];
  const partial = input.slice(1).toLowerCase();
  const results: SlashSuggestion[] = [];
  for (const [name, desc] of SlashCommands) {
    if (name.toLowerCase().startsWith(partial)) {
      results.push({ name: `/${name}`, description: desc });
    }
  }
  return max > 0 ? results.slice(0, max) : results;
}

// ────────────────────────────────────────────────────────────
// handleUnknownCommand — Error message for unknown commands
// ────────────────────────────────────────────────────────────

export function handleUnknownCommand(cmd: string): string {
  const display = cmd.startsWith("/") ? cmd : `/${cmd}`;
  return `Unknown command: ${display}. Type /help for available commands.`;
}
