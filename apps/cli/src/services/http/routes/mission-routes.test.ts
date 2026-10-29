import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ScientificStoreError, ScientificStoreErrorCode } from "@eigengrid/mission-runtime";
import { MissionApplicationError } from "../../mission-application";
import {
  budget,
  makeDecisions,
  makePlan,
  mission,
  structureEvidence,
} from "@eigengrid/scientific-agent/test-fixtures";
import {
  createMissionRouteHandler,
  MissionHttpError,
  MissionHttpMaximumBodyBytes,
  type MissionHttpApplicationPort,
  type MissionHttpIdempotencyRequest,
  type MissionHttpIdempotencyService,
  type MissionHttpMutation,
  type MissionHttpOperation,
  type TrustedMissionHttpSession,
} from "./mission-routes";

const origin = "https://mission.example.test";
const projectId = "project-one";
const base = `/api/v1/projects/${projectId}/missions`;
const missionPath = `${base}/${mission.id}`;
const exact = {
  projectId,
  missionId: mission.id,
  planId: "plan-1",
  candidateDigest: "a".repeat(64),
};
const mutations: MissionHttpMutation[] = ["create", "import", "approve", "compile", "start"];
const allOperations: MissionHttpOperation[] = ["read", "status", "review", ...mutations];

function inputFor(operation: MissionHttpMutation): Record<string, unknown> {
  if (operation === "create") {
    const { requestedBy: _actor, policyProfile: _policy, ...publicMission } = mission;
    return { projectId, mission: publicMission, budget, objectiveEvidence: [structureEvidence] };
  }
  if (operation === "import")
    return {
      projectId,
      missionId: mission.id,
      expectedCandidateDigest: "a".repeat(64),
      candidate: {
        schemaVersion: "eigengrid.mission-candidate/v1",
        plan: makePlan(),
        decisions: makeDecisions(),
        evidence: [structureEvidence],
        candidateDigest: "a".repeat(64),
      },
    };
  if (operation === "approve")
    return {
      ...exact,
      approvalRequestId: "approval-one",
      subjectVersion: 1,
      subjectRevision: 1,
      payloadDigest: "b".repeat(64),
      policyDigest: "c".repeat(64),
      decision: "approved",
      reason: "Exact candidate reviewed",
    };
  return { ...exact };
}

function bodyFor(operation: MissionHttpMutation) {
  return { expectedRevision: operation === "create" ? 0 : 1, request: inputFor(operation) };
}

function post(
  operation: MissionHttpMutation = "start",
  options: {
    body?: BodyInit;
    headers?: Record<string, string>;
    omit?: string[];
    path?: string;
    signal?: AbortSignal;
  } = {},
): Request {
  const headers = new Headers({
    "Content-Type": "application/json",
    Origin: origin,
    "X-CSRF-Token": "csrf-token-from-trusted-session",
    "Idempotency-Key": "request-key-one",
    ...options.headers,
  });
  for (const name of options.omit ?? []) headers.delete(name);
  return new Request(
    `${origin}${options.path ?? (operation === "create" ? base : `${missionPath}/${operation}`)}`,
    {
      method: "POST",
      signal: options.signal,
      headers,
      body: options.body ?? JSON.stringify(bodyFor(operation)),
    },
  );
}

