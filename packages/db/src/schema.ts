import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  software: text("software").notNull(),
  inputPath: text("input_path").notNull(),
  workdir: text("workdir").notNull(),
  outputPath: text("output_path"),
  nodeId: text("node_id"),
  status: text("status").notNull().default("created"),
  // ── External backend metadata ───────────────
  ownerUserId: text("owner_user_id"),
  projectId: text("project_id"),
  backend: text("backend"),
  externalJobId: text("external_job_id"),
  externalState: text("external_state"),
  lastSyncAt: integer("last_sync_at"),
  nativeDetail: text("native_detail"),
  nodeName: text("node_name"),
  // ── Resource fields ──────────────────────────
  cpuThreads: integer("cpu_threads").notNull().default(1),
  memoryMb: integer("memory_mb").notNull().default(1024),
  scratchMb: integer("scratch_mb").notNull().default(1024),
  priority: text("priority").notNull().default("normal"),
  jobFamily: text("job_family"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const jobAttempts = sqliteTable("job_attempts", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  runner: text("runner").notNull(),
  status: text("status").notNull().default("created"),
  command: text("command").notNull(),
  cwd: text("cwd").notNull(),
  pid: integer("pid"),
  exitCode: integer("exit_code"),
  startedAt: integer("started_at"),
  finishedAt: integer("finished_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  attemptId: text("attempt_id").notNull(),
  kind: text("kind").notNull(),
  path: text("path").notNull(),
  label: text("label"),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes"),
  createdAt: integer("created_at").notNull(),
});

export const nodes = sqliteTable("nodes", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  host: text("host").notNull(),
  user: text("user").notNull(),
  runner: text("runner").notNull(),
  status: text("status").notNull().default("unknown"),
  tagsJson: text("tags_json").notNull().default("[]"),
  maxJobs: integer("max_jobs").notNull().default(1),
  // ── Capacity fields ─────────────────────────
  engines: text("engines").notNull().default("[]"),
  cpuThreadsTotal: integer("cpu_threads_total").notNull().default(1),
  memoryMbTotal: integer("memory_mb_total").notNull().default(1024),
  scratchMbTotal: integer("scratch_mb_total").notNull().default(10240),
  draining: integer("draining", { mode: "boolean" }).notNull().default(false),
  thermalState: text("thermal_state").notNull().default("unknown"),
  lastSeenAt: integer("last_seen_at"),
  // ── Power management ─────────────────────────
  isHead: integer("is_head", { mode: "boolean" }).notNull().default(false),
  powerMode: text("power_mode").notNull().default("manual"),
  macAddress: text("mac_address"),
  broadcastAddress: text("broadcast_address"),
  wolPort: integer("wol_port"),
  allowWake: integer("allow_wake", { mode: "boolean" }).notNull().default(false),
  allowPowerDown: integer("allow_power_down", { mode: "boolean" }).notNull().default(false),
  idlePowerDownAfterSec: integer("idle_power_down_after_sec"),
  lastWakeAt: integer("last_wake_at"),
  lastPowerDownAt: integer("last_power_down_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const jobEvents = sqliteTable("job_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: text("job_id").notNull(),
  type: text("type").notNull(),
  payloadJson: text("payload_json"),
  createdAt: integer("created_at").notNull(),
});

export const jobLogs = sqliteTable("job_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: text("job_id").notNull(),
  stream: text("stream").notNull(),
  line: text("line").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const results = sqliteTable("results", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  parser: text("parser").notNull(),
  status: text("status").notNull(),
  energyHartree: text("energy_hartree"),
  scfConverged: integer("scf_converged"),
  imaginaryFrequencies: integer("imaginary_frequencies"),
  normalTermination: integer("normal_termination"),
  warningsJson: text("warnings_json").notNull().default("[]"),
  errorsJson: text("errors_json").notNull().default("[]"),
  rawJson: text("raw_json"),
  createdAt: integer("created_at").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const proposals = sqliteTable("proposals", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  action: text("action").notNull(),
  reason: text("reason").notNull(),
  proposedChanges: text("proposed_changes").notNull(),
  status: text("status", { enum: ["pending", "approved", "rejected", "executed"] })
    .notNull()
    .default("pending"),
  diagnosisJson: text("diagnosis_json"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const permissions = sqliteTable("permissions", {
  id: text("id").primaryKey(),
  action: text("action").notNull(),
  resource: text("resource").notNull().default("*"),
  effect: text("effect", { enum: ["allow", "deny", "ask"] })
    .notNull()
    .default("allow"),
  projectId: text("project_id"),
  label: text("label"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// ── Users ─────────────────────────────────────

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  displayName: text("display_name"),
  email: text("email"),
  status: text("status").notNull().default("active"), // active | disabled
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// ── Projects ──────────────────────────────────

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  status: text("status").notNull().default("active"), // active | archived
  maxConcurrentJobs: integer("max_concurrent_jobs").notNull().default(10),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// ── Project Memberships ──────────────────────

export const projectMemberships = sqliteTable("project_memberships", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull().default("member"), // owner | admin | member
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// ── Project Quotas ───────────────────────────

export const projectQuotas = sqliteTable("project_quotas", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().unique(),
  maxCpuThreads: integer("max_cpu_threads").notNull().default(0), // 0 = unlimited
  maxMemoryMb: integer("max_memory_mb").notNull().default(0),
  maxScratchMb: integer("max_scratch_mb").notNull().default(0),
  maxJobsTotal: integer("max_jobs_total").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// ── Usage Accounting ──────────────────────────

export const usageRecords = sqliteTable("usage_records", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  userId: text("user_id").notNull(),
  jobId: text("job_id").notNull(),
  cpuThreads: integer("cpu_threads").notNull().default(1),
  memoryMb: integer("memory_mb").notNull().default(1024),
  scratchMb: integer("scratch_mb").notNull().default(1024),
  walltimeMs: integer("walltime_ms"),
  recordedAt: integer("recorded_at").notNull(),
});
