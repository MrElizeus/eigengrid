import type { Artifact, Job, JobAttempt } from "@eigengrid/core";
import type { EigenGridEventBase } from "@eigengrid/events";
import { type CommandExecutor } from "../executor";
import type {
  IdentityVerification,
  LocalActiveIdentity,
  LocalActiveIdentityV1,
  ProcessStartTokenReader,
} from "../local-identity";
import type { LocalReceipt, LocalReceiptV1 } from "../local-receipt";
import { type RunOptions, type SpawnHandle } from "../process-utils";

// ────────────────────────────────────────────────────────────
// ProcessSupervisor — injectable boundary for identity/receipt
// ────────────────────────────────────────────────────────────
// Separates the IO of writing identity files and terminal
// receipts from the runner's process tracking. Real impl uses
// local-identity.ts / local-receipt.ts; tests inject a fake.

export interface ProcessSupervisor {
  /** Write active identity BEFORE the process is considered started. */
  writeActiveIdentity(
    jobDir: string,
    attemptId: string,
    identity: LocalActiveIdentityV1,
    tokenReader?: ProcessStartTokenReader,
  ): void;

  /** Write terminal receipt after the process completes. */
  writeTerminalReceipt(jobDir: string, attemptId: string, receipt: LocalReceiptV1): void;

  /** Read and verify a receipt with identity match. */
  readReceipt(
    jobDir: string,
    attemptId: string,
    match?: { jobId?: string; attemptId?: string; cwd?: string },
  ): LocalReceipt | null;

  /** Verify active identity against live process. */
  verifyActiveIdentity(jobDir: string, attemptId: string): IdentityVerification;

  /** Read active identity (null if absent/malformed). */
  readActiveIdentity(jobDir: string, attemptId: string): LocalActiveIdentity | null;
}

export interface LocalTerminalAttemptEvidence {
  jobId: string;
  attemptId: string;
  status: "completed" | "failed" | "cancelled";
  exitCode?: number;
  finishedAt: number;
  source: EigenGridEventBase["source"];
  payload?: Record<string, unknown>;
}

export interface LocalRunnerDatabase {
  createJobAttempt(attempt: {
    id: string;
    jobId: string;
    runner: "local";
    command: string;
    cwd: string;
    status?: JobAttempt["status"];
    pid?: number;
    exitCode?: number;
    startedAt?: number;
    finishedAt?: number;
  }): Promise<void>;
  updateJobStatus(jobId: string, status: Job["status"]): Promise<void>;
  updateJobAttemptStatus(
    attemptId: string,
    status: JobAttempt["status"],
    updates?: {
      pid?: number;
      startedAt?: number;
      exitCode?: number;
      finishedAt?: number;
    },
  ): Promise<void>;
  listJobAttempts(jobId?: string): Promise<JobAttempt[]>;
  createArtifact(artifact: Omit<Artifact, "createdAt">): Promise<void>;
  createArtifactIfAbsent(artifact: Omit<Artifact, "createdAt">): Promise<boolean>;
  listArtifacts(jobId?: string): Promise<Artifact[]>;
  materializeTerminalAttempt(evidence: LocalTerminalAttemptEvidence): Promise<void>;
  appendEvent?: (event: EigenGridEventBase) => Promise<void>;
}

export interface LocalRunnerEngine {
  command: string;
  args?: string[];
  displayCommand?: string;
}

export interface LocalRunnerOptions {
  database?: LocalRunnerDatabase;
  engines?: Record<string, LocalRunnerEngine>;
  defaultRunOptions?: RunOptions;
  maxWallTime?: number;
  /** Required legacy UID switch when configured; not an OS sandbox by itself. */
  sandboxUser?: string;
  executor?: CommandExecutor;
  /** Injectable supervisor for identity/receipt persistence. */
  supervisor?: ProcessSupervisor;
  /** Injectable process-start token reader (default: LinuxProcTokenReader). */
  tokenReader?: ProcessStartTokenReader;
  /** Persist terminal status from a detached trusted wrapper, not the launcher. */
  durableCompletion?: boolean;
  /** Host-owned command transformation applied before the durable supervisor. */
  isolateCommand?: (
    command: string,
    args: string[],
    cwd: string,
  ) => { command: string; args: string[] };
  /** Maximum wait for confirmed process-tree termination during local cleanup. */
  cancellationConfirmationTimeoutMs?: number;
}

export interface TrackedProcess {
  handle: SpawnHandle;
  attemptId: string;
  jobDir: string;
  stdoutPath: string;
  stderrPath: string;
  settled: boolean;
  startedAt: number;
}
