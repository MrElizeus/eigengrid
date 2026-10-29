import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ensureWorkerLayout,
  checkWorkerLayout,
  getInboxDir,
  getRunningDir,
  getDoneDir,
  getFailedDir,
  getCancelledDir,
  getLocksDir,
  getDaemonDir,
  getInboxBundlePath,
  getRunningBundlePath,
  getDoneBundlePath,
  getFailedBundlePath,
  getCancelledBundlePath,
} from "@eigengrid/worker";

// ────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────

describe("ensureWorkerLayout", () => {
  test("creates all 8 subdirectories", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-layout-"));
    try {
      ensureWorkerLayout(tmpDir);

      const expected = [
        "inbox",
        "running",
        "done",
        "failed",
        "cancelled",
        "orphaned",
        "locks",
        "daemon",
      ];
      for (const dir of expected) {
        expect(existsSync(join(tmpDir, dir))).toBe(true);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("is idempotent when directories already exist", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-layout-"));
    try {
      ensureWorkerLayout(tmpDir);
      // Call again — should not throw
      expect(() => ensureWorkerLayout(tmpDir)).not.toThrow();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("checkWorkerLayout", () => {
  test("returns ok=true when all directories exist", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-layout-"));
    try {
      ensureWorkerLayout(tmpDir);
      const result = checkWorkerLayout(tmpDir);
      expect(result.ok).toBe(true);
      expect(result.missing).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns ok=false with missing dirs listed when none exist", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-layout-"));
    try {
      const result = checkWorkerLayout(tmpDir);
      expect(result.ok).toBe(false);
      expect(result.missing.sort()).toEqual([
        "cancelled",
        "daemon",
        "done",
        "failed",
        "inbox",
        "locks",
        "orphaned",
        "running",
      ]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns ok=false with specific missing dirs when only some exist", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-layout-"));
    try {
      // Create only inbox and done
      mkdirSync(join(tmpDir, "inbox"), { recursive: true });
      mkdirSync(join(tmpDir, "done"), { recursive: true });

      const result = checkWorkerLayout(tmpDir);
      expect(result.ok).toBe(false);
      expect(result.missing.sort()).toEqual([
        "cancelled",
        "daemon",
        "failed",
        "locks",
        "orphaned",
        "running",
      ]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("path helpers", () => {
  const scratchDir = "/scratch/eigengrid";

  test("getInboxDir returns correct path", () => {
    expect(getInboxDir(scratchDir)).toBe("/scratch/eigengrid/inbox");
  });

  test("getRunningDir returns correct path", () => {
    expect(getRunningDir(scratchDir)).toBe("/scratch/eigengrid/running");
  });

  test("getDoneDir returns correct path", () => {
    expect(getDoneDir(scratchDir)).toBe("/scratch/eigengrid/done");
  });

  test("getFailedDir returns correct path", () => {
    expect(getFailedDir(scratchDir)).toBe("/scratch/eigengrid/failed");
  });

  test("getCancelledDir returns correct path", () => {
    expect(getCancelledDir(scratchDir)).toBe("/scratch/eigengrid/cancelled");
  });

  test("getLocksDir returns correct path", () => {
    expect(getLocksDir(scratchDir)).toBe("/scratch/eigengrid/locks");
  });

  test("getDaemonDir returns correct path", () => {
    expect(getDaemonDir(scratchDir)).toBe("/scratch/eigengrid/daemon");
  });

  test("getInboxBundlePath returns correct path", () => {
    expect(getInboxBundlePath(scratchDir, "job-001")).toBe("/scratch/eigengrid/inbox/job-001");
  });

  test("getRunningBundlePath returns correct path", () => {
    expect(getRunningBundlePath(scratchDir, "job-001")).toBe("/scratch/eigengrid/running/job-001");
  });

  test("getDoneBundlePath returns correct path", () => {
    expect(getDoneBundlePath(scratchDir, "job-001")).toBe("/scratch/eigengrid/done/job-001");
  });

  test("getFailedBundlePath returns correct path", () => {
    expect(getFailedBundlePath(scratchDir, "job-001")).toBe("/scratch/eigengrid/failed/job-001");
  });

  test("getCancelledBundlePath returns correct path", () => {
    expect(getCancelledBundlePath(scratchDir, "job-001")).toBe(
      "/scratch/eigengrid/cancelled/job-001",
    );
  });
});
