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

describe("scheduler — failure isolation (offline / draining / failed nodes)", () => {
  test("skips disabled nodes", () => {
    const input = makeInput({
      jobs: [{ id: "job-1", resources: makeJobResources(), status: "queued" }],
      nodes: [makeNode({ nodeId: "node-a", enabled: false }), makeNode({ nodeId: "node-b" })],
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    if (decisions[0].action === "dispatch") {
      expect(decisions[0].nodeId).toBe("node-b");
    }
  });

  test("skips draining nodes", () => {
    const input = makeInput({
      jobs: [{ id: "job-1", resources: makeJobResources(), status: "queued" }],
      nodes: [makeNode({ nodeId: "node-a", draining: true }), makeNode({ nodeId: "node-b" })],
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    if (decisions[0].action === "dispatch") {
      expect(decisions[0].nodeId).toBe("node-b");
    }
  });

  test("skips nodes with stale heartbeat (>5 min)", () => {
    const staleTime = Date.now() - 6 * 60 * 1000; // 6 minutes ago
    const input = makeInput({
      jobs: [{ id: "job-1", resources: makeJobResources(), status: "queued" }],
      nodes: [
        makeNode({ nodeId: "node-a", lastSeenAt: staleTime }),
        makeNode({ nodeId: "node-b" }),
      ],
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    if (decisions[0].action === "dispatch") {
      expect(decisions[0].nodeId).toBe("node-b");
    }
  });

  test("skips nodes that have never been seen", () => {
    const input = makeInput({
      jobs: [{ id: "job-1", resources: makeJobResources(), status: "queued" }],
      nodes: [makeNode({ nodeId: "node-a", lastSeenAt: null }), makeNode({ nodeId: "node-b" })],
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    if (decisions[0].action === "dispatch") {
      expect(decisions[0].nodeId).toBe("node-b");
    }
  });

  test("holds job when only available nodes are offline or draining", () => {
    const input = makeInput({
      jobs: [{ id: "job-1", resources: makeJobResources(), status: "queued" }],
      nodes: [
        makeNode({ nodeId: "node-a", enabled: false }),
        makeNode({ nodeId: "node-b", draining: true }),
      ],
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("hold");
  });

  test("skips nodes with critical thermal state", () => {
    const input = makeInput({
      jobs: [{ id: "job-1", resources: makeJobResources(), status: "queued" }],
      nodes: [
        makeNode({ nodeId: "node-a", thermalState: "critical" }),
        makeNode({ nodeId: "node-b" }),
      ],
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    if (decisions[0].action === "dispatch") {
      expect(decisions[0].nodeId).toBe("node-b");
    }
  });

  test("prefers normal thermal nodes over warm nodes", () => {
    const input = makeInput({
      jobs: [{ id: "job-1", resources: makeJobResources(), status: "queued" }],
      nodes: [
        makeNode({ nodeId: "node-hot", thermalState: "hot" }),
        makeNode({ nodeId: "node-warm", thermalState: "warm" }),
        makeNode({ nodeId: "node-cool", thermalState: "normal" }),
      ],
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    // Should pick the coolest node with best score (higher resource headroom)
    if (decisions[0].action === "dispatch") {
      expect(decisions[0].nodeId).toBe("node-cool");
    }
  });

  test("isolates failures — single bad node doesn't prevent dispatch to good nodes", () => {
    const input = makeInput({
      jobs: [{ id: "job-1", resources: makeJobResources(), status: "queued" }],
      nodes: [
        makeNode({ nodeId: "node-failed", enabled: false }),
        makeNode({ nodeId: "node-draining", draining: true }),
        makeNode({ nodeId: "node-stale", lastSeenAt: Date.now() - 10 * 60 * 1000 }),
        makeNode({ nodeId: "node-good" }),
      ],
    });
    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    if (decisions[0].action === "dispatch") {
      expect(decisions[0].nodeId).toBe("node-good");
    }
  });
});
