import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { redactDatabaseUrl } from "@eigengrid/db";
import { redactString } from "./redact";

export const POSTGRES_BACKUP_FORMAT = "eigengrid-postgresql-custom" as const;
export const POSTGRES_BACKUP_VERSION = 1 as const;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandExecutor {
  run(
    command: string,
    args: readonly string[],
    options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
  ): Promise<CommandResult>;
}

function defaultExecutor(): CommandExecutor {
  return {
    run(command, args, options = {}) {
      return new Promise<CommandResult>((resolvePromise, reject) => {
        const child = spawn(command, [...args], {
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          env: sanitizeChildEnvironment(options.env),
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
        child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
        const timer = options.timeoutMs
          ? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs)
          : undefined;
        child.once("error", reject);
        child.once("close", (code) => {
          if (timer) clearTimeout(timer);
          resolvePromise({
            exitCode: code ?? 1,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        });
      });
    },
  };
}

const SENSITIVE_CHILD_ENVIRONMENT_NAME =
  /(?:API[_-]?KEY|TOKEN|PASSWORD|PASSFILE|SECRET|PRIVATE[_-]?KEY|CREDENTIAL|LICENSE|DATABASE_URL|SSH_AUTH_SOCK)/iu;

function sanitizeChildEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || SENSITIVE_CHILD_ENVIRONMENT_NAME.test(key)) continue;
    environment[key] = value;
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) continue;
    // PGPASSWORD is explicitly supplied by databaseInvocation and is scoped
    // to this child; all other credential-like overrides remain forbidden.
    if (key !== "PGPASSWORD" && SENSITIVE_CHILD_ENVIRONMENT_NAME.test(key)) continue;
    environment[key] = value;
  }
  return environment;
}

function outputPathFor(path: string): string {
  if (!isAbsolute(path)) throw new Error("PostgreSQL backup outputPath must be absolute");
  const resolved = resolve(path);
  if (resolved === "/" || resolved.endsWith("/"))
    throw new Error("backup outputPath must be a file");
  return resolved;
}

function digestFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface DatabaseInvocation {
  sanitizedUrl: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Keep database credentials out of argv (and therefore process listings).
 * libpq accepts PGPASSWORD for this child-only invocation; the URI retains
 * the non-secret connection identity and is safe to include in diagnostics.
 */
function databaseInvocation(databaseUrl: string): DatabaseInvocation {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("PostgreSQL database URL is invalid");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
    throw new Error("PostgreSQL database URL is invalid");
  let password: string;
  try {
    password = decodeURIComponent(parsed.password);
  } catch {
    throw new Error("PostgreSQL database URL contains an invalid password encoding");
  }
  parsed.password = "";
  // libpq accepts credentials in query parameters too.  Never put those
  // values in argv, process listings, diagnostics, or the manifest.
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (/(?:pass(?:word|file)?|secret|token|api[_-]?key|credential)/iu.test(key)) {
      parsed.searchParams.delete(key);
    }
  }
  return {
    sanitizedUrl: parsed.toString(),
    env: password.length > 0 ? { PGPASSWORD: password } : {},
  };
}

export interface PostgresBackupManifest {
  format: typeof POSTGRES_BACKUP_FORMAT;
  formatVersion: typeof POSTGRES_BACKUP_VERSION;
  createdAt: string;
  database: string;
  archivePath: string;
  archiveSha256: string;
  archiveBytes: number;
  migrationHead: number;
  walPolicy: "site-configured";
}

export interface PostgresBackupRequest {
  databaseUrl: string;
  outputPath: string;
  migrationHead: number;
  pgDumpPath?: string;
  timeoutMs?: number;
  executor?: CommandExecutor;
  now?: () => Date;
}

/**
 * Produce an atomic `pg_dump --format=custom` archive.  The dump is written
 * to a private temporary file, fsynced, and renamed into place only after the
 * command exits successfully.  Database credentials are passed only to the
 * child process and are redacted from all errors and manifests.
 */
