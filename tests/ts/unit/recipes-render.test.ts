import { describe, expect, it } from "bun:test";
import { join } from "path";
import { rmSync } from "fs";
import {
  renderTemplate,
  validateRecipe,
  sanitizeInputName,
  findRunnableRecipe,
  loadBuiltinRecipes,
  renderRecipePlan,
} from "@eigengrid/recipes";
import type { Recipe } from "@eigengrid/recipes";

const validRecipe: Recipe = {
  id: "orca-opt",
  software: "orca",
  description: "ORCA geometry optimization",
  inputExtensions: [".inp"],
  commands: { local: { run: "orca {{input}} > {{output}}" } },
  outputs: { mainLog: "{{basename}}.out" },
  parser: { name: "orca" },
  resources: { defaultCores: 8, defaultMemoryGb: 16 },
};

describe("renderTemplate", () => {
  it("renders template with context object", () => {
    const result = renderTemplate("orca {{input}} > {{output}}", {
      input: "water.inp",
      output: "water.out",
      basename: "water",
      jobId: "job-001",
      workdir: "/scratch",
    });
    expect(result).toBe("orca water.inp > water.out");
  });

  it("renders template with backward-compatible 3-param signature", () => {
    const result = renderTemplate("g16 < {{input}} > {{output}}", "water.inp", "water.log");
    expect(result).toBe("g16 < water.inp > water.log");
  });

  it("replaces {{basename}} correctly", () => {
    const result = renderTemplate("{{basename}}.log", "path/to/water.inp", "");
    expect(result).toBe("water.log");
  });

  it("replaces {{jobId}} and {{workdir}}", () => {
    const result = renderTemplate("{{workdir}}/{{jobId}}/{{input}}", {
      input: "water.inp",
      output: "",
      basename: "water",
      jobId: "abc-123",
      workdir: "/tmp",
    });
    expect(result).toBe("/tmp/abc-123/water.inp");
  });
});

