import { describe, expect, test } from "bun:test";
import { schedule, DEFAULT_SCHEDULER_POLICY } from "@eigengrid/scheduler";
import type { NodeCapacity, JobResources, SchedulerInput } from "@eigengrid/scheduler";

function makeNode(overrides: Partial<NodeCapacity> = {}): NodeCapacity {
  return {
    nodeId: "node-1",
    enabled: true,
    draining: false,
    maxJobs: 10,
    engines: ["orca", "gaussian", "xtb", "cp2k"],
    cpuThreadsTotal: 16,
    cpuThreadsAvailable: 16,
    memoryMbTotal: 32768,
    memoryMbAvailable: 32768,
    scratchMbTotal: 102400,
    scratchMbAvailable: 102400,
    thermalState: "normal",
    lastSeenAt: Date.now(),
    ...overrides,
  };
}

function makeJobResources(overrides: Partial<JobResources> = {}): JobResources {
  return {
    engine: "orca",
    cpuThreads: 1,
    memoryMb: 1024,
    scratchMb: 1024,
    priority: "normal",
    ...overrides,
  };
}

function makeInput(overrides: Partial<SchedulerInput> = {}): SchedulerInput {
  return {
    jobs: [],
    nodes: [makeNode()],
    runningJobs: [],
    policy: DEFAULT_SCHEDULER_POLICY,
    ...overrides,
  };
}

describe("scheduler — multi-node dispatch scenarios", () => {
  test("distributes jobs across multiple nodes", () => {
    const input = makeInput({
      jobs: [
        { id: "job-1", resources: makeJobResources({ engine: "xtb" }), status: "queued" },
        { id: "job-2", resources: makeJobResources({ engine: "cp2k" }), status: "queued" },
        { id: "job-3", resources: makeJobResources({ engine: "orca" }), status: "queued" },
      ],
      nodes: [
        makeNode({ nodeId: "node-a", engines: ["orca", "xtb"] }),
        makeNode({ nodeId: "node-b", engines: ["cp2k", "gaussian"] }),
      ],
    });
    const decisions = schedule(input);

    // job-1 (xtb) → node-a, job-2 (cp2k) → node-b, job-3 (orca) → node-a
    expect(decisions).toHaveLength(3);
    for (const d of decisions) {
      expect(d.action).toBe("dispatch");
    }

    const dispatched = decisions.filter((d) => d.action === "dispatch") as Array<{
      action: "dispatch";
      jobId: string;
      nodeId: string;
      reason: string;
      resources: JobResources;
    }>;

    // Check xtb went to node-a
    const xtbJob = dispatched.find((d) => d.jobId === "job-1");
    expect(xtbJob?.nodeId).toBe("node-a");

    // Check cp2k went to node-b
    const cp2kJob = dispatched.find((d) => d.jobId === "job-2");
    expect(cp2kJob?.nodeId).toBe("node-b");

    // Check orca went to node-a
    const orcaJob = dispatched.find((d) => d.jobId === "job-3");
    expect(orcaJob?.nodeId).toBe("node-a");
  });

  test("prefers node with more available resources", () => {
    const input = makeInput({
      jobs: [{ id: "job-1", resources: makeJobResources(), status: "queued" }],
      nodes: [
        makeNode({
          nodeId: "node-small",
          cpuThreadsTotal: 4,
          cpuThreadsAvailable: 4,
          memoryMbTotal: 4096,
          memoryMbAvailable: 4096,
          scratchMbTotal: 10240,
          scratchMbAvailable: 10240,
        }),
        makeNode({
          nodeId: "node-large",
          cpuThreadsTotal: 64,
          cpuThreadsAvailable: 64,
          memoryMbTotal: 262144,
          memoryMbAvailable: 262144,
          scratchMbTotal: 1048576,
          scratchMbAvailable: 1048576,
        }),
      ],
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    if (decisions[0].action === "dispatch") {
      expect(decisions[0].nodeId).toBe("node-large");
    }
  });

  test("dispatches multiple jobs by distributing across nodes for load balance", () => {
    // Use non-DFT engine (xtb) so jobs can be split across nodes
    const input = makeInput({
      jobs: [
        {
          id: "job-a",
          resources: makeJobResources({ engine: "xtb", cpuThreads: 8 }),
          status: "queued",
        },
        {
          id: "job-b",
          resources: makeJobResources({ engine: "xtb", cpuThreads: 8 }),
          status: "queued",
        },
        {
          id: "job-c",
          resources: makeJobResources({ engine: "xtb", cpuThreads: 8 }),
          status: "queued",
        },
        {
          id: "job-d",
          resources: makeJobResources({ engine: "xtb", cpuThreads: 8 }),
          status: "queued",
        },
      ],
      nodes: [
        makeNode({ nodeId: "node-a", cpuThreadsTotal: 16, cpuThreadsAvailable: 16, maxJobs: 4 }),
        makeNode({ nodeId: "node-b", cpuThreadsTotal: 16, cpuThreadsAvailable: 16, maxJobs: 4 }),
      ],
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(4);

    const dispatched = decisions.filter((d) => d.action === "dispatch") as Array<{
      action: "dispatch";
      jobId: string;
      nodeId: string;
      reason: string;
      resources: JobResources;
    }>;
    expect(dispatched).toHaveLength(4);

    // Scheduler distributes load: job-a to node-a, then node-b has higher headroom
    // for job-b, job-c fills node-a alongside job-a, job-d fills node-b alongside job-b.
    // Each node gets exactly 2 jobs (8+8=16 CPU each).
    const nodeA_count = dispatched.filter((d) => d.nodeId === "node-a").length;
    const nodeB_count = dispatched.filter((d) => d.nodeId === "node-b").length;
    expect(nodeA_count).toBe(2);
    expect(nodeB_count).toBe(2);
  });
});
