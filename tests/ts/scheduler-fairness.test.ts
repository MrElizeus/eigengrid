import { describe, expect, it } from "bun:test";
import { schedule, DEFAULT_SCHEDULER_POLICY } from "@eigengrid/scheduler";
import type { SchedulerInput, NodeCapacity, ProjectFairnessConfig } from "@eigengrid/scheduler";

function makeNode(overrides: Partial<NodeCapacity> & { nodeId: string }): NodeCapacity {
  return {
    enabled: true,
    draining: false,
    maxJobs: 10,
    engines: ["orca"],
    cpuThreadsTotal: 16,
    cpuThreadsAvailable: 16,
    memoryMbTotal: 65536,
    memoryMbAvailable: 65536,
    scratchMbTotal: 102400,
    scratchMbAvailable: 102400,
    thermalState: "normal",
    lastSeenAt: Date.now(),
    powerMode: "manual",
    allowWake: false,
    allowPowerDown: false,
    ...overrides,
  };
}

function makeJob(
  overrides: { id: string; projectId?: string } & Partial<{
    status: string;
    priority: string;
    engine: string;
  }>,
) {
  return {
    id: overrides.id,
    status: overrides.status ?? "queued",
    resources: {
      engine: overrides.engine ?? "orca",
      cpuThreads: 1,
      memoryMb: 1024,
      scratchMb: 1024,
      priority: (overrides.priority ?? "normal") as "low" | "normal" | "high",
    },
    projectId: overrides.projectId,
  };
}

function makeProjectConfig(
  overrides: Partial<ProjectFairnessConfig> & { projectId: string },
): ProjectFairnessConfig {
  return {
    maxConcurrentJobs: 0,
    quotaCpuThreads: 0,
    quotaMemoryMb: 0,
    quotaScratchMb: 0,
    quotaJobsTotal: 0,
    weight: 1.0,
    runningJobCount: 0,
    usedCpuThreads: 0,
    usedMemoryMb: 0,
    usedScratchMb: 0,
    ...overrides,
  };
}

function buildInput(overrides: Partial<SchedulerInput>): SchedulerInput {
  return {
    jobs: [],
    nodes: [],
    runningJobs: [],
    policy: DEFAULT_SCHEDULER_POLICY,
    ...overrides,
  };
}

describe("scheduler fairness — project maxConcurrentJobs", () => {
  it("holds jobs when project reaches maxConcurrentJobs", () => {
    const node = makeNode({ nodeId: "node-1" });
    const input = buildInput({
      jobs: [makeJob({ id: "job-1", projectId: "proj-a" })],
      nodes: [node],
      runningJobs: [
        {
          jobId: "running-1",
          nodeId: "node-1",
          resources: {
            engine: "orca",
            cpuThreads: 1,
            memoryMb: 1024,
            scratchMb: 1024,
            priority: "normal",
          },
          projectId: "proj-a",
        },
        {
          jobId: "running-2",
          nodeId: "node-1",
          resources: {
            engine: "orca",
            cpuThreads: 1,
            memoryMb: 1024,
            scratchMb: 1024,
            priority: "normal",
          },
          projectId: "proj-a",
        },
        {
          jobId: "running-3",
          nodeId: "node-1",
          resources: {
            engine: "orca",
            cpuThreads: 1,
            memoryMb: 1024,
            scratchMb: 1024,
            priority: "normal",
          },
          projectId: "proj-a",
        },
      ],
      projects: [makeProjectConfig({ projectId: "proj-a", maxConcurrentJobs: 3 })],
    });

    const decisions = schedule(input);
    const jobDecision = decisions.find((d) => d.jobId === "job-1");
    expect(jobDecision).toBeDefined();
    expect(jobDecision!.action).toBe("hold");
    expect(jobDecision!.holdCode).toBe("project_max_concurrent");
  });

  it("dispatches jobs within maxConcurrentJobs limit", () => {
    const node = makeNode({ nodeId: "node-1" });
    const input = buildInput({
      jobs: [makeJob({ id: "job-2", projectId: "proj-b" })],
      nodes: [node],
      runningJobs: [
        {
          jobId: "running-4",
          nodeId: "node-1",
          resources: {
            engine: "orca",
            cpuThreads: 1,
            memoryMb: 1024,
            scratchMb: 1024,
            priority: "normal",
          },
          projectId: "proj-b",
        },
      ],
      projects: [makeProjectConfig({ projectId: "proj-b", maxConcurrentJobs: 3 })],
    });

    const decisions = schedule(input);
    const jobDecision = decisions.find((d) => d.jobId === "job-2");
    expect(jobDecision).toBeDefined();
    expect(jobDecision!.action).toBe("dispatch");
  });
});

