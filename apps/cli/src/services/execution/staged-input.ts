import type { Job, RunnerResult } from "@eigengrid/core";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename, resolve } from "node:path";

// ── Local execution ──────────────────────────────────────

export async function verifyStagedInput(
  stageResult: RunnerResult,
  expectedDigest: string,
  job: Job,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!/^[a-f0-9]{64}$/u.test(expectedDigest)) {
    return { ok: false, message: "Expected input digest is not a canonical SHA-256 digest" };
  }
  const stagedInputPath = stageResult.metadata?.inputPath;
  if (typeof stagedInputPath !== "string" || !stagedInputPath) {
    return {
      ok: false,
      message: "The local backend did not identify the staged input for digest verification",
    };
  }
  const expectedStagedPath = resolve(job.workdir, job.id, basename(job.inputPath));
  if (resolve(stagedInputPath) !== expectedStagedPath) {
    return {
      ok: false,
      message: "The local backend did not return the exact staged execution input",
    };
  }
  try {
    const hash = createHash("sha256");
    await new Promise<void>((resolvePromise, reject) => {
      const stream = createReadStream(stagedInputPath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolvePromise);
    });
    if (hash.digest("hex") !== expectedDigest) {
      return {
        ok: false,
        message: "Staged input bytes do not match the approved input digest",
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: `Unable to verify staged input bytes: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
