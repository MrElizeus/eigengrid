import { existsSync, mkdirSync, writeFileSync, accessSync, constants } from "fs";
import { join, dirname } from "path";
import { userInfo } from "os";
import { getEigenGridDir, getConfigPath, readRoleFromConfig } from "@eigengrid/config";
import { createDatabase } from "@eigengrid/db";
import type { DatabaseLike } from "@eigengrid/db";
import type { EigenGridRole } from "@eigengrid/config";
import { ensureHeadSshKey } from "./ssh-key-service";
import { upsertNodeByName } from "./node-service";

export interface InitRoleInput {
  role: EigenGridRole;
  nodeName?: string;
  python?: string;
  database?: string;
  jobsDir?: string;
  logsDir?: string;
  outputsDir?: string;
  sessionsDir?: string;
  sshKeyPath?: string;
  generateSshKey?: boolean;
  remoteDir?: string;
  headHost?: string;
  headUser?: string;
  update?: boolean;
}

export interface InitResult {
  initialized: boolean;
  configPath: string;
  warnings: string[];
  sshKeyCreated?: boolean;
  sshKeyPath?: string;
  scratchReady?: boolean;
}

/**
 * Injectable side-effect boundaries for the initializer.  Production uses
 * the canonical database/node services; tests and embedders can supply an
 * isolated implementation without globally mocking the package module.
 */
export interface InitServiceDependencies {
  createDatabase?: (path: string) => DatabaseLike;
  upsertNodeByName?: typeof upsertNodeByName;
}

function buildConfigLines(input: InitRoleInput): string[] {
  const nodeName = input.nodeName ?? `${input.role}-node`;
  const lines: string[] = [
    `role: ${input.role}`,
    `nodeName: ${nodeName}`,
    `database: ${input.database ?? "eigengrid.sqlite"}`,
    `python: ${input.python ?? "python"}`,
    `jobsDir: ${input.jobsDir ?? "jobs"}`,
    `logsDir: ${input.logsDir ?? "logs"}`,
    `outputsDir: ${input.outputsDir ?? "outputs"}`,
    `sessionsDir: ${input.sessionsDir ?? "sessions"}`,
  ];

  if (input.role === "head") {
    if (input.sshKeyPath) {
      lines.push(`sshKeyPath: ${input.sshKeyPath}`);
    }
    lines.push(`generateSshKey: ${input.generateSshKey ?? true}`);
  }

  if (input.role === "worker") {
    if (input.remoteDir) lines.push(`remoteDir: ${input.remoteDir}`);
    if (input.headHost) lines.push(`headHost: ${input.headHost}`);
    if (input.headUser) lines.push(`headUser: ${input.headUser}`);
  }

  return lines;
}

export async function initProject(
  input: InitRoleInput,
  dependencies: InitServiceDependencies = {},
): Promise<InitResult> {
  const dir = getEigenGridDir();
  const configPath = getConfigPath();
  const warnings: string[] = [];

  // ── Check existing config (idempotence) ─────────────────
  let shouldWrite = !existsSync(configPath);

  if (!shouldWrite) {
    const existingRole = readRoleFromConfig();

    if (existingRole === null) {
      // Old config without role field — upgrade
      shouldWrite = true;
      warnings.push("Upgrading existing config with role field");
    } else if (existingRole !== input.role) {
      if (!input.update) {
        throw new Error(
          `Role "${input.role}" differs from existing "${existingRole}". Use --update to change.`,
        );
      }
      warnings.push(`Changing role from "${existingRole}" to "${input.role}"`);
      shouldWrite = true;
    } else if (input.update) {
      // Same role but --update flag: rewrite with new options
      shouldWrite = true;
    }
  }

  // ── Build resolved paths ───────────────────────────────
  const nodeName = input.nodeName ?? `${input.role}-node`;
  const database = input.database ?? "eigengrid.sqlite";
  const python = input.python ?? "python";
  const jobsDir = input.jobsDir ?? "jobs";
  const logsDir = input.logsDir ?? "logs";
  const outputsDir = input.outputsDir ?? "outputs";
  const sessionsDir = input.sessionsDir ?? "sessions";

  // Ensure .eigengrid directory exists
  mkdirSync(dir, { recursive: true });

  // ── Write config ───────────────────────────────────────
  if (shouldWrite) {
    const lines = buildConfigLines({
      ...input,
      nodeName,
      database,
      python,
      jobsDir,
      logsDir,
      outputsDir,
      sessionsDir,
    });
    writeFileSync(configPath, lines.join("\n") + "\n");
  }

  // ── Create directories ─────────────────────────────────
  const absDatabaseDir = dirname(join(dir, database));
  const absJobsDir = join(dir, jobsDir);
  const absLogsDir = join(dir, logsDir);
  const absOutputsDir = join(dir, outputsDir);
  const absSessionsDir = join(dir, sessionsDir);

  mkdirSync(absDatabaseDir, { recursive: true });
  mkdirSync(absJobsDir, { recursive: true });
  mkdirSync(absLogsDir, { recursive: true });
  mkdirSync(absOutputsDir, { recursive: true });
  mkdirSync(absSessionsDir, { recursive: true });

  // ── Check for missing dirs (warn on idempotent re-run) ─
  if (!shouldWrite) {
    if (!existsSync(absJobsDir)) warnings.push(`Missing directory: ${absJobsDir}`);
    if (!existsSync(absLogsDir)) warnings.push(`Missing directory: ${absLogsDir}`);
    if (!existsSync(absOutputsDir)) warnings.push(`Missing directory: ${absOutputsDir}`);
    if (!existsSync(absSessionsDir)) warnings.push(`Missing directory: ${absSessionsDir}`);
  }

  // ── Initialize database ────────────────────────────────
  const db = (dependencies.createDatabase ?? createDatabase)(join(dir, database));
  await db.init();

  // ── Create local node for standalone/head ──────────────
  if (input.role === "standalone" || input.role === "head") {
    const result = await (dependencies.upsertNodeByName ?? upsertNodeByName)(db, {
      name: nodeName,
      host: "localhost",
      user: userInfo().username,
      runner: "local",
    });
    if (result.created) {
      // Node created — first-time init
    }
  }

  // ── SSH key generation (P5-04) ────────────────────────
  let sshKeyCreated: boolean | undefined;
  let sshKeyPath: string | undefined;
  if (input.role === "head") {
    const sshResult = await ensureHeadSshKey({
      generate: input.generateSshKey,
      sshKeyPath: input.sshKeyPath,
      nodeName,
    });
    sshKeyCreated = sshResult.created;
    sshKeyPath = sshResult.keyPath;
    warnings.push(...sshResult.warnings);
  }

  // ── Remote scratch dir (P5-05) ────────────────────────
  let scratchReady: boolean | undefined;
  if (input.role === "worker" && input.remoteDir) {
    try {
      mkdirSync(input.remoteDir, { recursive: true });
      try {
        accessSync(input.remoteDir, constants.W_OK);
        scratchReady = true;
      } catch {
        scratchReady = false;
        warnings.push(
          `Remote scratch directory "${input.remoteDir}" is not writable. ` +
            `Ensure permissions are correct before running worker jobs.`,
        );
      }
    } catch {
      scratchReady = false;
      warnings.push(
        `Could not create remote scratch directory "${input.remoteDir}". ` +
          `Create it manually with: mkdir -p "${input.remoteDir}"`,
      );
    }
  }

  return {
    initialized: true,
    configPath,
    warnings,
    sshKeyCreated,
    sshKeyPath,
    scratchReady,
  };
}
