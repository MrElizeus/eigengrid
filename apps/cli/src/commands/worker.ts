import type { CommandModule } from "yargs";
import { resolve } from "path";
import { loadConfig } from "@eigengrid/config";
import {
  ensureWorkerLayout,
  checkWorkerLayout,
  runDaemon,
  runOnce,
  getDaemonStatus,
  createStopController,
} from "@eigengrid/worker";
import type { DaemonConfig } from "@eigengrid/worker";
import { runRecoveryCycle } from "@eigengrid/worker-agent";

// ────────────────────────────────────────────────────────────
// eigengrid worker <subcommand>
// ────────────────────────────────────────────────────────────

type WorkerArgs = {
  "poll-interval"?: number;
  "max-concurrent"?: number;
  "scratch-dir"?: string;
  init?: boolean;
};

export const workerCommand: CommandModule = {
  command: "worker <subcommand>",
  describe: "Worker daemon management",
  builder: (y) =>
    y
      .command(
        "daemon",
        "Run the worker daemon (long-lived poll loop)",
        (y2) =>
          y2
            .option("poll-interval", {
              type: "number",
              default: 5,
              describe: "Poll interval in seconds",
            })
            .option("max-concurrent", {
              type: "number",
              default: 1,
              describe: "Maximum concurrent jobs",
            })
            .option("scratch-dir", {
              type: "string",
              describe: "Override remoteScratchDir from config",
            })
            .option("init", {
              type: "boolean",
              default: false,
              describe: "Initialize worker layout before starting",
            }),
        async (args) => {
          const a = args as unknown as WorkerArgs;
          const config = await loadConfig();

          const scratchDir = resolve(a["scratch-dir"] ?? config.remoteScratchDir ?? process.cwd());

          // Initialize layout if requested
          if (a.init) {
            ensureWorkerLayout(scratchDir);
            console.log(`  Worker layout created at ${scratchDir}\n`);
          }

          // Check layout exists
          const layout = checkWorkerLayout(scratchDir);
          if (!layout.ok) {
            console.log(
              `  Worker layout incomplete at ${scratchDir}. Missing: ${layout.missing.join(", ")}\n`,
            );
            console.log("  Run with --init to create the layout.\n");
            return;
          }

          const wa = config.workerAgent;
          const daemonConfig: DaemonConfig = {
            scratchDir,
            pollIntervalMs: (a["poll-interval"] ?? 5) * 1000,
            maxConcurrent: a["max-concurrent"] ?? 1,
            recoveryHandler:
              wa && wa.mode !== "off"
                ? async (s: string) => {
                    await runRecoveryCycle(s, wa, config.nodeName ?? "unknown");
                  }
                : undefined,
          };

          console.log(
            `  Worker daemon starting (poll=${daemonConfig.pollIntervalMs}ms, max=${daemonConfig.maxConcurrent})\n`,
          );
          if (wa && wa.mode !== "off") {
            console.log(`  Worker agent mode: ${wa.mode}\n`);
          }
          console.log("  Press Ctrl+C to stop.\n");

          const controller = createStopController();

          process.on("SIGINT", () => {
            console.log("\n  Shutting down daemon...\n");
            controller.stop();
          });
          process.on("SIGTERM", () => {
            console.log("\n  Shutting down daemon...\n");
            controller.stop();
          });

          const result = await runDaemon(daemonConfig, controller);

          console.log(`  Daemon stopped. Processed ${result.processedCount} jobs.\n`);
        },
      )
      .command(
        "once",
        "Process one ready job and exit",
        (y2) =>
          y2.option("scratch-dir", {
            type: "string",
            describe: "Override remoteScratchDir from config",
          }),
        async (args) => {
          const a = args as unknown as WorkerArgs;
          const config = await loadConfig();
          const scratchDir = resolve(a["scratch-dir"] ?? config.remoteScratchDir ?? process.cwd());

          const result = await runOnce(scratchDir);
          if (result.ok) {
            console.log(`  Processed ${result.processed} job(s).\n`);
          } else {
            console.log("  Failed to process job.\n");
          }
        },
      )
      .command(
        "status",
        "Show worker daemon status",
        (y2) =>
          y2.option("scratch-dir", {
            type: "string",
            describe: "Override remoteScratchDir from config",
          }),
        async (args) => {
          const a = args as unknown as WorkerArgs;
          const config = await loadConfig();
          const scratchDir = resolve(a["scratch-dir"] ?? config.remoteScratchDir ?? process.cwd());

          const status = getDaemonStatus(scratchDir);
          console.log(`  Daemon dir: ${status.daemonDir}`);
          console.log(`  Running:    ${status.running ? "yes" : "no"}`);
          console.log(`  Active jobs: ${status.activeJobs}`);
          console.log("");
        },
      )
      .demandCommand(1, "Use --help to see available subcommands")
      .strict(),
  async handler() {
    // If no subcommand is given, show help
    console.log("  Use one of: daemon, once, status\n");
  },
};
