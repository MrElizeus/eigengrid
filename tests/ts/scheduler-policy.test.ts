import { describe, expect, test } from "bun:test";
import { schedule, DEFAULT_SCHEDULER_POLICY } from "@eigengrid/scheduler";
import type { NodeCapacity, JobResources, SchedulerInput } from "@eigengrid/scheduler";

function makeNode(overrides: Partial<NodeCapacity> = {}): NodeCapacity {
  return {
    nodeId: "node-1",
    enabled: true,
    draining: false,
    maxJobs: 4,
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

describe("scheduler — basic dispatch logic", () => {
  test("dispatches a simple job to an available node", () => {
    const input = makeInput({
      jobs: [{ id: "job-1", resources: makeJobResources(), status: "queued" }],
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("dispatch");
    if (decisions[0].action === "dispatch") {
      expect(decisions[0].nodeId).toBe("node-1");
      expect(decisions[0].jobId).toBe("job-1");
    }
  });

  test("holds a job when no node is enabled", () => {
    const input = makeInput({
      jobs: [{ id: "job-1", resources: makeJobResources(), status: "queued" }],
      nodes: [makeNode({ enabled: false })],
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("hold");
    if (decisions[0].action === "hold") {
      expect(decisions[0].reason).toContain("No enabled nodes");
    }
  });

  test("holds a job when no node supports the required engine", () => {
    const input = makeInput({
      jobs: [{ id: "job-1", resources: makeJobResources({ engine: "gromacs" }), status: "queued" }],
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("hold");
    if (decisions[0].action === "hold") {
      expect(decisions[0].reason).toContain("gromacs");
    }
  });

  test("holds a job when node is at maxJobs capacity", () => {
    const input = makeInput({
      jobs: [{ id: "job-2", resources: makeJobResources(), status: "queued" }],
      nodes: [makeNode({ maxJobs: 1 })],
      runningJobs: [{ jobId: "existing", nodeId: "node-1", resources: makeJobResources() }],
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("hold");
  });

  test("dispatches high priority jobs before low priority", () => {
    const input = makeInput({
      jobs: [
        { id: "low-pri", resources: makeJobResources({ priority: "low" }), status: "queued" },
        { id: "high-pri", resources: makeJobResources({ priority: "high" }), status: "queued" },
      ],
      nodes: [makeNode({ maxJobs: 1 })],
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(2);

    // High priority should be first and dispatched
    expect(decisions[0].jobId).toBe("high-pri");
    expect(decisions[0].action).toBe("dispatch");

    // Low priority should be held (node at capacity after high-pri)
    expect(decisions[1].jobId).toBe("low-pri");
    expect(decisions[1].action).toBe("hold");
  });

  test("handles empty job queue gracefully", () => {
    const input = makeInput({ jobs: [] });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(0);
  });

  test("handles multiple nodes — picks best scored", () => {
    const input = makeInput({
      jobs: [{ id: "job-1", resources: makeJobResources(), status: "queued" }],
      nodes: [
        makeNode({ nodeId: "node-a", cpuThreadsTotal: 8, cpuThreadsAvailable: 8 }),
        makeNode({
          nodeId: "node-b",
          cpuThreadsTotal: 32,
          cpuThreadsAvailable: 32,
          memoryMbTotal: 65536,
          memoryMbAvailable: 65536,
          scratchMbTotal: 204800,
          scratchMbAvailable: 204800,
        }),
      ],
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("dispatch");
    // node-b has more resources → better score
    if (decisions[0].action === "dispatch") {
      expect(decisions[0].nodeId).toBe("node-b");
    }
  });
});
