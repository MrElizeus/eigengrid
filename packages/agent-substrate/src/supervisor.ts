import { mkdir } from "node:fs/promises";
import { appendFileSync, chmodSync, closeSync, fsyncSync, openSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentSubstratePreflightReceipt } from "./compatibility";
import {
  authorizeCodexClientNotification,
  authorizeCodexClientRequest,
  authorizeCodexServerRequest,
  type AllowedCodexClientNotificationMethod,
  type AllowedCodexServerRequestMethod,
} from "./rpc-policy";
import type { CodexAppServerTransport, CodexServerRequestDispatcher } from "./adapter";

export type CodexSupervisorState =
  | "stopped"
  | "starting"
  | "ready"
  | "degraded"
  | "incompatible"
  | "crashed";

export interface CodexProcessLike {
  readonly pid?: number;
  readonly stdin: { write(chunk: string): boolean; end(): void };
  readonly stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  readonly stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  on(event: "error", listener: (error: Error) => void): unknown;
  once(event: "spawn" | "exit" | "close", listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type CodexProcessFactory = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] },
) => CodexProcessLike;

export interface CodexSupervisorJournal {
  append(entry: Record<string, unknown>): Promise<void>;
}

export interface CodexSupervisorEvent {
  readonly protocol: string;
  readonly sequence: number;
  readonly at: string;
  readonly type: string;
  readonly id?: string | number;
  readonly method?: string;
}

export class DurableCodexSupervisorJournal implements CodexSupervisorJournal {
  private chain = Promise.resolve();
  constructor(private readonly path: string) {}

  append(entry: Record<string, unknown>): Promise<void> {
    this.chain = this.chain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const descriptor = openSync(this.path, "a", 0o600);
      try {
        appendFileSync(descriptor, `${JSON.stringify(entry)}\n`, "utf8");
        fsyncSync(descriptor);
        chmodSync(this.path, 0o600);
      } finally {
        closeSync(descriptor);
      }
    });
    return this.chain;
  }
}

export interface CodexAppServerSupervisorOptions {
  preflight: AgentSubstratePreflightReceipt;
  command?: string;
  args?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  processFactory?: CodexProcessFactory;
  journal?: CodexSupervisorJournal;
  requestTimeoutMs?: number;
  /** Host capability dispatcher for the one allow-listed upstream server request. */
  serverRequestDispatcher?: CodexServerRequestDispatcher;
  /** Maximum unframed upstream data retained before the engagement fails closed. */
  maxBufferedBytes?: number;
  /** Maximum number of simultaneously unresolved client requests. */
  maxPendingRequests?: number;
  now?: () => string;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_SERVER_NOTIFICATIONS = new Set([
  "thread/started",
  "thread/resumed",
  "thread/closed",
  "turn/started",
  "turn/steered",
  "turn/interrupted",
  "turn/completed",
  "turn/failed",
  "item/started",
  "item/completed",
  "output/delta",
  "usage/updated",
  "approval/paused",
  "approval/resumed",
  "error",
]);

function defaultProcessFactory(
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] },
): CodexProcessLike {
  return spawn(command, [...args], options) as unknown as ChildProcessWithoutNullStreams;
}

/**
 * Supervised private-stdio Codex app-server process. The supervisor is a
 * generic transport/lifecycle component: it has no mission, scientific, DB,
 * scheduler, or credential authority and is deliberately not composed into
 * the CLI until its qualification gate is enabled.
 */
export class CodexAppServerSupervisor {
  private process: CodexProcessLike | undefined;
  private state: CodexSupervisorState = "stopped";
  private buffer = "";
  private requestSequence = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private readonly now: () => string;
  private readonly journal: CodexSupervisorJournal;
  private readonly processFactory: CodexProcessFactory;
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly serverRequestDispatcher?: CodexServerRequestDispatcher;
  private readonly maxBufferedBytes: number;
  private readonly maxPendingRequests: number;
  private eventSequence = 0;
  private readonly serverRequestIds = new Set<string>();

