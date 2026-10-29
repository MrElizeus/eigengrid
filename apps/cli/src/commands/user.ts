import type { CommandModule } from "yargs";
import { generateId } from "@eigengrid/core";
import { runWithContext } from "../composition";

export const userCommand: CommandModule = {
  command: "user",
  describe: "Manage users",
  builder: (y) =>
    y
      .command("list", "List all users", {}, async () => {
        await runWithContext(async ({ db }) => {
          const users = await db.listUsers();
          if (users.length === 0) {
            console.log("  No users found.\n");
            return;
          }
          console.log("  USER ID      USERNAME       STATUS");
          console.log("  -------------------------------------");
          for (const u of users) {
            const id = (u.id as string).slice(0, 12).padEnd(12);
            const name = (u.username as string).slice(0, 14).padEnd(14);
            console.log(`  ${id} ${name} ${u.status}`);
          }
          console.log("");
        });
      })
      .command(
        "create <username>",
        "Create a new user",
        {
          username: { type: "string", demandOption: true, describe: "Username" },
          display: { type: "string", describe: "Display name" },
          email: { type: "string", describe: "Email address" },
        } as const,
        async (args) => {
          const username = args.username as string;
          const displayName = args.display as string | undefined;
          const email = args.email as string | undefined;
          await runWithContext(async ({ db }) => {
            const existing = await db.getUserByUsername(username);
            if (existing) {
              console.log(`  User already exists: ${username} (${existing.id})\n`);
              return;
            }
            const id = generateId("user");
            await db.createUser({ id, username, displayName, email });
            console.log(`  Created user: ${username} (${id})\n`);
          });
        },
      )
      .command(
        "show <user-id>",
        "Show user details",
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
            console.log(`  ID:           ${user.id}`);
            console.log(`  Username:     ${user.username}`);
            console.log(`  Display name: ${user.displayName ?? "(not set)"}`);
            console.log(`  Email:        ${user.email ?? "(not set)"}`);
            console.log(`  Status:       ${user.status}`);
            console.log("");
          });
        },
      )
      .command(
        "disable <user-id>",
        "Disable a user (prevents job submission)",
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
            await db.disableUser(user.id);
            console.log(`  Disabled user: ${user.username} (${user.id})\n`);
          });
        },
      )
      .demandCommand(1, "Specify a subcommand: list, create, show, disable"),
  async handler() {
    console.log("  Use `eigengrid user list` to list users.\n");
  },
};