describe("scheduler fairness — project quota enforcement", () => {
  it("uses durable total job usage instead of only currently running jobs", () => {
    const node = makeNode({ nodeId: "node-1" });
    const input = buildInput({
      jobs: [makeJob({ id: "total-quota-job", projectId: "proj-total" })],
      nodes: [node],
      runningJobs: [],
      projects: [
        makeProjectConfig({
          projectId: "proj-total",
          quotaJobsTotal: 5,
          totalJobCount: 5,
        }),
      ],
    });

    const decisions = schedule(input);
    expect(decisions).toEqual([
      expect.objectContaining({
        action: "hold",
        jobId: "total-quota-job",
        holdCode: "project_quota_jobs",
      }),
    ]);
  });

  it("accounts for dispatches earlier in the same cycle against total job quota", () => {
    const node = makeNode({ nodeId: "node-1" });
    const input = buildInput({
      jobs: [
        makeJob({ id: "first-total-job", projectId: "proj-cycle-total" }),
        makeJob({ id: "second-total-job", projectId: "proj-cycle-total" }),
      ],
      nodes: [node],
      runningJobs: [],
      projects: [
        makeProjectConfig({
          projectId: "proj-cycle-total",
          quotaJobsTotal: 1,
          totalJobCount: 0,
        }),
      ],
    });

    const decisions = schedule(input);
    expect(decisions.find((decision) => decision.jobId === "first-total-job")?.action).toBe(
      "dispatch",
    );
    expect(decisions.find((decision) => decision.jobId === "second-total-job")).toEqual(
      expect.objectContaining({
        action: "hold",
        holdCode: "project_quota_jobs",
      }),
    );
  });

  it("holds job when project would exceed CPU quota", () => {
    const node = makeNode({ nodeId: "node-1" });
    const input = buildInput({
      jobs: [
        {
          id: "cpu-job",
          status: "queued",
          resources: {
            engine: "orca",
            cpuThreads: 8,
            memoryMb: 1024,
            scratchMb: 1024,
            priority: "normal",
          },
          projectId: "proj-c",
        },
      ],
      nodes: [node],
      runningJobs: [],
      projects: [makeProjectConfig({ projectId: "proj-c", quotaCpuThreads: 4 })],
    });

    const decisions = schedule(input);
    const d = decisions.find((x) => x.jobId === "cpu-job");
    expect(d).toBeDefined();
    expect(d!.action).toBe("hold");
    expect(d!.holdCode).toBe("project_quota_cpu");
  });

  it("holds job when project would exceed RAM quota", () => {
    const node = makeNode({ nodeId: "node-1" });
    const input = buildInput({
      jobs: [
        {
          id: "mem-job",
          status: "queued",
          resources: {
            engine: "orca",
            cpuThreads: 1,
            memoryMb: 65536,
            scratchMb: 1024,
            priority: "normal",
          },
          projectId: "proj-d",
        },
      ],
      nodes: [node],
      runningJobs: [],
      projects: [makeProjectConfig({ projectId: "proj-d", quotaMemoryMb: 32768 })],
    });

    const decisions = schedule(input);
    const d = decisions.find((x) => x.jobId === "mem-job");
    expect(d).toBeDefined();
    expect(d!.action).toBe("hold");
    expect(d!.holdCode).toBe("project_quota_ram");
  });

  it("dispatches job within quota limits", () => {
    const node = makeNode({ nodeId: "node-1" });
    const input = buildInput({
      jobs: [
        {
          id: "ok-job",
          status: "queued",
          resources: {
            engine: "orca",
            cpuThreads: 2,
            memoryMb: 2048,
            scratchMb: 512,
            priority: "normal",
          },
          projectId: "proj-e",
        },
      ],
      nodes: [node],
      runningJobs: [],
      projects: [
        makeProjectConfig({ projectId: "proj-e", quotaCpuThreads: 16, quotaMemoryMb: 65536 }),
      ],
    });

    const decisions = schedule(input);
    const d = decisions.find((x) => x.jobId === "ok-job");
    expect(d).toBeDefined();
    expect(d!.action).toBe("dispatch");
  });
});

describe("scheduler fairness — jobs without project", () => {
  it("dispatches jobs without projectId (backward compat)", () => {
    const node = makeNode({ nodeId: "node-1" });
    const input = buildInput({
      jobs: [makeJob({ id: "no-project-job" })],
      nodes: [node],
      runningJobs: [],
    });

    const decisions = schedule(input);
    const d = decisions.find((x) => x.jobId === "no-project-job");
    expect(d).toBeDefined();
    expect(d!.action).toBe("dispatch");
  });

  it("dispatches jobs with projectId when no project config given", () => {
    const node = makeNode({ nodeId: "node-1" });
    const input = buildInput({
      jobs: [makeJob({ id: "no-config-job", projectId: "unknown" })],
      nodes: [node],
      runningJobs: [],
      projects: [],
    });

    const decisions = schedule(input);
    const d = decisions.find((x) => x.jobId === "no-config-job");
    expect(d).toBeDefined();
    expect(d!.action).toBe("dispatch");
  });
});

describe("scheduler fairness — weighted fairness", () => {
  it("handles multiple projects with different weights", () => {
    const node = makeNode({ nodeId: "node-1", cpuThreadsTotal: 64, cpuThreadsAvailable: 64 });
    const input = buildInput({
      jobs: [
        {
          id: "weighted-a",
          status: "queued",
          resources: {
            engine: "orca",
            cpuThreads: 1,
            memoryMb: 1024,
            scratchMb: 1024,
            priority: "normal",
          },
          projectId: "proj-heavy",
        },
        {
          id: "weighted-b",
          status: "queued",
          resources: {
            engine: "orca",
            cpuThreads: 1,
            memoryMb: 1024,
            scratchMb: 1024,
            priority: "normal",
          },
          projectId: "proj-light",
        },
      ],
      nodes: [node],
      runningJobs: [],
      projects: [
        makeProjectConfig({ projectId: "proj-heavy", weight: 2.0 }),
        makeProjectConfig({ projectId: "proj-light", weight: 0.5 }),
      ],
    });

    const decisions = schedule(input);
    const dispatched = decisions.filter((d) => d.action === "dispatch");
    expect(dispatched.length).toBeGreaterThan(0);
  });
});
