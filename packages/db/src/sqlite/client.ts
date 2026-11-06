import type { PermissionEffect } from "@eigengrid/core";
import {
  type Artifact,
  type JobAttempt,
  type JobAttemptStatus,
  type RunnerKind,
} from "@eigengrid/core";
import type { EigenGridEvent, EigenGridEventBase } from "@eigengrid/events";
import type {
  CreateProposalInput,
  DatabaseLike,
  DbTransaction as DbTransactionInterface,
  EventRecord,
  JobRecord,
  ListEventsFilter,
  LogLine,
  MembershipRecord,
  NodeRecord,
  NodeUpdateInput,
  PermissionRecord,
  ProjectRecord,
  ProposalRow,
  ProposalStatus,
  QuotaRecord,
  SaveResultInput,
  StoredResultRecord,
  TerminalAttemptEvidence,
  TimelineRow,
  UsageRecord,
  UserRecord,
} from "../client";
import * as access from "./access";
import * as artifacts from "./artifacts";
import * as attempts from "./attempts";
import * as budgets from "./budgets";
import { SqliteContext } from "./context";
import * as dispatch from "./dispatch";
import * as events from "./events";
import * as jobs from "./jobs";
import * as migrations from "./migration-runner";
import * as nodes from "./nodes";
import * as projects from "./projects";
import type { SqliteConnection } from "./transaction";

/** Stable database facade; each domain function owns its full transaction. */
export class SqliteDatabase implements DatabaseLike {
  readonly _provider = "sqlite";
  private readonly context: SqliteContext;
  constructor(dbPath: string) {
    this.context = new SqliteContext(dbPath);
  }
  // Preserve the connection seam used by legacy migration fixtures.
  private get db(): SqliteConnection | null {
    return this.context.db;
  }
  private set db(connection: SqliteConnection | null) {
    this.context.db = connection;
  }
  // Existing query and backup adapters use this internal connection seam.
  private ensureDb() {
    return this.context.ensureDb();
  }
  async init(): Promise<void> {
    return this.context.init();
  }

  async beginTransaction(): Promise<DbTransactionInterface> {
    return this.context.beginTransaction();
  }

  async createJob(job: {
    id: string;
    name: string;
    software: string;
    inputPath: string;
    workdir: string;
    outputPath?: string;
    ownerUserId?: string;
    projectId?: string;
    backend?: string;
  }): Promise<void> {
    return jobs.createJob(this.context, job);
  }

  async createJobAttempt(attempt: {
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
  }): Promise<void> {
    return attempts.createJobAttempt(this.context, attempt);
  }

  async updateJobAttemptStatus(
    attemptId: string,
    status: JobAttemptStatus,
    updates?: {
      pid?: number;
      startedAt?: number;
      exitCode?: number;
      finishedAt?: number;
    },
  ): Promise<void> {
    return attempts.updateJobAttemptStatus(this.context, attemptId, status, updates);
  }

  async listJobAttempts(jobId?: string): Promise<JobAttempt[]> {
    return attempts.listJobAttempts(this.context, jobId);
  }

  async createArtifact(artifact: Omit<Artifact, "createdAt">): Promise<void> {
    return artifacts.createArtifact(this.context, artifact);
  }

  async createArtifactIfAbsent(artifact: Omit<Artifact, "createdAt">): Promise<boolean> {
    return artifacts.createArtifactIfAbsent(this.context, artifact);
  }

  async listArtifacts(jobId?: string): Promise<Artifact[]> {
    return artifacts.listArtifacts(this.context, jobId);
  }

  async materializeTerminalAttempt(evidence: TerminalAttemptEvidence): Promise<void> {
    return attempts.materializeTerminalAttempt(this.context, evidence);
  }

  async updateJobStatus(jobId: string, status: string): Promise<void> {
    return jobs.updateJobStatus(this.context, jobId, status);
  }

  async updateJobExternalMetadata(
    jobId: string,
    metadata: {
      backend?: string;
      externalJobId?: string;
      externalState?: string;
      lastSyncAt?: number;
      nativeDetail?: string;
      nodeName?: string;
    },
  ): Promise<void> {
    return jobs.updateJobExternalMetadata(this.context, jobId, metadata);
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    return jobs.getJob(this.context, jobId);
  }

  async resolveJobId(prefix: string): Promise<string> {
    return jobs.resolveJobId(this.context, prefix);
  }

