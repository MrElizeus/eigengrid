import { describe, expect, it } from "bun:test";
import { findRunnableRecipe, loadBuiltinRecipes } from "@eigengrid/recipes";
import type { Recipe } from "@eigengrid/recipes";

const recipes = loadBuiltinRecipes();

describe("findRunnableRecipe — auto-selection", () => {
  it("selects gaussian recipe when software is gaussian and runner is local", () => {
    const result = findRunnableRecipe(recipes, "gaussian", "local", "");
    expect(result).toBeDefined();
    expect(result!.software).toBe("gaussian");
    // Should be the first gaussian recipe (gaussian-opt)
    expect(result!.id).toBe("gaussian-opt");
  });

  it("selects orca recipe when software is orca and runner is local", () => {
    const result = findRunnableRecipe(recipes, "orca", "local", "");
    expect(result).toBeDefined();
    expect(result!.software).toBe("orca");
    expect(result!.id).toBe("orca-opt");
  });

  it("selects xtb recipe when software is xtb and runner is local", () => {
    const result = findRunnableRecipe(recipes, "xtb", "local", "");
    expect(result).toBeDefined();
    expect(result!.software).toBe("xtb");
  });

  it("returns undefined for unconfigured software", () => {
    const result = findRunnableRecipe(recipes, "nosuchsoftware", "local", "");
    expect(result).toBeUndefined();
  });

  it("selects recipe by input extension (.gjf for gaussian)", () => {
    const result = findRunnableRecipe(recipes, "gaussian", "local", ".gjf");
    expect(result).toBeDefined();
    expect(result!.inputExtensions).toContain(".gjf");
  });

  it("selects recipe by input extension (.inp for orca)", () => {
    const result = findRunnableRecipe(recipes, "orca", "local", ".inp");
    expect(result).toBeDefined();
    expect(result!.inputExtensions).toContain(".inp");
  });

  it("selects recipe by input extension (.xyz for xtb)", () => {
    const result = findRunnableRecipe(recipes, "xtb", "local", ".xyz");
    expect(result).toBeDefined();
    expect(result!.inputExtensions).toContain(".xyz");
  });

  it("returns undefined when input extension does not match any recipe", () => {
    const result = findRunnableRecipe(recipes, "orca", "local", ".xyz");
    expect(result).toBeUndefined();
  });

  it("returns undefined when no runner command template exists", () => {
    const recipe: Recipe = {
      id: "test-no-runner",
      software: "orca",
      description: "No runner",
      inputExtensions: [".inp"],
      commands: {},
      outputs: { mainLog: "{{basename}}.out" },
      parser: { name: "orca" },
      resources: { defaultCores: 8, defaultMemoryGb: 16 },
    };
    const result = findRunnableRecipe([recipe], "orca", "local", ".inp");
    expect(result).toBeUndefined();
  });
});
