// ────────────────────────────────────────────────────────────
// DashboardController — deterministic dashboard state owner
// ────────────────────────────────────────────────────────────
// Owns the read-only dashboard state machine: initial load,
// bounded periodic/manual refresh with no overlap, stable job
// selection, loading/empty/stale/error state retention, and
// cancellation via dispose(). Never mutates application data —
// it only calls DashboardDataSource.fetch().
//
// Timer functions are injectable so tests can assert cleanup
// deterministically without real timers.
// ────────────────────────────────────────────────────────────

import type { DashboardDataSource, DashboardSnapshot } from "../../composition/types";

export type DashboardStatus = "loading" | "ready" | "empty" | "error" | "stale";

export interface DashboardView {
  readonly status: DashboardStatus;
  readonly snapshot: DashboardSnapshot | null;
  readonly error: string | null;
  readonly selectedJobId: string | null;
  readonly isRefreshing: boolean;
  readonly refreshCount: number;
  readonly lastFetchedAt: number | null;
}

export interface DashboardControllerOptions {
  dataSource: DashboardDataSource;
  /** Periodic refresh interval in ms. 0 or negative disables the timer. */
  refreshIntervalMs?: number;
  clock?: () => number;
  setIntervalFn?: (handler: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

type Listener = () => void;

export class DashboardController {
  readonly #dataSource: DashboardDataSource;
  readonly #refreshIntervalMs: number;
  readonly #clock: () => number;
  readonly #setIntervalFn: (handler: () => void, ms: number) => unknown;
  readonly #clearIntervalFn: (handle: unknown) => void;

  #snapshot: DashboardSnapshot | null = null;
  #error: string | null = null;
  #selectedJobId: string | null = null;
  #isRefreshing = false;
  #refreshCount = 0;
  #lastFetchedAt: number | null = null;
  #disposed = false;
  #pendingRefresh = false;
  #timer: unknown = null;
  readonly #listeners = new Set<Listener>();

  constructor(options: DashboardControllerOptions) {
    this.#dataSource = options.dataSource;
    this.#refreshIntervalMs = options.refreshIntervalMs ?? 5000;
    this.#clock = options.clock ?? Date.now;
    this.#setIntervalFn = options.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms));
    this.#clearIntervalFn =
      options.clearIntervalFn ??
      ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  get status(): DashboardStatus {
    if (this.#snapshot === null) {
      return this.#error !== null ? "error" : "loading";
    }
    if (this.#error !== null) return "stale";
    if (this.#snapshot.jobs.length === 0 && this.#snapshot.nodes.length === 0) return "empty";
    return "ready";
  }

  get snapshot(): DashboardSnapshot | null {
    return this.#snapshot;
  }

  get selectedJobId(): string | null {
    return this.#selectedJobId;
  }

  get isRefreshing(): boolean {
    return this.#isRefreshing;
  }

  get refreshCount(): number {
    return this.#refreshCount;
  }

  get lastFetchedAt(): number | null {
    return this.#lastFetchedAt;
  }

  get error(): string | null {
    return this.#error;
  }

  get isDisposed(): boolean {
    return this.#disposed;
  }

  getView(): DashboardView {
    return {
      status: this.status,
      snapshot: this.#snapshot,
      error: this.#error,
      selectedJobId: this.#selectedJobId,
      isRefreshing: this.#isRefreshing,
      refreshCount: this.#refreshCount,
      lastFetchedAt: this.#lastFetchedAt,
    };
  }

  /** Initial load + start the periodic timer (if any). Idempotent. */
  start(): void {
    if (this.#disposed) return;
    if (this.#timer === null && this.#refreshIntervalMs > 0) {
      this.#timer = this.#setIntervalFn(() => {
        void this.refresh();
      }, this.#refreshIntervalMs);
    }
    void this.refresh();
  }

  /**
   * Manual or periodic refresh. Never overlaps: if a refresh is
   * already in flight, the request is remembered and re-run once
   * the in-flight fetch settles.
   */
  async refresh(): Promise<void> {
    if (this.#disposed) return;
    if (this.#isRefreshing) {
      this.#pendingRefresh = true;
      return;
    }
    this.#isRefreshing = true;
    this.#pendingRefresh = false;
    this.#notify();
    const jobId = this.#selectedJobId;
    try {
      const snapshot = await this.#dataSource.fetch({ jobId: jobId ?? undefined });
      if (!this.#disposed && jobId === this.#selectedJobId) {
        this.#snapshot = snapshot;
        this.#error = null;
        this.#refreshCount += 1;
        this.#lastFetchedAt = this.#clock();
      }
    } catch (err) {
      if (!this.#disposed && jobId === this.#selectedJobId) {
        // Retain the last valid snapshot; expose the failure as stale/error.
        this.#error = err instanceof Error ? err.message : String(err);
      }
    }
    if (this.#disposed) return;
    this.#isRefreshing = false;
    this.#notify();
    if (this.#pendingRefresh) {
      this.#pendingRefresh = false;
      void this.refresh();
    }
  }

  /** Change the selected job. Selection is stable across refreshes. */
  selectJob(jobId: string | null): void {
    if (this.#disposed) return;
    if (this.#selectedJobId === jobId) return;
    this.#selectedJobId = jobId;
    // Evidence is scoped to the previous selection until a matching fetch completes.
    // Never show that evidence under the newly selected job's identity.
    if (this.#snapshot) {
      this.#snapshot = { ...this.#snapshot, logs: [], events: [], timeline: [] };
    }
    this.#notify();
    void this.refresh();
  }

  /**
   * Cancel the session: clears the timer, stops applying in-flight
   * results, and drops listeners. Safe to call more than once.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#timer !== null) {
      this.#clearIntervalFn(this.#timer);
      this.#timer = null;
    }
    this.#listeners.clear();
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #notify(): void {
    for (const listener of Array.from(this.#listeners)) listener();
  }
}
