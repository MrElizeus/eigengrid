import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExperienceMemory } from "@eigengrid/experience-memory";
import { InMemoryAgentJournal, ZERO_AGENT_CURSOR, type AgentEvent } from "@eigengrid/agent-runtime";
import { captureAgentExperience } from "./experience-capture";

let root: string, memory: ExperienceMemory;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eigengrid-capture-"));
  memory = new ExperienceMemory(join(root, "memory.sqlite"), {
    projectId: "project",
    ownerId: "alice",
  });
});
afterEach(() => {
  memory.close();
  rmSync(root, { recursive: true, force: true });
});
function journal(events: AgentEvent[]) {
  const value = new InMemoryAgentJournal();
  let cursor = ZERO_AGENT_CURSOR;
  const started: AgentEvent = {
    type: "started",
    prompt: "Inspect AMBER",
    limits: {
      maximumSteps: 4,
      maximumToolCalls: 4,
      maximumInputTokens: 1000,
      maximumOutputTokens: 1000,
      maximumCost: 10,
    },
  };
  for (const event of [started, ...events]) cursor = value.append("session-a", cursor, event);
  return value.load("session-a");
}
test("records uncertain effects with unresolved intents and never labels them successful", () => {
  const records = journal([
    {
      type: "effect_intent",
      call: { id: "call-a", name: "submit-job", input: { engine: "AMBER" } },
    },
    { type: "terminated", reason: "uncertain_effect", detail: "Transport lost after submission" },
  ]);
  const captured = captureAgentExperience(memory, "session-a", records);
  expect(memory.get(captured.candidateId!).candidate.outcome).toBe("uncertain_effect");
  expect(memory.recentEvidence()[0].observation).toContain("unresolvedIntents");
  expect(memory.recentEvidence()[0].observation).toContain("submit-job");
  const history = memory.get(captured.candidateId!).history;
  expect(captureAgentExperience(memory, "session-a", records)).toEqual(captured);
  expect(memory.get(captured.candidateId!).history).toEqual(history);
});
test("imports a recovered receipt without repeating the effect and rejects altered journal records", () => {
  const records = journal([
    { type: "effect_intent", call: { id: "call-a", name: "inspect-node", input: {} } },
    {
      type: "effect_reconciled",
      observation: {
        id: "call-a",
        tool: "inspect-node",
        ok: true,
        result: { PATH: "no AMBER", password: "private-secret" },
      },
    },
    { type: "completed", text: "Inspect identities and modules next" },
  ]);
  captureAgentExperience(memory, "session-a", records);
  expect(memory.recentEvidence()).toHaveLength(2);
  expect(JSON.stringify(memory.recentEvidence())).not.toContain("private-secret");
  expect(() => captureAgentExperience(memory, "session-b", records)).toThrow("chain");
  const changed = records.map((r, i) => (i ? r : { ...r, digest: "f".repeat(64) }));
  expect(() => captureAgentExperience(memory, "session-a", changed)).toThrow("digest");
  expect(memory.recentEvidence()).toHaveLength(2);
});
test("memory inspection and conversation do not manufacture operational lessons", () => {
  for (const events of [
    [{ type: "completed", text: "Hello" }],
    [
      { type: "effect_intent", call: { id: "call-a", name: "search-experiences", input: {} } },
      {
        type: "effect_observed",
        observation: { id: "call-a", tool: "search-experiences", ok: true, result: {} },
      },
      { type: "completed", text: "Memory inspection" },
    ],
  ] satisfies AgentEvent[][]) {
    expect(
      captureAgentExperience(memory, "session-a", journal(events)).candidateId,
    ).toBeUndefined();
  }
  expect(memory.search("", {}, { includeIneligible: true })).toEqual([]);
});
