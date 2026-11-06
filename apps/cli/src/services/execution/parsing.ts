import type { ParseResult } from "@eigengrid/core";
import { emitExecutionEvent, resolveJobAndAttempt } from "./context";
import { type ExecutionCoordinatorDeps, type ParseLocalOutcome } from "./contracts";

// ── parseJob — coordinator-owned ─────────────────────────
//
// Blocker 9: output artifact matched to exact attempt.
// Blocker 10: on retry, find existing result, don't rerun parser,
//   don't duplicate events, apply only missing transition.
//   For already-parsed, return actual existing result ID directly
//   from StoredResultRecord — no event scanning.

export async function parseJob(
  deps: ExecutionCoordinatorDeps,
  jobIdArg: string,
  attemptIdArg?: string,
): Promise<ParseLocalOutcome> {
  if (deps.allowLegacyExecution === false)
    return {
      ok: false,
      jobId: jobIdArg,
      message: "Legacy job parsing/state mutation is disabled in production",
    };
  const parser = deps.parser;
  if (!parser)
    return { ok: false, jobId: jobIdArg, message: "No parser bridge configured in coordinator" };

  const resolved = await resolveJobAndAttempt(deps, jobIdArg, attemptIdArg);
  if (!resolved.ok) return { ok: false, jobId: jobIdArg, message: resolved.message };

  const { job, resolvedId, attempt } = resolved;

  // Already parsed — return actual durable result ID from stored record
  if (job.status === "parsed") {
    const existingResult = await deps.db.getLatestResult(resolvedId, attempt.id);
    if (existingResult) {
      return {
        ok: true,
        jobId: resolvedId,
        attemptId: attempt.id,
        resultId: existingResult.id,
        parser: existingResult.parser,
        message: `Job ${resolvedId} is already parsed`,
      };
    }
    // Parsed but no result record — fall through to parse
  }

  // Only completed jobs can be parsed
  if (job.status !== "completed") {
    return {
      ok: false,
      jobId: resolvedId,
      attemptId: attempt.id,
      message: `Job ${resolvedId} is ${job.status}; must be completed to parse`,
    };
  }

  // Check for existing result (retry — blocker 10, no event scanning)
  const existingResults = await deps.db.listResults(resolvedId, attempt.id);
  if (existingResults.length > 0) {
    const lastResult = existingResults[existingResults.length - 1];

    // Result saved but state transition missing — apply it, don't reparse
    try {
      await deps.db.updateJobStatus(resolvedId, "parsed");
    } catch (error) {
      // The result is durable, but the lifecycle transition is authoritative
      // too.  Never report a completed parse while the job remains
      // `completed`; callers can retry and this path will not rerun the
      // parser or duplicate the result.
      return {
        ok: false,
        jobId: resolvedId,
        attemptId: attempt.id,
        message: `Result ${lastResult.id} is durable but parsed transition failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    await emitExecutionEvent(deps, "parse.completed", resolvedId, attempt.id, {
      parser: lastResult.parser,
      status: lastResult.status,
      resultId: lastResult.id,
    });
    return {
      ok: true,
      jobId: resolvedId,
      attemptId: attempt.id,
      resultId: lastResult.id,
      parser: lastResult.parser,
      message: "Completed missing transition",
    };
  }

  // Find output artifact matching exact attempt (blocker 9)
  const artifacts = await deps.db.listArtifacts(resolvedId);
  const outputArtifact = artifacts.find((a) => a.kind === "output" && a.attemptId === attempt.id);
  if (!outputArtifact) {
    return {
      ok: false,
      jobId: resolvedId,
      attemptId: attempt.id,
      message: `No output artifact found for attempt ${attempt.id}. Run collect first.`,
    };
  }

  const outputPath = outputArtifact.path;
  const software = job.software;

  // Emit parse.started
  await emitExecutionEvent(deps, "parse.started", resolvedId, attempt.id, { software, outputPath });

  // Run parser
  let parseResult: ParseResult;
  try {
    parseResult = await parser.parse(software, outputPath);
  } catch (err) {
    await emitExecutionEvent(deps, "parse.failed", resolvedId, attempt.id, {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      jobId: resolvedId,
      attemptId: attempt.id,
      message: `Parser threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!parseResult.ok || !parseResult.data) {
    await emitExecutionEvent(deps, "parse.failed", resolvedId, attempt.id, {
      error: parseResult.error?.message ?? "Parser returned no data",
    });
    return {
      ok: false,
      jobId: resolvedId,
      attemptId: attempt.id,
      message: parseResult.error?.message ?? "Parse failed",
    };
  }

  // Save result
  const data = parseResult.data as Record<string, unknown>;
  let resultId: string;
  try {
    resultId = await deps.db.saveResult({
      jobId: resolvedId,
      attemptId: attempt.id,
      parser: parseResult.parser ?? software,
      status: (parseResult.status as "completed" | "failed" | "partial" | "unknown") ?? "completed",
      energyHartree: data.energy_hartree != null ? Number(data.energy_hartree) : undefined,
      scfConverged: data.scf_converged != null ? Boolean(data.scf_converged) : undefined,
      imaginaryFrequencies:
        data.imaginary_frequencies != null ? Number(data.imaginary_frequencies) : undefined,
      normalTermination:
        data.normal_termination != null ? Boolean(data.normal_termination) : undefined,
      warnings: Array.isArray(data.warnings) ? (data.warnings as string[]) : [],
      errors: Array.isArray(data.errors) ? (data.errors as string[]) : [],
      raw: data,
    });
  } catch (err) {
    await emitExecutionEvent(deps, "parse.failed", resolvedId, attempt.id, {
      error: `Parse succeeded but result save failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return {
      ok: false,
      jobId: resolvedId,
      attemptId: attempt.id,
      message: `Parse succeeded but failed to save result: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Emit result.saved
  await emitExecutionEvent(deps, "result.saved", resolvedId, attempt.id, {
    resultId,
    parser: parseResult.parser ?? software,
    energy: data.energy_hartree,
  });

  // Transition completed→parsed AFTER persistence
  try {
    await deps.db.updateJobStatus(resolvedId, "parsed");
  } catch (error) {
    // Keep the durable result and make the missing transition explicit. A
    // successful-looking parse outcome here would contradict the DB state
    // and could cause a caller to release capacity or promote evidence.
    // Retry parseJob will find the existing result and only apply the
    // missing transition.
    return {
      ok: false,
      jobId: resolvedId,
      attemptId: attempt.id,
      resultId,
      parser: parseResult.parser ?? software,
      message: `Parse result ${resultId} is durable but parsed transition failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  // Emit parse.completed
  await emitExecutionEvent(deps, "parse.completed", resolvedId, attempt.id, {
    parser: parseResult.parser ?? software,
    status: parseResult.status,
    resultId,
  });

  return {
    ok: true,
    jobId: resolvedId,
    attemptId: attempt.id,
    resultId,
    parser: parseResult.parser ?? software,
    message: "Parse completed",
  };
}
