import type { CommandModule } from "yargs";
import { runWithContext, type ApplicationContext } from "../composition";

type ShowArgs = {
  jobId: string;
  json?: boolean;
};

export const showCommand: CommandModule = {
  command: "show <job-id>",
  describe: "Show detailed job information",
  builder: (y) =>
    y
      .positional("job-id", {
        describe: "Job ID (supports prefix)",
        type: "string",
        demandOption: true,
      })
      .option("json", {
        describe: "Output as JSON",
        type: "boolean",
        default: false,
      }),
  async handler(args) {
    const { jobId, json } = args as unknown as ShowArgs;

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

        const job = await db.getJob(resolvedId);
        if (!job) {
          console.log(`  Job not found: ${resolvedId}\n`);
          return;
        }

        const attempts = await db.listJobAttempts(resolvedId);
        const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;

        const result = latestAttempt
          ? await db.getLatestResult(resolvedId, latestAttempt.id)
          : null;

        const artifacts = await db.listArtifacts(resolvedId);

        const events = await db.getEvents(resolvedId);
        const recentEvents = events.slice(-10);

        if (json) {
          console.log(
            JSON.stringify(
              {
                job,
                latestAttempt,
                result,
                artifacts,
                events: recentEvents,
              },
              null,
              2,
            ),
          );
          return;
        }

        // ── Human-readable output ────────────────────────────────
        console.log(`\n  Job: ${resolvedId}\n`);

        console.log(`  ID:          ${resolvedId}`);
        console.log(`  Name:        ${job.name}`);
        console.log(`  Software:    ${job.software}`);
        console.log(`  Input:       ${job.inputPath}`);
        console.log(`  Output:      ${job.outputPath ?? "-"}`);
        console.log(`  Workdir:     ${job.workdir}`);
        console.log(`  Status:      ${job.status}`);
        console.log(
          `  Created:     ${job.createdAt ? new Date(job.createdAt).toISOString() : "-"}`,
        );
        console.log(
          `  Updated:     ${job.updatedAt ? new Date(job.updatedAt).toISOString() : "-"}`,
        );

        // Latest attempt
        if (latestAttempt) {
          console.log("");
          console.log("  Latest Attempt:");
          console.log(`  Attempt ID:  ${latestAttempt.id}`);
          console.log(`  Runner:      ${latestAttempt.runner}`);
          console.log(`  Status:      ${latestAttempt.status}`);
          console.log(`  Command:     ${latestAttempt.command}`);
          console.log(`  CWD:         ${latestAttempt.cwd}`);
          if (latestAttempt.pid != null) console.log(`  PID:         ${latestAttempt.pid}`);
          if (latestAttempt.exitCode != null)
            console.log(`  Exit code:   ${latestAttempt.exitCode}`);
          if (latestAttempt.startedAt != null)
            console.log(
              `  Started:     ${new Date(Number(latestAttempt.startedAt)).toISOString()}`,
            );
          if (latestAttempt.finishedAt != null)
            console.log(
              `  Finished:    ${new Date(Number(latestAttempt.finishedAt)).toISOString()}`,
            );
        }

        // Parse result
        if (result) {
          console.log("");
          console.log("  Parse Result:");
          console.log(`  Parser:      ${result.parser}`);
          console.log(`  Status:      ${result.status}`);
          if (result.energyHartree != null) {
            console.log(`  Energy:      ${result.energyHartree} Hartree`);
          }
          if (result.scfConverged != null) {
            console.log(`  SCF:         ${result.scfConverged ? "converged" : "not converged"}`);
          }
          if (result.normalTermination != null) {
            console.log(`  Term:        ${result.normalTermination ? "normal" : "abnormal"}`);
          }
          if (result.imaginaryFrequencies != null) {
            console.log(`  ImagFreq:    ${result.imaginaryFrequencies}`);
          }
          if (result.warnings && result.warnings.length > 0) {
            console.log(`  Warnings:    ${result.warnings.join(", ")}`);
          }
          if (result.errors && result.errors.length > 0) {
            console.log(`  Errors:      ${result.errors.join(", ")}`);
          }
        }

        // Artifacts
        if (artifacts.length > 0) {
          console.log("");
          console.log("  Artifacts:");
          for (const a of artifacts) {
            const label = a.label ?? a.path;
            const size = a.sizeBytes != null ? ` (${a.sizeBytes} B)` : "";
            console.log(`    ${a.kind}: ${label}${size}`);
          }
        }

        // Recent events
        if (recentEvents.length > 0) {
          console.log("");
          console.log("  Recent Events:");
          for (const ev of recentEvents) {
            const ts = ev.createdAt
              ? new Date(ev.createdAt).toISOString().replace("T", " ").slice(0, 19)
              : "?";
            const type = String(ev.type ?? "?");
            const payload = ev.payloadJson ? ` ${String(ev.payloadJson).slice(0, 80)}` : "";
            console.log(`    ${ts}  ${type}${payload}`);
          }
        }

        console.log("");
      });
    } catch (err) {
      console.log(`  ${err instanceof Error ? err.message : String(err)}\n`);
    }
  },
};
