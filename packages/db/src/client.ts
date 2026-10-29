import type { EigenGridEvent, EigenGridEventBase, EigenGridEventType } from "@eigengrid/events";
import type {
  Artifact,
  JobAttempt,
  JobAttemptStatus,
  RunnerKind,
  PermissionEffect,
} from "@eigengrid/core";

// ── Core typed records ─────────────────────────────────────────

/** Typed job record. Provider-neutral camelCase fields. */
export interface JobRecord {
  id: string;
  name: string;
  software: string;
  inputPath: string;
  workdir: string;
  outputPath: string | null;
  nodeId: string | null;
  status: string;
  ownerUserId: string | null;
  projectId: string | null;
  backend: string | null;
  externalJobId: string | null;
  externalState: string | null;
  lastSyncAt: number | null;
  nativeDetail: string | null;
  nodeName: string | null;
  cpuThreads: number;
  memoryMb: number;
  scratchMb: number;
  priority: string;
  jobFamily: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Typed user record. */
export interface UserRecord {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
}

/** Typed project record. */
export interface ProjectRecord {
  id: string;
  name: string;
  description: string | null;
  status: string;
  maxConcurrentJobs: number;
  createdAt: number;
  updatedAt: number;
}

/** Typed node record. */
export interface NodeRecord {
  id: string;
  name: string;
  host: string;
  user: string;
  runner: string;
  status: string;
  tagsJson: string;
  maxJobs: number;
  engines: string;
  cpuThreadsTotal: number;
  memoryMbTotal: number;
  scratchMbTotal: number;
  draining: boolean;
  thermalState: string;
  lastSeenAt: number | null;
  isHead: boolean;
  powerMode: string;
  macAddress: string | null;
  broadcastAddress: string | null;
  wolPort: number | null;
  allowWake: boolean;
  allowPowerDown: boolean;
  idlePowerDownAfterSec: number | null;
  lastWakeAt: number | null;
  lastPowerDownAt: number | null;
  port: number;
  privateKeyPath: string | null;
  remoteScratchDir: string;
  createdAt: number;
  updatedAt: number;
}

/** Provider-neutral mutable node fields used by registration and power control. */
export interface NodeUpdateInput {
  name?: string;
  host?: string;
  user?: string;
  port?: number;
  runner?: string;
  status?: string;
  tags?: string[];
  maxJobs?: number;
  engines?: string[];
  cpuThreadsTotal?: number;
  memoryMbTotal?: number;
  scratchMbTotal?: number;
  draining?: boolean;
  thermalState?: string;
  lastSeenAt?: number | null;
  isHead?: boolean;
  powerMode?: string;
  macAddress?: string | null;
  broadcastAddress?: string | null;
  wolPort?: number | null;
  allowWake?: boolean;
  allowPowerDown?: boolean;
  idlePowerDownAfterSec?: number | null;
  lastWakeAt?: number | null;
  lastPowerDownAt?: number | null;
  privateKeyPath?: string | null;
  remoteScratchDir?: string;
}

/** Typed membership record. */
export interface MembershipRecord {
  id: string;
  projectId: string;
  userId: string;
  role: string;
  createdAt: number;
  updatedAt: number;
}

/** Typed quota record. */
export interface QuotaRecord {
  id: string;
  projectId: string;
  maxCpuThreads: number;
  maxMemoryMb: number;
  maxScratchMb: number;
  maxJobsTotal: number;
  createdAt: number;
  updatedAt: number;
}

/** Typed usage record. */
export interface UsageRecord {
  id: string;
  projectId: string;
  userId: string;
  jobId: string;
  cpuThreads: number;
  memoryMb: number;
  scratchMb: number;
  walltimeMs: number | null;
  recordedAt: number;
}

/** Typed permission record. */
export interface PermissionRecord {
  id: string;
  action: string;
  resource: string;
  effect: PermissionEffect;
  projectId?: string;
  label?: string;
}

/** Typed stored result record — canonical identity per job+attempt+parser. */
export interface StoredResultRecord {
  id: string;
  jobId: string;
  attemptId: string;
  parser: string;
  status: "completed" | "failed" | "partial" | "unknown";
  energyHartree: number | null;
  scfConverged: boolean | null;
  imaginaryFrequencies: number | null;
  normalTermination: boolean | null;
  warnings: string[];
  errors: string[];
  raw: Record<string, unknown> | null;
  createdAt: number;
}

/** Typed event record from job_events table. */
export interface EventRecord {
  id: number;
  jobId: string;
  type: string;
  eventId: string | null;
  source: string;
  attemptId: string | null;
  artifactId: string | null;
  resultId: string | null;
  sequence: number | null;
  schemaVersion: number;
  payloadJson: string | null;
  createdAt: number;
}

// ── Log line type ─────────────────────────────────────────────

export interface LogLine {
  stream: string;
  line: string;
  createdAt: number;
}

// ── Event filters ─────────────────────────────────────────────

export interface ListEventsFilter {
  jobId?: string;
  type?: EigenGridEventType;
  limit?: number;
}

// ── Timeline row ──────────────────────────────────────────────

export interface TimelineRow {
  at: string;
  type: string;
  details: string;
}

// ── Proposal types ────────────────────────────────────────────

export type ProposalStatus = "pending" | "approved" | "rejected" | "executed";

export interface ProposalRow {
  id: string;
  jobId: string;
  action: string;
  reason: string;
  proposedChanges: string;
  status: ProposalStatus;
  diagnosisJson: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateProposalInput {
  jobId: string;
  action: string;
  reason: string;
  proposedChanges: string;
  diagnosis?: Record<string, unknown>;
}

// ── Result input ──────────────────────────────────────────────

export interface SaveResultInput {
  jobId: string;
  attemptId: string;
  parser: string;
  status: "completed" | "failed" | "partial" | "unknown";
  energyHartree?: number;
  scfConverged?: boolean;
  imaginaryFrequencies?: number;
  normalTermination?: boolean;
  warnings?: string[];
  errors?: string[];
  raw?: Record<string, unknown>;
}

// ── Transaction interface ─────────────────────────────────────

/**
 * Provider-neutral transaction handle.
 * Both adapters implement transactional wrappers via this interface.
 */
export interface DbTransaction {
  /** Commit the transaction. */
  commit(): Promise<void>;
  /** Roll back the transaction. */
  rollback(): Promise<void>;
  /** Execute a raw query within the transaction. */
  query(sql: string, params?: Record<string, unknown> | unknown[]): Promise<unknown>;
  /**
   * Return provider-neutral rows from a statement. Optional so existing
   * DatabaseLike fakes remain source compatible.
   */
  queryRows?<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: Record<string, unknown> | unknown[],
  ): Promise<T[]>;
}

// ── Scheduler Claim Result ─────────────────────────────────────

/**
 * Result of an atomic scheduler dispatch claim.
 * On claimed=true: attempt was created atomically, ownership established.
 * On claimed=false: the job could not be claimed (race, invalid state, etc.)
 */
export type ClaimDispatchResult =
  | { claimed: true; jobId: string; attemptId: string; nodeId: string }
  | { claimed: false; reason: string; message: string };

/**
 * Authoritative terminal state and evidence for one job attempt.
 * Adapters persist the state transitions and terminal process event in one
 * transaction, and make repeated calls for the same outcome a no-op.
 */
export interface TerminalAttemptEvidence {
  jobId: string;
  attemptId: string;
  status: "completed" | "failed" | "cancelled";
  exitCode?: number;
  finishedAt: number;
  source: EigenGridEventBase["source"];
  payload?: Record<string, unknown>;
}

// ── Main Database Interface ───────────────────────────────────

/**
 * DatabaseLike interface — the central contract for both adapters.
 *
 * Migration path: new typed records (JobRecord, UserRecord, etc.) are
 * available as types but the interface retains Record<string, unknown>
 * for backward compatibility. Consumers can use the helper mappers
 * from "./rows" to get typed results.
 */
export interface DatabaseLike {
  /** Provider identifier for runtime dispatch: "sqlite" | "postgres" */
  readonly _provider: string;
  // ── Lifecycle ───────────────────────────────────────────
  init(): Promise<void>;
  close(): Promise<void>;

