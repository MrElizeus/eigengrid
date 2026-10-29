import { existsSync } from "node:fs";
import { resolve } from "node:path";

const prettierExecutable = resolve(import.meta.dir, "../node_modules/.bin/prettier");
const zeroRevision = /^0+$/;

export interface FormatCheckOptions {
  base: string;
  cwd?: string;
  inheritPrettierOutput?: boolean;
}

export interface FormatCheckResult {
  checkedPaths: string[];
  exitCode: number;
}

function run(command: string[], cwd: string) {
  return Bun.spawnSync({ cmd: command, cwd, stderr: "pipe", stdout: "pipe" });
}

function assertCommit(base: string, cwd: string) {
  if (!base || zeroRevision.test(base)) {
    throw new Error("FORMAT_BASE must be a non-zero commit revision");
  }

  const result = run(["git", "rev-parse", "--verify", "--end-of-options", `${base}^{commit}`], cwd);
  if (result.exitCode !== 0) {
    throw new Error(`FORMAT_BASE is not a commit revision: ${base}`);
  }
}

export function checkChangedFormat({
  base,
  cwd = process.cwd(),
  inheritPrettierOutput = false,
}: FormatCheckOptions): FormatCheckResult {
  assertCommit(base, cwd);

  const diff = run(
    ["git", "diff", "--name-only", "-z", "--diff-filter=ACMR", base, "HEAD", "--"],
    cwd,
  );
  if (diff.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(diff.stderr).trim() || "Could not list changed files");
  }

  const checkedPaths = new TextDecoder().decode(diff.stdout).split("\0").filter(Boolean);
  if (checkedPaths.length === 0) {
    return { checkedPaths, exitCode: 0 };
  }
  if (!existsSync(prettierExecutable)) {
    throw new Error(`Prettier executable not found: ${prettierExecutable}`);
  }

  const command = [prettierExecutable, "--check", "--ignore-unknown", "--", ...checkedPaths];
  const prettier = inheritPrettierOutput
    ? Bun.spawnSync({ cmd: command, cwd, stderr: "inherit", stdout: "inherit" })
    : run(command, cwd);
  return { checkedPaths, exitCode: prettier.exitCode };
}

if (import.meta.main) {
  try {
    const result = checkChangedFormat({
      base: process.env.FORMAT_BASE ?? "",
      inheritPrettierOutput: true,
    });
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
