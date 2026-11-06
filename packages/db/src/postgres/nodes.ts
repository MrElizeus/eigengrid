import type { NodeRecord, NodeUpdateInput } from "../client";
import { DbAmbiguousPrefixError, DbNotFoundError } from "../errors";
import { mapNodeRow } from "../rows";
import type { PostgresContext } from "./context";
import { type PgRow } from "./row-helpers";

export async function createNode(
  context: PostgresContext,
  node: {
    id: string;
    name: string;
    host: string;
    user: string;
    runner: string;
    port?: number;
    maxJobs?: number;
    tags?: string[];
    privateKeyPath?: string;
    remoteScratchDir?: string;
  },
): Promise<void> {
  const now = context.nextTimestamp();
  await context.query(
    `INSERT INTO nodes (id, name, host, "user", port, runner, status, tags_json, max_jobs, private_key_path, remote_scratch_dir, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      node.id,
      node.name,
      node.host,
      node.user,
      node.port ?? 22,
      node.runner,
      "unknown",
      JSON.stringify(node.tags ?? []),
      node.maxJobs ?? 1,
      node.privateKeyPath ?? null,
      node.remoteScratchDir ?? "/scratch/eigengrid",
      now,
      now,
    ],
  );
}

export async function getNode(
  context: PostgresContext,
  nodeId: string,
): Promise<NodeRecord | null> {
  const row = await context.queryOne("SELECT * FROM nodes WHERE id = $1", [nodeId]);
  return row ? mapNodeRow(row as Record<string, unknown>) : null;
}

export async function listNodes(context: PostgresContext): Promise<NodeRecord[]> {
  const { rows } = await context.query("SELECT * FROM nodes ORDER BY created_at ASC");
  return rows.map((r: PgRow) => mapNodeRow(r as Record<string, unknown>));
}

export async function updateNode(
  context: PostgresContext,
  nodeId: string,
  updates: NodeUpdateInput,
): Promise<void> {
  const values: unknown[] = [];
  const fields: string[] = [];
  const add = (column: string, value: unknown): void => {
    values.push(value);
    fields.push(`${column} = $${values.length}`);
  };

  if (updates.name !== undefined) add("name", updates.name);
  if (updates.host !== undefined) add("host", updates.host);
  if (updates.user !== undefined) add('"user"', updates.user);
  if (updates.port !== undefined) add("port", updates.port);
  if (updates.runner !== undefined) add("runner", updates.runner);
  if (updates.status !== undefined) add("status", updates.status);
  if (updates.tags !== undefined) add("tags_json", JSON.stringify(updates.tags));
  if (updates.maxJobs !== undefined) add("max_jobs", updates.maxJobs);
  if (updates.engines !== undefined) add("engines", JSON.stringify(updates.engines));
  if (updates.cpuThreadsTotal !== undefined) add("cpu_threads_total", updates.cpuThreadsTotal);
  if (updates.memoryMbTotal !== undefined) add("memory_mb_total", updates.memoryMbTotal);
  if (updates.scratchMbTotal !== undefined) add("scratch_mb_total", updates.scratchMbTotal);
  if (updates.draining !== undefined) add("draining", updates.draining);
  if (updates.thermalState !== undefined) add("thermal_state", updates.thermalState);
  if (updates.lastSeenAt !== undefined) add("last_seen_at", updates.lastSeenAt);
  if (updates.isHead !== undefined) add("is_head", updates.isHead);
  if (updates.powerMode !== undefined) add("power_mode", updates.powerMode);
  if (updates.macAddress !== undefined) add("mac_address", updates.macAddress);
  if (updates.broadcastAddress !== undefined) add("broadcast_address", updates.broadcastAddress);
  if (updates.wolPort !== undefined) add("wol_port", updates.wolPort);
  if (updates.allowWake !== undefined) add("allow_wake", updates.allowWake);
  if (updates.allowPowerDown !== undefined) add("allow_power_down", updates.allowPowerDown);
  if (updates.idlePowerDownAfterSec !== undefined)
    add("idle_power_down_after_sec", updates.idlePowerDownAfterSec);
  if (updates.lastWakeAt !== undefined) add("last_wake_at", updates.lastWakeAt);
  if (updates.lastPowerDownAt !== undefined) add("last_power_down_at", updates.lastPowerDownAt);
  if (updates.privateKeyPath !== undefined) add("private_key_path", updates.privateKeyPath);
  if (updates.remoteScratchDir !== undefined) add("remote_scratch_dir", updates.remoteScratchDir);

  values.push(context.nextTimestamp(), nodeId);
  fields.push(`updated_at = $${values.length - 1}`);
  await context.query(`UPDATE nodes SET ${fields.join(", ")} WHERE id = $${values.length}`, values);
}

export async function removeNode(context: PostgresContext, nodeId: string): Promise<void> {
  await context.query("DELETE FROM nodes WHERE id = $1", [nodeId]);
}

export async function resolveNodeId(context: PostgresContext, prefix: string): Promise<string> {
  const { rows } = await context.query("SELECT id FROM nodes WHERE id LIKE $1", [`${prefix}%`]);
  if (rows.length === 0) {
    const nameRows = await context.query("SELECT id FROM nodes WHERE name = $1", [prefix]);
    if (nameRows.rows.length === 0) {
      throw new DbNotFoundError("Node", prefix);
    }
    if (nameRows.rows.length > 1) {
      throw new DbAmbiguousPrefixError("node", prefix, nameRows.rows.length);
    }
    return String(nameRows.rows[0].id);
  }
  if (rows.length > 1) {
    throw new DbAmbiguousPrefixError("node", prefix, rows.length);
  }
  return String(rows[0].id);
}

export async function getNodeByName(
  context: PostgresContext,
  name: string,
): Promise<NodeRecord | null> {
  const row = await context.queryOne("SELECT * FROM nodes WHERE name = $1", [name]);
  return row ? mapNodeRow(row as Record<string, unknown>) : null;
}
