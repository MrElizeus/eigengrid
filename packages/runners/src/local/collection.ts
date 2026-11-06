import type { Artifact, Job } from "@eigengrid/core";
import { generateId } from "@eigengrid/core";
import { existsSync, statSync } from "fs";
import { join } from "path";
import { localRegisterArtifactOnce } from "./artifacts";
import { LocalRunnerContext } from "./context";
import { assertSafeFileTarget } from "./paths";

/**
 * Collect artifacts for a specific attempt.
 * Deduplicates by jobId + attemptId + kind + canonical path.
 */
export async function localCollectAttempt(
  runner: LocalRunnerContext,
  job: Job,
  attemptId: string,
  options?: { requiredOutput?: boolean },
): Promise<
  | { ok: true; artifacts: string[]; message: string }
  | { ok: false; artifacts: string[]; message: string }
> {
  const jobDir = runner.jobDir(job);
  const registered: string[] = [];
  const errors: string[] = [];
  const requiredOutput = options?.requiredOutput ?? true;

  const stdoutPath = join(jobDir, "stdout.log");
  const stderrPath = join(jobDir, "stderr.log");

  const register = async (
    kind: Artifact["kind"],
    path: string,
    label: string,
    required: boolean,
  ): Promise<void> => {
    if (!existsSync(path)) {
      if (required) errors.push(`Required ${label} not found: ${path}`);
      return;
    }
    assertSafeFileTarget(path, `${label} artifact`);

    const created = await localRegisterArtifactOnce(runner, {
      id: generateId("artifact"),
      jobId: job.id,
      attemptId,
      kind,
      path,
      label,
      mimeType: kind === "log" ? "text/plain" : undefined,
      sizeBytes: statSync(path).size,
    });
    if (created) registered.push(path);
  };

  await register("log", stdoutPath, "stdout", false);
  await register("log", stderrPath, "stderr", false);

  if (job.outputPath) {
    const outputPath = runner.resolvePath(jobDir, job.outputPath);
    await register("output", outputPath, "output", requiredOutput);
  }

  const ok = errors.length === 0;
  return {
    ok,
    artifacts: registered,
    message: ok
      ? `Collected ${registered.length} artifact(s) for attempt ${attemptId}`
      : `Collection partial: ${errors.join("; ")}`,
  };
}
