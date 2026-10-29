import type { CommandModule } from "yargs";
import type { DatabaseLike } from "@eigengrid/db";
import {
  schedule,
  planPower,
  DEFAULT_SCHEDULER_POLICY,
  type JobResources,
  type NodeCapacity,
  type SchedulerDecision,
  type SchedulerPolicy,
  type SchedulerInput,
  type SchedulerPowerInput,
  type PowerDecision,
  type ProjectFairnessConfig,
} from "@eigengrid/scheduler";
import { runWithContext } from "../composition/run-with-context";
import { generateId } from "@eigengrid/core";

// ── Helpers ────────────────────────────────────────────────

function now(): number {
  return Date.now();
}

/**
 * Build scheduler input from current DB state.
 */
async function buildSchedulerInput(
  db: DatabaseLike,
  policy?: Partial<SchedulerPolicy>,
): Promise<SchedulerInput> {
  const [nodeRows, jobRows, projects] = await Promise.all([
    db.listNodes(),
    db.listJobs(),
    buildProjectFairness(db),
  ]);

  const allNodes: NodeCapacity[] = nodeRows.map((r) => {
    const enginesRaw = r.engines;
    let engines: string[];
    try {
      engines = JSON.parse(enginesRaw);
    } catch {
      engines = [];
    }

    return {
      nodeId: r.id,
      enabled: r.status !== "offline" && r.status !== "error",
      draining: r.draining || r.status === "draining",
      maxJobs: r.maxJobs ?? 1,
      engines,
      cpuThreadsTotal: r.cpuThreadsTotal ?? 1,
      cpuThreadsAvailable: r.cpuThreadsTotal ?? 1,
      memoryMbTotal: r.memoryMbTotal ?? 1024,
      memoryMbAvailable: r.memoryMbTotal ?? 1024,
      scratchMbTotal: r.scratchMbTotal ?? 10240,
      scratchMbAvailable: r.scratchMbTotal ?? 10240,
      thermalState: (r.thermalState ?? "unknown") as NodeCapacity["thermalState"],
      lastSeenAt: r.lastSeenAt,
      // ── Power fields with DB defaults ─────
      isHead: r.isHead,
      powerMode: (r.powerMode ?? "manual") as NodeCapacity["powerMode"],
      macAddress: r.macAddress ?? undefined,
      broadcastAddress: r.broadcastAddress ?? undefined,
      wolPort: r.wolPort ?? undefined,
      allowWake: r.allowWake,
      allowPowerDown: r.allowPowerDown,
      idlePowerDownAfterSec: r.idlePowerDownAfterSec ?? undefined,
      lastWakeAt: r.lastWakeAt,
      lastPowerDownAt: r.lastPowerDownAt,
    };
  });

  const localJobs = jobRows.filter((r) => r.backend !== "slurm");

  // Build running jobs and compute available resources
  const runningJobs: SchedulerInput["runningJobs"] = [];
  const nodeConsumedCPU = new Map<string, number>();
  const nodeConsumedRAM = new Map<string, number>();
  const nodeConsumedScratch = new Map<string, number>();

  for (const row of localJobs) {
    const status = row.status || "created";
    if (status === "running" && row.nodeId) {
      const resources = makeJobResources(row);
      const nodeId = row.nodeId;
      runningJobs.push({ jobId: row.id, nodeId, resources });
      nodeConsumedCPU.set(nodeId, (nodeConsumedCPU.get(nodeId) ?? 0) + resources.cpuThreads);
      nodeConsumedRAM.set(nodeId, (nodeConsumedRAM.get(nodeId) ?? 0) + resources.memoryMb);
      nodeConsumedScratch.set(nodeId, (nodeConsumedScratch.get(nodeId) ?? 0) + resources.scratchMb);
    }
  }

  // Deduct consumed from available
  for (const node of allNodes) {
    node.cpuThreadsAvailable = Math.max(
      0,
      node.cpuThreadsTotal - (nodeConsumedCPU.get(node.nodeId) ?? 0),
    );
    node.memoryMbAvailable = Math.max(
      0,
      node.memoryMbTotal - (nodeConsumedRAM.get(node.nodeId) ?? 0),
    );
    node.scratchMbAvailable = Math.max(
      0,
      node.scratchMbTotal - (nodeConsumedScratch.get(node.nodeId) ?? 0),
    );
  }

  const pendingJobs = localJobs
    .filter((r) => {
      const s = r.status ?? "";
      return s === "created" || s === "queued";
    })
    .map((r) => ({
      id: r.id,
      status: r.status,
      resources: makeJobResources(r),
    }));

  return {
    jobs: pendingJobs,
    nodes: allNodes,
    runningJobs,
    policy: { ...DEFAULT_SCHEDULER_POLICY, ...policy },
    projects,
  };
}

