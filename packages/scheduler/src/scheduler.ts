// ────────────────────────────────────────────────────────────
// Scheduler Engine (pure, no side effects)
// ────────────────────────────────────────────────────────────

import type {
  SchedulerInput,
  SchedulerDecision,
  SchedulerPowerInput,
  PowerDecision,
  NodeCapacity,
  ProjectFairnessConfig,
} from "./types";

// ── Helpers ────────────────────────────────────────────────

const DFT_ENGINES = new Set(["orca", "gaussian"]);

function isDFTEngine(engine: string): boolean {
  return DFT_ENGINES.has(engine.toLowerCase());
}

const PRIORITY_ORDER: Record<string, number> = { high: 0, normal: 1, low: 2 };

const HEARTBEAT_FRESH_MS = 5 * 60 * 1000; // 5 minutes

// ── Thermal penalties for node scoring ────────────────────

const THERMAL_SCORE: Record<string, number> = {
  unknown: 0,
  normal: 0,
  warm: -2,
  hot: -5,
  critical: -100,
};

// ── Public API ─────────────────────────────────────────────

/**
 * Pure scheduler engine: evaluates jobs against node capacity and policy,
 * produces dispatch/hold decisions without mutating any state.
 */
export function schedule(input: SchedulerInput): SchedulerDecision[] {
  const decisions: SchedulerDecision[] = [];

  // ── Track node loading from existing running jobs ──────
  const nodeJobCounts = new Map<string, number>();
  const nodeConsumedCPU = new Map<string, number>();
  const nodeConsumedRAM = new Map<string, number>();
  const nodeConsumedScratch = new Map<string, number>();
  const nodeFamilies = new Map<string, Map<string, number>>();

  for (const rj of input.runningJobs) {
    nodeJobCounts.set(rj.nodeId, (nodeJobCounts.get(rj.nodeId) ?? 0) + 1);
    nodeConsumedCPU.set(rj.nodeId, (nodeConsumedCPU.get(rj.nodeId) ?? 0) + rj.resources.cpuThreads);
    nodeConsumedRAM.set(rj.nodeId, (nodeConsumedRAM.get(rj.nodeId) ?? 0) + rj.resources.memoryMb);
    nodeConsumedScratch.set(
      rj.nodeId,
      (nodeConsumedScratch.get(rj.nodeId) ?? 0) + rj.resources.scratchMb,
    );

    if (rj.resources.jobFamily) {
      if (!nodeFamilies.has(rj.nodeId)) nodeFamilies.set(rj.nodeId, new Map());
      const fam = nodeFamilies.get(rj.nodeId)!;
      fam.set(rj.resources.jobFamily, (fam.get(rj.resources.jobFamily) ?? 0) + 1);
    }
  }

  /**
   * Compute effective available resources for a node, accounting for
   * both pre-existing running jobs and jobs dispatched earlier in this cycle.
   */
  function effectiveCPU(node: NodeCapacity): number {
    const consumed = nodeConsumedCPU.get(node.nodeId) ?? 0;
    return node.cpuThreadsTotal - consumed;
  }

  function effectiveRAM(node: NodeCapacity): number {
    const consumed = nodeConsumedRAM.get(node.nodeId) ?? 0;
    return node.memoryMbTotal - consumed;
  }

  function effectiveScratch(node: NodeCapacity): number {
    const consumed = nodeConsumedScratch.get(node.nodeId) ?? 0;
    return node.scratchMbTotal - consumed;
  }

  // ── Determine existing DFT node (for co-location) ─────
  function findExistingDFTNode(): string | null {
    for (const rj of input.runningJobs) {
      if (isDFTEngine(rj.resources.engine)) return rj.nodeId;
    }
    // Check decisions already made in THIS cycle
    for (const d of decisions) {
      if (d.action === "dispatch" && isDFTEngine(d.resources.engine)) return d.nodeId;
    }
    return null;
  }

  // ── Project fairness tracking ──────────────
  const projectRunning = new Map<string, number>(); // projectId → running job count
  const projectUsedCPU = new Map<string, number>();
  const projectUsedRAM = new Map<string, number>();
  const projectUsedScratch = new Map<string, number>();

  for (const rj of input.runningJobs) {
    if (rj.projectId) {
      projectRunning.set(rj.projectId, (projectRunning.get(rj.projectId) ?? 0) + 1);
      projectUsedCPU.set(
        rj.projectId,
        (projectUsedCPU.get(rj.projectId) ?? 0) + rj.resources.cpuThreads,
      );
      projectUsedRAM.set(
        rj.projectId,
        (projectUsedRAM.get(rj.projectId) ?? 0) + rj.resources.memoryMb,
      );
      projectUsedScratch.set(
        rj.projectId,
        (projectUsedScratch.get(rj.projectId) ?? 0) + rj.resources.scratchMb,
      );
    }
  }

  // Update project fairness config with actual usage
  const projectFairness = new Map<string, ProjectFairnessConfig>();
  for (const pc of input.projects ?? []) {
    projectFairness.set(pc.projectId, {
      ...pc,
      runningJobCount: projectRunning.get(pc.projectId) ?? 0,
      usedCpuThreads: projectUsedCPU.get(pc.projectId) ?? 0,
      usedMemoryMb: projectUsedRAM.get(pc.projectId) ?? 0,
      usedScratchMb: projectUsedScratch.get(pc.projectId) ?? 0,
    });
  }

  // ── Sort pending jobs: priority then insertion order ────
  const pendingJobs = input.jobs
    .filter((j) => j.status === "queued" || j.status === "created")
    .sort((a, b) => {
      const pa = PRIORITY_ORDER[a.resources.priority] ?? 1;
      const pb = PRIORITY_ORDER[b.resources.priority] ?? 1;
      return pa - pb;
    });

  // ── Evaluate each job ──────────────────────────────────
  for (const job of pendingJobs) {
    // ── Project fairness pre-check ──────────
    const projectConfig = job.projectId ? projectFairness.get(job.projectId) : undefined;

    if (projectConfig) {
      // Check maxConcurrentJobs
      if (
        projectConfig.maxConcurrentJobs > 0 &&
        projectConfig.runningJobCount >= projectConfig.maxConcurrentJobs
      ) {
        decisions.push({
          action: "hold",
          jobId: job.id,
          reason: `Project ${job.projectId} at maxConcurrentJobs (${projectConfig.maxConcurrentJobs})`,
          holdCode: "project_max_concurrent",
        });
        continue;
      }

      // Check quota CPU
      if (
        projectConfig.quotaCpuThreads > 0 &&
        projectConfig.usedCpuThreads + job.resources.cpuThreads > projectConfig.quotaCpuThreads
      ) {
        decisions.push({
          action: "hold",
          jobId: job.id,
          reason: `Project ${job.projectId} would exceed CPU quota (used ${projectConfig.usedCpuThreads}/${projectConfig.quotaCpuThreads}, need ${job.resources.cpuThreads})`,
          holdCode: "project_quota_cpu",
        });
        continue;
      }

      // Check quota RAM
      if (
        projectConfig.quotaMemoryMb > 0 &&
        projectConfig.usedMemoryMb + job.resources.memoryMb > projectConfig.quotaMemoryMb
      ) {
        decisions.push({
          action: "hold",
          jobId: job.id,
          reason: `Project ${job.projectId} would exceed RAM quota (used ${projectConfig.usedMemoryMb}/${projectConfig.quotaMemoryMb}, need ${job.resources.memoryMb})`,
          holdCode: "project_quota_ram",
        });
        continue;
      }

      // Check quota scratch
      if (
        projectConfig.quotaScratchMb > 0 &&
        projectConfig.usedScratchMb + job.resources.scratchMb > projectConfig.quotaScratchMb
      ) {
        decisions.push({
          action: "hold",
          jobId: job.id,
          reason: `Project ${job.projectId} would exceed scratch quota (used ${projectConfig.usedScratchMb}/${projectConfig.quotaScratchMb}, need ${job.resources.scratchMb})`,
          holdCode: "project_quota_scratch",
        });
        continue;
      }

      // Check total jobs quota
      if (
        projectConfig.quotaJobsTotal > 0 &&
        (projectConfig.totalJobCount ?? projectConfig.runningJobCount) + 1 >
          projectConfig.quotaJobsTotal
      ) {
        decisions.push({
          action: "hold",
          jobId: job.id,
          reason: `Project ${job.projectId} would exceed total jobs quota (${projectConfig.quotaJobsTotal})`,
          holdCode: "project_quota_jobs",
        });
        continue;
      }
    }
    // Figure out DFT constraint before filtering nodes
    let forcedDFTNode: string | null = null;
    if (input.policy.dftNeverSplitAcrossNodes && isDFTEngine(job.resources.engine)) {
      forcedDFTNode = findExistingDFTNode();
    }

    const eligibleNodes = input.nodes.filter((node) => {
      // 1. Enabled and not draining
      if (!node.enabled) return false;
      if (node.draining) return false;

      // 2. Heartbeat fresh (within 5 min)
      if (node.lastSeenAt === null) return false;
      if (Date.now() - node.lastSeenAt > HEARTBEAT_FRESH_MS) return false;

      // 3. Engine available on node
      if (!node.engines.map((e) => e.toLowerCase()).includes(job.resources.engine.toLowerCase())) {
        return false;
      }

      // 4. MaxJobs not exceeded (including cycle dispatches)
      const currentJobs = nodeJobCounts.get(node.nodeId) ?? 0;
      if (currentJobs >= node.maxJobs) return false;

      // 5. CPU budget sufficient (including cycle dispatches)
      if (effectiveCPU(node) < job.resources.cpuThreads) return false;

      // 6. RAM budget sufficient (including cycle dispatches)
      if (effectiveRAM(node) < job.resources.memoryMb) return false;

      // 7. Scratch budget sufficient (including cycle dispatches)
      if (effectiveScratch(node) < job.resources.scratchMb) return false;

      // 8. Thermal state acceptable
      if (node.thermalState === "critical") return false;

      // 9. DFT co-location policy
      if (forcedDFTNode !== null && node.nodeId !== forcedDFTNode) return false;

      return true;
    });

    // ── No eligible nodes → hold ─────────────────────────
    if (eligibleNodes.length === 0) {
      const reasons: string[] = [];

      if (!input.nodes.some((n) => n.enabled && !n.draining)) {
        reasons.push("No enabled nodes available");
      } else if (
        !input.nodes.some(
          (n) =>
            n.enabled &&
            !n.draining &&
            n.lastSeenAt !== null &&
            Date.now() - n.lastSeenAt <= HEARTBEAT_FRESH_MS,
        )
      ) {
        reasons.push("No nodes with fresh heartbeat");
      } else if (
        !input.nodes.some((n) =>
          n.engines.map((e) => e.toLowerCase()).includes(job.resources.engine.toLowerCase()),
        )
      ) {
        reasons.push(`No node supports engine: ${job.resources.engine}`);
      } else if (forcedDFTNode !== null) {
        const dftNode = input.nodes.find((n) => n.nodeId === forcedDFTNode);
        if (dftNode) {
          const jobsOnNode = nodeJobCounts.get(forcedDFTNode) ?? 0;
          if (jobsOnNode >= dftNode.maxJobs) {
            reasons.push(`DFT co-location node ${forcedDFTNode} at maxJobs (${dftNode.maxJobs})`);
          } else {
            reasons.push(
              `DFT co-location node ${forcedDFTNode} lacks sufficient resources for this job`,
            );
          }
        } else {
          reasons.push(`DFT co-location node ${forcedDFTNode} not found in available nodes`);
        }
      } else {
        reasons.push("All eligible nodes lack sufficient resources");
      }

      decisions.push({ action: "hold", jobId: job.id, reason: reasons.join("; ") });
      continue;
    }

    // ── Score eligible nodes ─────────────────────────────
    // Weighted fairness — boost score for under-served projects
    const fairnessBoost = projectConfig
      ? (1.0 / Math.max(1, projectConfig.weight)) *
        (1.0 / Math.max(1, projectConfig.runningJobCount + 1))
      : 0;

    const scored = eligibleNodes.map((node) => {
      let score = 0;

      // Resource headroom ratios (0..1)
      const cpuRatio = node.cpuThreadsTotal > 0 ? effectiveCPU(node) / node.cpuThreadsTotal : 0;
      const ramRatio = node.memoryMbTotal > 0 ? effectiveRAM(node) / node.memoryMbTotal : 0;
      const scrRatio = node.scratchMbTotal > 0 ? effectiveScratch(node) / node.scratchMbTotal : 0;

      // Base score: average headroom ratio weighted by 5
      score += (cpuRatio + ramRatio + scrRatio) * 5;

      // Absolute capacity bonus: prefer larger nodes when ratios are equal
      // Normalize by a reasonable reference (e.g., 64 CPU, 256 GB, 1 TB)
      score += node.cpuThreadsTotal / 64;
      score += node.memoryMbTotal / 262144;
      score += node.scratchMbTotal / 1048576;

      // Job family affinity: bonus if node already runs same family
      if (job.resources.jobFamily) {
        const families = nodeFamilies.get(node.nodeId);
        if (families?.has(job.resources.jobFamily)) {
          score += 10;
        }
      }

      // Thermal preference
      score += THERMAL_SCORE[node.thermalState] ?? 0;

      // Weighted fairness boost
      score += fairnessBoost * 5;

      return { node, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    // ── Update project intra-cycle tracking ──
    if (projectConfig) {
      const previousRunningJobCount = projectConfig.runningJobCount;
      projectConfig.runningJobCount++;
      projectConfig.usedCpuThreads += job.resources.cpuThreads;
      projectConfig.usedMemoryMb += job.resources.memoryMb;
      projectConfig.usedScratchMb += job.resources.scratchMb;
      projectConfig.totalJobCount = (projectConfig.totalJobCount ?? previousRunningJobCount) + 1;
    }

    // ── Dispatch ─────────────────────────────────────────
    decisions.push({
      action: "dispatch",
      jobId: job.id,
      nodeId: best.node.nodeId,
      reason: `Assigned to ${best.node.nodeId} (score=${best.score.toFixed(2)})`,
      resources: job.resources,
    });

    // Update intra-cycle resource tracking
    nodeJobCounts.set(best.node.nodeId, (nodeJobCounts.get(best.node.nodeId) ?? 0) + 1);
    nodeConsumedCPU.set(
      best.node.nodeId,
      (nodeConsumedCPU.get(best.node.nodeId) ?? 0) + job.resources.cpuThreads,
    );
    nodeConsumedRAM.set(
      best.node.nodeId,
      (nodeConsumedRAM.get(best.node.nodeId) ?? 0) + job.resources.memoryMb,
    );
    nodeConsumedScratch.set(
      best.node.nodeId,
      (nodeConsumedScratch.get(best.node.nodeId) ?? 0) + job.resources.scratchMb,
    );

    if (job.resources.jobFamily) {
      if (!nodeFamilies.has(best.node.nodeId)) nodeFamilies.set(best.node.nodeId, new Map());
      const fam = nodeFamilies.get(best.node.nodeId)!;
      fam.set(job.resources.jobFamily, (fam.get(job.resources.jobFamily) ?? 0) + 1);
    }
  }

  return decisions;
}

// ── Default policy ────────────────────────────────────────

export const DEFAULT_SCHEDULER_POLICY = {
  dftNeverSplitAcrossNodes: true,
  dockingShardsIndependent: true,
};

// ── Default idle power-down threshold ─────────────────────

export const DEFAULT_IDLE_POWER_DOWN_SEC = 300; // 5 minutes

// ── Power Planning ──────────────────────────────────────────

/**
 * Pure function: analyzes node power state and pending/running jobs
 * to produce safe power decisions (wake, power-down, or skip).
 *
 * Does NOT execute any side effects — callers decide what to apply.
 */
export function planPower(input: SchedulerPowerInput): PowerDecision[] {
  const now = input.now ?? Date.now();
  const decisions: PowerDecision[] = [];

  for (const node of input.nodes) {
    // ── Wake decisions ─────────────────────────────────
    if (node.allowWake) {
      const isOffline = node.lastSeenAt === null || now - node.lastSeenAt > HEARTBEAT_FRESH_MS;

      if (isOffline) {
        // Check for compatible pending jobs
        const compatibleJobs = input.pendingJobs.filter((j) =>
          node.engines.map((e) => e.toLowerCase()).includes(j.resources.engine.toLowerCase()),
        );

        if (compatibleJobs.length === 0) {
          decisions.push({
            action: "skip_wake",
            nodeId: node.nodeId,
            reason: "No compatible pending jobs",
          });
        } else if (!node.macAddress || !node.broadcastAddress) {
          decisions.push({
            action: "skip_wake",
            nodeId: node.nodeId,
            reason: "Missing MAC or broadcast address",
          });
        } else {
          decisions.push({
            action: "wake",
            nodeId: node.nodeId,
            reason: `${compatibleJobs.length} compatible job(s) waiting (e.g., ${compatibleJobs[0].id})`,
            macAddress: node.macAddress,
            broadcastAddress: node.broadcastAddress,
            wolPort: node.wolPort ?? 9,
          });
        }
      }
    }

    // ── Power-down decisions ────────────────────────────
    if (!node.allowPowerDown) continue;

    // Never power down the head node
    if (node.isHead) {
      decisions.push({
        action: "block_power_down",
        nodeId: node.nodeId,
        reason: "Head node — never power down",
      });
      continue;
    }

    // Never power down a node with running jobs
    const hasRunningJobs = input.runningJobs.some((rj) => rj.nodeId === node.nodeId);
    if (hasRunningJobs) {
      decisions.push({
        action: "block_power_down",
        nodeId: node.nodeId,
        reason: "Node has running jobs",
      });
      continue;
    }

    // Evaluate idle state
    const idleThreshold = node.idlePowerDownAfterSec ?? DEFAULT_IDLE_POWER_DOWN_SEC;

    if (node.lastSeenAt === null) {
      decisions.push({
        action: "skip_power_down",
        nodeId: node.nodeId,
        reason: "Node never seen — cannot determine idle state",
      });
    } else if (now - node.lastSeenAt >= idleThreshold * 1000) {
      decisions.push({
        action: "power_down",
        nodeId: node.nodeId,
        reason: `Idle for ${Math.round((now - node.lastSeenAt) / 1000)}s (threshold: ${idleThreshold}s)`,
      });
    } else {
      const waitTime = Math.round((idleThreshold * 1000 - (now - node.lastSeenAt)) / 1000);
      decisions.push({
        action: "skip_power_down",
        nodeId: node.nodeId,
        reason: `Not yet idle enough (need ${waitTime}s more)`,
      });
    }
  }

  return decisions;
}
