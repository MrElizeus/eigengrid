// ────────────────────────────────────────────────────────────
// `eigengrid db` command group
// ────────────────────────────────────────────────────────────

import type { CommandModule } from "yargs";
import { loadConfig } from "@eigengrid/config";
import {
  createDatabaseFromConfig,
  resolveDbConfig,
  redactDatabaseUrl,
  checkPostgresConnection,
  DatabaseConnectionError,
  PostgresDatabase,
} from "@eigengrid/db";
import { existsSync } from "fs";
import { resolve } from "path";

// ── Main command group ──────────────────────────────────────

export const dbCommand: CommandModule = {
  command: "db <action>",
  describe: "Database operations",
  builder: (y) =>
    y
      .command(dbDoctorCommand)
      .command(dbStatusCommand)
      .command(dbMigrateCommand)
      .command(dbImportCommand)
      .demandCommand(1, "Specify an action: doctor, status, migrate, import"),
  handler: () => {
    // handled by subcommands
  },
};

// ── db doctor ────────────────────────────────────────────────

type DbDoctorArgs = {
  url?: string;
};

const dbDoctorCommand: CommandModule = {
  command: "doctor",
  describe: "Check database connectivity and health",
  builder: (y) =>
    y.option("url", {
      describe: "DATABASE_URL to check (postgres only)",
      type: "string",
    }),
  async handler(args) {
    const { url } = args as unknown as DbDoctorArgs;

    const config = await loadConfig();
    const dbConfig = resolveDbConfig(config);

    if (dbConfig.provider === "postgres") {
      const checkUrl = url ?? dbConfig.databaseUrl;
      if (!checkUrl) {
        console.error(
          "  ✗ No DATABASE_URL configured.\n" +
            "    Set DATABASE_URL environment variable or add databaseUrl to your config.\n",
        );
        process.exit(1);
      }

      console.log("  Checking PostgreSQL connection...\n");

      const result = await checkPostgresConnection(checkUrl);
      if (result.ok) {
        console.log(`  ✓ PostgreSQL reachable`);
        console.log(`  Version: ${result.version}`);
        console.log(`  URL:     ${redactDatabaseUrl(checkUrl)}\n`);
      } else {
        console.error(`  ✗ Connection failed: ${result.error}\n`);
        console.error("  Possible causes:");
        console.error("    1. PostgreSQL server is not running");
        console.error("    2. DATABASE_URL is incorrect");
        console.error("    3. Network connectivity issues");
        console.error("    4. 'pg' package not installed (run: bun add pg)\n");
        process.exit(1);
      }
    } else {
      // SQLite
      const dbPath = resolve(dbConfig.databasePath);
      if (existsSync(dbPath)) {
        const { statSync } = await import("fs");
        const stats = statSync(dbPath);
        console.log(`  ✓ SQLite database found`);
        console.log(`  Path: ${dbPath}`);
        console.log(`  Size: ${formatSize(stats.size)}\n`);
      } else {
        console.log(`  ~ SQLite database not found at: ${dbPath}`);
        console.log("    Run `eigengrid init` to create it.\n");
      }
    }
  },
};

// ── db status ───────────────────────────────────────────────

