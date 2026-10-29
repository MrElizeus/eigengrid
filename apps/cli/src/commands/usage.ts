import type { CommandModule } from "yargs";
import { runWithContext } from "../composition";

export const usageCommand: CommandModule = {
  command: "usage",
  describe: "View resource usage",
  builder: (y) =>
    y
      .command(
        "project <project-id>",
        "Show usage for a project",
        {
          "project-id": { type: "string", demandOption: true, describe: "Project ID or name" },
        } as const,
        async (args) => {
          const projectIdOrName = args["project-id"] as string;
          await runWithContext(async ({ db }) => {
            let project = await db.getProject(projectIdOrName);
            if (!project) project = await db.getProjectByName(projectIdOrName);
            if (!project) {
              console.log(`  Project not found: ${projectIdOrName}\n`);
              return;
            }
            const agg = await db.getProjectAggregatedUsage(project.id);
            console.log(`  Usage for project: ${project.name}`);
            console.log(`  ${"=".repeat(50)}`);
            console.log(`  Jobs:            ${agg.jobCount}`);
            console.log(`  Total CPU:       ${agg.totalCpuThreads} thread-units`);
            console.log(`  Total RAM:       ${agg.totalMemoryMb} MB`);
            console.log(`  Total scratch:   ${agg.totalScratchMb} MB`);
            console.log(`  Total walltime:  ${formatDuration(agg.totalWalltimeMs)}`);
            console.log("");
          });
        },
      )
      .command(
        "user <user-id>",
        "Show usage for a user",
        {
          "user-id": { type: "string", demandOption: true, describe: "User ID or username" },
        } as const,
        async (args) => {
          const userIdOrName = args["user-id"] as string;
          await runWithContext(async ({ db }) => {
            let user = await db.getUser(userIdOrName);
            if (!user) user = await db.getUserByUsername(userIdOrName);
            if (!user) {
              console.log(`  User not found: ${userIdOrName}\n`);
              return;
            }
            const usage = await db.getUserUsage(user.id);
            console.log(`  Usage for user: ${user.username} (${user.id})`);
            console.log(`  ${"=".repeat(50)}`);
            console.log(`  Records: ${usage.length}`);
            let totalCpu = 0,
              totalMem = 0,
              totalScratch = 0,
              totalWalltime = 0;
            for (const r of usage) {
              totalCpu += Number(r.cpuThreads ?? 0);
              totalMem += Number(r.memoryMb ?? 0);
              totalScratch += Number(r.scratchMb ?? 0);
              totalWalltime += Number(r.walltimeMs ?? 0);
            }
            console.log(`  Total CPU:       ${totalCpu} thread-units`);
            console.log(`  Total RAM:       ${totalMem} MB`);
            console.log(`  Total scratch:   ${totalScratch} MB`);
            console.log(`  Total walltime:  ${formatDuration(totalWalltime)}`);
            console.log("");
          });
        },
      )
      .demandCommand(1, "Specify a subcommand: project, user"),
  async handler() {
    console.log("  Use `eigengrid usage project <project>` to view project usage.\n");
  },
};

function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
