import type { Software } from "@eigengrid/core";

export type RecipeRunnerKind = "local" | "ssh" | "slurm" | "pbs";

export interface RecipeCommandTemplate {
  run: string;
}

export interface RenderedCommand {
  runner: RecipeRunnerKind;
  display: string;
  program: string;
  args: string[];
  shell: boolean;
}

export interface RenderedRecipePlan {
  recipeId: string;
  software: string;
  runner: RecipeRunnerKind;
  inputName: string;
  inputPath: string;
  outputName: string;
  outputs: Record<string, string>;
  command: RenderedCommand;
  parser: { name: string };
  resources: {
    cores: number;
    memoryGb: number;
  };
}

export interface RecipeRenderContext {
  input: string;
  output: string;
  basename: string;
  jobId?: string;
  workdir?: string;
}

export interface Recipe {
  id: string;
  software: Software;
  description: string;
  inputExtensions: string[];
  commands: Partial<Record<RecipeRunnerKind, RecipeCommandTemplate>>;
  outputs: Record<string, string>;
  parser: { name: "gaussian" | "orca" | "xtb" | "cp2k" };
  resources: { defaultCores: number; defaultMemoryGb: number };
}

export interface RecipeStep {
  recipeId: string;
  order: number;
  description: string;
}
