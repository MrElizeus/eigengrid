import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkHistory, validateMessage } from "./check-commits.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const checker = join(root, "scripts/check-commits.mjs");
const installer = join(root, "scripts/install-hooks.mjs");

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), "eigengrid-commits-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Commit policy test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  // Tests must never inherit the developer's hooks or global signing policy.
  git("config", "core.hooksPath", join(cwd, ".git/hooks"));
  const commit = (message) => {
    git("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const base = commit("Historical commit without a prefix");
  return { cwd, git, commit, base };
}

test("accepts documented types, scopes, Unicode descriptions and breaking changes", () => {
  for (const message of [
    "feat(web): add dark mode",
    "fix: preserve café labels",
    "docs(cli): explain configuration",
    "refactor(agent/runtime): extract setup",
    "perf(db): reduce journal reads",
    "test: cover cancellation",
    "build: update dependencies",
    "ci: validate commits",
    "chore(repo): configure hooks",
    "style: format sources",
    "revert(web): remove navigation",
    "feat(protocol)!: require schema v2",
    "fix!: reject unsupported input\n\nBREAKING CHANGE: old input needs migration.",
    "fix: correct behavior\r\n\r\nAdditional detail.\r\n",
  ])
    assert.deepEqual(validateMessage(message), [], message);
});

test("rejects missing and invalid types, malformed scopes, empty subjects and control characters", () => {
  for (const message of [
    "",
    "Update everything",
    "(feat): add mode",
    "doc: update guide",
    "Feat: add mode",
    "feat(): add mode",
    "feat(Web): add mode",
    "feat: ",
    "feat:no separator",
    "feat:  extra space",
    "fix(web ui): repair layout",
    "fix: bad\ttext",
    "fixup! feat: add mode",
    "Merge branch 'fake'",
    "fix: change behavior\nMissing blank line",
    `docs: ${"x".repeat(95)}`,
  ])
    assert.ok(validateMessage(message).length, message);
  assert.deepEqual(validateMessage(`docs: ${"x".repeat(94)}`), []);
});

test("checks every commit in an explicit range", (t) => {
  const repo = repository(t);
  repo.commit("feat: add a capability");
  const bad = repo.commit("Update things");
  repo.commit("docs: explain the capability");
  const result = checkHistory({ cwd: repo.cwd, base: repo.base });
  assert.equal(result.checked, 3);
  assert.deepEqual(
    result.failures.map((x) => x.sha),
    [bad],
  );
  assert.throws(() => checkHistory({ cwd: repo.cwd, base: "missing-revision" }));
});

test("validates the root commit when no base is supplied", (t) => {
  const repo = repository(t);
  repo.commit("feat: add a capability");
  const invalid = checkHistory({ cwd: repo.cwd });
  assert.equal(invalid.checked, 2);
  assert.deepEqual(
    invalid.failures.map((entry) => entry.sha),
    [repo.base],
  );
  repo.git("switch", "--orphan", "canonical");
  repo.commit("chore: initialize EigenGrid");
  const valid = checkHistory({ cwd: repo.cwd });
  assert.equal(valid.checked, 1);
  assert.deepEqual(valid.failures, []);
});

test("uses the merge base when the target branch has advanced", (t) => {
  const repo = repository(t);
  repo.git("switch", "-c", "feature");
  const head = repo.commit("feat: add feature");
  repo.git("switch", "main");
  const base = repo.commit("Existing target commit without a prefix");
  const result = checkHistory({ cwd: repo.cwd, base, head });
  assert.equal(result.checked, 1);
  assert.deepEqual(result.failures, []);
});

test("exempts real merges without hiding invalid commits brought in by the merge", (t) => {
  const repo = repository(t);
  repo.git("switch", "-c", "feature");
  const bad = repo.commit("Unformatted feature");
  repo.git("switch", "main");
  repo.commit("fix: independent correction");
  repo.git("merge", "--no-ff", "feature", "-m", "Merge branch 'feature'");
  const result = checkHistory({ cwd: repo.cwd, base: repo.base });
  assert.equal(result.checked, 2);
  assert.deepEqual(
    result.failures.map((x) => x.sha),
    [bad],
  );
});

test("hook handles Git comments and rejects invalid local messages", (t) => {
  const repo = repository(t);
  const path = join(repo.cwd, "message");
  writeFileSync(path, "# Template comment\n\nfeat(web): add dark mode\n\n# Status\n");
  const invoke = () =>
    spawnSync(process.execPath, [checker, "--file", path], { cwd: repo.cwd, encoding: "utf8" });
  assert.equal(invoke().status, 0);
  writeFileSync(path, "Bad commit title\n");
  assert.equal(invoke().status, 1);
  writeFileSync(path, "Merge branch 'fake'\n");
  assert.equal(invoke().status, 1);
});

test("installer enables a real commit hook without extra dependencies", (t) => {
  const repo = repository(t);
  for (const file of [".commit-policy.json", ".githooks/commit-msg", "scripts/check-commits.mjs"]) {
    const target = join(repo.cwd, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, file), target);
  }
  repo.git("config", "--unset", "core.hooksPath");
  execFileSync(process.execPath, [installer], { cwd: repo.cwd });
  execFileSync(process.execPath, [installer], { cwd: repo.cwd });
  const bad = spawnSync("git", ["commit", "--allow-empty", "-m", "Update things"], {
    cwd: repo.cwd,
  });
  assert.equal(bad.status, 1);
  assert.equal(repo.git("rev-parse", "HEAD"), repo.base);
  repo.git("commit", "--allow-empty", "-m", "chore(repo): enable commit validation");
  assert.notEqual(repo.git("rev-parse", "HEAD"), repo.base);
});

test("installer preserves custom hook directories and existing hooks", (t) => {
  const repo = repository(t);
  const previous = repo.git("config", "--get", "core.hooksPath");
  const invoke = () => spawnSync(process.execPath, [installer], { cwd: repo.cwd });
  assert.equal(invoke().status, 1);
  assert.equal(repo.git("config", "--get", "core.hooksPath"), previous);
  repo.git("config", "--unset", "core.hooksPath");
  const hook = join(repo.cwd, ".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.equal(invoke().status, 1);
  assert.equal(readFileSync(hook, "utf8"), "#!/bin/sh\nexit 0\n");
});

test("CI validates PR titles as data, including edited invalid titles", (t) => {
  const repo = repository(t);
  const head = repo.commit("feat: add capability");
  const eventPath = join(repo.cwd, "event.json");
  const event = {
    pull_request: { base: { sha: repo.base }, head: { sha: head }, title: "feat: add capability" },
  };
  const invoke = () =>
    spawnSync(process.execPath, [checker, "--ci"], {
      cwd: repo.cwd,
      encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_PATH: eventPath },
    });
  writeFileSync(eventPath, JSON.stringify(event));
  assert.equal(invoke().status, 0);
  event.pull_request.title = "bad $(touch injected)";
  writeFileSync(eventPath, JSON.stringify(event));
  assert.equal(invoke().status, 1);
  assert.throws(() => readFileSync(join(repo.cwd, "injected")));
});