  constructor(private readonly options: CodexAppServerSupervisorOptions) {
    this.command = options.command ?? "codex";
    this.args = options.args ?? ["app-server"];
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.now = options.now ?? (() => new Date().toISOString());
    this.processFactory = options.processFactory ?? defaultProcessFactory;
    this.journal = options.journal ?? { append: async () => {} };
    this.serverRequestDispatcher = options.serverRequestDispatcher;
    this.maxBufferedBytes = positiveBound(
      options.maxBufferedBytes ?? 1_048_576,
      "maxBufferedBytes",
    );
    this.maxPendingRequests = positiveBound(
      options.maxPendingRequests ?? 128,
      "maxPendingRequests",
    );
    if (!(options.preflight && typeof options.preflight === "object")) {
      throw new TypeError("A verified Codex preflight receipt is required");
    }
  }

  get status(): CodexSupervisorState {
    return this.state;
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }

  /** Start exactly one private stdio child after the caller's preflight. */
  async start(): Promise<void> {
    if (this.process && (this.state === "starting" || this.state === "ready")) return;
    this.state = "starting";
    // Never inherit provider/license/SSH/database credentials into the generic
    // agent, including aliases supplied through the caller's environment.
    const environment = sanitizeAgentEnvironment({
      ...process.env,
      ...this.options.environment,
    });
    const child = this.processFactory(this.command, this.args, {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;
    child.stdout.on("data", (chunk) => this.consume(chunk));
    child.stderr.on("data", (chunk) => {
      void this.record({ type: "stderr", data: String(chunk).slice(0, 4_096) });
    });
    child.on("error", (error) => this.crash(error));
    child.once("exit", (...args) =>
      this.crash(new Error(`Codex app-server exited: ${args[0] ?? "unknown"}`)),
    );
    await this.record({
      type: "process.started",
      pid: child.pid,
      command: this.command,
      args: this.args,
    });
    // Spawn is asynchronous on Node. A process reaching this point is ready
    // for requests; the protocol initialize call remains the caller's gate.
    this.state = "ready";
  }

  asTransport(): CodexAppServerTransport {
    return {
      request: async (method, params) => this.request(method, params),
      notify: (method, params) => {
        void this.notify(method, params);
      },
    };
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const allowed = authorizeCodexClientRequest(method);
    if (this.state !== "ready" || !this.process)
      throw new Error(`Codex app-server is not ready: ${this.state}`);
    if (this.pending.size >= this.maxPendingRequests)
      throw new Error("Codex app-server request queue is full");
    const id = `eg-${++this.requestSequence}-${randomUUID()}`;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method: allowed, params })}\n`;
    await this.record({ type: "request", id, method: allowed });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${allowed}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.process?.stdin.write(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async notify(method: string, params: unknown): Promise<void> {
    const allowed: AllowedCodexClientNotificationMethod = authorizeCodexClientNotification(method);
    if (this.state !== "ready" || !this.process)
      throw new Error(`Codex app-server is not ready: ${this.state}`);
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: allowed, params })}\n`);
    await this.record({ type: "notification", method: allowed });
  }

  /** Bounded graceful shutdown; no external scientific job is cancelled here. */
  async stop(timeoutMs = 5_000): Promise<void> {
    const child = this.process;
    if (!child) {
      this.state = "stopped";
      return;
    }
    this.state = "degraded";
    child.stdin.end();
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, timeoutMs)));
    if (this.process === child) child.kill("SIGKILL");
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Codex supervisor stopped while request ${id} was pending`));
    }
    this.pending.clear();
    this.process = undefined;
    this.state = "stopped";
    await this.record({ type: "process.stopped" });
  }

  private consume(chunk: Buffer | string): void {
    if (this.state === "incompatible" || this.state === "crashed" || this.state === "stopped")
      return;
    const incoming = String(chunk);
    if (incoming.length > this.maxBufferedBytes * 4) {
      this.incompatible("Codex output chunk exceeds the bounded transport limit");
      return;
    }
    this.buffer += incoming;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        if (this.buffer.length > this.maxBufferedBytes)
          this.incompatible(
            "Codex emitted an unterminated message over the bounded transport limit",
          );
        return;
      }
      if (newline > this.maxBufferedBytes) {
        this.incompatible("Codex emitted a message over the bounded transport limit");
        return;
      }
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.incompatible("Codex emitted malformed JSON");
        continue;
      }
      this.handleMessage(message);
      const stateAfterMessage = this.state as CodexSupervisorState;
      if (stateAfterMessage === "incompatible" || stateAfterMessage === "crashed") return;
    }
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.incompatible("Codex emitted a non-object message");
      return;
    }
    const record = message as Record<string, unknown>;
    if (typeof record.method === "string" && isRpcId(record.id)) {
      this.handleServerRequest(record.id, record.method, record.params);
      return;
    }
    if (typeof record.id === "string") {
      const pending = this.pending.get(record.id);
      if (!pending) {
        this.incompatible(`Codex response references unknown request ${record.id}`);
        return;
      }
      this.pending.delete(record.id);
      clearTimeout(pending.timer);
      if (Object.hasOwn(record, "error"))
        pending.reject(new Error("Codex app-server request failed"));
      else pending.resolve(record.result);
      void this.record({ type: "response", id: record.id, ok: !Object.hasOwn(record, "error") });
      return;
    }
    if (typeof record.method !== "string") {
      this.incompatible("Codex emitted a message without id or method");
      return;
    }
    if (!DEFAULT_SERVER_NOTIFICATIONS.has(record.method)) {
      this.incompatible(`Codex emitted an unknown critical event: ${record.method}`);
      return;
    }
    void this.record({ type: "event", method: record.method });
  }

  private handleServerRequest(id: string | number, method: string, params: unknown): void {
    let allowed: AllowedCodexServerRequestMethod;
    try {
      allowed = authorizeCodexServerRequest(method);
    } catch {
      this.incompatible(`Codex emitted an unauthorized server request: ${method}`);
      return;
    }
    if (!this.serverRequestDispatcher) {
      this.incompatible("Codex server request has no registered EigenGrid capability dispatcher");
      return;
    }
    const key = String(id);
    if (this.serverRequestIds.has(key)) {
      this.incompatible(`Codex replayed server request id ${key}`);
      return;
    }
    if (this.serverRequestIds.size >= this.maxPendingRequests) {
      this.incompatible("Codex server request queue is full");
      return;
    }
    this.serverRequestIds.add(key);
    void this.dispatchServerRequest(id, allowed, params);
  }

  private async dispatchServerRequest(
    id: string | number,
    method: AllowedCodexServerRequestMethod,
    params: unknown,
  ): Promise<void> {
    await this.record({ type: "server.request", id, method });
    try {
      const result = await this.serverRequestDispatcher!(method, params);
      if (this.state === "ready" && this.process)
        this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
      await this.record({ type: "server.response", id, method, ok: true });
    } catch {
      if (this.state === "ready" && this.process) {
        this.process.stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32001, message: "capability request denied" },
          })}\n`,
        );
      }
      await this.record({ type: "server.response", id, method, ok: false });
    }
  }

  private incompatible(message: string): void {
    this.state = "incompatible";
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      this.pending.delete(id);
    }
    void this.record({ type: "compatibility.failed", message });
  }

  private crash(error: Error): void {
    if (this.state === "stopped") return;
    this.state = "crashed";
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Codex substrate crashed: ${error.message}`));
      this.pending.delete(id);
    }
    void this.record({ type: "process.crashed", message: error.message });
  }

  private async record(fields: Record<string, unknown>): Promise<void> {
    const entry = {
      protocol: this.options.preflight.protocol,
      at: this.now(),
      sequence: ++this.eventSequence,
      ...fields,
    };
    await this.journal.append(entry);
  }
}

function positiveBound(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}

function isRpcId(value: unknown): value is string | number {
  return (
    (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

const SENSITIVE_ENVIRONMENT_NAME =
  /(?:API[_-]?KEY|TOKEN|PASSWORD|PASSFILE|SECRET|PRIVATE[_-]?KEY|CREDENTIAL|LICENSE|DATABASE_URL|SSH_AUTH_SOCK)/iu;

function sanitizeAgentEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || SENSITIVE_ENVIRONMENT_NAME.test(key)) continue;
    result[key] = value;
  }
  return result;
}
