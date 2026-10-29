/**
 * Durable HTTP mutation idempotency, backed by a HEAD-controlled PostgreSQL
 * connection. Reserving a key is committed BEFORE invoking the mission runtime facade.
 *
 * A pending key after a crash/DB outage is UNCERTAIN: never re-execute blindly.
 * mission runtime owns scientific admission, WorkUnits, Slurm and effect reconciliation.
 * This store does not infer a successful scientific receipt from an HTTP 200.
 */
import { randomUUID } from "node:crypto";
import { canonicalAgentJson } from "@eigengrid/agent-runtime";
import { applicationJson } from "../application-json";
import {
  MissionHttpError,
  type MissionHttpIdempotencyRequest,
  type MissionHttpIdempotencyService,
} from "./routes/mission-routes";

export interface PgQueryRows<T> {
  readonly rows: T[];
  readonly rowCount: number | null;
}
export interface PgTransactionClient {
  query<T extends object = Record<string, unknown>>(
    statement: string,
    args?: readonly unknown[],
  ): Promise<PgQueryRows<T>>;
  release(): void;
}
export interface PgTransactionPool {
  connect(): Promise<PgTransactionClient>;
}
type StoredOperation = {
  operation_id: string;
  request_digest: string;
  expected_revision: string;
  status: "pending" | "complete";
  output_json: unknown;
  request_json: unknown;
};
const name = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/u;
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const hash = /^[a-f0-9]{64}$/u;

function validate(request: MissionHttpIdempotencyRequest): void {
  if (
    !name.test(request.actorId) ||
    !name.test(request.projectId) ||
    ![
      "create",
      "import",
      "approve",
      "compile",
      "start",
      "cancel",
      "agent.open",
      "agent.approve",
      "agent.resume",
      "agent.cancel",
      "agent.reconcile",
    ].includes(request.operation) ||
    !keyPattern.test(request.key) ||
    !hash.test(request.requestDigest) ||
    !Number.isSafeInteger(request.expectedRevision) ||
    request.expectedRevision < 0
  )
    throw new MissionHttpError("INVALID_REQUEST");
}
const sqlSelect = [
  "SELECT operation_id,request_digest,expected_revision::text,status,output_json,request_json",
  "FROM eigengrid_a5_http_operations",
  "WHERE actor_id=$1 AND project_id=$2 AND operation=$3 AND idempotency_key=$4",
  "FOR UPDATE",
].join(" ");
const sqlInsert = [
  "INSERT INTO eigengrid_a5_http_operations",
  "(actor_id,project_id,operation,idempotency_key,operation_id,request_digest,expected_revision,request_json,status)",
  "VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'pending')",
  "ON CONFLICT (actor_id,project_id,operation,idempotency_key) DO NOTHING",
  "RETURNING operation_id",
].join(" ");

/** application explicitly requires this to be the canonical mission runtime expected-revision check.
 * Do not pass a no-op outside read-only fixtures.
 */
export type AssertExactMissionRevision = (request: MissionHttpIdempotencyRequest) => Promise<void>;

export class PostgresMissionHttpIdempotency implements MissionHttpIdempotencyService {
  constructor(
    readonly pool: PgTransactionPool,
    readonly assertExactRevision: AssertExactMissionRevision,
  ) {}

