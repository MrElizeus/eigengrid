import type { Recipe, RecipeRunnerKind, RenderedRecipePlan } from "@eigengrid/recipes";
import { renderRecipePlan } from "@eigengrid/recipes";
import { type LocalExecutionPlan } from "../submit-service";

export function buildLocalExecutionPlanInternal(
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
