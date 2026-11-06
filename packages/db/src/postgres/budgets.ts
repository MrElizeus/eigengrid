import type { QuotaRecord, UsageRecord } from "../client";
import { mapQuotaRow, mapUsageRow } from "../rows";
import type { PostgresContext } from "./context";
import { type PgRow } from "./row-helpers";

export async function getProjectQuota(
  context: PostgresContext,
  projectId: string,
): Promise<QuotaRecord | null> {
  const row = await context.queryOne("SELECT * FROM project_quotas WHERE project_id = $1", [
    projectId,
  ]);
  return row ? mapQuotaRow(row as Record<string, unknown>) : null;
}

export async function setProjectQuota(
  context: PostgresContext,
  projectId: string,
  quota: {
    maxCpuThreads?: number;
    maxMemoryMb?: number;
    maxScratchMb?: number;
    maxJobsTotal?: number;
  },
): Promise<void> {
  const now = context.nextTimestamp();
  const existing = await getProjectQuota(context, projectId);
  if (existing) {
    const setFields: string[] = ["updated_at = $1"];
    const params: unknown[] = [now];
    let paramIdx = 2;
    if (quota.maxCpuThreads !== undefined) {
      setFields.push(`max_cpu_threads = $${paramIdx++}`);
      params.push(quota.maxCpuThreads);
    }
    if (quota.maxMemoryMb !== undefined) {
      setFields.push(`max_memory_mb = $${paramIdx++}`);
      params.push(quota.maxMemoryMb);
    }
    if (quota.maxScratchMb !== undefined) {
      setFields.push(`max_scratch_mb = $${paramIdx++}`);
      params.push(quota.maxScratchMb);
    }
    if (quota.maxJobsTotal !== undefined) {
      setFields.push(`max_jobs_total = $${paramIdx++}`);
      params.push(quota.maxJobsTotal);
    }
    params.push(projectId);
    await context.query(
      `UPDATE project_quotas SET ${setFields.join(", ")} WHERE project_id = $${paramIdx}`,
      params,
    );
  } else {
    await context.query(
      `INSERT INTO project_quotas (id, project_id, max_cpu_threads, max_memory_mb, max_scratch_mb, max_jobs_total, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        `quota-${projectId}`,
        projectId,
        quota.maxCpuThreads ?? 0,
        quota.maxMemoryMb ?? 0,
        quota.maxScratchMb ?? 0,
        quota.maxJobsTotal ?? 0,
        now,
        now,
      ],
    );
  }
}

export async function recordUsage(
  context: PostgresContext,
  usage: {
    id: string;
    projectId: string;
    userId: string;
    jobId: string;
    cpuThreads?: number;
    memoryMb?: number;
    scratchMb?: number;
    walltimeMs?: number;
  },
): Promise<void> {
  const now = context.nextTimestamp();
  await context.query(
    `INSERT INTO usage_records (id, project_id, user_id, job_id, cpu_threads, memory_mb, scratch_mb, walltime_ms, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      usage.id,
      usage.projectId,
      usage.userId,
      usage.jobId,
      usage.cpuThreads ?? 1,
      usage.memoryMb ?? 1024,
      usage.scratchMb ?? 1024,
      usage.walltimeMs ?? null,
      now,
    ],
  );
}

export async function getProjectUsage(
  context: PostgresContext,
  projectId: string,
): Promise<UsageRecord[]> {
  const { rows } = await context.query(
    "SELECT * FROM usage_records WHERE project_id = $1 ORDER BY recorded_at DESC LIMIT 1000",
    [projectId],
  );
  return rows.map((r: PgRow) => mapUsageRow(r as Record<string, unknown>));
}

export async function getUserUsage(
  context: PostgresContext,
  userId: string,
): Promise<UsageRecord[]> {
  const { rows } = await context.query(
    "SELECT * FROM usage_records WHERE user_id = $1 ORDER BY recorded_at DESC LIMIT 1000",
    [userId],
  );
  return rows.map((r: PgRow) => mapUsageRow(r as Record<string, unknown>));
}

export async function getProjectAggregatedUsage(
  context: PostgresContext,
  projectId: string,
): Promise<{
  totalCpuThreads: number;
  totalMemoryMb: number;
  totalScratchMb: number;
  totalWalltimeMs: number;
  jobCount: number;
}> {
  const row = await context.queryOne(
    `SELECT
        COALESCE(SUM(cpu_threads), 0) AS total_cpu,
        COALESCE(SUM(memory_mb), 0) AS total_mem,
        COALESCE(SUM(scratch_mb), 0) AS total_scratch,
        COALESCE(SUM(walltime_ms), 0) AS total_walltime,
        COUNT(DISTINCT job_id) AS job_count
      FROM usage_records WHERE project_id = $1`,
    [projectId],
  );
  return {
    totalCpuThreads: Number(row?.total_cpu ?? 0),
    totalMemoryMb: Number(row?.total_mem ?? 0),
    totalScratchMb: Number(row?.total_scratch ?? 0),
    totalWalltimeMs: Number(row?.total_walltime ?? 0),
    jobCount: Number(row?.job_count ?? 0),
  };
}
