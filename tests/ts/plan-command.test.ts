import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPlan } from "../../apps/cli/src/commands/plan";
import {
  planningModel,
  planningRuntime,
  planSteps,
  questions,
} from "../../apps/cli/src/agent/fixtures/planning";

describe("scientific plan command", () => {
  test("creates model-authored detailed proposals and immutable revisions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "eigengrid-plan-test-"));
    try {
      for (const revision of [1, 2]) {
        const fixture = planningModel(planSteps());
        const result = await runPlan({ objective: "A small pilot", "plan-id": "plan-test" }, cwd, {
          runtime: planningRuntime(),
          model: fixture.model,
        });
        expect(result.status).toBe("proposal");
        expect(fixture.requests).toHaveLength(4);
        expect(result.artifact?.revision).toBe(revision);
        expect(result.artifact?.budgets.scientificCompute).toBe(0);
        expect(result.response).toContain("Campaign stages");
        expect(result.response).toContain("Acceptance");
      }
      expect(
        (await readFile(join(cwd, ".eigengrid", "plans.jsonl"), "utf8")).trim().split("\n"),
      ).toHaveLength(2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  test("noninteractive callers receive pending questions instead of invented defaults", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "eigengrid-plan-test-"));
    try {
      const result = await runPlan({ objective: "Plan a pilot", json: true }, cwd, {
        runtime: planningRuntime(),
        model: planningModel([{ name: "ask-planning-questions", input: questions }]).model,
      });
      expect(result.status).toBe("needs-input");
      expect(result.questions).toEqual(questions);
      expect(result.artifact).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
