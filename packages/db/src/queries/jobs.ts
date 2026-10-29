import type { Job } from "@eigengrid/core";
import type { DatabaseLike, JobRecord } from "../client";

function mapJobRecordToJob(row: JobRecord): Job {
  return {
    id: row.id,
    name: row.name,
    software: row.software as Job["software"],
    inputPath: row.inputPath,
    outputPath: row.outputPath ?? undefined,
    workdir: row.workdir,
    nodeId: row.nodeId ?? undefined,
    status: row.status as Job["status"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createJob(
  db: DatabaseLike,
  params: Parameters<DatabaseLike["createJob"]>[0],
): Promise<void> {
  await db.createJob(params);
}

export async function getJob(db: DatabaseLike, jobId: string): Promise<Job | null> {
  const row = await db.getJob(jobId);
  return row ? mapJobRecordToJob(row) : null;
}

export async function resolveJobId(db: DatabaseLike, prefix: string): Promise<string> {
  return db.resolveJobId(prefix);
}

export async function listJobs(db: DatabaseLike): Promise<Job[]> {
  const rows = await db.listJobs();
  return rows.map(mapJobRecordToJob);
}

export async function updateJobStatus(db: DatabaseLike, jobId: string, status: string) {
  await db.updateJobStatus(jobId, status);
}
