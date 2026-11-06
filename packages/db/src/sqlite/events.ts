import { generateId } from "@eigengrid/core";
import type { EigenGridEvent, EigenGridEventBase } from "@eigengrid/events";
import type { EventRecord, LogLine } from "../client";
import { mapEventRow, readNumber, readString } from "../rows";
import type { SqliteContext } from "./context";

export function emitBaseEvent(
  context: SqliteContext,
  event: Omit<EigenGridEventBase, "id" | "at" | "source"> & {
    source?: EigenGridEventBase["source"];
  },
): void {
  const db = context.ensureDb();
  const fullEvent: EigenGridEventBase = {
    id: generateId("evt"),
    at: context.nextTimestamp(),
    source: event.source ?? "db",
    ...event,
  };

  let sequence: number | null = null;
  if (fullEvent.jobId) {
    const row = db
      .query(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM job_events WHERE job_id = $jobId",
      )
      .get({ $jobId: fullEvent.jobId }) as { next_seq: number } | undefined;
    sequence = row?.next_seq ?? null;
  }

  db.query(
    `INSERT INTO job_events (job_id, type, event_id, source, attempt_id, artifact_id, result_id, sequence, schema_version, payload_json, created_at)
       VALUES ($jobId, $type, $eventId, $source, $attemptId, $artifactId, $resultId, $sequence, $schemaVersion, $payloadJson, $createdAt)`,
  ).run({
    $jobId: fullEvent.jobId ?? "system",
    $type: fullEvent.type,
    $eventId: fullEvent.id,
    $source: fullEvent.source,
    $attemptId: fullEvent.attemptId ?? null,
    $artifactId: fullEvent.artifactId ?? null,
    $resultId: fullEvent.resultId ?? null,
    $sequence: sequence,
    $schemaVersion: 1,
    $payloadJson: fullEvent.payload ? JSON.stringify(fullEvent.payload) : null,
    $createdAt: fullEvent.at,
  });
}

/** @deprecated Use appendEvent instead */
export async function insertEvent(context: SqliteContext, event: EigenGridEvent): Promise<void> {
  const db = context.ensureDb();
  const payloadJson = JSON.stringify(event);
  db.query(
    "INSERT INTO job_events (job_id, type, payload_json, created_at) VALUES ($jobId, $type, $payloadJson, $createdAt)",
  ).run({
    $jobId: "jobId" in event && event.jobId ? event.jobId : "system",
    $type: event.type,
    $payloadJson: payloadJson,
    $createdAt: event.at ?? context.nextTimestamp(),
  });
}

export async function getLogs(
  context: SqliteContext,
  jobId: string,
  stream?: string,
  tail?: number,
): Promise<LogLine[]> {
  const db = context.ensureDb();
  const params: Record<string, unknown> = { $jobId: jobId };

  let whereClause = "WHERE job_id = $jobId";
  if (stream) {
    whereClause += " AND stream = $stream";
    params.$stream = stream;
  }

  if (tail != null) {
    const sql = `SELECT stream, line, created_at FROM job_logs ${whereClause} ORDER BY id DESC LIMIT ${tail}`;
    const rows = db.query(sql).all(params);
    return rows.reverse().map((r: Record<string, unknown>) => ({
      stream: readString(r, "stream"),
      line: readString(r, "line"),
      createdAt: readNumber(r, "created_at"),
    }));
  }

  const sql = `SELECT stream, line, created_at FROM job_logs ${whereClause} ORDER BY id ASC`;
  const rows = db.query(sql).all(params);
  return rows.map((r: Record<string, unknown>) => ({
    stream: readString(r, "stream"),
    line: readString(r, "line"),
    createdAt: readNumber(r, "created_at"),
  }));
}

export async function getEvents(context: SqliteContext, jobId?: string): Promise<EventRecord[]> {
  const db = context.ensureDb();
  const rows: Record<string, unknown>[] = jobId
    ? db
        .query(
          "SELECT * FROM job_events WHERE job_id = $jobId ORDER BY sequence ASC, created_at ASC",
        )
        .all({ $jobId: jobId })
    : db.query("SELECT * FROM job_events ORDER BY sequence ASC, created_at ASC LIMIT 100").all();
  return rows.map((row) => mapEventRow(row));
}
