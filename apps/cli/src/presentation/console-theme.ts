/** Semantic presentation tokens. No Ink/React dependency; also usable by a web view. */
export const consoleTheme = {
  accent: "#67D4E8",
  secondary: "#B8A1F1",
  text: "#E1E8F0",
  value: "#F5F8FC",
  muted: "#A2B0C3",
  dim: "#76869C",
  border: "#46556C",
  success: "#83D6AA",
  warn: "#F2C879",
  error: "#F39191",
} as const;

export type StateTone = "accent" | "success" | "warn" | "error" | "muted";

export function jobPresentation(status: string): { glyph: string; tone: StateTone } {
  switch (status) {
    case "running":
      return { glyph: "●", tone: "accent" };
    case "completed":
    case "parsed":
      return { glyph: "✓", tone: "success" };
    case "failed":
      return { glyph: "!", tone: "error" };
    case "cancelled":
      return { glyph: "−", tone: "muted" };
    case "queued":
    case "staged":
      return { glyph: "◷", tone: "warn" };
    default:
      return { glyph: "·", tone: "muted" };
  }
}

export const jobFilters = ["all", "active", "attention", "finished"] as const;
export type JobFilter = (typeof jobFilters)[number];

export function matchesJobFilter(status: string, filter: JobFilter): boolean {
  switch (filter) {
    case "active":
      return ["created", "queued", "staged", "running"].includes(status);
    case "attention":
      return status === "failed";
    case "finished":
      return ["completed", "parsed", "cancelled"].includes(status);
    default:
      return true;
  }
}