/**
 * Build the scheduler's project/quota projection from provider-neutral DB
 * records. Usage is loaded separately from live running resources so the
 * total-jobs quota survives process restarts and scheduler cycles.
 */
async function buildProjectFairness(db: DatabaseLike): Promise<ProjectFairnessConfig[]> {
  const projects = await db.listProjects();
  return Promise.all(
    projects.map(async (project) => {
      const [quota, usage] = await Promise.all([
        db.getProjectQuota(project.id),
        db.getProjectAggregatedUsage(project.id),
      ]);
      return {
        projectId: project.id,
        maxConcurrentJobs: project.maxConcurrentJobs,
        quotaCpuThreads: quota?.maxCpuThreads ?? 0,
        quotaMemoryMb: quota?.maxMemoryMb ?? 0,
        quotaScratchMb: quota?.maxScratchMb ?? 0,
        quotaJobsTotal: quota?.maxJobsTotal ?? 0,
        weight: 1,
        runningJobCount: 0,
        usedCpuThreads: 0,
        usedMemoryMb: 0,
        usedScratchMb: 0,
        totalJobCount: usage.jobCount,
      };
    }),
  );
}

function makeJobResources(row: {
  software: string;
  cpuThreads: number;
  memoryMb: number;
  scratchMb: number;
  priority: string;
  jobFamily: string | null;
}): JobResources {
  return {
    engine: row.software || "unknown",
    cpuThreads: row.cpuThreads ?? 1,
    memoryMb: row.memoryMb ?? 1024,
    scratchMb: row.scratchMb ?? 1024,
    priority: (row.priority || "normal") as JobResources["priority"],
    jobFamily: row.jobFamily ?? undefined,
  };
}

// ── Display helpers ────────────────────────────────────────

function showDecisions(decisions: SchedulerDecision[], title: string): void {
  console.log(`\n  ${title}`);
  console.log(`  ${"=".repeat(title.length)}`);
  if (decisions.length === 0) {
    console.log("  (no decisions)\n");
    return;
  }
  for (const d of decisions) {
    if (d.action === "dispatch") {
      console.log(`  DISPATCH  ${d.jobId} → ${d.nodeId}`);
      console.log(`            ${d.reason}`);
    } else {
      console.log(`  HOLD      ${d.jobId}`);
      console.log(`            ${d.reason}`);
    }
  }
  console.log("");
}

