import type { CommandModule } from "yargs";
import type { DatabaseLike } from "@eigengrid/db";
import {
  SqliteProposalStore,
  makeDiagnosisStartedEvent,
  makeDiagnosisCompletedEvent,
  makeDecisionProposedEvent,
} from "@eigengrid/agent";
import { runWithContext } from "../composition";

// ────────────────────────────────────────────────────────────
// Types (exported for testing)
// ────────────────────────────────────────────────────────────

export interface DiagnosisFacts {
  jobId: string;
  jobStatus: string | null;
  exitCode: number | null;
  parserStatus: string | null;
  parserErrors: string[];
  parserWarnings: string[];
  energyHartree: string | null;
  scfConverged: boolean | null;
  normalTermination: boolean | null;
  imaginaryFrequencies: number | null;
  hasLogs: boolean;
  hasArtifacts: boolean;
  hasResult: boolean;
}

export interface DiagnosisInterpretation {
  likelyCause: string;
  confidence: "low" | "medium" | "high";
  reasoning: string;
}

export interface DiagnosisRecommendation {
  action: string;
  requiresApproval: boolean;
  reason: string;
  proposedChanges: string;
}

export interface Diagnosis {
  facts: DiagnosisFacts;
  interpretation: DiagnosisInterpretation;
  recommendations: DiagnosisRecommendation[];
}

// ────────────────────────────────────────────────────────────
// Arg types
// ────────────────────────────────────────────────────────────

type DiagnoseArgs = {
  jobId: string;
  json?: boolean;
  "dry-run"?: boolean;
  "propose-retry"?: boolean;
};

// ────────────────────────────────────────────────────────────
// Command
// ────────────────────────────────────────────────────────────

export const diagnoseCommand: CommandModule = {
  command: "agent diagnose <job-id>",
  describe: "Diagnose a failed or completed job and propose retry actions",
  builder: (y) =>
    y
      .positional("job-id", {
        describe: "Job ID (supports prefix)",
        type: "string",
        demandOption: true,
      })
      .option("json", {
        type: "boolean",
        describe: "Output diagnosis as JSON",
        default: false,
      })
      .option("dry-run", {
        type: "boolean",
        describe: "Block mutation tools (submit, cancel, parse)",
        default: false,
      })
      .option("propose-retry", {
        type: "boolean",
        describe: "Generate a retry proposal without executing it",
        default: false,
      }),
  async handler(argv) {
    const args = argv as unknown as DiagnoseArgs;
    await runWithContext(async ({ db }) => runDiagnose(db, args));
  },
};

// ────────────────────────────────────────────────────────────
// Core logic
// ────────────────────────────────────────────────────────────

async function runDiagnose(db: DatabaseLike, args: DiagnoseArgs): Promise<void> {
  const resolvedId = await db.resolveJobId(args.jobId);

  // ── Emit diagnosis started event ──────────────────────────
  await db.appendEvent(makeDiagnosisStartedEvent(resolvedId, { dryRun: args["dry-run"] }));

  // ── 1. Gather facts ──────────────────────────────────────
  const job = await db.getJob(resolvedId);
  const attempts = await db.listJobAttempts(resolvedId);
  const artifacts = await db.listArtifacts(resolvedId);
  const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;

  // Get latest result if any
  const result = latestAttempt ? await db.getLatestResult(resolvedId, latestAttempt.id) : null;

  // Check if logs exist
  let hasLogs = false;
  try {
    const logs = await db.getLogs(resolvedId, undefined, 1);
    hasLogs = logs.length > 0;
  } catch {
    hasLogs = false;
  }

  const facts: DiagnosisFacts = {
    jobId: resolvedId,
    jobStatus: job ? String(job.status ?? "") : null,
    exitCode: latestAttempt?.exitCode ?? null,
    parserStatus: result ? String(result.status ?? "") : null,
    parserErrors: result?.errors ?? [],
    parserWarnings: result?.warnings ?? [],
    energyHartree: result?.energyHartree != null ? String(result.energyHartree) : null,
    scfConverged: result?.scfConverged ?? null,
    normalTermination: result?.normalTermination ?? null,
    imaginaryFrequencies: result?.imaginaryFrequencies ?? null,
    hasLogs,
    hasArtifacts: artifacts.length > 0,
    hasResult: result !== null,
  };

  // ── 2. Build interpretation ──────────────────────────────
  const interpretation = buildInterpretation(facts);

  // ── 3. Build recommendations ─────────────────────────────
  const recommendations = buildRecommendations(facts, args["dry-run"] ?? false);

  // ── 4. Assemble diagnosis ────────────────────────────────
  const diagnosis: Diagnosis = {
    facts,
    interpretation,
    recommendations,
  };

  // ── 5. Emit diagnosis completed event ────────────────────
  await db.appendEvent(
    makeDiagnosisCompletedEvent(resolvedId, {
      hasRecommendations: recommendations.length > 0,
    }),
  );

  // ── 6. Optionally create proposals ───────────────────────
  if (args["propose-retry"] && recommendations.length > 0) {
    const store = new SqliteProposalStore(db);
    for (const rec of recommendations) {
      if (rec.requiresApproval) {
        const proposalId = await store.create({
          jobId: resolvedId,
          action: rec.action,
          reason: rec.reason,
          proposedChanges: rec.proposedChanges,
          diagnosis: diagnosis as unknown as Record<string, unknown>,
        });

        await db.appendEvent(
          makeDecisionProposedEvent(resolvedId, proposalId, {
            action: rec.action,
          }),
        );
      }
    }
    // Reload proposals list for output
    const proposals = await store.list({ jobId: resolvedId, status: "pending" });
    if (proposals.length > 0 && !args.json) {
      console.log(
        `\n  Created ${proposals.length} retry proposal(s) — use \`eigengrid agent approve <proposal-id>\` to review.\n`,
      );
    }
  }

  // ── 7. Output ────────────────────────────────────────────
  if (args.json) {
    console.log(JSON.stringify(diagnosis, null, 2));
  } else {
    printDiagnosis(diagnosis);
  }
}

