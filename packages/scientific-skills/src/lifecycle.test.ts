import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  DurableSkillLifecycleJournal,
  MemorySkillLifecycleJournal,
  SkillLifecycleRegistry,
} from "./lifecycle";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const base = {
  skillId: "amber.test",
  version: "1.0.0",
  contentDigest: "a".repeat(64),
  actor: { id: "reviewer", kind: "human" as const, role: "scientific_reviewer" },
};

describe("skill lifecycle authority", () => {
  it("enforces draft → evaluated → reviewed → promoted and requires evidence", async () => {
    const registry = new SkillLifecycleRegistry(new MemorySkillLifecycleJournal());
    await registry.submitDraft(base);
    await registry.recordEvaluation({ ...base, evaluationDigest: "b".repeat(64) });
    await registry.review({ ...base, evaluationDigest: "b".repeat(64), evidenceIds: ["eval-1"] });
    await expect(
      registry.promote({ ...base, evaluationDigest: "b".repeat(64), evidenceIds: ["eval-1"] }),
    ).resolves.toMatchObject({ state: "promoted" });
    await expect(registry.transition({ ...base, state: "draft" })).rejects.toThrow("illegal");
  });

  it("persists append-only state and rejects digest drift", async () => {
    const root = mkdtempSync(join("/tmp", "eigengrid-skill-lifecycle-"));
    roots.push(root);
    const journal = new DurableSkillLifecycleJournal(join(root, "lifecycle.jsonl"));
    const first = new SkillLifecycleRegistry(journal);
    await first.submitDraft(base);
    const second = new SkillLifecycleRegistry(journal);
    await second.load();
    expect(second.get(base.skillId, base.version)?.state).toBe("draft");
    await expect(
      second.recordEvaluation({
        ...base,
        contentDigest: "c".repeat(64),
        evaluationDigest: "b".repeat(64),
      }),
    ).rejects.toThrow("digest");
  });

  it("never permits model-only promotion without evidence", async () => {
    const registry = new SkillLifecycleRegistry(new MemorySkillLifecycleJournal());
    const model = { id: "model", kind: "model" as const, role: "planner" };
    await registry.submitDraft({ ...base, actor: model });
    await registry.recordEvaluation({ ...base, actor: model, evaluationDigest: "b".repeat(64) });
    await registry.review({
      ...base,
      actor: { id: "service", kind: "service", role: "verifier" },
      evaluationDigest: "b".repeat(64),
      evidenceIds: ["v"],
    });
    await expect(
      registry.promote({
        ...base,
        actor: model,
        evaluationDigest: "b".repeat(64),
        evidenceIds: [],
      }),
    ).rejects.toThrow("promotion requires");
    await expect(
      registry.promote({
        ...base,
        actor: model,
        evaluationDigest: "b".repeat(64),
        evidenceIds: ["v"],
      }),
    ).rejects.toThrow("model actors");
  });
});
