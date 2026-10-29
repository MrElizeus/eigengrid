import type { DatabaseLike, MembershipRecord, ProjectRecord } from "../client";

export async function addProjectMember(
  db: DatabaseLike,
  projectId: string,
  userId: string,
  role?: string,
): Promise<void> {
  await db.addProjectMember(projectId, userId, role);
}

export async function removeProjectMember(
  db: DatabaseLike,
  projectId: string,
  userId: string,
): Promise<void> {
  await db.removeProjectMember(projectId, userId);
}

export async function listProjectMembers(
  db: DatabaseLike,
  projectId: string,
): Promise<MembershipRecord[]> {
  return db.listProjectMembers(projectId);
}

export async function listUserProjects(db: DatabaseLike, userId: string): Promise<ProjectRecord[]> {
  return db.listUserProjects(userId);
}
