import type { CommandModule } from "yargs";
import { initProject } from "../services/init-service";

export const initCommand: CommandModule = {
  command: "init",
  describe: "Initialize an EigenGrid project",
  builder: (y) =>
    y.options({
      role: {
        type: "string",
        choices: ["standalone", "head", "worker"] as const,
        default: "standalone" as const,
        describe: "Node role",
      },
      "node-name": {
        type: "string",
        describe: "Node name (defaults to {role}-node)",
      },
      python: {
        type: "string",
        describe: "Python command",
      },
      database: {
        type: "string",
        describe: "Database filename (relative to .eigengrid)",
      },
      "jobs-dir": {
        type: "string",
        describe: "Jobs directory (relative to .eigengrid)",
      },
      "logs-dir": {
        type: "string",
        describe: "Logs directory (relative to .eigengrid)",
      },
      "outputs-dir": {
        type: "string",
        describe: "Outputs directory (relative to .eigengrid)",
      },
      "sessions-dir": {
        type: "string",
        describe: "Sessions directory (relative to .eigengrid)",
      },
      "ssh-key-path": {
        type: "string",
        describe: "Path to SSH private key (head only)",
      },
      "generate-ssh-key": {
        type: "boolean",
        default: true,
        describe: "Generate SSH key pair (head only)",
      },
      "remote-dir": {
        type: "string",
        describe: "Remote scratch directory (worker only)",
      },
      "head-host": {
        type: "string",
        describe: "Head node hostname (worker only)",
      },
      "head-user": {
        type: "string",
        describe: "Head node SSH user (worker only)",
      },
      update: {
        type: "boolean",
        default: false,
        describe: "Allow role change if already initialized",
      },
    }),
  async handler(args) {
    const input = {
      role: args.role as "standalone" | "head" | "worker",
      nodeName: args["node-name"] as string | undefined,
      python: args.python as string | undefined,
      database: args.database as string | undefined,
      jobsDir: args["jobs-dir"] as string | undefined,
      logsDir: args["logs-dir"] as string | undefined,
      outputsDir: args["outputs-dir"] as string | undefined,
      sessionsDir: args["sessions-dir"] as string | undefined,
      sshKeyPath: args["ssh-key-path"] as string | undefined,
      generateSshKey: args["generate-ssh-key"] as boolean | undefined,
      remoteDir: args["remote-dir"] as string | undefined,
      headHost: args["head-host"] as string | undefined,
      headUser: args["head-user"] as string | undefined,
      update: args.update as boolean | undefined,
    };

    const result = await initProject(input);

    for (const w of result.warnings) {
      console.warn("  Warning:", w);
    }

    console.log(`  Initialized ${input.role} EigenGrid project at ${result.configPath}`);
  },
};
