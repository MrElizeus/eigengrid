/**
 * application: host-owned, replayable agent sessions. Model output is never identity,
 * authorization, a filesystem path, an approval receipt or an effect owner.
 *
 * JsonlAgentJournal supplies per-session fsync/CAS and a cross-process exclusive
 * writer. Keep the journal on a HEAD-owned shared volume if two Heads are used.
 * A lock left by SIGKILL is deliberately NOT stolen by this service.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  NativeAgentEngine,
  JsonlAgentJournal,
  AgentConcurrencyError,
  agentDigest,
  type AgentInferencePort,
  type AgentToolAuthority,
  type AgentToolCall,
  type AgentLimits,
  type AgentSession,
  type AgentObservation,
} from "@eigengrid/agent-runtime";

export type AgentSessionErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "APPROVAL_EXPIRED"
  | "POLICY_CHANGED"
  | "UNCERTAIN_EFFECT";

export class AgentSessionError extends Error {
  constructor(readonly code: AgentSessionErrorCode) {
    super(code);
    this.name = "AgentSessionError";
  }
}

const safeId = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,159}$/u;
const safeSession = /^[a-f0-9-]{36}$/u;
const digest = /^[a-f0-9]{64}$/u;
const maximumMetadataBytes = 8192;
const version = "eigengrid.agent.scope/v1";

export interface AgentPrincipal {
  readonly actorId: string;
  readonly projectId: string;
  readonly missionId: string;
  readonly policyDigest: string;
}
/** Must derive actor and policy from host authentication, then check CURRENT
 * mission/project access with the mission runtime/MissionApplication authority. */
export interface AgentSessionIdentity {
  current(address: { projectId: string; missionId: string }): Promise<AgentPrincipal>;
  assertCurrent(principal: AgentPrincipal): Promise<void>;
}
interface Scope extends AgentPrincipal {
  readonly schemaVersion: typeof version;
  readonly sessionId: string;
}
interface Receipt {
  readonly schemaVersion: "eigengrid.agent.approval/v1";
  readonly sessionId: string;
  readonly actorId: string;
  readonly projectId: string;
  readonly missionId: string;
  readonly policyDigest: string;
  readonly callId: string;
  readonly tool: string;
  readonly inputDigest: string;
  readonly expiresAtMs: number;
}

function identifier(value: string): void {
  if (typeof value !== "string" || !safeId.test(value))
    throw new AgentSessionError("INVALID_REQUEST");
}
function validScope(p: AgentPrincipal): void {
  identifier(p.actorId);
  identifier(p.projectId);
  identifier(p.missionId);
  if (!digest.test(p.policyDigest)) throw new AgentSessionError("INVALID_REQUEST");
}
function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("Head-owned agent session storage is not private");
}
function writeExclusive(path: string, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value) + "\n", "utf8");
  if (bytes.length > maximumMetadataBytes) throw new AgentSessionError("INVALID_REQUEST");
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const dirFd = openSync(dirname(path), constants.O_RDONLY);
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}
function readPrivate(path: string): unknown {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid()) ||
    stat.size === 0 ||
    stat.size > maximumMetadataBytes
  )
    throw new AgentSessionError("CONFLICT");
  const bytes = readFileSync(path);
  if (bytes.length !== stat.size) throw new AgentSessionError("CONFLICT");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new AgentSessionError("CONFLICT");
  }
}
function expectedSession(id: string): void {
  if (!safeSession.test(id)) throw new AgentSessionError("INVALID_REQUEST");
}
function validatedScope(raw: unknown, id: string): Scope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new AgentSessionError("CONFLICT");
  const value = raw as Record<string, unknown>;
  const names = Object.keys(value).sort().join(",");
  if (
    names !== "actorId,missionId,policyDigest,projectId,schemaVersion,sessionId" ||
    value.schemaVersion !== version ||
    value.sessionId !== id
  )
    throw new AgentSessionError("CONFLICT");
  const p: AgentPrincipal = {
    actorId: value.actorId as string,
    projectId: value.projectId as string,
    missionId: value.missionId as string,
    policyDigest: value.policyDigest as string,
  };
  try {
    validScope(p);
  } catch {
    throw new AgentSessionError("CONFLICT");
  }
  return { schemaVersion: version, sessionId: id, ...p };
}
export interface AgentEventPage {
  readonly events: ReturnType<JsonlAgentJournal["load"]>;
  readonly cursor: number;
  readonly hasMore: boolean;
}
export interface AgentApprovalRequest {
  readonly callId: string;
  readonly inputDigest: string;
  readonly cursor: { readonly sequence: number; readonly digest: string };
  readonly ttlSeconds: number;
}
export interface AgentReconciliation {
  readonly status: "RESOLVED" | "BLOCKED" | "UNKNOWN";
  /** An mission runtime receipt can be reported, but cannot be turned into a new effect. */
  readonly receiptId?: string;
  readonly observation?: AgentObservation;
}
export interface AgentSessionEffects {
  readonly tools: AgentToolAuthority;
  readonly observeUncertain: (
    principal: AgentPrincipal,
    sessionId: string,
    call: AgentToolCall,
  ) => Promise<AgentReconciliation>;
}