  async listJobs(): Promise<JobRecord[]> {
    return jobs.listJobs(this.context);
  }

  async appendEvent(event: EigenGridEventBase): Promise<void> {
    const { appendEvent: queryAppendEvent } = await import("../queries/events");
    await queryAppendEvent(this, event);
  }

  /** @deprecated Use appendEvent instead */
  async insertEvent(event: EigenGridEvent): Promise<void> {
    return events.insertEvent(this.context, event);
  }

  async getLogs(jobId: string, stream?: string, tail?: number): Promise<LogLine[]> {
    return events.getLogs(this.context, jobId, stream, tail);
  }

  async getEvents(jobId?: string): Promise<EventRecord[]> {
    return events.getEvents(this.context, jobId);
  }

  async listPermissions(projectId?: string): Promise<PermissionRecord[]> {
    return access.listPermissions(this.context, projectId);
  }

  async createUser(user: {
    id: string;
    username: string;
    displayName?: string;
    email?: string;
  }): Promise<void> {
    return access.createUser(this.context, user);
  }

  async getUser(userId: string): Promise<UserRecord | null> {
    return access.getUser(this.context, userId);
  }

  async getUserByUsername(username: string): Promise<UserRecord | null> {
    return access.getUserByUsername(this.context, username);
  }

  async listUsers(): Promise<UserRecord[]> {
    return access.listUsers(this.context);
  }

  async disableUser(userId: string): Promise<void> {
    return access.disableUser(this.context, userId);
  }

  async enableUser(userId: string): Promise<void> {
    return access.enableUser(this.context, userId);
  }

