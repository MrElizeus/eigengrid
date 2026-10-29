import { describe, expect, test } from "bun:test";
import { planPower } from "@eigengrid/scheduler";
import type { NodeCapacity, SchedulerPowerInput, PowerDecision } from "@eigengrid/scheduler";

const NOW = 1_000_000_000_000;
function makePowerNode(overrides: Partial<NodeCapacity> = {}): NodeCapacity {
  return {
    nodeId: "node-1",
    enabled: true,
    draining: false,
    maxJobs: 10,
    engines: ["orca", "gaussian", "xtb"],
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

function makePowerInput(overrides: Partial<SchedulerPowerInput> = {}): SchedulerPowerInput {
  return {
    nodes: [],
    pendingJobs: [],
    runningJobs: [],
    now: NOW,
    ...overrides,
  };
}

describe("planPower — wake decisions", () => {
  test("proposes wake for offline wakeable node with compatible pending jobs", () => {
    const input = makePowerInput({
      nodes: [
        makePowerNode({
          nodeId: "node-a",
          allowWake: true,
          lastSeenAt: null, // offline
          macAddress: "AA:BB:CC:DD:EE:FF",
          broadcastAddress: "192.168.1.255",
          engines: ["orca"],
        }),
      ],
      pendingJobs: [
        {
          id: "job-1",
          resources: {
            engine: "orca",
            cpuThreads: 1,
            memoryMb: 1024,
            scratchMb: 1024,
            priority: "normal",
          },
        },
      ],
    });

    const decisions = planPower(input);
    const wakeDecisions = decisions.filter(
      (d): d is PowerDecision & { action: "wake" } => d.action === "wake",
    );
    expect(wakeDecisions).toHaveLength(1);
    expect(wakeDecisions[0].nodeId).toBe("node-a");
    expect(wakeDecisions[0].macAddress).toBe("AA:BB:CC:DD:EE:FF");
    expect(wakeDecisions[0].broadcastAddress).toBe("192.168.1.255");
    expect(wakeDecisions[0].wolPort).toBe(9); // default
  });

  test("skips wake for offline wakeable node with no compatible jobs (wrong engine)", () => {
    const input = makePowerInput({
      nodes: [
        makePowerNode({
          nodeId: "node-a",
          allowWake: true,
          lastSeenAt: null,
          macAddress: "AA:BB:CC:DD:EE:FF",
          broadcastAddress: "192.168.1.255",
          engines: ["cp2k"],
        }),
      ],
      pendingJobs: [
        {
          id: "job-1",
          resources: {
            engine: "orca",
            cpuThreads: 1,
            memoryMb: 1024,
            scratchMb: 1024,
            priority: "normal",
          },
        },
      ],
    });

    const decisions = planPower(input);
    const skipped = decisions.filter((d) => d.action === "skip_wake");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].nodeId).toBe("node-a");
    expect(skipped[0].reason).toContain("No compatible");
  });

  test("skips wake when macAddress is missing", () => {
    const input = makePowerInput({
      nodes: [
        makePowerNode({
          nodeId: "node-a",
          allowWake: true,
          lastSeenAt: null,
          macAddress: undefined,
          broadcastAddress: "192.168.1.255",
        }),
      ],
      pendingJobs: [
        {
          id: "job-1",
          resources: {
            engine: "orca",
            cpuThreads: 1,
            memoryMb: 1024,
            scratchMb: 1024,
            priority: "normal",
          },
        },
      ],
    });

    const decisions = planPower(input);
    const skipped = decisions.filter((d) => d.action === "skip_wake");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toContain("Missing MAC");
  });

  test("does not propose wake for already-online node", () => {
    const input = makePowerInput({
      nodes: [
        makePowerNode({
          nodeId: "node-a",
          allowWake: true,
          lastSeenAt: NOW, // online
          macAddress: "AA:BB:CC:DD:EE:FF",
          broadcastAddress: "192.168.1.255",
        }),
      ],
      pendingJobs: [
        {
          id: "job-1",
          resources: {
            engine: "orca",
            cpuThreads: 1,
            memoryMb: 1024,
            scratchMb: 1024,
            priority: "normal",
          },
        },
      ],
    });

    const decisions = planPower(input);
    const wakeDecisions = decisions.filter((d) => d.action === "wake");
    expect(wakeDecisions).toHaveLength(0);
  });

  test("does not propose wake when allowWake is false", () => {
    const input = makePowerInput({
      nodes: [
        makePowerNode({
          nodeId: "node-a",
          allowWake: false,
          lastSeenAt: null,
          macAddress: "AA:BB:CC:DD:EE:FF",
          broadcastAddress: "192.168.1.255",
        }),
      ],
      pendingJobs: [
        {
          id: "job-1",
          resources: {
            engine: "orca",
            cpuThreads: 1,
            memoryMb: 1024,
            scratchMb: 1024,
            priority: "normal",
          },
        },
      ],
    });

    const decisions = planPower(input);
    expect(decisions).toHaveLength(0);
  });
});

