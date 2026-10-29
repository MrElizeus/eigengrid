// ────────────────────────────────────────────────────────────
// Core backup, restore, verify, and inspect operations
// ────────────────────────────────────────────────────────────

import type { BackupManifest, BackupInfo, RestoreValidation } from "./types";
import {
  listJobs as dbListJobs,
  listResults,
  type DatabaseLike,
  type UserRecord,
  type ProjectRecord,
  type MembershipRecord,
  type QuotaRecord,
  type UsageRecord,
  type ProposalRow,
} from "@eigengrid/db";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { join, resolve, basename, dirname } from "path";
import * as tar from "tar";
import { checksumEntry, validateRestoreTarget } from "./safety";
import { redactObject } from "./redact";
import { readVerifiedSqliteSnapshot } from "./sqlite-snapshot";
import { ARCHIVE_PREFLIGHT_LIMITS, withPreflightedArchive } from "./archive-preflight";
import { verifyStagedArchive } from "./disk-verification";
import { materializeRestore, validateRestoreDestination } from "./restore-materialization";
import {
  BACKUP_CONTROL_FILE_MAX_BYTES,
  groupScientificCasReferences,
  readScientificCasReferencesFromBytes,
  scientificCasArchivePath,
  stageScientificCasObject,
  type BackupContentAddressedStore,
  type ScientificCasIndex,
} from "./scientific-cas";

const BACKUP_FORMAT = "eigengrid-backup";
const FORMAT_VERSION = 1;
const BACKUP_EXTENSION = ".eigengrid-backup.tar.gz";

// ── Public API ──────────────────────────────────────────────

/**
 * Create a full system backup.
 */
