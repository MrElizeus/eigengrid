import type { CommandModule } from "yargs";
/** application security closure: legacy approved SQLite rows cannot authorize a retry.
 * Do not restore executeLocal/parseJob here: mission runtime owns all scientific effects.
 */
export const executeCommand: CommandModule = {
  command: "agent execute <proposal-id>",
  describe: "Disabled unsafe legacy retry execution; use canonical mission services",
  builder: (y) => y.positional("proposal-id", { type: "string", demandOption: true }).strict(),
  handler() {
    throw new Error(
      "LEGACY_AGENT_EXECUTE_DISABLED: use eigengrid mission and mission runtime reconciliation",
    );
  },
};
