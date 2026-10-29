import { mkdir, readFile } from "node:fs/promises";
import { appendFileSync, chmodSync, closeSync, constants, fsyncSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { canonicalPublicJson, publicDigest, type PublicDigest } from "./public-protocol";

/** Durable liveness envelope emitted by Head/worker services. */
export const NodeHeartbeatSchema = z
  .object({
    schema: z.literal("eigengrid.node-heartbeat.v1"),
    nodeId: z.string().min(1).max(256),
    instanceId: z.string().min(1).max(256),
    fence: z.string().min(1).max(256),
    sequence: z.number().int().nonnegative(),
    status: z.enum(["healthy", "stale", "unreachable", "draining", "incompatible", "degraded"]),
    capabilityDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    sentAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    heartbeatDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  })
  .strict();

export type NodeHeartbeat = z.infer<typeof NodeHeartbeatSchema>;

export function computeNodeHeartbeatDigest(
  heartbeat: Omit<NodeHeartbeat, "heartbeatDigest"> | NodeHeartbeat,
): PublicDigest {
  const { heartbeatDigest: _digest, ...material } = heartbeat as NodeHeartbeat;
  return publicDigest(material);
}

export function createNodeHeartbeat(
  input: Omit<NodeHeartbeat, "schema" | "heartbeatDigest">,
): NodeHeartbeat {
  const material = { ...input, schema: "eigengrid.node-heartbeat.v1" } as Omit<
    NodeHeartbeat,
    "heartbeatDigest"
  >;
  return NodeHeartbeatSchema.parse({
    ...material,
    heartbeatDigest: computeNodeHeartbeatDigest(material),
  });
}

export function verifyNodeHeartbeat(
  raw: unknown,
): { ok: true; heartbeat: NodeHeartbeat } | { ok: false; errors: string[] } {
  const parsed = NodeHeartbeatSchema.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  const expected = computeNodeHeartbeatDigest(parsed.data);
  if (expected !== parsed.data.heartbeatDigest) {
    return {
      ok: false,
      errors: [`heartbeatDigest: expected ${expected}, got ${parsed.data.heartbeatDigest}`],
    };
  }
  if (Date.parse(parsed.data.expiresAt) <= Date.parse(parsed.data.sentAt)) {
    return { ok: false, errors: ["expiresAt must be later than sentAt"] };
  }
  return { ok: true, heartbeat: parsed.data };
}

export type HeartbeatFenceResult =
  | {
      accepted: true;
      heartbeat: NodeHeartbeat;
      reason: "new-instance" | "next-sequence" | "duplicate";
    }
  | {
      accepted: false;
      reason: "stale-fence" | "stale-sequence" | "digest-conflict";
      message: string;
    };

type FenceState = { instanceId: string; fence: string; sequence: number; digest: string };

/**
 * In-memory fence validator. The caller persists accepted envelopes through
 * the journal below; a stale worker can never regain authority by replaying an
 * older instance/sequence after a restart.
 */
export class HeartbeatFence {
  private readonly state = new Map<string, FenceState>();

  constructor(initial: readonly NodeHeartbeat[] = []) {
    for (const heartbeat of initial) this.accept(heartbeat);
  }

  accept(raw: unknown): HeartbeatFenceResult {
    const verified = verifyNodeHeartbeat(raw);
    if (!verified.ok)
      return { accepted: false, reason: "digest-conflict", message: verified.errors.join("; ") };
    const heartbeat = verified.heartbeat;
    const current = this.state.get(heartbeat.nodeId);
    if (!current) {
      this.state.set(heartbeat.nodeId, {
        instanceId: heartbeat.instanceId,
        fence: heartbeat.fence,
        sequence: heartbeat.sequence,
        digest: heartbeat.heartbeatDigest,
      });
      return { accepted: true, heartbeat, reason: "new-instance" };
    }
    if (heartbeat.instanceId !== current.instanceId || heartbeat.fence !== current.fence) {
      // Fence tokens are opaque monotonic grants. A new instance must carry a
      // lexically greater token so an old worker cannot reclaim ownership.
      if (heartbeat.fence <= current.fence) {
        return { accepted: false, reason: "stale-fence", message: "heartbeat fence is stale" };
      }
      this.state.set(heartbeat.nodeId, {
        instanceId: heartbeat.instanceId,
        fence: heartbeat.fence,
        sequence: heartbeat.sequence,
        digest: heartbeat.heartbeatDigest,
      });
      return { accepted: true, heartbeat, reason: "new-instance" };
    }
    if (heartbeat.sequence < current.sequence)
      return { accepted: false, reason: "stale-sequence", message: "heartbeat sequence is stale" };
    if (heartbeat.sequence === current.sequence) {
      if (heartbeat.heartbeatDigest !== current.digest)
        return {
          accepted: false,
          reason: "digest-conflict",
          message: "duplicate sequence has a different digest",
        };
      return { accepted: true, heartbeat, reason: "duplicate" };
    }
    this.state.set(heartbeat.nodeId, {
      instanceId: heartbeat.instanceId,
      fence: heartbeat.fence,
      sequence: heartbeat.sequence,
      digest: heartbeat.heartbeatDigest,
    });
    return { accepted: true, heartbeat, reason: "next-sequence" };
  }

  snapshot(): readonly FenceState[] {
    return [...this.state.values()].map((state) => ({ ...state }));
  }
}

/** Append-only durable journal used to rebuild fences after process restart. */
export class DurableNodeHeartbeatJournal {
  private loaded = false;
  private loading: Promise<void> | undefined;
  private loadFailure: Error | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly records: NodeHeartbeat[] = [];

  constructor(private readonly filePath: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadFailure) throw this.loadFailure;
    if (this.loading) return this.loading;
    this.loading = this.loadFromDisk();
    try {
      await this.loading;
    } finally {
      this.loading = undefined;
    }
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const source = await readFile(this.filePath, "utf8");
      if (source.length > 0 && !source.endsWith("\n"))
        throw new Error("invalid heartbeat journal: unterminated final record");
      const loaded: NodeHeartbeat[] = [];
      for (const line of source.split("\n")) {
        if (!line.trim()) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch (error) {
          throw new Error(`invalid heartbeat JSON: ${String(error)}`);
        }
        const verified = verifyNodeHeartbeat(value);
        if (!verified.ok)
          throw new Error(`invalid heartbeat in journal: ${verified.errors.join("; ")}`);
        const prior = [...loaded]
          .reverse()
          .find((entry) => entry.nodeId === verified.heartbeat.nodeId);
        if (prior) {
          const decision = new HeartbeatFence([prior]).accept(verified.heartbeat);
          if (!decision.accepted || decision.reason === "duplicate")
            throw new Error(`invalid heartbeat journal sequence for ${verified.heartbeat.nodeId}`);
        }
        loaded.push(verified.heartbeat);
      }
      this.records.splice(0, this.records.length, ...loaded);
      this.loaded = true;
    } catch (error) {
      this.records.splice(0, this.records.length);
      const failure = error instanceof Error ? error : new Error(String(error));
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.loadFailure = failure;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.loaded = true;
        return;
      }
      throw failure;
    }
  }

  async append(raw: unknown): Promise<NodeHeartbeat> {
    return this.enqueue(async () => {
      await this.load();
      const verified = verifyNodeHeartbeat(raw);
      if (!verified.ok) throw new Error(verified.errors.join("; "));
      const heartbeat = verified.heartbeat;
      const last = [...this.records].reverse().find((entry) => entry.nodeId === heartbeat.nodeId);
      if (last) {
        const fence = new HeartbeatFence([last]);
        const decision = fence.accept(heartbeat);
        if (!decision.accepted) throw new Error(decision.message);
        if (decision.reason === "duplicate") return last;
      }
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const descriptor = openSync(this.filePath, "a", 0o600);
      try {
        appendFileSync(descriptor, `${canonicalPublicJson(heartbeat)}\n`, "utf8");
        fsyncSync(descriptor);
        chmodSync(this.filePath, 0o600);
      } finally {
        closeSync(descriptor);
      }
      syncDirectory(dirname(this.filePath));
      this.records.push(heartbeat);
      return heartbeat;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(operation, operation);
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async list(): Promise<readonly NodeHeartbeat[]> {
    await this.load();
    return [...this.records];
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function classifyHeartbeat(
  heartbeat: NodeHeartbeat,
  now = new Date(),
): NodeHeartbeat["status"] {
  if (Date.parse(heartbeat.expiresAt) <= now.getTime()) return "stale";
  return heartbeat.status;
}