  async run(
    request: MissionHttpIdempotencyRequest,
    execute: () => Promise<unknown>,
  ): Promise<{ operationId: string; result: unknown; replayed: boolean }> {
    validate(request);
    const requestJson = canonicalAgentJson(applicationJson(request.request));
    const key = [request.actorId, request.projectId, request.operation, request.key];
    const client = await this.pool.connect();
    const newlyReservedId = randomUUID();
    let first = false;
    let replay: { operationId: string; result: unknown; replayed: boolean } | undefined;
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ operation_id: string }>(sqlInsert, [
        ...key,
        newlyReservedId,
        request.requestDigest,
        request.expectedRevision,
        requestJson,
      ]);
      first = inserted.rows.length === 1;
      if (!first) {
        const previous = await client.query<StoredOperation>(sqlSelect, key);
        if (previous.rows.length !== 1) throw new MissionHttpError("EFFECT_UNCERTAIN");
        const item = previous.rows[0]!;
        if (item.request_json === null) throw new MissionHttpError("EFFECT_UNCERTAIN");
        if (
          item.request_digest !== request.requestDigest ||
          Number(item.expected_revision) !== request.expectedRevision ||
          canonicalAgentJson(item.request_json) !== requestJson
        )
          throw new MissionHttpError("IDEMPOTENCY_CONFLICT");
        if (item.status !== "complete") throw new MissionHttpError("EFFECT_UNCERTAIN");
        replay = { operationId: item.operation_id, result: item.output_json, replayed: true };
      } else {
        // Check before committing the persistent intent; mission runtime must also recheck
        // exact plan, policy, membership and approval at admission time.
        await this.assertExactRevision(request);
      }
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* do not retry an ambiguous effect */
      }
      throw error;
    } finally {
      client.release();
    }
    if (replay) return replay;
    if (!first) throw new MissionHttpError("EFFECT_UNCERTAIN");

    // Commit intent before effect. Never wrap mission runtime in a transaction on this table:
    // external effects have a distinct canonical transaction/outbox owner.
    const result = await execute();
    let safeResult: unknown;
    try {
      const text = canonicalAgentJson(applicationJson(result));
      if (Buffer.byteLength(text, "utf8") > 1024 * 1024) throw new Error("oversized result");
      safeResult = JSON.parse(text) as unknown;
    } catch {
      // The effect MAY have happened. Persisted 'pending' is a blocking fence.
      throw new MissionHttpError("EFFECT_UNCERTAIN");
    }
    const resultClient = await this.pool.connect();
    try {
      const updated = await resultClient.query<{ operation_id: string }>(
        [
          "UPDATE eigengrid_a5_http_operations",
          "SET status='complete',output_json=$6::jsonb,completed_at=clock_timestamp()",
          "WHERE actor_id=$1 AND project_id=$2 AND operation=$3 AND idempotency_key=$4",
          "AND operation_id=$5 AND request_digest=$7 AND status='pending'",
          "RETURNING operation_id",
        ].join(" "),
        [...key, newlyReservedId, JSON.stringify(safeResult), request.requestDigest],
      );
      if (updated.rows.length !== 1) throw new MissionHttpError("EFFECT_UNCERTAIN");
    } catch {
      throw new MissionHttpError("EFFECT_UNCERTAIN");
    } finally {
      resultClient.release();
    }
    return { operationId: newlyReservedId, result: safeResult, replayed: false };
  }

  /** Explicit readback of a pending operation; the callback has no submission authority. */
  async reconcile(
    input: { actorId: string; projectId: string; missionId: string; operationId: string },
    observe: (request: MissionHttpIdempotencyRequest) => Promise<unknown | null>,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const rows = await client.query<Record<string, unknown>>(
        "SELECT * FROM eigengrid_a5_http_operations WHERE actor_id=$1 AND project_id=$2 AND operation_id=$3 FOR UPDATE",
        [input.actorId, input.projectId, input.operationId],
      );
      const row = rows.rows[0];
      const request = row?.request_json as
        | { missionId?: string; mission?: { id: string } }
        | undefined;
      if (!row || !request || (request.missionId ?? request.mission?.id) !== input.missionId)
        throw new MissionHttpError("NOT_FOUND");
      if (row.status === "complete") {
        await client.query("COMMIT");
        return { operationId: input.operationId, result: row.output_json, replayed: true };
      }
      const observed = await observe({
        actorId: input.actorId,
        projectId: input.projectId,
        operation: String(row.operation) as MissionHttpIdempotencyRequest["operation"],
        key: String(row.idempotency_key),
        requestDigest: String(row.request_digest),
        expectedRevision: Number(row.expected_revision),
        request,
      });
      if (observed === null) throw new MissionHttpError("EFFECT_UNCERTAIN");
      const result = applicationJson({ recoveredFromCanonical: true, observation: observed });
      const bytes = JSON.stringify(result);
      if (Buffer.byteLength(bytes) > 1024 * 1024) throw new MissionHttpError("EFFECT_UNCERTAIN");
      await client.query(
        "UPDATE eigengrid_a5_http_operations SET status='complete',output_json=$2::jsonb,completed_at=clock_timestamp() WHERE operation_id=$1 AND status='pending'",
        [input.operationId, bytes],
      );
      await client.query("COMMIT");
      return { operationId: input.operationId, result, replayed: false };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* A failed reconciliation is never retried as an effect. */
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