function fixture() {
  const calls: { method: string; input: unknown }[] = [];
  const requests: MissionHttpIdempotencyRequest[] = [];
  const incidents: { incidentId: string; code: string }[] = [];
  const state = {
    revoked: false,
    csrf: true,
    currentChecks: 0,
    beforeExecute: async () => {},
    afterRun: async () => {},
    afterApplication: async () => {},
    error: undefined as unknown,
  };
  const application = Object.fromEntries(
    ["create", "importCandidate", "approve", "compile", "start", "read", "status", "review"].map(
      (method) => [
        method,
        async (input: unknown) => {
          calls.push({ method, input });
          if (state.error) throw state.error;
          await state.afterApplication();
          return {
            missionId: mission.id,
            method,
            state: method === "start" ? "executing" : "ready",
          };
        },
      ],
    ),
  ) as MissionHttpApplicationPort;
  const session: TrustedMissionHttpSession = {
    actorId: "human-one",
    application,
    scopes: [{ projectId, operations: allOperations }],
    async assertCurrent() {
      state.currentChecks++;
      if (state.revoked) throw new MissionHttpError("UNAUTHENTICATED");
    },
    async verifyCsrf(request) {
      return (
        state.csrf && request.headers.get("x-csrf-token") === "csrf-token-from-trusted-session"
      );
    },
  };
  // Test-only fake: exercises the transport/adapter contract, not durable production replay.
  const persisted = new Map<string, { digest: string; operationId: string; result: unknown }>();
  const idempotency: MissionHttpIdempotencyService = {
    async run(request, execute) {
      requests.push(request);
      const identity = JSON.stringify([
        request.actorId,
        request.projectId,
        request.operation,
        request.key,
      ]);
      const prior = persisted.get(identity);
      if (prior) {
        if (prior.digest !== request.requestDigest)
          throw new MissionHttpError("IDEMPOTENCY_CONFLICT");
        await state.afterRun();
        return { operationId: prior.operationId, result: prior.result, replayed: true };
      }
      if (request.expectedRevision !== (request.operation === "create" ? 0 : 1))
        throw new MissionHttpError("REVISION_CONFLICT");
      await state.beforeExecute();
      const result = await execute();
      const operationId = `operation-${persisted.size + 1}`;
      persisted.set(identity, { digest: request.requestDigest, result, operationId });
      await state.afterRun();
      return { operationId, result, replayed: false };
    },
  };
  let currentSession: TrustedMissionHttpSession | null = session;
  const options = {
    origin,
    idempotency,
    resolveSession: async () => currentSession,
    reportIncident: (incident: { incidentId: string; code: string }) => {
      incidents.push(incident);
    },
  };
  return {
    calls,
    requests,
    incidents,
    state,
    session,
    options,
    idempotency,
    setSession(value: TrustedMissionHttpSession | null) {
      currentSession = value;
    },
    handle: createMissionRouteHandler(options),
  };
}

async function failure(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const payload = await response.json();
  expect(payload.error.code).toBe(code);
  expect(payload.error.incidentId).toMatch(/^[a-f0-9-]{36}$/u);
  expect(response.headers.get("x-incident-id")).toBe(payload.error.incidentId);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return payload;
}

