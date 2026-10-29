import type { DatabaseLike, UsageRecord } from "../client";

export async function recordUsage(
  db: DatabaseLike,
  params: {
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
  await db.recordUsage(params);
}

export async function getProjectUsage(db: DatabaseLike, projectId: string): Promise<UsageRecord[]> {
  return db.getProjectUsage(projectId);
}

export async function getUserUsage(db: DatabaseLike, userId: string): Promise<UsageRecord[]> {
  return db.getUserUsage(userId);
}

export async function getProjectAggregatedUsage(
  db: DatabaseLike,
  projectId: string,
): Promise<{
  totalCpuThreads: number;
  totalMemoryMb: number;
  totalScratchMb: number;
  totalWalltimeMs: number;
  jobCount: number;
}> {
  return db.getProjectAggregatedUsage(projectId);
}
