import {
  type Artifact,
  type JobAttempt,
  type JobAttemptStatus,
  type PermissionEffect,
  type RunnerKind,
} from "@eigengrid/core";
import type { EigenGridEvent, EigenGridEventBase } from "@eigengrid/events";
import type {
  CreateProposalInput,
  DatabaseLike,
  DbTransaction,
  EventRecord,
  JobRecord,
  ListEventsFilter,
  LogLine,
  MembershipRecord,
  NodeRecord,
  NodeUpdateInput,
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
import { PostgresContext } from "./context";
import * as dispatch from "./dispatch";
import * as events from "./events";
import * as jobs from "./jobs";
import * as migrations from "./migration-runner";
import * as nodes from "./nodes";
import type { PostgresDatabaseOptions } from "./options";
import * as projects from "./projects";
import * as proposals from "./proposals";
import * as results from "./results";
/** Stable database facade; each domain function owns its full transaction. */
export class PostgresDatabase implements DatabaseLike {
  readonly _provider = "postgres";
  private readonly context: PostgresContext;
  constructor(dbUrl: string, options: PostgresDatabaseOptions = {}) {
    this.context = new PostgresContext(dbUrl, options);
  }
  // Preserve the SQL seam used by PostgreSQL fault-injection fixtures.
  private query(text: string, params?: unknown[]) {
    return this.context.query(text, params);
  }
  async init(): Promise<void> {
    return this.context.init();
  }

  async close(): Promise<void> {
    return this.context.close();
  }

  async beginTransaction(): Promise<DbTransaction> {
    return this.context.beginTransaction();
  }

  /** Read-only startup validation. Never bootstraps, adopts or repairs history. */
  async validateMigrations(): Promise<void> {
    return migrations.validateMigrations(this.context);
  }

  async runMigrations(): Promise<void> {
    return migrations.runMigrations(this.context);
  }

  async getMigrationVersion(): Promise<number> {
    return migrations.getMigrationVersion(this.context);
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

  async getLogs(jobId: string, stream?: string, tail?: number): Promise<LogLine[]> {
    return events.getLogs(this.context, jobId, stream, tail);
  }

  async insertEvent(event: EigenGridEvent): Promise<void> {
    return events.insertEvent(this.context, event);
  }

  async appendEvent(event: EigenGridEventBase): Promise<void> {
    return events.appendEvent(this.context, event);
  }

  async getEvents(jobId?: string): Promise<EventRecord[]> {
    return events.getEvents(this.context, jobId);
  }

  async listEvents(filters?: ListEventsFilter): Promise<EventRecord[]> {
    return events.listEvents(this.context, filters);
  }

  async listJobEvents(jobId: string): Promise<EventRecord[]> {
    return events.listJobEvents(this.context, jobId);
  }

  async listAttemptEvents(attemptId: string): Promise<EventRecord[]> {
    return events.listAttemptEvents(this.context, attemptId);
  }

  async getTimeline(jobId: string): Promise<TimelineRow[]> {
    return events.getTimeline(this.context, jobId);
  }

  async saveResult(input: SaveResultInput): Promise<string> {
    return results.saveResult(this.context, input);
  }

  async listResults(jobId?: string, attemptId?: string): Promise<StoredResultRecord[]> {
    return results.listResults(this.context, jobId, attemptId);
  }

  async getLatestResult(jobId: string, attemptId: string): Promise<StoredResultRecord | null> {
    return results.getLatestResult(this.context, jobId, attemptId);
  }

  async createProposal(input: CreateProposalInput): Promise<string> {
    return proposals.createProposal(this.context, input);
  }

  async getProposal(proposalId: string): Promise<ProposalRow | null> {
    return proposals.getProposal(this.context, proposalId);
  }

  async listProposals(filters?: {
    jobId?: string;
    status?: ProposalStatus;
  }): Promise<ProposalRow[]> {
    return proposals.listProposals(this.context, filters);
  }

  async updateProposalStatus(proposalId: string, status: ProposalStatus): Promise<void> {
    return proposals.updateProposalStatus(this.context, proposalId, status);
  }

  async listPermissions(projectId?: string): Promise<
    Array<{
      id: string;
      action: string;
      resource: string;
      effect: PermissionEffect;
      projectId?: string;
      label?: string;
    }>
  > {
    return access.listPermissions(this.context, projectId);
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
    runner: import("@eigengrid/core").RunnerKind,
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
}
export type { PostgresDatabaseOptions } from "./options";
export { PostgresTransaction } from "./transaction";
