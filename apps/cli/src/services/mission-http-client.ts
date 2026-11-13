import { request as httpsRequest } from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { z } from "zod";
import { openSchema, approvalSchema, sessionIdSchema } from "./agent-session-requests";
import { SessionCookieName } from "./http/auth";
import {
  ensurePrivateClientDirectory,
  lockPrivateClient,
  readPrivateClientJson,
  writePrivateClientJson,
} from "./mission-http-private-files";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const MissionHttpClientConfigSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.mission-http-client/v1"),
    origin: z
      .string()
      .url()
      .refine((value) => {
        const u = new URL(value);
        return u.protocol === "https:" && u.origin === value && !u.username && !u.password;
      }),
    caCertificate: z
      .string()
      .min(64)
      .max(65536)
      .refine((value) => value.includes("-----BEGIN CERTIFICATE-----")),
    credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    actorId: id,
    projectId: id,
    missionId: id,
  })
  .strict();
type Config = z.infer<typeof MissionHttpClientConfigSchema>;
const pendingSchema = z
  .object({
    action: z.enum(["open", "approve", "resume", "cancel", "reconcile"]),
    key: z.string().regex(/^agent-(open|approve|resume|cancel|reconcile)-[a-f0-9]{64}$/u),
    path: z.string().max(2048),
    body: z.string(),
    sessionId: sessionIdSchema.optional(),
  })
  .strict();
const stateSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.mission-http-client-state/v1"),
    configDigest: digest,
    scope: z.object({ origin: z.string(), actorId: id, projectId: id, missionId: id }).strict(),
    sessions: z.array(sessionIdSchema).max(1000),
    auth: z
      .object({
        cookie: z.string().max(512),
        csrfToken: z.string().max(128),
        expiresAt: z.string().max(64),
      })
      .strict()
      .optional(),
    pending: pendingSchema.optional(),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
