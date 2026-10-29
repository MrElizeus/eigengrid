import { describe, expect, test } from "bun:test";
import {
  schedule,
  planPower,
  DEFAULT_SCHEDULER_POLICY,
  DEFAULT_IDLE_POWER_DOWN_SEC,
} from "@eigengrid/scheduler";
import type {
  NodeCapacity,
  JobResources,
  SchedulerInput,
  PowerDecision,
} from "@eigengrid/scheduler";

const NOW = 1_000_000_000_000;

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
    lastSeenAt: NOW,
    isHead: false,
    powerMode: "manual",
    macAddress: undefined,
    broadcastAddress: undefined,
    wolPort: undefined,
    allowWake: false,
    allowPowerDown: false,
    idlePowerDownAfterSec: 300,
    lastWakeAt: null,
    lastPowerDownAt: null,
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

// ── Plan dry-run semantics ─────────────────────────────────

describe("power integration — plan dry-run semantics", () => {
  test("planPower is a pure function (same input → same output)", () => {
    const input = {
      nodes: [
        makeNode({
          nodeId: "node-a",
          allowWake: true,
          lastSeenAt: null,
          macAddress: "AA:BB:CC:DD:EE:FF",
          broadcastAddress: "192.168.1.255",
          engines: ["orca"],
        }),
      ],
      pendingJobs: [{ id: "job-1", resources: makeJobResources() }],
      runningJobs: [],
      now: NOW,
    };

    const result1 = planPower(input);
    const result2 = planPower(input);
    expect(result1).toEqual(result2);
  });

  test("planPower does not mutate its input", () => {
    const nodes = [
      makeNode({
        nodeId: "node-a",
        allowWake: true,
        lastSeenAt: null,
        macAddress: "AA:BB:CC:DD:EE:FF",
        broadcastAddress: "192.168.1.255",
        engines: ["orca"],
      }),
    ];
    const input = {
      nodes,
      pendingJobs: [{ id: "job-1", resources: makeJobResources() }],
      runningJobs: [],
      now: NOW,
    };

    const snapshot = JSON.stringify(input);
    planPower(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  test("planPower can be called alongside schedule for combined output", () => {
    // Simulate the CLI combining both outputs
    const nodes = [
      makeNode({
        nodeId: "sleepy-node",
        allowWake: true,
        lastSeenAt: null,
        macAddress: "AA:BB:CC:DD:EE:FF",
        broadcastAddress: "192.168.1.255",
        engines: ["orca"],
      }),
    ];

    const schedulingInput: SchedulerInput = {
      jobs: [{ id: "job-1", resources: makeJobResources(), status: "queued" }],
      nodes,
      runningJobs: [],
      policy: DEFAULT_SCHEDULER_POLICY,
    };

    const powerInput = {
      nodes,
      pendingJobs: [{ id: "job-1", resources: makeJobResources() }],
      runningJobs: [],
      now: NOW,
    };

    // Both can be called independently
    const schedDecisions = schedule(schedulingInput);
    const powerDecisions = planPower(powerInput);

    // Scheduling: job-1 should be held because sleepy-node is offline
    expect(schedDecisions).toHaveLength(1);
    expect(schedDecisions[0].action).toBe("hold");

    // Power: sleepy-node should get a wake proposal
    const wake = powerDecisions.find((d) => d.action === "wake") as PowerDecision & {
      action: "wake";
    };
    expect(wake).toBeDefined();
    expect(wake.nodeId).toBe("sleepy-node");
  });
});

// ── Wake-then-dispatch ordering ─────────────────────────────

describe("power integration — wake before dispatch", () => {
  test("jobs remain held when node is offline with stale heartbeat (even after wake)", () => {
    // schedule() uses Date.now() internally, so use real timestamps
    const staleNow = Date.now() - 600_000; // 10 min ago = stale
    const nodes = [
      makeNode({
        nodeId: "node-a",
        lastSeenAt: staleNow, // stale heartbeat
        engines: ["orca"],
      }),
    ];

    const input: SchedulerInput = {
      jobs: [{ id: "job-1", resources: makeJobResources(), status: "queued" }],
      nodes,
      runningJobs: [],
      policy: DEFAULT_SCHEDULER_POLICY,
    };

    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("hold");
    expect(decisions[0].reason).toContain("heartbeat");
  });

  test("job dispatched when node confirms heartbeat after wake", () => {
    // schedule() uses Date.now() internally, so we use a real recent timestamp
    const freshNow = Date.now();
    const nodes = [
      makeNode({
        nodeId: "node-a",
        lastSeenAt: freshNow - 10_000, // 10 seconds ago = fresh heartbeat
        engines: ["orca"],
      }),
    ];

    const input: SchedulerInput = {
      jobs: [{ id: "job-1", resources: makeJobResources(), status: "queued" }],
      nodes,
      runningJobs: [],
      policy: DEFAULT_SCHEDULER_POLICY,
    };

    const decisions = schedule(input);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("dispatch");
  });
});

// ── Safety invariants ──────────────────────────────────────

describe("power integration — safety invariants", () => {
  test("power-down is disabled by default (allowPowerDown defaults to false)", () => {
    const node = makeNode({ allowPowerDown: false, isHead: false, lastSeenAt: NOW - 600_000 });
    const decisions = planPower({
      nodes: [node],
      pendingJobs: [],
      runningJobs: [],
      now: NOW,
    });
    expect(decisions.filter((d) => d.action === "power_down")).toHaveLength(0);
  });

  test("wake is disabled by default (allowWake defaults to false)", () => {
    const node = makeNode({
      allowWake: false,
      lastSeenAt: null,
      macAddress: "AA:BB:CC:DD:EE:FF",
      broadcastAddress: "192.168.1.255",
    });
    const decisions = planPower({
      nodes: [node],
      pendingJobs: [],
      runningJobs: [],
      now: NOW,
    });
    expect(decisions.filter((d) => d.action === "wake")).toHaveLength(0);
  });

  test("DEFAULT_IDLE_POWER_DOWN_SEC is 300", () => {
    expect(DEFAULT_IDLE_POWER_DOWN_SEC).toBe(300);
  });
});
