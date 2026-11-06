import type { Artifact, Job } from "@eigengrid/core";
import { generateId } from "@eigengrid/core";
import { existsSync, statSync } from "fs";
import { resolve } from "path";
import { atomicWriteRunnerFile } from "../safe-path";
import { LocalRunnerContext } from "./context";
import { type TrackedProcess } from "./contracts";
import { assertSafeFileTarget } from "./paths";

// ── Artifact Helpers ────────────────────────────────────

export async function localRegisterArtifactOnce(
  runner: LocalRunnerContext,
  artifact: Omit<Artifact, "createdAt">,
): Promise<boolean> {
  const canonPath = resolve(artifact.path);
  return runner.db.createArtifactIfAbsent({ ...artifact, path: canonPath });
}

export async function localWriteLogArtifacts(
  runner: LocalRunnerContext,
  jobId: string,
  record: Pick<TrackedProcess, "attemptId" | "stdoutPath" | "stderrPath">,
  stdout: string,
  stderr: string,
): Promise<void> {
  assertSafeFileTarget(record.stdoutPath, "stdout target");
  assertSafeFileTarget(record.stderrPath, "stderr target");
  atomicWriteRunnerFile(record.stdoutPath, stdout);
  atomicWriteRunnerFile(record.stderrPath, stderr);

  await localRegisterArtifactOnce(runner, {
    id: generateId("artifact"),
    jobId,
    attemptId: record.attemptId,
    kind: "log",
    path: record.stdoutPath,
    label: "stdout",
    mimeType: "text/plain",
    sizeBytes: statSync(record.stdoutPath).size,
  });

  await localRegisterArtifactOnce(runner, {
    id: generateId("artifact"),
    jobId,
    attemptId: record.attemptId,
    kind: "log",
    path: record.stderrPath,
    label: "stderr",
    mimeType: "text/plain",
    sizeBytes: statSync(record.stderrPath).size,
  });
}

export async function localRegisterOutputArtifact(
  runner: LocalRunnerContext,
  job: Job,
  record: Pick<TrackedProcess, "attemptId" | "jobDir">,
): Promise<void> {
  if (!job.outputPath) return;
  const outputPath = runner.resolvePath(record.jobDir, job.outputPath);
  if (!existsSync(outputPath)) return;
  assertSafeFileTarget(outputPath, "output artifact");
  await localRegisterArtifactOnce(runner, {
    id: generateId("artifact"),
    jobId: job.id,
    attemptId: record.attemptId,
    kind: "output",
    path: outputPath,
    mimeType: "text/plain",
    sizeBytes: statSync(outputPath).size,
  });
}
