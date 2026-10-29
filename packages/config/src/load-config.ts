import type { Config, DbProvider, EigenGridRole } from "@eigengrid/core";
import { existsSync, readFileSync } from "fs";
import { isAbsolute, join } from "path";
import { getDefaultConfig } from "./default-config";
import { getConfigPath, getEigenGridDir } from "./paths";
import { normalizeRole } from "./roles";

type ConfigFileShape = Partial<{
  database: string;
  databasePath: string;
  dbProvider: string;
  databaseUrl: string;
  jobsDir: string;
  logsDir: string;
  outputsDir: string;
  python: string;
  pythonCommand: string;
  sessionsDir: string;
  role: string;
  nodeName: string;
  sshKeyPath: string;
  remoteScratchDir: string;
  headHost: string;
  headUser: string;
  knownHostsPath: string;
  "workerAgent.mode": string;
  "workerAgent.maxRecoveryActionsPerJob": string;
  "workerAgent.maxRecoveryActionsPerHour": string;
  "workerAgent.allowParserRetry": string;
  "workerAgent.allowArtifactSyncRetry": string;
  "workerAgent.allowSameCommandRetry": string;
  "workerAgent.allowNodeDrain": string;
  "workerAgent.allowPidReattach": string;
}>;

const CONFIG_FILE_KEYS = new Set<keyof ConfigFileShape>([
  "database",
  "databasePath",
  "dbProvider",
  "databaseUrl",
  "jobsDir",
  "logsDir",
  "outputsDir",
  "python",
  "pythonCommand",
  "sessionsDir",
  "role",
  "nodeName",
  "sshKeyPath",
  "remoteScratchDir",
  "headHost",
  "headUser",
  "knownHostsPath",
  "workerAgent.mode",
  "workerAgent.maxRecoveryActionsPerJob",
  "workerAgent.maxRecoveryActionsPerHour",
  "workerAgent.allowParserRetry",
  "workerAgent.allowArtifactSyncRetry",
  "workerAgent.allowSameCommandRetry",
  "workerAgent.allowNodeDrain",
  "workerAgent.allowPidReattach",
]);

function parseFlatYaml(source: string): ConfigFileShape {
  const result: ConfigFileShape = {};

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf(":");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!value) continue;

    const unwrapped =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
        ? value.slice(1, -1)
        : value;

    if (CONFIG_FILE_KEYS.has(key as keyof ConfigFileShape)) {
      result[key as keyof ConfigFileShape] = unwrapped;
    }
  }

  return result;
}

function resolvePathValue(cwd: string | undefined, value: string): string {
  if (isAbsolute(value)) return value;
  return join(getEigenGridDir(cwd), value);
}

function applyConfigValue(
  config: Config,
  cwd: string | undefined,
  key: keyof ConfigFileShape,
  value: string,
): Config {
  if (key === "python" || key === "pythonCommand") {
    return { ...config, pythonCommand: value };
  }

  if (key === "database" || key === "databasePath") {
    return { ...config, databasePath: resolvePathValue(cwd, value) };
  }

  if (key === "dbProvider") {
    if (value === "sqlite" || value === "postgres") {
      return { ...config, dbProvider: value as DbProvider };
    }
    return config;
  }

  if (key === "databaseUrl") {
    return { ...config, databaseUrl: value, dbProvider: "postgres" };
  }

  if (key === "jobsDir") {
    return { ...config, jobsDir: resolvePathValue(cwd, value) };
  }

  if (key === "logsDir") {
    return { ...config, logsDir: resolvePathValue(cwd, value) };
  }

  if (key === "outputsDir") {
    return { ...config, outputsDir: resolvePathValue(cwd, value) };
  }

  if (key === "sessionsDir") {
    return { ...config, sessionsDir: resolvePathValue(cwd, value) };
  }

  if (key === "role") {
    return { ...config, role: normalizeRole(value) };
  }

  if (key === "nodeName") {
    return { ...config, nodeName: value };
  }

  if (key === "sshKeyPath") {
    return { ...config, sshKeyPath: value };
  }

  if (key === "remoteScratchDir") {
    return { ...config, remoteScratchDir: value };
  }

  if (key === "headHost") {
    return { ...config, headHost: value };
  }

  if (key === "headUser") {
    return { ...config, headUser: value };
  }

  if (key === "knownHostsPath") {
    return { ...config, knownHostsPath: resolvePathValue(cwd, value) };
  }

  if (key === "workerAgent.mode") {
    const mode = value as "off" | "recover-only";
    if (mode === "off" || mode === "recover-only") {
      return { ...config, workerAgent: { ...config.workerAgent!, mode } };
    }
    return config;
  }

  if (key === "workerAgent.maxRecoveryActionsPerJob") {
    return {
      ...config,
      workerAgent: { ...config.workerAgent!, maxRecoveryActionsPerJob: parseInt(value, 10) || 1 },
    };
  }

  if (key === "workerAgent.maxRecoveryActionsPerHour") {
    return {
      ...config,
      workerAgent: { ...config.workerAgent!, maxRecoveryActionsPerHour: parseInt(value, 10) || 10 },
    };
  }

  if (key === "workerAgent.allowParserRetry") {
    return {
      ...config,
      workerAgent: { ...config.workerAgent!, allowParserRetry: value === "true" },
    };
  }

  if (key === "workerAgent.allowArtifactSyncRetry") {
    return {
      ...config,
      workerAgent: { ...config.workerAgent!, allowArtifactSyncRetry: value === "true" },
    };
  }

  if (key === "workerAgent.allowSameCommandRetry") {
    return {
      ...config,
      workerAgent: { ...config.workerAgent!, allowSameCommandRetry: value === "true" },
    };
  }

  if (key === "workerAgent.allowNodeDrain") {
    return { ...config, workerAgent: { ...config.workerAgent!, allowNodeDrain: value === "true" } };
  }

  if (key === "workerAgent.allowPidReattach") {
    return {
      ...config,
      workerAgent: { ...config.workerAgent!, allowPidReattach: value === "true" },
    };
  }

  return config;
}

