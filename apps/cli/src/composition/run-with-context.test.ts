import { describe, expect, it } from "bun:test";
import { ApplicationContext } from "./context";
import { runWithContext } from "./run-with-context";
import type { Config } from "@eigengrid/core";
import type { DatabaseLike } from "@eigengrid/db";
import type { PythonBridge } from "@eigengrid/python-bridge";
import type { BackendRegistry, RecipeRegistry } from "./types";

/**
 * Minimal fake ApplicationContext factory for lifecycle tests.
 * Records close-sequence events so we can verify ordering.
 */
function createFakeContext(sequence: string[], label: string): ApplicationContext {
  const db = {
    _provider: "sqlite" as const,
    init: async () => {},
    close: async () => {
      sequence.push(`close:${label}`);
    },
  } as unknown as DatabaseLike;

  const backends: BackendRegistry = {
    runners: new Map(),
    get: () => undefined,
    available: () => [],
  };

  const bridge: PythonBridge = {
    parse: async () => ({ ok: true, parser: "test", status: "completed" as const, data: {} }),
    generate: async () => ({ ok: true }),
    conformers: async () => ({ ok: true, conformers: 0 }),
    run: async () => ({ ok: true, stdout: "", stderr: "" }),
  };

  const recipeRegistry: RecipeRegistry = {
    recipes: [],
    find: () => undefined,
    findRunnable: () => undefined,
  };

  return new ApplicationContext(
    { databasePath: ":memory:", dbProvider: "sqlite" } as Config,
    db,
    backends,
    bridge,
    recipeRegistry,
  );
}

describe("runWithContext lifecycle", () => {
  it("passes the context to the callback and closes after completion", async () => {
    const sequence: string[] = [];

    const result = await runWithContext(
      async (ctx) => {
        sequence.push("callback-start");
        expect(ctx).toBeInstanceOf(ApplicationContext);
        sequence.push("callback-end");
        return 42;
      },
      async () => createFakeContext(sequence, "ctx"),
    );

    expect(result).toBe(42);
    expect(sequence).toEqual(["callback-start", "callback-end", "close:ctx"]);
  });

  it("calls close exactly once on success", async () => {
    const sequence: string[] = [];

    await runWithContext(
      async (ctx) => {
        sequence.push("callback");
        expect(ctx).toBeInstanceOf(ApplicationContext);
      },
      async () => createFakeContext(sequence, "ctx"),
    );

    // close should appear exactly once
    const closeCalls = sequence.filter((s) => s.startsWith("close:"));
    expect(closeCalls).toHaveLength(1);
  });

  it("propagates callback error and still calls close exactly once", async () => {
    const sequence: string[] = [];
    const testError = new Error("callback-failure");

    await expect(
      runWithContext(
        async (_ctx) => {
          sequence.push("callback-start");
          throw testError;
        },
        async () => createFakeContext(sequence, "ctx"),
      ),
    ).rejects.toThrow("callback-failure");

    expect(sequence).toContain("close:ctx");

    // close should appear exactly once
    const closeCalls = sequence.filter((s) => s.startsWith("close:"));
    expect(closeCalls).toHaveLength(1);

    // callback-start should appear before close
    const cbIdx = sequence.indexOf("callback-start");
    const closeIdx = sequence.indexOf("close:ctx");
    expect(cbIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeGreaterThan(cbIdx);
  });

  it("does not swallow the original error on throw", async () => {
    const testError = new Error("original-error-preserved");

    let caught: unknown;
    try {
      await runWithContext(
        async (_ctx) => {
          throw testError;
        },
        async () => {
          // Return a context whose close does NOT throw
          const ctx = createFakeContext([], "ctx");
          return ctx;
        },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(testError);
  });
});
