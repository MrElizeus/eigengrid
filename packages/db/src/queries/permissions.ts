import type { DatabaseLike } from "../client";
import type { PermissionEffect } from "@eigengrid/core";

export async function listPermissions(
  db: DatabaseLike,
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
  return db.listPermissions(projectId) as Promise<
    Array<{
      id: string;
      action: string;
      resource: string;
      effect: PermissionEffect;
      projectId?: string;
      label?: string;
    }>
  >;
}

export async function createPermission(
  db: DatabaseLike,
  params: {
    id: string;
    action: string;
    resource?: string;
    effect: PermissionEffect;
    projectId?: string;
    label?: string;
  },
): Promise<void> {
  await db.createPermission(params);
}

export async function removePermission(db: DatabaseLike, id: string): Promise<void> {
  await db.removePermission(id);
}
