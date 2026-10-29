import type { JobStatus } from "./types";

export const EIGENGRID_DIR = ".eigengrid";
export const CONFIG_FILE = "eigengrid.yaml";
export const DB_FILE = "eigengrid.sqlite";
export const JOBS_DIR = "jobs";
export const LOGS_DIR = "logs";
export const OUTPUTS_DIR = "outputs";
export const SESSIONS_DIR = "sessions";

export const VALID_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  created: ["queued"],
  queued: ["staged", "failed", "cancelled"],
  staged: ["running", "failed", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: ["parsed", "failed"],
  parsed: [],
  failed: [],
  cancelled: [],
};
