import type { QuotaRecord, UsageRecord } from "../client";
import { mapQuotaRow, mapUsageRow } from "../rows";
import type { SqliteContext } from "./context";

export async function getProjectQuota(
  context: SqliteContext,
  projectId: string,
): Promise<QuotaRecord | null> {
  const row = context
    .ensureDb()
    .query("SELECT * FROM project_quotas WHERE project_id = $projectId")
    .get({ $projectId: projectId });
  if (!row) return null;
  return mapQuotaRow(row as Record<string, unknown>);
}

export async function setProjectQuota(
  context: SqliteContext,
  projectId: string,
  quota: {
    maxCpuThreads?: number;
    maxMemoryMb?: number;
    maxScratchMb?: number;
    maxJobsTotal?: number;
  },
): Promise<void> {
  const db = context.ensureDb();
  const now = context.nextTimestamp();
  const existing = await getProjectQuota(context, projectId);
  if (existing) {
    const fields: string[] = ["updated_at = $updatedAt"];
    const params: Record<string, unknown> = { $projectId: projectId, $updatedAt: now };
    if (quota.maxCpuThreads !== undefined) {
      fields.push("max_cpu_threads = $maxCpu");
      params.$maxCpu = quota.maxCpuThreads;
    }
    if (quota.maxMemoryMb !== undefined) {
      fields.push("max_memory_mb = $maxMem");
      params.$maxMem = quota.maxMemoryMb;
    }
    if (quota.maxScratchMb !== undefined) {
      fields.push("max_scratch_mb = $maxScratch");
      params.$maxScratch = quota.maxScratchMb;
    }
    if (quota.maxJobsTotal !== undefined) {
      fields.push("max_jobs_total = $maxJobs");
      params.$maxJobs = quota.maxJobsTotal;
    }
    db.query(`UPDATE project_quotas SET ${fields.join(", ")} WHERE project_id = $projectId`).run(
      params,
    );
  } else {
    db.query(
      "INSERT INTO project_quotas (id, project_id, max_cpu_threads, max_memory_mb, max_scratch_mb, max_jobs_total, created_at, updated_at) VALUES ($id, $projectId, $maxCpu, $maxMem, $maxScratch, $maxJobs, $createdAt, $updatedAt)",
    ).run({
      $id: `quota-${projectId}`,
      $projectId: projectId,
      $maxCpu: quota.maxCpuThreads ?? 0,
      $maxMem: quota.maxMemoryMb ?? 0,
      $maxScratch: quota.maxScratchMb ?? 0,
      $maxJobs: quota.maxJobsTotal ?? 0,
      $createdAt: now,
      $updatedAt: now,
    });
  }
}

export async function recordUsage(
  context: SqliteContext,
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
  context
    .ensureDb()
    .query(
      "INSERT INTO usage_records (id, project_id, user_id, job_id, cpu_threads, memory_mb, scratch_mb, walltime_ms, recorded_at) VALUES ($id, $projectId, $userId, $jobId, $cpu, $mem, $scratch, $walltime, $recordedAt)",
    )
    .run({
      $id: usage.id,
      $projectId: usage.projectId,
      $userId: usage.userId,
      $jobId: usage.jobId,
      $cpu: usage.cpuThreads ?? 1,
      $mem: usage.memoryMb ?? 1024,
      $scratch: usage.scratchMb ?? 1024,
      $walltime: usage.walltimeMs ?? null,
      $recordedAt: now,
    });
}

export async function getProjectUsage(
  context: SqliteContext,
  projectId: string,
): Promise<UsageRecord[]> {
  const rows = context
    .ensureDb()
    .query(
      "SELECT * FROM usage_records WHERE project_id = $projectId ORDER BY recorded_at DESC LIMIT 1000",
    )
    .all({ $projectId: projectId });
  return rows.map((r: Record<string, unknown>) => mapUsageRow(r));
}

export async function getUserUsage(context: SqliteContext, userId: string): Promise<UsageRecord[]> {
  const rows = context
    .ensureDb()
    .query(
      "SELECT * FROM usage_records WHERE user_id = $userId ORDER BY recorded_at DESC LIMIT 1000",
    )
    .all({ $userId: userId });
  return rows.map((r: Record<string, unknown>) => mapUsageRow(r));
}

export async function getProjectAggregatedUsage(
  context: SqliteContext,
  projectId: string,
): Promise<{
  totalCpuThreads: number;
  totalMemoryMb: number;
  totalScratchMb: number;
  totalWalltimeMs: number;
  jobCount: number;
}> {
  const row = context
    .ensureDb()
    .query(
      `SELECT
        COALESCE(SUM(cpu_threads), 0) AS total_cpu,
        COALESCE(SUM(memory_mb), 0) AS total_mem,
        COALESCE(SUM(scratch_mb), 0) AS total_scratch,
        COALESCE(SUM(walltime_ms), 0) AS total_walltime,
        COUNT(DISTINCT job_id) AS job_count
      FROM usage_records WHERE project_id = $projectId`,
    )
    .get({ $projectId: projectId }) as Record<string, unknown>;
  return {
    totalCpuThreads: Number(row?.total_cpu ?? 0),
    totalMemoryMb: Number(row?.total_mem ?? 0),
    totalScratchMb: Number(row?.total_scratch ?? 0),
    totalWalltimeMs: Number(row?.total_walltime ?? 0),
    jobCount: Number(row?.job_count ?? 0),
  };
}
