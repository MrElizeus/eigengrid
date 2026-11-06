import { type PermissionEffect } from "@eigengrid/core";
import type { UserRecord } from "../client";
import { mapUserRow } from "../rows";
import type { PostgresContext } from "./context";
import { type PgRow } from "./row-helpers";

export async function listPermissions(
  context: PostgresContext,
  projectId?: string,
): Promise<
  Array<{
    id: string;
    action: string;
    resource: string;
    effect: PermissionEffect;
    projectId?: string;
    label?: string;
  }>
> {
  let sql: string;
  let params: unknown[];
  if (projectId) {
    sql = "SELECT * FROM permissions WHERE project_id = $1 ORDER BY created_at ASC";
    params = [projectId];
  } else {
    sql = "SELECT * FROM permissions ORDER BY created_at ASC";
    params = [];
  }
  const { rows } = await context.query(sql, params);
  return rows.map((row) => ({
    id: String(row.id),
    action: String(row.action),
    resource: String(row.resource),
    effect: String(row.effect) as PermissionEffect,
    ...(typeof row.project_id === "string" ? { projectId: row.project_id } : {}),
    ...(typeof row.label === "string" ? { label: row.label } : {}),
  }));
}

export async function createPermission(
  context: PostgresContext,
  permission: {
    id: string;
    action: string;
    resource?: string;
    effect: PermissionEffect;
    projectId?: string;
    label?: string;
  },
): Promise<void> {
  const now = context.nextTimestamp();
  await context.query(
    `INSERT INTO permissions (id, action, resource, effect, project_id, label, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      permission.id,
      permission.action,
      permission.resource ?? "*",
      permission.effect,
      permission.projectId ?? null,
      permission.label ?? null,
      now,
      now,
    ],
  );
}

export async function removePermission(context: PostgresContext, id: string): Promise<void> {
  await context.query("DELETE FROM permissions WHERE id = $1", [id]);
}

export async function createUser(
  context: PostgresContext,
  user: {
    id: string;
    username: string;
    displayName?: string;
    email?: string;
  },
): Promise<void> {
  const now = context.nextTimestamp();
  await context.query(
    `INSERT INTO users (id, username, display_name, email, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', $5, $6)`,
    [user.id, user.username, user.displayName ?? null, user.email ?? null, now, now],
  );
}

export async function getUser(
  context: PostgresContext,
  userId: string,
): Promise<UserRecord | null> {
  const row = await context.queryOne("SELECT * FROM users WHERE id = $1", [userId]);
  return row ? mapUserRow(row as Record<string, unknown>) : null;
}

export async function getUserByUsername(
  context: PostgresContext,
  username: string,
): Promise<UserRecord | null> {
  const row = await context.queryOne("SELECT * FROM users WHERE username = $1", [username]);
  return row ? mapUserRow(row as Record<string, unknown>) : null;
}

export async function listUsers(context: PostgresContext): Promise<UserRecord[]> {
  const { rows } = await context.query("SELECT * FROM users ORDER BY created_at ASC");
  return rows.map((r: PgRow) => mapUserRow(r as Record<string, unknown>));
}

export async function disableUser(context: PostgresContext, userId: string): Promise<void> {
  await context.query("UPDATE users SET status = 'disabled', updated_at = $1 WHERE id = $2", [
    Date.now(),
    userId,
  ]);
}

export async function enableUser(context: PostgresContext, userId: string): Promise<void> {
  await context.query("UPDATE users SET status = 'active', updated_at = $1 WHERE id = $2", [
    Date.now(),
    userId,
  ]);
}

export async function isUserDisabled(context: PostgresContext, userId: string): Promise<boolean> {
  const row = await context.queryOne("SELECT status FROM users WHERE id = $1", [userId]);
  return String(row?.status ?? "") === "disabled";
}
