import { describe, it, expect } from "bun:test";
import { OPERATOR_SYSTEM_PROMPT, MISSION_SYSTEM_PROMPT } from "./system";

describe("OPERATOR_SYSTEM_PROMPT", () => {
  it("is defined and non-empty", () => {
    expect(OPERATOR_SYSTEM_PROMPT).toBeDefined();
    expect(OPERATOR_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it("instructs to use tools before answering about jobs, nodes, cluster, logs, artifacts, config", () => {
    const lower = OPERATOR_SYSTEM_PROMPT.toLowerCase();
    // Should mention using tools
    expect(lower).toContain("tool");
    // Should reference jobs
    expect(lower).toContain("job");
  });

  it("forbids claiming access is unavailable when tools exist", () => {
    expect(OPERATOR_SYSTEM_PROMPT.toLowerCase()).toContain(
      "never claim you lack access when a tool exists",
    );
  });

  it("forbids inventing slash commands or CLI syntax", () => {
    const lower = OPERATOR_SYSTEM_PROMPT.toLowerCase();
    const forbidsSlash =
      lower.includes("slash") ||
      lower.includes("/command") ||
      lower.includes("invent") ||
      lower.includes("hallucinat");
    expect(forbidsSlash).toBe(true);
  });

  it("discourages excessive apologies", () => {
    const lower = OPERATOR_SYSTEM_PROMPT.toLowerCase();
    const noApologies = lower.includes("apolog") || lower.includes("sorry");
    expect(noApologies).toBe(true);
  });

  it("discourages emojis", () => {
    const lower = OPERATOR_SYSTEM_PROMPT.toLowerCase();
    expect(lower).toContain("emoj");
  });

  it("encourages concise operational language", () => {
    const lower = OPERATOR_SYSTEM_PROMPT.toLowerCase();
    const hasConcise =
      lower.includes("concise") ||
      lower.includes("brief") ||
      lower.includes("short") ||
      lower.includes("succinct");
    expect(hasConcise).toBe(true);
  });

  it("prefers exact job IDs, statuses, node names", () => {
    const lower = OPERATOR_SYSTEM_PROMPT.toLowerCase();
    const hasExactIds =
      lower.includes("exact") || lower.includes("job id") || lower.includes("specific");
    expect(hasExactIds).toBe(true);
  });

  it("provides a fallback message for unavailable actions", () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain("No registered tool");
  });

  it("addresses language handling — responds in user's language", () => {
    const lower = OPERATOR_SYSTEM_PROMPT.toLowerCase();
    const hasLangHandling =
      lower.includes("language") ||
      lower.includes("user's language") ||
      lower.includes("spanish") ||
      lower.includes("neutral");
    expect(hasLangHandling).toBe(true);
  });

  it("mentions available tool categories (doctor, list-jobs, etc)", () => {
    const lower = OPERATOR_SYSTEM_PROMPT.toLowerCase();
    expect(lower).toContain("doctor");
    expect(lower).toContain("list-jobs");
  });
});

testMissionPrompt();
function testMissionPrompt() {
  it("keeps durable mission instructions scoped to the supplied tools", () => {
    expect(MISSION_SYSTEM_PROMPT).toContain("mission-status");
    expect(MISSION_SYSTEM_PROMPT).toContain("mission-start");
    expect(MISSION_SYSTEM_PROMPT).not.toContain("## Registered Tools");
    expect(MISSION_SYSTEM_PROMPT).not.toContain("Use operator-info before");
    expect(MISSION_SYSTEM_PROMPT).toContain("separate persisted per-call human approval");
  });
}
