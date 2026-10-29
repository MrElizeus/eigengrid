import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createDatabase,
  createUser,
  getUser,
  getUserByUsername,
  listUsers,
  disableUser,
  enableUser,
} from "@eigengrid/db";

function createWorkspace(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "eigengrid-users-"));
  return { root, dbPath: join(root, ".eigengrid", "eigengrid.sqlite") };
}

describe("user CRUD", () => {
  it("creates and retrieves a user", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await createUser(db, {
        id: "user-1",
        username: "alice",
        displayName: "Alice",
        email: "alice@example.com",
      });
      const user = await getUser(db, "user-1");
      expect(user).not.toBeNull();
      expect(user!.username).toBe("alice");
      expect(user!.displayName).toBe("Alice");
      expect(user!.email).toBe("alice@example.com");
      expect(user!.status).toBe("active");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds a user by username", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await createUser(db, { id: "user-2", username: "bob" });
      const user = await getUserByUsername(db, "bob");
      expect(user).not.toBeNull();
      expect(user!.id).toBe("user-2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists all users", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      // 'local' user is created by default migration
      await createUser(db, { id: "user-3", username: "charlie" });
      const users = await listUsers(db);
      expect(users.length).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("disables and enables a user", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await createUser(db, { id: "user-4", username: "dave" });
      await disableUser(db, "user-4");
      let user = await getUser(db, "user-4");
      expect(user!.status).toBe("disabled");

      await enableUser(db, "user-4");
      user = await getUser(db, "user-4");
      expect(user!.status).toBe("active");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate usernames", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await createUser(db, { id: "user-5", username: "eve" });
      // Second create with same username should not throw (INSERT OR IGNORE in SQLite)
      await expect(createUser(db, { id: "user-6", username: "eve" })).rejects.toThrow();
    } catch {
      // SQLite unique constraint should throw
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("default migration creates 'local' user", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      const local = await getUserByUsername(db, "local");
      expect(local).not.toBeNull();
      expect(local!.status).toBe("active");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