function showPowerDecisions(decisions: PowerDecision[], title: string): void {
  console.log(`\n  ${title}`);
  console.log(`  ${"=".repeat(title.length)}`);
  if (decisions.length === 0) {
    console.log("  (no power decisions)\n");
    return;
  }
  for (const d of decisions) {
    switch (d.action) {
      case "wake":
        console.log(`  WAKE       ${d.nodeId}`);
        console.log(`             ${d.reason}`);
        console.log(
          `             MAC=${d.macAddress} broadcast=${d.broadcastAddress} port=${d.wolPort}`,
        );
        break;
      case "power_down":
        console.log(`  POWER DOWN ${d.nodeId}`);
        console.log(`             ${d.reason}`);
        break;
      case "skip_wake":
        console.log(`  SKIP WAKE  ${d.nodeId}`);
        console.log(`             ${d.reason}`);
        break;
      case "skip_power_down":
        console.log(`  SKIP PWRDN ${d.nodeId}`);
        console.log(`             ${d.reason}`);
        break;
      case "block_power_down":
        console.log(`  BLOCK PWRDN ${d.nodeId}`);
        console.log(`             ${d.reason}`);
        break;
    }
  }
  console.log("");
}

function showStatus(input: SchedulerInput): void {
  console.log("\n  SCHEDULER STATUS");
  console.log("  ===============");
  console.log(`  Nodes:          ${input.nodes.length}`);
  console.log(`  Pending jobs:   ${input.jobs.length}`);
  console.log(`  Running jobs:   ${input.runningJobs.length}`);
  console.log("");

  console.log("  NODES");
  console.log("  -----");
  for (const n of input.nodes) {
    const status = n.enabled ? (n.draining ? "draining" : "enabled") : "disabled";
    const heartbeat = n.lastSeenAt ? `${Math.round((now() - n.lastSeenAt) / 1000)}s ago` : "never";
    console.log(
      `  ${n.nodeId.slice(0, 12).padEnd(12)} ${status.padEnd(9)} cpu=${n.cpuThreadsAvailable}/${n.cpuThreadsTotal} ram=${n.memoryMbAvailable}/${n.memoryMbTotal}mb scr=${n.scratchMbAvailable}/${n.scratchMbTotal}mb thermal=${n.thermalState} heartbeat=${heartbeat}`,
    );
  }
  console.log("");

  if (input.jobs.length > 0) {
    console.log("  PENDING JOBS");
    console.log("  ------------");
    for (const j of input.jobs) {
      const r = j.resources;
      console.log(
        `  ${j.id.slice(0, 12).padEnd(12)} ${r.engine.padEnd(8)} cpu=${r.cpuThreads} ram=${r.memoryMb}mb scr=${r.scratchMb}mb pri=${r.priority}${r.jobFamily ? ` family=${r.jobFamily}` : ""}`,
      );
    }
    console.log("");
  }
}

// ── Command ────────────────────────────────────────────────

