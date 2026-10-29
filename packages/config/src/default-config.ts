import type { Config, WorkerAgentConfig } from "@eigengrid/core";
import { getDbPath, getJobsDir, getLogsDir, getOutputsDir, getSessionsDir } from "./paths";

export function getDefaultWorkerAgentConfig(): WorkerAgentConfig {
  return {
    mode: "off",
    maxRecoveryActionsPerJob: 1,
    maxRecoveryActionsPerHour: 10,
    allowParserRetry: true,
    allowArtifactSyncRetry: true,
    allowSameCommandRetry: false,
    allowNodeDrain: true,
    allowPidReattach: true,
  };
}

export function getDefaultConfig(cwd?: string): Config {
  return {
    databasePath: getDbPath(cwd),
    dbProvider: "sqlite",
    jobsDir: getJobsDir(cwd),
    logsDir: getLogsDir(cwd),
    outputsDir: getOutputsDir(cwd),
    pythonCommand: "python",
    sessionsDir: getSessionsDir(cwd),
    workerAgent: getDefaultWorkerAgentConfig(),
  };
}
