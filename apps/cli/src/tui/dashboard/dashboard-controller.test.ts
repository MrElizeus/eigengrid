// ────────────────────────────────────────────────────────────
// DashboardController — deterministic state machine tests
// ────────────────────────────────────────────────────────────
// No Ink/React involved: a fake DashboardDataSource and injectable
// timer/clock seams make initial load, refresh, overlap prevention,
// error retention, selection stability, and cleanup deterministic.
// ────────────────────────────────────────────────────────────

import { describe, expect, it } from "bun:test";
import type { JobRecord, NodeRecord } from "@eigengrid/db";
import type {
  DashboardDataSource,
  DashboardFetchOptions,
  DashboardSnapshot,
} from "../../composition/types";
import { DashboardController } from "./dashboard-controller";

function makeJob(id: string, status = "queued"): JobRecord {
  return {
    id,
    name: `job-${id}`,
    software: "gaussian",
    inputPath: "in.gjf",
    workdir: "/tmp",
    outputPath: null,
    nodeId: null,
    status,
    ownerUserId: null,
    projectId: null,
    backend: null,
    externalJobId: null,
    externalState: null,
    lastSyncAt: null,
    nativeDetail: null,
    nodeName: null,
    cpuThreads: 1,
    memoryMb: 1024,
    scratchMb: 1024,
    priority: "normal",
    jobFamily: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeNode(id: string): NodeRecord {
  return {
    id,
    name: `node-${id}`,
    host: "localhost",
    user: "ops",
    runner: "local",
    status: "online",
    tagsJson: "[]",
    maxJobs: 2,
    engines: "local",
    cpuThreadsTotal: 4,
    memoryMbTotal: 4096,
    scratchMbTotal: 8192,
    draining: false,
    thermalState: "ok",
    lastSeenAt: null,
    isHead: true,
    powerMode: "on",
    macAddress: null,
    broadcastAddress: null,
    wolPort: null,
    allowWake: false,
    allowPowerDown: false,
    idlePowerDownAfterSec: null,
    lastWakeAt: null,
    lastPowerDownAt: null,
    port: 22,
    privateKeyPath: null,
    remoteScratchDir: "/tmp",
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeSnapshot(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    jobs: [],
    nodes: [],
    logs: [],
    events: [],
    timeline: [],
    fetchedAt: 0,
    ...overrides,
  };
}

/**
 * Fake data source with queued results/errors and optional manual
 * settling so tests can interleave refreshes deterministically.
 */
class FakeDataSource implements DashboardDataSource {
  fetchCount = 0;
  readonly calls: DashboardFetchOptions[] = [];
  readonly results: DashboardSnapshot[] = [];
  readonly errors: Error[] = [];
  autoResolve = true;
  readonly #pending: Array<() => void> = [];

  async fetch(options: DashboardFetchOptions = {}): Promise<DashboardSnapshot> {
    this.fetchCount += 1;
    this.calls.push(options);
    if (this.autoResolve) {
      const err = this.errors.shift();
      if (err) throw err;
      return this.results.shift() ?? makeSnapshot();
    }
    return new Promise<DashboardSnapshot>((resolve, reject) => {
      this.#pending.push(() => {
        const err = this.errors.shift();
        if (err) {
          reject(err);
          return;
        }
        resolve(this.results.shift() ?? makeSnapshot());
      });
    });
  }

  settleNext(): void {
    const settle = this.#pending.shift();
    if (settle) settle();
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error("waitFor timed out");
}

describe("DashboardController", () => {
  it("clears old evidence and rejects a response for a superseded selection", async () => {
    const ds = new FakeDataSource();
    const jobs = [makeJob("a"), makeJob("b")];
    ds.results.push(
      makeSnapshot({ jobs, logs: [{ stream: "stdout", line: "old evidence", createdAt: 1 }] }),
    );
    const controller = new DashboardController({ dataSource: ds, refreshIntervalMs: 0 });
    await controller.refresh();
    ds.autoResolve = false;
    controller.selectJob("a");
    expect(controller.snapshot?.logs).toEqual([]);
    controller.selectJob("b");
    ds.results.push(
      makeSnapshot({ jobs, logs: [{ stream: "stdout", line: "a evidence", createdAt: 2 }] }),
    );
    ds.settleNext();
    await waitFor(() => ds.calls.at(-1)?.jobId === "b");
    expect(controller.selectedJobId).toBe("b");
    expect(controller.snapshot?.logs).toEqual([]);
    ds.results.push(
      makeSnapshot({ jobs, logs: [{ stream: "stdout", line: "b evidence", createdAt: 3 }] }),
    );
    ds.settleNext();
    await waitFor(() => !controller.isRefreshing);
    expect(controller.snapshot?.logs[0]?.line).toBe("b evidence");
    controller.dispose();
  });

  it("ignores errors from the previously selected job", async () => {
    const ds = new FakeDataSource();
    ds.autoResolve = false;
    const controller = new DashboardController({ dataSource: ds, refreshIntervalMs: 0 });
    controller.selectJob("a");
    controller.selectJob("b");
    ds.errors.push(new Error("a cannot be fetched"));
    ds.settleNext();
    await waitFor(() => ds.calls.at(-1)?.jobId === "b");
    expect(controller.error).toBeNull();
    ds.results.push(makeSnapshot({ jobs: [makeJob("b")] }));
    ds.settleNext();
    await waitFor(() => !controller.isRefreshing);
    expect(controller.status).toBe("ready");
    controller.dispose();
  });

  it("transitions loading → empty on initial load", async () => {
    const ds = new FakeDataSource();
    const controller = new DashboardController({ dataSource: ds });

    expect(controller.status).toBe("loading");
    expect(controller.snapshot).toBeNull();
    expect(controller.refreshCount).toBe(0);

    controller.start();
    await waitFor(() => controller.snapshot !== null);

    expect(controller.status).toBe("empty");
    expect(controller.refreshCount).toBe(1);
    expect(controller.error).toBeNull();
    expect(ds.fetchCount).toBe(1);
  });

  it("shows live refresh changes on the same controller (no remount)", async () => {
    const ds = new FakeDataSource();
    ds.results.push(makeSnapshot({ jobs: [makeJob("job-1", "queued")] }));
    const controller = new DashboardController({ dataSource: ds });
    controller.start();
    await waitFor(() => controller.snapshot?.jobs[0]?.status === "queued");
    expect(controller.status).toBe("ready");

    // Simulate an external writer changing the DB, then refresh.
    ds.results.push(makeSnapshot({ jobs: [makeJob("job-1", "running")] }));
    await controller.refresh();

    expect(controller.snapshot?.jobs[0]?.status).toBe("running");
    expect(controller.status).toBe("ready");
    expect(controller.refreshCount).toBe(2);
  });

  it("prevents overlapping refreshes and queues one follow-up", async () => {
    const ds = new FakeDataSource();
    ds.autoResolve = false;
    ds.results.push(makeSnapshot({ jobs: [makeJob("job-1")] }));
    const controller = new DashboardController({ dataSource: ds });

    controller.start();
    expect(ds.fetchCount).toBe(1);

    await controller.refresh();
    await controller.refresh();
    await controller.refresh();
    expect(ds.fetchCount).toBe(1); // still the single in-flight fetch

    ds.settleNext();
    await waitFor(() => ds.fetchCount === 2); // exactly one follow-up
    ds.settleNext();
    await waitFor(() => controller.snapshot !== null);
    expect(controller.status).toBe("ready");
    await Bun.sleep(10);
    expect(ds.fetchCount).toBe(2); // no further overlap after settle
  });

  it("keeps selection stable across refreshes and scopes refetch to it", async () => {
    const ds = new FakeDataSource();
    const snapshotWithLogs = makeSnapshot({
      jobs: [makeJob("job-1"), makeJob("job-2")],
      logs: [{ stream: "stdout", line: "job-2 line", createdAt: 5 }],
    });
    ds.results.push(snapshotWithLogs);
    const controller = new DashboardController({ dataSource: ds });
    controller.start();
    await waitFor(() => controller.snapshot !== null);

    ds.results.push(snapshotWithLogs);
    controller.selectJob("job-2");
    await waitFor(() => controller.selectedJobId === "job-2");
    expect(ds.calls.at(-1)?.jobId).toBe("job-2");
    expect(controller.snapshot?.logs[0]?.line).toBe("job-2 line");

    // Refresh preserves selection and refetches the same job scope.
    ds.results.push(snapshotWithLogs);
    await controller.refresh();
    expect(controller.selectedJobId).toBe("job-2");
    expect(ds.calls.at(-1)?.jobId).toBe("job-2");
  });

  it("retains the last valid snapshot when a refresh errors (stale)", async () => {
    const ds = new FakeDataSource();
    ds.results.push(makeSnapshot({ jobs: [makeJob("job-1", "queued")] }));
    const controller = new DashboardController({ dataSource: ds });
    controller.start();
    await waitFor(() => controller.snapshot !== null);
    expect(controller.status).toBe("ready");

    ds.errors.push(new Error("db unavailable"));
    await controller.refresh();

    expect(controller.snapshot?.jobs[0]?.status).toBe("queued"); // retained
    expect(controller.status).toBe("stale");
    expect(controller.error).toBe("db unavailable");

    // Recovery on the next refresh.
    ds.results.push(makeSnapshot({ jobs: [makeJob("job-1", "queued")] }));
    await controller.refresh();
    expect(controller.status).toBe("ready");
    expect(controller.error).toBeNull();
    expect(controller.snapshot?.jobs[0]?.status).toBe("queued");
  });

  it("shows error status when the initial load fails", async () => {
    const ds = new FakeDataSource();
    ds.errors.push(new Error("boom"));
    const controller = new DashboardController({ dataSource: ds });
    controller.start();
    await waitFor(() => controller.error !== null);

    expect(controller.status).toBe("error");
    expect(controller.snapshot).toBeNull();
    expect(controller.error).toBe("boom");
  });

  it("exposes node and job data in ready state", async () => {
    const ds = new FakeDataSource();
    ds.results.push(makeSnapshot({ jobs: [makeJob("job-1")], nodes: [makeNode("node-1")] }));
    const controller = new DashboardController({ dataSource: ds });
    controller.start();
    await waitFor(() => controller.snapshot !== null);

    expect(controller.status).toBe("ready");
    expect(controller.snapshot?.nodes[0]?.name).toBe("node-node-1");
  });

  it("dispose clears the timer and stops periodic refreshes", async () => {
    const ds = new FakeDataSource();
    let handle: unknown = null;
    const cleared: unknown[] = [];
    const controller = new DashboardController({
      dataSource: ds,
      refreshIntervalMs: 10,
      setIntervalFn: (handler) => {
        handle = { handler };
        return handle;
      },
      clearIntervalFn: (timerHandle) => {
        cleared.push(timerHandle);
      },
    });
    controller.start();
    expect(handle).not.toBeNull();

    // Periodic tick triggers a refresh.
    (handle as { handler: () => void }).handler();
    await waitFor(() => ds.fetchCount >= 2);

    controller.dispose();
    expect(cleared).toEqual([handle]);
    expect(controller.isDisposed).toBe(true);

    // Ticks after dispose are no-ops.
    (handle as { handler: () => void }).handler();
    await Bun.sleep(10);
    expect(ds.fetchCount).toBe(2);
  });

  it("dispose during an in-flight fetch cancels state application and listeners", async () => {
    const ds = new FakeDataSource();
    ds.autoResolve = false;
    ds.results.push(makeSnapshot({ jobs: [makeJob("job-1")] }));
    const controller = new DashboardController({ dataSource: ds });
    let notified = 0;
    controller.subscribe(() => {
      notified += 1;
    });

    controller.start();
    expect(ds.fetchCount).toBe(1);
    expect(controller.snapshot).toBeNull();
    const notificationsBeforeDispose = notified; // from the isRefreshing notify

    controller.dispose();
    ds.settleNext(); // resolve after dispose
    await Bun.sleep(10);

    expect(controller.snapshot).toBeNull();
    expect(controller.refreshCount).toBe(0);
    expect(notified).toBe(notificationsBeforeDispose); // no notify after dispose
    expect(controller.isDisposed).toBe(true);
  });

  it("subscribe returns an unsubscribe that stops notifications", async () => {
    const controller = new DashboardController({ dataSource: new FakeDataSource() });
    let count = 0;
    const unsubscribe = controller.subscribe(() => {
      count += 1;
    });

    controller.selectJob("job-1");
    expect(count).toBeGreaterThanOrEqual(1);

    unsubscribe();
    const afterUnsubscribe = count;
    controller.selectJob("job-2");
    expect(count).toBe(afterUnsubscribe);
  });
});
