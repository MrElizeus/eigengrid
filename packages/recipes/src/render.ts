import { parse, basename } from "path";
import type {
  Recipe,
  RecipeRenderContext,
  RecipeRunnerKind,
  RenderedRecipePlan,
  RenderedCommand,
} from "./types";

const ALLOWED_PLACEHOLDERS = new Set([
  "{{input}}",
  "{{output}}",
  "{{basename}}",
  "{{jobId}}",
  "{{workdir}}",
]);

const EXECUTABLE_PLACEHOLDERS: Record<string, string> = {
  "{{input}}": '"$1"',
  "{{output}}": '"$2"',
  "{{basename}}": '"$3"',
  "{{jobId}}": '"$4"',
  "{{workdir}}": '"$5"',
};

// AMBER and GROMACS are recognized Software identities, but they are intentionally
// absent from this legacy single-command route. MD effects must be owned by
// ScientificMission WorkUnits and typed engine adapters, never by an injected Recipe.
const LEGACY_RECIPE_SOFTWARE = ["gaussian", "orca", "xtb", "cp2k", "qe", "unknown"];

const ALLOWED_PARSERS = ["gaussian", "orca", "xtb", "cp2k"];

/**
 * Find the first local recipe that matches the given software.
 * A "local" recipe has a local command template defined.
 */
export function getLocalRecipe(software: string, recipes: Recipe[]): Recipe | undefined {
  return recipes.find((recipe) => recipe.software === software && recipe.commands.local?.run);
}

/**
 * Render a command/output template by replacing placeholders with values.
 *
 * Supports two call signatures:
 * 1. `renderTemplate(template, inputName, outputName)` — classic 3-arg form
 * 2. `renderTemplate(template, context)` — context object form
 *
 * Recognized placeholders: {{input}}, {{output}}, {{basename}}, {{jobId}}, {{workdir}}
 */
export function renderTemplate(template: string, inputName: string, outputName: string): string;
export function renderTemplate(template: string, context: RecipeRenderContext): string;
export function renderTemplate(
  template: string,
  inputOrContext: string | RecipeRenderContext,
  outputName?: string,
): string {
  let context: RecipeRenderContext;

  if (typeof inputOrContext === "string") {
    const baseName = parse(inputOrContext).name;
    context = {
      input: inputOrContext,
      output: outputName ?? "",
      basename: baseName,
      jobId: "",
      workdir: "",
    };
  } else {
    context = inputOrContext;
  }

  return template
    .replaceAll("{{input}}", context.input)
    .replaceAll("{{output}}", context.output)
    .replaceAll("{{basename}}", context.basename)
    .replaceAll("{{jobId}}", context.jobId ?? "")
    .replaceAll("{{workdir}}", context.workdir ?? "");
}

/**
 * Build a fully-typed RenderedRecipePlan from a recipe and input details.
 *
 * Renders all templates (command + outputs) and produces a structured
 * plan that can be consumed by runners or displayed to the user.
 */
export function renderRecipePlan(
  recipe: Recipe,
  inputPath: string,
  jobId: string,
  workdir: string,
  runner: RecipeRunnerKind = "local",
): RenderedRecipePlan {
  const inputName = basename(inputPath);
  const baseName = parse(inputName).name;
  const runnerCommands = recipe.commands[runner];

  if (!runnerCommands?.run) {
    throw new Error(`No ${runner} command found for recipe ${recipe.id} (${recipe.software})`);
  }

  // Compute the primary output log path
  const outputName = renderTemplate(recipe.outputs.mainLog ?? "{{basename}}.log", {
    input: inputName,
    output: `${baseName}.log`,
    basename: baseName,
    jobId,
    workdir,
  });

  const context: RecipeRenderContext = {
    input: inputName,
    output: outputName,
    basename: baseName,
    jobId,
    workdir,
  };

  // Render all output paths
  const outputs: Record<string, string> = {};
  for (const [key, tmpl] of Object.entries(recipe.outputs)) {
    outputs[key] = renderTemplate(tmpl, context);
  }

  const renderedCommand = renderTemplate(runnerCommands.run, context);
  // Recipe templates are trusted shell source (they may use redirection), but
  // submit-provided values must only enter it through positional parameters.
  const executableScript = Object.entries(EXECUTABLE_PLACEHOLDERS).reduce(
    (script, [placeholder, positionalReference]) =>
      script.replaceAll(placeholder, positionalReference),
    runnerCommands.run,
  );

  const command: RenderedCommand = {
    runner,
    display: renderedCommand,
    program: "sh",
    args: [
      "-c",
      executableScript,
      "eigengrid-recipe",
      inputName,
      outputName,
      baseName,
      jobId,
      workdir,
    ],
    shell: false,
  };

  return {
    recipeId: recipe.id,
    software: recipe.software,
    runner,
    inputName,
    inputPath,
    outputName,
    outputs,
    command,
    parser: recipe.parser,
    resources: {
      cores: recipe.resources.defaultCores,
      memoryGb: recipe.resources.defaultMemoryGb,
    },
  };
}

