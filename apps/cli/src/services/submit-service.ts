import type { Config, Job, StartedProcess } from "@eigengrid/core";
import { generateId } from "@eigengrid/core";
import type { CommandExecutor, Runner } from "@eigengrid/runners";
import {
  loadBuiltinRecipes,
  findRunnableRecipe,
  renderRecipePlan,
  validateRecipe,
  type Recipe,
  type RecipeRunnerKind,
  type RenderedRecipePlan,
} from "@eigengrid/recipes";
import type { DatabaseLike } from "@eigengrid/db";
import { realpathSync, statSync } from "fs";

export { renderTemplate } from "@eigengrid/recipes";

export interface SubmitJobInput {
  software: string;
  inputPath: string;
  name?: string;
  runner?: "local" | "ssh" | "slurm";
  nodeId?: string;
  recipe?: string;
  projectId?: string;
  backend?: string;
}

export interface SubmitJobResult {
  ok: boolean;
  jobId?: string;
  message?: string;
}

export interface LocalExecutionPlan {
  command: string;
  program: string;
  args: string[];
  displayCommand?: string;
  job: Job;
}

export type RunnerFactory = (
  plan: LocalExecutionPlan,
  db: DatabaseLike,
  executor?: CommandExecutor,
) => Promise<StartedProcess>;

export function validateSubmissionInput(
  inputPath: string,
): { ok: true; canonicalPath: string } | { ok: false; message: string } {
  if (
    !inputPath ||
    inputPath.includes("\0") ||
    inputPath.includes("\r") ||
    inputPath.includes("\n")
  ) {
    return { ok: false, message: "Input path is empty or contains an invalid control character" };
  }
  if (inputPath.split(/[\\/]/).includes("..")) {
    return { ok: false, message: "Input path must not contain traversal segments" };
  }

  try {
    const canonicalPath = realpathSync(inputPath);
    if (!statSync(canonicalPath).isFile()) {
      return { ok: false, message: "Input path is not a regular file" };
    }
    return { ok: true, canonicalPath };
  } catch {
    return { ok: false, message: "Input file not found or is not a regular file" };
  }
}