  async createProject(project: {
    id: string;
    name: string;
    description?: string;
    maxConcurrentJobs?: number;
  }): Promise<void> {
    return projects.createProject(this.context, project);
  }

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    return projects.getProject(this.context, projectId);
  }

  async getProjectByName(name: string): Promise<ProjectRecord | null> {
    return projects.getProjectByName(this.context, name);
  }

  async listProjects(): Promise<ProjectRecord[]> {
    return projects.listProjects(this.context);
  }

  async archiveProject(projectId: string): Promise<void> {
    return projects.archiveProject(this.context, projectId);
  }

  async resolveProjectId(prefix: string): Promise<string> {
    return projects.resolveProjectId(this.context, prefix);
  }

  async addProjectMember(projectId: string, userId: string, role?: string): Promise<void> {
    return projects.addProjectMember(this.context, projectId, userId, role);
  }

  async removeProjectMember(projectId: string, userId: string): Promise<void> {
    return projects.removeProjectMember(this.context, projectId, userId);
  }

  async listProjectMembers(projectId: string): Promise<MembershipRecord[]> {
    return projects.listProjectMembers(this.context, projectId);
  }

  async listUserProjects(userId: string): Promise<ProjectRecord[]> {
    return projects.listUserProjects(this.context, userId);
  }

  async getProjectQuota(projectId: string): Promise<QuotaRecord | null> {
    return budgets.getProjectQuota(this.context, projectId);
  }

  async setProjectQuota(
    projectId: string,
    quota: {
      maxCpuThreads?: number;
      maxMemoryMb?: number;
      maxScratchMb?: number;
      maxJobsTotal?: number;
    },
  ): Promise<void> {
    return budgets.setProjectQuota(this.context, projectId, quota);
  }

  async recordUsage(usage: {
    id: string;
    projectId: string;
    userId: string;
    jobId: string;
    cpuThreads?: number;
    memoryMb?: number;
    scratchMb?: number;
    walltimeMs?: number;
  }): Promise<void> {
    return budgets.recordUsage(this.context, usage);
  }

  async getProjectUsage(projectId: string): Promise<UsageRecord[]> {
    return budgets.getProjectUsage(this.context, projectId);
  }

  async getUserUsage(userId: string): Promise<UsageRecord[]> {
    return budgets.getUserUsage(this.context, userId);
  }

  async getProjectAggregatedUsage(projectId: string): Promise<{
    totalCpuThreads: number;
    totalMemoryMb: number;
    totalScratchMb: number;
    totalWalltimeMs: number;
    jobCount: number;
  }> {
    return budgets.getProjectAggregatedUsage(this.context, projectId);
  }

  async isUserDisabled(userId: string): Promise<boolean> {
    return access.isUserDisabled(this.context, userId);
  }

  async createPermission(permission: {
    id: string;
    action: string;
    resource?: string;
    effect: PermissionEffect;
    projectId?: string;
    label?: string;
  }): Promise<void> {
    return access.createPermission(this.context, permission);
  }

  async removePermission(id: string): Promise<void> {
    return access.removePermission(this.context, id);
  }

  async createNode(node: {
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
  }): Promise<void> {
    return nodes.createNode(this.context, node);
  }

  async getNode(nodeId: string): Promise<NodeRecord | null> {
    return nodes.getNode(this.context, nodeId);
  }

  async listNodes(): Promise<NodeRecord[]> {
    return nodes.listNodes(this.context);
  }

  async updateNode(nodeId: string, updates: NodeUpdateInput): Promise<void> {
    return nodes.updateNode(this.context, nodeId, updates);
  }

  async removeNode(nodeId: string): Promise<void> {
    return nodes.removeNode(this.context, nodeId);
  }

  async resolveNodeId(prefix: string): Promise<string> {
    return nodes.resolveNodeId(this.context, prefix);
  }

  async getNodeByName(name: string): Promise<NodeRecord | null> {
    return nodes.getNodeByName(this.context, name);
  }

  async claimJobForDispatch(
    jobId: string,
    nodeId: string,
    attemptId: string,
    runner: RunnerKind,
    command: string,
    cwd: string,
  ): Promise<import("../client").ClaimDispatchResult> {
    return dispatch.claimJobForDispatch(
      this.context,
      jobId,
      nodeId,
      attemptId,
      runner,
      command,
      cwd,
    );
  }

  async releaseJobDispatch(jobId: string, attemptId: string, errorMessage: string): Promise<void> {
    return dispatch.releaseJobDispatch(this.context, jobId, attemptId, errorMessage);
  }

  async close(): Promise<void> {
    return this.context.close();
  }

  async runMigrations(): Promise<void> {
    return migrations.runMigrations(this.context);
  }

  async getMigrationVersion(): Promise<number> {
    return migrations.getMigrationVersion(this.context);
  }

  async listEvents(filters?: ListEventsFilter): Promise<EventRecord[]> {
    const { listEvents: queryListEvents } = await import("../queries/events");
    return queryListEvents(this, filters);
  }

  async listJobEvents(jobId: string): Promise<EventRecord[]> {
    const { listJobEvents: queryListJobEvents } = await import("../queries/events");
    return queryListJobEvents(this, jobId);
  }

  async listAttemptEvents(attemptId: string): Promise<EventRecord[]> {
    const { listAttemptEvents: queryListAttemptEvents } = await import("../queries/events");
    return queryListAttemptEvents(this, attemptId);
  }

  async getTimeline(jobId: string): Promise<TimelineRow[]> {
    const { getTimeline: queryGetTimeline } = await import("../queries/events");
    return queryGetTimeline(this, jobId);
  }

  async saveResult(input: SaveResultInput): Promise<string> {
    const { saveResult: querySaveResult } = await import("../queries/results");
    return querySaveResult(this, input);
  }

  async listResults(jobId?: string, attemptId?: string): Promise<StoredResultRecord[]> {
    const { listResults: queryListResults } = await import("../queries/results");
    return queryListResults(this, jobId, attemptId);
  }

  async getLatestResult(jobId: string, attemptId: string): Promise<StoredResultRecord | null> {
    const { getLatestResult: queryGetLatestResult } = await import("../queries/results");
    return queryGetLatestResult(this, jobId, attemptId);
  }

  async createProposal(input: CreateProposalInput): Promise<string> {
    const { createProposal: queryCreateProposal } = await import("../queries/proposals");
    return queryCreateProposal(this, input);
  }

  async getProposal(proposalId: string): Promise<ProposalRow | null> {
    const { getProposal: queryGetProposal } = await import("../queries/proposals");
    return queryGetProposal(this, proposalId);
  }

  async listProposals(filters?: {
    jobId?: string;
    status?: ProposalStatus;
  }): Promise<ProposalRow[]> {
    const { listProposals: queryListProposals } = await import("../queries/proposals");
    return queryListProposals(this, filters);
  }

  async updateProposalStatus(proposalId: string, status: ProposalStatus): Promise<void> {
    const { updateProposalStatus: queryUpdateProposalStatus } =
      await import("../queries/proposals");
    return queryUpdateProposalStatus(this, proposalId, status);
  }
}
export function createDatabase(dbPath: string): SqliteDatabase {
  return new SqliteDatabase(dbPath);
}
