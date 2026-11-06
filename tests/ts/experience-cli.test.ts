import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentMemory } from "@eigengrid/agent";
import { memoryDigest } from "@eigengrid/experience-memory";
import { ToolRegistry, type ToolContext } from "@eigengrid/tool-registry";
import { getDefaultPermissionRules } from "@eigengrid/agent";
import { registerExperienceTools } from "../../apps/cli/src/agent/experience-tools";

const cli = resolve(import.meta.dir, "../../apps/cli/bin/eigengrid.ts");
let root: string, memory: AgentMemory;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "eigengrid-experience-cli-"));
  memory = new AgentMemory({ dbPath: join(root, ".eigengrid", "memory.db") });
  await memory.connect();
});
afterEach(async () => {
  await memory.close();
  rmSync(root, { recursive: true, force: true });
});
async function run(...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, "memory", ...args], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}
function proposal() {
  const evidence = memory.experience!.observe({
    id: "observation-a",
    scope: { kind: "project" },
    origin: {
      kind: "tool_observation",
      reference: "call-a",
      sourceDigest: memoryDigest("fixture output"),
    },
    outcome: "tool_succeeded",
    observation: "AMBER available through a module",
    observedAt: new Date().toISOString(),
  });
  return {
    domain: "operational",
    title: "Inspect AMBER modules",
    claim: "Check the module environment before concluding absence.",
    rationale: "Evidence observed a module outside PATH.",
    conditions: [],
    evidence: [{ id: evidence.id, digest: evidence.digest }],
    outcome: "completed",
    confidence: { level: "low", basis: "Single observation, needs review" },
    validFrom: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
}
test("CLI proposes and verifies durable records but noninteractive review and promotion fail closed", async () => {
  const file = join(root, "lesson.json");
  writeFileSync(
    file,
    JSON.stringify({ ...proposal(), id: "lesson-a", scope: { kind: "project" } }),
  );
  const proposed = await run("propose", "--file", file);
  expect(proposed.code).toBe(0);
  const initial = memory.experience!.get("lesson-a");
  const verified = await run("verify", "lesson-a", "--expected", initial.current.digest);
  expect(verified.code).toBe(0);
  const current = memory.experience!.get("lesson-a");
  for (const action of ["review", "promote"]) {
    const result = await run(
      action,
      "lesson-a",
      "--expected",
      current.current.digest,
      "--reason",
      "Attempt unattended approval",
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("interactive operator terminal");
  }
  expect(memory.experience!.get("lesson-a").current.digest).toBe(current.current.digest);
  const searched = await run("search", "--query", "AMBER", "--include-candidates");
  expect(searched.code).toBe(0);
  expect(JSON.parse(searched.stdout)[0].excludedBy).toContain("evidence_verified");
  expect(JSON.parse((await run("search", "--query", "AMBER")).stdout)).toEqual([]);
});
test("model tools bind identity, need write permission and cannot expose review operations", async () => {
  const ctx = {} as ToolContext;
  const denied = new ToolRegistry(getDefaultPermissionRules());
  registerExperienceTools(denied, memory.experience!, memory.experienceContext);
  expect((await denied.execute("propose-lesson", ctx, proposal())).error?.code).toBe(
    "APPROVAL_REQUIRED",
  );
  const registry = new ToolRegistry([{ action: "*", resource: "*", effect: "allow" }]);
  registerExperienceTools(registry, memory.experience!, memory.experienceContext);
  expect(
    registry
      .list()
      .map((t) => t.name)
      .sort(),
  ).toEqual(["contest-lesson", "inspect-experience", "propose-lesson", "search-experiences"]);
  expect(
    (await registry.execute("propose-lesson", ctx, { ...proposal(), author: { kind: "human" } }))
      .ok,
  ).toBe(false);
  const input = proposal();
  const result = await registry.execute("propose-lesson", ctx, input);
  expect(result.ok).toBe(true);
  const candidate = memory.experience!.get("proposal:" + memoryDigest(input));
  expect(candidate.candidate.author.kind).toBe("model");
  expect(candidate.current.state).toBe("evidence_verified");
  const inspected = await registry.execute("inspect-experience", ctx, {
    kind: "lesson",
    id: candidate.candidate.id,
  });
  expect(inspected.ok).toBe(true);
  expect(inspected.data).toMatchObject({
    excludedBy: ["evidence_verified"],
    evidence: [expect.objectContaining({ observation: "AMBER available through a module" })],
  });
  expect(
    (
      await registry.execute("inspect-experience", ctx, {
        kind: "evidence",
        id: "not-in-this-scope",
      })
    ).ok,
  ).toBe(false);
  expect(
    (await memory.retrieveContext("AMBER")).filter((block) => block.name.startsWith("experience:")),
  ).toEqual([]);
});