export const schedulerCommand: CommandModule = {
  command: "scheduler",
  describe: "Manage job scheduling and dispatching",
  builder: (y) =>
    y
      .command(
        "status",
        "Show scheduler queue, nodes, running jobs, and capacity",
        {},
        async () => {
          await runWithContext(async (ctx) => {
            const input = await buildSchedulerInput(ctx.db);
            showStatus(input);
          });
        },
      )

      .command(
        "plan",
        "Dry-run: show scheduling and power decisions without executing",
        {},
        async () => {
          await runWithContext(async (ctx) => {
            const input = await buildSchedulerInput(ctx.db);
            const decisions = schedule(input);
            showDecisions(decisions, `SCHEDULER PLAN (${decisions.length} decisions)`);

            const powerInput: SchedulerPowerInput = {
              nodes: input.nodes,
              pendingJobs: input.jobs,
              runningJobs: input.runningJobs,
            };
            const powerDecisions = planPower(powerInput);
            showPowerDecisions(powerDecisions, `POWER PLAN (${powerDecisions.length} decisions)`);
          });
        },
      )

      .command(
        "run",
        "Execute one scheduler dispatch cycle (requires --once)",
        {
          once: {
            type: "boolean",
            default: false,
            describe: "Perform exactly one bounded dispatch cycle",
          },
        } as const,
        async (args) => {
          if (!args.once) {
            console.error(
              "\n  Error: --once is required for scheduler run. Use `eigengrid scheduler plan` to inspect decisions without dispatching.\n",
            );
            process.exitCode = 1;
            return;
          }

          await runWithContext(async (ctx) => {
            // Reconcile receipt-backed local attempts before planning. A
            // detached supervisor can finish between scheduler processes; the
            // next tick must materialize that durable truth before computing
            // queue state and capacity.
            const unreconciledAttempts = await ctx.db.listJobAttempts();
            const unreconciledJobs = await ctx.db.listJobs();
            const localJobIds = new Set(
              unreconciledJobs
                .filter((job) => !job.backend || job.backend === "local")
                .map((job) => job.id),
            );
            for (const attempt of unreconciledAttempts) {
              if (
                attempt.runner === "local" &&
                attempt.status === "running" &&
                localJobIds.has(attempt.jobId)
              ) {
                await ctx.execution.reconcileLocal(attempt.jobId, attempt.id);
              }
            }

            // 1. Build typed scheduler input restricted to queued local jobs
            //    excluding remote-backed jobs and jobs with nonterminal attempts
            const allJobs = await ctx.db.listJobs();
            const allNodes = await ctx.db.listNodes();
            const allAttempts = await ctx.db.listJobAttempts();

            // Jobs with nonterminal attempts
            const jobsWithNonTerminalAttempt = new Set<string>();
            for (const att of allAttempts) {
              if (
                att.status === "created" ||
                att.status === "queued" ||
                att.status === "staged" ||
                att.status === "running"
              ) {
                jobsWithNonTerminalAttempt.add(att.jobId);
              }
            }

            const pendingJobs: Array<{
              id: string;
              status: string;
              resources: JobResources;
              projectId?: string;
            }> = [];
            const runningJobList: Array<{
              jobId: string;
              nodeId: string;
              resources: JobResources;
              projectId?: string;
            }> = [];

            for (const j of allJobs) {
              const resources: JobResources = {
                engine: j.software,
                cpuThreads: j.cpuThreads ?? 1,
                memoryMb: j.memoryMb ?? 1024,
                scratchMb: j.scratchMb ?? 1024,
                priority: (j.priority as JobResources["priority"]) ?? "normal",
                jobFamily: j.jobFamily ?? undefined,
              };

              const status = j.status ?? "";
              const isQueued = status === "queued";
              const isRunning = status === "running";

              if (isRunning && j.nodeId) {
                runningJobList.push({
                  jobId: j.id,
                  nodeId: j.nodeId,
                  resources,
                  projectId: j.projectId ?? undefined,
                });
              }

              // Only local backend jobs
              if (j.backend && j.backend !== "local" && j.backend !== "") continue;

              // Only queued (not created) — claimJobForDispatch requires queued
              if (isQueued && !jobsWithNonTerminalAttempt.has(j.id)) {
                pendingJobs.push({
                  id: j.id,
                  status,
                  resources,
                  projectId: j.projectId ?? undefined,
                });
              }
            }

            // Build node capacities
            const nodeCapacities: NodeCapacity[] = allNodes.map((n) => {
              let engines: string[];
              try {
                engines = JSON.parse(n.engines);
              } catch {
                engines = [];
              }
              return {
                nodeId: n.id,
                enabled: n.status !== "offline" && n.status !== "error",
                draining: n.draining || n.status === "draining",
                maxJobs: n.maxJobs ?? 1,
                engines,
                cpuThreadsTotal: n.cpuThreadsTotal ?? 1,
                cpuThreadsAvailable: n.cpuThreadsTotal ?? 1,
                memoryMbTotal: n.memoryMbTotal ?? 1024,
                memoryMbAvailable: n.memoryMbTotal ?? 1024,
                scratchMbTotal: n.scratchMbTotal ?? 10240,
                scratchMbAvailable: n.scratchMbTotal ?? 10240,
                thermalState: (n.thermalState as NodeCapacity["thermalState"]) ?? "unknown",
                lastSeenAt: n.lastSeenAt ?? null,
                powerMode: "manual",
                allowWake: false,
                allowPowerDown: false,
                isHead: n.isHead ?? false,
              };
            });

            // Deduct running job resources from available
            for (const rj of runningJobList) {
              const node = nodeCapacities.find((nc) => nc.nodeId === rj.nodeId);
              if (node) {
                node.cpuThreadsAvailable = Math.max(
                  0,
                  node.cpuThreadsAvailable - rj.resources.cpuThreads,
                );
                node.memoryMbAvailable = Math.max(
                  0,
                  node.memoryMbAvailable - rj.resources.memoryMb,
                );
                node.scratchMbAvailable = Math.max(
                  0,
                  node.scratchMbAvailable - rj.resources.scratchMb,
                );
              }
            }

            const input: SchedulerInput = {
              jobs: pendingJobs,
              nodes: nodeCapacities,
              runningJobs: runningJobList,
              policy: { ...DEFAULT_SCHEDULER_POLICY },
              projects: await buildProjectFairness(ctx.db),
            };

            // 2. Run pure schedule()
            const decisions = schedule(input);

            // 3. Pick first dispatch decision at most
            const dispatchDecision = decisions.find((d) => d.action === "dispatch");
            if (!dispatchDecision) {
              console.log("\n  No dispatch decisions. All jobs held or queue empty.\n");
              return;
            }

            // 4. Report planned dispatch
            console.log(`\n  Dispatching ${dispatchDecision.jobId} → ${dispatchDecision.nodeId}`);
            console.log(`  Reason: ${dispatchDecision.reason}`);

            // 5. Generate attempt ID for the claim
            const attemptId = generateId("attempt");
            const job = allJobs.find((j) => j.id === dispatchDecision.jobId);
            if (!job) {
              console.log(`  FAILED: Job ${dispatchDecision.jobId} disappeared before claim.\n`);
              return;
            }
            const jobsDir = ctx.config.jobsDir;
            const cwd = `${jobsDir}/${dispatchDecision.jobId}`;
            const command = `${job.software} ${job.inputPath}`;

            // 6. Atomically claim via DB
            const claimResult = await ctx.db.claimJobForDispatch(
              dispatchDecision.jobId,
              dispatchDecision.nodeId,
              attemptId,
              "local",
              command,
              cwd,
            );

            if (!claimResult.claimed) {
              console.log(`  SKIPPED: ${claimResult.message}\n`);
              // Lost the race — job already claimed by concurrent tick
              return;
            }

            console.log(
              `  Claimed: attempt ${claimResult.attemptId} on node ${claimResult.nodeId}`,
            );

            // 7. Dispatch through canonical ExecutionCoordinator
            const dispatchResult = await ctx.execution.dispatchExistingJob(
              claimResult.jobId,
              claimResult.attemptId,
            );

            if (dispatchResult.ok) {
              console.log(
                `  Started: pid=${dispatchResult.pid} job=${dispatchResult.jobId} attempt=${dispatchResult.attemptId}\n`,
              );
            } else {
              console.log(`  FAILED: ${dispatchResult.message}\n`);
            }
          });
        },
      )

      .command(
        "explain <job-id>",
        "Explain why a job is held or dispatchable",
        {
          "job-id": {
            type: "string",
            describe: "Job ID or prefix",
            demandOption: true,
          },
        } as const,
        async (args) => {
          const jobIdPrefix = args["job-id"] as string;
          await runWithContext(async (ctx) => {
            const input = await buildSchedulerInput(ctx.db);
            const targetJob = input.jobs.find((j) => j.id.startsWith(jobIdPrefix));
            if (!targetJob) {
              // Check if it might be a running/completed job
              const allJobs = await ctx.db.listJobs();
              const matchingJobs = allJobs.filter((job) => job.id.startsWith(jobIdPrefix));
              if (matchingJobs.length === 0) {
                console.log(`  Job not found: ${jobIdPrefix}\n`);
                return;
              }
              if (matchingJobs.length > 1) {
                console.log(`  Job prefix is ambiguous: ${jobIdPrefix}\n`);
                return;
              }
              const row = matchingJobs[0];
              console.log(`  Job ${row.id} has status "${row.status}" — not pending.\n`);
              return;
            }

            const decisions = schedule(input);
            const decision = decisions.find((d) => d.jobId === targetJob.id);

            if (!decision) {
              console.log(`  No decision produced for job ${targetJob.id}.\n`);
              return;
            }

            console.log(`\n  SCHEDULER EXPLAIN for ${targetJob.id}`);
            console.log(`  ${"=".repeat(40 + targetJob.id.length)}`);
            console.log(`  Status:     ${targetJob.status}`);
            console.log(`  Engine:     ${targetJob.resources.engine}`);
            console.log(
              `  Resources:  CPU=${targetJob.resources.cpuThreads} RAM=${targetJob.resources.memoryMb}MB Scratch=${targetJob.resources.scratchMb}MB`,
            );
            console.log(`  Priority:   ${targetJob.resources.priority}`);
            if (targetJob.resources.jobFamily) {
              console.log(`  Family:     ${targetJob.resources.jobFamily}`);
            }

            if (decision.action === "dispatch") {
              console.log(`  Decision:   DISPATCH → ${decision.nodeId}`);
              console.log(`  Reason:     ${decision.reason}`);
              const node = input.nodes.find((n) => n.nodeId === decision.nodeId);
              if (node) {
                console.log(
                  `  Node state: enabled=${node.enabled} draining=${node.draining} thermal=${node.thermalState}`,
                );
                console.log(
                  `  Node load:  ${node.cpuThreadsAvailable}/${node.cpuThreadsTotal} CPU ${node.memoryMbAvailable}/${node.memoryMbTotal} RAM ${node.scratchMbAvailable}/${node.scratchMbTotal} scratch`,
                );
              }
            } else {
              console.log(`  Decision:   HOLD`);
              console.log(`  Reason:     ${decision.reason}`);

              // Show why each node is ineligible
              console.log(`\n  Node eligibility breakdown:`);
              for (const node of input.nodes) {
                const issues: string[] = [];
                if (!node.enabled) issues.push("disabled");
                if (node.draining) issues.push("draining");
                if (node.lastSeenAt === null) issues.push("never seen");
                else if (now() - node.lastSeenAt > 5 * 60 * 1000) issues.push("stale heartbeat");
                if (
                  !node.engines
                    .map((e) => e.toLowerCase())
                    .includes(targetJob.resources.engine.toLowerCase())
                ) {
                  issues.push(`no ${targetJob.resources.engine} engine`);
                }
                if ((nodeJobCount(node, input) ?? 0) >= node.maxJobs) issues.push("at maxJobs");
                if (node.cpuThreadsAvailable < targetJob.resources.cpuThreads)
                  issues.push("insufficient CPU");
                if (node.memoryMbAvailable < targetJob.resources.memoryMb)
                  issues.push("insufficient RAM");
                if (node.scratchMbAvailable < targetJob.resources.scratchMb)
                  issues.push("insufficient scratch");
                if (node.thermalState === "critical") issues.push("critical thermal state");
                console.log(
                  `    ${node.nodeId.slice(0, 12).padEnd(12)} ${issues.length > 0 ? "✗ " + issues.join(", ") : "✓ eligible"}`,
                );
              }
            }
            console.log("");
          });
        },
      )
      .demandCommand(1, "Specify a subcommand"),
  async handler() {
    console.log("  Use `eigengrid scheduler status` to view scheduler state.\n");
  },
};

function nodeJobCount(node: NodeCapacity, input: SchedulerInput): number {
  let count = 0;
  for (const rj of input.runningJobs) {
    if (rj.nodeId === node.nodeId) count++;
  }
  return count;
}
