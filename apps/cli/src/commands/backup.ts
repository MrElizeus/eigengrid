import type { CommandModule } from "yargs";
import { loadConfig } from "@eigengrid/config";
import {
  createBackup,
  createPostgresBackup,
  restorePostgresBackup,
  verifyPostgresBackup,
  inspectBackup,
  restoreBackup,
  verifyBackup,
  type BackupContentAddressedStore,
  type BackupManifest,
} from "@eigengrid/backup";
import { ContentAddressedArtifactStore } from "@eigengrid/mission-runtime";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { EIGENGRID_VERSION } from "../version";
import { runWithContext, type ApplicationContext } from "../composition";

// ── Backup command group ────────────────────────────────────

export const backupCommand: CommandModule = {
  command: "backup <action>",
  describe: "Backup and restore operations",
  builder: (y) =>
    y
      .command(backupCreateCommand)
      .command(backupPostgresCreateCommand)
      .command(backupPostgresRestoreCommand)
      .command(backupPostgresVerifyCommand)
      .command(backupInspectCommand)
      .command(backupRestoreCommand)
      .command(backupVerifyCommand)
      .demandCommand(1, "Specify an action: create, inspect, restore, verify"),
  handler: () => {
    // handled by subcommands
  },
};

type PostgresCreateArgs = { output: string; migrationHead: number };
const backupPostgresCreateCommand: CommandModule = {
  command: "postgres-create",
  describe: "Create an atomic PostgreSQL custom-format backup",
  builder: (y) =>
    y
      .option("output", { alias: "o", type: "string", demandOption: true })
      .option("migration-head", { type: "number", default: 18 }),
  async handler(args) {
    const value = args as unknown as PostgresCreateArgs;
    const config = await loadConfig();
    if (config.dbProvider !== "postgres" || !config.databaseUrl)
      throw new Error("PostgreSQL backup requires dbProvider=postgres and DATABASE_URL");
    const result = await createPostgresBackup({
      databaseUrl: config.databaseUrl,
      outputPath: resolve(value.output),
      migrationHead: value.migrationHead,
    });
    console.log(`  ✓ PostgreSQL backup created: ${result.manifest.archivePath}`);
    console.log(`  Manifest: ${result.manifestPath}`);
  },
};

type PostgresRestoreArgs = { backupFile: string; databaseUrl?: string; destructive?: boolean };
const backupPostgresRestoreCommand: CommandModule = {
  command: "postgres-restore <backup-file>",
  describe: "Restore a verified PostgreSQL backup",
  builder: (y) =>
    y
      .positional("backup-file", { type: "string", demandOption: true })
      .option("database-url", { type: "string", describe: "Target URL (otherwise DATABASE_URL)" })
      .option("destructive", {
        type: "boolean",
        default: false,
        describe: "Allow --clean/--if-exists",
      }),
  async handler(args) {
    const value = args as unknown as PostgresRestoreArgs;
    const config = await loadConfig();
    const databaseUrl = value.databaseUrl ?? config.databaseUrl;
    if (!databaseUrl) throw new Error("A target PostgreSQL URL is required");
    await restorePostgresBackup({
      archivePath: resolve(value.backupFile),
      databaseUrl,
      ...(value.destructive
        ? { destructiveConfirmation: "RESTORE_EXPLICITLY_AUTHORIZED" as const }
        : {}),
    });
    console.log("  ✓ PostgreSQL restore completed");
  },
};

const backupPostgresVerifyCommand: CommandModule = {
  command: "postgres-verify <backup-file>",
  describe: "Verify a PostgreSQL archive and sidecar manifest",
  builder: (y) => y.positional("backup-file", { type: "string", demandOption: true }),
  async handler(args) {
    const value = args as unknown as { backupFile: string };
    const manifest = verifyPostgresBackup(resolve(value.backupFile));
    console.log(`  ✓ PostgreSQL backup verified: ${manifest.archiveSha256}`);
  },
};

// ── backup create ───────────────────────────────────────────

export type BackupCreateArgs = {
  output?: string;
  includeArtifacts?: boolean;
  scientificCasRoot?: string;
};

