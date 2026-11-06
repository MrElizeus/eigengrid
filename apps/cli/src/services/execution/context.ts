import type { Job } from "@eigengrid/core";
import type { JobRecord } from "@eigengrid/db";
import type { EigenGridEventBase } from "@eigengrid/events";
import {
  type EventPayload,
  type ExecutionCoordinatorDeps,
  type LocalExecutionBackend,
} from "./contracts";

export async function emitExecutionEvent(
  deps: ExecutionCoordinatorDeps,
  type: EigenGridEventBase["type"],
  jobId: string,
  attemptId?: string,
  payload?: EventPayload,
): Promise<void> {
  const event: EigenGridEventBase = {
    id: deps.idGenerator("evt"),
    type,
    at: deps.clock(),
    source: "cli",
    jobId,
    attemptId,
    payload,
  };
  await deps.db.appendEvent(event);
}

export function jobFromDb(deps: ExecutionCoordinatorDeps, raw: JobRecord): Job {
  return {
    id: raw.id,
    name: raw.name,
    software: raw.software as Job["software"],
    inputPath: raw.inputPath,
    workdir: raw.workdir ?? deps.config.jobsDir,
    outputPath: raw.outputPath ?? undefined,
    status: raw.status as Job["status"],
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    projectId: raw.projectId ?? undefined,
    backend: raw.backend ?? undefined,
  };
}

export async function resolveJobAndAttempt(
  deps: ExecutionCoordinatorDeps,
  jobIdArg: string,
  attemptId?: string,
): Promise<
  | { ok: true; job: Job; resolvedId: string; attempt: { id: string } }
  | { ok: false; message: string }
> {
  let resolvedId: string;
  try {
    resolvedId = await deps.db.resolveJobId(jobIdArg);
  } catch {
    return { ok: false, message: `Job not found: ${jobIdArg}` };
  }
  const raw = await deps.db.getJob(resolvedId);
  if (!raw) return { ok: false, message: `Job not found: ${resolvedId}` };
  const job = jobFromDb(deps, raw);

  const attempts = await deps.db.listJobAttempts(resolvedId);
  const selected = attemptId
    ? attempts.find((candidate) => candidate.id === attemptId)
    : attempts[attempts.length - 1];
  if (!selected) {
    return {
      ok: false,
      message: attemptId
        ? `Attempt ${attemptId} not found for job ${resolvedId}`
        : `No attempts found for job ${resolvedId}`,
    };
  }
  return { ok: true, job, resolvedId, attempt: selected };
}

export function buildBackendForJob(
  deps: ExecutionCoordinatorDeps,
  job: Job,
): LocalExecutionBackend {
  return deps.localBackendFactory(
    { command: "", program: "", args: [], job },
    deps.db,
    deps.executor,
  );
}

export async function resolveJobOnly(
  deps: ExecutionCoordinatorDeps,
  jobIdArg: string,
): Promise<
  | { ok: true; resolvedId: string; job: Job & Record<string, unknown> }
  | { ok: false; resolvedId: string; message: string }
> {
  let resolvedId: string;
  try {
    resolvedId = await deps.db.resolveJobId(jobIdArg);
  } catch {
    return { ok: false, resolvedId: jobIdArg, message: `Job not found: ${jobIdArg}` };
  }
  const raw = await deps.db.getJob(resolvedId);
  if (!raw) return { ok: false, resolvedId, message: `Job not found: ${resolvedId}` };
  // Preserve provider-specific metadata for remote adapters while still
  // normalizing the canonical Job fields.  Older runner fakes and external
  // backends may rely on fields such as externalJobId/nodeName that are not
  // part of the narrow local Job shape; dropping them at this boundary would
  // make the coordinator observably lossy.
  const preserved = {
    ...(raw as unknown as Record<string, unknown>),
    ...jobFromDb(deps, raw),
  } as Job & Record<string, unknown>;
  // The legacy Slurm adapter accepted the historical snake_case alias;
  // retaining it during the migration keeps external runner contracts
  // source-compatible without making it part of the canonical domain Job.
  if (preserved.external_job_id === undefined && preserved.externalJobId !== undefined) {
    preserved.external_job_id = preserved.externalJobId;
  }
  return {
    ok: true,
    resolvedId,
    job: preserved,
  };
}

// ── Failure helper ────────────────────────────────────────

export async function failJobAndAttempt(
  deps: ExecutionCoordinatorDeps,
  jobId: string,
  attemptId: string,
  message: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const now = deps.clock();
  const persistenceErrors: string[] = [];
  try {
    await deps.db.updateJobAttemptStatus(attemptId, "failed", { finishedAt: now });
  } catch (error) {
    persistenceErrors.push(
      `attempt failed transition: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    await deps.db.updateJobStatus(jobId, "failed");
  } catch (error) {
    persistenceErrors.push(
      `job failed transition: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (persistenceErrors.length > 0) {
    return {
      ok: false,
      message: `Unable to persist failure state for ${jobId}/${attemptId}: ${persistenceErrors.join(
        "; ",
      )}`,
    };
  }
  try {
    await emitExecutionEvent(deps, "process.failed", jobId, attemptId, {
      error: message,
      pid: null,
      exitCode: 1,
    });
  } catch (error) {
    return {
      ok: false,
      message: `Failure state is durable but process.failed event persistence failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return { ok: true };
}
