import { expect, test } from "bun:test";
import type { ToolContext } from "../types";
import { submitJobTool } from "./submit-job";

test("a remote node cannot silently submit a local job", async () => {
  let executions = 0;
  const ctx = {
    execution: {
      executeLocal: async () => {
        executions++;
        throw new Error("Must not execute locally");
      },
    },
  } as unknown as ToolContext;
  const result = await submitJobTool.execute(ctx, {
    software: "gaussian",
    inputPath: "water.gjf",
    nodeId: "slurm:fixture-cluster:compute-01",
  });
  expect(result.ok).toBe(false);
  expect(result.error?.code).toBe("UNSUPPORTED_TARGET");
  expect(result.error?.message).toContain("no job was submitted");
  expect(executions).toBe(0);
});
