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

describe("scheduler — capacity budget checks", () => {
  test("holds job when CPU budget is insufficient", () => {
    const input = makeInput({
      jobs: [
        {
          id: "cpu-hungry",
          resources: makeJobResources({ cpuThreads: 32 }),
          status: "queued",
        },
      ],
      nodes: [makeNode({ cpuThreadsTotal: 16, cpuThreadsAvailable: 16 })],
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("hold");
  });

  test("holds job when RAM budget is insufficient", () => {
    const input = makeInput({
      jobs: [
        {
          id: "ram-hungry",
          resources: makeJobResources({ memoryMb: 65536 }),
          status: "queued",
        },
      ],
      nodes: [makeNode({ memoryMbTotal: 32768, memoryMbAvailable: 32768 })],
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("hold");
  });

  test("holds job when scratch budget is insufficient", () => {
    const input = makeInput({
      jobs: [
        {
          id: "scratch-hungry",
          resources: makeJobResources({ scratchMb: 999999 }),
          status: "queued",
        },
      ],
      nodes: [makeNode({ scratchMbTotal: 102400, scratchMbAvailable: 102400 })],
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("hold");
  });

  test("dispatches job when resources exactly match available", () => {
    const input = makeInput({
      jobs: [
        {
          id: "exact-fit",
          resources: makeJobResources({ cpuThreads: 16, memoryMb: 32768, scratchMb: 102400 }),
          status: "queued",
        },
      ],
      nodes: [
        makeNode({
          cpuThreadsTotal: 16,
          cpuThreadsAvailable: 16,
          memoryMbTotal: 32768,
          memoryMbAvailable: 32768,
          scratchMbTotal: 102400,
          scratchMbAvailable: 102400,
        }),
      ],
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("dispatch");
  });

  test("tracks resource consumption across multiple dispatches in same cycle", () => {
    const input = makeInput({
      jobs: [
        { id: "job-a", resources: makeJobResources({ cpuThreads: 8 }), status: "queued" },
        { id: "job-b", resources: makeJobResources({ cpuThreads: 8 }), status: "queued" },
        { id: "job-c", resources: makeJobResources({ cpuThreads: 8 }), status: "queued" },
      ],
      nodes: [makeNode({ cpuThreadsTotal: 16, cpuThreadsAvailable: 16 })],
    });
    const decisions = schedule(input);
    // jobs a and b should fit (8+8=16), job c should not
    expect(decisions).toHaveLength(3);
    expect(decisions[0].action).toBe("dispatch");
    expect(decisions[1].action).toBe("dispatch");
    expect(decisions[2].action).toBe("hold");
  });

  test("computes available resources correctly with running jobs", () => {
    const input = makeInput({
      jobs: [{ id: "new-job", resources: makeJobResources({ cpuThreads: 8 }), status: "queued" }],
      nodes: [makeNode({ cpuThreadsTotal: 16, cpuThreadsAvailable: 8 })],
      runningJobs: [
        { jobId: "running-1", nodeId: "node-1", resources: makeJobResources({ cpuThreads: 8 }) },
      ],
    });
    const decisions = schedule(input);
    // 8 available, need 8 → should dispatch
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("dispatch");
  });

  test("does not dispatch to nodes with critical thermal state", () => {
    const input = makeInput({
      jobs: [{ id: "job-1", resources: makeJobResources(), status: "queued" }],
      nodes: [makeNode({ thermalState: "critical" })],
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("hold");
  });
});
