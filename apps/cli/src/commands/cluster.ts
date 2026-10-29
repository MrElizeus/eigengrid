import type { CommandModule } from "yargs";
import { discoverCluster, printCluster } from "../services/cluster-inventory";

export const clusterCommand: CommandModule = {
  command: "cluster [action]",
  describe: "Observe live Slurm compute nodes without changing jobs or project data",
  builder: (y) =>
    y
      .positional("action", { choices: ["status", "nodes"], default: "status" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    printCluster(await discoverCluster(), args.json as boolean);
  },
};