export async function createPostgresBackup(
  request: PostgresBackupRequest,
): Promise<{ manifest: PostgresBackupManifest; manifestPath: string }> {
  if (
    !request.databaseUrl.startsWith("postgres://") &&
    !request.databaseUrl.startsWith("postgresql://")
  ) {
    throw new Error("PostgreSQL backup requires a postgres:// or postgresql:// URL");
  }
  const invocation = databaseInvocation(request.databaseUrl);
  if (!Number.isSafeInteger(request.migrationHead) || request.migrationHead < 0)
    throw new Error("migrationHead must be a non-negative integer");
  const outputPath = outputPathFor(request.outputPath);
  const parent = dirname(outputPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stagingDir = join(parent, `.eigengrid-pg-backup-${process.pid}-${Date.now()}`);
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  const staged = join(stagingDir, "archive.dump");
  const executor = request.executor ?? defaultExecutor();
  try {
    const result = await executor.run(
      request.pgDumpPath ?? "pg_dump",
      [
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "--file",
        staged,
        "--dbname",
        invocation.sanitizedUrl,
      ],
      { timeoutMs: request.timeoutMs ?? 120_000, env: invocation.env },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `pg_dump failed for ${redactDatabaseUrl(request.databaseUrl)}: ${redactString(result.stderr).slice(0, 512)}`,
      );
    }
    if (!existsSync(staged) || !statSync(staged).isFile() || statSync(staged).size === 0)
      throw new Error("pg_dump returned success without a non-empty archive");
    const fd = openSync(staged, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(staged, outputPath);
    syncDirectory(parent);
    const archiveSha256 = digestFile(outputPath);
    const manifest: PostgresBackupManifest = {
      format: POSTGRES_BACKUP_FORMAT,
      formatVersion: POSTGRES_BACKUP_VERSION,
      createdAt: (request.now ?? (() => new Date()))().toISOString(),
      database: redactDatabaseUrl(request.databaseUrl),
      archivePath: outputPath,
      archiveSha256,
      archiveBytes: statSync(outputPath).size,
      migrationHead: request.migrationHead,
      walPolicy: "site-configured",
    };
    const manifestPath = `${outputPath}.manifest.json`;
    const tempManifest = `${manifestPath}.tmp-${process.pid}`;
    writeFileSync(tempManifest, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    const manifestFd = openSync(tempManifest, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(manifestFd);
    } finally {
      closeSync(manifestFd);
    }
    renameSync(tempManifest, manifestPath);
    syncDirectory(parent);
    return { manifest, manifestPath };
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function verifyPostgresBackup(
  archivePath: string,
  manifestPath = `${archivePath}.manifest.json`,
): PostgresBackupManifest {
  const archive = outputPathFor(archivePath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PostgresBackupManifest;
  if (
    manifest.format !== POSTGRES_BACKUP_FORMAT ||
    manifest.formatVersion !== POSTGRES_BACKUP_VERSION
  )
    throw new Error("unsupported PostgreSQL backup manifest");
  if (resolve(manifest.archivePath) !== archive)
    throw new Error("backup manifest archive path mismatch");
  if (!existsSync(archive)) throw new Error("PostgreSQL backup archive is missing");
  const digest = digestFile(archive);
  if (digest !== manifest.archiveSha256) throw new Error("PostgreSQL backup checksum mismatch");
  if (statSync(archive).size !== manifest.archiveBytes)
    throw new Error("PostgreSQL backup size mismatch");
  return manifest;
}

export interface PostgresRestoreRequest {
  archivePath: string;
  databaseUrl: string;
  pgRestorePath?: string;
  timeoutMs?: number;
  executor?: CommandExecutor;
  /** Destructive clean/if-exists restore requires an explicit typed token. */
  destructiveConfirmation?: "RESTORE_EXPLICITLY_AUTHORIZED";
}

/** Restore a verified archive with safe argv; no shell or interpolated script is used. */
export async function restorePostgresBackup(
  request: PostgresRestoreRequest,
): Promise<CommandResult> {
  if (
    !request.databaseUrl.startsWith("postgres://") &&
    !request.databaseUrl.startsWith("postgresql://")
  )
    throw new Error("PostgreSQL restore requires a postgres:// or postgresql:// URL");
  const invocation = databaseInvocation(request.databaseUrl);
  verifyPostgresBackup(request.archivePath);
  const args = [
    "--exit-on-error",
    "--single-transaction",
    "--no-owner",
    "--dbname",
    invocation.sanitizedUrl,
  ];
  if (request.destructiveConfirmation === "RESTORE_EXPLICITLY_AUTHORIZED")
    args.splice(1, 0, "--clean", "--if-exists");
  const result = await (request.executor ?? defaultExecutor()).run(
    request.pgRestorePath ?? "pg_restore",
    [...args, request.archivePath],
    { timeoutMs: request.timeoutMs ?? 120_000, env: invocation.env },
  );
  if (result.exitCode !== 0)
    throw new Error(
      `pg_restore failed for ${redactDatabaseUrl(request.databaseUrl)}: ${redactString(result.stderr).slice(0, 512)}`,
    );
  return result;
}

export interface PostgresPitrPolicy {
  recoveryPointObjectiveMinutes?: number;
  recoveryTimeObjectiveMinutes?: number;
  retentionDays: number;
  offHostCopyRequired: boolean;
  owner: string;
  status: "site-pending" | "configured";
}

export function validatePostgresPitrPolicy(value: PostgresPitrPolicy): PostgresPitrPolicy {
  if (!Number.isSafeInteger(value.retentionDays) || value.retentionDays <= 0)
    throw new Error("retentionDays must be positive");
  for (const [name, candidate] of [
    ["recoveryPointObjectiveMinutes", value.recoveryPointObjectiveMinutes],
    ["recoveryTimeObjectiveMinutes", value.recoveryTimeObjectiveMinutes],
  ] as const) {
    if (candidate !== undefined && (!Number.isSafeInteger(candidate) || candidate <= 0))
      throw new Error(`${name} must be positive when configured`);
  }
  if (!value.owner.trim()) throw new Error("PITR owner is required");
  if (
    value.status === "configured" &&
    (value.recoveryPointObjectiveMinutes === undefined ||
      value.recoveryTimeObjectiveMinutes === undefined)
  )
    throw new Error("configured PITR policy requires explicit RPO/RTO");
  return { ...value };
}
