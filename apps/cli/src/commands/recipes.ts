import type { CommandModule } from "yargs";
import { loadBuiltinRecipes } from "@eigengrid/recipes";

type RecipesArgs = {
  software?: string;
  json?: boolean;
};

export const recipesCommand: CommandModule = {
  command: "recipes",
  describe: "List available built-in recipes",
  builder: (y) =>
    y
      .option("software", {
        describe: "Filter recipes by software",
        type: "string",
      })
      .option("json", {
        describe: "Output as JSON",
        type: "boolean",
        default: false,
      }),
  async handler(args) {
    const { software, json } = args as unknown as RecipesArgs;
    const allRecipes = loadBuiltinRecipes();

    const filtered = software ? allRecipes.filter((r) => r.software === software) : allRecipes;

    if (json) {
      console.log(JSON.stringify(filtered, null, 2));
      return;
    }

    if (filtered.length === 0) {
      if (software) {
        console.log(`  No recipes found for software "${software}".\n`);
      } else {
        console.log("  No recipes available.\n");
      }
      return;
    }

    console.log("  Available Recipes\n");
    for (const recipe of filtered) {
      const runners = Object.keys(recipe.commands).join(", ");
      console.log(`  ${recipe.id}`);
      console.log(`    Software:      ${recipe.software}`);
      console.log(`    Input Ext:     ${recipe.inputExtensions.join(", ")}`);
      console.log(`    Runner(s):     ${runners}`);
      console.log(`    Description:   ${recipe.description}`);
      console.log("");
    }
  },
};
