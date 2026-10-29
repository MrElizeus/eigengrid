import type { CommandModule } from "yargs";
import { runWithContext } from "../composition";

export const quotaCommand: CommandModule = {
  command: "quota",
  describe: "Manage project quotas",
  builder: (y) =>
    y
      .command(
        "show <project-id>",
        "Show quota for a project",
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
            const quota = await db.getProjectQuota(project.id);
            if (!quota) {
              console.log(`  No quota configured for project: ${project.name} (unlimited)\n`);
              return;
            }
            console.log(`  Quota for project: ${project.name} (${project.id})`);
            console.log(`  ${"=".repeat(50)}`);
            console.log(
              `  Max CPU threads:     ${quota.maxCpuThreads === 0 ? "unlimited" : quota.maxCpuThreads}`,
            );
            console.log(
              `  Max RAM (MB):        ${quota.maxMemoryMb === 0 ? "unlimited" : quota.maxMemoryMb}`,
            );
            console.log(
              `  Max scratch (MB):    ${quota.maxScratchMb === 0 ? "unlimited" : quota.maxScratchMb}`,
            );
            console.log(
              `  Max total jobs:      ${quota.maxJobsTotal === 0 ? "unlimited" : quota.maxJobsTotal}`,
            );
            console.log("");
          });
        },
      )
      .command(
        "set <project-id>",
        "Set quota for a project",
        {
          "project-id": { type: "string", demandOption: true, describe: "Project ID or name" },
          cpu: { type: "number", describe: "Max CPU threads (0 = unlimited)" },
          memory: { type: "number", describe: "Max RAM in MB (0 = unlimited)" },
          scratch: { type: "number", describe: "Max scratch in MB (0 = unlimited)" },
          jobs: { type: "number", describe: "Max total jobs (0 = unlimited)" },
        } as const,
        async (args) => {
          const projectIdOrName = args["project-id"] as string;
          const cpu = args.cpu as number | undefined;
          const memory = args.memory as number | undefined;
          const scratch = args.scratch as number | undefined;
          const jobs = args.jobs as number | undefined;

          if (
            cpu === undefined &&
            memory === undefined &&
            scratch === undefined &&
            jobs === undefined
          ) {
            console.log("  Specify at least one quota limit: --cpu, --memory, --scratch, --jobs\n");
            return;
          }

          await runWithContext(async ({ db }) => {
            let project = await db.getProject(projectIdOrName);
            if (!project) project = await db.getProjectByName(projectIdOrName);
            if (!project) {
              console.log(`  Project not found: ${projectIdOrName}\n`);
              return;
            }
            await db.setProjectQuota(project.id, {
              maxCpuThreads: cpu,
              maxMemoryMb: memory,
              maxScratchMb: scratch,
              maxJobsTotal: jobs,
            });
            console.log(`  Quota updated for project: ${project.name}\n`);
          });
        },
      )
      .demandCommand(1, "Specify a subcommand: show, set"),
  async handler() {
    console.log("  Use `eigengrid quota show <project>` to view quotas.\n");
  },
};
