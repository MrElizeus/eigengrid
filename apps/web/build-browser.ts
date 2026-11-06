// Runs in a separate Bun process: macros cannot re-enter their parent bundler.
const result = await Bun.build({
  entrypoints: [new URL("./src/main.tsx", import.meta.url).pathname],
  target: "browser",
  minify: true,
  env: "disable",
  define: { "process.env.NODE_ENV": '"production"' },
  // NODE_ENV replacement alone does not select the production JSX transform.
  jsx: { development: false },
});
if (!result.success) throw new AggregateError(result.logs, "Unable to build the React workspace");
if (result.outputs.length !== 1) throw new Error("Expected one self-contained browser bundle");
process.stdout.write(await result.outputs[0]!.text());
