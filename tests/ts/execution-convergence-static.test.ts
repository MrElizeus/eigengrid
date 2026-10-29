import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");

describe("canonical execution boundary", () => {
  test("effectful CLI entry points dispatch through ExecutionCoordinator", () => {
    for (const command of ["cancel.ts", "collect.ts", "status.ts"]) {
      const source = readFileSync(join(root, "apps/cli/src/commands", command), "utf8");
      expect(source).toContain("ctx.execution.");
      expect(source).not.toMatch(/\b(?:runner|backend)\.(?:start|stop|fetch|status)\s*\(/u);
    }
    const submit = readFileSync(join(root, "apps/cli/src/commands/submit.ts"), "utf8");
    expect(submit).toContain("ctx.execution.executeLocal");
    expect(submit).toContain("ctx.execution.dispatchRemote");
    const productionHandler = submit.slice(submit.indexOf("export async function runSubmit"));
    expect(productionHandler).not.toMatch(
      /\b(?:runner|backend)\.(?:start|stop|fetch|status)\s*\(/u,
    );
  });

  test("remote operation methods are exposed only by the coordinator service", () => {
    const source = readFileSync(
      join(root, "apps/cli/src/services/execution-coordinator.ts"),
      "utf8",
    );
    for (const method of ["dispatchRemote", "reconcileRemote", "cancelRemote", "collectRemote"]) {
      expect(source).toContain(`async ${method}(`);
    }
    const commands = ["submit.ts", "cancel.ts", "collect.ts", "status.ts"]
      .map((command) => readFileSync(join(root, "apps/cli/src/commands", command), "utf8"))
      .join("\n");
    expect(
      commands.match(/\.execution\.(?:dispatchRemote|reconcileRemote|cancelRemote|collectRemote)/gu)
        ?.length,
    ).toBeGreaterThanOrEqual(4);
  });

  test("agent parsing enters through the coordinator in production", () => {
    const source = readFileSync(
      join(root, "packages/tool-registry/src/builtin/parse-job-output.ts"),
      "utf8",
    );
    expect(source).toContain("ctx.execution?.parseJob");
    expect(source).toContain("parseJob(input.jobId, input.attemptId)");
  });
});