export async function createBackup(
  db: DatabaseLike,
  options: {
    outputPath?: string;
    includeArtifacts?: boolean;
    projectName?: string;
    projectRoot?: string;
    version: string;
    dbPath: string;
    /** Required whenever the frozen SQLite snapshot references cas:// evidence. */
    contentAddressedStore?: BackupContentAddressedStore;
  },
): Promise<{ backupPath: string; fileCount: number; totalSizeBytes: number }> {
  if (db._provider !== "sqlite") {
    throw new Error(
      "Backup archive creation currently requires the SQLite provider; PostgreSQL export is not implemented yet.",
    );
  }

  const outputPath = options.outputPath ?? `eigengrid-backup-${Date.now()}${BACKUP_EXTENSION}`;
  const version = options.version;
  const includeArtifacts = options.includeArtifacts ?? false;

  // Freeze the authoritative database first. CAS selection is derived from
  // this immutable snapshot, never from a later view of the mutable source DB.
  const dbContent = await readVerifiedSqliteSnapshot(options.dbPath);
  const scientificCasReferences = await readScientificCasReferencesFromBytes(dbContent);
  const scientificCasObjects = groupScientificCasReferences(scientificCasReferences);
  if (scientificCasObjects.length > 0 && !options.contentAddressedStore) {
    throw new Error(
      `Backup snapshot references ${scientificCasObjects.length} scientific CAS object(s), but no verified content-addressed store was provided.`,
    );
  }

  // Collect all data
  const jobs = await dbListJobs(db);
  const allAttempts: Record<string, unknown>[] = [];
  for (const job of jobs) {
    const attempts = await db.listJobAttempts(job.id as string);
    allAttempts.push(...(attempts as unknown as Record<string, unknown>[]));
  }

  const allArtifacts: Record<string, unknown>[] = [];
  for (const job of jobs) {
    const artifacts = await db.listArtifacts(job.id as string);
    allArtifacts.push(...(artifacts as unknown as Record<string, unknown>[]));
  }

  const allEvents = await db.getEvents();

  const allResults = await listResults(db);

  const allNodes = await db.listNodes();

  const allPermissions = await db.listPermissions();

  // ── Users, projects, memberships, quotas, usage ──
  let allUsers: UserRecord[] = [];
  let allProjects: ProjectRecord[] = [];
  let allMemberships: MembershipRecord[] = [];
  let allQuotas: QuotaRecord[] = [];
  let allUsageRecords: UsageRecord[] = [];

  try {
    allUsers = await db.listUsers();
    allProjects = await db.listProjects();
    // memberships: collect for each project
    for (const p of allProjects) {
      const members = await db.listProjectMembers(p.id as string);
      allMemberships.push(...members);
    }
    // quotas
    for (const p of allProjects) {
      const q = await db.getProjectQuota(p.id as string);
      if (q) allQuotas.push(q);
    }
    // usage
    for (const p of allProjects) {
      const u = await db.getProjectUsage(p.id as string);
      allUsageRecords.push(...u);
    }
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    // Older SQLite databases may legitimately predate the optional account
    // tables; only that specific schema condition is tolerated.
  }

  const allProposals: ProposalRow[] = [];
  for (const job of jobs) {
    try {
      // Proposals are stored separately; we read from the proposals table
      const dbConn = (db as any).ensureDb();
      const proposals = dbConn
        .query("SELECT * FROM proposals WHERE job_id = $jobId")
        .all({ $jobId: job.id });
      allProposals.push(...proposals);
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
      // Optional proposals table on pre-migration databases.
    }
  }

  // Build manifest
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    version,
    projectName: options.projectName,
    projectRoot: options.projectRoot,
    hashAlgorithm: "sha256",
    includeArtifacts,
    counts: {
      jobs: jobs.length,
      attempts: allAttempts.length,
      artifacts: allArtifacts.length,
      results: allResults.length,
      events: allEvents.length,
      nodes: allNodes.length,
      permissions: allPermissions.length,
      logs: 0, // counted separately via DB
      proposals: allProposals.length,
      users: allUsers.length,
      projects: allProjects.length,
      memberships: allMemberships.length,
      quotas: allQuotas.length,
      usageRecords: allUsageRecords.length,
      scientificCasReferences: scientificCasReferences.length,
      scientificCasObjects: scientificCasObjects.length,
    },
  };

  // Build archive entries as a collection of { path, buffer }
  const files = new Map<string, Buffer>();

  // manifest.json
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf-8"));

  // schema.json
  const schema = extractSchema(db);
  files.set("schema.json", Buffer.from(JSON.stringify(schema, null, 2), "utf-8"));

  // config.json — read from active config
  try {
    const { loadConfig } = await import("@eigengrid/config");
    const config = await loadConfig();
    const redactedConfig = redactObject(config);
    files.set("config.json", Buffer.from(JSON.stringify(redactedConfig, null, 2), "utf-8"));
  } catch (error) {
    throw new Error(
      `Unable to capture active configuration for backup: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // head.sqlite — verified, transactionally consistent SQLite snapshot
  files.set("head.sqlite", dbContent);

  // events.ndjson
  const eventsNdjson = allEvents.map((e) => JSON.stringify(e)).join("\n");
  files.set("events.ndjson", Buffer.from(eventsNdjson, "utf-8"));

  // Jobs data as ndjson
  files.set("jobs.ndjson", Buffer.from(jobs.map((j) => JSON.stringify(j)).join("\n"), "utf-8"));
  files.set(
    "attempts.ndjson",
    Buffer.from(allAttempts.map((a) => JSON.stringify(a)).join("\n"), "utf-8"),
  );
  files.set(
    "artifacts.ndjson",
    Buffer.from(allArtifacts.map((a) => JSON.stringify(a)).join("\n"), "utf-8"),
  );
  files.set(
    "results.ndjson",
    Buffer.from(allResults.map((r) => JSON.stringify(r)).join("\n"), "utf-8"),
  );
  files.set(
    "nodes.ndjson",
    Buffer.from(allNodes.map((n) => JSON.stringify(n)).join("\n"), "utf-8"),
  );
  files.set(
    "permissions.ndjson",
    Buffer.from(allPermissions.map((p) => JSON.stringify(p)).join("\n"), "utf-8"),
  );
  files.set(
    "proposals.ndjson",
    Buffer.from(allProposals.map((p) => JSON.stringify(p)).join("\n"), "utf-8"),
  );

  // Users, projects, memberships, quotas, usage
  // External serialization boundary: convert camelCase canonical records
  // to snake_case for the established backup format.
  files.set("users.ndjson", Buffer.from(ndjsonSnake(allUsers), "utf-8"));
  files.set("projects.ndjson", Buffer.from(ndjsonSnake(allProjects), "utf-8"));
  files.set("memberships.ndjson", Buffer.from(ndjsonSnake(allMemberships), "utf-8"));
  files.set("quotas.ndjson", Buffer.from(ndjsonSnake(allQuotas), "utf-8"));
  files.set("usage.ndjson", Buffer.from(ndjsonSnake(allUsageRecords), "utf-8"));

  // logs for each job
  for (const job of jobs) {
    try {
      const logs = await db.getLogs(job.id as string);
      if (logs.length > 0) {
        const logNdjson = logs.map((l) => JSON.stringify(l)).join("\n");
        files.set(
          `logs/${safeArchiveSegment(String(job.id), "job")}.ndjson`,
          Buffer.from(logNdjson, "utf-8"),
        );
      }
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
      // Optional logs table on pre-migration databases.
    }
  }

  // artifacts files if requested
  if (includeArtifacts) {
    for (const artifact of allArtifacts) {
      const artPath = artifact.path as string;
      if (!artPath) throw new Error(`Artifact ${String(artifact.id)} has no path`);
      if (!existsSync(artPath))
        throw new Error(`Artifact ${String(artifact.id)} is missing: ${artPath}`);
      const content = readFileSync(artPath);
      const safeName = `artifacts/${safeArchiveSegment(String(artifact.jobId), "artifact job")}/${safeArchiveSegment(String(artifact.id), "artifact")}_${basename(artPath)}`;
      files.set(safeName, content);
    }
  }

  // Write archive
  const resolvedOutput = resolve(outputPath);
  const outputDir = dirname(resolvedOutput);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const temporaryRoot = mkdtempSync(join(outputDir, ".eigengrid-backup-create-"));
  const tmpDir = join(temporaryRoot, "staging");
  const temporaryArchive = join(temporaryRoot, "archive.tar.gz");
  mkdirSync(tmpDir, { mode: 0o700 });

  try {
    // Write files to temp dir
    for (const [filePath, content] of files) {
      const fullPath = join(tmpDir, filePath);
      const dir = dirname(fullPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, content);
    }

    // Scientific CAS is not an optional presentation artifact: every object
    // referenced by the frozen evidence catalog is streamed and re-hashed.
    const casIndex: ScientificCasIndex = {
      format: "eigengrid-scientific-cas",
      formatVersion: 1,
      hashAlgorithm: "sha256",
      objects: [],
    };
    for (const object of scientificCasObjects) {
      const archivePath = scientificCasArchivePath(object.digest);
      const fullPath = join(tmpDir, archivePath);
      mkdirSync(dirname(fullPath), { recursive: true, mode: 0o700 });
      const sizeBytes = await stageScientificCasObject(
        options.contentAddressedStore!,
        object.digest,
        fullPath,
        ARCHIVE_PREFLIGHT_LIMITS.maxRegularFileBytes,
      );
      if (object.expectedSizeBytes !== undefined && object.expectedSizeBytes !== sizeBytes) {
        throw new Error(`Scientific CAS object ${object.digest} disagrees with its evidence size`);
      }
      casIndex.objects.push({
        digest: object.digest,
        uri: object.uri,
        archivePath,
        sizeBytes,
        evidenceIds: object.evidenceIds,
      });
    }
    const casIndexBytes = Buffer.from(JSON.stringify(casIndex, null, 2), "utf-8");
    if (casIndexBytes.byteLength > BACKUP_CONTROL_FILE_MAX_BYTES) {
      throw new Error("cas/index.json exceeds 1 MiB limit");
    }
    files.set("cas/index.json", casIndexBytes);
    mkdirSync(join(tmpDir, "cas"), { recursive: true, mode: 0o700 });
    writeFileSync(join(tmpDir, "cas/index.json"), casIndexBytes, { mode: 0o600 });

    const checksumLines = Array.from(files, ([filePath, content]) =>
      checksumEntry(filePath, content),
    );
    for (const object of casIndex.objects) {
      checksumLines.push(`${object.digest}  ${object.archivePath}`);
    }
    checksumLines.sort();
    const checksumBytes = Buffer.from(checksumLines.join("\n"), "utf-8");
    writeFileSync(join(tmpDir, "checksums.sha256"), checksumBytes, { mode: 0o600 });

    const archivePaths = [
      ...files.keys(),
      ...casIndex.objects.map((object) => object.archivePath),
      "checksums.sha256",
    ].sort();
    if (archivePaths.length > ARCHIVE_PREFLIGHT_LIMITS.maxEntries) {
      throw new Error("Backup exceeds archive entry limit");
    }
    let expandedBytes = checksumBytes.byteLength;
    for (const [path, content] of files) {
      if (content.byteLength > ARCHIVE_PREFLIGHT_LIMITS.maxRegularFileBytes) {
        throw new Error(`Backup entry exceeds regular-file limit: ${path}`);
      }
      expandedBytes += content.byteLength;
    }
    for (const object of casIndex.objects) expandedBytes += object.sizeBytes;
    if (
      !Number.isSafeInteger(expandedBytes) ||
      expandedBytes > ARCHIVE_PREFLIGHT_LIMITS.maxExpandedRegularFileBytes
    ) {
      throw new Error("Backup exceeds expanded-size limit");
    }

    // Build and fully verify a private sibling before one atomic publication.
    await tar.create(
      {
        file: temporaryArchive,
        cwd: tmpDir,
        gzip: true,
        portable: true,
      },
      archivePaths,
    );
    chmodSync(temporaryArchive, 0o600);
    const totalSizeBytes = statSync(temporaryArchive).size;
    if (totalSizeBytes > ARCHIVE_PREFLIGHT_LIMITS.maxCompressedBytes) {
      throw new Error("Backup exceeds compressed-size limit");
    }
    await withPreflightedArchive(temporaryArchive, async (stable, context) => {
      const verified = await verifyStagedArchive(stable, context.root);
      if (verified.checksumErrors.length > 0) {
        throw new Error(
          `Created backup failed verification: ${verified.checksumErrors.join("; ")}`,
        );
      }
    });
    syncFile(temporaryArchive);
    syncDirectory(temporaryRoot);
    syncDirectory(outputDir);
    renameSync(temporaryArchive, resolvedOutput);
    syncDirectory(outputDir);

    return { backupPath: resolvedOutput, fileCount: archivePaths.length, totalSizeBytes };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

/**
 * Inspect a backup archive and return its metadata.
 */
export async function inspectBackup(backupFile: string): Promise<BackupInfo> {
  if (!existsSync(backupFile)) {
    throw new Error(`Backup file not found: ${backupFile}`);
  }

  const resolved = resolve(backupFile);
  const { staged, totalSizeBytes } = await withPreflightedArchive(
    resolved,
    async (stable, context) => ({
      staged: await verifyStagedArchive(stable, context.root, { collectPaths: true }),
      totalSizeBytes: context.compressedBytes,
    }),
  );

  // Read manifest
  const manifestBuffer = staged.manifest;
  if (!manifestBuffer) {
    throw new Error("Invalid backup: missing manifest.json");
  }

  const manifest: BackupManifest = JSON.parse(manifestBuffer.toString("utf-8"));

  return {
    manifest,
    fileCount: staged.files,
    totalSizeBytes,
    checksumValid: staged.checksumErrors.length === 0,
    files: staged.paths ?? [],
  };
}

/**
 * Restore a backup to a target directory.
 */
export async function restoreBackup(
  backupFile: string,
  options: {
    targetDir: string;
    dryRun?: boolean;
    force?: boolean;
    dbPath?: string;
  },
): Promise<RestoreValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!existsSync(backupFile)) {
    errors.push(`Backup file not found: ${backupFile}`);
    return {
      ok: false,
      errors,
      warnings,
      checksumValid: false,
      archiveSafe: false,
      schemaCompatible: false,
      targetExists: false,
      targetHasActiveDb: false,
      fileCount: 0,
      totalSizeBytes: 0,
    };
  }

  const resolvedTarget = resolve(options.targetDir);
  const targetExistedBeforeRestore = existsSync(resolvedTarget);
  const targetValidation = validateRestoreTarget(resolvedTarget);
  if (!targetValidation.ok) errors.push(...targetValidation.errors);
  warnings.push(...targetValidation.warnings);
  errors.push(...validateRestoreDestination(resolvedTarget));
  const targetHasActiveDb = options.dbPath ? existsSync(options.dbPath) : false;
  if (!options.dryRun) {
    warnings.push(
      targetExistedBeforeRestore
        ? "Existing restore targets are updated per file; rollback is not guaranteed if materialization fails."
        : "Restore publication is per file; a failed materialization leaves already-published files for explicit operator recovery.",
    );
  }
  if (targetHasActiveDb && options.force !== true)
    errors.push("Active database detected at target. Use --force to overwrite.");
  let manifest: BackupManifest | undefined,
    staged: Awaited<ReturnType<typeof verifyStagedArchive>>,
    totalSizeBytes = 0;
  try {
    staged = await withPreflightedArchive(
      resolve(backupFile),
      async (stable, context) => {
        totalSizeBytes = context.compressedBytes;
        const verified = await verifyStagedArchive(stable, context.root, { restoreEntries: true });
        if (!verified.manifest) errors.push("Invalid backup: missing manifest.json");
        try {
          if (verified.manifest) manifest = JSON.parse(verified.manifest.toString("utf-8"));
        } catch {
          errors.push("Invalid manifest.json format");
        }
        if (manifest && manifest.formatVersion !== FORMAT_VERSION)
          errors.push(
            `Schema version mismatch: backup is v${manifest.formatVersion}, expected v${FORMAT_VERSION}`,
          );
        errors.push(...verified.checksumErrors);
        if (!options.dryRun && !errors.length)
          try {
            materializeRestore(resolvedTarget, verified.restoreEntries!);
          } catch (error) {
            errors.push(
              `Restore failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        return verified;
      },
      undefined,
      (bytes) => {
        totalSizeBytes = bytes;
      },
    );
  } catch (error) {
    errors.push(`Invalid archive: ${error instanceof Error ? error.message : String(error)}`);
    return {
      ok: false,
      errors,
      warnings,
      checksumValid: false,
      archiveSafe: false,
      schemaCompatible: false,
      targetExists: existsSync(resolvedTarget),
      targetHasActiveDb,
      fileCount: 0,
      totalSizeBytes,
    };
  }

  const archiveSafe = true,
    checksumValid = staged.checksumErrors.length === 0;

  const result = () => ({
    ok: errors.length === 0,
    errors,
    warnings,
    manifest,
    checksumValid,
    archiveSafe,
    schemaCompatible: manifest?.formatVersion === FORMAT_VERSION,
    targetExists: existsSync(resolvedTarget),
    targetHasActiveDb,
    fileCount: staged.files,
    totalSizeBytes,
  });
  if (options.dryRun || errors.length) return result();

  return {
    ok: true,
    errors: [],
    warnings,
    manifest: manifest!,
    checksumValid,
    archiveSafe,
    schemaCompatible: manifest!.formatVersion === FORMAT_VERSION,
    targetExists: true,
    targetHasActiveDb,
    fileCount: staged.files,
    totalSizeBytes,
  };
}

