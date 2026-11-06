import { expect, test } from "bun:test";
import type { ToolContext } from "../types";
import { doctorTool } from "./doctor";
import { listNodesTool } from "./list-nodes";
import { inspectNodeTool } from "./inspect-node";
import { getJobStatusTool } from "./get-job-status";

function context(): ToolContext {
  return {
    config: { pythonCommand: process.execPath },
    db: {
      listNodes: async () => [{ id: "local", name: "login" }],
      getNode: async () => null,
      listJobs: async () => [{ id: "job-1", status: "running" }],
      getJob: async () => ({ id: "job-1", status: "running", software: "orca" }),
      listJobAttempts: async () => [],
      listArtifacts: async () => [],
    },
    listComputeNodes: async () => [
      { id: "slurm:cluster:beast", name: "beast", status: "online" },
      { id: "slurm:cluster:worker", name: "worker", status: "online" },
    ],
  } as unknown as ToolContext;
}
test("doctor, list and inspection use the same live node inventory", async () => {
  const ctx = context();
  const doctor = await doctorTool.execute(ctx, {});
  expect(doctor.data?.checks.find((c) => c.name === "Compute nodes")?.detail).toBe(
    "2 node(s) in current inventory",
  );
  expect((await listNodesTool.execute(ctx, {})).data?.total).toBe(2);
  expect((await inspectNodeTool.execute(ctx, { nodeId: "beast" })).data?.node).toMatchObject({
    name: "beast",
  });
  ctx.listComputeNodes = undefined;
  expect((await listNodesTool.execute(ctx, {})).data?.total).toBe(1);
});
test("unavailable live inventory never silently reports the stored registry as live", async () => {
  const ctx = context();
  ctx.listComputeNodes = async () => {
    throw new Error("Slurm unavailable");
  };
  expect((await listNodesTool.execute(ctx, {})).ok).toBe(false);
  expect((await inspectNodeTool.execute(ctx, { nodeId: "beast" })).ok).toBe(false);
  expect(
    (await doctorTool.execute(ctx, {})).data?.checks.find((c) => c.name === "Compute nodes")
      ?.status,
  ).toBe("warn");
});
test("stored running is explicitly unverified and exposes the authorized reconciliation path", async () => {
  const result = await getJobStatusTool.execute(context(), { jobId: "job-1" });
  expect(result.data).toMatchObject({
    statusSource: "database",
    liveVerified: false,
    job: { status: "running" },
    reconciliation: { command: "eigengrid", args: ["status", "job-1"], mutatesState: true },
  });
  expect(getJobStatusTool.outputSchema.safeParse(result.data).success).toBe(true);
});