  // ── Migration ──────────────────────────────────────────
  runMigrations(): Promise<void>;
  getMigrationVersion(): Promise<number>;

  // ── Transaction support ────────────────────────────────
  beginTransaction(): Promise<DbTransaction>;

  // ── Jobs ───────────────────────────────────────────────
  createJob(job: {
    id: string;
    name: string;
    software: string;
    inputPath: string;
    workdir: string;
    outputPath?: string;
    ownerUserId?: string;
    projectId?: string;
    backend?: string;
  }): Promise<void>;
  updateJobStatus(jobId: string, status: string): Promise<void>;
  updateJobExternalMetadata(
    jobId: string,
    metadata: {
      backend?: string;
      externalJobId?: string;
      externalState?: string;
      lastSyncAt?: number;
      nativeDetail?: string;
      nodeName?: string;
    },
  ): Promise<void>;
  getJob(jobId: string): Promise<JobRecord | null>;
  resolveJobId(prefix: string): Promise<string>;
  listJobs(): Promise<JobRecord[]>;

  // ── Attempts ───────────────────────────────────────────
  createJobAttempt(attempt: {
    id: string;
    jobId: string;
    runner: RunnerKind;
    command: string;
    cwd: string;
    status?: JobAttemptStatus;
    pid?: number;
    exitCode?: number;
    startedAt?: number;
    finishedAt?: number;
  }): Promise<void>;
  updateJobAttemptStatus(
    attemptId: string,
    status: JobAttemptStatus,
    updates?: {
      pid?: number;
      startedAt?: number;
      exitCode?: number;
      finishedAt?: number;
    },
  ): Promise<void>;
  listJobAttempts(jobId?: string): Promise<JobAttempt[]>;

