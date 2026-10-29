import { describe, expect, it } from "bun:test";
import { executeCancelJob } from "../../packages/tool-registry/src/builtin/cancel-job";

const state = {
  statusUpdates: [] as Array<{ jobId: string; status: string }>,
  externalMetadata: [] as Array<{ jobId: string; metadata: Record<string, unknown> }>,
  events: [] as Array<Record<string, unknown>>,
  scancelCalls: [] as string[],
};

function createFakeDatabase() {
  return {
    async getJob(jobId: string) {
      if (jobId !== "job-1") return null;
      return {
        id: "job-1",
        status: "running",
        backend: "slurm",
        externalJobId: "123456",
      };
    },
    async updateJobStatus(jobId: string, status: string) {
      state.statusUpdates.push({ jobId, status });
    },
    async updateJobExternalMetadata(jobId: string, metadata: Record<string, unknown>) {
      state.externalMetadata.push({ jobId, metadata });
    },
    async appendEvent(event: Record<string, unknown>) {
      state.events.push(event);
    },
    async insertEvent(event: Record<string, unknown>) {
      state.events.push(event);
    },
  };
}

describe("cancel-job tool Slurm routing", () => {
  it("routes running Slurm jobs through scancel", async () => {
    const runner = {
      kind: "slurm",
      async stage() {
        return { ok: false };
      },
      async start() {
        return { ok: false };
      },
      async status() {
        return { status: "stopped" as const };
      },
      async stop(job: { id: string }) {
        state.scancelCalls.push(job.id);
        return { ok: true, message: "cancelled" };
      },
      async fetch() {
        return { ok: false };
      },
    };
    const result = await executeCancelJob(
      {
        db: createFakeDatabase() as never,
        python: {} as never,
        runners: { slurm: runner } as never,
        bus: {} as never,
        config: {} as never,
        execution: {
          cancelRemote: async (jobId: string, backend: typeof runner) =>
            backend.stop({ id: jobId }),
        },
      } as never,
      { jobId: "job-1" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        jobId: "job-1",
        previousStatus: "running",
        status: "cancelled",
      });
    }
    expect(state.scancelCalls).toEqual(["job-1"]);
    expect(state.statusUpdates).toEqual([]);
    expect(state.externalMetadata).toHaveLength(0);
    expect(state.events).toHaveLength(0);
  });
});