describe("planPower — power-down decisions", () => {
  test("blocks power down for head node", () => {
    const input = makePowerInput({
      nodes: [
        makePowerNode({
          nodeId: "head-node",
          isHead: true,
          allowPowerDown: true,
          lastSeenAt: NOW - 600_000, // idle for 10 min
        }),
      ],
    });

    const decisions = planPower(input);
    const blocked = decisions.filter((d) => d.action === "block_power_down");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].nodeId).toBe("head-node");
    expect(blocked[0].reason).toContain("Head node");
  });

  test("blocks power down for node with running jobs", () => {
    const input = makePowerInput({
      nodes: [
        makePowerNode({
          nodeId: "node-a",
          allowPowerDown: true,
          lastSeenAt: NOW - 600_000,
        }),
      ],
      runningJobs: [{ jobId: "job-1", nodeId: "node-a" }],
    });

    const decisions = planPower(input);
    const blocked = decisions.filter((d) => d.action === "block_power_down");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].reason).toContain("running jobs");
  });

  test("proposes power down for idle node past grace period", () => {
    const input = makePowerInput({
      nodes: [
        makePowerNode({
          nodeId: "node-a",
          allowPowerDown: true,
          lastSeenAt: NOW - 600_000, // 10 min ago
          idlePowerDownAfterSec: 300, // 5 min threshold
        }),
      ],
    });

    const decisions = planPower(input);
    const pd = decisions.filter((d) => d.action === "power_down");
    expect(pd).toHaveLength(1);
    expect(pd[0].nodeId).toBe("node-a");
    expect(pd[0].reason).toContain("Idle");
  });

  test("skips power down if not idle long enough", () => {
    const input = makePowerInput({
      nodes: [
        makePowerNode({
          nodeId: "node-a",
          allowPowerDown: true,
          lastSeenAt: NOW - 60_000, // 1 min ago
          idlePowerDownAfterSec: 300,
        }),
      ],
    });

    const decisions = planPower(input);
    const skipped = decisions.filter((d) => d.action === "skip_power_down");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toContain("idle enough");
  });

  test("skips power down if allowPowerDown is false", () => {
    const input = makePowerInput({
      nodes: [
        makePowerNode({
          nodeId: "node-a",
          allowPowerDown: false,
          lastSeenAt: NOW - 600_000,
        }),
      ],
    });

    const decisions = planPower(input);
    const pd = decisions.filter((d) => d.action === "power_down");
    expect(pd).toHaveLength(0);
  });

  test("skips power down for nodes never seen", () => {
    const input = makePowerInput({
      nodes: [
        makePowerNode({
          nodeId: "node-a",
          allowPowerDown: true,
          lastSeenAt: null,
        }),
      ],
    });

    const decisions = planPower(input);
    const skipped = decisions.filter((d) => d.action === "skip_power_down");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toContain("never seen");
  });
});

describe("planPower — mixed scenarios", () => {
  test("produces multiple decisions for different nodes", () => {
    const input = makePowerInput({
      nodes: [
        makePowerNode({
          nodeId: "node-a",
          allowWake: true,
          lastSeenAt: null,
          macAddress: "AA:BB:CC:DD:EE:FF",
          broadcastAddress: "192.168.1.255",
          engines: ["orca"],
        }),
        makePowerNode({
          nodeId: "head-node",
          isHead: true,
          allowPowerDown: true,
          lastSeenAt: NOW - 600_000,
        }),
        makePowerNode({
          nodeId: "node-c",
          allowPowerDown: false,
          allowWake: false,
        }),
      ],
      pendingJobs: [
        {
          id: "job-1",
          resources: {
            engine: "orca",
            cpuThreads: 1,
            memoryMb: 1024,
            scratchMb: 1024,
            priority: "normal",
          },
        },
      ],
    });

    const decisions = planPower(input);
    // node-a → wake, head-node → block_power_down, node-c → nothing (no power config)
    expect(decisions.length).toBeGreaterThanOrEqual(2);
    const wake = decisions.find((d) => d.nodeId === "node-a" && d.action === "wake");
    const block = decisions.find(
      (d) => d.nodeId === "head-node" && d.action === "block_power_down",
    );
    expect(wake).toBeDefined();
    expect(block).toBeDefined();
  });

  test("returns empty array when no power decisions needed", () => {
    const input = makePowerInput({
      nodes: [
        makePowerNode({
          nodeId: "node-a",
          allowWake: false,
          allowPowerDown: false,
        }),
      ],
    });
    const decisions = planPower(input);
    expect(decisions).toHaveLength(0);
  });
});

describe("planPower — uses default idlePowerDownAfterSec", () => {
  test("defaults to 300s when idlePowerDownAfterSec is undefined", () => {
    const input = makePowerInput({
      nodes: [
        makePowerNode({
          nodeId: "node-a",
          allowPowerDown: true,
          lastSeenAt: NOW - 350_000, // ~5.8 min > 5 min default
          idlePowerDownAfterSec: undefined,
        }),
      ],
    });

    const decisions = planPower(input);
    const pd = decisions.filter((d) => d.action === "power_down");
    expect(pd).toHaveLength(1);
  });
});