/**
 * Check whether an input filename is safe to use in shell commands.
 * Rejects names containing characters that could enable injection
 * or argument splitting.
 *
 * Returns `true` if the name is safe.
 */
export function sanitizeInputName(name: string): boolean {
  // Forbidden: space, newline, tab, shell metacharacters
  const forbidden = /[\s\n\t;&|`$><*?[\]()]/;
  return !forbidden.test(name);
}

/**
 * Validate a Recipe definition and return a list of errors.
 *
 * Checks:
 *  - id is non-empty
 *  - software is a known value
 *  - inputExtensions are lowercase and start with "."
 *  - local command exists
 *  - outputs.mainLog exists
 *  - parser.name exists and is known
 *  - defaultCores > 0
 *  - defaultMemoryGb > 0
 *  - all templates use only allowed placeholders
 */
export function validateRecipe(recipe: Recipe): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // id
  if (!recipe.id || recipe.id.trim().length === 0) {
    errors.push("id is empty");
  }

  // software
  if (recipe.software === "amber" || recipe.software === "gromacs") {
    errors.push(`software "${recipe.software}" requires the typed ScientificMission MD workflow`);
  } else if (!LEGACY_RECIPE_SOFTWARE.includes(recipe.software)) {
    errors.push(`unknown software "${recipe.software}"`);
  }

  // inputExtensions
  if (!recipe.inputExtensions || recipe.inputExtensions.length === 0) {
    errors.push("inputExtensions is empty");
  } else {
    for (const ext of recipe.inputExtensions) {
      if (!ext.startsWith(".")) {
        errors.push(`inputExtension "${ext}" does not start with "."`);
      }
      if (ext !== ext.toLowerCase()) {
        errors.push(`inputExtension "${ext}" is not lowercase`);
      }
    }
  }

  // local command
  if (!recipe.commands.local?.run) {
    errors.push("commands.local.run is missing");
  }

  // outputs.mainLog
  if (!recipe.outputs.mainLog) {
    errors.push("outputs.mainLog is missing");
  }

  // parser.name
  if (!recipe.parser?.name) {
    errors.push("parser.name is missing");
  } else if (!ALLOWED_PARSERS.includes(recipe.parser.name)) {
    errors.push(`unknown parser "${recipe.parser.name}"`);
  }

  // resources
  if (!recipe.resources || recipe.resources.defaultCores <= 0) {
    errors.push("resources.defaultCores must be > 0");
  }
  if (!recipe.resources || recipe.resources.defaultMemoryGb <= 0) {
    errors.push("resources.defaultMemoryGb must be > 0");
  }

  // template placeholder validation
  const allTemplates: string[] = [];

  for (const cmd of Object.values(recipe.commands)) {
    if (cmd?.run) allTemplates.push(cmd.run);
  }
  for (const tmpl of Object.values(recipe.outputs)) {
    if (tmpl) allTemplates.push(tmpl);
  }

  for (const tmpl of allTemplates) {
    const matches = tmpl.match(/\{\{[^}]+\}\}/g);
    if (matches) {
      for (const match of matches) {
        if (!ALLOWED_PLACEHOLDERS.has(match)) {
          errors.push(
            `invalid placeholder "${match}" in template "${tmpl.slice(0, 50)}${tmpl.length > 50 ? "..." : ""}"`,
          );
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