// ────────────────────────────────────────────────────────────
// Interpretation builder (exported for testing)
// ────────────────────────────────────────────────────────────

export function buildInterpretation(facts: DiagnosisFacts): DiagnosisInterpretation {
  // SEPARATE parser facts from agent interpretation
  // If insufficient evidence, say so

  if (!facts.jobStatus) {
    return {
      likelyCause: "insufficient evidence",
      confidence: "low",
      reasoning: "Job not found in database. Cannot determine cause without a valid job record.",
    };
  }

  // Job never ran
  if (facts.jobStatus === "created" || facts.jobStatus === "queued") {
    return {
      likelyCause: "job not yet executed",
      confidence: "high",
      reasoning: `Job is in '${facts.jobStatus}' status and has not been dispatched to a runner. No exit code or logs available.`,
    };
  }

  // Job was cancelled
  if (facts.jobStatus === "cancelled") {
    return {
      likelyCause: "job was cancelled",
      confidence: "high",
      reasoning:
        "Job was explicitly cancelled. No retry needed unless the cancellation was unintended.",
    };
  }

  // Check exit code first (low-level failure)
  if (facts.exitCode != null && facts.exitCode !== 0) {
    let cause: string;
    let confidence: "low" | "medium" | "high" = "medium";

    if (facts.exitCode === 134) {
      cause = "process aborted (SIGABRT) — likely memory corruption or assertion failure";
      confidence = "high";
    } else if (facts.exitCode === 139) {
      cause = "segmentation fault (SIGSEGV) — likely memory issue or software bug";
      confidence = "high";
    } else if (facts.exitCode === 137) {
      cause = "process killed (SIGKILL) — likely OOM kill by kernel";
      confidence = "high";
    } else if (facts.exitCode === -1) {
      cause = "process terminated by signal or runner error";
      confidence = "medium";
    } else {
      cause = `process exited with code ${facts.exitCode}`;
      confidence = "medium";
    }

    return {
      likelyCause: cause,
      confidence,
      reasoning: `Exit code ${facts.exitCode} indicates a runtime failure. ${
        facts.hasLogs
          ? "Check logs for detailed error messages."
          : "No logs available — consider checking system resources."
      } ${
        facts.hasResult
          ? `Parser status: ${facts.parserStatus ?? "unknown"}.`
          : "No parser result was saved."
      }`,
    };
  }

  // Check parser status
  if (facts.hasResult && facts.parserStatus === "failed") {
    const errorSummary =
      facts.parserErrors.length > 0
        ? `Parser errors: ${facts.parserErrors.slice(0, 3).join("; ")}`
        : "Parser reported failure without specific errors.";

    return {
      likelyCause: "parser reported failure",
      confidence: "medium",
      reasoning: `Job completed execution (exit code ${facts.exitCode ?? "N/A"}) but the parser reported failure. ${errorSummary}`,
    };
  }

  // Check for SCF convergence issues
  if (facts.hasResult && facts.scfConverged === false) {
    return {
      likelyCause: "SCF did not converge",
      confidence: "high",
      reasoning:
        "The SCF procedure failed to converge. This is a common issue in computational chemistry that can often be resolved by adjusting convergence criteria or using a different initial guess.",
    };
  }

  // Check imaginary frequencies
  if (facts.imaginaryFrequencies != null && facts.imaginaryFrequencies > 0) {
    return {
      likelyCause: `structure has ${facts.imaginaryFrequencies} imaginary frequency/ies`,
      confidence: "high",
      reasoning: `The optimized structure has ${facts.imaginaryFrequencies} imaginary frequency/ies, indicating it may be a transition state rather than a local minimum.`,
    };
  }

  // Job completed successfully
  if (facts.jobStatus === "completed" || facts.jobStatus === "parsed") {
    if (facts.parserErrors.length === 0) {
      return {
        likelyCause: "no issues detected",
        confidence: "high",
        reasoning: "Job completed successfully with no parser errors. No retry needed.",
      };
    }
    return {
      likelyCause: "completed with parser warnings",
      confidence: "medium",
      reasoning: `Job completed but the parser reported ${facts.parserWarnings.length} warning(s). Review warnings to determine if retry is needed.`,
    };
  }

  // Running — not actionable
  if (facts.jobStatus === "running" || facts.jobStatus === "staged") {
    return {
      likelyCause: "job still in progress",
      confidence: "high",
      reasoning: `Job is in '${facts.jobStatus}' status. Wait for completion before diagnosing.`,
    };
  }

  // Fallback
  return {
    likelyCause: "insufficient evidence",
    confidence: "low",
    reasoning: `Job status is '${facts.jobStatus}'. Insufficient data to determine the cause. ${
      !facts.hasLogs ? "No logs available. " : ""
    }${!facts.hasResult ? "No parser result saved. " : ""}`,
  };
}

