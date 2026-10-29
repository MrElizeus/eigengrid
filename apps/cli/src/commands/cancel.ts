// ────────────────────────────────────────────────────────────
// eigengrid cancel <job-id> — cancel a pending or running job
// ────────────────────────────────────────────────────────────
// Routes through the canonical execution coordinator for safe, identity-
// verified cancellation. Pending jobs are materialized atomically; running
// jobs require backend identity and reconciliation. Refuses unsafe PID-only
// cancellation.
// ────────────────────────────────────────────────────────────

import type { CommandModule } from "yargs";
import type { DatabaseLike } from "@eigengrid/db";
import { SshRunner, SlurmRunner } from "@eigengrid/runners";
import { createApplicationContext, runWithContext, type ApplicationContext } from "../composition";

type CancelArgs = {
  jobId: string;
  node?: string;
};

type CancelDependencies = {
  createContext?: typeof createApplicationContext;
  slurmRunnerFactory?: (db: DatabaseLike) => SlurmRunner;
};

export const cancelCommand: CommandModule = {
  command: "cancel <job-id>",
  describe: "Cancel a running local job",
  builder: (y) =>
    y.positional("job-id", {
      describe: "Job ID (supports prefix)",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    await cancelJob(args as unknown as CancelArgs);
  },
};

export async function cancelJob(args: CancelArgs, deps: CancelDependencies = {}): Promise<void> {
  const { jobId } = args;

  try {
    await runWithContext(async (ctx: ApplicationContext) => {
      const resolvedId = await ctx.db.resolveJobId(jobId);
      const job = await ctx.db.getJob(resolvedId);
      if (!job) {
        console.log(`  Job not found: ${resolvedId}\n`);
        return;
      }

      const attempts = await ctx.db.listJobAttempts(resolvedId);
      const latestAttempt = attempts.at(-1);

      // A queued/staged attempt without an external backend identity has not
      // crossed an effect boundary. Materialize cancellation through the
      // coordinator before selecting a backend-specific remote path.
      if (
        (job.status === "queued" || job.status === "staged") &&
        !job.externalJobId &&
        (!latestAttempt || latestAttempt.status === "queued" || latestAttempt.status === "staged")
      ) {
        const result = await ctx.execution.cancelPending?.(resolvedId, "operator-request");
        if (!result) {
          console.log("  Pending cancellation is unavailable in this application context.\n");
          return;
        }
        console.log(
          result.ok
            ? `  Job ${resolvedId} cancelled before external execution.\n`
            : `  Cancel failed: ${result.message}\n`,
        );
        return;
      }

      if (job.backend === "slurm" || latestAttempt?.runner === "slurm") {
        const runner = deps.slurmRunnerFactory?.(ctx.db) ?? new SlurmRunner({}, ctx.db as never);
        const result = await ctx.execution.cancelRemote?.(resolvedId, runner);
        if (!result) {
          console.log("  Remote cancellation is unavailable in this application context.\n");
          return;
        }
        if (result.ok) {
          console.log(`  Job ${resolvedId} cancelled through Slurm.\n`);
        } else {
          console.log(`  Cancel failed: ${result.message ?? "Slurm cancellation failed"}\n`);
        }
        return;
      }

      if (latestAttempt?.runner === "ssh") {
        const nodeRef = args.node ?? job.nodeId ?? undefined;
        if (!nodeRef) {
          console.log("  SSH cancellation requires --node or persisted node identity.\n");
          return;
        }
        const nodeId = await ctx.db.resolveNodeId(nodeRef);
        const node = await ctx.db.getNode(nodeId);
        if (!node) {
          console.log(`  Node not found: ${nodeRef}\n`);
          return;
        }
        const runner = new SshRunner(
          {
            host: node.host,
            port: node.port,
            username: node.user,
            privateKeyPath: node.privateKeyPath ?? undefined,
            knownHostsPath: ctx.config.knownHostsPath ?? process.env.EIGENGRID_KNOWN_HOSTS,
            remoteScratchDir: node.remoteScratchDir,
          },
          ctx.db as never,
        );
        const result = await ctx.execution.cancelRemote?.(resolvedId, runner);
        if (!result) {
          console.log("  Remote cancellation is unavailable in this application context.\n");
          return;
        }
        console.log(
          result.ok
            ? `  Job ${resolvedId} cancelled through SSH.\n`
            : `  Cancel failed: ${result.message}\n`,
        );
        return;
      }

      const result = await ctx.execution.cancelLocal(jobId);

      if (result.ok) {
        console.log(`  Job ${result.jobId} cancelled.\n`);
        console.log(`  Receipt written for attempt ${result.attemptId}\n`);
      } else {
        console.log(`  Cancel failed: ${result.message}\n`);
      }
    }, deps.createContext);
  } catch (err) {
    console.log(`  ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
