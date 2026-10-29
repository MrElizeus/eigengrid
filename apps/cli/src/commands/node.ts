import type { CommandModule } from "yargs";
import { userInfo } from "os";
import { generateId } from "@eigengrid/core";
import { isValidMacAddress, sendWolPacket } from "@eigengrid/scheduler/wol";
import { WorkerSyncService } from "../services/worker-sync-service";
import { runWithContext } from "../composition";
import type { DatabaseLike, NodeUpdateInput, NodeRecord } from "@eigengrid/db";
import {
  clusterNodeRecords,
  discoverCluster,
  loadClusterProfile,
  printCluster,
} from "../services/cluster-inventory";

async function updateNode(
  db: DatabaseLike,
  nodeId: string,
  updates: NodeUpdateInput,
): Promise<void> {
  if (!db.updateNode) {
    throw new Error("The configured database provider does not support node updates");
  }
  await db.updateNode(nodeId, updates);
}

export const nodeCommand: CommandModule = {
  command: "node",
  describe: "Manage compute nodes",
  builder: (y) =>
    y
      .command("add", "Add a compute node", (y2) =>
        y2
          .command(
            "local",
            "Add a local node",
            {
              name: { type: "string", demandOption: true },
              "max-jobs": { type: "number", default: 1, describe: "Maximum concurrent jobs" },
              engines: {
                type: "string",
                default: "orca,gaussian,xtb,cp2k",
                describe: "Comma-separated engines",
              },
              cpu: { type: "number", default: 1, describe: "Total CPU threads" },
              memory: { type: "number", default: 1024, describe: "Total memory MB" },
              scratch: { type: "number", default: 10240, describe: "Total scratch MB" },
            } as const,
            async (args) => {
              const name = args.name as string;
              const maxJobs = args["max-jobs"] as number;
              const engines = (args.engines as string).split(",").map((e) => e.trim());
              const cpu = args.cpu as number;
              const memory = args.memory as number;
              const scratch = args.scratch as number;
              await runWithContext(async ({ db }) => {
                const id = generateId("node");
                await db.createNode({
                  id,
                  name,
                  host: "localhost",
                  user: userInfo().username,
                  runner: "local",
                  maxJobs,
                  tags: engines,
                });
                await updateNode(db, id, {
                  engines,
                  cpuThreadsTotal: cpu,
                  memoryMbTotal: memory,
                  scratchMbTotal: scratch,
                });
                console.log(`  Added local node: ${name} (${id})`);
                console.log(
                  `  Engines: ${engines.join(", ")}, CPU: ${cpu}, RAM: ${memory}MB, Scratch: ${scratch}MB`,
                );
              });
            },
          )
          .command(
            "ssh",
            "Add an SSH node",
            {
              name: { type: "string", demandOption: true },
              host: { type: "string", demandOption: true },
              user: { type: "string", demandOption: true },
              "ssh-port": { type: "number", default: 22, describe: "SSH port" },
              "ssh-key": { type: "string", describe: "SSH private key path" },
              "remote-dir": {
                type: "string",
                default: "/scratch/eigengrid",
                describe: "Remote scratch directory",
              },
              "max-jobs": { type: "number", default: 1, describe: "Maximum concurrent jobs" },
              engines: {
                type: "string",
                default: "orca,gaussian,xtb,cp2k",
                describe: "Comma-separated engines",
              },
              cpu: { type: "number", default: 1, describe: "Total CPU threads" },
              memory: { type: "number", default: 1024, describe: "Total memory MB" },
              scratch: { type: "number", default: 10240, describe: "Total scratch MB" },
            } as const,
            async (args) => {
              const name = args.name as string;
              const host = args.host as string;
              const user = args.user as string;
              const port = args["ssh-port"] as number;
              const keyFile = args["ssh-key"] as string | undefined;
              const remoteDir = args["remote-dir"] as string;
              const maxJobs = args["max-jobs"] as number;
              const engines = (args.engines as string).split(",").map((e) => e.trim());
              const cpu = args.cpu as number;
              const memory = args.memory as number;
              const scratch = args.scratch as number;
              await runWithContext(async ({ db }) => {
                const id = generateId("node");
                await db.createNode({
                  id,
                  name,
                  host,
                  user,
                  port,
                  runner: "ssh",
                  maxJobs,
                  privateKeyPath: keyFile,
                  remoteScratchDir: remoteDir,
                  tags: engines,
                });
                await updateNode(db, id, {
                  engines,
                  cpuThreadsTotal: cpu,
                  memoryMbTotal: memory,
                  scratchMbTotal: scratch,
                });
                console.log(`  Added SSH node: ${name} (${id})`);
                console.log(
                  `  Engines: ${engines.join(", ")}, CPU: ${cpu}, RAM: ${memory}MB, Scratch: ${scratch}MB`,
                );
              });
            },
          ),
      )
      .command(
        "discover",
        "Observe live Slurm nodes (read-only)",
        {
          json: { type: "boolean", default: false },
        } as const,
        async (args) => {
          printCluster(await discoverCluster(), args.json);
        },
      )
      .command(
        "list",
        "List live cluster nodes, or project nodes when no site profile exists",
        {
          source: { type: "string", choices: ["auto", "project", "slurm"], default: "auto" },
          json: { type: "boolean", default: false },
        } as const,
        async (args) => {
          if (args.source === "slurm" || (args.source === "auto" && loadClusterProfile())) {
            printCluster(await discoverCluster(), args.json);
            return;
          }
          await runWithContext(async ({ db }) => {
            const nodes = await db.listNodes();
            if (args.json) {
              console.log(JSON.stringify({ source: "project", nodes }, null, 2));
              return;
            }
            if (nodes.length === 0) {
              console.log("  No nodes found. Use `eigengrid node add` to add one.\n");
              return;
            }
            console.log("  NODE ID      NAME           RUNNER  STATUS   HOST");
            console.log("  --------------------------------------------------");
            for (const n of nodes) {
              const id = (n.id as string).slice(0, 12).padEnd(12);
              const name = (n.name as string).slice(0, 14).padEnd(14);
              const runner = (n.runner as string).padEnd(7);
              const status = (n.status as string).padEnd(8);
              console.log(`  ${id} ${name} ${runner} ${status} ${n.host}`);
            }
            console.log("");
          });
        },
      )
      .command(
        "show",
        "Show node details",
        { id: { type: "string", demandOption: true } } as const,
        async (args) => {
          const nodeId = args.id as string;
          const clusterNodes = await clusterNodeRecords();
          if (clusterNodes) {
            const node = clusterNodes.find((n) => n.id === nodeId || n.name === nodeId);
            if (!node) throw new Error(`Slurm node not found: ${nodeId}`);
            console.log(JSON.stringify(node, null, 2));
            return;
          }
          await runWithContext(async ({ db }) => {
            const n = await db.getNode(nodeId);
            if (!n) {
              console.log(`  Node not found: ${nodeId}\n`);
              return;
            }
            console.log(`  ID:          ${n.id}`);
            console.log(`  Name:        ${n.name}`);
            console.log(`  Host:        ${n.host}`);
            console.log(`  User:        ${n.user}`);
            console.log(`  Port:        ${n.port ?? 22}`);
            console.log(`  Runner:      ${n.runner}`);
            console.log(`  Status:      ${n.status}`);
            console.log(`  Max jobs:    ${n.maxJobs}`);
            if (n.privateKeyPath) console.log(`  SSH key:     ${n.privateKeyPath}`);
            if (n.remoteScratchDir) console.log(`  Remote dir:  ${n.remoteScratchDir}`);
            if (n.tagsJson && JSON.parse(n.tagsJson).length > 0) {
              console.log(`  Tags:        ${n.tagsJson}`);
            }
            console.log("");
          });
        },
      )
      .command(
        "rm",
        "Remove a node",
        { id: { type: "string", demandOption: true } } as const,
        async (args) => {
          const nodeId = args.id as string;
          await runWithContext(async ({ db }) => {
            await db.removeNode(nodeId);
            console.log(`  Removed node: ${nodeId}\n`);
          });
        },
      )
      .command(
        "sync <node>",
        "Sync worker status from a compute node",
        {
          node: {
            type: "string",
            describe: "Node name to sync from",
            demandOption: true,
          },
        } as const,
        async (args) => {
          const nodeName = args.node as string;
          await runWithContext(async ({ db, config }) => {
            const service = new WorkerSyncService(db, config);
            const result = await service.syncNode(nodeName);

            if (result.ok) {
              console.log(`  Synced ${result.syncedJobs} job(s) from node "${nodeName}"\n`);
            } else {
              console.log(`  Sync from node "${nodeName}" completed with errors:\n`);
              console.log(`  Synced jobs: ${result.syncedJobs}`);
              for (const err of result.errors) {
                console.log(`    - ${err}`);
              }
              console.log("");
            }
          });
        },
      )
      // ── Power subcommands ───────────────────────
      .command("power", "Manage node power configuration and Wake-on-LAN", (y2) =>
        y2
          .command(
            "show <node>",
            "Show power configuration for a node",
            {
              node: {
                type: "string",
                describe: "Node name or ID prefix",
                demandOption: true,
              },
            } as const,
            async (args) => {
              const nodeIdOrName = args.node as string;
              await runWithContext(async ({ db }) => {
                let node: NodeRecord | null = null;
                try {
                  const resolved = await db.resolveNodeId(nodeIdOrName);
                  node = await db.getNode(resolved);
                } catch {
                  node = await db.getNodeByName(nodeIdOrName);
                }
                if (!node) {
                  console.log(`  Node not found: ${nodeIdOrName}\n`);
                  return;
                }
                const id = String(node.id).slice(0, 12).padEnd(12);
                const name = String(node.name ?? "");
                console.log(`\n  POWER CONFIG — ${name} (${id.trim()})`);
                console.log(`  ${"=".repeat(50)}`);
                console.log(`  Power mode:        ${String(node.powerMode ?? "manual")}`);
                console.log(`  Allow wake:        ${node.allowWake ? "yes" : "no"}`);
                console.log(`  Allow power-down:  ${node.allowPowerDown ? "yes" : "no"}`);
                console.log(`  MAC address:       ${node.macAddress ?? "(not set)"}`);
                console.log(`  Broadcast address: ${node.broadcastAddress ?? "(not set)"}`);
                console.log(`  WoL port:          ${node.wolPort ?? 9}`);
                console.log(`  Idle power-down:   ${node.idlePowerDownAfterSec ?? 300}s`);
                console.log(`  Is head node:      ${node.isHead ? "yes" : "no"}`);
                console.log(
                  `  Last wake:         ${node.lastWakeAt ? new Date(Number(node.lastWakeAt)).toISOString() : "never"}`,
                );
                console.log(
                  `  Last power-down:   ${node.lastPowerDownAt ? new Date(Number(node.lastPowerDownAt)).toISOString() : "never"}`,
                );
                console.log("");
              });
            },
          )
          .command(
            "configure <node>",
            "Configure power settings for a node",
            {
              node: {
                type: "string",
                describe: "Node name or ID prefix",
                demandOption: true,
              },
              mac: {
                type: "string",
                describe: "MAC address (e.g., AA:BB:CC:DD:EE:FF)",
              },
              broadcast: {
                type: "string",
                describe: "Broadcast address (e.g., 192.168.1.255)",
              },
              "wol-port": {
                type: "number",
                describe: "WoL UDP port (default: 9)",
              },
              "allow-wake": {
                type: "boolean",
                describe: "Allow waking this node via WoL",
              },
              "allow-power-down": {
                type: "boolean",
                describe: "Allow idle power-down for this node",
              },
              "idle-after": {
                type: "number",
                describe: "Idle grace period in seconds before power-down",
              },
              "head-node": {
                type: "boolean",
                describe: "Mark as head node (never powered down)",
              },
            } as const,
            async (args) => {
              const nodeIdOrName = args.node as string;
              const mac = args.mac as string | undefined;
              const broadcast = args.broadcast as string | undefined;
              const wolPort = args["wol-port"] as number | undefined;
              const allowWake = args["allow-wake"] as boolean | undefined;
              const allowPowerDown = args["allow-power-down"] as boolean | undefined;
              const idleAfter = args["idle-after"] as number | undefined;
              const headNode = args["head-node"] as boolean | undefined;

              // Validate MAC if provided
              if (mac !== undefined && !isValidMacAddress(mac)) {
                console.log(`  Error: Invalid MAC address format: ${mac}\n`);
                console.log(
                  "  Expected formats: XX:XX:XX:XX:XX:XX, XX-XX-XX-XX-XX-XX,\n  XXXXXXXXXXXX, or XXXX.XXXX.XXXX\n",
                );
                return;
              }

              await runWithContext(async ({ db }) => {
                let nodeId: string;
                try {
                  nodeId = await db.resolveNodeId(nodeIdOrName);
                } catch {
                  const byName = await db.getNodeByName(nodeIdOrName);
                  if (!byName) {
                    console.log(`  Node not found: ${nodeIdOrName}\n`);
                    return;
                  }
                  nodeId = String(byName.id);
                }

                const currentNode = await db.getNode(nodeId);
                if (!currentNode) {
                  console.log(`  Node not found: ${nodeIdOrName}\n`);
                  return;
                }
                const updates: NodeUpdateInput = {};
                if (mac !== undefined) {
                  updates.macAddress = mac;
                }
                if (broadcast !== undefined) {
                  updates.broadcastAddress = broadcast;
                }
                if (wolPort !== undefined) {
                  updates.wolPort = wolPort;
                }
                if (allowWake !== undefined) {
                  updates.allowWake = allowWake;
                }
                if (allowPowerDown !== undefined) {
                  updates.allowPowerDown = allowPowerDown;
                }
                if (idleAfter !== undefined) {
                  updates.idlePowerDownAfterSec = idleAfter;
                }
                if (headNode !== undefined) {
                  updates.isHead = headNode;
                }

                if (allowWake !== undefined || allowPowerDown !== undefined) {
                  const effectiveWake = allowWake ?? currentNode.allowWake;
                  const effectivePowerDown = allowPowerDown ?? currentNode.allowPowerDown;
                  updates.powerMode = effectivePowerDown
                    ? "managed"
                    : effectiveWake
                      ? "wakeable"
                      : "manual";
                }

                if (Object.keys(updates).length === 0) {
                  console.log("  No power settings to update. Specify at least one option.\n");
                  console.log(
                    "  Options: --mac, --broadcast, --wol-port, --allow-wake,\n" +
                      "  --allow-power-down, --idle-after, --head-node\n",
                  );
                  return;
                }

                await updateNode(db, nodeId, updates);

                console.log(`  Power settings updated for node: ${nodeIdOrName}\n`);
              });
            },
          )
          .command(
            "wake <node>",
            "Send Wake-on-LAN packet to a node",
            {
              node: {
                type: "string",
                describe: "Node name or ID prefix",
                demandOption: true,
              },
            } as const,
            async (args) => {
              const nodeIdOrName = args.node as string;
              await runWithContext(async ({ db }) => {
                let nodeId = "";
                let node: NodeRecord | null = null;
                try {
                  nodeId = await db.resolveNodeId(nodeIdOrName);
                  node = await db.getNode(nodeId);
                } catch {
                  node = await db.getNodeByName(nodeIdOrName);
                  if (node) nodeId = String(node.id);
                }
                if (!node) {
                  console.log(`  Node not found: ${nodeIdOrName}\n`);
                  return;
                }

                const mac = String(node.macAddress ?? "");
                const broadcast = String(node.broadcastAddress ?? "");
                const wolPort = Number(node.wolPort ?? 9);

                if (!mac) {
                  console.log(`  Error: No MAC address configured for ${nodeIdOrName}.\n`);
                  console.log(
                    "  Use `eigengrid node power configure <node> --mac <address>` first.\n",
                  );
                  return;
                }
                if (!broadcast) {
                  console.log(`  Error: No broadcast address configured for ${nodeIdOrName}.\n`);
                  console.log(
                    "  Use `eigengrid node power configure <node> --broadcast <ip>` first.\n",
                  );
                  return;
                }

                console.log(`  Sending WoL packet to ${nodeIdOrName}...`);
                console.log(`  MAC:       ${mac}`);
                console.log(`  Broadcast: ${broadcast}`);
                console.log(`  Port:      ${wolPort}`);

                try {
                  await sendWolPacket(mac, broadcast, wolPort);
                  console.log("  WoL packet sent successfully.\n");

                  // Record last wake timestamp through the provider-neutral DB boundary.
                  await updateNode(db, nodeId, { lastWakeAt: Date.now() });
                } catch (err) {
                  console.log(`  Error sending WoL packet: ${err}\n`);
                }
              });
            },
          )
          .command(
            "disable <node>",
            "Disable power management and revert to manual mode",
            {
              node: {
                type: "string",
                describe: "Node name or ID prefix",
                demandOption: true,
              },
            } as const,
            async (args) => {
              const nodeIdOrName = args.node as string;
              await runWithContext(async ({ db }) => {
                let nodeId: string;
                try {
                  nodeId = await db.resolveNodeId(nodeIdOrName);
                } catch {
                  const byName = await db.getNodeByName(nodeIdOrName);
                  if (!byName) {
                    console.log(`  Node not found: ${nodeIdOrName}\n`);
                    return;
                  }
                  nodeId = String(byName.id);
                }

                await updateNode(db, nodeId, {
                  powerMode: "manual",
                  allowWake: false,
                  allowPowerDown: false,
                  macAddress: null,
                  broadcastAddress: null,
                  wolPort: null,
                  idlePowerDownAfterSec: null,
                });

                console.log(`  Power management disabled for node: ${nodeIdOrName}\n`);
              });
            },
          )
          .demandCommand(1, "Specify a power subcommand"),
      )
      .demandCommand(1, "Specify a subcommand"),
  async handler() {
    console.log("  Use `eigengrid node list` to list nodes.\n");
  },
};
