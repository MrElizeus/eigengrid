import { describe, expect, test } from "bun:test";
import { $ } from "bun";

describe("CLI smoke tests", () => {
  test("eigengrid --help prints usage", async () => {
    const result = await $`bun run apps/cli/bin/eigengrid.ts --help`.nothrow().quiet();
    expect(result.exitCode).toBe(0);
    expect(result.text()).toMatch(/eigengrid/i);
  });

  test("eigengrid doctor checks environment", async () => {
    const result = await $`bun run apps/cli/bin/eigengrid.ts doctor`.nothrow().quiet();
    expect(result.exitCode).toBe(0);
  });
});
