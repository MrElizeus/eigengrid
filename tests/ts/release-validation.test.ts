import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
const script = resolve("scripts/release/validation.ts");
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "release-validation-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  writeFileSync(join(root, "README.md"), "Synthetic release fixture\n");
  git("add", "README.md");
  git(
    "-c",
    "user.name=Release Test",
    "-c",
    "user.email=release@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "test: initialize release fixture",
  );
  const commit = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", commit);
  mkdirSync(join(root, "dist/packages"), { recursive: true });
  writeFileSync(
    join(root, "dist/packages/release.json"),
    JSON.stringify({ version: "1.0.0-rc.2", sourceCommit: commit }),
  );
  writeFileSync(
    join(root, "dist/packages/eigengrid-1.0.0-rc.2-linux-x64.tar.gz"),
    "synthetic package",
  );
  const env = {
    ...process.env,
    GITHUB_REF_NAME: "v1.0.0-rc.2",
    GITHUB_SHA: commit,
    GITHUB_RUN_ID: "123",
    GITHUB_REPOSITORY_ID: "456",
    GITHUB_EVENT_NAME: "push",
  };
  return {
    root,
    env,
    execute: () => spawnSync(process.execPath, [script], { cwd: root, env, encoding: "utf8" }),
  };
}

describe("release validation manifest", () => {
  test("binds package bytes, source and migrations to the CI run", () => {
    const item = fixture();
    const result = item.execute();
    expect(result.status).toBe(0);
    const validation = JSON.parse(
      readFileSync(join(item.root, "dist/packages/validation.json"), "utf8"),
    );
    expect(validation.sourceCommit).toBe(item.env.GITHUB_SHA);
    expect(validation.repositoryId).toBe(456);
    expect(validation.runId).toBe(123);
    expect(validation.archiveSha256).toBe(
      createHash("sha256").update("synthetic package").digest("hex"),
    );
    expect(validation.migrations).toHaveLength(22);
    expect(validation.migrations[21].version).toBe(22);
  });

  test.each([
    ["GITHUB_REF_NAME", "v1.0.0-rc.3"],
    ["GITHUB_SHA", "a".repeat(40)],
    ["GITHUB_EVENT_NAME", "pull_request"],
    ["GITHUB_RUN_ID", ""],
  ])("rejects invalid %s", (key, value) => {
    const item = fixture();
    Object.assign(item.env, { [key]: value });
    expect(item.execute().status).not.toBe(0);
  });
});
