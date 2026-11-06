/** Executed by Bun at build time; compiled releases need no frontend runtime. */
export function browserBundle(): string {
  // A subprocess avoids re-entering Bun's bundler from its own macro worker.
  const result = Bun.spawnSync(
    [process.execPath, new URL("./build-browser.ts", import.meta.url).pathname],
    { cwd: new URL("../..", import.meta.url).pathname },
  );
  if (!result.success)
    throw new Error(`Unable to build the React workspace: ${result.stderr.toString()}`);
  return result.stdout.toString();
}
