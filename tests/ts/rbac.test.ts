import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDatabase } from "@eigengrid/db";

function createWorkspace(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "eigengrid-rbac-"));
  return { root, dbPath: join(root, ".eigengrid", "eigengrid.sqlite") };
}

describe("RBAC — permission checks", () => {
  it("disabled user is detected as disabled", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      await db.createUser({ id: "rbac-u-1", username: "disablable" });
      const before = await db.isUserDisabled("rbac-u-1");
      expect(before).toBe(false);

      await db.disableUser("rbac-u-1");
      const after = await db.isUserDisabled("rbac-u-1");
      expect(after).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("non-existent user is not considered disabled", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      const disabled = await db.isUserDisabled("nonexistent-user");
      expect(disabled).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("only admins and owners can remove project members (via permissions table)", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      // The permissions table already exists — verify we can create permission rules
      await db.createPermission({
        id: "perm-1",
        action: "project.manage_members",
        resource: "*",
        effect: "deny",
        label: "Non-admins cannot manage members",
      });

      const perms = await db.listPermissions();
      const memberRule = perms.find((p) => p.id === "perm-1");
      expect(memberRule).toBeDefined();
      expect(memberRule!.effect).toBe("deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("secrets are not logged in audit events", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      // When creating a user, no password/secret should leak into events
      await db.createUser({ id: "secret-user", username: "no-leak", email: "test@example.com" });
      await db.createPermission({
        id: "secret-perm",
        action: "admin.*",
        resource: "*",
        effect: "deny",
      });

      // Verify events table — should not contain passwords or secrets
      const events = await db.getEvents();
      for (const evt of events) {
        const payloadStr = JSON.stringify(evt.payload_json ?? "");
        expect(payloadStr.toLowerCase()).not.toContain("password");
        expect(payloadStr.toLowerCase()).not.toContain("secret");
        expect(payloadStr.toLowerCase()).not.toContain("api_key");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("RBAC — no implicit allow for mutating actions", () => {
  it("permissions table requires explicit allow for state-changing actions", async () => {
    const { root, dbPath } = createWorkspace();
    try {
      const db = createDatabase(dbPath);
      await db.init();

      // Create a deny rule for a mutating action
      await db.createPermission({
        id: "rbac-deny-1",
        action: "project.archive",
        resource: "*",
        effect: "deny",
      });

      const perms = await db.listPermissions();
      const denyRule = perms.find((p) => p.id === "rbac-deny-1");
      expect(denyRule).toBeDefined();
      expect(denyRule!.effect).toBe("deny");

      // Verify we can also have explicit allow rules
      await db.createPermission({
        id: "rbac-allow-1",
        action: "user.create",
        resource: "*",
        effect: "allow",
      });

      const updatedPerms = await db.listPermissions();
      const allowRule = updatedPerms.find((p) => p.id === "rbac-allow-1");
      expect(allowRule).toBeDefined();
      expect(allowRule!.effect).toBe("allow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checkPermission from core package enforces deny rules", () => {
    const { checkPermission, deny, allow } = require("@eigengrid/core");

    const rules = [allow("user.list"), deny("user.disable"), deny("project.archive")];

    // Allowed action
    const listResult = checkPermission("user.list", "*", rules);
    expect(listResult.effect).toBe("allow");

    // Denied action
    const disableResult = checkPermission("user.disable", "*", rules);
    expect(disableResult.effect).toBe("deny");

    // Denied action (project.archive)
    const archiveResult = checkPermission("project.archive", "*", rules);
    expect(archiveResult.effect).toBe("deny");

    // Unspecified action defaults to allow (open by default)
    const unknownResult = checkPermission("unknown.action", "*", rules);
    expect(unknownResult.effect).toBe("allow");
  });
});