describe("mission HTTP transport with trusted session/application ports", () => {
  test("read/status/review use exact project-scoped application addresses", async () => {
    const f = fixture();
    for (const path of [
      missionPath,
      `${missionPath}/status`,
      `${missionPath}/plans/plan-1/review`,
    ]) {
      const response = await f.handle(new Request(`${origin}${path}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(f.calls).toEqual([
      { method: "read", input: { projectId, missionId: mission.id } },
      { method: "status", input: { projectId, missionId: mission.id } },
      { method: "review", input: { projectId, missionId: mission.id, planId: "plan-1" } },
    ]);
    expect(f.requests).toHaveLength(0);
    expect(f.state.currentChecks).toBe(6);
  });

  test("all five mutations call the shared facade through the mandatory durable adapter", async () => {
    const f = fixture();
    for (const operation of mutations) {
      const response = await f.handle(post(operation));
      expect(response.status).toBe(operation === "create" ? 201 : 200);
      expect(response.headers.get("idempotency-replayed")).toBe("false");
      expect((await response.json()).operationId).toMatch(/^operation-/u);
    }
    expect(f.calls.map((call) => call.method)).toEqual([
      "create",
      "importCandidate",
      "approve",
      "compile",
      "start",
    ]);
    expect(f.requests.map((request) => request.operation)).toEqual(mutations);
    for (const request of f.requests) {
      expect(request.actorId).toBe("human-one");
      expect(request.projectId).toBe(projectId);
      expect(request.requestDigest).toBe(
        createHash("sha256")
          .update(
            JSON.stringify(
              bodyFor(mutations.find((operation) => operation === request.operation)!),
            ),
          )
          .digest("hex"),
      );
    }
  });

  test("no session or missing explicit operation/project scope never reaches the facade", async () => {
    const f = fixture();
    f.setSession(null);
    await failure(await f.handle(post()), 401, "UNAUTHENTICATED");
    await failure(await f.handle(new Request(`${origin}${missionPath}`)), 401, "UNAUTHENTICATED");
    for (const scopes of [
      [],
      [{ projectId: "other-project", operations: allOperations }],
      [{ projectId, operations: ["read" as const] }],
    ]) {
      f.setSession({ ...f.session, scopes });
      await failure(await f.handle(post()), 403, "FORBIDDEN");
    }
    expect(f.calls).toHaveLength(0);
    expect(f.requests).toHaveLength(0);
  });

  test("requires configured HTTPS same origin and never trusts forwarded origin headers", async () => {
    const f = fixture();
    for (const request of [
      post("start", { omit: ["Origin"] }),
      post("start", { headers: { Origin: "https://attacker.test" } }),
      post("start", { headers: { Origin: "null" } }),
      post("start", { headers: { "Sec-Fetch-Site": "cross-site" } }),
      new Request(`https://attacker.test${missionPath}`, {
        headers: { "X-Forwarded-Host": "mission.example.test", Origin: origin },
      }),
      new Request(`${origin}${missionPath}`, { headers: { Origin: "https://attacker.test" } }),
    ])
      await failure(await f.handle(request), 403, "FORBIDDEN");
    for (const invalid of [
      "http://mission.example.test",
      `${origin}/`,
      "https://user:secret@mission.example.test",
    ])
      expect(() => createMissionRouteHandler({ ...f.options, origin: invalid })).toThrow(
        "canonical HTTPS origin",
      );
    expect(f.calls).toHaveLength(0);
  });

  test("requires both a CSRF header and positive session-bound verification", async () => {
    const f = fixture();
    await failure(await f.handle(post("start", { omit: ["X-CSRF-Token"] })), 403, "FORBIDDEN");
    await failure(
      await f.handle(post("start", { headers: { "X-CSRF-Token": "forged" } })),
      403,
      "FORBIDDEN",
    );
    f.state.csrf = false;
    await failure(await f.handle(post()), 403, "FORBIDDEN");
    expect(f.requests).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  });

  test("rejects body identity/policy authority, unknown nested fields and path substitution", async () => {
    const f = fixture();
    for (const injected of [
      { actor: { id: "admin", kind: "human", role: "scientific_reviewer" } },
      { authenticatedActor: { id: "admin" } },
      { authorizedRoles: ["scientific_reviewer"] },
      { compilerPolicy: {} },
      { decidedAt: "2026-09-25T00:00:00.000Z" },
      { projectId: "other-project" },
      { missionId: "other-mission" },
    ])
      await failure(
        await f.handle(
          post("start", {
            body: JSON.stringify({ expectedRevision: 1, request: { ...exact, ...injected } }),
          }),
        ),
        400,
        "INVALID_REQUEST",
      );
    const create = inputFor("create");
    for (const change of [
      { ...create, mission: { ...(create.mission as object), requestedBy: mission.requestedBy } },
      { ...create, mission: { ...(create.mission as object), policyProfile: "forged" } },
      { ...create, budget: { ...budget, authorizedRoles: ["admin"] } },
    ])
      await failure(
        await f.handle(
          post("create", { body: JSON.stringify({ expectedRevision: 0, request: change }) }),
        ),
        400,
        "INVALID_REQUEST",
      );
    await failure(
      await f.handle(
        post("start", { body: JSON.stringify({ ...bodyFor("start"), actorId: "admin" }) }),
      ),
      400,
      "INVALID_REQUEST",
    );
    expect(f.calls).toHaveLength(0);
    expect(f.requests).toHaveLength(0);
  });

  test("enforces 4 MiB while streaming even with no or false Content-Length, and cancels excess input", async () => {
    for (const headers of [{}, { "Content-Length": "1" }] as Record<string, string>[]) {
      const f = fixture();
      let cancelled = false;
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          offset++;
          controller.enqueue(new Uint8Array(MissionHttpMaximumBodyBytes / 2 + 1));
        },
        cancel() {
          cancelled = true;
        },
      });
      await failure(await f.handle(post("start", { body, headers })), 413, "REQUEST_TOO_LARGE");
      expect(cancelled).toBe(true);
      expect(offset).toBeLessThanOrEqual(3);
      expect(f.calls).toHaveLength(0);
    }
    const f = fixture();
    await failure(
      await f.handle(
        post("start", { headers: { "Content-Length": String(MissionHttpMaximumBodyBytes + 1) } }),
      ),
      413,
      "REQUEST_TOO_LARGE",
    );
  });

  test("rejects malformed UTF-8/JSON, ambiguous length and non-JSON or compressed media", async () => {
    const f = fixture();
    for (const body of ["", "{", "null", "[]", new Uint8Array([123, 34, 255, 34, 58, 49, 125])])
      await failure(await f.handle(post("start", { body })), 400, "INVALID_REQUEST");
    for (const length of ["1", "-1", "01", "NaN", "2, 3"])
      await failure(
        await f.handle(post("start", { headers: { "Content-Length": length } })),
        400,
        "INVALID_REQUEST",
      );
    for (const type of [
      "text/plain",
      "application/json; charset=iso-8859-1",
      "application/json; extra=yes",
      "application/problem+json",
    ])
      await failure(
        await f.handle(post("start", { headers: { "Content-Type": type } })),
        415,
        "UNSUPPORTED_MEDIA_TYPE",
      );
    await failure(
      await f.handle(post("start", { headers: { "Content-Encoding": "gzip" } })),
      415,
      "UNSUPPORTED_MEDIA_TYPE",
    );
    await failure(
      await f.handle(post("start", { omit: ["Content-Type"] })),
      415,
      "UNSUPPORTED_MEDIA_TYPE",
    );
    expect(f.calls).toHaveLength(0);
  });

  test("a stalled body times out and cancels without awaiting a stalled cancellation hook", async () => {
    const f = fixture();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });
    const handle = createMissionRouteHandler({ ...f.options, bodyReadTimeoutMs: 5 });
    await failure(await handle(post("start", { body })), 408, "REQUEST_TIMEOUT");
    expect(cancelled).toBe(true);
    expect(f.calls).toHaveLength(0);
    expect(f.requests).toHaveLength(0);
    for (const invalid of [0, -1, 30_001, 1.5, NaN, Infinity])
      expect(() => createMissionRouteHandler({ ...f.options, bodyReadTimeoutMs: invalid })).toThrow(
        "body deadline",
      );
  });

  test("an aborted signal immediately cancels a pending body read", async () => {
    const f = fixture();
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = post("start", { body, signal: controller.signal });
    const response = f.handle(request);
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(request.body!.locked).toBe(true);
    controller.abort();
    await failure(await response, 400, "REQUEST_ABORTED");
    expect(cancelled).toBe(true);
    expect(request.body!.locked).toBe(false);
    expect(f.calls).toHaveLength(0);
    await failure(
      await f.handle(post("start", { signal: controller.signal })),
      400,
      "REQUEST_ABORTED",
    );
  });

  test("successful reads remove the deadline and abort listener", async () => {
    const f = fixture();
    const controller = new AbortController();
    const handle = createMissionRouteHandler({ ...f.options, bodyReadTimeoutMs: 5 });
    expect((await handle(post("start", { signal: controller.signal }))).status).toBe(200);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.incidents).toHaveLength(0);
    expect(f.calls).toHaveLength(1);
  });

  test("mutations fail closed without durable idempotency, bounded key or expected revision", async () => {
    const f = fixture();
    const noPersistence = createMissionRouteHandler({ ...f.options, idempotency: undefined });
    await failure(await noPersistence(post()), 503, "DEPENDENCY_UNAVAILABLE");
    await failure(
      await f.handle(post("start", { omit: ["Idempotency-Key"] })),
      400,
      "INVALID_REQUEST",
    );
    await failure(
      await f.handle(post("start", { headers: { "Idempotency-Key": "a".repeat(129) } })),
      400,
      "INVALID_REQUEST",
    );
    for (const expectedRevision of [undefined, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])
      await failure(
        await f.handle(
          post("start", { body: JSON.stringify({ expectedRevision, request: exact }) }),
        ),
        400,
        "INVALID_REQUEST",
      );
    await failure(
      await f.handle(
        post("create", {
          body: JSON.stringify({ expectedRevision: 1, request: inputFor("create") }),
        }),
      ),
      400,
      "INVALID_REQUEST",
    );
    await failure(
      await f.handle(
        post("start", { body: JSON.stringify({ expectedRevision: 2, request: exact }) }),
      ),
      409,
      "REVISION_CONFLICT",
    );
    expect(f.calls).toHaveLength(0);
  });

  test("identical bytes replay stable operation/result; changed bytes conflict under the same actor/project/operation key", async () => {
    const f = fixture();
    const first = await f.handle(post());
    const replay = await f.handle(post());
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(await replay.json()).toEqual(await first.json());
    expect(f.calls).toHaveLength(1);
    await failure(
      await f.handle(post("start", { body: `${JSON.stringify(bodyFor("start"))}\n` })),
      409,
      "IDEMPOTENCY_CONFLICT",
    );
    f.setSession({ ...f.session, actorId: "human-two" });
    expect((await f.handle(post())).status).toBe(200);
    expect(f.calls).toHaveLength(2);
    expect(f.requests.at(-1)?.actorId).toBe("human-two");
  });

  test("rechecks revocation after body reads, before execution, and before replay/read disclosure", async () => {
    const duringRead = fixture();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.close();
          return;
        }
        sent = true;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(bodyFor("start"))));
        duringRead.state.revoked = true;
      },
    });
    await failure(await duringRead.handle(post("start", { body })), 401, "UNAUTHENTICATED");
    expect(duringRead.calls).toHaveLength(0);
    const beforeExecute = fixture();
    beforeExecute.state.beforeExecute = async () => {
      beforeExecute.state.revoked = true;
    };
    await failure(await beforeExecute.handle(post()), 401, "UNAUTHENTICATED");
    expect(beforeExecute.calls).toHaveLength(0);
    const replay = fixture();
    expect((await replay.handle(post())).status).toBe(200);
    replay.state.afterRun = async () => {
      replay.state.revoked = true;
    };
    await failure(await replay.handle(post()), 401, "UNAUTHENTICATED");
    expect(replay.calls).toHaveLength(1);
    const read = fixture();
    read.state.afterApplication = async () => {
      read.state.revoked = true;
    };
    await failure(
      await read.handle(new Request(`${origin}${missionPath}`)),
      401,
      "UNAUTHENTICATED",
    );
  });

  test("never invokes an operation twice when a faulty adapter repeats the execution callback", async () => {
    const f = fixture();
    const handle = createMissionRouteHandler({
      ...f.options,
      idempotency: {
        async run(_request, execute) {
          await execute();
          return { operationId: "bad-adapter", result: await execute(), replayed: false };
        },
      },
    });
    await failure(await handle(post()), 409, "EFFECT_UNCERTAIN");
    expect(f.calls).toHaveLength(1);
  });

  test("typed failures stay distinct and never expose SQL, exception details or private paths", async () => {
    const cases = [
      [ScientificStoreErrorCode.REVISION_CONFLICT, 409, "REVISION_CONFLICT"],
      [ScientificStoreErrorCode.APPROVAL_EXPIRED, 409, "APPROVAL_EXPIRED"],
      [ScientificStoreErrorCode.APPROVAL_POLICY_MISMATCH, 409, "POLICY_CHANGED"],
      [ScientificStoreErrorCode.BUDGET_EXCEEDED, 429, "QUOTA_EXCEEDED"],
      [ScientificStoreErrorCode.RECONCILIATION_REQUIRED, 409, "EFFECT_UNCERTAIN"],
      [ScientificStoreErrorCode.APPROVAL_UNAUTHORIZED, 403, "FORBIDDEN"],
    ] as const;
    for (const [code, status, safe] of cases) {
      const f = fixture();
      f.state.error = new ScientificStoreError("SELECT secret FROM /private/keys", code, {
        databaseUrl: "postgresql://user:secret@host/db",
      });
      const payload = await failure(await f.handle(post()), status, safe);
      expect(JSON.stringify(payload)).not.toContain("secret");
      expect(f.incidents).toEqual([{ incidentId: payload.error.incidentId, code: safe }]);
    }
    const f = fixture();
    f.state.error = new Error("Cookie: secret; /private/keys; SQL failure");
    const payload = await failure(await f.handle(post()), 500, "INTERNAL_ERROR");
    expect(JSON.stringify(payload)).not.toContain("secret");
    expect(Object.keys(payload.error).sort()).toEqual(["code", "incidentId", "message"]);
  });

  test("unknown paths, encoded separators, extra query fields and unsupported methods do not dispatch", async () => {
    const f = fixture();
    for (const path of [
      "/api/v1/missions",
      `${missionPath}/`,
      `${base}/mission%2fother`,
      `${missionPath}/pause`,
    ])
      await failure(await f.handle(new Request(`${origin}${path}`)), 404, "NOT_FOUND");
    await failure(
      await f.handle(new Request(`${origin}${missionPath}?actorId=admin`)),
      400,
      "INVALID_REQUEST",
    );
    await failure(
      await f.handle(new Request(`${origin}${missionPath}`, { method: "DELETE" })),
      405,
      "METHOD_NOT_ALLOWED",
    );
    expect(f.calls).toHaveLength(0);
  });

  test("routine facade failures map safely and inaccessible missions match absent missions", async () => {
    for (const [code, status, safe] of [
      ["FORBIDDEN", 403, "FORBIDDEN"],
      ["INVALID_CANDIDATE", 400, "INVALID_REQUEST"],
      ["CANDIDATE_CHANGED", 409, "CONFLICT"],
      ["ENVIRONMENT_CHANGED", 409, "ENVIRONMENT_CHANGED"],
      ["APPROVAL_REQUIRED", 409, "CONFLICT"],
      ["CONFLICT", 409, "CONFLICT"],
    ] as const) {
      const f = fixture();
      f.state.error = new MissionApplicationError(code, "private owner or candidate detail");
      const response = await failure(await f.handle(post()), status, safe);
      expect(JSON.stringify(response)).not.toContain("private");
    }
    const responses: unknown[] = [];
    for (const error of [
      new MissionApplicationError("NOT_FOUND", "Owner is another person"),
      new ScientificStoreError("Missing mission id", ScientificStoreErrorCode.NOT_FOUND),
    ]) {
      const f = fixture();
      f.state.error = error;
      for (const suffix of ["", "/status", "/plans/plan-1/review"]) {
        const payload = await failure(
          await f.handle(new Request(`${origin}${missionPath}${suffix}`)),
          404,
          "NOT_FOUND",
        );
        responses.push({ ...payload.error, incidentId: "unique" });
      }
    }
    expect(responses.every((item) => JSON.stringify(item) === JSON.stringify(responses[0]))).toBe(
      true,
    );
  });
});