/**
 * Verify backup integrity and return validation result.
 */
export async function verifyBackup(backupFile: string): Promise<RestoreValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!existsSync(backupFile)) {
    errors.push(`Backup file not found: ${backupFile}`);
    return {
      ok: false,
      errors,
      warnings,
      checksumValid: false,
      archiveSafe: false,
      schemaCompatible: false,
      targetExists: false,
      targetHasActiveDb: false,
      fileCount: 0,
      totalSizeBytes: 0,
    };
  }

  const resolved = resolve(backupFile);

  // Copy and validate before extraction so the extracted bytes cannot change.
  let staged: { files: number; manifest?: Buffer; checksumErrors: string[] };
  let totalSizeBytes = 0;
  try {
    staged = await withPreflightedArchive(resolved, async (stable, context) => {
      totalSizeBytes = context.compressedBytes;
      return verifyStagedArchive(stable, context.root);
    });
  } catch (err) {
    errors.push(`Invalid archive: ${err instanceof Error ? err.message : String(err)}`);
    return {
      ok: false,
      errors,
      warnings,
      checksumValid: false,
      archiveSafe: false,
      schemaCompatible: false,
      targetExists: false,
      targetHasActiveDb: false,
      fileCount: 0,
      totalSizeBytes: 0,
    };
  }

  // Check manifest
  const manifestBuffer = staged.manifest;
  if (!manifestBuffer) {
    errors.push("Missing manifest.json");
  }

  let archiveSafe = true;

  const checksumValid = staged.checksumErrors.length === 0;
  errors.push(...staged.checksumErrors);

  // Schema compatibility
  let schemaCompatible = true;
  let manifestData: BackupManifest | undefined;
  if (manifestBuffer) {
    try {
      const parsed = JSON.parse(manifestBuffer.toString("utf-8")) as BackupManifest;
      manifestData = parsed;
      if (parsed.formatVersion !== FORMAT_VERSION) {
        schemaCompatible = false;
        warnings.push(`Backup format v${parsed.formatVersion}, current is v${FORMAT_VERSION}`);
      }
    } catch {
      errors.push("Invalid manifest.json format");
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    manifest: manifestData,
    checksumValid,
    archiveSafe,
    schemaCompatible,
    targetExists: false,
    targetHasActiveDb: false,
    fileCount: staged.files,
    totalSizeBytes,
  };
}