interface CliScientificCasStore extends BackupContentAddressedStore {
  init(): Promise<void>;
  close(): Promise<void>;
}

export interface BackupCreateDependencies {
  runInContext?: (action: (ctx: ApplicationContext) => Promise<void>) => Promise<void>;
  createArchive?: typeof createBackup;
  createScientificCasStore?: (absoluteRoot: string) => CliScientificCasStore;
  write?: (message: string) => void;
}

export const backupCreateCommand: CommandModule = {
  command: "create",
  describe: "Create a full system backup archive",
  builder: (y) =>
    y
      .option("output", {
        alias: "o",
        describe: "Output path for the backup file",
        type: "string",
      })
      .option("include-artifacts", {
        describe: "Include artifact files in the backup",
        type: "boolean",
        default: false,
      })
      .option("scientific-cas-root", {
        describe:
          "Root of the scientific content-addressed store; required when the SQLite snapshot references cas:// evidence",
        type: "string",
      }),
  async handler(args) {
    const { output, includeArtifacts, scientificCasRoot } = args as unknown as BackupCreateArgs;

    try {
      await runBackupCreate({ output, includeArtifacts, scientificCasRoot });
    } catch (err) {
      console.error(`  ✗ Backup failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  },
};

export async function runBackupCreate(
  args: BackupCreateArgs,
  dependencies: BackupCreateDependencies = {},
): Promise<void> {
  const runInContext =
    dependencies.runInContext ??
    ((action: (ctx: ApplicationContext) => Promise<void>) => runWithContext(action));
  const createArchive = dependencies.createArchive ?? createBackup;
  const createScientificCasStore =
    dependencies.createScientificCasStore ??
    ((root: string) => new ContentAddressedArtifactStore(root));
  const write = dependencies.write ?? console.log;

  await runInContext(async (ctx) => {
    if (ctx.db._provider !== "sqlite") {
      throw new Error(
        "Backup archive creation currently requires the SQLite provider; PostgreSQL export is not implemented yet.",
      );
    }

    const absoluteCasRoot = args.scientificCasRoot ? resolve(args.scientificCasRoot) : undefined;
    const contentAddressedStore = absoluteCasRoot
      ? createScientificCasStore(absoluteCasRoot)
      : undefined;
    let operationError: unknown;
    let closeError: unknown;
    let result: Awaited<ReturnType<typeof createBackup>> | undefined;
    try {
      await contentAddressedStore?.init();
      write("  Creating backup...\n");
      result = await createArchive(ctx.db, {
        outputPath: args.output,
        includeArtifacts: args.includeArtifacts,
        dbPath: ctx.config.databasePath,
        version: EIGENGRID_VERSION,
        contentAddressedStore,
      });
    } catch (error) {
      operationError = error;
    } finally {
      try {
        await contentAddressedStore?.close();
      } catch (error) {
        closeError = error;
      }
    }
    if (operationError && closeError) {
      throw new AggregateError(
        [operationError, closeError],
        "Backup creation failed and the scientific CAS store could not be closed",
      );
    }
    if (closeError) throw closeError;
    if (operationError) {
      if (
        !absoluteCasRoot &&
        operationError instanceof Error &&
        operationError.message.includes("no verified content-addressed store")
      ) {
        throw new Error(
          `${operationError.message} Re-run with --scientific-cas-root <path> pointing to the source CAS root.`,
          { cause: operationError },
        );
      }
      throw operationError;
    }
    if (!result) throw new Error("Backup creation completed without a result");
    write(`  ✓ Backup created: ${result.backupPath}`);
    write(`  Files archived: ${result.fileCount}`);
    write(`  Size: ${formatSize(result.totalSizeBytes)}\n`);
  });
}

// ── backup inspect ──────────────────────────────────────────

type BackupInspectArgs = {
  backupFile: string;
};

const backupInspectCommand: CommandModule = {
  command: "inspect <backup-file>",
  describe: "Inspect a backup archive and show its contents",
  builder: (y) =>
    y.positional("backup-file", {
      describe: "Path to the backup file",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    const { backupFile } = args as unknown as BackupInspectArgs;

    if (!existsSync(backupFile)) {
      console.error(`  Backup file not found: ${backupFile}\n`);
      process.exit(1);
    }

    try {
      const info = await inspectBackup(backupFile);

      console.log("\n  Backup Inspection\n");
      console.log(`  Format:      ${info.manifest.format} v${info.manifest.formatVersion}`);
      console.log(`  Created:     ${info.manifest.createdAt}`);
      console.log(`  Version:     ${info.manifest.version}`);
      console.log(`  Artifacts:   ${info.manifest.includeArtifacts ? "included" : "excluded"}`);
      console.log(`  Checksums:   ${info.checksumValid ? "✓ valid" : "✗ invalid"}`);
      console.log(`  Total size:  ${formatSize(info.totalSizeBytes)}`);
      console.log(`  File count:  ${info.fileCount}\n`);

      console.log("  Counts:");
      console.log(`    Jobs:         ${info.manifest.counts.jobs}`);
      console.log(`    Attempts:     ${info.manifest.counts.attempts}`);
      console.log(`    Artifacts:    ${info.manifest.counts.artifacts}`);
      console.log(`    Results:      ${info.manifest.counts.results}`);
      console.log(`    Events:       ${info.manifest.counts.events}`);
      console.log(`    Nodes:        ${info.manifest.counts.nodes}`);
      console.log(`    Permissions:  ${info.manifest.counts.permissions}`);
      console.log(`    Proposals:    ${info.manifest.counts.proposals}`);
      for (const line of scientificCasInspectionLines(info.manifest.counts)) {
        console.log(line);
      }
      console.log("");

      if (info.files.length <= 20) {
        console.log("  Files:");
        for (const f of info.files) {
          console.log(`    ${f}`);
        }
        console.log("");
      } else {
        console.log(`  Files: ${info.files.length} total (use verify for full list)\n`);
      }
    } catch (err) {
      console.error(`  ✗ Inspection failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  },
};

// ── backup restore ──────────────────────────────────────────

type BackupRestoreArgs = {
  backupFile: string;
  target?: string;
  dryRun?: boolean;
  force?: boolean;
};

const backupRestoreCommand: CommandModule = {
  command: "restore <backup-file>",
  describe: "Restore a backup archive to a target directory",
  builder: (y) =>
    y
      .positional("backup-file", {
        describe: "Path to the backup file",
        type: "string",
        demandOption: true,
      })
      .option("target", {
        alias: "t",
        describe: "Target directory for restore",
        type: "string",
        default: ".",
      })
      .option("dry-run", {
        describe: "Validate without writing any files",
        type: "boolean",
        default: false,
      })
      .option("force", {
        describe: "Allow restore even if target has active database",
        type: "boolean",
        default: false,
      }),
  async handler(args) {
    const { backupFile, target, dryRun, force } = args as unknown as BackupRestoreArgs;

    if (!existsSync(backupFile)) {
      console.error(`  Backup file not found: ${backupFile}\n`);
      process.exit(1);
    }

    const config = await loadConfig();
    const resolvedTarget = target ? resolve(target) : ".";

    try {
      const result = await restoreBackup(backupFile, {
        targetDir: resolvedTarget,
        dryRun: dryRun ?? false,
        force: force ?? false,
        dbPath: config.databasePath,
      });

      if (dryRun) {
        console.log("\n  Restore Validation (dry-run)\n");
      } else {
        console.log("\n  Restore Result\n");
      }

      if (result.ok) {
        console.log(`  ✓ Restore ${dryRun ? "validation passed" : "completed"}`);
      } else {
        console.log(`  ✗ Restore ${dryRun ? "validation failed" : "failed"}`);
      }

      console.log(`  Target:      ${resolvedTarget}`);
      console.log(`  Files:       ${result.fileCount}`);
      console.log(`  Size:        ${formatSize(result.totalSizeBytes)}`);
      console.log(`  Checksums:   ${result.checksumValid ? "✓ valid" : "✗ invalid"}`);
      console.log(`  Schema:      ${result.schemaCompatible ? "✓ compatible" : "✗ incompatible"}`);
      console.log(`  Safe:        ${result.archiveSafe ? "✓ pass" : "✗ issues found"}`);
      const casLine = result.ok
        ? scientificCasRestoreLine(result.manifest, resolvedTarget, dryRun ?? false)
        : undefined;
      if (casLine) console.log(casLine);

      if (result.warnings.length > 0) {
        console.log("\n  Warnings:");
        for (const w of result.warnings) {
          console.log(`    ⚠ ${w}`);
        }
      }

      if (result.errors.length > 0) {
        console.log("\n  Errors:");
        for (const e of result.errors) {
          console.log(`    ✗ ${e}`);
        }
      }

      if (!result.ok) {
        process.exit(1);
      }

      console.log("");
    } catch (err) {
      console.error(`  ✗ Restore failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  },
};

// ── backup verify ───────────────────────────────────────────

type BackupVerifyArgs = {
  backupFile: string;
};

const backupVerifyCommand: CommandModule = {
  command: "verify <backup-file>",
  describe: "Verify backup integrity (checksums, format, safety)",
  builder: (y) =>
    y.positional("backup-file", {
      describe: "Path to the backup file",
      type: "string",
      demandOption: true,
    }),
  async handler(args) {
    const { backupFile } = args as unknown as BackupVerifyArgs;

    if (!existsSync(backupFile)) {
      console.error(`  Backup file not found: ${backupFile}\n`);
      process.exit(1);
    }

    try {
      const result = await verifyBackup(backupFile);

      console.log("\n  Backup Verification\n");

      if (result.ok) {
        console.log("  ✓ INTEGRITY PASSED\n");
      } else {
        console.log("  ✗ INTEGRITY FAILED\n");
      }

      console.log(
        `  Format:      ${result.manifest?.format ?? "unknown"} v${result.manifest?.formatVersion ?? "?"}`,
      );
      console.log(`  Created:     ${result.manifest?.createdAt ?? "unknown"}`);
      console.log(`  Files:       ${result.fileCount}`);
      console.log(`  Size:        ${formatSize(result.totalSizeBytes)}`);
      console.log(`  Checksums:   ${result.checksumValid ? "✓ verified" : "✗ mismatch"}`);
      console.log(`  Schema:      ${result.schemaCompatible ? "✓ compatible" : "✗ incompatible"}`);
      console.log(`  Path safety: ${result.archiveSafe ? "✓ safe" : "✗ unsafe paths detected"}`);

      if (result.warnings.length > 0) {
        console.log("\n  Warnings:");
        for (const w of result.warnings) {
          console.log(`    ⚠ ${w}`);
        }
      }

      if (result.errors.length > 0) {
        console.log("\n  Errors:");
        for (const e of result.errors) {
          console.log(`    ✗ ${e}`);
        }
      }

      if (!result.ok) {
        process.exit(1);
      }

      console.log("");
    } catch (err) {
      console.error(
        `  ✗ Verification failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  },
};

// ── Helpers ─────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function scientificCasInspectionLines(counts: BackupManifest["counts"]): string[] {
  const lines: string[] = [];
  if (counts.scientificCasReferences !== undefined) {
    lines.push(`    Scientific CAS references: ${counts.scientificCasReferences}`);
  }
  if (counts.scientificCasObjects !== undefined) {
    lines.push(`    Scientific CAS objects:    ${counts.scientificCasObjects}`);
  }
  return lines;
}

export function scientificCasRestoreLine(
  manifest: BackupManifest | undefined,
  resolvedTarget: string,
  dryRun: boolean,
): string | undefined {
  const objects = manifest?.counts.scientificCasObjects;
  if (objects === undefined) return undefined;
  if (objects === 0) return "  Scientific CAS objects: 0";
  return `  Scientific CAS: ${join(resolvedTarget, "cas")} (${objects} object${
    objects === 1 ? "" : "s"
  }${dryRun ? "; dry-run only" : ""})`;
}
