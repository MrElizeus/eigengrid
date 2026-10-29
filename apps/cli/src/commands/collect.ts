// ────────────────────────────────────────────────────────────
// eigengrid collect <job-id> — collect artifacts
// ────────────────────────────────────────────────────────────
// Routes local collection through ctx.execution.collectLocal()
// for path reconstruction, deduplication, and artifact registration.
// Leaves worker/SSH/Slurm collection behavior unchanged.
// ────────────────────────────────────────────────────────────

import type { CommandModule } from "yargs";
import type { Config } from "@eigengrid/core";
import type { DatabaseLike } from "@eigengrid/db";
import { SshRunner, SlurmRunner } from "@eigengrid/runners";
import { WorkerSyncService } from "../services/worker-sync-service";
import { WorkerDaemonCollectionBackend } from "../services/worker-daemon-backend";
import { createApplicationContext, runWithContext, type ApplicationContext } from "../composition";

type CollectArgs = {
  jobId: string;
  node?: string;
};

type CollectDependencies = {
  createContext?: typeof createApplicationContext;
  slurmRunnerFactory?: (db: DatabaseLike) => SlurmRunner;
  workerSyncServiceFactory?: (db: DatabaseLike, config: Config) => WorkerSyncService;
};

export const collectCommand: CommandModule = {
  command: "collect <job-id>",
  describe: "Collect output files for a job",
  builder: (y) =>
    y
      .positional("job-id", {
        describe: "Job ID (supports prefix)",
        type: "string",
        demandOption: true,
      })
      .option("node", { describe: "Node name or ID", type: "string" }),
  async handler(args) {
    await collectJob(args as unknown as CollectArgs);
  },
};