type Action = "open" | "observe" | "events" | "approve" | "resume" | "cancel" | "reconcile";

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    code?: unknown,
  ) {
    super(
      `Mission HTTPS request rejected (${typeof code === "string" && /^[A-Z_]{1,64}$/u.test(code) ? code : status})`,
    );
  }
}
async function request(
  config: Config,
  path: string,
  headers: Record<string, string>,
  body?: string,
) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw new Error("Mission HTTPS client requires TLS verification");
  const url = new URL(path, config.origin);
  if (url.origin !== config.origin)
    throw new Error("Mission HTTP request escaped its configured origin");
  return new Promise<{ status: number; text: string; cookies: string[] }>((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: body === undefined ? "GET" : "POST",
        ca: config.caCertificate,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        ...(url.hostname === "localhost" ? { family: 4 } : {}),
        headers: {
          Origin: config.origin,
          ...headers,
          ...(body === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": String(Buffer.byteLength(body)),
              }),
        },
      },
      (response) => {
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16 * 1024 * 1024) req.destroy();
          else chunks.push(chunk);
        });
        response.on("error", () => {
          clearTimeout(timer);
          reject(new Error("Mission HTTPS response interrupted"));
        });
        response.on("end", () => {
          clearTimeout(timer);
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
            cookies: response.headers["set-cookie"] ?? [],
          });
        });
      },
    );
    const timer = setTimeout(() => req.destroy(), 180000);
    req.on("error", () => {
      clearTimeout(timer);
      reject(
        new Error("Mission HTTPS transport unavailable; no mutation is automatically retried"),
      );
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}
function jsonResponse(result: Awaited<ReturnType<typeof request>>) {
  let value;
  try {
    value = JSON.parse(result.text);
  } catch {
    throw new Error("Mission HTTPS response is invalid");
  }
  if (result.status < 200 || result.status >= 300)
    throw new HttpFailure(result.status, value?.error?.code);
  return value as Record<string, unknown>;
}
const scopeOf = (config: Config) => ({
  origin: config.origin,
  actorId: config.actorId,
  projectId: config.projectId,
  missionId: config.missionId,
});
const projectPath = (config: Config) => `/api/v1/projects/${encodeURIComponent(config.projectId)}`;
const missionPath = (config: Config) =>
  `${projectPath(config)}/missions/${encodeURIComponent(config.missionId)}`;

/** Private transport state never enters an inference request, tool result or agent journal. */
export class MissionHttpClient {
  readonly config: Config;
  readonly configDigest: string;
  constructor(
    value: unknown,
    readonly statePath: string,
  ) {
    try {
      this.config = MissionHttpClientConfigSchema.parse(value);
    } catch {
      throw new Error("Private mission HTTP configuration is invalid");
    }
    this.configDigest = createHash("sha256").update(JSON.stringify(this.config)).digest("hex");
  }
  private async withState<T>(run: (state: State) => Promise<T>) {
    await ensurePrivateClientDirectory(dirname(this.statePath));
    const unlock = await lockPrivateClient(`${this.statePath}.lock`);
    try {
      const value = await readPrivateClientJson(this.statePath, true);
      let state: State;
      try {
        state =
          value === undefined
            ? {
                schemaVersion: "eigengrid.mission-http-client-state/v1",
                configDigest: this.configDigest,
                scope: scopeOf(this.config),
                sessions: [],
              }
            : stateSchema.parse(value);
      } catch {
        throw new Error("Private mission HTTP state is invalid");
      }
      if (JSON.stringify(state.scope) !== JSON.stringify(scopeOf(this.config)))
        throw new Error("Mission client state belongs to a different origin, actor or mission");
      if (state.configDigest !== this.configDigest) {
        // Credential/CA rotation invalidates authentication, never an unresolved mutation.
        state.configDigest = this.configDigest;
        delete state.auth;
        await this.save(state);
      }
      return await run(state);
    } finally {
      await unlock();
    }
  }
  private save(state: State) {
    stateSchema.parse(state);
    return writePrivateClientJson(this.statePath, state);
  }
  private async authenticate(state: State) {
    if (state.auth && Date.parse(state.auth.expiresAt) > Date.now() + 5000) {
      const result = await request(this.config, "/api/v1/auth/session", {
        Cookie: state.auth.cookie,
      });
      if (result.status === 200) {
        const value = jsonResponse(result) as { actor?: { id?: string } };
        if (value.actor?.id !== this.config.actorId)
          throw new Error("Mission HTTPS actor differs from the private configuration");
        return;
      }
      if (result.status !== 401) jsonResponse(result);
      delete state.auth;
    }
    const result = await request(
      this.config,
      "/api/v1/auth/login",
      {},
      JSON.stringify({ credential: this.config.credential }),
    );
    const value = jsonResponse(result);
    const cookie = result.cookies
      .find((entry) => entry.startsWith(`${SessionCookieName}=`))
      ?.split(";", 1)[0];
    if (!cookie || typeof value.csrfToken !== "string" || typeof value.expiresAt !== "string")
      throw new Error("Mission HTTPS login did not return a valid session");
    const checked = jsonResponse(
      await request(this.config, "/api/v1/auth/session", { Cookie: cookie }),
    ) as { actor?: { id?: string } };
    if (checked.actor?.id !== this.config.actorId)
      throw new Error("Mission HTTPS actor differs from the private configuration");
    state.auth = { cookie, csrfToken: value.csrfToken, expiresAt: value.expiresAt };
    await this.save(state);
  }
  private async get(state: State, path: string) {
    return request(this.config, path, { Cookie: state.auth!.cookie });
  }
  private session(state: State, sessionId: string) {
    sessionIdSchema.parse(sessionId);
    if (!state.sessions.includes(sessionId))
      throw new Error("Session is not bound to this client's origin, actor and mission");
    return `${missionPath(this.config)}/agent-sessions/${sessionId}`;
  }
  private checkedSession(value: unknown, sessionId?: string, prompt?: string) {
    const parsed = z
      .object({
        sessionId: sessionIdSchema,
        prompt: z.string(),
        phase: z.string(),
        cursor: z.object({ sequence: z.number().int().nonnegative(), digest }),
      })
      .passthrough()
      .parse(value);
    if (
      (sessionId && parsed.sessionId !== sessionId) ||
      (prompt !== undefined && parsed.prompt !== prompt)
    )
      throw new Error("Mission HTTPS returned a mismatched session");
    return parsed;
  }
  async run(action: Action, input: unknown) {
    return this.withState(async (state) => {
      await this.authenticate(state);
      const body = input as Record<string, unknown>;
      if (action === "open") {
        const value = openSchema.parse(input);
        if (value.projectId !== this.config.projectId || value.missionId !== this.config.missionId)
          throw new Error("Remote client is bound to a different project or mission");
        return this.mutate(
          state,
          "open",
          `${missionPath(this.config)}/agent-sessions`,
          0,
          { prompt: value.prompt },
          undefined,
          value.requestId,
        );
      }
      const sessionId = sessionIdSchema.parse(body.sessionId),
        path = this.session(state, sessionId);
      if (action === "observe")
        return this.checkedSession(jsonResponse(await this.get(state, path)).result, sessionId);
      if (action === "events") {
        const after = z
            .number()
            .int()
            .nonnegative()
            .parse(body.after ?? 0),
          maximum = z
            .number()
            .int()
            .min(1)
            .max(256)
            .parse(body.maximum ?? 64);
        const raw = await this.get(state, `${path}/events?after=${after}&maximum=${maximum}`);
        if (raw.status !== 200) jsonResponse(raw);
        let cursor = after;
        const events = [];
        for (const line of raw.text.split("\n").filter(Boolean)) {
          let item;
          try {
            item = JSON.parse(line);
          } catch {
            throw new Error("Mission HTTPS journal response is invalid");
          }
          if (
            item.record?.sessionId !== sessionId ||
            !Number.isSafeInteger(item.cursor) ||
            item.cursor <= cursor
          )
            throw new Error("Mission HTTPS returned mismatched journal events");
          cursor = item.cursor;
          events.push(item.record);
        }
        return { cursor, events };
      }
      const observed = this.checkedSession(
        jsonResponse(await this.get(state, path)).result,
        sessionId,
      );
      const value = action === "approve" ? approvalSchema.parse(body.approval) : {};
      return this.mutate(
        state,
        action,
        `${path}/${action}`,
        observed.cursor.sequence,
        value,
        sessionId,
      );
    });
  }
  private async mutate(
    state: State,
    action: z.infer<typeof pendingSchema>["action"],
    path: string,
    expectedRevision: number,
    value: unknown,
    sessionId?: string,
    requestId?: string,
  ) {
    if (state.pending)
      throw new Error(
        "A previous mission HTTP mutation is pending; use agent-session recover-remote before another mutation",
      );
    const key = `agent-${action}-${createHash("sha256")
      .update(
        JSON.stringify({
          scope: state.scope,
          sessionId,
          requestId: requestId ?? randomUUID(),
          expectedRevision,
          value,
        }),
      )
      .digest("hex")}`;
    const body = JSON.stringify({ expectedRevision, request: value });
    state.pending = { action, key, path, body, ...(sessionId ? { sessionId } : {}) };
    await this.save(state); // Durable before the first network byte of any scientific mutation.
    const result = jsonResponse(
      await request(
        this.config,
        path,
        {
          Cookie: state.auth!.cookie,
          "X-CSRF-Token": state.auth!.csrfToken,
          "Idempotency-Key": key,
        },
        body,
      ),
    );
    const valueResult = result.result;
    if (action === "open") {
      const opened = this.checkedSession(
        valueResult,
        undefined,
        (value as { prompt: string }).prompt,
      );
      if (!state.sessions.includes(opened.sessionId)) state.sessions.push(opened.sessionId);
    } else if (["resume", "cancel"].includes(action)) this.checkedSession(valueResult, sessionId);
    else if (action === "approve") {
      const approved = valueResult as Record<string, unknown>;
      if (
        approved?.callId !== (value as Record<string, unknown>).callId ||
        approved?.inputDigest !== (value as Record<string, unknown>).inputDigest
      )
        throw new Error("Mission HTTPS returned a mismatched approval");
    }
    if (action === "reconcile") {
      const outcome = valueResult as { status?: string };
      if (!["RESOLVED", "BLOCKED", "UNKNOWN"].includes(outcome?.status ?? ""))
        throw new Error("Mission HTTPS returned a mismatched reconciliation");
    }
    delete state.pending;
    await this.save(state);
    return valueResult;
  }
  async status() {
    return this.withState(async (state) => ({
      configured: true,
      ...state.scope,
      sessionCount: state.sessions.length,
      pending: state.pending
        ? {
            action: state.pending.action,
            key: state.pending.key,
            sessionId: state.pending.sessionId,
          }
        : null,
    }));
  }
  async recoverPending() {
    return this.withState(async (state) => {
      await this.authenticate(state);
      const pending = state.pending;
      if (!pending) return { status: "no-pending-mutation" };
      const lookupPath = `${projectPath(this.config)}/requests/agent.${pending.action}/${pending.key}?missionId=${encodeURIComponent(this.config.missionId)}`;
      const record = jsonResponse(await this.get(state, lookupPath)).result as {
        status?: string;
        operationId?: string;
        result?: unknown;
      };
      let recovered = record.result;
      if (record.status !== "complete") {
        const operationId = z.string().uuid().parse(record.operationId);
        const response = jsonResponse(
          await request(
            this.config,
            `${missionPath(this.config)}/operations/${operationId}/reconcile`,
            { Cookie: state.auth!.cookie, "X-CSRF-Token": state.auth!.csrfToken },
            "{}",
          ),
        );
        recovered = response.result;
      }
      const observation = (recovered as { recoveredFromCanonical?: boolean; observation?: unknown })
        ?.recoveredFromCanonical
        ? (recovered as { observation: unknown }).observation
        : recovered;
      if (pending.action === "open") {
        const opened = this.checkedSession(
          observation,
          undefined,
          (JSON.parse(pending.body).request as { prompt: string }).prompt,
        );
        if (!state.sessions.includes(opened.sessionId)) state.sessions.push(opened.sessionId);
      }
      if (["resume", "cancel"].includes(pending.action))
        this.checkedSession(observation, pending.sessionId);
      if (pending.action === "approve") {
        const expected = JSON.parse(pending.body).request as {
          callId: string;
          inputDigest: string;
        };
        const actual = observation as { callId?: string; inputDigest?: string };
        if (actual?.callId !== expected.callId || actual?.inputDigest !== expected.inputDigest)
          throw new Error("Mission HTTPS returned a mismatched recovered approval");
      }
      if (pending.action === "reconcile") {
        const value = observation as { sessionId?: string; status?: string };
        if (value?.sessionId) this.checkedSession(value, pending.sessionId);
        else if (!["RESOLVED", "BLOCKED", "UNKNOWN"].includes(value?.status ?? ""))
          throw new Error("Mission HTTPS returned a mismatched recovered reconciliation");
      }
      delete state.pending;
      await this.save(state);
      return { status: "recovered", action: pending.action, result: recovered };
    });
  }
}
export async function configuredMissionHttpClient(
  configPath = join(homedir(), ".eigengrid", "mission-http.json"),
) {
  const value = await readPrivateClientJson(configPath, true);
  if (value === undefined) return null;
  let config;
  try {
    config = MissionHttpClientConfigSchema.parse(value);
  } catch {
    throw new Error("Private mission HTTP configuration is invalid");
  }
  const hash = createHash("sha256")
    .update(JSON.stringify(scopeOf(config)))
    .digest("hex");
  return new MissionHttpClient(
    config,
    join(dirname(configPath), `mission-http-state-${hash.slice(0, 16)}.json`),
  );
}
