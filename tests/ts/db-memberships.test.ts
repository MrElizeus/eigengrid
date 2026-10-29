import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createDatabase,
  createUser,
  createProject,
  addProjectMember,
  removeProjectMember,
  listProjectMembers,
  listUserProjects,
} from "@eigengrid/db";

function createWorkspace(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "eigengrid-mem-"));
  return { root, dbPath: join(root, ".eigengrid", "eigengrid.sqlite") };
}

describe("memberships", () => {
  it("adds a member to a project", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await createUser(db, { id: "u-1", username: "member1" });
      await createProject(db, { id: "p-1", name: "shared-project" });
      await addProjectMember(db, "p-1", "u-1", "admin");

      const members = await listProjectMembers(db, "p-1");
      expect(members).toHaveLength(1);
      expect(members[0].userId).toBe("u-1");
      expect(members[0].role).toBe("admin");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes a member from a project", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await createUser(db, { id: "u-2", username: "member2" });
      await createProject(db, { id: "p-2", name: "test-project" });
      await addProjectMember(db, "p-2", "u-2");
      await removeProjectMember(db, "p-2", "u-2");

      const members = await listProjectMembers(db, "p-2");
      expect(members).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists multiple members of a project", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await createUser(db, { id: "u-3", username: "alice" });
      await createUser(db, { id: "u-4", username: "bob" });
      await createProject(db, { id: "p-3", name: "team-project" });

      await addProjectMember(db, "p-3", "u-3", "owner");
      await addProjectMember(db, "p-3", "u-4", "member");

      const members = await listProjectMembers(db, "p-3");
      expect(members).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists projects for a user", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await createUser(db, { id: "u-5", username: "multi" });
      await createProject(db, { id: "p-4", name: "project-a" });
      await createProject(db, { id: "p-5", name: "project-b" });

      await addProjectMember(db, "p-4", "u-5");
      await addProjectMember(db, "p-5", "u-5");

      const projects = await listUserProjects(db, "u-5");
      expect(projects).toHaveLength(2);
      expect(projects.map((p: any) => p.name).sort()).toEqual(["project-a", "project-b"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is idempotent adding the same member twice", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await createUser(db, { id: "u-6", username: "dup" });
      await createProject(db, { id: "p-6", name: "dup-project" });

      await addProjectMember(db, "p-6", "u-6");
      await addProjectMember(db, "p-6", "u-6"); // second add should be ignored

      const members = await listProjectMembers(db, "p-6");
      expect(members).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
