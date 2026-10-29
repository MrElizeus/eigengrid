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
    nodes: [],
    runningJobs: [],
    policy: DEFAULT_SCHEDULER_POLICY,
    ...overrides,
  };
}

describe("scheduler — DFT never split across nodes policy", () => {
  test("places all DFT jobs on the same node when policy is enabled", () => {
    const input = makeInput({
      jobs: [
        { id: "dft-1", resources: makeJobResources({ engine: "orca" }), status: "queued" },
        { id: "dft-2", resources: makeJobResources({ engine: "gaussian" }), status: "queued" },
        { id: "dft-3", resources: makeJobResources({ engine: "orca" }), status: "queued" },
      ],
      nodes: [makeNode({ nodeId: "node-a" }), makeNode({ nodeId: "node-b" })],
      policy: { dftNeverSplitAcrossNodes: true, dockingShardsIndependent: true },
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(3);

    const dispatched = decisions.filter((d) => d.action === "dispatch") as Array<{
      action: "dispatch";
      jobId: string;
      nodeId: string;
      reason: string;
      resources: JobResources;
    }>;
    expect(dispatched).toHaveLength(3);

    const targetNode = dispatched[0].nodeId;
    for (const d of dispatched) {
      expect(d.nodeId).toBe(targetNode);
    }
  });

  test("allows DFT jobs on any node when no DFT jobs are running and no previous cycle decision exists", () => {
    const input = makeInput({
      jobs: [{ id: "dft-1", resources: makeJobResources({ engine: "orca" }), status: "queued" }],
      nodes: [makeNode({ nodeId: "node-a" }), makeNode({ nodeId: "node-b" })],
      policy: { dftNeverSplitAcrossNodes: true, dockingShardsIndependent: true },
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("dispatch");
    // Should pick the best-scored node — either is fine
  });

  test("pins new DFT jobs to the node already running DFT", () => {
    const input = makeInput({
      jobs: [{ id: "dft-new", resources: makeJobResources({ engine: "orca" }), status: "queued" }],
      nodes: [makeNode({ nodeId: "node-with-dft" }), makeNode({ nodeId: "node-empty" })],
      runningJobs: [
        {
          jobId: "existing-dft",
          nodeId: "node-with-dft",
          resources: makeJobResources({ engine: "gaussian" }),
        },
      ],
      policy: { dftNeverSplitAcrossNodes: true, dockingShardsIndependent: true },
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    if (decisions[0].action === "dispatch") {
      expect(decisions[0].nodeId).toBe("node-with-dft");
    }
  });

  test("holds DFT job when the DFT node is at capacity", () => {
    const input = makeInput({
      jobs: [{ id: "dft-new", resources: makeJobResources({ engine: "orca" }), status: "queued" }],
      nodes: [makeNode({ nodeId: "dft-node", maxJobs: 1 }), makeNode({ nodeId: "empty-node" })],
      runningJobs: [
        {
          jobId: "existing-dft",
          nodeId: "dft-node",
          resources: makeJobResources({ engine: "gaussian" }),
        },
      ],
      policy: { dftNeverSplitAcrossNodes: true, dockingShardsIndependent: true },
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("hold");
    if (decisions[0].action === "hold") {
      expect(decisions[0].reason).toContain("DFT");
    }
  });

  test("allows non-DFT jobs to dispatch freely to any node regardless of DFT policy", () => {
    const input = makeInput({
      jobs: [{ id: "non-dft", resources: makeJobResources({ engine: "xtb" }), status: "queued" }],
      nodes: [makeNode({ nodeId: "dft-node" }), makeNode({ nodeId: "other-node" })],
      runningJobs: [
        {
          jobId: "existing-dft",
          nodeId: "dft-node",
          resources: makeJobResources({ engine: "orca" }),
        },
      ],
      policy: { dftNeverSplitAcrossNodes: true, dockingShardsIndependent: true },
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("dispatch");
    // xtb is not DFT, so it can go to any node (prefer higher scored)
  });

  test("respects dftNeverSplitAcrossNodes=false — allows splitting DFT across nodes", () => {
    const input = makeInput({
      jobs: [
        { id: "dft-1", resources: makeJobResources({ engine: "orca" }), status: "queued" },
        { id: "dft-2", resources: makeJobResources({ engine: "gaussian" }), status: "queued" },
      ],
      nodes: [
        makeNode({ nodeId: "node-a", maxJobs: 1 }),
        makeNode({ nodeId: "node-b", maxJobs: 1 }),
      ],
      policy: { dftNeverSplitAcrossNodes: false, dockingShardsIndependent: true },
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(2);
    const dispatched = decisions.filter((d) => d.action === "dispatch");
    // With maxJobs=1 on each node, both should be dispatched to different nodes
    expect(dispatched).toHaveLength(2);
  });
});
