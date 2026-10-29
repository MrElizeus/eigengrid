import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkChangedFormat } from "../../scripts/check-format-changed";

const gitIdentity = {
  ...process.env,
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_AUTHOR_NAME: "Format Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Format Test",
};

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, env: gitIdentity, stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function createRepository() {
  const cwd = mkdtempSync(join(tmpdir(), "eigengrid-format-"));
  git(cwd, "init");
  writeFileSync(join(cwd, "initial.ts"), "const initial = 1;\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  return cwd;
}

function base(cwd: string) {
  const result = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd, stdout: "pipe" });
  return new TextDecoder().decode(result.stdout).trim();
}

function commit(cwd: string) {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "change");
}

describe("checkChangedFormat", () => {
  test("passes an empty diff and formatted supported files", () => {
    const cwd = createRepository();
    try {
      const initial = base(cwd);
      expect(checkChangedFormat({ cwd, base: initial })).toEqual({ checkedPaths: [], exitCode: 0 });
      writeFileSync(join(cwd, "formatted.ts"), "const value = 1;\n");
      commit(cwd);
      expect(checkChangedFormat({ cwd, base: initial }).exitCode).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("fails unformatted supported files", () => {
    const cwd = createRepository();
    try {
      const initial = base(cwd);
      writeFileSync(join(cwd, "unformatted.ts"), "const value={x:1}\n");
      commit(cwd);
      expect(checkChangedFormat({ cwd, base: initial }).exitCode).not.toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("ignores unknown files and deleted files", () => {
    const cwd = createRepository();
    try {
      const initial = base(cwd);
      writeFileSync(join(cwd, "unknown.txt"), "not prettier input\n");
      rmSync(join(cwd, "initial.ts"));
      commit(cwd);
      expect(checkChangedFormat({ cwd, base: initial })).toEqual({
        checkedPaths: ["unknown.txt"],
        exitCode: 0,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("handles whitespace and shell-looking paths without execution", () => {
    const cwd = createRepository();
    const sentinel = join(cwd, "sentinel");
    try {
      const initial = base(cwd);
      const filename = "space; $(touch sentinel).ts";
      writeFileSync(join(cwd, filename), "const value = 1;\n");
      commit(cwd);
      expect(checkChangedFormat({ cwd, base: initial }).exitCode).toBe(0);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("checks only a renamed leading-dash destination", () => {
    const cwd = createRepository();
    try {
      const initial = base(cwd);
      const destination = "- renamed.ts";
      git(cwd, "mv", "--", "initial.ts", destination);
      commit(cwd);
      expect(checkChangedFormat({ cwd, base: initial })).toEqual({
        checkedPaths: [destination],
        exitCode: 0,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("rejects missing, all-zero, and invalid bases", () => {
    const cwd = createRepository();
    try {
      expect(() => checkChangedFormat({ cwd, base: "" })).toThrow("FORMAT_BASE");
      expect(() =>
        checkChangedFormat({ cwd, base: "0000000000000000000000000000000000000000" }),
      ).toThrow("FORMAT_BASE");
      expect(() => checkChangedFormat({ cwd, base: "not-a-commit" })).toThrow("not a commit");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
