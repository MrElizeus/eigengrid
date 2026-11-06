import type { MembershipRecord, ProjectRecord } from "../client";
import { DbAmbiguousPrefixError, DbNotFoundError } from "../errors";
import { mapMembershipRow, mapProjectRow } from "../rows";
import type { SqliteContext } from "./context";

export async function createProject(
  context: SqliteContext,
  project: {
    id: string;
    name: string;
    description?: string;
    maxConcurrentJobs?: number;
  },
): Promise<void> {
  const db = context.ensureDb();
  const now = context.nextTimestamp();
  db.query(
    "INSERT INTO projects (id, name, description, status, max_concurrent_jobs, created_at, updated_at) VALUES ($id, $name, $description, 'active', $maxConcurrentJobs, $createdAt, $updatedAt)",
  ).run({
    $id: project.id,
    $name: project.name,
    $description: project.description ?? null,
    $maxConcurrentJobs: project.maxConcurrentJobs ?? 10,
    $createdAt: now,
    $updatedAt: now,
  });
}

export async function getProject(
  context: SqliteContext,
  projectId: string,
): Promise<ProjectRecord | null> {
  const row = context
    .ensureDb()
    .query("SELECT * FROM projects WHERE id = $id")
    .get({ $id: projectId });
  if (!row) return null;
  return mapProjectRow(row as Record<string, unknown>);
}

export async function getProjectByName(
  context: SqliteContext,
  name: string,
): Promise<ProjectRecord | null> {
  const row = context
    .ensureDb()
    .query("SELECT * FROM projects WHERE name = $name")
    .get({ $name: name });
  if (!row) return null;
  return mapProjectRow(row as Record<string, unknown>);
}

export async function listProjects(context: SqliteContext): Promise<ProjectRecord[]> {
  const rows = context.ensureDb().query("SELECT * FROM projects ORDER BY created_at ASC").all();
  return rows.map((r: Record<string, unknown>) => mapProjectRow(r));
}

export async function archiveProject(context: SqliteContext, projectId: string): Promise<void> {
  context
    .ensureDb()
    .query("UPDATE projects SET status = 'archived', updated_at = $updatedAt WHERE id = $id")
    .run({
      $id: projectId,
      $updatedAt: Date.now(),
    });
}

export async function resolveProjectId(context: SqliteContext, prefix: string): Promise<string> {
  const db = context.ensureDb();
  const rows = db
    .query("SELECT id FROM projects WHERE id LIKE $prefix")
    .all({ $prefix: `${prefix}%` });
  if (rows.length === 0) {
    const nameRows = db.query("SELECT id FROM projects WHERE name = $name").all({ $name: prefix });
    if (nameRows.length === 0) throw new DbNotFoundError("Project", prefix);
    if (nameRows.length > 1) throw new DbAmbiguousPrefixError("project", prefix, nameRows.length);
    return String(nameRows[0].id);
  }
  if (rows.length > 1) throw new DbAmbiguousPrefixError("project", prefix, rows.length);
  return String(rows[0].id);
}

export async function addProjectMember(
  context: SqliteContext,
  projectId: string,
  userId: string,
  role?: string,
): Promise<void> {
  const db = context.ensureDb();
  const now = context.nextTimestamp();
  const id = `mem-${projectId}-${userId}`;
  db.query(
    "INSERT OR IGNORE INTO project_memberships (id, project_id, user_id, role, created_at, updated_at) VALUES ($id, $projectId, $userId, $role, $createdAt, $updatedAt)",
  ).run({
    $id: id,
    $projectId: projectId,
    $userId: userId,
    $role: role ?? "member",
    $createdAt: now,
    $updatedAt: now,
  });
}

export async function removeProjectMember(
  context: SqliteContext,
  projectId: string,
  userId: string,
): Promise<void> {
  context
    .ensureDb()
    .query("DELETE FROM project_memberships WHERE project_id = $projectId AND user_id = $userId")
    .run({ $projectId: projectId, $userId: userId });
}

export async function listProjectMembers(
  context: SqliteContext,
  projectId: string,
): Promise<MembershipRecord[]> {
  const rows = context
    .ensureDb()
    .query(
      "SELECT * FROM project_memberships WHERE project_id = $projectId ORDER BY created_at ASC",
    )
    .all({ $projectId: projectId });
  return rows.map((r: Record<string, unknown>) => mapMembershipRow(r));
}

export async function listUserProjects(
  context: SqliteContext,
  userId: string,
): Promise<ProjectRecord[]> {
  const rows = context
    .ensureDb()
    .query(
      `SELECT p.* FROM projects p
       JOIN project_memberships pm ON p.id = pm.project_id
       WHERE pm.user_id = $userId ORDER BY p.created_at ASC`,
    )
    .all({ $userId: userId });
  return rows.map((r: Record<string, unknown>) => mapProjectRow(r));
}
