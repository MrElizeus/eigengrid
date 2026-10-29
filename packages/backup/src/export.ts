// ────────────────────────────────────────────────────────────
// Job export and diagnostic bundle exports
// ────────────────────────────────────────────────────────────

import type { JobExportManifest, DiagnosticManifest } from "./types";
import { type DatabaseLike, type JobRecord } from "@eigengrid/db";
import { listResults, getLatestResult, listJobEvents, getTimeline } from "@eigengrid/db";
import {
  closeSync,
  chmodSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { join, resolve, dirname, basename } from "path";
import * as tar from "tar";
import { checksumEntry } from "./safety";
import { redactObject, redactJson } from "./redact";

const BACKUP_EXTENSION = ".eigengrid-backup.tar.gz";

// ── Job Export ──────────────────────────────────────────────

/**
 * Export a single job with all its data into a portable bundle.
 */
export async function exportJob(
  db: DatabaseLike,
  jobId: string,
  options: {
    outputPath?: string;
    includeArtifacts?: boolean;
  },
): Promise<{ exportPath: string; fileCount: number; totalSizeBytes: number }> {
  const resolvedId = await db.resolveJobId(jobId);
  const job = await db.getJob(resolvedId);
  if (!job) {
    throw new Error(`Job not found: ${resolvedId}`);
  }

  const includeArtifacts = options.includeArtifacts ?? false;
  const outputPath = options.outputPath ?? `job-export-${resolvedId}${BACKUP_EXTENSION}`;

  const files = new Map<string, Buffer>();

  // job.json
  files.set("job.json", Buffer.from(JSON.stringify(redactObject(job), null, 2), "utf-8"));

  // attempts.json
  const attempts = await db.listJobAttempts(resolvedId);
  files.set("attempts.json", Buffer.from(JSON.stringify(redactObject(attempts), null, 2), "utf-8"));

  // events.ndjson
  const events = await listJobEvents(db, resolvedId);
  const eventsNdjson = events.map((e) => JSON.stringify(redactObject(e))).join("\n");
  files.set("events.ndjson", Buffer.from(eventsNdjson, "utf-8"));

  // results.json
  const results = await listResults(db, resolvedId);
  files.set("results.json", Buffer.from(JSON.stringify(redactObject(results), null, 2), "utf-8"));

  // logs/
  const streams = ["stdout", "stderr"];
  for (const stream of streams) {
    try {
      const logs = await db.getLogs(resolvedId, stream);
      if (logs.length > 0) {
        const logText = logs.map((l) => l.line).join("\n");
        const redacted = redactObject(logText);
        files.set(`logs/${stream}.log`, Buffer.from(redacted, "utf-8"));
      }
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
      // Optional logs table on pre-migration databases.
    }
  }

  // Try getting all logs without stream filter
  try {
    const allLogs = await db.getLogs(resolvedId);
    if (allLogs.length > 0) {
      const logLines = allLogs.map((l) => `[${l.stream}] ${l.line}`).join("\n");
      const redacted = redactObject(logLines);
      files.set("logs/combined.log", Buffer.from(redacted, "utf-8"));
    }
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
  }

  // recipe.json — read from job's workdir or attempt
  const jobWorkdir = job.workdir as string | undefined;
  if (jobWorkdir) {
    const recipePath = join(jobWorkdir, "recipe.json");
    if (existsSync(recipePath)) {
      const recipe = readFileSync(recipePath, "utf-8");
      files.set("recipe.json", Buffer.from(redactJson(recipe), "utf-8"));
    }

    // environment.json
    const envPath = join(jobWorkdir, "environment.json");
    if (existsSync(envPath)) {
      const env = readFileSync(envPath, "utf-8");
      files.set("environment.json", Buffer.from(redactJson(env), "utf-8"));
    }
  }

  // artifacts/ if requested
  if (includeArtifacts) {
    const artifacts = await db.listArtifacts(resolvedId);
    for (const artifact of artifacts) {
      const artPath = artifact.path;
      if (!artPath) throw new Error(`Artifact ${String(artifact.id)} has no path`);
      if (!existsSync(artPath))
        throw new Error(`Artifact ${String(artifact.id)} is missing: ${artPath}`);
      const content = readFileSync(artPath);
      const safeName = `artifacts/${safeArchiveSegment(String(artifact.id), "artifact")}_${basename(artPath)}`;
      files.set(safeName, content);
    }
  }

  // Build manifest
  const manifest: JobExportManifest = {
    format: "eigengrid-job-export",
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    jobId: resolvedId,
    software: String(job.software ?? "unknown"),
    status: String(job.status ?? "unknown"),
    includeArtifacts,
    fileCount: files.size + 1, // + manifest
  };
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf-8"));

  // README.md
  const readme = generateJobExportReadme(resolvedId, job);
  files.set("README.md", Buffer.from(readme, "utf-8"));

  // checksums.sha256
  const checksumLines: string[] = [];
  for (const [filePath, content] of files) {
    checksumLines.push(checksumEntry(filePath, content));
  }
  files.set("checksums.sha256", Buffer.from(checksumLines.join("\n"), "utf-8"));

  // Write archive
  return writeArchive(outputPath, files);
}

// ── Diagnostic Export ────────────────────────────────────────

/**
 * Export a diagnostic bundle for a job.
 */
export async function exportDiagnostic(
  db: DatabaseLike,
  jobId: string,
  options: {
    outputPath?: string;
  },
): Promise<{ exportPath: string; fileCount: number; totalSizeBytes: number }> {
  const resolvedId = await db.resolveJobId(jobId);
  const job = await db.getJob(resolvedId);
  if (!job) {
    throw new Error(`Job not found: ${resolvedId}`);
  }

  const outputPath = options.outputPath ?? `diagnostic-${resolvedId}${BACKUP_EXTENSION}`;

  const files = new Map<string, Buffer>();

  // diagnostic.json — context info
  const diagnostic = {
    jobId: resolvedId,
    jobName: job.name,
    software: job.software,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    exportedAt: new Date().toISOString(),
    nodeId: job.nodeId,
    inputPath: job.inputPath,
    outputPath: job.outputPath,
    workdir: job.workdir,
  };
  files.set(
    "diagnostic.json",
    Buffer.from(JSON.stringify(redactObject(diagnostic), null, 2), "utf-8"),
  );

  // status.json
  const attempts = await db.listJobAttempts(resolvedId);
  const latestAttempt = attempts.at(-1);
  const statusInfo = {
    job: redactObject(job),
    attempts: redactObject(attempts),
    latestResult: redactObject(
      latestAttempt ? await getLatestResult(db, resolvedId, latestAttempt.id) : null,
    ),
  };
  files.set("status.json", Buffer.from(JSON.stringify(statusInfo, null, 2), "utf-8"));

  // events.ndjson
  const events = await listJobEvents(db, resolvedId);
  const eventsNdjson = events.map((e) => JSON.stringify(redactObject(e))).join("\n");
  files.set("events.ndjson", Buffer.from(eventsNdjson, "utf-8"));

  // timeline.txt
  const timeline = await getTimeline(db, resolvedId);
  const timelineText = timeline
    .map((t) => `${t.at} | ${t.type.padEnd(40)} | ${t.details}`)
    .join("\n");
  files.set("timeline.txt", Buffer.from(timelineText, "utf-8"));

  // logs/
  const streams = ["stdout", "stderr"];
  for (const stream of streams) {
    try {
      const logs = await db.getLogs(resolvedId, stream);
      if (logs.length > 0) {
        const logText = logs.map((l) => l.line).join("\n");
        files.set(`logs/${stream}.log`, Buffer.from(redactObject(logText), "utf-8"));
      }
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
    }
  }

  // scheduler-decisions.ndjson — extract from events
  const schedulerEvents = events.filter((e) => String(e.type).startsWith("scheduler."));
  if (schedulerEvents.length > 0) {
    files.set(
      "scheduler-decisions.ndjson",
      Buffer.from(schedulerEvents.map((e) => JSON.stringify(redactObject(e))).join("\n"), "utf-8"),
    );
  }

  // agent-decisions.ndjson
  const agentEvents = events.filter((e) => String(e.type).startsWith("agent."));
  if (agentEvents.length > 0) {
    files.set(
      "agent-decisions.ndjson",
      Buffer.from(agentEvents.map((e) => JSON.stringify(redactObject(e))).join("\n"), "utf-8"),
    );
  }

  // worker-recovery-decisions.ndjson
  const workerEvents = events.filter((e) => String(e.type).startsWith("worker."));
  if (workerEvents.length > 0) {
    files.set(
      "worker-recovery-decisions.ndjson",
      Buffer.from(workerEvents.map((e) => JSON.stringify(redactObject(e))).join("\n"), "utf-8"),
    );
  }

  // artifacts-index.json
  const artifacts = await db.listArtifacts(resolvedId);
  files.set(
    "artifacts-index.json",
    Buffer.from(JSON.stringify(redactObject(artifacts), null, 2), "utf-8"),
  );

  // Build manifest
  const manifest: DiagnosticManifest = {
    format: "eigengrid-diagnostic",
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    jobId: resolvedId,
    software: String(job.software ?? "unknown"),
    status: String(job.status ?? "unknown"),
    fileCount: files.size + 1,
  };
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf-8"));

  // checksums.sha256
  const checksumLines: string[] = [];
  for (const [filePath, content] of files) {
    checksumLines.push(checksumEntry(filePath, content));
  }
  files.set("checksums.sha256", Buffer.from(checksumLines.join("\n"), "utf-8"));

  // Write archive
  return writeArchive(outputPath, files);
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Write an archive from a map of files.
 */
async function writeArchive(
  outputPath: string,
  files: Map<string, Buffer>,
): Promise<{ exportPath: string; fileCount: number; totalSizeBytes: number }> {
  const resolvedOutput = resolve(outputPath);
  const outputDir = dirname(resolvedOutput);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const temporaryRoot = mkdtempSync(join(outputDir, ".eigengrid-export-"));
  const tmpDir = join(temporaryRoot, "staging");
  const temporaryArchive = join(temporaryRoot, "archive.tar.gz");
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });

  try {
    for (const [filePath, content] of files) {
      assertSafeArchivePath(filePath);
      const fullPath = join(tmpDir, filePath);
      const dir = dirname(fullPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, content, { mode: 0o600 });
      syncFile(fullPath);
    }

    await tar.create(
      {
        file: temporaryArchive,
        cwd: tmpDir,
        gzip: true,
        portable: true,
      },
      Array.from(files.keys()),
    );

    chmodSync(temporaryArchive, 0o600);
    const totalSizeBytes = statSync(temporaryArchive).size;
    syncFile(temporaryArchive);
    syncDirectory(temporaryRoot);
    renameSync(temporaryArchive, resolvedOutput);
    syncDirectory(outputDir);

    return { exportPath: resolvedOutput, fileCount: files.size, totalSizeBytes };
  } catch (err) {
    if (existsSync(temporaryRoot)) rmRecursive(temporaryRoot);
    throw err;
  } finally {
    if (existsSync(temporaryRoot)) rmRecursive(temporaryRoot);
  }
}

function isMissingTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:no such table|relation .* does not exist|undefined table)/iu.test(message);
}

function safeArchiveSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(value)) {
    throw new Error(`${label} contains unsafe archive path characters`);
  }
  return value;
}

function assertSafeArchivePath(filePath: string): void {
  const normalized = filePath.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    throw new Error(`Unsafe archive entry path: ${filePath}`);
  }
}

function syncFile(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0),
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function generateJobExportReadme(jobId: string, job: JobRecord): string {
  return [
    `# Job Export: ${jobId}`,
    "",
    `Software: ${job.software ?? "unknown"}`,
    `Status: ${job.status ?? "unknown"}`,
    `Name: ${job.name ?? "unknown"}`,
    `Created: ${job.createdAt ? new Date(Number(job.createdAt)).toISOString() : "unknown"}`,
    "",
    "## Contents",
    "",
    "- `manifest.json` — Export metadata",
    "- `job.json` — Full job record",
    "- `attempts.json` — All attempts for this job",
    "- `events.ndjson` — Event log (newline-delimited JSON)",
    "- `results.json` — Parse results",
    "- `logs/` — stdout and stderr logs (if available)",
    "- `recipe.json` — Recipe used (if available)",
    "- `environment.json` — Runtime environment (if available)",
    "- `checksums.sha256` — Integrity hashes for all files",
    "- `artifacts/` — Artifact files (if --include-artifacts was used)",
    "",
    "## Restore",
    "",
    "This is a read-only export for review. To restore a full backup, use:",
    "```",
    "eigengrid backup restore <backup-file>",
    "```",
    "",
    "Generated by eigengrid at " + new Date().toISOString(),
    "",
  ].join("\n");
}

function rmRecursive(dir: string): void {
  try {
    const { rmSync } = require("fs");
    rmSync(dir, { recursive: true, force: true });
  } catch {
    try {
      const { readdirSync, rmdirSync, unlinkSync } = require("fs");
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          rmRecursive(fullPath);
        } else {
          unlinkSync(fullPath);
        }
      }
      rmdirSync(dir);
    } catch {
      // Ignore cleanup errors
    }
  }
}
