import type { RunnerResult, StartedProcess } from "@eigengrid/core";
import type { Recipe, RecipeRunnerKind } from "@eigengrid/recipes";
import { findRunnableRecipe, renderRecipePlan, validateRecipe } from "@eigengrid/recipes";
import { validateSubmissionInput } from "../submit-service";
import { emitExecutionEvent, failJobAndAttempt, jobFromDb } from "./context";
import {
  type ExecutionCoordinatorDeps,
  type LocalExecutionOutcome,
  type LocalExecutionRequest,
} from "./contracts";
import { reconcileLocal } from "./local-lifecycle";
import { buildLocalExecutionPlanInternal } from "./local-plan";
import { verifyStagedInput } from "./staged-input";

export async function executeLocal(
  deps: ExecutionCoordinatorDeps,
  request: LocalExecutionRequest,
): Promise<LocalExecutionOutcome> {
  if (deps.allowLegacyExecution === false)
    return { ok: false, message: "Local scientific execution is disabled in production" };
  if ((request.intendedJobId === undefined) !== (request.intendedAttemptId === undefined)) {
    return {
      ok: false,
      message: "intendedJobId and intendedAttemptId must be supplied together",
    };
  }
  for (const [label, id] of [
    ["intendedJobId", request.intendedJobId],
    ["intendedAttemptId", request.intendedAttemptId],
  ] as const) {
    if (id !== undefined && !/^[A-Za-z0-9._-]{1,128}$/u.test(id)) {
      return { ok: false, message: `${label} is not a safe stable identifier` };
    }
  }

  const inputValidation = validateSubmissionInput(request.inputPath);
  if (!inputValidation.ok) return { ok: false, message: inputValidation.message };
  const canonicalPath = inputValidation.canonicalPath;

  const runKind: RecipeRunnerKind = "local";
  const allRecipes: readonly Recipe[] = deps.recipes.recipes;

  let selectedRecipe: Recipe | undefined;
  if (request.recipeId) {
    selectedRecipe = deps.recipes.find(request.recipeId);
    if (!selectedRecipe) return { ok: false, message: `Recipe "${request.recipeId}" not found` };
    const runnable = findRunnableRecipe(
      [...allRecipes],
      request.software,
      runKind,
      "",
      request.recipeId,
    );
    if (!runnable)
      return {
        ok: false,
        message: `Recipe "${request.recipeId}" is for ${selectedRecipe.software}, not ${request.software}`,
      };
  } else {
    selectedRecipe = findRunnableRecipe([...allRecipes], request.software, runKind, "");
  }
  if (!selectedRecipe) return { ok: false, message: `No recipe found for ${request.software}` };
  const recipeValidation = validateRecipe(selectedRecipe);
  if (!recipeValidation.valid) {
    return {
      ok: false,
      message: `Recipe "${selectedRecipe.id}" validation failed: ${recipeValidation.errors.join("; ")}`,
    };
  }

  const jobId = request.intendedJobId ?? deps.idGenerator("job");
  const attemptId = request.intendedAttemptId ?? deps.idGenerator("attempt");
  const { plan: executionPlan, recipePlan } = buildLocalExecutionPlanInternal(
    selectedRecipe,
    canonicalPath,
    jobId,
    deps.config.jobsDir,
    runKind,
  );

  const existingJob = await deps.db.getJob(jobId);
  if (existingJob) {
    if (
      existingJob.software !== request.software ||
      existingJob.inputPath !== canonicalPath ||
      existingJob.workdir !== deps.config.jobsDir
    ) {
      return {
        ok: false,
        jobId,
        attemptId,
        message: `Stable job identity ${jobId} is already bound to different execution content`,
      };
    }
    const attempts = await deps.db.listJobAttempts(jobId);
    const intendedAttempt = attempts.find((attempt) => attempt.id === attemptId);
    if (intendedAttempt) {
      const reconciliation = await reconcileLocal(deps, jobId, attemptId);
      if (reconciliation.status === "safely-unknown") {
        return {
          ok: false,
          jobId,
          attemptId,
          message: `Stable execution ${jobId}/${attemptId} requires reconciliation: ${reconciliation.message}`,
        };
      }
      return {
        ok: true,
        jobId,
        attemptId,
        ...(intendedAttempt.pid ? { pid: intendedAttempt.pid } : {}),
        replayed: true,
        status: reconciliation.status,
      };
    }
    if (attempts.length > 0 || existingJob.status !== "created") {
      return {
        ok: false,
        jobId,
        attemptId,
        message: `Stable job identity ${jobId} exists without the intended attempt; refusing replay`,
      };
    }
  } else {
    await deps.db.createJob({
      id: jobId,
      name: request.name ?? canonicalPath,
      software: request.software,
      inputPath: canonicalPath,
      outputPath: recipePlan.outputName,
      workdir: deps.config.jobsDir,
      projectId: request.projectId,
    });
    await emitExecutionEvent(deps, "job.created", jobId, undefined, {
      software: request.software,
      inputPath: canonicalPath,
      runner: "local",
    });
  }
  await emitExecutionEvent(deps, "recipe.selected", jobId, undefined, {
    recipeId: selectedRecipe.id,
    command: recipePlan.command.display,
    resources: selectedRecipe.resources,
  });

  await deps.db.createJobAttempt({
    id: attemptId,
    jobId,
    runner: "local",
    command: executionPlan.displayCommand ?? recipePlan.command.display,
    cwd: `${deps.config.jobsDir}/${jobId}`,
    status: "created",
  });
  // attempt.created is emitted by the DB adapter's createJobAttempt

  const backend = deps.localBackendFactory(executionPlan, deps.db, deps.executor);

  let stageResult: RunnerResult;
  try {
    stageResult = await backend.stageAttempt(executionPlan.job, attemptId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stage threw unexpectedly";
    const failure = await failJobAndAttempt(deps, jobId, attemptId, message);
    if (!failure.ok) {
      return {
        ok: false,
        jobId,
        attemptId,
        status: "safely-unknown",
        message: `${message}; ${failure.message}`,
      };
    }
    return { ok: false, jobId, attemptId, message };
  }
  if (!stageResult.ok) {
    const message = stageResult.message ?? "Stage failed";
    if (stageResult.failureDisposition === "termination-unknown") {
      return { ok: false, jobId, attemptId, status: "safely-unknown", message };
    }
    const failure = await failJobAndAttempt(deps, jobId, attemptId, message);
    if (!failure.ok) {
      return {
        ok: false,
        jobId,
        attemptId,
        status: "safely-unknown",
        message: `${message}; ${failure.message}`,
      };
    }
    return { ok: false, jobId, attemptId, message: stageResult.message ?? "Stage failed" };
  }
  if (request.expectedInputDigest !== undefined) {
    const verification = await verifyStagedInput(
      stageResult,
      request.expectedInputDigest,
      executionPlan.job,
    );
    if (!verification.ok) {
      const failure = await failJobAndAttempt(deps, jobId, attemptId, verification.message);
      if (!failure.ok) {
        return {
          ok: false,
          jobId,
          attemptId,
          status: "safely-unknown",
          message: `${verification.message}; ${failure.message}`,
        };
      }
      return { ok: false, jobId, attemptId, message: verification.message };
    }
  }

  let startResult: StartedProcess;
  try {
    startResult = await backend.startAttempt(executionPlan.job, attemptId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Start threw unexpectedly";
    // An unexpected start exception may be post-spawn. Without a typed
    // terminal confirmation, failing the DB could release live capacity.
    return { ok: false, jobId, attemptId, status: "safely-unknown", message };
  }
  if (!startResult.ok) {
    return {
      ok: false,
      jobId,
      attemptId,
      ...(startResult.failureDisposition === "termination-unknown"
        ? { status: "safely-unknown" as const }
        : {}),
      message: startResult.message ?? "Start failed",
    };
  }

  return { ok: true, jobId, attemptId, pid: startResult.pid, command: startResult.command };
}

// ── dispatchExistingJob — for scheduler-dispatched jobs ──
//
// Takes a job and attempt that were already persisted atomically
// by the scheduler's claim operation. Builds the execution plan
// from the job's persisted state, selects the recipe, stages
// and starts. Preserves attempt-before-effects and
// confirmed-start-only running semantics.
//
// On synchronous failure, leaves failed state in DB and reconciles
// the reservation. On success, returns durable job/attempt/pid.

export async function dispatchExistingJob(
  deps: ExecutionCoordinatorDeps,
  jobId: string,
  attemptId: string,
): Promise<LocalExecutionOutcome> {
  if (deps.allowLegacyExecution === false)
    return {
      ok: false,
      jobId,
      attemptId,
      message: "Legacy existing-job dispatch is disabled in production",
    };
  // Helper to release dispatch on failure
  const release = async (
    msg: string,
  ): Promise<{ ok: false; jobId: string; attemptId: string; message: string }> => {
    await deps.db.releaseJobDispatch(jobId, attemptId, msg);
    return { ok: false, jobId, attemptId, message: msg };
  };

  // 1. Resolve job from DB
  const raw = await deps.db.getJob(jobId);
  if (!raw) return await release(`Job ${jobId} not found`);
  const job = jobFromDb(deps, raw);
  const software = typeof job.software === "string" ? job.software : String(job.software ?? "");
  const inputPath = job.inputPath;

  // 2. Resolve attempt
  const attempts = await deps.db.listJobAttempts(jobId);
  const attempt = attempts.find((a) => a.id === attemptId);
  if (!attempt) return await release(`Attempt ${attemptId} not found for job ${jobId}`);
  if (attempt.status !== "created") {
    return await release(`Attempt ${attemptId} has status "${attempt.status}", expected "created"`);
  }

  // 3. Find recipe for job's software
  const runKind: RecipeRunnerKind = "local";
  const allRecipes: readonly Recipe[] = deps.recipes.recipes;
  const selectedRecipe = findRunnableRecipe([...allRecipes], software, runKind, "");
  if (!selectedRecipe) return await release(`No recipe found for ${software}`);
  const recipeValidation = validateRecipe(selectedRecipe);
  if (!recipeValidation.valid) {
    return await release(
      `Recipe "${selectedRecipe.id}" validation failed: ${recipeValidation.errors.join("; ")}`,
    );
  }

  // 4. Render recipe plan from persisted job state
  const recipePlan = renderRecipePlan(selectedRecipe, inputPath, jobId, job.workdir, runKind);
  const plan: import("../submit-service").LocalExecutionPlan = {
    command: recipePlan.command.display,
    program: recipePlan.command.program,
    args: recipePlan.command.args,
    displayCommand: recipePlan.command.display,
    job,
  };

  // 5. Emit recipe.selected — recipe choice is part of dispatch
  await emitExecutionEvent(deps, "recipe.selected", jobId, attemptId, {
    recipeId: selectedRecipe.id,
    command: recipePlan.command.display,
    resources: selectedRecipe.resources,
  });

  // 6. Build backend and stage (attempt-before-effects: attempt already exists)
  const backend = deps.localBackendFactory(plan, deps.db, deps.executor);

  let stageResult: RunnerResult;
  try {
    stageResult = await backend.stageAttempt(job, attemptId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stage threw unexpectedly";
    await deps.db.releaseJobDispatch(jobId, attemptId, message);
    return { ok: false, jobId, attemptId, message };
  }
  if (!stageResult.ok) {
    if (stageResult.failureDisposition === "termination-unknown") {
      return {
        ok: false,
        jobId,
        attemptId,
        status: "safely-unknown",
        message: stageResult.message ?? "Stage termination is safely-unknown",
      };
    }
    await deps.db.releaseJobDispatch(jobId, attemptId, stageResult.message ?? "Stage failed");
    return { ok: false, jobId, attemptId, message: stageResult.message ?? "Stage failed" };
  }

  // 7. Start (confirmed-start-only running)
  let startResult: StartedProcess;
  try {
    startResult = await backend.startAttempt(job, attemptId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Start threw unexpectedly";
    // Same fail-closed boundary as executeLocal: a thrown start has no typed
    // proof that a spawned supervisor/process tree is dead.
    return { ok: false, jobId, attemptId, status: "safely-unknown", message };
  }
  if (!startResult.ok) {
    if (startResult.failureDisposition === "termination-unknown") {
      return {
        ok: false,
        jobId,
        attemptId,
        status: "safely-unknown",
        message: startResult.message ?? "Start termination is safely-unknown",
      };
    }
    await deps.db.releaseJobDispatch(jobId, attemptId, startResult.message ?? "Start failed");
    return { ok: false, jobId, attemptId, message: startResult.message ?? "Start failed" };
  }

  return { ok: true, jobId, attemptId, pid: startResult.pid, command: startResult.command };
}
