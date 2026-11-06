import { describe, expect, test } from "bun:test";
import { Api, ApiError, canonical, sha256 } from "../../apps/web/src/api.browser.js";
import { announceSessionChange, watchSessionChanges } from "../../apps/web/src/session.browser.js";
import { createRequest } from "../../apps/web/src/create.browser.js";
import { MissionCreateRequestSchema } from "../../apps/cli/src/services/mission-application";
import { agentDigest } from "@eigengrid/agent-runtime";
import { recoveryDestination } from "../../apps/web/src/recovery.browser.js";

class MemoryStorage implements Storage {
  values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}
const session = {
  actor: { id: "fixture-human", kind: "human" },
  roles: ["scientific_reviewer"],
  csrfToken: "fixture-csrf-secret",
};
const response = (value: unknown, status = 200) => Response.json(value, { status });
const errorResponse = (code: string, status: number) => {
  const incidentId = crypto.randomUUID();
  return Response.json(
    { error: { code, message: code, incidentId } },
    {
      status,
      headers: { "X-Incident-Id": incidentId },
    },
  );
};
const scope = { projectId: "project-web", missionId: "mission-web" };
const path = "/projects/project-web/missions/mission-web/start";
const request = {
  ...scope,
  candidateDigest: "a".repeat(64),
  privateScientificInput: "never-persist-this",
};

