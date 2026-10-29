import type { CommandModule } from "yargs";
import { runWithContext } from "../composition";

type ResultsArgs = {
  jobId: string;
  json?: boolean;
};

export const resultsCommand: CommandModule = {
  command: "results <job-id>",
  describe: "Show parse results for a job",
  builder: (y) =>
    y
      .positional("job-id", {
        describe: "Job ID (supports prefix)",
        type: "string",
        demandOption: true,
      })
      .option("json", { describe: "Output as JSON", type: "boolean", default: false }),
  async handler(args) {
    const { jobId, json } = args as unknown as ResultsArgs;
    await runWithContext(async (ctx) => {
      let resolvedId: string;
      try {
        resolvedId = await ctx.db.resolveJobId(jobId);
      } catch (err) {
        console.log(`  ${err instanceof Error ? err.message : String(err)}\n`);
        return;
      }

      const attempts = await ctx.db.listJobAttempts(resolvedId);
      const latestAttempt = attempts.at(-1);
      const result = latestAttempt
        ? await ctx.db.getLatestResult(resolvedId, latestAttempt.id)
        : null;

      if (!result) {
        console.log(`  No results found for job ${resolvedId}\n`);
        return;
      }

      if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`  Results for job ${resolvedId}\n`);
      console.log(`  Parser:    ${result.parser}`);
      console.log(`  Status:    ${result.status}`);
      if (result.energyHartree != null) {
        console.log(`  Energy:    ${result.energyHartree} Hartree`);
      }
      if (result.scfConverged != null) {
        console.log(`  SCF:       ${result.scfConverged ? "converged" : "not converged"}`);
      }
      if (result.normalTermination != null) {
        console.log(`  Term:      ${result.normalTermination ? "normal" : "abnormal"}`);
      }
      if (result.imaginaryFrequencies != null) {
        console.log(`  ImagFreq:  ${result.imaginaryFrequencies}`);
      }
      if (result.warnings.length > 0) {
        console.log(`  Warnings:  ${result.warnings.join(", ")}`);
      }
      if (result.errors.length > 0) {
        console.log(`  Errors:    ${result.errors.join(", ")}`);
      }
      console.log("");
    });
  },
};