// ────────────────────────────────────────────────────────────
// Recommendations builder (exported for testing)
// ────────────────────────────────────────────────────────────

export function buildRecommendations(
  facts: DiagnosisFacts,
  dryRun: boolean,
): DiagnosisRecommendation[] {
  const recs: DiagnosisRecommendation[] = [];

  // Helper to add a recommendation
  function add(action: string, reason: string, changes: string, requiresApproval = true) {
    recs.push({ action, requiresApproval, reason, proposedChanges: changes });
  }

  // No job found
  if (!facts.jobStatus) {
    return [];
  }

  // Cancelled — no action unless unintended
  if (facts.jobStatus === "cancelled") {
    add(
      "no-action",
      "Job was cancelled — no automatic retry recommended.",
      "Review why cancellation was triggered.",
      false,
    );
    return recs;
  }

  // Running / queued / staged
  if (["created", "queued", "staged", "running"].includes(facts.jobStatus)) {
    add(
      "wait",
      `Job is in '${facts.jobStatus}' status — wait for completion.`,
      "Run diagnosis again after job finishes.",
      false,
    );
    return recs;
  }

  // ── Mutating recommendations (require approval unless dry-run blocks them) ──

  if (dryRun) {
    add(
      "blocked-by-dry-run",
      "Dry-run mode is active. Mutating actions are blocked.",
      "Re-run without --dry-run to enable retry proposals.",
      false,
    );
    return recs;
  }

  // Completed successfully — no retry needed (unless parser failed)
  if (
    (facts.jobStatus === "completed" || facts.jobStatus === "parsed") &&
    facts.parserErrors.length === 0 &&
    facts.scfConverged !== false &&
    facts.parserStatus !== "failed"
  ) {
    add(
      "no-action",
      "Job completed successfully — no retry needed.",
      "Continue with analysis or submit new jobs.",
      false,
    );

    // Still add informational recommendations (e.g., imaginary frequencies)
    if (facts.imaginaryFrequencies != null && facts.imaginaryFrequencies > 0) {
      add(
        "inspect-structure",
        `Structure has ${facts.imaginaryFrequencies} imaginary frequency/ies — may need geometry adjustment.`,
        "Review the geometry and consider running a frequency calculation or adjusting the initial structure.",
        false,
      );
    }

    return recs;
  }

  // SCF convergence failure — retry with tighter criteria
  if (facts.scfConverged === false) {
    add(
      "retry-with-tighter-scf",
      "SCF did not converge — retry with adjusted convergence criteria.",
      "Re-submit job with SCF=tight or increased max cycles in the input file.",
    );
  }

  // Process crashed
  if (facts.exitCode != null && facts.exitCode !== 0 && facts.exitCode !== -1) {
    add(
      "retry-job",
      `Process exited with code ${facts.exitCode} — retry the job.`,
      `Re-submit job ${facts.jobId} with the same input. If the failure persists, check system resources and input validity.`,
    );
  }

  // Parser failure
  if (facts.hasResult && facts.parserStatus === "failed") {
    add(
      "reparse-job",
      "Parser failed to process the output — retry parsing.",
      `Re-run parser on job ${facts.jobId}. The output file may be malformed or incomplete.`,
    );
  }

  // Imaginary frequencies (informational, not a failure)
  if (facts.imaginaryFrequencies != null && facts.imaginaryFrequencies > 0) {
    add(
      "inspect-structure",
      `Structure has ${facts.imaginaryFrequencies} imaginary frequency/ies — may need geometry adjustment.`,
      "Review the geometry and consider running a frequency calculation or adjusting the initial structure.",
      false,
    );
  }

  // Generic retry for failed jobs
  if (facts.jobStatus === "failed" && recs.length === 0) {
    add(
      "retry-job",
      "Job failed — retry with the same input.",
      `Re-submit job ${facts.jobId}. Consider checking input validity and available resources.`,
    );
  }

  return recs;
}

