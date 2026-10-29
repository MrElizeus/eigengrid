import type { Recipe, RecipeRunnerKind } from "./types";

const BUILTIN_RECIPES: Recipe[] = [
  {
    id: "gaussian-opt",
    software: "gaussian",
    description: "Gaussian geometry optimization",
    inputExtensions: [".gjf", ".com"],
    commands: {
      local: { run: "g16 < {{input}} > {{output}}" },
      slurm: { run: "g16 < {{input}} > {{output}}" },
    },
    outputs: { mainLog: "{{basename}}.log" },
    parser: { name: "gaussian" },
    resources: { defaultCores: 8, defaultMemoryGb: 16 },
  },
  {
    id: "gaussian-freq",
    software: "gaussian",
    description: "Gaussian frequency calculation",
    inputExtensions: [".gjf", ".com"],
    commands: {
      local: { run: "g16 < {{input}} > {{output}}" },
      slurm: { run: "g16 < {{input}} > {{output}}" },
    },
    outputs: { mainLog: "{{basename}}.log" },
    parser: { name: "gaussian" },
    resources: { defaultCores: 8, defaultMemoryGb: 16 },
  },
  {
    id: "orca-opt",
    software: "orca",
    description: "ORCA geometry optimization",
    inputExtensions: [".inp"],
    commands: {
      local: { run: "orca {{input}} > {{output}}" },
      slurm: { run: "orca {{input}} > {{output}}" },
    },
    outputs: { mainLog: "{{basename}}.out" },
    parser: { name: "orca" },
    resources: { defaultCores: 8, defaultMemoryGb: 16 },
  },
  {
    id: "xtb-opt",
    software: "xtb",
    description: "xTB geometry optimization",
    inputExtensions: [".xyz"],
    commands: {
      local: { run: "xtb {{input}} --opt > {{output}}" },
      slurm: { run: "xtb {{input}} --opt > {{output}}" },
    },
    outputs: { mainLog: "{{basename}}.out" },
    parser: { name: "xtb" },
    resources: { defaultCores: 4, defaultMemoryGb: 4 },
  },
  {
    id: "cp2k-opt",
    software: "cp2k",
    description: "CP2K optimization",
    inputExtensions: [".inp"],
    commands: {
      local: { run: "cp2k {{input}} > {{output}}" },
      slurm: { run: "cp2k {{input}} > {{output}}" },
    },
    outputs: { mainLog: "{{basename}}.out" },
    parser: { name: "cp2k" },
    resources: { defaultCores: 16, defaultMemoryGb: 32 },
  },
  {
    id: "cp2k-freq",
    software: "cp2k",
    description: "CP2K frequency calculation",
    inputExtensions: [".inp"],
    commands: {
      local: { run: "cp2k {{input}} > {{output}}" },
      slurm: { run: "cp2k {{input}} > {{output}}" },
    },
    outputs: { mainLog: "{{basename}}.out" },
    parser: { name: "cp2k" },
    resources: { defaultCores: 16, defaultMemoryGb: 32 },
  },
  {
    id: "orca-freq",
    software: "orca",
    description: "ORCA frequency calculation",
    inputExtensions: [".inp"],
    commands: {
      local: { run: "orca {{input}} > {{output}}" },
      slurm: { run: "orca {{input}} > {{output}}" },
    },
    outputs: { mainLog: "{{basename}}.out" },
    parser: { name: "orca" },
    resources: { defaultCores: 8, defaultMemoryGb: 16 },
  },
];

export function loadBuiltinRecipes(): Recipe[] {
  return BUILTIN_RECIPES;
}

export function findRecipe(id: string): Recipe | undefined {
  return BUILTIN_RECIPES.find((r) => r.id === id);
}

/**
 * Find a runnable recipe that matches the given criteria.
 *
 * If `recipeId` is provided, finds the recipe by ID and validates that
 * its software matches the given software. If no `recipeId` is given,
 * returns the first recipe matching software and runner. When
 * `inputExtension` is non-empty, also filters by input extension.
 *
 * Returns `undefined` when no matching recipe is found or when a
 * software mismatch occurs with an explicit recipeId.
 */
export function findRunnableRecipe(
  recipes: Recipe[],
  software: string,
  runner: RecipeRunnerKind,
  inputExtension: string,
  recipeId?: string,
): Recipe | undefined {
  if (recipeId) {
    const recipe = recipes.find((r) => r.id === recipeId);
    if (!recipe) return undefined;
    if (recipe.software !== software) return undefined;
    return recipe;
  }

  return recipes.find((recipe) => {
    if (recipe.software !== software) return false;
    if (!recipe.commands[runner]?.run) return false;
    if (inputExtension) {
      return recipe.inputExtensions.some(
        (ext) => ext.toLowerCase() === inputExtension.toLowerCase(),
      );
    }
    return true;
  });
}
