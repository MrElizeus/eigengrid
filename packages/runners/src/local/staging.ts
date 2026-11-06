import type { Job, JobAttempt, RunnerResult } from "@eigengrid/core";
import { generateId } from "@eigengrid/core";
import { statSync } from "fs";
import { atomicCopyRunnerFile } from "../safe-path";
import { localRegisterArtifactOnce } from "./artifacts";
import { LocalRunnerContext } from "./context";
import { assertSafeFileTarget, ensurePrivateJobDirectory } from "./paths";

// ── Attempt Lifecycle ───────────────────────────────────

export async function localEnsureAttempt(
  runner: LocalRunnerContext,
  job: Job,
): Promise<JobAttempt> {
  const attempts = await runner.db.listJobAttempts(job.id);
  if (attempts.length > 0) return attempts[attempts.length - 1];
  await localStage(runner, job);
  const stagedAttempts = await runner.db.listJobAttempts(job.id);
  const attempt = stagedAttempts[stagedAttempts.length - 1];
  if (!attempt) throw new Error(`Failed to create a local attempt for job ${job.id}`);
  return attempt;
}

// ── Coordinator-Driven Explicit-Attempt Methods ─────────

export async function localStageAttempt(
  runner: LocalRunnerContext,
  job: Job,
  attemptId: string,
): Promise<RunnerResult> {
  const jobDir = runner.jobDir(job);
  ensurePrivateJobDirectory(jobDir);

  await runner.db.updateJobStatus(job.id, "queued");
  await runner.db.updateJobAttemptStatus(attemptId, "queued");

  const stagedInput = runner.stagedInputPath(job);
  assertSafeFileTarget(stagedInput, "staged input target");
  atomicCopyRunnerFile(job.inputPath, stagedInput);

  await localRegisterArtifactOnce(runner, {
    id: generateId("artifact"),
    jobId: job.id,
    attemptId,
    kind: "input",
    path: stagedInput,
    mimeType: "text/plain",
    sizeBytes: statSync(stagedInput).size,
  });

  await runner.db.updateJobAttemptStatus(attemptId, "staged");
  await runner.db.updateJobStatus(job.id, "staged");

  return {
    ok: true,
    message: `Staged ${job.name} in ${jobDir}`,
    metadata: { attemptId, cwd: jobDir, inputPath: stagedInput },
  };
}

// ── Runner Interface ────────────────────────────────────

export async function localStage(runner: LocalRunnerContext, job: Job): Promise<RunnerResult> {
  const engine = runner.getEngine(job);
  const jobDir = runner.jobDir(job);
  const attemptId = generateId("attempt");

  ensurePrivateJobDirectory(jobDir);

  await runner.db.updateJobStatus(job.id, "queued");
  await runner.db.createJobAttempt({
    id: attemptId,
    jobId: job.id,
    runner: "local",
    command: engine.displayCommand ?? engine.command,
    cwd: jobDir,
  });

  const stagedInput = runner.stagedInputPath(job);
  assertSafeFileTarget(stagedInput, "staged input target");
  atomicCopyRunnerFile(job.inputPath, stagedInput);

  await localRegisterArtifactOnce(runner, {
    id: generateId("artifact"),
    jobId: job.id,
    attemptId,
    kind: "input",
    path: stagedInput,
    mimeType: "text/plain",
    sizeBytes: statSync(stagedInput).size,
  });

  await runner.db.updateJobAttemptStatus(attemptId, "queued");
  await runner.db.updateJobAttemptStatus(attemptId, "staged");
  await runner.db.updateJobStatus(job.id, "staged");

  return {
    ok: true,
    message: `Staged ${job.name} in ${jobDir}`,
    metadata: { attemptId, cwd: jobDir, inputPath: stagedInput },
  };
}
