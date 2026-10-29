export interface SlurmSubmitOptions {
  jobName?: string;
  partition?: string;
  account?: string;
  qos?: string;
  time?: string;
  cpusPerTask?: number;
  mem?: string;
  nodes?: number;
  ntasks?: number;
  output?: string;
  error?: string;
  chdir?: string;
  envVars?: Record<string, string>;
}

export interface SlurmSubmitResult {
  slurmJobId: string;
  success: boolean;
  error?: string;
  /** The scheduler may have accepted the request before transport loss. */
  ambiguous?: boolean;
}

export type SlurmJobState =
  | "PENDING"
  | "RUNNING"
  | "COMPLETING"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED"
  | "TIMEOUT"
  | "NODE_FAIL"
  | "PREEMPTED"
  | "BOOT_FAIL"
  | "OUT_OF_MEMORY"
  | "SUSPENDED"
  | "REQUEUED"
  | "RESIZING"
  | "CONFIGURING"
  | "SIGNALING"
  | "STAGE_OUT"
  | "STOPPED"
  | "SPECIAL_EXIT"
  | "REVOKED"
  | "DEADLINE"
  | "RESV_DEL_HOLD"
  | "REQUEUE_HOLD"
  | "REQUEUE_FED"
  | "UNKNOWN";

export interface SlurmJobStatus {
  slurmJobId: string;
  state: SlurmJobState;
  stateCompact: string;
  elapsed?: string;
  timeLimit?: string;
  exitCode?: number;
  signal?: number;
  derivedExitCode?: number;
  derivedSignal?: number;
  rawState?: string;
  source?: "sacct" | "squeue";
  accountingPending?: boolean;
  nodeName?: string;
  partition?: string;
  workDir?: string;
  reason?: string;
}

export interface SlurmNode {
  name: string;
  state: string;
  cpus: number;
  freeCpus?: number;
  memoryMb?: number;
  freeMemoryMb?: number;
  partitions: string[];
}

export interface SlurmPartition {
  name: string;
  state: string;
  defaultTime?: string;
  maxTime?: string;
  defaultMem?: string;
  nodes: string[] | string;
}

export interface SlurmAccountingRecord {
  slurmJobId: string;
  state: SlurmJobState;
  exitCode?: number;
  signal?: number;
  derivedExitCode?: number;
  derivedSignal?: number;
  rawState?: string;
  reason?: string;
  uid?: number;
  submittedAt?: string;
  cluster?: string;
  nodeName?: string;
  accountingSchema?: string;
  nativeAccountingSchema?: string;
  records?: import("./accounting-contract").SacctRecord[];
  elapsed?: string;
  maxRss?: string;
  reqMem?: string;
  nNodes?: number;
  nCpus?: number;
}

/**
 * Abstract interface for Slurm client implementations.
 * SlurmCliClient implements this via CLI commands.
 * SlurmRestClient (future) implements this via slurmrestd API.
 */
export interface SlurmClient {
  submitJob(scriptPath: string, opts?: SlurmSubmitOptions): Promise<SlurmSubmitResult>;
  getJobStatus(slurmJobId: string): Promise<SlurmJobStatus>;
  cancelJob(slurmJobId: string): Promise<{
    success: boolean;
    error?: string;
    /** Cancellation may have crossed the scheduler boundary without a reply. */
    ambiguous?: boolean;
  }>;
  getNodes(): Promise<SlurmNode[]>;
  getPartitions(): Promise<SlurmPartition[]>;
  getAccounting(slurmJobId: string): Promise<SlurmAccountingRecord | null>;
}
