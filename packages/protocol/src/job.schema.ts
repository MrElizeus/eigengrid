import { z } from "zod";

export const JobStatusSchema = z.enum([
  "created",
  "queued",
  "staged",
  "running",
  "completed",
  "failed",
  "cancelled",
  "parsed",
]);

export const JobAttemptStatusSchema = z.enum([
  "created",
  "queued",
  "staged",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const SoftwareSchema = z.enum([
  "gaussian",
  "orca",
  "xtb",
  "cp2k",
  "qe",
  "amber",
  "gromacs",
  "unknown",
]);

export const RunnerKindSchema = z.enum(["local", "ssh", "slurm", "pbs"]);

export const ArtifactKindSchema = z.enum([
  "input",
  "output",
  "log",
  "checkpoint",
  "geometry",
  "result",
  "report",
  "other",
]);

export const NodeStatusSchema = z.enum([
  "unknown",
  "online",
  "busy",
  "offline",
  "draining",
  "error",
]);

export const JobSchema = z.object({
  id: z.string(),
  name: z.string(),
  software: SoftwareSchema,
  inputPath: z.string(),
  workdir: z.string(),
  outputPath: z.string().optional(),
  nodeId: z.string().optional(),
  status: JobStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const JobAttemptSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  runner: RunnerKindSchema,
  status: JobAttemptStatusSchema,
  command: z.string(),
  cwd: z.string(),
  pid: z.number().optional(),
  exitCode: z.number().optional(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const ArtifactSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  attemptId: z.string(),
  kind: ArtifactKindSchema,
  path: z.string(),
  label: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().optional(),
  createdAt: z.number(),
});

export const ComputeNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string(),
  user: z.string(),
  runner: RunnerKindSchema,
  status: NodeStatusSchema,
  tags: z.array(z.string()),
  maxJobs: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
