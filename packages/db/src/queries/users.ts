import type { DatabaseLike, UserRecord } from "../client";

export async function createUser(
  db: DatabaseLike,
  params: { id: string; username: string; displayName?: string; email?: string },
): Promise<void> {
  await db.createUser(params);
}

export async function getUser(db: DatabaseLike, userId: string): Promise<UserRecord | null> {
  return db.getUser(userId);
}

export async function getUserByUsername(
  db: DatabaseLike,
  username: string,
): Promise<UserRecord | null> {
  return db.getUserByUsername(username);
}

export async function listUsers(db: DatabaseLike): Promise<UserRecord[]> {
  return db.listUsers();
}

export async function disableUser(db: DatabaseLike, userId: string): Promise<void> {
  await db.disableUser(userId);
}

export async function enableUser(db: DatabaseLike, userId: string): Promise<void> {
  await db.enableUser(userId);
}
