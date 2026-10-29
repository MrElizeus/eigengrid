import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createDatabase,
  createProject,
  getProjectQuota,
  setProjectQuota,
  recordUsage,
  getProjectUsage,
  getProjectAggregatedUsage,
} from "@eigengrid/db";

function createWorkspace(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "eigengrid-quota-"));
  return { root, dbPath: join(root, ".eigengrid", "eigengrid.sqlite") };
}

describe("quotas", () => {
  it("sets and retrieves project quota", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await createProject(db, { id: "q-proj-1", name: "quota-test" });
      await setProjectQuota(db, "q-proj-1", {
        maxCpuThreads: 16,
        maxMemoryMb: 65536,
        maxScratchMb: 102400,
        maxJobsTotal: 50,
      });

      const quota = await getProjectQuota(db, "q-proj-1");
      expect(quota).not.toBeNull();
      expect(quota!.maxCpuThreads).toBe(16);
      expect(quota!.maxMemoryMb).toBe(65536);
      expect(quota!.maxScratchMb).toBe(102400);
      expect(quota!.maxJobsTotal).toBe(50);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("updates existing quota partially", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await createProject(db, { id: "q-proj-2", name: "partial-update" });
      await setProjectQuota(db, "q-proj-2", { maxCpuThreads: 8, maxMemoryMb: 32768 });
      await setProjectQuota(db, "q-proj-2", { maxCpuThreads: 16 }); // update only CPU

      const quota = await getProjectQuota(db, "q-proj-2");
      expect(quota!.maxCpuThreads).toBe(16);
      expect(quota!.maxMemoryMb).toBe(32768); // unchanged
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null for project without quota", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await createProject(db, { id: "q-proj-3", name: "no-quota" });
      const quota = await getProjectQuota(db, "q-proj-3");
      expect(quota).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("usage accounting", () => {
  it("records and retrieves project usage", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await createProject(db, { id: "u-proj-1", name: "usage-test" });
      await recordUsage(db, {
        id: "usage-1",
        projectId: "u-proj-1",
        userId: "local",
        jobId: "job-1",
        cpuThreads: 4,
        memoryMb: 8192,
        scratchMb: 10240,
      });
      await recordUsage(db, {
        id: "usage-2",
        projectId: "u-proj-1",
        userId: "local",
        jobId: "job-2",
        cpuThreads: 8,
        memoryMb: 16384,
        scratchMb: 20480,
      });

      const usage = await getProjectUsage(db, "u-proj-1");
      expect(usage).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("computes aggregated project usage", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await createProject(db, { id: "u-proj-2", name: "agg-test" });
      await recordUsage(db, {
        id: "u-3",
        projectId: "u-proj-2",
        userId: "local",
        jobId: "j-1",
        cpuThreads: 2,
        memoryMb: 4096,
      });
      await recordUsage(db, {
        id: "u-4",
        projectId: "u-proj-2",
        userId: "local",
        jobId: "j-2",
        cpuThreads: 4,
        memoryMb: 8192,
      });

      const agg = await getProjectAggregatedUsage(db, "u-proj-2");
      expect(agg.totalCpuThreads).toBe(6);
      expect(agg.totalMemoryMb).toBe(12288);
      expect(agg.jobCount).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retrieves usage by user", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await createProject(db, { id: "u-proj-3", name: "user-usage" });
      await recordUsage(db, { id: "u-5", projectId: "u-proj-3", userId: "testuser", jobId: "j-3" });

      const usage = await db.getUserUsage("testuser");
      expect(usage).toHaveLength(1);
      expect(usage[0].projectId).toBe("u-proj-3");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