export async function collectJob(args: CollectArgs, deps: CollectDependencies = {}): Promise<void> {
  const { jobId, node } = args;

  const slurmRunnerFactory =
    deps.slurmRunnerFactory ?? ((database: DatabaseLike) => new SlurmRunner({}, database as never));
  const workerSyncServiceFactory =
    deps.workerSyncServiceFactory ??
    ((database: DatabaseLike, config: Config) => new WorkerSyncService(database as never, config));

  try {
    await runWithContext(async (ctx: ApplicationContext) => {
      const { db, config } = ctx;

      // Resolve job ID
      let resolvedId: string;
      try {
        resolvedId = await db.resolveJobId(jobId);
      } catch (err) {
        console.log(`  ${err instanceof Error ? err.message : String(err)}\n`);
        return;
      }

      // Get the job
      const job = await db.getJob(resolvedId);
      if (!job) {
        console.log(`  Job not found: ${resolvedId}\n`);
        return;
      }

      // Check backend/runner kind to determine collection strategy
      const attempts = await db.listJobAttempts(resolvedId);
      const latestAttempt = attempts[attempts.length - 1];
      const runnerKind = latestAttempt?.runner;
      const isSlurmJob =
        String((job as { backend?: unknown }).backend ?? "") === "slurm" || runnerKind === "slurm";

      if (!latestAttempt && !isSlurmJob) {
        console.log(`  No attempts found for job ${resolvedId}\n`);
        return;
      }

      if (runnerKind === "worker-daemon") {
        // ── Worker daemon: collect through the canonical coordinator ──
        const syncService = workerSyncServiceFactory(db, config);
        const backend = new WorkerDaemonCollectionBackend(db, syncService, node);
        const result = await ctx.execution.collectRemote?.(resolvedId, backend);

        if (result?.ok) {
          console.log(`  Artifacts collected for job ${resolvedId}\n`);
          await printCollectedArtifacts(db, resolvedId);
        } else {
          console.log(
            `  Collect failed: ${result?.message ?? "worker-daemon coordinator is unavailable"}\n`,
          );
        }
        return;
      }

      if (isSlurmJob) {
        const runner = slurmRunnerFactory(db);
        console.log(`  Collecting artifacts for job ${resolvedId} from Slurm...\n`);

        const result = await ctx.execution.collectRemote?.(resolvedId, runner);
        if (!result) {
          console.log("  Remote collection is unavailable in this application context.\n");
          return;
        }
        if (result.ok) {
          console.log(`  Artifacts collected: ${result.message}\n`);
          await printCollectedArtifacts(db, resolvedId);
        } else {
          console.log(`  Collect failed: ${result.message}\n`);
        }
        return;
      }

      // ── Local collection: route through coordinator ────
      if (!runnerKind || runnerKind === "local") {
        const result = await ctx.execution.collectLocal(resolvedId);

        if (result.ok) {
          console.log(`  Collected ${result.artifacts.length} artifact(s) for job ${resolvedId}\n`);
          await printCollectedArtifacts(db, resolvedId);
        } else {
          console.log(`  Collect failed: ${result.message}\n`);
        }
        return;
      }

      if (runnerKind !== "ssh") {
        console.log(
          `  Job ${resolvedId} uses "${runnerKind}" runner. Collect is only for local, SSH, worker-daemon, and Slurm jobs.\n`,
        );
        return;
      }

      // ── SSH collection (unchanged) ──────────────────────
      let sshHost: string | undefined;
      let sshUser = process.env.USER ?? "root";
      let sshPort = 22;
      let sshKey: string | undefined;
      let remoteDir = "/scratch/eigengrid";

      if (node) {
        try {
          const resolvedNodeId = await db.resolveNodeId(node);
          const nodeRecord = await db.getNode(resolvedNodeId);
          if (nodeRecord) {
            sshHost = nodeRecord.host;
            sshUser = nodeRecord.user;
            sshPort = nodeRecord.port ?? 22;
            sshKey = nodeRecord.privateKeyPath ?? undefined;
            remoteDir = nodeRecord.remoteScratchDir ?? remoteDir;
          }
        } catch {
          console.log(`  Node not found: ${node}\n`);
          return;
        }
      } else if (latestAttempt?.cwd) {
        console.log("  No --node specified and SSH host cannot be determined from job metadata.\n");
        console.log("  Please provide --node <name> to identify the SSH node.\n");
        return;
      }

      if (!sshHost) {
        console.log("  Could not determine SSH host. Use --node <name> to specify the node.\n");
        return;
      }

      const runner = new SshRunner(
        {
          host: sshHost,
          port: sshPort,
          username: sshUser,
          privateKeyPath: sshKey,
          knownHostsPath: config.knownHostsPath ?? process.env.EIGENGRID_KNOWN_HOSTS,
          remoteScratchDir: remoteDir,
        },
        db,
      );

      console.log(
        `  Collecting artifacts for job ${resolvedId} from ${sshHost}:${remoteDir}/${resolvedId}...\n`,
      );

      const result = await ctx.execution.collectRemote?.(resolvedId, runner);
      if (!result) {
        console.log("  Remote collection is unavailable in this application context.\n");
        return;
      }

      if (result.ok) {
        console.log(`  Artifacts collected: ${result.message}\n`);
        await printCollectedArtifacts(db, resolvedId);
      } else {
        console.log(`  Collect failed: ${result.message}\n`);
      }
    }, deps.createContext);
  } catch (err) {
    console.log(`  ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

async function printCollectedArtifacts(
  db: {
    listArtifacts(
      jobId?: string,
    ): Promise<
      Array<{ kind: string; label?: string | null; path: string; sizeBytes?: number | null }>
    >;
  },
  resolvedId: string,
): Promise<void> {
  const artifacts = await db.listArtifacts(resolvedId);
  const collected = artifacts.filter((a) => a.kind === "log" || a.kind === "output");
  if (collected.length > 0) {
    console.log("  Collected files:");
    for (const a of collected) {
      const label = a.label ?? a.kind;
      const size = a.sizeBytes != null ? `(${formatSize(a.sizeBytes)})` : "";
      console.log(`    ${label}: ${a.path} ${size}`);
    }
    console.log("");
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
