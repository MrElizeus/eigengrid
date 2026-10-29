import { createApplicationContext } from "../../apps/cli/src/composition/context";

const [databasePath, jobsDir, inputPath] = process.argv.slice(2);
if (!databasePath || !jobsDir || !inputPath) {
  throw new Error("Usage: durable-local-launcher <database-path> <jobs-dir> <input-path>");
}

const context = await createApplicationContext({
  config: { databasePath, jobsDir, dbProvider: "sqlite" },
});

const result = await context.execution.executeLocal({
  software: "xtb",
  inputPath,
  recipeId: "xtb-opt",
  name: "durable-restart-fixture",
});

await Bun.write(Bun.stdout, `${JSON.stringify(result)}\n`);
await context.close();
process.exit(result.ok ? 0 : 1);
