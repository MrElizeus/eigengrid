import { expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guard test to detect process.chdir() leaks.
 *
 * The test suite MUST run from the repository root. If any concurrent test
 * file calls process.chdir() without restoring it, this guard may catch it
 * (though not deterministically — Bun runs test files in parallel).
 *
 * Restore process state in finally blocks; see CONTRIBUTING.md.
 */
test("test suite runs from repository root", () => {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  expect(process.cwd()).toBe(repositoryRoot);
});
