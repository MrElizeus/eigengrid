export { SqliteDatabase, createDatabase, MIGRATIONS } from "./migrate";
export { splitSqlStatements } from "./migration-utils";
export { PostgresDatabase, PostgresTransaction } from "./postgres/client";
export type { PostgresDatabaseOptions } from "./postgres/client";
export { POSTGRES_MIGRATIONS, postgresMigrationChecksum } from "./postgres/migrations";
export * from "./operation-outbox-migration";
export * from "./effect-delivery-migration";
export * from "./md-preparation-migration";
export {
  SCIENTIFIC_MIGRATION_NAME,
  SCIENTIFIC_MIGRATION_VERSION,
  SCIENTIFIC_SQLITE_MIGRATION,
  SCIENTIFIC_POSTGRES_MIGRATION,
} from "./scientific-migrations";
export {
  MD_MIGRATION_NAME,
  MD_MIGRATION_VERSION,
  MD_INTEGRITY_MIGRATION_NAME,
  MD_INTEGRITY_MIGRATION_VERSION,
  MD_INTEGRITY_SQLITE_MIGRATION,
  MD_INTEGRITY_POSTGRES_MIGRATION,
  MD_EFFECT_AUTHORITY_MIGRATION_NAME,
  MD_EFFECT_AUTHORITY_MIGRATION_VERSION,
  MD_EFFECT_AUTHORITY_SQLITE_MIGRATION,
  MD_EFFECT_AUTHORITY_POSTGRES_MIGRATION,
  MD_MATERIAL_IDENTITY_MIGRATION_NAME,
  MD_MATERIAL_IDENTITY_MIGRATION_VERSION,
  MD_MATERIAL_IDENTITY_SQLITE_MIGRATION,
  MD_MATERIAL_IDENTITY_POSTGRES_MIGRATION,
  MD_MODEL_AUTHORITY_MIGRATION_NAME,
  MD_MODEL_AUTHORITY_MIGRATION_VERSION,
  MD_MODEL_AUTHORITY_SQLITE_MIGRATION,
  MD_MODEL_AUTHORITY_POSTGRES_MIGRATION,
  MD_SQLITE_MIGRATION,
  MD_POSTGRES_MIGRATION,
  MD_SQLITE_MIGRATIONS,
  MD_POSTGRES_MIGRATIONS,
} from "./md-migrations";
export {
  createDatabaseFromConfig,
  resolveDbConfig,
  redactDatabaseUrl,
  checkPostgresConnection,
  DatabaseConnectionError,
} from "./provider";
export type { DbConfig } from "./provider";

export {
  DbError,
  DbErrorCode,
  DbRowValidationError,
  DbNotFoundError,
  DbQueryError,
  DbInvalidTransitionError,
  DbAmbiguousPrefixError,
} from "./errors";
export type { DbErrorCode as DbErrorCodeType } from "./errors";

export {
  readString,
  readOptionalString,
  readNumber,
  readOptionalNumber,
  readBoolean,
  readOptionalBoolean,
  readJsonArray,
  readJsonObject,
  tryParseJson,
  tryParseJsonArray,
  mapJobAttemptRow,
  mapArtifactRow,
  mapResultRow,
  mapProposalRow,
  mapStoredResultRow,
  mapJobRow,
  mapUserRow,
  mapProjectRow,
  mapNodeRow,
  mapMembershipRow,
  mapQuotaRow,
  mapUsageRow,
  mapPermissionRow,
  isJobAttemptStatus,
  JOB_ATTEMPT_STATUSES,
  VALID_ATTEMPT_TRANSITIONS,
  isValidAttemptTransition,
  VALID_PROPOSAL_TRANSITIONS,
  isValidProposalTransition,
} from "./rows";

export { createJob, getJob, resolveJobId, listJobs, updateJobStatus } from "./queries/jobs";
export {
  createNode,
  getNode,
  listNodes,
  removeNode,
  resolveNodeId,
  getNodeByName,
} from "./queries/nodes";
export { getLogs } from "./queries/logs";
export { saveResult, listResults, getLatestResult } from "./queries/results";
export {
  appendEvent,
  listEvents,
  listJobEvents,
  listAttemptEvents,
  getTimeline,
} from "./queries/events";
export { listPermissions, createPermission, removePermission } from "./queries/permissions";
export {
  createUser,
  getUser,
  getUserByUsername,
  listUsers,
  disableUser,
  enableUser,
} from "./queries/users";
export {
  createProject,
  getProject,
  getProjectByName,
  listProjects,
  archiveProject,
  resolveProjectId,
} from "./queries/projects";
export {
  addProjectMember,
  removeProjectMember,
  listProjectMembers,
  listUserProjects,
} from "./queries/memberships";
export { getProjectQuota, setProjectQuota } from "./queries/quotas";
export {
  recordUsage,
  getProjectUsage,
  getUserUsage,
  getProjectAggregatedUsage,
} from "./queries/usage";
export {
  createProposal,
  getProposal,
  listProposals,
  updateProposalStatus,
} from "./queries/proposals";
export type { ProposalRow, ProposalStatus, CreateProposalInput } from "./queries/proposals";
export type {
  DatabaseLike,
  LogLine,
  ListEventsFilter,
  TimelineRow,
  SaveResultInput,
  DbTransaction,
  JobRecord,
  UserRecord,
  ProjectRecord,
  NodeRecord,
  NodeUpdateInput,
  MembershipRecord,
  QuotaRecord,
  UsageRecord,
  PermissionRecord,
  EventRecord,
  StoredResultRecord,
  ClaimDispatchResult,
  TerminalAttemptEvidence,
} from "./client";