  // ── Artifacts ──────────────────────────────────────────
  createArtifact(artifact: Omit<Artifact, "createdAt">): Promise<void>;
  /** Atomically register an artifact by job/attempt/kind/path identity. */
  createArtifactIfAbsent(artifact: Omit<Artifact, "createdAt">): Promise<boolean>;
  listArtifacts(jobId?: string): Promise<Artifact[]>;

  // ── Terminal attempt evidence ────────────────────────────
  materializeTerminalAttempt(evidence: TerminalAttemptEvidence): Promise<void>;

  // ── Logs ───────────────────────────────────────────────
  getLogs(jobId: string, stream?: string, tail?: number): Promise<LogLine[]>;

  // ── Events ─────────────────────────────────────────────
  /** @deprecated Use appendEvent instead — richer schema with event_id, source, attempt_id, etc. */
  insertEvent(event: EigenGridEvent): Promise<void>;
  appendEvent(event: EigenGridEventBase): Promise<void>;
  getEvents(jobId?: string): Promise<EventRecord[]>;
  listEvents(filters?: ListEventsFilter): Promise<EventRecord[]>;
  listJobEvents(jobId: string): Promise<EventRecord[]>;
  listAttemptEvents(attemptId: string): Promise<EventRecord[]>;
  getTimeline(jobId: string): Promise<TimelineRow[]>;

  // ── Results ────────────────────────────────────────────
  saveResult(input: SaveResultInput): Promise<string>;
  listResults(jobId?: string, attemptId?: string): Promise<StoredResultRecord[]>;
  getLatestResult(jobId: string, attemptId: string): Promise<StoredResultRecord | null>;

  // ── Proposals ──────────────────────────────────────────
  createProposal(input: CreateProposalInput): Promise<string>;
  getProposal(proposalId: string): Promise<ProposalRow | null>;
  listProposals(filters?: { jobId?: string; status?: ProposalStatus }): Promise<ProposalRow[]>;
  updateProposalStatus(proposalId: string, status: ProposalStatus): Promise<void>;

  // ── Permissions ────────────────────────────────────────
  listPermissions(projectId?: string): Promise<PermissionRecord[]>;
  createPermission(permission: {
    id: string;
    action: string;
    resource?: string;
    effect: PermissionEffect;
    projectId?: string;
    label?: string;
  }): Promise<void>;
  removePermission(id: string): Promise<void>;

