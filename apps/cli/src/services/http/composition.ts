import { Pool } from "pg";
import { createHash } from "node:crypto";
import schema from "./schema-v1.sql" with { type: "text" };
import schemaV2 from "./schema-v2.sql" with { type: "text" };
import { MissionLocalAuthority, type MissionLocalContext } from "../mission-local-authority";
import { openMissionApplication, assertMissionDatabaseEnvironment } from "../mission-composition";
import { AgentSessionService } from "../agent-sessions";
import { createLocalAgentIdentity, createMissionAgentEffects } from "../mission-agent";
import { AgentSessionRoot } from "../../commands/agent-session";
import { PostgresHttpAuth, type HttpSql } from "./auth";
import { PostgresMissionHttpIdempotency, type PgTransactionPool } from "./idempotency";
import { MissionHttpError } from "./routes/mission-routes";
import { createApplicationHttpHandler } from "./server";
import { observeApplicationOperation } from "./reconciliation";
import { PostgresHttpArtifactGrants } from "./artifact-grants";
import { createMissionBoundInference } from "../mission-inference";

export const ApplicationHttpSchema = schema;
export const ApplicationHttpSchemaV2 = schemaV2;
const schemaV2Checksum = createHash("sha256").update(schemaV2).digest("hex");
const schemaChecksum = createHash("sha256").update(schema).digest("hex");
export async function applyApplicationHttpSchema(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('eigengrid.a5.http-schema',0))",
    );
    const present = await client.query(
      "SELECT to_regclass('public.eigengrid_a5_http_schema') AS name",
    );
    const installed = present.rows[0]?.name
      ? (
          await client.query(
            "SELECT version,checksum FROM eigengrid_a5_http_schema WHERE version IN (1,2)",
          )
        ).rows
      : [];
    const v1 = installed.find((row) => row.version === 1);
    const v2 = installed.find((row) => row.version === 2);
    if ((v1 && v1.checksum !== schemaChecksum) || (v2 && v2.checksum !== schemaV2Checksum))
      throw new Error("HTTP schema version checksum changed");
    if (!v1) {
      if (v2) throw new Error("HTTP schema history is incomplete");
      await client.query(schema);
      await client.query("INSERT INTO eigengrid_a5_http_schema(version,checksum) VALUES(1,$1)", [
        schemaChecksum,
      ]);
    }
    if (!v2) {
      await client.query(schemaV2);
      await client.query("INSERT INTO eigengrid_a5_http_schema(version,checksum) VALUES(2,$1)", [
        schemaV2Checksum,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function validateApplicationHttpSchema(pool: Pool) {
  const version = await pool.query(
    "SELECT version,checksum FROM eigengrid_a5_http_schema WHERE version IN (1,2) ORDER BY version",
  );
  if (
    version.rows.length !== 2 ||
    version.rows[0]!.checksum !== schemaChecksum ||
    version.rows[1]!.checksum !== schemaV2Checksum
  )
    throw new Error("HTTP schema migration is required");
  await pool.query(
    "SELECT token_digest,csrf_digest,actor_id,config_digest,expires_at,revoked FROM eigengrid_a5_http_sessions LIMIT 0",
  );
  await pool.query(
    "SELECT operation_id,request_digest,expected_revision,status,output_json FROM eigengrid_a5_http_operations LIMIT 0",
  );
  await pool.query(
    "SELECT actor_id,project_id,content_digest FROM eigengrid_a5_http_artifact_grants LIMIT 0",
  );
}

/** Explicit trusted operator command only. The HTTP request handler never runs DDL. */
export async function initializeApplicationHttpSchema() {
  assertMissionDatabaseEnvironment(process.env);
  const authority = new MissionLocalAuthority();
  const context = await authority.current();
  if (!context.authorizedRoles.includes("admin"))
    throw new Error("HTTP schema migration requires a protected admin role");
  const pool = new Pool({
    connectionString: context.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  try {
    await authority.assertCurrent(context);
    await applyApplicationHttpSchema(pool);
  } finally {
    await pool.end();
  }
}

export async function startApplicationHttpServer() {
  assertMissionDatabaseEnvironment(process.env);
  const authority = new MissionLocalAuthority();
  const host = await authority.current();
  if (!host.http) throw new Error("HTTP is not provisioned");
  const pool = new Pool({
    connectionString: host.databaseUrl,
    max: 16,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    idle_in_transaction_session_timeout: 15000,
  });
  pool.on("error", () => {
    console.error(JSON.stringify({ code: "HTTP_DATABASE_UNAVAILABLE" }));
  });
  const sql: HttpSql = {
    query: async (text, args) => {
      const result = await pool.query(text, args);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
  const transactions: PgTransactionPool = {
    async connect() {
      const client = await pool.connect();
      return {
        async query<T extends object>(text: string, args?: readonly unknown[]) {
          const result = await client.query(text, args ? [...args] : undefined);
          return { rows: result.rows as T[], rowCount: result.rowCount };
        },
        release: () => client.release(),
      };
    },
  };
  const open = async (context: MissionLocalContext, current: () => Promise<void>) =>
    openMissionApplication({
      current: async () => {
        await current();
        await authority.assertCurrent(context);
        return context;
      },
      assertCurrent: async (value) => {
        if (value !== context) throw new MissionHttpError("UNAUTHENTICATED");
        await current();
        await authority.assertCurrent(context);
      },
    });
  try {
    await validateApplicationHttpSchema(pool);
    const idempotency = new PostgresMissionHttpIdempotency(transactions, async (request) => {
      await authority.assertCurrent(host);
      if (request.operation.startsWith("agent.")) return; // Agent journal cursor is checked in the common service before its CAS.
      const context = await authority.httpActor(request.actorId, host.configDigest);
      const session = await open(context, () => authority.assertCurrent(context));
      try {
        const value = request.request as { missionId?: string; mission?: { id: string } };
        const missionId = value.missionId ?? value.mission?.id;
        if (!missionId) throw new MissionHttpError("INVALID_REQUEST");
        if (request.operation === "create") {
          const existing = await pool.query("SELECT id FROM scientific_missions WHERE id=$1", [
            missionId,
          ]);
          if (existing.rows.length !== 0 || request.expectedRevision !== 0)
            throw new MissionHttpError("REVISION_CONFLICT");
        } else {
          const state = await session.application.status({
            projectId: request.projectId,
            missionId,
          });
          if (state.revision !== request.expectedRevision)
            throw new MissionHttpError("REVISION_CONFLICT");
        }
      } finally {
        await session.close();
      }
    });
    const agent = (context: MissionLocalContext, current: () => Promise<void>) => {
      const scopedAuthority = {
        current: async () => {
          await current();
          return context;
        },
        assertCurrent: async () => {
          await current();
          await authority.assertCurrent(context);
        },
      };
      const identity = createLocalAgentIdentity(scopedAuthority, () => open(context, current));
      let service!: AgentSessionService;
      const effects = createMissionAgentEffects(
        identity,
        (id) => service.principal(id),
        () => open(context, current),
      );
      service = new AgentSessionService(
        AgentSessionRoot,
        identity,
        createMissionBoundInference(
          (id) => service.principal(id),
          () => open(context, current),
        ),
        effects,
      );
      return service;
    };
    const fetch = createApplicationHttpHandler({
      grants: new PostgresHttpArtifactGrants(sql),
      origin: host.http.origin,
      auth: new PostgresHttpAuth(sql, authority),
      idempotency,
      lookup: (input) => idempotency.lookup(input),
      open,
      agent,
      reconcile: (input, context, current) =>
        idempotency.reconcile(input, async (record) => {
          await current();
          const session = await open(context, current);
          try {
            if (record.operation === "material.apply") {
              const result = await session.reconcileConfirmedMaterialPublication(record);
              await current();
              return result ?? null;
            }
            const result = await observeApplicationOperation(record, session.application, () =>
              agent(context, current),
            );
            await current();
            return result;
          } finally {
            await session.close();
          }
        }),
      reportIncident: (incident) => console.error(JSON.stringify(incident)),
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: host.http.port,
      maxRequestBodySize: 64 * 1024 * 1024,
      idleTimeout: 30,
      async fetch(request, server) {
        // The public origin is protected configuration, never Host/X-Forwarded-* authority.
        const incoming = new URL(request.url);
        const trusted = new Request(
          host.http!.origin + incoming.pathname + incoming.search,
          request,
        );
        return fetch(trusted, server.requestIP(request)?.address ?? "local");
      },
      error() {
        return new Response('{"error":{"code":"INTERNAL_ERROR"}}', {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    return {
      server,
      close: async () => {
        await server.stop(true);
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