// ────────────────────────────────────────────────────────────
// Output formatters
// ────────────────────────────────────────────────────────────

function printDiagnosis(diagnosis: Diagnosis): void {
  const { facts, interpretation, recommendations } = diagnosis;

  console.log("");
  console.log("  Agent Diagnosis");
  console.log("  " + "=".repeat(60));
  console.log(`  Job: ${facts.jobId}`);
  console.log("");

  // ── Facts section ──────────────────────────────────────
  console.log("  ┌─ Facts");
  console.log(`  │  Status:         ${facts.jobStatus ?? "N/A"}`);
  console.log(`  │  Exit code:      ${facts.exitCode != null ? facts.exitCode : "N/A"}`);
  console.log(`  │  Parser status:  ${facts.parserStatus ?? "N/A"}`);
  console.log(
    `  │  SCF converged:  ${facts.scfConverged != null ? (facts.scfConverged ? "yes" : "no") : "N/A"}`,
  );
  console.log(
    `  │  Im. freq.:      ${facts.imaginaryFrequencies != null ? facts.imaginaryFrequencies : "N/A"}`,
  );
  console.log(
    `  │  Normal term.:   ${facts.normalTermination != null ? (facts.normalTermination ? "yes" : "no") : "N/A"}`,
  );
  console.log(`  │  Logs:           ${facts.hasLogs ? "available" : "none"}`);
  console.log(
    `  │  Artifacts:      ${facts.hasArtifacts ? facts.hasArtifacts + " file(s)" : "none"}`,
  );
  console.log(`  │  Parse result:   ${facts.hasResult ? "found" : "none"}`);
  if (facts.parserErrors.length > 0) {
    console.log(`  │  Errors:`);
    for (const e of facts.parserErrors.slice(0, 5)) {
      console.log(`  │    • ${e.slice(0, 120)}`);
    }
  }
  console.log("  └" + "─".repeat(40));
  console.log("");

  // ── Interpretation section ──────────────────────────────
  console.log("  ┌─ Interpretation");
  console.log(`  │  Cause:     ${interpretation.likelyCause}`);
  console.log(`  │  Confidence: ${interpretation.confidence}`);
  console.log(`  │  Reasoning:  ${interpretation.reasoning}`);
  console.log("  └" + "─".repeat(40));
  console.log("");

  // ── Recommendations section ────────────────────────────
  if (recommendations.length > 0) {
    console.log("  ┌─ Recommendations");
    for (const rec of recommendations) {
      const badge = rec.requiresApproval ? " [requires approval]" : "";
      console.log(`  │`);
      console.log(`  │  • ${rec.action}${badge}`);
      console.log(`  │    ${rec.reason}`);
    }
    console.log("  └" + "─".repeat(40));
    console.log("");
  } else {
    console.log("  No recommendations.\n");
  }
}
