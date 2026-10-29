import type { CommandModule } from "yargs";
import { exportJob, exportDiagnostic } from "@eigengrid/backup";
import { runWithContext } from "../composition";

// ── Export command group ────────────────────────────────────

export const exportCommand: CommandModule = {
  command: "export <action>",
  describe: "Export operations (job bundles, diagnostics)",
  builder: (y) =>
    y
      .command(exportJobCommand)
      .command(exportDiagnosticCommand)
      .demandCommand(1, "Specify an action: job, diagnostic"),
  handler: () => {
    // handled by subcommands
  },
};

// ── export job ──────────────────────────────────────────────

type ExportJobArgs = {
  jobId: string;
  output?: string;
  includeArtifacts?: boolean;
};

const exportJobCommand: CommandModule = {
  command: "job <job-id>",
  describe: "Export a job into a portable bundle archive",
  builder: (y) =>
    y
      .positional("job-id", {
        describe: "Job ID (supports prefix)",
        type: "string",
        demandOption: true,
      })
      .option("output", {
        alias: "o",
        describe: "Output path for the export archive",
        type: "string",
      })
      .option("include-artifacts", {
        describe: "Include artifact files in the export",
        type: "boolean",
        default: false,
      }),
  async handler(args) {
    const { jobId, output, includeArtifacts } = args as unknown as ExportJobArgs;

    try {
      await runWithContext(async (ctx) => {
        console.log("  Exporting job...\n");
        const result = await exportJob(ctx.db, jobId, {
          outputPath: output,
          includeArtifacts: includeArtifacts ?? false,
        });

        console.log(`  ✓ Job export created: ${result.exportPath}`);
        console.log(`  Files archived: ${result.fileCount}`);
        console.log(`  Size: ${formatSize(result.totalSizeBytes)}\n`);
      });
    } catch (err) {
      console.error(`  ✗ Export failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  },
};

// ── export diagnostic ───────────────────────────────────────

type ExportDiagnosticArgs = {
  jobId: string;
  output?: string;
};

const exportDiagnosticCommand: CommandModule = {
  command: "diagnostic <job-id>",
  describe: "Export a diagnostic bundle for a job",
  builder: (y) =>
    y
      .positional("job-id", {
        describe: "Job ID (supports prefix)",
        type: "string",
        demandOption: true,
      })
      .option("output", {
        alias: "o",
        describe: "Output path for the diagnostic archive",
        type: "string",
      }),
  async handler(args) {
    const { jobId, output } = args as unknown as ExportDiagnosticArgs;

    try {
      await runWithContext(async (ctx) => {
        console.log("  Exporting diagnostic bundle...\n");
        const result = await exportDiagnostic(ctx.db, jobId, {
          outputPath: output,
        });

        console.log(`  ✓ Diagnostic export created: ${result.exportPath}`);
        console.log(`  Files archived: ${result.fileCount}`);
        console.log(`  Size: ${formatSize(result.totalSizeBytes)}\n`);
      });
    } catch (err) {
      console.error(`  ✗ Export failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  },
};

// ── Helper ──────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
