import type { CommandModule } from "yargs";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { runWithContext, type ApplicationContext } from "../composition";

type LogsArgs = {
  jobId: string;
  stdout?: boolean;
  stderr?: boolean;
  tail?: number;
};

export const logsCommand: CommandModule = {
  command: "logs <job-id>",
  describe: "Show job logs",
  builder: (y) =>
    y
      .positional("job-id", {
        describe: "Job ID (supports prefix)",
        type: "string",
        demandOption: true,
      })
      .option("stdout", { describe: "Show stdout only", type: "boolean", default: false })
      .option("stderr", { describe: "Show stderr only", type: "boolean", default: false })
      .option("tail", { describe: "Show only last N lines", type: "number" }),
  async handler(args) {
    const { jobId, stdout, stderr, tail } = args as unknown as LogsArgs;

    try {
      await runWithContext(async (ctx: ApplicationContext) => {
        const { db, config } = ctx;

        let resolvedId: string;
        try {
          resolvedId = await db.resolveJobId(jobId);
        } catch (err) {
          console.log(`  ${err instanceof Error ? err.message : String(err)}\n`);
          return;
        }

        // Get job to find workdir
        const job = await db.getJob(resolvedId);
        if (!job) {
          console.log(`  Job ${resolvedId} not found.\n`);
          return;
        }

        const workdir = (job.workdir as string) ?? config.jobsDir;
        const jobDir = join(workdir, resolvedId);
        const stdoutPath = join(jobDir, "stdout.log");
        const stderrPath = join(jobDir, "stderr.log");

        const showStdout = stdout || (!stdout && !stderr);
        const showStderr = stderr || (!stdout && !stderr);

        console.log(`  Logs for job ${resolvedId}\n`);

        let hasOutput = false;

        if (showStdout && existsSync(stdoutPath)) {
          const content = readFileSync(stdoutPath, "utf-8");
          const lines = tail ? content.split("\n").slice(-tail) : content.split("\n");
          hasOutput = true;
          for (const line of lines) {
            console.log(`           ${line}`);
          }
        } else if (showStdout) {
          console.log("  [stdout log not found]\n");
        }

        if (showStderr && existsSync(stderrPath)) {
          const content = readFileSync(stderrPath, "utf-8");
          const lines = tail ? content.split("\n").slice(-tail) : content.split("\n");
          hasOutput = true;
          console.log("  [stderr]");
          for (const line of lines) {
            console.log(`  [stderr] ${line}`);
          }
        } else if (showStderr) {
          console.log("  [stderr log not found]\n");
        }

        if (!hasOutput) {
          console.log(
            "  No log files found. The job may still be running or no output was captured.\n",
          );
        }
      });
    } catch (err) {
      console.log(`  ${err instanceof Error ? err.message : String(err)}\n`);
    }
  },
};
