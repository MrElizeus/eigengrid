/** @typedef {import('./contracts').Session} Session */
/** @typedef {import('./contracts').PendingRequest} PendingRequest */
const pendingStorage = "eigengrid.web.pending.v1";
/** Opaque credentials and CSRF tokens never enter browser storage. */
export class Api {
  generation = 0;
  /** @type {Session | null} */ session = null;
  /** @type {PendingRequest[]} */ pending = [];
  /** @param {typeof fetch} [transport] @param {Storage | null} [storage] */
  constructor(transport = fetch, storage) {
    this.transport = transport;
    /** @type {Storage | null | undefined} */
    this.storage = null;
    try {
      this.storage = storage === undefined ? globalThis.sessionStorage : storage;
      const value = JSON.parse(this.storage?.getItem(pendingStorage) ?? "[]");
      if (Array.isArray(value))
        this.pending = value
          .filter(
            (item) =>
              item &&
              ["actorId", "projectId", "missionId", "operation", "key", "createdAt"].every(
                (key) => typeof item[key] === "string",
              ),
          )
          .map((item) => ({
            actorId: item.actorId,
            projectId: item.projectId,
            missionId: item.missionId,
            operation: item.operation,
            key: item.key,
            createdAt: item.createdAt,
            responseReceived: item.responseReceived === true,
          }));
    } catch {
      /* A blocked storage area is surfaced before any mutation. */
    }
  }
  /** @template T @param {string} path @param {RequestInit} [options] @returns {Promise<T>} */
  async request(path, options = {}) {
    const generation = this.generation;
    const headers = new Headers(options.headers);
    if (options.method && options.method !== "GET" && this.session)
      headers.set("X-CSRF-Token", this.session.csrfToken);
    const response = await this.transport(`/api/v1${path}`, {
      ...options,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)])
        : AbortSignal.timeout(120000),
    });
    const data = await response.json();
    if (generation !== this.generation)
      throw new DOMException("The session changed.", "AbortError");
    if (!response.ok) {
      const incident = response.headers.get("X-Incident-Id");
      const error = new ApiError(
        data?.error?.code ?? "HTTP_ERROR",
        data?.error?.message ?? `Request failed (${response.status}).`,
        response.status,
        !!incident &&
          /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(incident) &&
          incident === data?.error?.incidentId,
      );
      if (response.status === 401) {
        this.invalidateSession();
        globalThis.dispatchEvent?.(new Event("eigengrid:session-expired"));
      }
      throw error;
    }
    return data;
  }
  invalidateSession() {
    this.generation++;
    this.session = null;
  }
  /** @param {AbortSignal} [signal] */
  async bootstrap(signal) {
    this.session = await this.request("/auth/session", { signal });
    return this.session;
  }
  /** @param {string} credential */
  async login(credential) {
    await this.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    return this.bootstrap();
  }
  async logout() {
    await this.request("/auth/logout", { method: "POST" });
    this.invalidateSession();
  }
  /** @template T @param {string} path @param {AbortSignal} [signal] @returns {Promise<T>} */
  async get(path, signal) {
    const data = await this.request(path, { signal });
    return data.result;
  }
  /** @template T @param {string} path @param {AbortSignal} [signal] @returns {Promise<T[]>} */
  async list(path, signal) {
    /** @type {T[]} */ const items = [];
    let after = "";
    do {
      /** @type {import('./contracts').Page<T>} */
      const page = await this.get(
        `${path}?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`,
        signal,
      );
      items.push(...page.items);
      if (page.nextCursor === after || items.length >= 10000)
        throw new Error("This catalog is too large. Narrow access using the CLI.");
      after = page.nextCursor ?? "";
    } while (after);
    return items;
  }
  /** @param {PendingRequest[]} [entries] */
  persist(entries = this.pending) {
    if (!this.storage)
      throw new Error(
        "Session storage is required to track operations safely. Enable it before submitting a request.",
      );
    if (entries.length > 100)
      throw new Error("Resolve outstanding requests before submitting more operations.");
    this.storage.setItem(pendingStorage, JSON.stringify(entries));
  }
  /** @param {string} projectId @param {string} missionId */
  outstanding(projectId, missionId) {
    return this.pending.filter(
      (item) =>
        item.actorId === this.session?.actor.id &&
        item.projectId === projectId &&
        item.missionId === missionId,
    );
  }
  /** @param {string} path @param {string} projectId @param {string} missionId @param {string} operation @param {number} expectedRevision @param {unknown} request @returns {Promise<import('./contracts').MutationResult>} */
  async mutate(path, projectId, missionId, operation, expectedRevision, request) {
    if (!this.session) throw new Error("Sign in before continuing.");
    if (this.outstanding(projectId, missionId).length)
      throw new Error(
        "Resolve the outstanding request for this mission before submitting another operation.",
      );
    /** @type {PendingRequest} */
    const entry = {
      actorId: this.session.actor.id,
      projectId,
      missionId,
      operation,
      key: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.pending.push(entry);
    try {
      this.persist();
    } catch (error) {
      this.pending = this.pending.filter((item) => item !== entry);
      throw error;
    }
    try {
      const result = await this.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": entry.key },
        body: JSON.stringify({ expectedRevision, request }),
      });
      this.forget(entry);
      return result;
    } catch (error) {
      // Even a server error can follow a committed effect. Keep the durable key,
      // never repeat the POST or manufacture a success from a transport failure.
      if (error instanceof ApiError && error.applicationResponse) {
        entry.responseReceived = true;
        this.persist();
      }
      throw new Error(
        `${error instanceof Error ? error.message : "Connection lost."} Check the outstanding request before trying again.`,
      );
    }
  }
  /** @param {PendingRequest} entry */
  forget(entry) {
    const remaining = this.pending.filter((item) => item.key !== entry.key);
    this.persist(remaining);
    this.pending = remaining;
  }
  /** @param {PendingRequest} entry @returns {Promise<import('./contracts').Recovery>} */
  async recover(entry) {
    try {
      const result = await this.get(
        `/projects/${encodeURIComponent(entry.projectId)}/requests/${encodeURIComponent(entry.operation)}/${encodeURIComponent(entry.key)}?missionId=${encodeURIComponent(entry.missionId)}`,
      );
      if (result.status === "complete") this.forget(entry);
      return result;
    } catch (error) {
      // A received rejection followed by an authorized absent lookup means the
      // server finished without reserving this key. A lost connection alone
      // never establishes absence: its request could still be in flight.
      if (
        error instanceof ApiError &&
        error.applicationResponse &&
        error.status === 404 &&
        entry.responseReceived
      ) {
        this.forget(entry);
        return { status: "not_recorded", operationId: "" };
      }
      throw error;
    }
  }
  /** @param {PendingRequest} entry @param {string} operationId */
  async reconcile(entry, operationId) {
    const result = await this.request(
      `${missionPath(entry.projectId, entry.missionId)}/operations/${encodeURIComponent(operationId)}/reconcile`,
      { method: "POST" },
    );
    this.forget(entry);
    return result;
  }
  /** @param {string} projectId @param {File} file */
  async upload(projectId, file) {
    if (file.size === 0 || file.size > 64 * 1024 * 1024)
      throw new Error("Choose a nonempty file smaller than 64 MiB.");
    const bytes = await file.arrayBuffer();
    const digest = await sha256(bytes);
    await this.request(`/projects/${encodeURIComponent(projectId)}/artifacts/${digest}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
    });
    return digest;
  }
}
export class ApiError extends Error {
  /** @param {string} code @param {string} message @param {number} status @param {boolean} [applicationResponse] */
  constructor(code, message, status, applicationResponse = false) {
    super(message);
    this.code = code;
    this.status = status;
    this.applicationResponse = applicationResponse;
  }
}
/** @param {string} projectId @param {string} [missionId] */
export const missionPath = (projectId, missionId) =>
  `/projects/${encodeURIComponent(projectId)}/missions${missionId ? `/${encodeURIComponent(missionId)}` : ""}`;
/** @param {ArrayBuffer} bytes */
export async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}
/** JSON values from the server are plain and bounded. Matches canonicalAgentJson. @param {unknown} value @returns {string} */
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = /** @type {Record<string, unknown>} */ (value);
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}
export const api = new Api();
