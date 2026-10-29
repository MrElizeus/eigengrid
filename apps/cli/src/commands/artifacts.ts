import type { CommandModule } from "yargs";
import { runWithContext, type ApplicationContext } from "../composition";

type ArtifactsArgs = {
  jobId: string;
  json?: boolean;
};

export const artifactsCommand: CommandModule = {
  command: "artifacts <job-id>",
  describe: "List artifacts for a job",
  builder: (y) =>
    y
      .positional("job-id", {
        describe: "Job ID (supports prefix)",
        type: "string",
        demandOption: true,
      })
      .option("json", { describe: "Output as JSON", type: "boolean", default: false }),
  async handler(args) {
    const { jobId, json } = args as unknown as ArtifactsArgs;

    try {
      await runWithContext(async (ctx: ApplicationContext) => {
        const { db } = ctx;

        let resolvedId: string;
        try {
          resolvedId = await db.resolveJobId(jobId);
        } catch (err) {
          console.log(`  ${err instanceof Error ? err.message : String(err)}\n`);
          return;
        }

        const artifacts = await db.listArtifacts(resolvedId);
        if (artifacts.length === 0) {
          console.log(`  No artifacts for job ${resolvedId}\n`);
          return;
        }

        if (json) {
          console.log(JSON.stringify(artifacts, null, 2));
          return;
        }

        // Table view
        console.log(`  Artifacts for job ${resolvedId}\n`);
        console.log("  KIND       LABEL                    SIZE          PATH");
        console.log("  ------------------------------------------------------------");
        for (const a of artifacts) {
          const kind = a.kind.padEnd(10);
          const label = (a.label ?? "").padEnd(24).slice(0, 24);
          const size = a.sizeBytes != null ? formatSize(a.sizeBytes).padStart(12) : " ".repeat(12);
          console.log(`  ${kind} ${label} ${size} ${a.path}`);
        }
        console.log("");
      });
    } catch (err) {
      console.log(`  ${err instanceof Error ? err.message : String(err)}\n`);
    }
  },
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
