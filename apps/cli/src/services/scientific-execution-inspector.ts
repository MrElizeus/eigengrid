import { createHash } from "node:crypto";
import { createReadStream, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Artifact, JobAttempt } from "@eigengrid/core";
import type { DatabaseLike, JobRecord, StoredResultRecord } from "@eigengrid/db";
import { digestCanonical } from "@eigengrid/scientific-schema";

export type ScientificArtifactIntegrity =
  | { status: "verified" }
  | { status: "corrupt"; reasons: string[] };

export interface ScientificArtifactSnapshot {
  artifact: Artifact;
  canonicalPath: string;
  contentDigest: string;
  actualSizeBytes: number;
  integrity: ScientificArtifactIntegrity;
}

export interface ScientificParsedResultSnapshot {
  record: StoredResultRecord;
  contentDigest: string;
}

export interface ScientificExecutionSnapshot {
  job: JobRecord;
  attempt: JobAttempt;
  artifacts: ScientificArtifactSnapshot[];
  result?: ScientificParsedResultSnapshot;
}

export interface ScientificExecutionInspectionRequest {
  jobId: string;
  attemptId: string;
  requireOutputArtifact?: boolean;
  requireResult?: boolean;
}

/**
 * Narrow, read-only evidence capability used after the canonical coordinator
 * has collected and parsed an attempt. It exposes typed immutable snapshots,
 * never a database handle, parser, shell, runner, or arbitrary path read.
 */
export interface ScientificExecutionInspector {
  inspect(request: ScientificExecutionInspectionRequest): Promise<ScientificExecutionSnapshot>;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

function ensurePathWithinJobRoot(job: JobRecord, artifactPath: string): string {
  if (!isAbsolute(artifactPath)) {
    throw new Error(`Artifact ${artifactPath} is not an absolute canonical path`);
  }
  const declaredJobRoot = resolve(job.workdir, job.id);
  const canonicalRoot = realpathSync(declaredJobRoot);
  const stat = lstatSync(artifactPath);
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Artifact ${artifactPath} is a symbolic link and cannot be authoritative evidence`,
    );
  }
  if (!stat.isFile()) {
    throw new Error(`Artifact ${artifactPath} is not a regular file`);
  }
  const canonicalPath = realpathSync(artifactPath);
  const fromRoot = relative(canonicalRoot, canonicalPath);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Artifact ${artifactPath} escapes the canonical job directory`);
  }
  return canonicalPath;
}

export class CanonicalScientificExecutionInspector implements ScientificExecutionInspector {
  constructor(private readonly database: DatabaseLike) {}

  async inspect(
    request: ScientificExecutionInspectionRequest,
  ): Promise<ScientificExecutionSnapshot> {
    const resolvedJobId = await this.database.resolveJobId(request.jobId);
    const job = await this.database.getJob(resolvedJobId);
    if (!job) throw new Error(`Scientific execution job ${resolvedJobId} was not found`);
    const attempts = await this.database.listJobAttempts(resolvedJobId);
    const attempt = attempts.find((candidate) => candidate.id === request.attemptId);
    if (!attempt) {
      throw new Error(
        `Scientific execution attempt ${request.attemptId} was not found for ${resolvedJobId}`,
      );
    }

    const artifactRecords = (await this.database.listArtifacts(resolvedJobId))
      .filter((artifact) => artifact.attemptId === attempt.id)
      .sort((left, right) =>
        `${left.kind}\0${left.id}`.localeCompare(`${right.kind}\0${right.id}`),
      );
    if (
      request.requireOutputArtifact &&
      !artifactRecords.some((artifact) => artifact.kind === "output")
    ) {
      throw new Error(`Attempt ${attempt.id} has no collected output artifact`);
    }

    const artifacts: ScientificArtifactSnapshot[] = [];
    for (const artifact of artifactRecords) {
      const canonicalPath = ensurePathWithinJobRoot(job, artifact.path);
      const stat = lstatSync(canonicalPath);
      const actualSizeBytes = stat.size;
      const contentDigest = await sha256File(canonicalPath);
      const reasons: string[] = [];
      if (artifact.sizeBytes !== undefined && artifact.sizeBytes !== actualSizeBytes) {
        reasons.push(
          `database size ${artifact.sizeBytes} differs from filesystem size ${actualSizeBytes}`,
        );
      }
      artifacts.push({
        artifact,
        canonicalPath,
        contentDigest,
        actualSizeBytes,
        integrity: reasons.length === 0 ? { status: "verified" } : { status: "corrupt", reasons },
      });
    }

    const result = await this.database.getLatestResult(resolvedJobId, attempt.id);
    if (request.requireResult && !result) {
      throw new Error(`Job ${resolvedJobId} has no durable parsed result`);
    }
    if (result && result.jobId !== resolvedJobId) {
      throw new Error(`Parsed result ${result.id} is bound to a different job`);
    }
    if (result && result.attemptId !== attempt.id) {
      throw new Error(`Parsed result ${result.id} is bound to a different attempt`);
    }

    return {
      job,
      attempt,
      artifacts,
      ...(result
        ? {
            result: {
              record: result,
              contentDigest: digestCanonical({
                id: result.id,
                jobId: result.jobId,
                attemptId: result.attemptId,
                parser: result.parser,
                status: result.status,
                energyHartree: result.energyHartree,
                scfConverged: result.scfConverged,
                imaginaryFrequencies: result.imaginaryFrequencies,
                normalTermination: result.normalTermination,
                warnings: result.warnings,
                errors: result.errors,
                raw: result.raw,
                createdAt: result.createdAt,
              }),
            },
          }
        : {}),
    };
  }
}
