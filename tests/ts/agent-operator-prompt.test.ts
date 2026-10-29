/**
 * agent-operator-prompt.test.ts
 *
 * Ticket 13, coverage item 8:
 *   8. prompt policy forbids invented CLI commands
 */
import { describe, it, expect } from "bun:test";
import { OPERATOR_SYSTEM_PROMPT } from "../../packages/agent/src/prompts/system";

describe("OPERATOR_SYSTEM_PROMPT", () => {
  it("contains the no-invented-commands rule", () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain("Never invent slash commands");
  });

  it("contains the tool-first rule", () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain("Use tools before answering");
  });

  it("contains the missing tool response template", () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain("No registered tool currently supports that action");
  });

  it("forbids decorative emojis (rule is stated)", () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain("No decorative emojis");
  });

  it("instructs responding in user language", () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain("Respond in the user's language");
  });

  it("itself does not use emojis", () => {
    // Simple regex for common emoji ranges — not exhaustive but catches obvious ones
    const emojiPattern = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/u;
    expect(emojiPattern.test(OPERATOR_SYSTEM_PROMPT)).toBe(false);
  });

  it("mentions cancel-job tool", () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain("cancel-job");
  });

  it("allows structured terminal Markdown", () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain("terminal-safe Markdown");
    expect(OPERATOR_SYSTEM_PROMPT).toContain("**bold**");
    expect(OPERATOR_SYSTEM_PROMPT).not.toContain("One paragraph maximum");
    expect(OPERATOR_SYSTEM_PROMPT).not.toContain("Use plain text");
  });

  it("identifies the native bounded runtime and runtime introspection tool", () => {
    expect(OPERATOR_SYSTEM_PROMPT).toContain("native bounded tool loop");
    expect(OPERATOR_SYSTEM_PROMPT).toContain("operator-info");
    expect(OPERATOR_SYSTEM_PROMPT).toContain("It is not\nCodex");
  });

  it("does not mention submitGaussianTool in tool list", () => {
    expect(OPERATOR_SYSTEM_PROMPT.toLowerCase()).not.toContain("submitgaussian");
    expect(OPERATOR_SYSTEM_PROMPT.toLowerCase()).not.toContain("submit-gaussian");
  });
});
