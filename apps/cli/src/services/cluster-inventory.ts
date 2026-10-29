import { lstatSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { z } from "zod";
import type { NodeRecord } from "@eigengrid/db";
import { BunExecutor, type CliExecutor } from "@eigengrid/slurm";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u);
export const ClusterProfileSchema = z
  .object({
    schemaVersion: z.literal("eigengrid.cluster-profile/v1"),
    clusterName: identifier,
    controller: identifier,
    loginNodes: z.array(identifier).min(1),
  })
  .strict();
export type ClusterProfile = z.infer<typeof ClusterProfileSchema>;

export interface ClusterNode {
  id: string;
  name: string;
  runner: "slurm";
  state: string;
  status: string;
  cpus: number;
  allocatedCpus: number;
  idleCpus: number;
  otherCpus: number;
  memoryMiB: number;
  osFreeMemoryMiB: number | null;
  partitions: string[];
  availablePartitions: string[];
  gres: string;
}

export function loadClusterProfile(): ClusterProfile | null {
  const path = process.env.EIGENGRID_CLUSTER_PROFILE;
  if (!path) return null;
  const info = lstatSync(path);
  if (!info.isFile() || info.size > 65536) throw new Error("Invalid cluster profile file");
  return ClusterProfileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function number(value: string): number {
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error("Malformed Slurm inventory capacity");
  return Number(value);
}

function nodeStatus(state: string): string {
  const lower = state.toLowerCase();
  if (lower.includes("drain")) return "draining";
  if (/down|fail|unknown|future|power|maint|\*/u.test(lower)) return "offline";
  if (/alloc|mixed|complet/u.test(lower)) return "busy";
  return lower === "idle" ? "online" : "unknown";
}

/** Strict per-node rows, merged across partitions; never register synthetic workers. */
export function parseClusterNodes(stdout: string, profile: ClusterProfile): ClusterNode[] {
  const nodes = new Map<string, ClusterNode>();
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const fields = line.split("|").map((field) => field.trim());
    if (fields.length !== 9) throw new Error("Malformed Slurm inventory row");
    const [name, state, cpu, counts, memory, free, rawPartition, rawGres, availability] = fields;
    identifier.parse(name);
    if (!/^[A-Za-z0-9_+*~#%$@!.:-]+$/u.test(state)) throw new Error("Invalid Slurm node state");
    const parts = counts.split("/");
    if (parts.length !== 4) throw new Error("Malformed Slurm CPU state counts");
    const [allocatedCpus, idleCpus, otherCpus, total] = parts.map(number);
    const cpus = number(cpu);
    if (total !== cpus || allocatedCpus + idleCpus + otherCpus !== total)
      throw new Error("Inconsistent Slurm CPU capacity");
    const partition = rawPartition.replace(/\*$/u, "");
    identifier.parse(partition);
    const item: ClusterNode = {
      id: `slurm:${profile.clusterName}:${name}`,
      name,
      runner: "slurm",
      state,
      status: nodeStatus(state),
      cpus,
      allocatedCpus,
      idleCpus,
      otherCpus,
      memoryMiB: number(memory),
      osFreeMemoryMiB: /^(?:N\/A|n\/a|unknown|\(null\))$/u.test(free) ? null : number(free),
      partitions: [partition],
      availablePartitions: availability.toLowerCase() === "up" ? [partition] : [],
      gres: rawGres === "(null)" ? "" : rawGres,
    };
    if (profile.loginNodes.includes(name)) continue;
    const existing = nodes.get(name);
    if (existing) {
      for (const key of [
        "state",
        "cpus",
        "allocatedCpus",
        "idleCpus",
        "otherCpus",
        "memoryMiB",
        "gres",
      ] as const)
        if (existing[key] !== item[key]) throw new Error("Inconsistent duplicate Slurm node");
      existing.partitions = [...new Set([...existing.partitions, partition])].sort();
      existing.availablePartitions = [
        ...new Set([...existing.availablePartitions, ...item.availablePartitions]),
      ].sort();
    } else nodes.set(name, item);
  }
  return [...nodes.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function discoverCluster(
  profile: ClusterProfile | null = loadClusterProfile(),
  executor: CliExecutor = new BunExecutor(),
) {
  if (!profile) throw new Error("No cluster profile configured (EIGENGRID_CLUSTER_PROFILE)");
  const run = async (command: string, args: string[]) => {
    const result = await executor.run(command, args, {
      timeout: 10000,
      maxOutputBytes: 1024 * 1024,
      maxErrorBytes: 65536,
      inheritEnv: false,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", SLURM_CONF: "/etc/slurm/slurm.conf" },
    });
    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.stdoutTruncated ||
      result.stderrTruncated
    )
      throw new Error(`Slurm inventory query failed (${command}); live state unavailable`);
    return result.stdout;
  };
  const [version, output] = await Promise.all([
    run("scontrol", ["version"]),
    run("sinfo", ["--Node", "--noheader", "--format", "%N|%T|%c|%C|%m|%e|%P|%G|%a"]),
  ]);
  const nodes = parseClusterNodes(output, profile);
  return {
    schemaVersion: "eigengrid.cluster-observation/v1",
    source: "slurm",
    readOnly: true,
    observedAt: new Date().toISOString(),
    clusterName: profile.clusterName,
    controller: profile.controller,
    controllerRole: "login/controller/storage",
    schedulerVersion: version.trim(),
    nodes,
    totalNodes: nodes.length,
    scientificDispatchQualified: false,
  };
}

export async function clusterNodeRecords(): Promise<NodeRecord[] | null> {
  const profile = loadClusterProfile();
  if (!profile) return null;
  const inventory = await discoverCluster(profile);
  const now = Date.parse(inventory.observedAt);
  return inventory.nodes.map((node) => ({
    id: node.id,
    name: node.name,
    host: node.name,
    user: userInfo().username,
    runner: "slurm",
    status: node.status,
    tagsJson: JSON.stringify([
      "source:slurm",
      ...node.partitions.map((part) => `partition:${part}`),
      ...(node.gres ? [node.gres] : []),
    ]),
    maxJobs: 0,
    engines: "[]",
    cpuThreadsTotal: node.cpus,
    memoryMbTotal: node.memoryMiB,
    scratchMbTotal: 0,
    draining: node.status === "draining",
    thermalState: "unknown",
    lastSeenAt: now,
    isHead: false,
    powerMode: "manual",
    macAddress: null,
    broadcastAddress: null,
    wolPort: null,
    allowWake: false,
    allowPowerDown: false,
    idlePowerDownAfterSec: null,
    lastWakeAt: null,
    lastPowerDownAt: null,
    port: 0,
    privateKeyPath: null,
    remoteScratchDir: "",
    createdAt: now,
    updatedAt: now,
  }));
}

export function printCluster(
  inventory: Awaited<ReturnType<typeof discoverCluster>>,
  json = false,
): void {
  if (json) {
    console.log(JSON.stringify(inventory, null, 2));
    return;
  }
  console.log(
    `\n  CLUSTER ${inventory.clusterName} · ${inventory.schedulerVersion} · source: Slurm (live, read-only)`,
  );
  console.log(`  Controller: ${inventory.controller} (login/control/storage)`);
  console.log("  NODE          STATE          CPU idle/total   MEMORY MiB   PARTITIONS       GRES");
  for (const node of inventory.nodes)
    console.log(
      `  ${node.name.padEnd(13)} ${node.state.padEnd(14)} ${`${node.idleCpus}/${node.cpus}`.padEnd(16)} ${String(node.memoryMiB).padEnd(12)} ${node.partitions.join(",").padEnd(16)} ${node.gres || "-"}`,
    );
  console.log(
    `  Observed: ${inventory.observedAt}\n  Scientific dispatch qualification: pending\n`,
  );
}