export class AgentSessionService {
  readonly journal: JsonlAgentJournal;
  readonly engine: NativeAgentEngine;
  private readonly scopes: string;
  private readonly receipts: string;
  private readonly stopped: string;
  private readonly opens: string;

  constructor(
    readonly root: string,
    readonly identity: AgentSessionIdentity,
    readonly inference: AgentInferencePort,
    readonly effects: AgentSessionEffects,
    readonly now: () => number = () => Date.now(),
  ) {
    privateDirectory(root);
    this.scopes = join(root, "scopes");
    this.receipts = join(root, "approvals");
    this.stopped = join(root, "stopped");
    this.opens = join(root, "opens");
    for (const path of [this.scopes, this.receipts, this.stopped, this.opens])
      privateDirectory(path);
    this.journal = new JsonlAgentJournal(join(root, "journal"));
    this.engine = new NativeAgentEngine({
      journal: this.journal,
      inference,
      authority: {
        describe: () => this.effects.tools.describe(),
        decide: async (call, id) => {
          const p = await this.authorize(id);
          await this.identity.assertCurrent(p);
          return this.effects.tools.decide(call, id);
        },
        verifyApproval: async (call, id) => this.approvalIsCurrent(id, call),
        execute: async (call, id) => {
          const p = await this.authorize(id);
          await this.identity.assertCurrent(p);
          if (
            (await this.effects.tools.decide(call, id)) !== "ask" &&
            (await this.effects.tools.decide(call, id)) !== "allow"
          )
            throw new AgentSessionError("FORBIDDEN");
          return this.effects.tools.execute(call, id);
        },
      },
      beforeEffect: async (call, id) => {
        const p = await this.authorize(id);
        await this.identity.assertCurrent(p);
        if (this.isStopped(id)) throw new AgentSessionError("FORBIDDEN");
        if (
          (await this.effects.tools.decide(call, id)) === "ask" &&
          !(await this.approvalIsCurrent(id, call))
        )
          throw new AgentSessionError("APPROVAL_EXPIRED");
      },
    });
  }

  private scopePath(id: string): string {
    expectedSession(id);
    return join(this.scopes, id + ".json");
  }
  private stopPath(id: string): string {
    expectedSession(id);
    return join(this.stopped, id + ".stop");
  }
  private approvalPath(id: string, callId: string): string {
    expectedSession(id);
    if (typeof callId !== "string" || !callId || callId.length > 128)
      throw new AgentSessionError("INVALID_REQUEST");
    return join(this.receipts, id + "-" + agentDigest(callId) + ".json");
  }
  private isStopped(id: string): boolean {
    return existsSync(this.stopPath(id));
  }
  private async authorize(id: string): Promise<Scope> {
    const path = this.scopePath(id);
    if (!existsSync(path)) throw new AgentSessionError("NOT_FOUND");
    const scope = validatedScope(readPrivate(path), id);
    const p = await this.identity.current({
      projectId: scope.projectId,
      missionId: scope.missionId,
    });
    validScope(p);
    if (p.actorId !== scope.actorId) throw new AgentSessionError("NOT_FOUND");
    if (p.projectId !== scope.projectId || p.missionId !== scope.missionId)
      throw new AgentSessionError("FORBIDDEN");
    if (p.policyDigest !== scope.policyDigest) throw new AgentSessionError("POLICY_CHANGED");
    await this.identity.assertCurrent(p);
    return scope;
  }

