import type { DatabaseLike } from "../client";

export async function getLogs(
  db: DatabaseLike,
  jobId: string,
  stream?: string,
  tail?: number,
): Promise<{ stream: string; line: string; createdAt: number }[]> {
  return db.getLogs(jobId, stream, tail);
}