describe("renderRecipePlan executable command", () => {
  it("keeps hostile-looking values out of trusted shell source", () => {
    const inputPath = "/tmp/naïve ; touch sentinel $(nope) `nope`.inp";
    const plan = renderRecipePlan(validRecipe, inputPath, "job;$(id)", "/tmp/work dir", "local");

    expect(plan.command.shell).toBe(false);
    expect(plan.command.program).toBe("sh");
    expect(plan.command.args[0]).toBe("-c");
    expect(plan.command.args[2]).toBe("eigengrid-recipe");
    expect(plan.command.args.slice(3)).toEqual([
      "naïve ; touch sentinel $(nope) `nope`.inp",
      "naïve ; touch sentinel $(nope) `nope`.out",
      "naïve ; touch sentinel $(nope) `nope`",
      "job;$(id)",
      "/tmp/work dir",
    ]);
    expect(plan.command.args[1]).toBe('orca "$1" > "$2"');
    expect(plan.command.args[1]).not.toContain("sentinel");
    expect(plan.command.args[1]).not.toContain("$(id)");
  });

  it("executes a trusted template without evaluating argument contents", async () => {
    const workspace = `/tmp/eigengrid-recipe-${crypto.randomUUID()}`;
    const sentinel = "sentinel";
    const hostile = "input; touch sentinel; $(touch sentinel) `touch sentinel`.inp";
    const recipe: Recipe = {
      ...validRecipe,
      commands: { local: { run: "printf '%s' {{input}} > {{output}}" } },
    };
    const plan = renderRecipePlan(recipe, hostile, "job", workspace, "local");
    const output = join(workspace, "output");
    plan.command.args[4] = output;

    try {
      const result = Bun.spawnSync(["mkdir", "-p", workspace]);
      expect(result.exitCode).toBe(0);
      const execution = Bun.spawnSync([plan.command.program, ...plan.command.args], {
        cwd: workspace,
      });
      expect(execution.exitCode).toBe(0);
      await expect(Bun.file(output).text()).resolves.toBe(hostile);
      expect(await Bun.file(join(workspace, sentinel)).exists()).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("validateRecipe", () => {
  it("passes valid recipes", () => {
    const result = validateRecipe(validRecipe);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects empty recipe id", () => {
    const result = validateRecipe({ ...validRecipe, id: "" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("id is empty");
  });

  it("rejects unknown software", () => {
    const result = validateRecipe({ ...validRecipe, software: "nosuchsoft" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("unknown software"))).toBe(true);
  });

  it("rejects MD engines on the legacy single-command Recipe path", () => {
    for (const software of ["amber", "gromacs"] as const) {
      const result = validateRecipe({ ...validRecipe, software });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        `software "${software}" requires the typed ScientificMission MD workflow`,
      );
    }
  });

  it("rejects bad input extensions", () => {
    const result = validateRecipe({ ...validRecipe, inputExtensions: ["inp"] });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('does not start with "."'))).toBe(true);
  });

  it("rejects missing outputs", () => {
    const result = validateRecipe({ ...validRecipe, outputs: {} });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("outputs.mainLog is missing");
  });

  it("rejects missing parser", () => {
    const result = validateRecipe({ ...validRecipe, parser: { name: "" as never } });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("parser.name is missing");
  });

  it("rejects zero resources", () => {
    const result = validateRecipe({
      ...validRecipe,
      resources: { defaultCores: 0, defaultMemoryGb: 0 },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("resources.defaultCores must be > 0");
    expect(result.errors).toContain("resources.defaultMemoryGb must be > 0");
  });
});

describe("findRunnableRecipe", () => {
  const recipes = loadBuiltinRecipes();

  it("selects correct recipe by software, runner, and input extension", () => {
    const result = findRunnableRecipe(recipes, "orca", "local", ".inp");
    expect(result).toBeDefined();
    expect(result!.id).toBe("orca-opt");
  });

  it("selects correct recipe with explicit recipeId", () => {
    const result = findRunnableRecipe(recipes, "orca", "local", ".inp", "orca-opt");
    expect(result).toBeDefined();
    expect(result!.id).toBe("orca-opt");
  });

  it("returns undefined for mismatched software with explicit recipeId", () => {
    const result = findRunnableRecipe(recipes, "gaussian", "local", ".inp", "orca-opt");
    expect(result).toBeUndefined();
  });

  it("returns undefined when recipeId is not found", () => {
    const result = findRunnableRecipe(recipes, "orca", "local", ".inp", "nonexistent");
    expect(result).toBeUndefined();
  });

  it("returns undefined when no recipe matches software", () => {
    const result = findRunnableRecipe(recipes, "nosuchsoft", "local", ".inp");
    expect(result).toBeUndefined();
  });

  it("returns first matching recipe when no input extension and no recipeId", () => {
    const result = findRunnableRecipe(recipes, "gaussian", "local", "");
    expect(result).toBeDefined();
    expect(result!.software).toBe("gaussian");
  });
});

describe("sanitizeInputName", () => {
  const invalidCases = [
    { name: "has space", value: "water 1.inp" },
    { name: "has dollar sign", value: "water$file.inp" },
    { name: "has semicolon", value: "water;rm.inp" },
    { name: "has pipe", value: "water|sh.inp" },
    { name: "has ampersand", value: "water&bg.inp" },
    { name: "has backtick", value: "water`cmd`.inp" },
    { name: "has newline", value: "water\n.inp" },
    { name: "has tab", value: "water\t.inp" },
  ];

  for (const { name, value } of invalidCases) {
    it(`rejects name with ${name}`, () => {
      expect(sanitizeInputName(value)).toBe(false);
    });
  }

  const validCases = ["water.inp", "water_sp.inp", "benzene-001.inp"];

  for (const name of validCases) {
    it(`accepts "${name}"`, () => {
      expect(sanitizeInputName(name)).toBe(true);
    });
  }
});
