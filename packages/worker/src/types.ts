import { z } from "zod";

// ────────────────────────────────────────────────────────────
// Worker Job States
// ────────────────────────────────────────────────────────────

export type WorkerJobState =
  | "enqueued"
  | "claimed"
  | "staged"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "orphaned";

// ────────────────────────────────────────────────────────────
// Worker Job Manifest (command-free bundle descriptor)
// ────────────────────────────────────────────────────────────

export const MAX_WORKER_CORES = 4096;
export const MAX_WORKER_MEMORY_GB = 1048576;

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u, "must be a conservative identifier");

const bundleNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) => value !== "." && value !== ".." && !/[\\/\p{Cc}]/u.test(value),
    "must be a basename without separators or control characters",
  );

export const workerJobManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    jobId: identifierSchema.refine(
      (value) => !value.endsWith(".tmp"),
      "must not use the reserved .tmp suffix",
    ),
    attemptId: identifierSchema,
    nodeName: identifierSchema,
    // MD engines are intentionally excluded: this legacy queue resolves a single
    // built-in Recipe and is not a typed, durable MD backend.
    software: z.enum(["gaussian", "orca", "xtb", "cp2k", "qe", "unknown"]),
    recipeId: identifierSchema,
    runner: z.literal("worker-daemon"),
    inputName: bundleNameSchema,
    outputName: bundleNameSchema,
    resources: z
      .object({
        cores: z.number().finite().int().positive().max(MAX_WORKER_CORES),
        memoryGb: z.number().finite().min(0.1).max(MAX_WORKER_MEMORY_GB),
      })
      .strict(),
    createdAt: z.number().finite().int().positive(),
  })
  .strict();

export type WorkerJobManifest = z.infer<typeof workerJobManifestSchema>;

// ────────────────────────────────────────────────────────────
// Worker Job Status File (status.json)
// ────────────────────────────────────────────────────────────

export interface WorkerJobStatusFile {
  schemaVersion: 1;
  jobId: string;
  attemptId: string;
  state: WorkerJobState;
  pid?: number;
  exitCode?: number;
  command: string;
  startedAt?: number;
  finishedAt?: number;
  updatedAt: number;
  message?: string;
}

// ────────────────────────────────────────────────────────────
// Worker Event Types (events.jsonl)
// ────────────────────────────────────────────────────────────

export type WorkerEventType =
  | "worker.daemon.started"
  | "worker.daemon.stopped"
  | "worker.job.claimed"
  | "worker.process.started"
  | "worker.process.completed"
  | "worker.artifact.available"
  | "worker.job.completed"
  | "worker.job.failed"
  | "worker.job.cancelled"
  | "worker.job.orphaned"
  | "worker.error";

export interface WorkerEvent {
  type: WorkerEventType;
  jobId?: string;
  attemptId?: string;
  pid?: number;
  exitCode?: number;
  path?: string;
  kind?: string;
  message?: string;
  at: number;
}
