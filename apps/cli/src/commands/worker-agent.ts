import type { CommandModule } from "yargs";
import { resolve } from "path";
import { loadConfig } from "@eigengrid/config";
import type { WorkerAgentConfig } from "@eigengrid/core";
import { deriveActionHistory, readLedgerWithIntegrity } from "@eigengrid/worker-agent";
import type { DerivedActionHistory } from "@eigengrid/worker-agent";

// ────────────────────────────────────────────────────────────
// eigengrid worker-agent <subcommand>
// ────────────────────────────────────────────────────────────

type WorkerAgentArgs = {
  node: string;
  mode?: string;
};

export const workerAgentCommand: CommandModule = {
  command: "worker-agent <subcommand>",
  describe: "Worker agent management (recovery agent)",
  builder: (y) =>
    y
      .command(
        "status <node>",
        "Show worker agent mode and recent decisions",
        (y2) =>
          y2.positional("node", {
            describe: "Node name or ID",
            type: "string",
            demandOption: true,
          }),
        async (args) => {
          const a = args as unknown as WorkerAgentArgs;
          const config = await loadConfig();
          const scratchDir = resolve(config.remoteScratchDir ?? process.cwd());

          const wa = config.workerAgent ?? getDefaultWorkerAgentConfig();
          console.log(`  Node:                    ${a.node}`);
          console.log(`  Worker agent mode:       ${wa.mode}`);
          console.log(`  Max actions per job:     ${wa.maxRecoveryActionsPerJob}`);
          console.log(`  Max actions per hour:    ${wa.maxRecoveryActionsPerHour}`);
          console.log(`  Allow parser retry:      ${wa.allowParserRetry}`);
          console.log(`  Allow artifact sync:     ${wa.allowArtifactSyncRetry}`);
          console.log(`  Allow same command:      ${wa.allowSameCommandRetry}`);
          console.log(`  Allow node drain:        ${wa.allowNodeDrain}`);
          console.log(`  Allow PID reattach:      ${wa.allowPidReattach}`);
          console.log("");

          // Show recent decisions
          const recent = deriveActionHistory(readLedgerWithIntegrity(scratchDir).records)
            .slice(-10)
            .reverse();
          if (recent.length > 0) {
            console.log("  Recent decisions (last 10):");
            for (const { evaluation: d, outcome } of recent) {
              const time = new Date(d.createdAt).toISOString();
              console.log(
                `    [${time}] ${d.decision.padEnd(24)} ${outcome ?? "evaluated"} ${d.reason}`,
              );
            }
          } else {
            console.log("  No decisions recorded.");
          }
          console.log("");
        },
      )
      .command(
        "decisions <node>",
        "List all agent decisions",
        (y2) =>
          y2.positional("node", {
            describe: "Node name or ID",
            type: "string",
            demandOption: true,
          }),
        async (_args) => {
          const config = await loadConfig();
          const scratchDir = resolve(config.remoteScratchDir ?? process.cwd());

          const history = deriveActionHistory(readLedgerWithIntegrity(scratchDir).records);
          if (history.length === 0) {
            console.log("  No decisions recorded.\n");
            return;
          }

          for (const entry of history) {
            for (const line of formatDecisionHistoryEntry(entry)) console.log(line);
            console.log("");
          }
        },
      )
      .command(
        "disable <node>",
        "Disable worker agent (set mode to off)",
        (y2) =>
          y2.positional("node", {
            describe: "Node name or ID",
            type: "string",
            demandOption: true,
          }),
        async () => {
          console.log("  Run: eigengrid config set workerAgent.mode off\n");
          console.log("  Or set: EIGENGRID_WORKER_AGENT_MODE=off in your environment\n");
        },
      )
      .command(
        "enable <node>",
        "Enable worker agent (recover-only mode)",
        (y2) =>
          y2
            .positional("node", {
              describe: "Node name or ID",
              type: "string",
              demandOption: true,
            })
            .option("mode", {
              type: "string",
              default: "recover-only",
              choices: ["recover-only"],
              describe: "Worker agent mode",
            }),
        async (args) => {
          const a = args as unknown as WorkerAgentArgs;
          console.log(`  Run: eigengrid config set workerAgent.mode ${a.mode ?? "recover-only"}\n`);
          console.log("  Or set: EIGENGRID_WORKER_AGENT_MODE=recover-only in your environment\n");
        },
      )
      .demandCommand(1, "Use --help to see available subcommands")
      .strict(),
  async handler() {
    console.log("  Use one of: status, decisions, disable, enable\n");
  },
};

export function formatDecisionHistoryEntry({
  evaluation: decision,
  reservation,
  outcome,
  message,
}: DerivedActionHistory): string[] {
  return [
    `  ID:        ${decision.id}`,
    `  Time:      ${new Date(decision.createdAt).toISOString()}`,
    `  Job:       ${decision.jobId ?? "N/A"}`,
    `  Decision:  ${decision.decision}`,
    `  Reason:    ${decision.reason}`,
    `  Confidence: ${decision.confidence}`,
    `  Mode:      ${decision.mode}`,
    `  Reserved:  ${reservation ? new Date(reservation.reservedAt).toISOString() : "no"}`,
    `  Blocked:   ${decision.blockedAt ? new Date(decision.blockedAt).toISOString() : "no"}`,
    `  Outcome:   ${outcome ?? "not reserved"}${message ? ` (${message})` : ""}`,
  ];
}

function getDefaultWorkerAgentConfig(): WorkerAgentConfig {
  return {
    mode: "off",
    maxRecoveryActionsPerJob: 1,
    maxRecoveryActionsPerHour: 10,
    allowParserRetry: true,
    allowArtifactSyncRetry: true,
    allowSameCommandRetry: false,
    allowNodeDrain: true,
    allowPidReattach: true,
  };
}