  // ── Users ────────────────────────────────
  createUser(user: {
    id: string;
    username: string;
    displayName?: string;
    email?: string;
  }): Promise<void>;
  getUser(userId: string): Promise<UserRecord | null>;
  getUserByUsername(username: string): Promise<UserRecord | null>;
  listUsers(): Promise<UserRecord[]>;
  disableUser(userId: string): Promise<void>;
  enableUser(userId: string): Promise<void>;

  // ── Projects ─────────────────────────────
  createProject(project: {
    id: string;
    name: string;
    description?: string;
    maxConcurrentJobs?: number;
  }): Promise<void>;
  getProject(projectId: string): Promise<ProjectRecord | null>;
  getProjectByName(name: string): Promise<ProjectRecord | null>;
  listProjects(): Promise<ProjectRecord[]>;
  archiveProject(projectId: string): Promise<void>;
  resolveProjectId(prefix: string): Promise<string>;

  // ── Project Memberships ──────────────────
  addProjectMember(projectId: string, userId: string, role?: string): Promise<void>;
  removeProjectMember(projectId: string, userId: string): Promise<void>;
  listProjectMembers(projectId: string): Promise<MembershipRecord[]>;
  listUserProjects(userId: string): Promise<ProjectRecord[]>;

  // ── Quotas ───────────────────────────────
  getProjectQuota(projectId: string): Promise<QuotaRecord | null>;
  setProjectQuota(
    projectId: string,
    quota: {
      maxCpuThreads?: number;
      maxMemoryMb?: number;
      maxScratchMb?: number;
      maxJobsTotal?: number;
    },
  ): Promise<void>;

  // ── Usage Accounting ─────────────────────
  recordUsage(usage: {
    id: string;
    projectId: string;
    userId: string;
    jobId: string;
    cpuThreads?: number;
    memoryMb?: number;
    scratchMb?: number;
    walltimeMs?: number;
  }): Promise<void>;
  getProjectUsage(projectId: string): Promise<UsageRecord[]>;
  getUserUsage(userId: string): Promise<UsageRecord[]>;
  getProjectAggregatedUsage(projectId: string): Promise<{
    totalCpuThreads: number;
    totalMemoryMb: number;
    totalScratchMb: number;
    totalWalltimeMs: number;
    jobCount: number;
  }>;

  // ── Privilege Checks ─────────────────────
  isUserDisabled(userId: string): Promise<boolean>;

  // ── Scheduler Dispatch ────────────────────────────────
  /**
   * Atomically claim a queued job for dispatch on a specific node.
   * In one transaction: verifies job exists and is queued,
   * has no nonterminal attempt, target node exists, is enabled, and is not draining,
   * creates the attempt record, assigns node_id on job,
   * emits attempt.created event.
   * Returns a typed ClaimDispatchResult.
   */
  claimJobForDispatch(
    jobId: string,
    nodeId: string,
    attemptId: string,
    runner: import("@eigengrid/core").RunnerKind,
    command: string,
    cwd: string,
  ): Promise<ClaimDispatchResult>;

  /**
   * Release a previously claimed dispatch that failed after claim.
   * Clears node_id from job, marks the attempt as failed with error message.
   * Must leave truthful failed state; does not emit process.started.
   * No-op if job/attempt don't exist or status doesn't match expected.
   */
  releaseJobDispatch(jobId: string, attemptId: string, errorMessage: string): Promise<void>;

  // ── Nodes ──────────────────────────────────────────────
  createNode(node: {
    id: string;
    name: string;
    host: string;
    user: string;
    runner: string;
    port?: number;
    maxJobs?: number;
    tags?: string[];
    privateKeyPath?: string;
    remoteScratchDir?: string;
  }): Promise<void>;
  getNode(nodeId: string): Promise<NodeRecord | null>;
  listNodes(): Promise<NodeRecord[]>;
  /** Update a whitelisted set of node fields without exposing provider SQL. */
  updateNode?(nodeId: string, updates: NodeUpdateInput): Promise<void>;
  removeNode(nodeId: string): Promise<void>;
  resolveNodeId(prefix: string): Promise<string>;
  getNodeByName(name: string): Promise<NodeRecord | null>;
}
