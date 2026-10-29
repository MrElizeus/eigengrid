import type { CommandModule } from "yargs";
import { runWithContext } from "../composition";

type EventsArgs = {
  jobId?: string;
  type?: string;
  json?: boolean;
};

export const eventsCommand: CommandModule = {
  command: "events [job-id]",
  describe: "List events from the event log",
  builder: (y) =>
    y
      .positional("job-id", { describe: "Job ID (supports prefix)", type: "string" })
      .option("type", { describe: "Filter by event type", type: "string" })
      .option("json", { describe: "Output as JSON", type: "boolean", default: false }),
  async handler(args) {
    const { jobId, type, json } = args as unknown as EventsArgs;
    await runWithContext(async (ctx) => {
      let resolvedId: string | undefined;
      if (jobId) {
        try {
          resolvedId = await ctx.db.resolveJobId(jobId);
        } catch (err) {
          console.log(`  ${err instanceof Error ? err.message : String(err)}\n`);
          return;
        }
      }

      const events = await ctx.db.listEvents({
        jobId: resolvedId,
        type: type as never,
        limit: 200,
      });

      if (events.length === 0) {
        console.log("  No events found.\n");
        return;
      }

      if (json) {
        console.log(JSON.stringify(events, null, 2));
        return;
      }

      console.log(`  Event Log${resolvedId ? ` for job ${resolvedId}` : ""}\n`);
      console.log("  TIMESTAMP                 TYPE                            DETAILS");
      console.log("  ---------------------------------------------------------------------");
      for (const ev of events) {
        const ts = new Date(ev.createdAt).toISOString().replace("T", " ").slice(0, 19);
        const eventType = String(ev.type).padEnd(32).slice(0, 32);
        const payload = ev.payloadJson ? String(ev.payloadJson).slice(0, 60) : "";
        console.log(`  ${ts} ${eventType} ${payload}`);
      }
      console.log("");
    });
  },
};
