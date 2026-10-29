import type { CommandModule } from "yargs";
import { generateId } from "@eigengrid/core";
import { runWithContext } from "../composition";

export const projectCommand: CommandModule = {
  command: "project",
  describe: "Manage projects",
  builder: (y) =>
    y
      .command("list", "List all projects", {}, async () => {
        await runWithContext(async ({ db }) => {
          const projects = await db.listProjects();
          if (projects.length === 0) {
            console.log("  No projects found.\n");
            return;
          }
          console.log("  PROJECT ID   NAME             STATUS   MAX CONCURRENT");
          console.log("  -------------------------------------------------------");
          for (const p of projects) {
            const id = (p.id as string).slice(0, 12).padEnd(12);
            const name = (p.name as string).slice(0, 16).padEnd(16);
            const status = (p.status as string).padEnd(8);
            console.log(`  ${id} ${name} ${status} ${p.maxConcurrentJobs}`);
          }
          console.log("");
        });
      })
      .command(
        "create <name>",
        "Create a new project",
        {
          name: { type: "string", demandOption: true, describe: "Project name" },
          description: { type: "string", describe: "Project description" },
          "max-concurrent": { type: "number", default: 10, describe: "Max concurrent jobs" },
        } as const,
        async (args) => {
          const name = args.name as string;
          const description = args.description as string | undefined;
          const maxConcurrent = args["max-concurrent"] as number;
          await runWithContext(async ({ db }) => {
            const existing = await db.getProjectByName(name);
            if (existing) {
              console.log(`  Project already exists: ${name} (${existing.id})\n`);
              return;
            }
            const id = generateId("proj");
            await db.createProject({ id, name, description, maxConcurrentJobs: maxConcurrent });
            console.log(`  Created project: ${name} (${id})\n`);
          });
        },
      )
      .command(
        "show <project-id>",
        "Show project details",
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
            console.log(`  ID:              ${project.id}`);
            console.log(`  Name:            ${project.name}`);
            console.log(`  Description:     ${project.description ?? "(not set)"}`);
            console.log(`  Status:          ${project.status}`);
            console.log(`  Max concurrent:  ${project.maxConcurrentJobs}`);

            // Show members
            const projectId = project.id as string;
            const members = await db.listProjectMembers(projectId);
            if (members.length > 0) {
              console.log(`  Members:`);
              for (const m of members) {
                console.log(`    - ${m.userId} (${m.role})`);
              }
            }

            // Show quota
            const quota = await db.getProjectQuota(projectId);
            if (quota) {
              console.log(`  Quota:`);
              console.log(
                `    CPU:     ${quota.maxCpuThreads === 0 ? "unlimited" : `${quota.maxCpuThreads} threads`}`,
              );
              console.log(
                `    RAM:     ${quota.maxMemoryMb === 0 ? "unlimited" : `${quota.maxMemoryMb} MB`}`,
              );
              console.log(
                `    Scratch: ${quota.maxScratchMb === 0 ? "unlimited" : `${quota.maxScratchMb} MB`}`,
              );
              console.log(
                `    Jobs:    ${quota.maxJobsTotal === 0 ? "unlimited" : `${quota.maxJobsTotal}`}`,
              );
            }
            console.log("");
          });
        },
      )
      .command(
        "archive <project-id>",
        "Archive a project",
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
            await db.archiveProject(project.id);
            console.log(`  Archived project: ${project.name} (${project.id})\n`);
          });
        },
      )
      .command(
        "add-user <project-id> <user-id>",
        "Add a user to a project",
        {
          "project-id": { type: "string", demandOption: true, describe: "Project ID or name" },
          "user-id": { type: "string", demandOption: true, describe: "User ID or username" },
          role: { type: "string", default: "member", describe: "Role: owner, admin, member" },
        } as const,
        async (args) => {
          const projectIdOrName = args["project-id"] as string;
          const userIdOrName = args["user-id"] as string;
          const role = args.role as string;
          await runWithContext(async ({ db }) => {
            let project = await db.getProject(projectIdOrName);
            if (!project) project = await db.getProjectByName(projectIdOrName);
            if (!project) {
              console.log(`  Project not found: ${projectIdOrName}\n`);
              return;
            }
            let user = await db.getUser(userIdOrName);
            if (!user) user = await db.getUserByUsername(userIdOrName);
            if (!user) {
              console.log(`  User not found: ${userIdOrName}\n`);
              return;
            }
            await db.addProjectMember(project.id, user.id, role);
            console.log(`  Added user ${user.username} to project ${project.name} as ${role}\n`);
          });
        },
      )
      .command(
        "remove-user <project-id> <user-id>",
        "Remove a user from a project",
        {
          "project-id": { type: "string", demandOption: true, describe: "Project ID or name" },
          "user-id": { type: "string", demandOption: true, describe: "User ID or username" },
        } as const,
        async (args) => {
          const projectIdOrName = args["project-id"] as string;
          const userIdOrName = args["user-id"] as string;
          await runWithContext(async ({ db }) => {
            let project = await db.getProject(projectIdOrName);
            if (!project) project = await db.getProjectByName(projectIdOrName);
            if (!project) {
              console.log(`  Project not found: ${projectIdOrName}\n`);
              return;
            }
            let user = await db.getUser(userIdOrName);
            if (!user) user = await db.getUserByUsername(userIdOrName);
            if (!user) {
              console.log(`  User not found: ${userIdOrName}\n`);
              return;
            }
            await db.removeProjectMember(project.id, user.id);
            console.log(`  Removed user ${user.username} from project ${project.name}\n`);
          });
        },
      )
      .demandCommand(1, "Specify a subcommand"),
  async handler() {
    console.log("  Use `eigengrid project list` to list projects.\n");
  },
};
