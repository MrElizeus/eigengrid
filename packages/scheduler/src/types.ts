// ────────────────────────────────────────────────────────────
// Node Capacity & Job Resource Types
// ────────────────────────────────────────────────────────────

// ── Project fairness types ─────────────────────

export interface ProjectFairnessConfig {
  projectId: string;
  maxConcurrentJobs: number; // 0 = unlimited
  quotaCpuThreads: number; // 0 = unlimited
  quotaMemoryMb: number; // 0 = unlimited
  quotaScratchMb: number; // 0 = unlimited
  quotaJobsTotal: number; // 0 = unlimited, overall cap
  weight: number; // for weighted fairness (default 1.0)
  runningJobCount: number; // currently running jobs for this project
  usedCpuThreads: number; // currently used CPU across running jobs
  usedMemoryMb: number;
  usedScratchMb: number;
  /** Durable completed/submitted job count used by quotaJobsTotal. */
  totalJobCount?: number;
}

export interface NodeCapacity {
  nodeId: string;
  enabled: boolean;
  draining: boolean;
  maxJobs: number;
  engines: string[]; // ["orca", "gaussian", "xtb", "cp2k"]
  cpuThreadsTotal: number;
  cpuThreadsAvailable: number;
  memoryMbTotal: number;
  memoryMbAvailable: number;
  scratchMbTotal: number;
  scratchMbAvailable: number;
  thermalState: "unknown" | "normal" | "warm" | "hot" | "critical";
  lastSeenAt: number | null;
  // ── Power management ──────────────────────
  isHead?: boolean; // never power down
  powerMode: "manual" | "wakeable" | "managed";
  macAddress?: string;
  broadcastAddress?: string;
  wolPort?: number;
  allowWake: boolean;
  allowPowerDown: boolean;
  idlePowerDownAfterSec?: number;
  lastWakeAt?: number | null;
  lastPowerDownAt?: number | null;
}

export interface JobResources {
  engine: string;
  cpuThreads: number; // default 1
  memoryMb: number; // default 1024
  scratchMb: number; // default 1024
  priority: "low" | "normal" | "high"; // default "normal"
  jobFamily?: string;
}

export type SchedulerPolicy = {
  dftNeverSplitAcrossNodes: boolean; // default true
  dockingShardsIndependent: boolean; // default true
};

export type SchedulerInput = {
  jobs: Array<{ id: string; resources: JobResources; status: string; projectId?: string }>;
  nodes: NodeCapacity[];
  runningJobs: Array<{
    jobId: string;
    nodeId: string;
    resources: JobResources;
    projectId?: string;
  }>;
  policy: SchedulerPolicy;
  projects?: ProjectFairnessConfig[];
};

export type SchedulerDecision =
  | { action: "dispatch"; jobId: string; nodeId: string; reason: string; resources: JobResources }
  | { action: "hold"; jobId: string; reason: string; holdCode?: string };

// ── Power Management Types ──────────────────────

export type PowerDecision =
  | {
      action: "wake";
      nodeId: string;
      reason: string;
      macAddress: string;
      broadcastAddress: string;
      wolPort: number;
    }
  | { action: "power_down"; nodeId: string; reason: string }
  | { action: "skip_wake"; nodeId: string; reason: string }
  | { action: "skip_power_down"; nodeId: string; reason: string }
  | { action: "block_power_down"; nodeId: string; reason: string };

export interface SchedulerPowerInput {
  nodes: NodeCapacity[];
  pendingJobs: Array<{ id: string; resources: JobResources }>;
  runningJobs: Array<{ jobId: string; nodeId: string }>;
  now?: number;
}