function applyEnvOverrides(config: Config, cwd: string | undefined): Config {
  const envEntries: Array<[keyof ConfigFileShape, string | undefined]> = [
    ["pythonCommand", process.env.EIGENGRID_PYTHON],
    ["databaseUrl", process.env.DATABASE_URL ?? process.env.EIGENGRID_DATABASE_URL],
    [
      "databasePath",
      process.env.EIGENGRID_DB_PATH ??
        process.env.EIGENGRID_DATABASE_PATH ??
        process.env.EIGENGRID_DATABASE,
    ],
    ["dbProvider", process.env.EIGENGRID_DB_PROVIDER],
    ["jobsDir", process.env.EIGENGRID_JOBS_DIR],
    ["logsDir", process.env.EIGENGRID_LOGS_DIR],
    ["outputsDir", process.env.EIGENGRID_OUTPUTS_DIR],
    ["sessionsDir", process.env.EIGENGRID_SESSIONS_DIR],
    ["role", process.env.EIGENGRID_ROLE],
    ["nodeName", process.env.EIGENGRID_NODE_NAME],
    ["sshKeyPath", process.env.EIGENGRID_SSH_KEY_PATH],
    ["remoteScratchDir", process.env.EIGENGRID_REMOTE_SCRATCH_DIR],
    ["headHost", process.env.EIGENGRID_HEAD_HOST],
    ["headUser", process.env.EIGENGRID_HEAD_USER],
    ["knownHostsPath", process.env.EIGENGRID_KNOWN_HOSTS],
    ["workerAgent.mode", process.env.EIGENGRID_WORKER_AGENT_MODE],
    [
      "workerAgent.maxRecoveryActionsPerJob",
      process.env.EIGENGRID_WORKER_AGENT_MAX_RECOVERY_PER_JOB,
    ],
    [
      "workerAgent.maxRecoveryActionsPerHour",
      process.env.EIGENGRID_WORKER_AGENT_MAX_RECOVERY_PER_HOUR,
    ],
    ["workerAgent.allowParserRetry", process.env.EIGENGRID_WORKER_AGENT_ALLOW_PARSER_RETRY],
    [
      "workerAgent.allowArtifactSyncRetry",
      process.env.EIGENGRID_WORKER_AGENT_ALLOW_ARTIFACT_SYNC_RETRY,
    ],
    [
      "workerAgent.allowSameCommandRetry",
      process.env.EIGENGRID_WORKER_AGENT_ALLOW_SAME_COMMAND_RETRY,
    ],
    ["workerAgent.allowNodeDrain", process.env.EIGENGRID_WORKER_AGENT_ALLOW_NODE_DRAIN],
    ["workerAgent.allowPidReattach", process.env.EIGENGRID_WORKER_AGENT_ALLOW_PID_REATTACH],
  ];

  return envEntries.reduce((current, [key, value]) => {
    if (!value) return current;
    return applyConfigValue(current, cwd, key, value);
  }, config);
}

export async function loadConfig(cwd?: string): Promise<Config> {
  const defaults: Config = { ...getDefaultConfig(cwd), role: "standalone" as EigenGridRole };
  const configPath = getConfigPath(cwd);

  if (!existsSync(configPath)) {
    return applyEnvOverrides(defaults, cwd);
  }

  const fileConfig = parseFlatYaml(readFileSync(configPath, "utf8"));
  const merged = Object.entries(fileConfig).reduce((current, [key, value]) => {
    if (!value) return current;
    return applyConfigValue(current, cwd, key as keyof ConfigFileShape, value);
  }, defaults);

  return applyEnvOverrides(merged, cwd);
}
