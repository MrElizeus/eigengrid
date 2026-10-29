import type { DatabaseLike, QuotaRecord } from "../client";

export async function getProjectQuota(
  db: DatabaseLike,
  projectId: string,
): Promise<QuotaRecord | null> {
  return db.getProjectQuota(projectId);
}

export async function setProjectQuota(
  db: DatabaseLike,
  projectId: string,
  quota: {
    maxCpuThreads?: number;
    maxMemoryMb?: number;
    maxScratchMb?: number;
    maxJobsTotal?: number;
  },
): Promise<void> {
  await db.setProjectQuota(projectId, quota);
}
