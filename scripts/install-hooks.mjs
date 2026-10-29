import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

try {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const hookPath = resolve(root, ".githooks");
  const configured = spawnSync("git", ["config", "--get", "core.hooksPath"], { encoding: "utf8" });
  if (configured.status !== 0 && configured.status !== 1)
    throw new Error("Cannot read Git hook configuration.");
  const previous = configured.stdout.trim();
  if (previous && resolve(root, previous) !== hookPath)
    throw new Error(
      `Existing hooksPath preserved: ${previous}. Integrate the commit-msg hook manually.`,
    );
  const defaultHook = execFileSync("git", ["rev-parse", "--git-path", "hooks/commit-msg"], {
    encoding: "utf8",
  }).trim();
  const defaultDirectory = dirname(defaultHook);
  if (
    !previous &&
    existsSync(defaultDirectory) &&
    readdirSync(defaultDirectory).some(
      (name) =>
        !name.endsWith(".sample") && (statSync(resolve(defaultDirectory, name)).mode & 0o111) !== 0,
    )
  )
    throw new Error("Existing Git hooks preserved. Integrate .githooks/commit-msg manually.");
  chmodSync(resolve(hookPath, "commit-msg"), 0o755);
  execFileSync("git", ["config", "--local", "core.hooksPath", hookPath]);
  console.log("Commit message validation enabled for this repository and its worktrees.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
