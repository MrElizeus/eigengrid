import { generateId } from "@eigengrid/core";
import type { EigenGridEvent, EigenGridEventBase } from "@eigengrid/events";
import type { EventRecord, ListEventsFilter, LogLine, TimelineRow } from "../client";
import { DbError, DbErrorCode } from "../errors";
import { mapEventRow } from "../rows";
import type { PostgresContext } from "./context";
import { type PgRow, tryParseJson } from "./row-helpers";

/**
 * Same as emitBaseEvent but uses a provided client connection,
 * allowing the event to be appended within an existing transaction.
 */
export async function emitClientEvent(
  context: PostgresContext,
  client: import("pg").PoolClient,
  event: Omit<EigenGridEventBase, "id" | "at" | "source"> & {
    source?: EigenGridEventBase["source"];
  },
): Promise<void> {
  const fullEvent: EigenGridEventBase = {
    id: generateId("evt"),
    at: context.nextTimestamp(),
    source: event.source ?? "db",
    ...event,
  } as EigenGridEventBase;

  // Direct INSERT into job_events on the provided client
  let sequence: number | null = null;
  if (fullEvent.jobId) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [fullEvent.jobId]);
    const row = (
      await client.query(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM job_events WHERE job_id = $1",
        [fullEvent.jobId],
      )
    ).rows[0] as { next_seq: number | null } | undefined;
    sequence = row?.next_seq != null ? Number(row.next_seq) : null;
  }

  await client.query(
    `INSERT INTO job_events (job_id, type, event_id, source, attempt_id, artifact_id, result_id, sequence, schema_version, payload_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      fullEvent.jobId ?? "system",
      fullEvent.type,
      fullEvent.id,
      fullEvent.source,
      fullEvent.attemptId ?? null,
      fullEvent.artifactId ?? null,
      fullEvent.resultId ?? null,
      sequence,
      1,
      fullEvent.payload ? JSON.stringify(fullEvent.payload) : null,
      context.nextTimestamp(),
    ],
  );
}

export async function insertEvent(context: PostgresContext, event: EigenGridEvent): Promise<void> {
  const payloadJson = JSON.stringify(event);
  await context.query(
    `INSERT INTO job_events (job_id, type, payload_json, created_at)
       VALUES ($1, $2, $3, $4)`,
    [
      "jobId" in event && event.jobId ? event.jobId : "system",
      event.type,
      payloadJson,
      event.at ?? context.nextTimestamp(),
    ],
  );
}

export async function appendEvent(
  context: PostgresContext,
  event: EigenGridEventBase,
): Promise<void> {
  if (!context.pool) throw new DbError("Database not initialized", DbErrorCode.NOT_INITIALIZED);
  const client = await context.pool.connect();
  try {
    await client.query("BEGIN");

    let sequence: number | null = null;
    if (event.jobId) {
      // Use pg_advisory_xact_lock for concurrency-safe sequence allocation
      // Hash the jobId to an int8 for the advisory lock key
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [event.jobId]);
      const row = (
        await client.query(
          "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq FROM job_events WHERE job_id = $1",
          [event.jobId],
        )
      ).rows[0] as { next_seq: number | null } | undefined;
      sequence = row?.next_seq != null ? Number(row.next_seq) : null;
    }

    await client.query(
      `INSERT INTO job_events (job_id, type, event_id, source, attempt_id, artifact_id, result_id, sequence, schema_version, payload_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        event.jobId ?? "system",
        event.type,
        event.id,
        event.source,
        event.attemptId ?? null,
        event.artifactId ?? null,
        event.resultId ?? null,
        sequence,
        1,
        event.payload ? JSON.stringify(event.payload) : null,
        context.nextTimestamp(),
      ],
    );

    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* best-effort */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function getEvents(context: PostgresContext, jobId?: string): Promise<EventRecord[]> {
  let sql: string;
  let params: unknown[];
  if (jobId) {
    sql = "SELECT * FROM job_events WHERE job_id = $1 ORDER BY sequence ASC, created_at ASC";
    params = [jobId];
  } else {
    sql = "SELECT * FROM job_events ORDER BY sequence ASC, created_at ASC LIMIT 100";
    params = [];
  }
  const { rows } = await context.query(sql, params);
  return rows.map((row) => mapEventRow(row as Record<string, unknown>));
}

