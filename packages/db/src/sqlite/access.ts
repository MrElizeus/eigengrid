import type { PermissionEffect } from "@eigengrid/core";
import type { PermissionRecord, UserRecord } from "../client";
import { mapUserRow } from "../rows";
import type { SqliteContext } from "./context";

export async function listPermissions(
  context: SqliteContext,
  projectId?: string,
): Promise<PermissionRecord[]> {
  const db = context.ensureDb();
  const rows = projectId
    ? db
        .query("SELECT * FROM permissions WHERE project_id = $projectId ORDER BY created_at ASC")
        .all({ $projectId: projectId })
    : db.query("SELECT * FROM permissions ORDER BY created_at ASC").all();
  return rows.map((row: Record<string, unknown>) => ({
    id: String(row.id),
    action: String(row.action),
    resource: String(row.resource),
    effect: String(row.effect) as PermissionEffect,
    ...(typeof row.project_id === "string" ? { projectId: row.project_id } : {}),
    ...(typeof row.label === "string" ? { label: row.label } : {}),
  })) as unknown as PermissionRecord[];
}

export async function createPermission(
  context: SqliteContext,
  permission: {
    id: string;
    action: string;
    resource?: string;
    effect: PermissionEffect;
    projectId?: string;
    label?: string;
  },
): Promise<void> {
  const db = context.ensureDb();
  const now = context.nextTimestamp();
  db.query(
    "INSERT INTO permissions (id, action, resource, effect, project_id, label, created_at, updated_at) VALUES ($id, $action, $resource, $effect, $projectId, $label, $createdAt, $updatedAt)",
  ).run({
    $id: permission.id,
    $action: permission.action,
    $resource: permission.resource ?? "*",
    $effect: permission.effect,
    $projectId: permission.projectId ?? null,
    $label: permission.label ?? null,
    $createdAt: now,
    $updatedAt: now,
  });
}

export async function removePermission(context: SqliteContext, id: string): Promise<void> {
  context.ensureDb().query("DELETE FROM permissions WHERE id = $id").run({ $id: id });
}

export async function createUser(
  context: SqliteContext,
  user: {
    id: string;
    username: string;
    displayName?: string;
    email?: string;
  },
): Promise<void> {
  const db = context.ensureDb();
  const now = context.nextTimestamp();
  db.query(
    "INSERT INTO users (id, username, display_name, email, status, created_at, updated_at) VALUES ($id, $username, $displayName, $email, 'active', $createdAt, $updatedAt)",
  ).run({
    $id: user.id,
    $username: user.username,
    $displayName: user.displayName ?? null,
    $email: user.email ?? null,
    $createdAt: now,
    $updatedAt: now,
  });
}

export async function getUser(context: SqliteContext, userId: string): Promise<UserRecord | null> {
  const row = context.ensureDb().query("SELECT * FROM users WHERE id = $id").get({ $id: userId });
  if (!row) return null;
  return mapUserRow(row as Record<string, unknown>);
}

export async function getUserByUsername(
  context: SqliteContext,
  username: string,
): Promise<UserRecord | null> {
  const row = context
    .ensureDb()
    .query("SELECT * FROM users WHERE username = $username")
    .get({ $username: username });
  if (!row) return null;
  return mapUserRow(row as Record<string, unknown>);
}

export async function listUsers(context: SqliteContext): Promise<UserRecord[]> {
  const rows = context.ensureDb().query("SELECT * FROM users ORDER BY created_at ASC").all();
  return rows.map((r: Record<string, unknown>) => mapUserRow(r));
}

export async function disableUser(context: SqliteContext, userId: string): Promise<void> {
  context
    .ensureDb()
    .query("UPDATE users SET status = 'disabled', updated_at = $updatedAt WHERE id = $id")
    .run({
      $id: userId,
      $updatedAt: Date.now(),
    });
}

export async function enableUser(context: SqliteContext, userId: string): Promise<void> {
  context
    .ensureDb()
    .query("UPDATE users SET status = 'active', updated_at = $updatedAt WHERE id = $id")
    .run({
      $id: userId,
      $updatedAt: Date.now(),
    });
}

export async function isUserDisabled(context: SqliteContext, userId: string): Promise<boolean> {
  const row = context
    .ensureDb()
    .query("SELECT status FROM users WHERE id = $id")
    .get({ $id: userId }) as Record<string, unknown> | undefined;
  return row != null && String(row.status ?? "") === "disabled";
}
