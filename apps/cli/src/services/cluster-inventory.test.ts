import { describe, expect, it } from "bun:test";
import { discoverCluster, parseClusterNodes, type ClusterProfile } from "./cluster-inventory";
import type { CliExecutor, CliResult } from "@eigengrid/slurm";

const profile: ClusterProfile = {
  schemaVersion: "eigengrid.cluster-profile/v1",
  clusterName: "test",
  controller: "login",
  loginNodes: ["login"],
};
const worker = "worker-01|idle|16|0/16/0/16|30000|28000|chem*|(null)|up";
const beast = "beast|mixed|16|4/12/0/16|120000|75000|beast-gpu|gpu:rtx_5090:1|up";

describe("live cluster inventory", () => {
  it("uses Slurm capacity, GPU resources and partitions, excluding the login host", () => {
    const nodes = parseClusterNodes(
      `${worker}\n${beast}\nlogin|idle|8|0/8/0/8|8000|5000|admin|(null)|up\n`,
      profile,
    );
    expect(nodes.map((node) => node.name)).toEqual(["beast", "worker-01"]);
    expect(nodes[0]).toMatchObject({
      status: "busy",
      idleCpus: 12,
      gres: "gpu:rtx_5090:1",
      runner: "slurm",
    });
    expect(nodes[1].partitions).toEqual(["chem"]);
  });
  it("merges a node in multiple partitions without doubling its capacity", () => {
    const nodes = parseClusterNodes(`${worker}\n${worker.replace("chem*", "general")}`, profile);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].partitions).toEqual(["chem", "general"]);
    expect(nodes[0].cpus).toBe(16);
  });
  it("shows unavailable nodes and partitions without treating them as available", () => {
    const [node] = parseClusterNodes(
      worker.replace("|idle|", "|down*|").replace("|up", "|down").replace("|28000|", "|N/A|"),
      profile,
    );
    expect(node.status).toBe("offline");
    expect(node.availablePartitions).toEqual([]);
    expect(node.osFreeMemoryMiB).toBeNull();
    expect(parseClusterNodes(worker.replace("idle", "idle+drain"), profile)[0].status).toBe(
      "draining",
    );
  });
  it("rejects malformed, compressed, conflicting or inconsistent resource output", () => {
    for (const text of [
      "worker|idle|16",
      worker.replace("worker-01", "worker-[01-04]"),
      worker.replace("0/16/0/16", "0/12/0/16"),
      `${worker}\n${worker.replace("|idle|", "|mixed|")}`,
      worker.replace("30000", "30000M"),
    ])
      expect(() => parseClusterNodes(text, profile)).toThrow();
  });
  it("performs only bounded read commands and reports a fresh observation", async () => {
    const calls: [string, string[]][] = [];
    const executor: CliExecutor = {
      async run(cmd, args, options) {
        calls.push([cmd, args]);
        expect(options?.timeout).toBe(10000);
        expect(options?.maxOutputBytes).toBe(1024 * 1024);
        expect(options?.maxErrorBytes).toBe(65536);
        expect(options?.inheritEnv).toBe(false);
        expect(options?.env).toEqual({
          PATH: "/usr/bin:/bin",
          LC_ALL: "C",
          SLURM_CONF: "/etc/slurm/slurm.conf",
        });
        return {
          exitCode: 0,
          stdout: cmd === "sinfo" ? `${worker}\n${beast}` : "slurm 26.05.5\n",
          stderr: "",
        };
      },
    };
    const result = await discoverCluster(profile, executor);
    expect(result.totalNodes).toBe(2);
    expect(result.source).toBe("slurm");
    expect(result.readOnly).toBeTrue();
    expect(result.scientificDispatchQualified).toBeFalse();
    expect(calls.map(([cmd]) => cmd).sort()).toEqual(["scontrol", "sinfo"]);
    expect(calls.find(([cmd]) => cmd === "sinfo")?.[1]).toContain("--Node");
  });
  it("does not report cached or project nodes when Slurm fails or truncates", async () => {
    for (const failure of [
      { exitCode: 1 },
      { timedOut: true },
      { stdoutTruncated: true },
      { stderrTruncated: true },
    ]) {
      const executor: CliExecutor = {
        async run(): Promise<CliResult> {
          return { exitCode: 0, stdout: worker, stderr: "", ...failure };
        },
      };
      await expect(discoverCluster(profile, executor)).rejects.toThrow("live state unavailable");
    }
    await expect(discoverCluster(null)).rejects.toThrow("No cluster profile configured");
  });
});
