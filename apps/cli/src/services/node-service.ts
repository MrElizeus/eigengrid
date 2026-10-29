import { generateId, type RunnerKind } from "@eigengrid/core";
import type { DatabaseLike } from "@eigengrid/db";
import {
  HeartbeatFence,
  createNodeHeartbeat,
  type DurableNodeHeartbeatJournal,
  type NodeHeartbeat,
} from "@eigengrid/protocol";

export interface NodeUpsertInput {
  /** Unique node name (used as the lookup key). */
  name: string;
  /** Hostname or IP address. */
  host: string;
  /** SSH username for remote connections. */
  user: string;
  /** Runner kind: "local" | "ssh" | "slurm" | "pbs". */
  runner?: RunnerKind;
  /** Maximum concurrent jobs (optional). */
  maxJobs?: number;
  /** Labels for filtering/scheduling. */
  tags?: string[];
  /** SSH port (defaults to 22 at the DB level). */
  port?: number;
  /** Path to SSH private key. */
  privateKeyPath?: string;
  /** Remote scratch directory for job files. */
  remoteScratchDir?: string;
}

/**
 * Upsert a compute node by name.
 *
 * Checks the database for an existing node with the same `name`.
 * If none exists: creates one with the supplied fields and returns
 * `{ created: true }`.
 * If one already exists: leaves it untouched and returns
 * `{ created: false, updated: false }`.
 *
 * This is deliberately **create-only** — it never updates an existing
 * node's fields to avoid silently overwriting user configuration.
 */
export async function upsertNodeByName(
  db: DatabaseLike,
  input: NodeUpsertInput,
): Promise<{ created: boolean; updated: boolean }> {
  const existing = await db.getNodeByName(input.name);

  if (existing) {
    return { created: false, updated: false };
  }

  await db.createNode({
    id: generateId("node"),
    name: input.name,
    host: input.host,
    user: input.user,
    runner: input.runner ?? "local",
    port: input.port,
    maxJobs: input.maxJobs,
    tags: input.tags,
    privateKeyPath: input.privateKeyPath,
    remoteScratchDir: input.remoteScratchDir,
  });

  return { created: true, updated: false };
}

export interface RecordNodeHeartbeatInput {
  nodeId: string;
  instanceId: string;
  fence: string;
  sequence: number;
  status: NodeHeartbeat["status"];
  capabilityDigest: `sha256:${string}`;
  sentAt?: Date;
  expiresAt: Date;
}

export type RecordNodeHeartbeatResult =
  | { accepted: true; heartbeat: NodeHeartbeat; nodeStatus: string }
  | { accepted: false; reason: string; message: string };

/**
 * Verify and persist a measured worker heartbeat. The DB projection is only a
 * convenience for scheduling; the signed/digested envelope and fence journal
 * remain the authoritative liveness evidence used during recovery.
 */
export async function recordNodeHeartbeat(
  db: DatabaseLike,
  input: RecordNodeHeartbeatInput,
  journal?: DurableNodeHeartbeatJournal,
): Promise<RecordNodeHeartbeatResult> {
  const node = await db.getNode(input.nodeId);
  if (!node)
    return { accepted: false, reason: "unknown-node", message: `Node not found: ${input.nodeId}` };
  const heartbeat = createNodeHeartbeat({
    nodeId: input.nodeId,
    instanceId: input.instanceId,
    fence: input.fence,
    sequence: input.sequence,
    status: input.status,
    capabilityDigest: input.capabilityDigest,
    sentAt: (input.sentAt ?? new Date()).toISOString(),
    expiresAt: input.expiresAt.toISOString(),
  });
  const prior = journal ? await journal.list() : [];
  const fence = new HeartbeatFence(prior.filter((entry) => entry.nodeId === input.nodeId));
  const decision = fence.accept(heartbeat);
  if (!decision.accepted) return decision;
  if (journal && decision.reason !== "duplicate") await journal.append(heartbeat);
  const nodeStatus =
    heartbeat.status === "healthy"
      ? "online"
      : heartbeat.status === "draining"
        ? "draining"
        : heartbeat.status === "stale" || heartbeat.status === "unreachable"
          ? "offline"
          : "error";
  await db.updateNode?.(input.nodeId, {
    status: nodeStatus,
    lastSeenAt: Date.parse(heartbeat.sentAt),
  });
  return { accepted: true, heartbeat, nodeStatus };
}
