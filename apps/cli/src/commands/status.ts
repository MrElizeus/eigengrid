// ────────────────────────────────────────────────────────────
// eigengrid status [job-id] — show job status
// ────────────────────────────────────────────────────────────
// Routes local job detail through ctx.execution.reconcileLocal()
// before rendering. No command-handler local lifecycle writes.
// Job listing is read-only. Slurm reconciliation routes through SlurmRunner.
// ────────────────────────────────────────────────────────────

import type { CommandModule } from "yargs";
import type { DatabaseLike, JobRecord } from "@eigengrid/db";
import { SlurmCliClient, type SlurmClient } from "@eigengrid/slurm";
import { SlurmRunner } from "@eigengrid/runners";
import { createApplicationContext, runWithContext, type ApplicationContext } from "../composition";

type StatusArgs = {
  jobId?: string;
};

type StatusDependencies = {
  createContext?: typeof createApplicationContext;
  createSlurmClient?: () => Pick<SlurmClient, "getJobStatus"> &
    Partial<Pick<SlurmClient, "getAccounting">>;
};

export const statusCommand: CommandModule = {
  command: "status [job-id]",
  describe: "Show job and node status",
  builder: (y) => y.positional("job-id", { describe: "Job ID (supports prefix)", type: "string" }),
  async handler(args) {
    await runStatus(args as unknown as StatusArgs);
  },
};
export async function runStatus(args: StatusArgs, deps: StatusDependencies = {}): Promise<void> {
  try {
    await runWithContext(async (ctx: ApplicationContext) => {
      if (args.jobId) {
        await showJobDetail(ctx, args.jobId!, deps);
      } else {
        await listAllJobs(ctx.db);
      }
    }, deps.createContext);
  } catch (err) {
    console.log(`  ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

async function listAllJobs(db: DatabaseLike): Promise<void> {
  console.log("  Job Status\n");
  const jobs = await db.listJobs();
  if (jobs.length === 0) {
    console.log("  No jobs found. Use `eigengrid submit` to create one.\n");
    return;
  }
  console.log("  JOB ID       STATUS      SOFTWARE");
  console.log("  ---------------------------------");
  for (const j of jobs) {
    const id = (j.id as string).slice(0, 12).padEnd(12);
    const s = (j.status as string).padEnd(11);
    console.log(`  ${id} ${s} ${j.software}`);
  }
  console.log("");
}

export async function showJobDetail(
  ctx: ApplicationContext,
  jobId: string,
  deps: {
    createSlurmClient?: () => Pick<SlurmClient, "getJobStatus"> &
      Partial<Pick<SlurmClient, "getAccounting">>;
  } = {},
): Promise<void> {
  const { db } = ctx;

  let resolvedId: string;
  try {
    resolvedId = await db.resolveJobId(jobId);
  } catch (err) {
    console.log(`  ${err instanceof Error ? err.message : String(err)}\n`);
    return;
  }

  const job = await db.getJob(resolvedId);
  if (!job) {
    console.log(`  Job not found: ${resolvedId}\n`);
    return;
  }

  // ── Reconcile local jobs before rendering ───────────────
  // This updates the command's view of local job state without
  // direct lifecycle writes in the handler.
  const isLocal = !job.backend || job.backend === "local" || String(job.backend ?? "") === "";

  if (isLocal) {
    try {
      await ctx.execution.reconcileLocal(resolvedId);
    } catch {
      // Reconciliation is advisory — continue rendering
    }
    // Refresh job after reconciliation
    const refreshed = await db.getJob(resolvedId);
    if (refreshed) Object.assign(job, refreshed);
  }

  // ── Render ───────────────────────────────────────────────
  console.log(`\n  Job: ${resolvedId}\n`);

  console.log(`  ID:          ${job.id}`);
  console.log(`  Name:        ${job.name}`);
  console.log(`  Software:    ${job.software}`);
  console.log(`  Input:       ${job.inputPath ?? "-"}`);
  console.log(`  Output:      ${job.outputPath ?? "-"}`);
  console.log(`  Workdir:     ${job.workdir}`);
  console.log(`  Status:      ${job.status}`);
  if (job.backend) console.log(`  Backend:     ${job.backend}`);
  if (job.externalJobId) console.log(`  External ID: ${job.externalJobId}`);

  if (job.backend === "slurm" && job.externalJobId) {
    await syncSlurmStatus(ctx, job, deps);
  }

  // Show latest attempt info
  const attempts = await db.listJobAttempts(resolvedId);
  if (attempts.length > 0) {
    const latest = attempts[attempts.length - 1];
    console.log("");
    console.log("  Latest Attempt:");
    console.log(`  Runner:      ${latest.runner}`);
    if (latest.pid != null) console.log(`  PID:         ${latest.pid}`);
    if (latest.exitCode != null) console.log(`  Exit code:   ${latest.exitCode}`);
    console.log(`  Command:     ${latest.command}`);
    if (latest.startedAt != null)
      console.log(`  Started:     ${new Date(latest.startedAt).toISOString()}`);
    if (latest.finishedAt != null)
      console.log(`  Finished:    ${new Date(latest.finishedAt).toISOString()}`);
  }

  console.log("");
}

async function syncSlurmStatus(
  ctx: ApplicationContext,
  job: JobRecord,
  deps: {
    createSlurmClient?: () => Pick<SlurmClient, "getJobStatus"> &
      Partial<Pick<SlurmClient, "getAccounting">>;
  },
): Promise<void> {
  const externalJobId = job.externalJobId;
  if (!externalJobId) return;

  const supplied = deps.createSlurmClient?.();
  const slurm = supplied
    ? ({
        submitJob: async () => ({
          success: false,
          slurmJobId: "",
          error: "status-only client",
        }),
        getJobStatus: supplied.getJobStatus,
        cancelJob: async () => ({ success: false, error: "status-only client" }),
        getNodes: async () => [],
        getPartitions: async () => [],
        getAccounting: supplied.getAccounting ?? (async () => null),
      } satisfies SlurmClient)
    : new SlurmCliClient();

  const runner = new SlurmRunner({}, ctx.db as never, slurm);
  const result = await ctx.execution.reconcileRemote?.(job.id, runner);
  if (!result) {
    console.log("  Slurm reconciliation is unavailable in this application context.");
    return;
  }

  const refreshed = await ctx.db.getJob(job.id);
  console.log(`  Slurm ID:    ${externalJobId}`);
  const displayState =
    refreshed?.externalState ?? result.message?.replace(/^SLURM state:\s*/, "") ?? result.status;
  console.log(`  Slurm State: ${displayState}`);
  if (refreshed?.nodeName) console.log(`  Node:        ${refreshed.nodeName}`);
  if (result.message) console.log(`  Slurm Sync:  ${result.message}`);
}
