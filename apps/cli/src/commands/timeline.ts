import type { CommandModule } from "yargs";
import { runWithContext } from "../composition";

type TimelineArgs = {
  jobId: string;
  json?: boolean;
};

export const timelineCommand: CommandModule = {
  command: "timeline <job-id>",
  describe: "Show human-readable lifecycle timeline for a job",
  builder: (y) =>
    y
      .positional("job-id", {
        describe: "Job ID (supports prefix)",
        type: "string",
        demandOption: true,
      })
      .option("json", { describe: "Output as JSON", type: "boolean", default: false }),
  async handler(args) {
    const { jobId, json } = args as unknown as TimelineArgs;
    await runWithContext(async (ctx) => {
      let resolvedId: string;
      try {
        resolvedId = await ctx.db.resolveJobId(jobId);
      } catch (err) {
        console.log(`  ${err instanceof Error ? err.message : String(err)}\n`);
        return;
      }

      const timeline = await ctx.db.getTimeline(resolvedId);

      if (timeline.length === 0) {
        console.log(`  No events found for job ${resolvedId}\n`);
        return;
      }

      if (json) {
        console.log(JSON.stringify(timeline, null, 2));
        return;
      }

      console.log(`  Timeline for job ${resolvedId}\n`);
      console.log("  TIMESTAMP                EVENT                          DETAILS");
      console.log("  -------------------------------------------------------------------");
      for (const row of timeline) {
        const type = row.type.padEnd(31).slice(0, 31);
        console.log(`  ${row.at}  ${type} ${row.details}`);
      }
      console.log("");
    });
  },
};
