import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPlan } from "../../apps/cli/src/commands/plan";

describe("hard /plan command", () => {
  test("creates a durable exact-digest artifact with zero effect budget", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "eigengrid-plan-test-"));
    const artifact = await runPlan(
      { objective: "inspect a test mission", "plan-id": "plan-test" },
      cwd,
    );
    expect(artifact.schema).toBe("eigengrid.scientific-plan-artifact.v1");
    expect(artifact.budgets).toEqual({ modelCalls: 0, externalEffects: 0, scientificCompute: 0 });
    const contents = await readFile(join(cwd, ".eigengrid", "plans.jsonl"), "utf8");
    expect(contents).toContain(artifact.materialDigest);
  });

  test("revising the same plan is append-only", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "eigengrid-plan-test-"));
    const first = await runPlan({ objective: "first", "plan-id": "plan-revise" }, cwd);
    const second = await runPlan({ objective: "second", "plan-id": "plan-revise" }, cwd);
    expect(second.revision).toBe(2);
    expect(second.priorRevision).toBe(first.revision);
    expect(second.materialDigest).not.toBe(first.materialDigest);
  });
});
