import type { DatabaseLike, ProjectRecord } from "../client";

export async function createProject(
  db: DatabaseLike,
  params: { id: string; name: string; description?: string; maxConcurrentJobs?: number },
): Promise<void> {
  await db.createProject(params);
}

export async function getProject(
  db: DatabaseLike,
  projectId: string,
): Promise<ProjectRecord | null> {
  return db.getProject(projectId);
}

export async function getProjectByName(
  db: DatabaseLike,
  name: string,
): Promise<ProjectRecord | null> {
  return db.getProjectByName(name);
}

export async function listProjects(db: DatabaseLike): Promise<ProjectRecord[]> {
  return db.listProjects();
}

export async function archiveProject(db: DatabaseLike, projectId: string): Promise<void> {
  await db.archiveProject(projectId);
}

export async function resolveProjectId(db: DatabaseLike, prefix: string): Promise<string> {
  return db.resolveProjectId(prefix);
}
