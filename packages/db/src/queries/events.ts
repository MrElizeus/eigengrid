import type { EigenGridEventBase, EigenGridEventType } from "@eigengrid/events";
import type { DatabaseLike, EventRecord } from "../client";
import { mapEventRow } from "../rows";

// Minimal SQLite connection interface for direct query access within events module
interface SqliteConn {
  query(sql: string): {
    run(params?: Record<string, unknown>): unknown;
    get(params?: Record<string, unknown>): Record<string, unknown> | undefined;
    all(params?: Record<string, unknown>): Record<string, unknown>[];
  };
}

export interface AppendEventOptions {
  /** Explicit timestamp (defaults to nextTimestamp) */
  at?: number;
}

export interface ListEventsFilter {
  jobId?: string;
  type?: EigenGridEventType;
  limit?: number;
}

export interface TimelineRow {
  at: string;
  type: string;
  details: string;
}

/**
 * Append a normalized event to the event log.
 * Maps EigenGridEventBase fields to DB columns.
 *
 * For SQLite, this delegates to the underlying connection.
 * For PostgreSQL, this is handled directly by the PostgresDatabase.
 */
export async function appendEvent(
  db: DatabaseLike,
  event: EigenGridEventBase,
  options?: AppendEventOptions,
): Promise<void> {
  if (db._provider === "sqlite") {
    // SQLite path: use ensureDb() for direct SQL access
    const sqlite = db as unknown as { ensureDb(): SqliteConn };
    const dbConn = sqlite.ensureDb();
    const now = options?.at ?? Date.now();

    // Sequence allocation and INSERT are transaction-protected by callers
    // (updateJobStatus, updateJobAttemptStatus, etc.) that wrap state mutation
    // + event emission in a single transaction. Direct appendEvent callers
    // are protected by the unique index on (job_id, sequence).
    let sequence: number | null = null;
    if (event.jobId) {
      const result = dbConn
        .query(
          "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM job_events WHERE job_id = $jobId",
        )
        .get({ $jobId: event.jobId }) as { next_seq: number } | undefined;
      sequence = result?.next_seq ?? null;
    }

    dbConn
      .query(
        `INSERT INTO job_events (job_id, type, event_id, source, attempt_id, artifact_id, result_id, sequence, schema_version, payload_json, created_at)
         VALUES ($jobId, $type, $eventId, $source, $attemptId, $artifactId, $resultId, $sequence, $schemaVersion, $payloadJson, $createdAt)`,
      )
      .run({
        $jobId: event.jobId ?? "system",
        $type: event.type,
        $eventId: event.id,
        $source: event.source,
        $attemptId: event.attemptId ?? null,
        $artifactId: event.artifactId ?? null,
        $resultId: event.resultId ?? null,
        $sequence: sequence,
        $schemaVersion: 1,
        $payloadJson: event.payload ? JSON.stringify(event.payload) : null,
        $createdAt: now,
      });
  } else {
    // PostgreSQL path: delegate to DatabaseLike.appendEvent
    await db.appendEvent(event);
  }
}

/**
 * List raw events chronologically with optional filters.
 */
export async function listEvents(
  db: DatabaseLike,
  filters?: ListEventsFilter,
): Promise<EventRecord[]> {
  if (db._provider === "sqlite") {
    const sqlite = db as unknown as { ensureDb(): SqliteConn };
    const dbConn = sqlite.ensureDb();
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filters?.jobId) {
      conditions.push("job_id = $jobId");
      params.$jobId = filters.jobId;
    }
    if (filters?.type) {
      conditions.push("type = $type");
      params.$type = filters.type;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = filters?.limit != null ? `LIMIT ${filters.limit}` : "LIMIT 100";

    const rows: Record<string, unknown>[] = dbConn
      .query(
        `SELECT * FROM job_events ${whereClause} ORDER BY sequence ASC, created_at ASC ${limitClause}`,
      )
      .all(params);
    return rows.map(mapEventRow);
  }

  // PostgreSQL path: delegate to DatabaseLike.listEvents
  return db.listEvents(filters);
}

/**
 * List events for a specific job in chronological order.
 */
export async function listJobEvents(db: DatabaseLike, jobId: string): Promise<EventRecord[]> {
  if (db._provider === "sqlite") {
    return listEvents(db, { jobId });
  }
  return db.listJobEvents(jobId);
}

/**
 * List events for a specific attempt.
 */
export async function listAttemptEvents(
  db: DatabaseLike,
  attemptId: string,
): Promise<EventRecord[]> {
  if (db._provider === "sqlite") {
    const sqlite = db as unknown as { ensureDb(): SqliteConn };
    const dbConn = sqlite.ensureDb();
    const rows: Record<string, unknown>[] = dbConn
      .query(
        "SELECT * FROM job_events WHERE attempt_id = $attemptId ORDER BY sequence ASC, created_at ASC",
      )
      .all({ $attemptId: attemptId });
    return rows.map(mapEventRow);
  }
  return db.listAttemptEvents(attemptId);
}

/**
 * Return a compact human-readable timeline for a job.
 */
export async function getTimeline(db: DatabaseLike, jobId: string): Promise<TimelineRow[]> {
  if (db._provider === "sqlite") {
    const events = await listJobEvents(db, jobId);
    return events.map((row) => {
      const ts = new Date(Number(row.createdAt)).toISOString().replace("T", " ").slice(0, 19);
      const type = String(row.type);
      const payload = row.payloadJson ? tryParsePayload(String(row.payloadJson)) : null;

      let details = "";
      if (type === "job.status.changed" && payload?.from && payload?.to) {
        details = `${payload.from} → ${payload.to}`;
      } else if (type === "attempt.created" && payload?.command) {
        details = `command: ${payload.command}`;
      } else if (type === "attempt.status.changed" && payload?.from && payload?.to) {
        details = `${payload.from} → ${payload.to}`;
        if (payload.exitCode != null) details += ` (exit=${payload.exitCode})`;
      } else if (type === "process.started" && payload?.pid) {
        details = `pid=${payload.pid}`;
      } else if (type === "process.completed" && payload?.exitCode != null) {
        details = `exit=${payload.exitCode} (${payload.durationMs ?? "?"}ms)`;
      } else if (type === "process.failed" && payload?.exitCode != null) {
        details = `exit=${payload.exitCode} (${payload.durationMs ?? "?"}ms) [FAILED]`;
      } else if (type === "artifact.registered" && payload?.path) {
        details = `${payload.kind ?? "file"}: ${payload.path}`;
      } else if (
        type === "parse.started" ||
        type === "parse.completed" ||
        type === "parse.failed"
      ) {
        details = payload ? JSON.stringify(payload) : "";
      } else if (type === "result.saved") {
        details = payload ? `parser=${payload.parser ?? "?"}` : "";
      } else if (payload) {
        details = JSON.stringify(payload).slice(0, 80);
      }

      return { at: ts, type, details };
    });
  }
  return db.getTimeline(jobId);
}

function tryParsePayload(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}
