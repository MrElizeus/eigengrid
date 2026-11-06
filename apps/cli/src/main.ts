import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { initCommand } from "./commands/init";
import { doctorCommand } from "./commands/doctor";
import { statusCommand } from "./commands/status";
import { submitCommand } from "./commands/submit";
import { parseCommand } from "./commands/parse";
import { logsCommand } from "./commands/logs";
import { artifactsCommand } from "./commands/artifacts";
import { resultsCommand } from "./commands/results";
import { eventsCommand } from "./commands/events";
import { timelineCommand } from "./commands/timeline";
import { nodeCommand } from "./commands/node";
import { clusterCommand } from "./commands/cluster";
import { dashboardCommand } from "./commands/dashboard";
import { agentCommand } from "./commands/agent";
import { agentSessionCommand } from "./commands/agent-session";
import { serveCommand } from "./commands/serve";
import { recipesCommand } from "./commands/recipes";
import { collectCommand } from "./commands/collect";
import { workerCommand } from "./commands/worker";
import { showCommand } from "./commands/show";
import { workerAgentCommand } from "./commands/worker-agent";
import { schedulerCommand } from "./commands/scheduler";
import { userCommand } from "./commands/user";
import { projectCommand } from "./commands/project";
import { quotaCommand } from "./commands/quota";
import { usageCommand } from "./commands/usage";
import { backupCommand } from "./commands/backup";
import { exportCommand } from "./commands/export";
import { dbCommand } from "./commands/db";
import { cancelCommand } from "./commands/cancel";
import { planCommand } from "./commands/plan";
import { missionCommand } from "./commands/mission";
import { amberCommand } from "./commands/amber";
import { printSplash } from "./splash";
import { EIGENGRID_VERSION } from "./version";

export async function main(): Promise<void> {
  const argv = hideBin(process.argv);

  if (argv.length === 0) {
    // Check if stdin is a TTY — Ink requires raw mode which only works on TTYs
    if (process.stdin.isTTY) {
      try {
        const [{ render }, { default: React }, { Splash }] = await Promise.all([
          import("ink"),
          import("react"),
          import("./tui/components/Splash"),
        ]);

        const { waitUntilExit } = render(React.createElement(Splash), {
          exitOnCtrlC: true,
        });

        await waitUntilExit();
        return;
      } catch {
        // Ink failed — fall through to static splash
        await printSplash();
        return;
      }
    }

    // Non-TTY or Ink unavailable: print static splash and exit
    await printSplash();
    return;
  }

  await yargs(argv)
    .scriptName("eigengrid")
    .version(EIGENGRID_VERSION)
    .command(initCommand)
    .command(doctorCommand)
    .command(statusCommand)
    .command(submitCommand)
    .command(parseCommand)
    .command(logsCommand)
    .command(artifactsCommand)
    .command(resultsCommand)
    .command(eventsCommand)
    .command(timelineCommand)
    .command(nodeCommand)
    .command(clusterCommand)
    .command(dashboardCommand)
    .command(agentCommand)
    .command(agentSessionCommand)
    .command(serveCommand)
    .command(recipesCommand)
    .command(collectCommand)
    .command(workerCommand)
    .command(showCommand)
    .command(workerAgentCommand)
    .command(schedulerCommand)
    .command(backupCommand)
    .command(exportCommand)
    .command(userCommand)
    .command(projectCommand)
    .command(quotaCommand)
    .command(usageCommand)
    .command(cancelCommand)
    .command(dbCommand)
    .command(planCommand)
    .command(missionCommand)
    .command(amberCommand)
    .demandCommand(1, "Use --help to see available commands")
    .strict()
    .help()
    .parse();
}
