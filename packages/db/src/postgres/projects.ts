import type { MembershipRecord, ProjectRecord } from "../client";
import { DbAmbiguousPrefixError, DbNotFoundError } from "../errors";
import { mapMembershipRow, mapProjectRow } from "../rows";
import type { PostgresContext } from "./context";
import { type PgRow } from "./row-helpers";

export async function createProject(
  context: PostgresContext,
  project: {
    id: string;
    name: string;
    description?: string;
    maxConcurrentJobs?: number;
  },
): Promise<void> {
  const now = context.nextTimestamp();
  await context.query(
    `INSERT INTO projects (id, name, description, status, max_concurrent_jobs, created_at, updated_at)
       VALUES ($1, $2, $3, 'active', $4, $5, $6)`,
    [
      project.id,
      project.name,
      project.description ?? null,
      project.maxConcurrentJobs ?? 10,
      now,
      now,
    ],
  );
}

export async function getProject(
  context: PostgresContext,
  projectId: string,
): Promise<ProjectRecord | null> {
  const row = await context.queryOne("SELECT * FROM projects WHERE id = $1", [projectId]);
  return row ? mapProjectRow(row as Record<string, unknown>) : null;
}

export async function getProjectByName(
  context: PostgresContext,
  name: string,
): Promise<ProjectRecord | null> {
  const row = await context.queryOne("SELECT * FROM projects WHERE name = $1", [name]);
  return row ? mapProjectRow(row as Record<string, unknown>) : null;
}

export async function listProjects(context: PostgresContext): Promise<ProjectRecord[]> {
  const { rows } = await context.query("SELECT * FROM projects ORDER BY created_at ASC");
  return rows.map((r: PgRow) => mapProjectRow(r as Record<string, unknown>));
}

export async function archiveProject(context: PostgresContext, projectId: string): Promise<void> {
  await context.query("UPDATE projects SET status = 'archived', updated_at = $1 WHERE id = $2", [
    Date.now(),
    projectId,
  ]);
}

export async function resolveProjectId(context: PostgresContext, prefix: string): Promise<string> {
  const { rows } = await context.query("SELECT id FROM projects WHERE id LIKE $1", [`${prefix}%`]);
  if (rows.length === 0) {
    const nameRows = await context.query("SELECT id FROM projects WHERE name = $1", [prefix]);
    if (nameRows.rows.length === 0) throw new DbNotFoundError("Project", prefix);
    if (nameRows.rows.length > 1)
      throw new DbAmbiguousPrefixError("project", prefix, nameRows.rows.length);
    return String(nameRows.rows[0].id);
  }
  if (rows.length > 1) throw new DbAmbiguousPrefixError("project", prefix, rows.length);
  return String(rows[0].id);
}

export async function addProjectMember(
  context: PostgresContext,
  projectId: string,
  userId: string,
  role?: string,
): Promise<void> {
  const now = context.nextTimestamp();
  const id = `mem-${projectId}-${userId}`;
  await context.query(
    `INSERT INTO project_memberships (id, project_id, user_id, role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
    [id, projectId, userId, role ?? "member", now, now],
  );
}

export async function removeProjectMember(
  context: PostgresContext,
  projectId: string,
  userId: string,
): Promise<void> {
  await context.query("DELETE FROM project_memberships WHERE project_id = $1 AND user_id = $2", [
    projectId,
    userId,
  ]);
}

export async function listProjectMembers(
  context: PostgresContext,
  projectId: string,
): Promise<MembershipRecord[]> {
  const { rows } = await context.query(
    "SELECT * FROM project_memberships WHERE project_id = $1 ORDER BY created_at ASC",
    [projectId],
  );
  return rows.map((r: PgRow) => mapMembershipRow(r as Record<string, unknown>));
}

export async function listUserProjects(
  context: PostgresContext,
  userId: string,
): Promise<ProjectRecord[]> {
  const { rows } = await context.query(
    `SELECT p.* FROM projects p
       JOIN project_memberships pm ON p.id = pm.project_id
       WHERE pm.user_id = $1 ORDER BY p.created_at ASC`,
    [userId],
  );
  return rows.map((r: PgRow) => mapProjectRow(r as Record<string, unknown>));
}
