// ────────────────────────────────────────────────────────────
// dashboard command — ApplicationContext lifecycle through the
// Ink session
// ────────────────────────────────────────────────────────────
// Proves runDashboard keeps the context alive for the whole TUI
// session, disposes the controller (timer cancellation) before
// closing, and closes the context exactly once after exit.
// ────────────────────────────────────────────────────────────

import { describe, expect, it } from "bun:test";
import type { ReactElement } from "react";
import type { Config } from "@eigengrid/core";
import type { DatabaseLike } from "@eigengrid/db";
import type { PythonBridge } from "@eigengrid/python-bridge";
import { ApplicationContext } from "../composition";
import type { BackendRegistry, RecipeRegistry } from "../composition";
import { runDashboard } from "./dashboard";
import type { DashboardController } from "../tui/dashboard/dashboard-controller";

function createRecordingContext(sequence: string[]): ApplicationContext {
  const db = {
    _provider: "sqlite",
    init: async () => {},
    close: async () => {
      sequence.push("close");
    },
    listJobs: async () => [],
    listNodes: async () => [],
    getLogs: async () => [],
    getEvents: async () => [],
    listJobEvents: async () => [],
    getTimeline: async () => [],
  } as unknown as DatabaseLike;

  const bridge: PythonBridge = {
    parse: async () => ({ ok: true, parser: "test", status: "completed" }),
    generate: async () => ({ ok: true }),
    conformers: async () => ({ ok: true, conformers: 0 }),
    run: async () => ({ ok: true }),
  };

  const backends: BackendRegistry = {
    runners: new Map(),
    get: () => undefined,
    available: () => [],
  };

  const recipes: RecipeRegistry = {
    recipes: [],
    find: () => undefined,
    findRunnable: () => undefined,
  };

  return new ApplicationContext(
    { databasePath: ":memory:", dbProvider: "sqlite" } as Config,
    db,
    backends,
    bridge,
    recipes,
  );
}

describe("dashboard command lifecycle", () => {
  it("disposes the controller and closes the context if rendering throws", async () => {
    const sequence: string[] = [];
    const ctx = createRecordingContext(sequence);
    const captured: { controller: DashboardController | null } = { controller: null };
    await expect(
      runDashboard({
        createContext: async () => ctx,
        render: (node) => {
          captured.controller = (
            node as ReactElement<{ controller: DashboardController }>
          ).props.controller;
          throw new Error("terminal failed");
        },
      }),
    ).rejects.toThrow("terminal failed");
    expect(captured.controller?.isDisposed).toBe(true);
    expect(sequence).toEqual(["close"]);
  });

  it("keeps the context alive through the session and closes exactly once after exit", async () => {
    const sequence: string[] = [];
    const ctx = createRecordingContext(sequence);
    const captured: { controller: DashboardController | null } = { controller: null };

    const renderSeam = (node: unknown) => {
      const element = node as ReactElement<{ controller: DashboardController }>;
      captured.controller = element.props.controller;
      return { waitUntilExit: async () => {} };
    };

    await runDashboard({ createContext: async () => ctx, render: renderSeam });

    expect(captured.controller).not.toBeNull();
    expect(captured.controller?.isDisposed).toBe(true);
    expect(sequence).toEqual(["close"]);
  });

  it("does not close the context until the session exits, then disposes before closing", async () => {
    const sequence: string[] = [];
    const ctx = createRecordingContext(sequence);
    const captured: { controller: DashboardController | null } = { controller: null };
    let resolveExit!: () => void;

    const renderSeam = (node: unknown) => {
      const element = node as ReactElement<{ controller: DashboardController }>;
      captured.controller = element.props.controller;
      return {
        waitUntilExit: () =>
          new Promise<void>((resolve) => {
            resolveExit = resolve;
          }),
      };
    };

    const pending = runDashboard({ createContext: async () => ctx, render: renderSeam });
    await Bun.sleep(20);

    // Session still active: context open, controller alive.
    expect(captured.controller).not.toBeNull();
    expect(captured.controller?.isDisposed).toBe(false);
    expect(sequence).toEqual([]);

    resolveExit();
    await pending;

    // After exit: controller disposed (timer cancelled) then context closed once.
    expect(captured.controller?.isDisposed).toBe(true);
    expect(sequence).toEqual(["close"]);
  });
});