  async open(input: {
    projectId: string;
    missionId: string;
    prompt: string;
    limits?: AgentLimits;
    requestId?: string;
  }): Promise<AgentSession> {
    identifier(input.projectId);
    identifier(input.missionId);
    if (
      typeof input.prompt !== "string" ||
      input.prompt.trim().length === 0 ||
      input.prompt.length > 100_000
    )
      throw new AgentSessionError("INVALID_REQUEST");
    const p = await this.identity.current({
      projectId: input.projectId,
      missionId: input.missionId,
    });
    validScope(p);
    if (p.projectId !== input.projectId || p.missionId !== input.missionId)
      throw new AgentSessionError("FORBIDDEN");
    await this.identity.assertCurrent(p);
    const key = input.requestId ?? randomUUID();
    identifier(key);
    const hash = agentDigest({
      actorId: p.actorId,
      projectId: p.projectId,
      missionId: p.missionId,
      key,
    });
    const sessionId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const requestDigest = agentDigest({ prompt: input.prompt, limits: input.limits ?? null, ...p });
    const path = join(this.opens, sessionId + ".json");
    try {
      writeExclusive(path, { requestDigest });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if ((readPrivate(path) as { requestDigest?: string }).requestDigest !== requestDigest)
        throw new AgentSessionError("CONFLICT");
    }
    try {
      writeExclusive(this.scopePath(sessionId), { schemaVersion: version, sessionId, ...p });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    await this.authorize(sessionId);
    const state = this.engine.state(sessionId);
    if (state.cursor.sequence) return state;
    try {
      return this.engine.start({ sessionId, prompt: input.prompt, limits: input.limits });
    } catch (error) {
      if (error instanceof AgentConcurrencyError && this.engine.state(sessionId).cursor.sequence)
        return this.engine.state(sessionId);
      throw error;
    }
  }

  /** Revalidated, host-only context for canonically bound tool adapters. */
  async principal(id: string): Promise<AgentPrincipal> {
    return this.authorize(id);
  }

  async findOpened(input: {
    projectId: string;
    missionId: string;
    requestId: string;
    prompt: string;
  }): Promise<AgentSession | null> {
    const p = await this.identity.current({
      projectId: input.projectId,
      missionId: input.missionId,
    });
    await this.identity.assertCurrent(p);
    const hash = agentDigest({
      actorId: p.actorId,
      projectId: p.projectId,
      missionId: p.missionId,
      key: input.requestId,
    });
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    if (!existsSync(this.scopePath(id)) || !this.engine.state(id).cursor.sequence) return null;
    const scope = await this.authorize(id);
    const original = readPrivate(join(this.opens, id + ".json")) as { requestDigest: string };
    if (
      original.requestDigest !==
      agentDigest({
        prompt: input.prompt,
        limits: null,
        actorId: scope.actorId,
        projectId: scope.projectId,
        missionId: scope.missionId,
        policyDigest: scope.policyDigest,
      })
    )
      throw new AgentSessionError("CONFLICT");
    return this.observe(id);
  }

  async observeApproval(id: string, request: { callId: string; inputDigest: string }) {
    const p = await this.authorize(id);
    const path = this.approvalPath(id, request.callId);
    if (!existsSync(path)) return null;
    const r = readPrivate(path) as Receipt;
    if (
      r.schemaVersion !== "eigengrid.agent.approval/v1" ||
      r.sessionId !== id ||
      r.actorId !== p.actorId ||
      r.projectId !== p.projectId ||
      r.missionId !== p.missionId ||
      r.policyDigest !== p.policyDigest ||
      r.callId !== request.callId ||
      r.inputDigest !== request.inputDigest
    )
      return null;
    return { callId: r.callId, inputDigest: r.inputDigest, expiresAtMs: r.expiresAtMs };
  }

  async observe(id: string): Promise<AgentSession & { cancellationRequested: boolean }> {
    await this.authorize(id);
    const state = this.engine.state(id);
    if (state.cursor.sequence === 0) throw new AgentSessionError("CONFLICT");
    return { ...state, cancellationRequested: this.isStopped(id) };
  }

  async events(id: string, after = 0, maximum = 64): Promise<AgentEventPage> {
    await this.authorize(id);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      maximum > 256
    )
      throw new AgentSessionError("INVALID_REQUEST");
    const records = this.journal.load(id);
    if (after > records.length) throw new AgentSessionError("CONFLICT");
    const events = records.slice(after, after + maximum);
    return {
      events,
      cursor: after + events.length,
      hasMore: after + events.length < records.length,
    };
  }

