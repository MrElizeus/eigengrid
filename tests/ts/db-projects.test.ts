import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createDatabase,
  createProject,
  getProject,
  getProjectByName,
  listProjects,
  archiveProject,
  resolveProjectId,
} from "@eigengrid/db";

function createWorkspace(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "eigengrid-proj-"));
  return { root, dbPath: join(root, ".eigengrid", "eigengrid.sqlite") };
}

describe("project CRUD", () => {
  it("creates and retrieves a project", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await createProject(db, {
        id: "proj-1",
        name: "water-analysis",
        description: "Water DFT analysis",
        maxConcurrentJobs: 5,
      });
      const p = await getProject(db, "proj-1");
      expect(p).not.toBeNull();
      expect(p!.name).toBe("water-analysis");
      expect(p!.description).toBe("Water DFT analysis");
      expect(p!.maxConcurrentJobs).toBe(5);
      expect(p!.status).toBe("active");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds a project by name", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await createProject(db, { id: "proj-2", name: "organic-opt" });
      const p = await getProjectByName(db, "organic-opt");
      expect(p).not.toBeNull();
      expect(p!.id).toBe("proj-2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists all projects", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      // 'default' project created by migration
      await createProject(db, { id: "proj-3", name: "catalyst-screening" });
      const projects = await listProjects(db);
      expect(projects.length).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("archives a project", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await createProject(db, { id: "proj-4", name: "old-research" });
      await archiveProject(db, "proj-4");
      const p = await getProject(db, "proj-4");
      expect(p!.status).toBe("archived");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves project by ID prefix", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await createProject(db, { id: "proj-prefix-1", name: "resolve-test" });
      const resolved = await resolveProjectId(db, "proj-prefix");
      expect(resolved).toBe("proj-prefix-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves project by name", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await createProject(db, { id: "proj-5", name: "by-name" });
      const resolved = await resolveProjectId(db, "by-name");
      expect(resolved).toBe("proj-5");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("default migration creates 'default' project", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      const def = await getProjectByName(db, "default");
      expect(def).not.toBeNull();
      expect(def!.status).toBe("active");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
