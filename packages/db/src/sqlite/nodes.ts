import type { NodeRecord, NodeUpdateInput } from "../client";
import { DbAmbiguousPrefixError, DbNotFoundError } from "../errors";
import { mapNodeRow } from "../rows";
import type { SqliteContext } from "./context";

export async function createNode(
  context: SqliteContext,
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
  const db = context.ensureDb();
  const now = context.nextTimestamp();
  db.query(
    "INSERT INTO nodes (id, name, host, user, port, runner, status, tags_json, max_jobs, private_key_path, remote_scratch_dir, created_at, updated_at) VALUES ($id, $name, $host, $user, $port, $runner, $status, $tagsJson, $maxJobs, $privateKeyPath, $remoteScratchDir, $createdAt, $updatedAt)",
  ).run({
    $id: node.id,
    $name: node.name,
    $host: node.host,
    $user: node.user,
    $port: node.port ?? 22,
    $runner: node.runner,
    $status: "unknown",
    $tagsJson: JSON.stringify(node.tags ?? []),
    $maxJobs: node.maxJobs ?? 1,
    $privateKeyPath: node.privateKeyPath ?? null,
    $remoteScratchDir: node.remoteScratchDir ?? "/scratch/eigengrid",
    $createdAt: now,
    $updatedAt: now,
  });
}

export async function getNode(context: SqliteContext, nodeId: string): Promise<NodeRecord | null> {
  const row = context.ensureDb().query("SELECT * FROM nodes WHERE id = $id").get({ $id: nodeId });
  if (!row) return null;
  return mapNodeRow(row as Record<string, unknown>);
}

export async function listNodes(context: SqliteContext): Promise<NodeRecord[]> {
  const rows = context.ensureDb().query("SELECT * FROM nodes ORDER BY created_at ASC").all();
  return rows.map((r: Record<string, unknown>) => mapNodeRow(r));
}

export async function updateNode(
  context: SqliteContext,
  nodeId: string,
  updates: NodeUpdateInput,
): Promise<void> {
  const values: Record<string, unknown> = { $id: nodeId, $updatedAt: context.nextTimestamp() };
  const fields: string[] = ["updated_at = $updatedAt"];

  const add = (column: string, parameter: string, value: unknown): void => {
    fields.push(`${column} = ${parameter}`);
    values[parameter] = value;
  };

  if (updates.name !== undefined) add("name", "$name", updates.name);
  if (updates.host !== undefined) add("host", "$host", updates.host);
  if (updates.user !== undefined) add("user", "$user", updates.user);
  if (updates.port !== undefined) add("port", "$port", updates.port);
  if (updates.runner !== undefined) add("runner", "$runner", updates.runner);
  if (updates.status !== undefined) add("status", "$status", updates.status);
  if (updates.tags !== undefined) add("tags_json", "$tagsJson", JSON.stringify(updates.tags));
  if (updates.maxJobs !== undefined) add("max_jobs", "$maxJobs", updates.maxJobs);
  if (updates.engines !== undefined) add("engines", "$engines", JSON.stringify(updates.engines));
  if (updates.cpuThreadsTotal !== undefined)
    add("cpu_threads_total", "$cpuThreadsTotal", updates.cpuThreadsTotal);
  if (updates.memoryMbTotal !== undefined)
    add("memory_mb_total", "$memoryMbTotal", updates.memoryMbTotal);
  if (updates.scratchMbTotal !== undefined)
    add("scratch_mb_total", "$scratchMbTotal", updates.scratchMbTotal);
  if (updates.draining !== undefined) add("draining", "$draining", updates.draining ? 1 : 0);
  if (updates.thermalState !== undefined)
    add("thermal_state", "$thermalState", updates.thermalState);
  if (updates.lastSeenAt !== undefined) add("last_seen_at", "$lastSeenAt", updates.lastSeenAt);
  if (updates.isHead !== undefined) add("is_head", "$isHead", updates.isHead ? 1 : 0);
  if (updates.powerMode !== undefined) add("power_mode", "$powerMode", updates.powerMode);
  if (updates.macAddress !== undefined) add("mac_address", "$macAddress", updates.macAddress);
  if (updates.broadcastAddress !== undefined)
    add("broadcast_address", "$broadcastAddress", updates.broadcastAddress);
  if (updates.wolPort !== undefined) add("wol_port", "$wolPort", updates.wolPort);
  if (updates.allowWake !== undefined) add("allow_wake", "$allowWake", updates.allowWake ? 1 : 0);
  if (updates.allowPowerDown !== undefined)
    add("allow_power_down", "$allowPowerDown", updates.allowPowerDown ? 1 : 0);
  if (updates.idlePowerDownAfterSec !== undefined)
    add("idle_power_down_after_sec", "$idlePowerDownAfterSec", updates.idlePowerDownAfterSec);
  if (updates.lastWakeAt !== undefined) add("last_wake_at", "$lastWakeAt", updates.lastWakeAt);
  if (updates.lastPowerDownAt !== undefined)
    add("last_power_down_at", "$lastPowerDownAt", updates.lastPowerDownAt);
  if (updates.privateKeyPath !== undefined)
    add("private_key_path", "$privateKeyPath", updates.privateKeyPath);
  if (updates.remoteScratchDir !== undefined)
    add("remote_scratch_dir", "$remoteScratchDir", updates.remoteScratchDir);

  context
    .ensureDb()
    .query(`UPDATE nodes SET ${fields.join(", ")} WHERE id = $id`)
    .run(values);
}

export async function removeNode(context: SqliteContext, nodeId: string): Promise<void> {
  context.ensureDb().query("DELETE FROM nodes WHERE id = $id").run({ $id: nodeId });
}

export async function resolveNodeId(context: SqliteContext, prefix: string): Promise<string> {
  const db = context.ensureDb();
  const rows = db
    .query("SELECT id FROM nodes WHERE id LIKE $prefix")
    .all({ $prefix: `${prefix}%` });
  if (rows.length === 0) {
    const nameRows = db.query("SELECT id FROM nodes WHERE name = $name").all({ $name: prefix });
    if (nameRows.length === 0) throw new DbNotFoundError("Node", prefix);
    if (nameRows.length > 1) throw new DbAmbiguousPrefixError("node", prefix, nameRows.length);
    return String(nameRows[0].id);
  }
  if (rows.length > 1) throw new DbAmbiguousPrefixError("node", prefix, rows.length);
  return String(rows[0].id);
}

export async function getNodeByName(
  context: SqliteContext,
  name: string,
): Promise<NodeRecord | null> {
  const row = context
    .ensureDb()
    .query("SELECT * FROM nodes WHERE name = $name")
    .get({ $name: name });
  if (!row) return null;
  return mapNodeRow(row as Record<string, unknown>);
}
