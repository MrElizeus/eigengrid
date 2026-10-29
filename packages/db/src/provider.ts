// ────────────────────────────────────────────────────────────
// Database provider factory — returns the correct adapter
// based on configuration
// ────────────────────────────────────────────────────────────

import type { DbProvider, Config } from "@eigengrid/core";
import type { DatabaseLike } from "./client";
import { SqliteDatabase } from "./migrate";
import { PostgresDatabase, type PostgresDatabaseOptions } from "./postgres/client";

// ── Errors ─────────────────────────────────────────────────

export class DatabaseConnectionError extends Error {
  constructor(
    message: string,
    public readonly provider: DbProvider,
    public readonly actionable: boolean = false,
  ) {
    super(message);
    this.name = "DatabaseConnectionError";
  }
}

// ── URL redaction ──────────────────────────────────────────

/**
 * Redact DATABASE_URL for safe logging/display.
 * Preserves `postgres://user:***@host:port/dbname`.
 */
export function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return url;
    if (!parsed.username && !parsed.password) return url;
    parsed.password = "***";
    return parsed.toString();
  } catch {
    // Preserve a safe fallback for malformed URLs found in log lines.
    return url.replace(/(postgres(?:ql)?:\/\/[^\s/:@]+:)[^\s/?#]*(@)/gi, "$1***$2");
  }
}

// ── Config validation ──────────────────────────────────────

export interface DbConfig {
  provider: DbProvider;
  databasePath: string;
  databaseUrl?: string;
  production: boolean;
}

export function resolveDbConfig(config: Config, env: NodeJS.ProcessEnv = process.env): DbConfig {
  const provider: DbProvider = config.dbProvider ?? "sqlite";
  const profile = env.EIGENGRID_DEPLOYMENT_PROFILE ?? "development";
  if (profile !== "development" && profile !== "production") {
    throw new DatabaseConnectionError("Unknown EIGENGRID_DEPLOYMENT_PROFILE", provider, true);
  }
  const production = profile === "production";
  if (production && provider !== "postgres") {
    throw new DatabaseConnectionError(
      "Production requires explicit dbProvider: postgres; SQLite is development-only",
      provider,
      true,
    );
  }

  if (provider === "postgres") {
    const url = config.databaseUrl ?? env.DATABASE_URL;
    if (!url) {
      throw new DatabaseConnectionError(
        "PostgreSQL provider selected but DATABASE_URL is not set. " +
          "Set the DATABASE_URL environment variable or add 'databaseUrl' to your config.",
        provider,
        true,
      );
    }
    return { provider, databasePath: config.databasePath, databaseUrl: url, production };
  }

  // SQLite default
  return { provider: "sqlite", databasePath: config.databasePath, production };
}

// ── Factory ────────────────────────────────────────────────

/**
 * Create a database adapter based on the application config.
 *
 * SQLite is the default. If dbProvider is "postgres", a PostgreSQL
 * adapter is returned using the DATABASE_URL connection string.
 *
 * Usage:
 *   const config = await loadConfig();
 *   const db = createDatabaseFromConfig(config);
 *   await db.init();
 */
export async function createDatabaseFromConfig(
  config: Config,
  options: PostgresDatabaseOptions = {},
): Promise<DatabaseLike> {
  const dbConfig = resolveDbConfig(config);

  if (dbConfig.provider === "postgres") {
    try {
      const db = new PostgresDatabase(dbConfig.databaseUrl!, {
        migrations: options.migrations ?? (dbConfig.production ? "validate" : "apply"),
      });
      await db.init();
      return db;
    } catch (err) {
      if (err instanceof DatabaseConnectionError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new DatabaseConnectionError(
        `Cannot connect to PostgreSQL: ${message}\n\n` +
          "Possible causes:\n" +
          "  1. PostgreSQL server is not running\n" +
          "  2. DATABASE_URL is incorrect\n" +
          "  3. Network connectivity issues\n" +
          "  4. 'pg' package is not installed (install with: bun add pg)\n\n" +
          "  5. Schema is not migrated or the database role lacks the required permissions\n" +
          (dbConfig.production
            ? "Production stays closed until PostgreSQL and the release schema are healthy."
            : "SQLite is available only for development; set dbProvider: sqlite explicitly."),
        "postgres",
        true,
      );
    }
  }

  // SQLite
  const db = new SqliteDatabase(dbConfig.databasePath);
  await db.init();
  return db;
}

/**
 * Check if a PostgreSQL connection is available.
 */
export async function checkPostgresConnection(url: string): Promise<{
  ok: boolean;
  error?: string;
  version?: string;
}> {
  let pool: import("pg").Pool | undefined;
  try {
    const pg = await import("pg");
    const { Pool } = pg;
    pool = new Pool({
      connectionString: url,
      max: 1,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
    });
    const client = await pool.connect();
    try {
      const result = await client.query("SELECT version()");
      const version = result.rows[0]?.version ?? "unknown";
      return { ok: true, version: String(version) };
    } finally {
      client.release();
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await pool?.end();
  }
}