export function buildLocalExecutionPlan(
  selectedRecipe: Recipe,
  inputPath: string,
  id: string,
  jobsDir: string,
  runner: RecipeRunnerKind = "local",
): { plan: LocalExecutionPlan; recipePlan: RenderedRecipePlan } {
  const recipePlan = renderRecipePlan(selectedRecipe, inputPath, id, jobsDir, runner);
  const executionPlan: LocalExecutionPlan = {
    command: recipePlan.command.display,
    program: recipePlan.command.program,
    args: recipePlan.command.args,
    displayCommand: recipePlan.command.display,
    job: {
      id,
      name: inputPath,
      software: selectedRecipe.software,
      inputPath,
      outputPath: recipePlan.outputName,
      workdir: jobsDir,
      status: "created",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };
  return { plan: executionPlan, recipePlan };
}

export async function submitJob(
  input: SubmitJobInput,
  deps: {
    db: DatabaseLike;
    config: Config;
    recipes?: Recipe[];
    runnerFactory?: RunnerFactory;
    executor?: CommandExecutor;
    /** Canonical coordinator used for production remote effects. */
    execution?: {
      dispatchRemote?: (
        jobId: string,
        backend: Runner,
      ) => Promise<{ ok: boolean; message?: string; status?: string }>;
    };
    /** Constructs the typed backend; the coordinator owns stage/start calls. */
    remoteRunnerFactory?: (plan: LocalExecutionPlan, db: DatabaseLike) => Runner;
  },
): Promise<SubmitJobResult> {
  // submitJob is for remote (SSH/Slurm) only. Local must use ExecutionCoordinator.
  if (!input.runner || input.runner === "local") {
    return {
      ok: false,
      message:
        "Local submission is not supported via submitJob. Use context.execution.executeLocal() for local jobs.",
    };
  }

  const inputValidation = validateSubmissionInput(input.inputPath);
  if (!inputValidation.ok) return { ok: false, message: inputValidation.message };
  const canonicalInputPath = inputValidation.canonicalPath;

  const allRecipes = deps.recipes ?? loadBuiltinRecipes();
  const runKind: RecipeRunnerKind = input.runner;

  let selectedRecipe: Recipe | undefined;

  if (input.recipe) {
    selectedRecipe = findRunnableRecipe(allRecipes, input.software, runKind, "", input.recipe);
    if (!selectedRecipe) {
      const found = allRecipes.find((r) => r.id === input.recipe);
      if (!found) {
        return { ok: false, message: `Recipe "${input.recipe}" not found` };
      }
      return {
        ok: false,
        message: `Recipe "${input.recipe}" is for ${found.software}, not ${input.software}`,
      };
    }
  } else {
    selectedRecipe = findRunnableRecipe(allRecipes, input.software, runKind, "");
    if (runKind === "ssh" && !selectedRecipe) {
      selectedRecipe = findRunnableRecipe(allRecipes, input.software, "local", "");
    }
  }

  if (!selectedRecipe) {
    return { ok: false, message: `No recipe found for ${input.software}` };
  }

  const validation = validateRecipe(selectedRecipe);
  if (!validation.valid) {
    return {
      ok: false,
      message: `Recipe "${selectedRecipe.id}" validation failed: ${validation.errors.join("; ")}`,
    };
  }

  const id = generateId("job");
  const renderRunner: RecipeRunnerKind = "local";

  const { plan: executionPlan, recipePlan } = buildLocalExecutionPlan(
    selectedRecipe,
    canonicalInputPath,
    id,
    deps.config.jobsDir,
    renderRunner,
  );

  await deps.db.createJob({
    id,
    name: input.name ?? canonicalInputPath,
    software: input.software,
    inputPath: canonicalInputPath,
    outputPath: recipePlan.outputName,
    workdir: deps.config.jobsDir,
    projectId: input.projectId,
    backend: input.backend ?? (input.runner === "slurm" ? input.runner : undefined),
  });

  await deps.db.appendEvent({
    id: generateId("evt"),
    type: "job.created",
    at: Date.now(),
    source: "cli",
    jobId: id,
    payload: {
      software: input.software,
      inputPath: canonicalInputPath,
      runner: input.runner ?? "local",
    },
  });

  await deps.db.appendEvent({
    id: generateId("evt"),
    type: "recipe.selected",
    at: Date.now(),
    source: "cli",
    jobId: id,
    payload: {
      recipeId: selectedRecipe.id,
      command: recipePlan.command.display,
      resources: selectedRecipe.resources,
    },
  });

  if (deps.execution?.dispatchRemote && deps.remoteRunnerFactory) {
    // Some legacy test/dry-run adapters expose createJob without a readable
    // getJob projection. Only the durable application adapter may enter the
    // coordinator; otherwise retain the explicitly injected compatibility
    // factory without claiming canonical production evidence.
    const persisted = await deps.db.getJob(id).catch(() => null);
    if (persisted) {
      const backend = deps.remoteRunnerFactory(executionPlan, deps.db);
      const dispatched = await deps.execution.dispatchRemote(id, backend);
      return {
        ok: dispatched.ok,
        jobId: id,
        message:
          dispatched.message ??
          (dispatched.ok ? "remote execution started" : "remote execution was not started"),
      };
    }
  }

  if (!deps.runnerFactory) {
    return { ok: false, jobId: id, message: "No runner factory provided for remote submission" };
  }
  const startResult = await deps.runnerFactory(executionPlan, deps.db, deps.executor);

  if (startResult.ok) {
    return { ok: true, jobId: id, message: startResult.message };
  }

  return { ok: false, jobId: id, message: startResult.message ?? "Failed to start runner" };
}