  private async approvalIsCurrent(id: string, call: AgentToolCall): Promise<boolean> {
    const p = await this.authorize(id);
    if (this.isStopped(id)) return false;
    const path = this.approvalPath(id, call.id);
    if (!existsSync(path)) return false;
    const r = readPrivate(path) as Receipt;
    if (
      r.schemaVersion !== "eigengrid.agent.approval/v1" ||
      r.sessionId !== id ||
      r.actorId !== p.actorId ||
      r.projectId !== p.projectId ||
      r.missionId !== p.missionId ||
      r.policyDigest !== p.policyDigest ||
      r.callId !== call.id ||
      r.tool !== call.name ||
      r.inputDigest !== agentDigest(call.input) ||
      !Number.isSafeInteger(r.expiresAtMs) ||
      r.expiresAtMs <= this.now()
    )
      return false;
    return (await this.effects.tools.decide(call, id)) === "ask";
  }

  async approve(
    id: string,
    request: AgentApprovalRequest,
  ): Promise<{
    callId: string;
    inputDigest: string;
    expiresAtMs: number;
  }> {
    const p = await this.authorize(id);
    if (this.isStopped(id)) throw new AgentSessionError("FORBIDDEN");
    const state = this.engine.state(id);
    const call = state.call;
    if (
      state.phase !== "awaiting_approval" ||
      !call ||
      request.callId !== call.id ||
      request.inputDigest !== agentDigest(call.input) ||
      request.cursor.sequence !== state.cursor.sequence ||
      request.cursor.digest !== state.cursor.digest
    )
      throw new AgentSessionError("CONFLICT");
    if (
      !Number.isSafeInteger(request.ttlSeconds) ||
      request.ttlSeconds < 1 ||
      request.ttlSeconds > 900
    )
      throw new AgentSessionError("INVALID_REQUEST");
    if ((await this.effects.tools.decide(call, id)) !== "ask")
      throw new AgentSessionError("FORBIDDEN");
    await this.identity.assertCurrent(p);
    const expiresAtMs = this.now() + request.ttlSeconds * 1000;
    const receipt: Receipt = {
      schemaVersion: "eigengrid.agent.approval/v1",
      sessionId: id,
      actorId: p.actorId,
      projectId: p.projectId,
      missionId: p.missionId,
      policyDigest: p.policyDigest,
      callId: call.id,
      tool: call.name,
      inputDigest: request.inputDigest,
      expiresAtMs,
    };
    const path = this.approvalPath(id, call.id);
    let lock: number;
    try {
      lock = openSync(
        path + ".lock",
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      throw new AgentSessionError("CONFLICT");
    }
    try {
      await this.authorize(id);
      if (
        this.isStopped(id) ||
        agentDigest(this.engine.state(id).cursor) !== agentDigest(request.cursor)
      )
        throw new AgentSessionError("CONFLICT");
      if (existsSync(path)) {
        const old = readPrivate(path) as Receipt;
        if (old.expiresAtMs > this.now() && (await this.approvalIsCurrent(id, call)))
          return {
            callId: call.id,
            inputDigest: request.inputDigest,
            expiresAtMs: old.expiresAtMs,
          };
        const history = path + "." + agentDigest(old) + ".history";
        if (!existsSync(history)) writeExclusive(history, old);
      }
      const temporary = path + "." + randomUUID() + ".tmp";
      writeExclusive(temporary, receipt);
      renameSync(temporary, path);
      const dir = openSync(dirname(path), constants.O_RDONLY);
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } finally {
      closeSync(lock);
      unlinkSync(path + ".lock");
    }
    return { callId: call.id, inputDigest: request.inputDigest, expiresAtMs };
  }

  async resume(id: string, signal?: AbortSignal): Promise<AgentSession> {
    await this.authorize(id);
    if (this.isStopped(id)) throw new AgentSessionError("FORBIDDEN");
    return this.engine.run(id, signal);
  }

  async cancel(id: string): Promise<AgentSession & { cancellationRequested: boolean }> {
    await this.authorize(id);
    if (!this.isStopped(id)) {
      try {
        writeExclusive(this.stopPath(id), { cancelled: true });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
    }
    // Stop is a durable barrier, not a fabricated Slurm cancellation receipt.
    return this.observe(id);
  }

  async reconcile(id: string): Promise<AgentReconciliation> {
    const p = await this.authorize(id);
    const state = this.engine.state(id);
    if (state.phase !== "uncertain_effect" && state.phase !== "tool_pending")
      throw new AgentSessionError("CONFLICT");
    if (!state.call) return { status: "BLOCKED" };
    const result = await this.effects.observeUncertain(p, id, state.call);
    await this.authorize(id);
    if (result.status === "RESOLVED") {
      if (!result.receiptId || !result.observation) throw new AgentSessionError("CONFLICT");
      this.engine.reconcileEffect(id, result.observation);
    }
    return result;
  }
}
