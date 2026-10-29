// ────────────────────────────────────────────────────────────
// eigengrid dashboard — live read-only operational TUI
// ────────────────────────────────────────────────────────────
// The ApplicationContext is created via runWithContext so it stays
// alive for the whole Ink session and is closed exactly once after
// the session exits. The controller is disposed (timers cancelled)
// before the context closes. All dashboard reads flow through
// ctx.dashboard (DashboardDataSource) — no direct DB access here.
// ────────────────────────────────────────────────────────────

import type { CommandModule } from "yargs";
import type { ReactNode } from "react";
import { runWithContext, type CreateContextFn } from "../composition";

export type DashboardRenderInstance = { waitUntilExit(): Promise<void> };
export type DashboardRenderSeam = (
  node: ReactNode,
  options?: { exitOnCtrlC?: boolean },
) => DashboardRenderInstance;

export interface DashboardDependencies {
  /** Test seam for context creation (defaults to createApplicationContext). */
  createContext?: CreateContextFn;
  /** Test seam for Ink rendering. */
  render?: DashboardRenderSeam;
}

export const dashboardCommand: CommandModule = {
  command: "dashboard",
  describe: "Launch live read-only operational dashboard (Ink)",
  async handler() {
    await runDashboard();
  },
};

export async function runDashboard(deps: DashboardDependencies = {}): Promise<void> {
  if (!deps.render && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error(
      "The dashboard needs an interactive terminal. Use eigengrid status --json for redirected output.",
    );
  }
  const { render } = await import("ink");
  const { default: React } = await import("react");
  const { App } = await import("../tui/App");
  const { DashboardController } = await import("../tui/dashboard/dashboard-controller");

  const renderApp: DashboardRenderSeam = deps.render ?? ((node, options) => render(node, options));

  await runWithContext(async (ctx) => {
    const controller = new DashboardController({
      dataSource: ctx.dashboard,
      refreshIntervalMs: 5000,
    });
    controller.start();
    try {
      const instance = renderApp(React.createElement(App, { controller }), {
        exitOnCtrlC: true,
      });
      await instance.waitUntilExit();
    } finally {
      controller.dispose();
    }
  }, deps.createContext);
}