// ── External serialization helpers (camelCase → snake_case) ──

/**
 * Convert a camelCase key to snake_case.
 */
function toSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * Convert a camelCase record to a plain snake_case object for
 * external serialization (NDJSON, export bundles).
 */
function toSnakeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[toSnake(key)] = value;
  }
  return out;
}

/**
 * Serialize an array of camelCase typed records as snake_case NDJSON.
 */
function ndjsonSnake(records: unknown[]): string {
  return records.map((r) => JSON.stringify(toSnakeRecord(r as Record<string, unknown>))).join("\n");
}

// ── Helpers ─────────────────────────────────────────────────

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

/**
 * Extract DB schema info as JSON.
 */
function extractSchema(db: DatabaseLike): Record<string, unknown> {
  const dbConn = (db as any).ensureDb();
  const tables = dbConn
    .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>;
  const schema: Record<string, unknown> = {};
  for (const table of tables) {
    const safeTableName = table.name.replaceAll('"', '""');
    const columns = dbConn.query(`PRAGMA table_info("${safeTableName}")`).all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    schema[table.name] = columns;
  }
  const migration = dbConn
    .query("SELECT COALESCE(MAX(version), 0) AS version FROM _migrations")
    .get() as { version: number };
  return { tables: schema, migrationVersion: migration.version };
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
