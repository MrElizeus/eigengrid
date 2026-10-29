export type JobStatus =
  | "created"
  | "queued"
  | "staged"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "parsed";

export type JobAttemptStatus =
  | "created"
  | "queued"
  | "staged"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type EigenGridRole = "standalone" | "head" | "worker";

export type Software =
  | "gaussian"
  | "orca"
  | "xtb"
  | "cp2k"
  | "qe"
  | "amber"
  | "gromacs"
  | "unknown";

export type RunnerKind = "local" | "ssh" | "worker-daemon" | "slurm" | "pbs";

export type ArtifactKind =
  | "input"
  | "output"
  | "log"
  | "checkpoint"
  | "geometry"
  | "result"
  | "report"
  | "other";

export type NodeStatus = "unknown" | "online" | "busy" | "offline" | "draining" | "error";

export interface Job {
  id: string;
  name: string;
  software: Software;
  inputPath: string;
  workdir: string;
  outputPath?: string;
  nodeId?: string;
  status: JobStatus;
  ownerUserId?: string;
  projectId?: string;
  backend?: string;
  externalJobId?: string;
  externalState?: string;
  lastSyncAt?: number;
  nativeDetail?: string;
  nodeName?: string;
  createdAt: number;
  updatedAt: number;
}

export interface JobAttempt {
  id: string;
  jobId: string;
  runner: RunnerKind;
  status: JobAttemptStatus;
  command: string;
  cwd: string;
  pid?: number;
  exitCode?: number;
  startedAt?: number;
  finishedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface Artifact {
  id: string;
  jobId: string;
  attemptId: string;
  kind: ArtifactKind;
  path: string;
  label?: string;
  mimeType?: string;
  sizeBytes?: number;
  createdAt: number;
}

export interface ComputeNode {
  id: string;
  name: string;
  host: string;
  user: string;
  port: number;
  runner: RunnerKind;
  status: NodeStatus;
  tags: string[];
  maxJobs: number;
  privateKeyPath?: string;
  remoteScratchDir?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChemistryResult {
  jobId: string;
  attemptId: string;
  parser: "gaussian" | "orca" | "xtb" | "cp2k";
  status: "completed" | "failed" | "partial" | "unknown";
  energyHartree?: number;
  scfConverged?: boolean;
  imaginaryFrequencies?: number;
  normalTermination?: boolean;
  warnings: string[];
  errors: string[];
  raw: Record<string, unknown>;
}

export interface RunnerResult {
  ok: boolean;
  message?: string;
  metadata?: Record<string, unknown>;
  /**
   * A failed remote operation may have crossed its effect boundary even when
   * the transport did not acknowledge it. Callers must reconcile before
   * retrying such an operation; a terminal-confirmed failure is safe to
   * release immediately.
   */
  failureDisposition?: "terminal-confirmed" | "termination-unknown";
}

export type StartedProcess =
  | {
      ok: true;
      pid?: number;
      command?: string;
      message?: string;
      failureDisposition?: never;
    }
  | {
      ok: false;
      message?: string;
      /** Whether a failed start is safe to terminalize or still owns capacity. */
      failureDisposition?: "terminal-confirmed" | "termination-unknown";
      pid?: number;
      command?: string;
    };

export interface RemoteProcessStatus {
  status: "unknown" | "running" | "completed" | "failed" | "stopped";
  exitCode?: number;
  message?: string;
}

export interface ParseResult {
  ok: boolean;
  parser: string;
  status: "completed" | "failed" | "partial" | "unknown";
  data?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    hint?: string;
  };
}

export interface GenerateResult {
  ok: boolean;
  message?: string;
  data?: Record<string, unknown>;
}

export interface ConformerResult {
  ok: boolean;
  conformers?: number;
  data?: Record<string, unknown>;
}

export interface PythonResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; hint?: string };
}

// ────────────────────────────────────────────────────────────
// Permission Contracts
// ────────────────────────────────────────────────────────────

export type PermissionEffect = "allow" | "deny" | "ask";

export interface PermissionRule {
  action: string;
  resource: string;
  effect: PermissionEffect;
}

export type PermissionRuleset = PermissionRule[];

export interface SshRunnerConfig {
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  /** Explicit known-hosts database used for strict host identity verification. */
  knownHostsPath?: string;
  /**
   * Characterization-only compatibility switch. Production callers must leave
   * this unset; it exists solely so the golden trace can replay the
   * pre-convergence event ordering without weakening the secure default.
   */
  legacyLifecycleForCharacterization?: boolean;
  remoteScratchDir: string;
}

export interface WorkerAgentConfig {
  mode: "off" | "recover-only";
  maxRecoveryActionsPerJob: number;
  maxRecoveryActionsPerHour: number;
  allowParserRetry: boolean;
  allowArtifactSyncRetry: boolean;
  allowSameCommandRetry: boolean;
  allowNodeDrain: boolean;
  allowPidReattach: boolean;
}

export type DbProvider = "sqlite" | "postgres";

export interface Config {
  databasePath: string;
  dbProvider: DbProvider;
  databaseUrl?: string;
  jobsDir: string;
  logsDir: string;
  outputsDir: string;
  pythonCommand: string;
  sessionsDir: string;
  role?: EigenGridRole;
  nodeName?: string;
  sshKeyPath?: string;
  remoteScratchDir?: string;
  headHost?: string;
  headUser?: string;
  knownHostsPath?: string;
  workerAgent?: WorkerAgentConfig;
}