export async function listEvents(
  context: PostgresContext,
  filters?: ListEventsFilter,
): Promise<EventRecord[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (filters?.jobId) {
    conditions.push(`job_id = $${paramIdx++}`);
    params.push(filters.jobId);
  }
  if (filters?.type) {
    conditions.push(`type = $${paramIdx++}`);
    params.push(filters.type);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limitClause = filters?.limit != null ? `LIMIT ${filters.limit}` : "LIMIT 100";

  const { rows } = await context.query(
    `SELECT * FROM job_events ${whereClause} ORDER BY sequence ASC, created_at ASC ${limitClause}`,
    params,
  );
  return rows.map((r: PgRow) => mapEventRow(r as Record<string, unknown>));
}

export async function listJobEvents(
  context: PostgresContext,
  jobId: string,
): Promise<EventRecord[]> {
  return listEvents(context, { jobId });
}

export async function listAttemptEvents(
  context: PostgresContext,
  attemptId: string,
): Promise<EventRecord[]> {
  const { rows } = await context.query(
    "SELECT * FROM job_events WHERE attempt_id = $1 ORDER BY sequence ASC, created_at ASC",
    [attemptId],
  );
  return rows.map((r: PgRow) => mapEventRow(r as Record<string, unknown>));
}

export async function getTimeline(context: PostgresContext, jobId: string): Promise<TimelineRow[]> {
  const events = await listJobEvents(context, jobId);
  return events.map((row) => {
    const ts = new Date(Number(row.createdAt)).toISOString().replace("T", " ").slice(0, 19);
    const type = String(row.type);
    const payload = row.payloadJson ? tryParseJson(String(row.payloadJson)) : null;

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
    } else if (type === "parse.started" || type === "parse.completed" || type === "parse.failed") {
      details = payload ? JSON.stringify(payload) : "";
    } else if (type === "result.saved") {
      details = payload ? `parser=${payload.parser ?? "?"}` : "";
    } else if (payload) {
      details = JSON.stringify(payload).slice(0, 80);
    }

    return { at: ts, type, details };
  });
}

export async function getLogs(
  context: PostgresContext,
  jobId: string,
  stream?: string,
  tail?: number,
): Promise<LogLine[]> {
  let sql: string;
  let params: unknown[];

  if (tail != null) {
    if (stream) {
      sql = `SELECT stream, line, created_at FROM job_logs WHERE job_id = $1 AND stream = $2 ORDER BY id DESC LIMIT $3`;
      params = [jobId, stream, tail];
    } else {
      sql = `SELECT stream, line, created_at FROM job_logs WHERE job_id = $1 ORDER BY id DESC LIMIT $2`;
      params = [jobId, tail];
    }
    const { rows } = await context.query(sql, params);
    return rows.reverse().map((r) => ({
      stream: String(r.stream),
      line: String(r.line),
      createdAt: Number(r.created_at),
    }));
  }

  if (stream) {
    sql =
      "SELECT stream, line, created_at FROM job_logs WHERE job_id = $1 AND stream = $2 ORDER BY id ASC";
    params = [jobId, stream];
  } else {
    sql = "SELECT stream, line, created_at FROM job_logs WHERE job_id = $1 ORDER BY id ASC";
    params = [jobId];
  }
  const { rows } = await context.query(sql, params);
  return rows.map((r) => ({
    stream: String(r.stream),
    line: String(r.line),
    createdAt: Number(r.created_at),
  }));
}
