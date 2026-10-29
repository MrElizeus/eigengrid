// ────────────────────────────────────────────────────────────
// eigengrid parse [software] [output-path] — parse output files
// ────────────────────────────────────────────────────────────
// Two modes:
//   1. Job-aware: eigengrid parse <job-id> — routes through
//      ctx.execution.parseJob() for coordinator-owned parsing
//      with result persistence and completed→parsed transition.
//   2. Legacy file parse: eigengrid parse <software> <output-path>
//      — direct file parse through the Python bridge.
// ────────────────────────────────────────────────────────────

import type { CommandModule } from "yargs";
import { createApplicationContext, runWithContext, type ApplicationContext } from "../composition";

type ParseArgs = { software?: string; outputPath?: string };

type ParseDependencies = {
  createContext?: typeof createApplicationContext;
};

export const parseCommand: CommandModule = {
  command: "parse [software] [output-path]",
  describe: "Parse a computational chemistry output file or run job-aware parsing",
  builder: (y) =>
    y
      .positional("software", { describe: "Software used or job ID", type: "string" })
      .positional("output-path", { describe: "Path to output file", type: "string" }),
  async handler(args) {
    await runParse(args as unknown as ParseArgs);
  },
};

export async function runParse(args: ParseArgs, deps: ParseDependencies = {}): Promise<void> {
  const { software, outputPath } = args;

  // ── Job-aware mode: eigengrid parse <job-id> ─────────────
  if (software && !outputPath) {
    await handleJobParse(software, deps);
    return;
  }

  // ── Legacy mode: eigengrid parse <software> <output-path> ─
  if (!software || !outputPath) {
    console.log("  Usage: eigengrid parse <software> <output-path>\n");
    console.log("    or:   eigengrid parse <job-id>\n");
    return;
  }

  try {
    await runWithContext(async (ctx: ApplicationContext) => {
      const result = await ctx.parsers.parse(software as string, outputPath as string);
      if (result.ok) {
        console.log("  Parse result:", JSON.stringify(result.data, null, 4), "\n");
      } else {
        console.log("  Parse failed:", result.error?.message ?? "Unknown error", "\n");
      }
    }, deps.createContext);
  } catch (err) {
    console.log(`  ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

async function handleJobParse(jobIdArg: string, deps: ParseDependencies): Promise<void> {
  try {
    await runWithContext(async (ctx: ApplicationContext) => {
      // Route through coordinator-owned parseJob
      const result = await ctx.execution.parseJob(jobIdArg);

      if (result.ok) {
        console.log(`  Parse completed for job ${result.jobId}:\n`);
        console.log(`    Parser:    ${result.parser}`);
        console.log(`    Result ID: ${result.resultId}`);
        console.log(`    ${result.message}\n`);

        // Show result data if available
        const results = await ctx.queries.results.list(result.jobId);
        if (results.length > 0) {
          const latest = results[results.length - 1];
          if (latest.energyHartree != null) {
            console.log(`    Energy:    ${latest.energyHartree} Hartree`);
          }
          if (latest.scfConverged != null) {
            console.log(`    SCF:       ${latest.scfConverged ? "converged" : "not converged"}`);
          }
          if (latest.normalTermination != null) {
            console.log(`    Term:      ${latest.normalTermination ? "normal" : "abnormal"}`);
          }
          if (latest.imaginaryFrequencies != null) {
            console.log(`    ImagFreq:  ${latest.imaginaryFrequencies}`);
          }
          console.log("");
        }
      } else {
        console.log(`  Parse failed: ${result.message}\n`);
      }
    }, deps.createContext);
  } catch (err) {
    console.log(`  ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
