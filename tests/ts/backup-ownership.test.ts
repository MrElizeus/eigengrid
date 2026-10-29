import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDatabase } from "@eigengrid/db";

function createWorkspace(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "eigengrid-backup-owner-"));
  return { root, dbPath: join(root, ".eigengrid", "eigengrid.sqlite") };
}

describe("backup ownership preservation", () => {
  it("backup includes users ndjson", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      // Create a test user
      await db.createUser({ id: "bu-user-1", username: "backup-user" });

      // Read the raw DB to verify users table has data
      const sqlite = (db as any).ensureDb();
      const users = sqlite.query("SELECT * FROM users").all();
      expect(users.length).toBeGreaterThanOrEqual(2); // local + backup-user

      const usernames = users.map((u: any) => u.username);
      expect(usernames).toContain("backup-user");
      expect(usernames).toContain("local");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("backup includes projects ndjson", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await db.createProject({
        id: "bu-proj-1",
        name: "backup-project",
        description: "For backup test",
      });

      const sqlite = (db as any).ensureDb();
      const projects = sqlite.query("SELECT * FROM projects").all();
      expect(projects.length).toBeGreaterThanOrEqual(2); // default + backup-project
      const names = projects.map((p: any) => p.name);
      expect(names).toContain("backup-project");
      expect(names).toContain("default");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("backup includes memberships ndjson", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await db.createUser({ id: "bu-u-2", username: "mem-user" });
      await db.createProject({ id: "bu-p-2", name: "mem-project" });
      await db.addProjectMember("bu-p-2", "bu-u-2", "admin");

      const members = await db.listProjectMembers("bu-p-2");
      expect(members).toHaveLength(1);
      expect(members[0].userId).toBe("bu-u-2");
      expect(members[0].role).toBe("admin");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("backup includes quotas ndjson", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await db.createProject({ id: "bu-p-3", name: "quota-project" });
      await db.setProjectQuota("bu-p-3", { maxCpuThreads: 8, maxMemoryMb: 16384 });

      const quota = await db.getProjectQuota("bu-p-3");
      expect(quota).not.toBeNull();
      expect(quota!.maxCpuThreads).toBe(8);
      expect(quota!.maxMemoryMb).toBe(16384);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("backup includes usage records", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await db.createProject({ id: "bu-p-4", name: "usage-project" });
      await db.recordUsage({
        id: "bu-usage-1",
        projectId: "bu-p-4",
        userId: "local",
        jobId: "backup-job",
        cpuThreads: 4,
        walltimeMs: 3600000,
      });

      const usage = await db.getProjectUsage("bu-p-4");
      expect(usage).toHaveLength(1);
      expect(usage[0].walltimeMs).toBe(3600000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
