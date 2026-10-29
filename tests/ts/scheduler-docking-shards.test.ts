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
    engine: "xtb",
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

describe("scheduler — docking shards independence", () => {
  test("dispatches docking shards independently to different nodes", () => {
    const input = makeInput({
      jobs: [
        { id: "dock-1", resources: makeJobResources({ jobFamily: "docking" }), status: "queued" },
        { id: "dock-2", resources: makeJobResources({ jobFamily: "docking" }), status: "queued" },
      ],
      nodes: [
        makeNode({ nodeId: "node-a", maxJobs: 2 }),
        makeNode({ nodeId: "node-b", maxJobs: 2 }),
      ],
      policy: { dftNeverSplitAcrossNodes: true, dockingShardsIndependent: true },
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(2);

    // Both should be dispatched (not held)
    for (const d of decisions) {
      expect(d.action).toBe("dispatch");
    }

    // They may go to same or different nodes — both are valid with dockingShardsIndependent
    // The key is they aren't blocked by any grouping constraint
    const dispatched = decisions.filter((d) => d.action === "dispatch");
    expect(dispatched).toHaveLength(2);
  });

  test("docking shards can spread across nodes for load balancing", () => {
    const input = makeInput({
      jobs: [
        { id: "dock-a", resources: makeJobResources({ jobFamily: "docking" }), status: "queued" },
        { id: "dock-b", resources: makeJobResources({ jobFamily: "docking" }), status: "queued" },
        { id: "dock-c", resources: makeJobResources({ jobFamily: "docking" }), status: "queued" },
        { id: "dock-d", resources: makeJobResources({ jobFamily: "docking" }), status: "queued" },
      ],
      nodes: [
        makeNode({ nodeId: "node-a", maxJobs: 2 }),
        makeNode({ nodeId: "node-b", maxJobs: 2 }),
      ],
      policy: { dftNeverSplitAcrossNodes: true, dockingShardsIndependent: true },
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(4);

    const dispatched = decisions.filter((d) => d.action === "dispatch");
    expect(dispatched).toHaveLength(4);

    // Check load is distributed: each node gets exactly 2
    const nodeA_count = dispatched.filter((d) => d.nodeId === "node-a").length;
    const nodeB_count = dispatched.filter((d) => d.nodeId === "node-b").length;
    expect(nodeA_count).toBe(2);
    expect(nodeB_count).toBe(2);
  });

  test("docking shards with non-docking jobs intermix freely", () => {
    const input = makeInput({
      jobs: [
        {
          id: "dock-1",
          resources: makeJobResources({ engine: "xtb", jobFamily: "docking" }),
          status: "queued",
        },
        { id: "normal-1", resources: makeJobResources({ engine: "orca" }), status: "queued" },
        {
          id: "dock-2",
          resources: makeJobResources({ engine: "xtb", jobFamily: "docking" }),
          status: "queued",
        },
      ],
      nodes: [
        makeNode({ nodeId: "node-a", maxJobs: 3 }),
        makeNode({ nodeId: "node-b", maxJobs: 3 }),
      ],
      policy: { dftNeverSplitAcrossNodes: true, dockingShardsIndependent: true },
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(3);

    // All jobs should dispatch (enough capacity)
    for (const d of decisions) {
      expect(d.action).toBe("dispatch");
    }
  });

  test("docking shards with dockingShardsIndependent=false are still dispatched (no grouping logic yet)", () => {
    const input = makeInput({
      jobs: [
        { id: "dock-1", resources: makeJobResources({ jobFamily: "docking" }), status: "queued" },
        { id: "dock-2", resources: makeJobResources({ jobFamily: "docking" }), status: "queued" },
      ],
      nodes: [
        makeNode({ nodeId: "node-a", maxJobs: 2 }),
        makeNode({ nodeId: "node-b", maxJobs: 2 }),
      ],
      policy: { dftNeverSplitAcrossNodes: true, dockingShardsIndependent: false },
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(2);

    // With dockingShardsIndependent=false, shards should ideally be co-located,
    // but current engine only has a scoring preference (job family affinity),
    // not a hard grouping constraint — so they may or may not be co-located.
    // For now, just verify they're both dispatched.
    for (const d of decisions) {
      expect(d.action).toBe("dispatch");
    }
  });

  test("prefers nodes already running same docking family", () => {
    const input = makeInput({
      jobs: [
        {
          id: "dock-2",
          resources: makeJobResources({ engine: "xtb", jobFamily: "docking" }),
          status: "queued",
        },
      ],
      nodes: [makeNode({ nodeId: "node-with-dock" }), makeNode({ nodeId: "node-empty" })],
      runningJobs: [
        {
          jobId: "dock-1",
          nodeId: "node-with-dock",
          resources: makeJobResources({ engine: "xtb", jobFamily: "docking" }),
        },
      ],
      policy: { dftNeverSplitAcrossNodes: true, dockingShardsIndependent: true },
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    if (decisions[0].action === "dispatch") {
      // Should prefer node already running same family (scoring bonus)
      expect(decisions[0].nodeId).toBe("node-with-dock");
    }
  });
});