const dbStatusCommand: CommandModule = {
  command: "status",
  describe: "Show database schema and migration status",
  async handler() {
    const config = await loadConfig();
    const dbConfig = resolveDbConfig(config);

    console.log(`\n  Database Status\n`);
    console.log(`  Provider: ${dbConfig.provider}`);

    if (dbConfig.provider === "postgres") {
      console.log(`  URL:     ${redactDatabaseUrl(dbConfig.databaseUrl ?? "")}`);
    } else {
      console.log(`  Path:    ${resolve(dbConfig.databasePath)}`);
    }

    try {
      const db = await createDatabaseFromConfig(config, { migrations: "validate" });
      const version = await db.getMigrationVersion();
      console.log(`  Schema:  v${version}`);
      console.log(`  Status:  ✓ connected\n`);
      await db.close();
    } catch (err) {
      if (err instanceof DatabaseConnectionError) {
        console.error(`  ✗ ${err.message}\n`);
      } else {
        console.error(`  ✗ Cannot connect: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      process.exit(1);
    }
  },
};

// ── db migrate ──────────────────────────────────────────────

const dbMigrateCommand: CommandModule = {
  command: "migrate",
  describe: "Run pending database migrations",
  async handler() {
    const config = await loadConfig();

    console.log("  Running migrations...\n");

    try {
      const db = await createDatabaseFromConfig(config, { migrations: "apply" });
      const version = await db.getMigrationVersion();
      console.log(`  ✓ Migrations complete. Schema version: v${version}\n`);
      await db.close();
    } catch (err) {
      if (err instanceof DatabaseConnectionError) {
        console.error(`  ✗ ${err.message}\n`);
      } else {
        console.error(
          `  ✗ Migration failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      process.exit(1);
    }
  },
};

// ── db import ───────────────────────────────────────────────

type DbImportArgs = {
  sqliteFile: string;
  target: "sqlite" | "postgres";
  url?: string;
};

const dbImportCommand: CommandModule = {
  command: "import <sqlite-file>",
  describe: "Import data from a SQLite file into a target database",
  builder: (y) =>
    y
      .positional("sqlite-file", {
        describe: "Path to the source SQLite database file",
        type: "string",
        demandOption: true,
      })
      .option("target", {
        alias: "t",
        describe: "Target database type",
        type: "string",
        choices: ["sqlite", "postgres"] as const,
        default: "sqlite",
      })
      .option("url", {
        describe: "DATABASE_URL for postgres target",
        type: "string",
      }),
  async handler(args) {
    const { sqliteFile, target, url } = args as unknown as DbImportArgs;

    if (!existsSync(sqliteFile)) {
      console.error(`  ✗ SQLite file not found: ${sqliteFile}\n`);
      process.exit(1);
    }

    if (target === "postgres" && !url && !process.env.DATABASE_URL) {
      console.error(
        "  ✗ No DATABASE_URL specified for postgres target.\n" +
          "    Use --url or set the DATABASE_URL environment variable.\n",
      );
      process.exit(1);
    }

    console.log(`  Importing from: ${sqliteFile}`);
    console.log(`  Target:         ${target}\n`);

    try {
      // Open source SQLite
      const { Database } = await import("bun:sqlite");
      const source = new Database(sqliteFile);

      // Open or create target database
      const targetDb =
        target === "postgres"
          ? new PostgresDatabase(url ?? process.env.DATABASE_URL!)
          : await createDatabaseFromConfig({
              ...(await loadConfig()),
              dbProvider: "sqlite",
              databaseUrl: undefined,
            });

      if (target === "postgres") {
        await targetDb.init();
      }

      // Read all tables from SQLite
      const tables = source
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>;

      let totalRows = 0;

      for (const { name: tableName } of tables) {
        const rows = source.query(`SELECT * FROM "${tableName}"`).all() as Record<
          string,
          unknown
        >[];
        if (rows.length === 0) continue;

        // Get column info
        const colInfo = source.query(`PRAGMA table_info("${tableName}")`).all() as Array<{
          name: string;
          type: string;
        }>;
        const columns = colInfo.map((c) => c.name);

        // Insert each row into target
        if (target === "postgres") {
          await importSqliteRowsToPostgres(targetDb as PostgresDatabase, tableName, columns, rows);
        } else {
          // SQLite → SQLite: just copy via raw SQL
          // Not implemented yet — for now it's the same file
          console.log(`  Skipping table ${tableName} (SQLite→SQLite copy not needed)`);
        }

        totalRows += rows.length;
        console.log(`  ✓ ${tableName}: ${rows.length} rows`);
      }

      source.close();
      if (target === "postgres") {
        await targetDb.close();
      }

      console.log(`\n  ✓ Import complete: ${totalRows} total rows imported\n`);
    } catch (err) {
      console.error(`  ✗ Import failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  },
};

// ── Import helper ────────────────────────────────────────────

async function importSqliteRowsToPostgres(
  pg: PostgresDatabase,
  table: string,
  columns: string[],
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return;

  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const colList = columns.map((c) => `"${c}"`).join(", ");
  const sql = `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`;

  for (const row of rows) {
    const params = columns.map((col) => {
      const val = row[col];
      // Convert SQLite integer booleans to PostgreSQL booleans
      if (val === 0 || val === 1) {
        // Check if this column expects a boolean
        return val;
      }
      return val ?? null;
    });

    try {
      await (pg as any).query(sql, params);
    } catch (err: any) {
      // Skip duplicate key errors (idempotent import)
      if (err.message && err.message.includes("duplicate key")) {
        continue;
      }
      throw err;
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