describe("browser client durability and scientific request contracts", () => {
  test("cross-tab changes and focus revalidate without sharing session credentials", () => {
    const storage = new MemoryStorage();
    announceSessionChange(storage);
    const [key, nonce] = [...storage.values.entries()][0]!;
    expect(nonce).toMatch(/^[a-f0-9-]{36}$/u);
    const target = new EventTarget();
    let changes = 0;
    const stop = watchSessionChanges(target, () => changes++);
    const storageEvent = (name: string) => {
      const event = new Event("storage");
      Object.defineProperty(event, "key", { value: name });
      target.dispatchEvent(event);
    };
    storageEvent("unrelated");
    expect(changes).toBe(0);
    storageEvent(key);
    target.dispatchEvent(new Event("focus"));
    expect(changes).toBe(2);
    stop();
    storageEvent(key);
    expect(changes).toBe(2);
  });

  test.each([200, 401])(
    "a late %s response cannot restore or clear another session",
    async (status) => {
      let finish!: (response: Response) => void;
      const client = new Api(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        new MemoryStorage(),
      );
      client.session = session;
      const pending = client.bootstrap();
      client.invalidateSession();
      const nextSession = { ...session, actor: { ...session.actor, id: "another-human" } };
      client.session = nextSession;
      finish(status === 200 ? response(session) : errorResponse("UNAUTHORIZED", status));
      await expect(pending).rejects.toThrow("session changed");
      expect(client.session).toBe(nextSession);
    },
  );

  test.each(["mutation", "lookup"])(
    "a proxy error during %s cannot authorize clearing an outstanding key",
    async (untrusted) => {
      const client = new Api(async (_url, options) => {
        const mutation = options?.method === "POST";
        if ((untrusted === "mutation") === mutation)
          return response(
            { error: { code: "PROXY_ERROR", message: "Gateway failure" } },
            mutation ? 502 : 404,
          );
        return errorResponse(mutation ? "REVISION_CONFLICT" : "NOT_FOUND", mutation ? 409 : 404);
      }, new MemoryStorage());
      client.session = session;
      await expect(
        client.mutate(path, scope.projectId, scope.missionId, "start", 7, request),
      ).rejects.toThrow();
      await expect(client.recover(client.pending[0]!)).rejects.toBeInstanceOf(ApiError);
      expect(client.pending).toHaveLength(1);
    },
  );

  test("bootstrap and mutations use session CSRF, same-origin cookies and no credential storage", async () => {
    const storage = new MemoryStorage();
    const calls: { url: string; options?: RequestInit }[] = [];
    const client = new Api(async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/auth/login")) return response({ csrfToken: session.csrfToken });
      if (String(url).endsWith("/auth/session")) return response(session);
      return response({ operationId: "operation-test", result: { recorded: true } });
    }, storage);
    await client.login("A".repeat(43));
    await client.mutate(path, scope.projectId, scope.missionId, "start", 7, request);
    const post = calls[2]!;
    expect(post.options?.credentials).toBe("same-origin");
    expect(post.options?.cache).toBe("no-store");
    expect(post.options?.redirect).toBe("error");
    expect(new Headers(post.options?.headers).get("x-csrf-token")).toBe(session.csrfToken);
    expect(new Headers(post.options?.headers).get("idempotency-key")).toMatch(/^[a-f0-9-]{36}$/u);
    expect(JSON.parse(String(post.options?.body))).toEqual({ expectedRevision: 7, request });
    expect(JSON.stringify([...storage.values.values()])).not.toContain("secret");
    expect(JSON.stringify([...storage.values.values()])).not.toContain("never-persist-this");
    expect(client.pending).toHaveLength(0);
  });

  test("a lost response persists only recovery metadata and fences duplicate effects across reload", async () => {
    const storage = new MemoryStorage();
    let effects = 0;
    const client = new Api(async () => {
      effects++;
      throw new TypeError("connection lost");
    }, storage);
    client.session = session;
    await expect(
      client.mutate(path, scope.projectId, scope.missionId, "start", 7, request),
    ).rejects.toThrow("outstanding request");
    expect(client.pending).toHaveLength(1);
    const persisted = JSON.stringify([...storage.values.values()]);
    expect(persisted).not.toContain("never-persist-this");
    expect(persisted).not.toContain("fixture-csrf-secret");
    const next = new Api(async (url, options) => {
      expect(options?.method).not.toBe("POST");
      expect(String(url)).toContain(
        `/requests/start/${client.pending[0]!.key}?missionId=${scope.missionId}`,
      );
      return response({
        result: { operationId: "recovered", status: "complete", result: { admitted: true } },
      });
    }, storage);
    next.session = session;
    await expect(
      next.mutate(path, scope.projectId, scope.missionId, "start", 7, request),
    ).rejects.toThrow("outstanding request");
    expect(effects).toBe(1);
    expect((await next.recover(next.pending[0]!)).status).toBe("complete");
    expect(next.pending).toHaveLength(0);
    expect(new Api(fetch, storage).pending).toHaveLength(0);
  });

  test("absence cannot clear a disconnected request that could still be in flight", async () => {
    const client = new Api(async (_url, options) => {
      if (options?.method === "POST") throw new TypeError("connection lost");
      return errorResponse("NOT_FOUND", 404);
    }, new MemoryStorage());
    client.session = session;
    await expect(
      client.mutate(path, scope.projectId, scope.missionId, "start", 7, request),
    ).rejects.toThrow();
    await expect(client.recover(client.pending[0]!)).rejects.toBeInstanceOf(ApiError);
    expect(client.outstanding(scope.projectId, scope.missionId)).toHaveLength(1);
    client.session = { ...session, actor: { ...session.actor, id: "another-human" } };
    expect(client.outstanding(scope.projectId, scope.missionId)).toHaveLength(0);
  });

  test("a received rejection can clear only after an authorized absent lookup", async () => {
    const storage = new MemoryStorage();
    const client = new Api(
      async (_url, options) =>
        options?.method === "POST"
          ? errorResponse("REVISION_CONFLICT", 409)
          : errorResponse("NOT_FOUND", 404),
      storage,
    );
    client.session = session;
    await expect(
      client.mutate(path, scope.projectId, scope.missionId, "start", 7, request),
    ).rejects.toThrow();
    const next = new Api(client.transport, storage);
    next.session = session;
    expect((await next.recover(next.pending[0]!)).status).toBe("not_recorded");
    expect(next.pending).toHaveLength(0);
  });

  test("a received error with a reserved key remains blocked until explicit reconciliation", async () => {
    let mutations = 0;
    const client = new Api(async (url, options) => {
      if (String(url).endsWith("/reconcile"))
        return response({ result: { recoveredFromCanonical: true } });
      if (options?.method === "POST") {
        mutations++;
        return errorResponse("EFFECT_UNCERTAIN", 409);
      }
      return response({ result: { operationId: "pending-operation", status: "pending" } });
    }, new MemoryStorage());
    client.session = session;
    await expect(
      client.mutate(path, scope.projectId, scope.missionId, "start", 7, request),
    ).rejects.toThrow();
    const entry = client.pending[0]!;
    expect((await client.recover(entry)).status).toBe("pending");
    expect(client.pending).toHaveLength(1);
    await client.reconcile(entry, "pending-operation");
    expect(client.pending).toHaveLength(0);
    expect(mutations).toBe(1);
  });

  test("unavailable storage prevents submission, and a failed completion write preserves the fence", async () => {
    let calls = 0;
    const transport = async () => {
      calls++;
      return response({ operationId: "done", result: {} });
    };
    const noStorage = new Api(transport, null);
    noStorage.session = session;
    await expect(
      noStorage.mutate(path, scope.projectId, scope.missionId, "start", 7, request),
    ).rejects.toThrow("storage");
    expect(calls).toBe(0);
    const storage = new MemoryStorage();
    let writes = 0;
    const original = storage.setItem.bind(storage);
    storage.setItem = (key, value) => {
      if (++writes === 2) throw new Error("storage quota");
      original(key, value);
    };
    const client = new Api(transport, storage);
    client.session = session;
    await expect(
      client.mutate(path, scope.projectId, scope.missionId, "start", 7, request),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(client.pending).toHaveLength(1);
  });

  test("recovering an opened agent preserves its session address instead of losing it after refresh", () => {
    const entry = {
      actorId: session.actor.id,
      ...scope,
      operation: "agent.open",
      key: "key",
      createdAt: new Date().toISOString(),
    };
    const sessionId = "61f368eb-7ce0-4b78-b165-0e97f1839c77";
    const destination = `#/projects/${scope.projectId}/missions/${scope.missionId}/agent/${sessionId}`;
    expect(recoveryDestination(entry, { sessionId })).toBe(destination);
    expect(
      recoveryDestination(entry, { recoveredFromCanonical: true, observation: { sessionId } }),
    ).toBe(destination);
    expect(recoveryDestination(entry, { sessionId: "javascript:bad" })).toBeNull();
  });

  test("browser tool approval digests match the canonical agent including Unicode and nested inputs", async () => {
    for (const value of [
      null,
      { z: [1, { alpha: "μ Δ", beta: true }], a: "line\n2" },
      { number: -0, nested: { z: 1, a: 2 } },
    ]) {
      expect(await sha256(new TextEncoder().encode(canonical(value)).buffer)).toBe(
        agentDigest(value),
      );
    }
  });

  test("guided creation produces the real DTO with explicit budgets and no invented molecular values or authority", () => {
    const dto = createRequest({
      ...scope,
      statement: "A fixture research question",
      targetProperties: ["relative energy"],
      allowedEngines: ["fixture"],
      criteria: ["A reviewer confirms the explicit comparison."],
      limits: { externalOperations: 3, modelTokens: 0, wallTimeSeconds: 600, cost: 0 },
      digest: "a".repeat(64),
      size: 40,
      format: "xyz",
      confidence: "screening",
      offline: true,
    });
    expect(MissionCreateRequestSchema.parse(dto)).toEqual(dto);
    expect(dto.mission.objective.system).not.toHaveProperty("charge");
    expect(dto.mission.objective.system).not.toHaveProperty("multiplicity");
    expect(dto.mission).not.toHaveProperty("requestedBy");
    expect(dto.mission).not.toHaveProperty("policyProfile");
    expect(dto.mission.acceptanceCriteria[0]!.kind).toBe("custom");
    expect(dto.objectiveEvidence[0]!.uri).toBe(`cas://sha256/${"a".repeat(64)}`);
  });

  test("uploads bind the exact bytes to SHA-256 and reject oversized or empty files before transport", async () => {
    let calls = 0;
    const client = new Api(async (url, options) => {
      calls++;
      const bytes = options?.body as ArrayBuffer;
      expect(new Headers(options?.headers).get("content-type")).toBe("application/octet-stream");
      expect(String(url)).toEndWith(await sha256(bytes));
      return response({ stored: true });
    }, new MemoryStorage());
    client.session = session;
    await expect(client.upload(scope.projectId, new File([], "empty.xyz"))).rejects.toThrow();
    expect(calls).toBe(0);
    await client.upload(scope.projectId, new File(["fixture structure\n"], "fixture.xyz"));
    expect(calls).toBe(1);
  });
});
