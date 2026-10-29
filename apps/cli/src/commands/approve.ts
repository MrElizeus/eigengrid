import type { CommandModule } from "yargs";
/** application security closure: legacy SQLite proposal approval is NOT scientific authority.
 * This command remains parseable for migration, but has zero side effects.
 */
export const approveCommand: CommandModule = {
  command: "agent approve <proposal-id>",
  describe: "Disabled legacy approval; use host-owned agent-session or canonical mission",
  builder: (y) => y.positional("proposal-id", { type: "string", demandOption: true }).strict(),
  handler() {
    throw new Error(
      "LEGACY_AGENT_APPROVAL_DISABLED: use eigengrid agent-session approve or eigengrid mission approve",
    );
  },
};
