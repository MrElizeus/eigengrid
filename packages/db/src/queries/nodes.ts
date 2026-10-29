import type { DatabaseLike } from "../client";

export async function createNode(
  db: DatabaseLike,
  params: {
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
  await db.createNode(params);
}

export async function getNode(db: DatabaseLike, nodeId: string) {
  return await db.getNode(nodeId);
}

export async function listNodes(db: DatabaseLike) {
  return await db.listNodes();
}

export async function removeNode(db: DatabaseLike, nodeId: string) {
  await db.removeNode(nodeId);
}

/**
 * Resolve a node ID prefix (or name) to a full node ID.
 * First tries prefix match on ID, then exact match on name.
 */
export async function resolveNodeId(db: DatabaseLike, prefix: string): Promise<string> {
  return await db.resolveNodeId(prefix);
}

/**
 * Look up a node by its name.
 */
export async function getNodeByName(db: DatabaseLike, name: string) {
  return await db.getNodeByName(name);
}
