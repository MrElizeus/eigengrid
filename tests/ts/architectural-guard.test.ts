// ────────────────────────────────────────────────────────────
// Architectural guard: verify no migrated command file
// reintroduces direct createDatabase composition.
// ────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const COMMANDS_DIR = join(import.meta.dir, "../../apps/cli/src/commands");

/**
 * Return the canonical basename for a migrated command file.
 */
const MIGRATED_FILES = [
  "submit.ts",
  "status.ts",
  "show.ts",
  "logs.ts",
  "artifacts.ts",
  "collect.ts",
  "parse.ts",
  "approve.ts",
  "diagnose.ts",
  "events.ts",
  "execute.ts",
  "export.ts",
  "node.ts",
  "project.ts",
  "quota.ts",
  "results.ts",
  "scheduler.ts",
  "timeline.ts",
  "usage.ts",
  "user.ts",
];

/**
 * Patterns that must NOT appear in migrated command files.
 *
 * Value imports of `createDatabase` from @eigengrid/db are forbidden.
 * Type-only `import type { DatabaseLike }` is allowed because it is a
 * provider-neutral interface, not the SQLite constructor.
 */
const FORBIDDEN_PATTERNS = [
  // Value import of createDatabase
  /\bcreateDatabase\b/,
  /\bensureDb\b/,
  // Value import from @eigengrid/db (exclude type-only imports)
  /import\s+\{[^}]*\bcreateDatabase\b[^}]*\}\s*from\s+["']@eigengrid\/db["']/,
  // import * as ... from @eigengrid/db
  /import\s+\*\s+as\s+\w+\s+from\s+["']@eigengrid\/db["']/,
  // Default import from @eigengrid/db
  /import\s+\w+\s+from\s+["']@eigengrid\/db["']/,
  // Dynamic import of @eigengrid/db
  /import\(["']@eigengrid\/db["']\)/,
];

// Also forbid `loadConfig` value import from `@eigengrid/config`
FORBIDDEN_PATTERNS.push(
  /import\s+\{[^}]*\bloadConfig\b[^}]*\}\s*from\s+["']@eigengrid\/config["']/,
  /import\s+\w+\s+from\s+["']@eigengrid\/config["']/,
);

/**
 * Also forbid raw SQLite SQL in command files.
 */
const SQLITE_SQL = /\bINSERT\s+INTO\s+\w+\b/i;

describe("architectural guard — WU-03 patterns", () => {
  test("execution-coordinator.ts does not import LocalRunner", () => {
    const content = readFileSync(
      join(import.meta.dir, "../../apps/cli/src/services/execution-coordinator.ts"),
      "utf8",
    );
    expect(content).not.toMatch(/import.*LocalRunner.*from/);
    expect(content).not.toMatch(/new\s+LocalRunner/);
  });

  test("submit-service.ts does not export defaultRunnerFactory", () => {
    const content = readFileSync(
      join(import.meta.dir, "../../apps/cli/src/services/submit-service.ts"),
      "utf8",
    );
    expect(content).not.toMatch(/defaultRunnerFactory/);
  });

  test("submit.ts does not import defaultRunnerFactory", () => {
    const content = readFileSync(
      join(import.meta.dir, "../../apps/cli/src/commands/submit.ts"),
      "utf8",
    );
    expect(content).not.toMatch(/defaultRunnerFactory/);
  });

  test("no db as any in coordinator or submit-service", () => {
    for (const file of ["execution-coordinator.ts", "submit-service.ts"]) {
      const content = readFileSync(
        join(import.meta.dir, `../../apps/cli/src/services/${file}`),
        "utf8",
      );
      const lines = content.split("\n");
      const dbAsAnyLines = lines.filter(
        (l) => /db\s+as\s+any/.test(l) || /\bas\s+any\b.*db/.test(l),
      );
      expect(dbAsAnyLines).toEqual([]);
    }
  });

  test("no as never in coordinator or submit-service", () => {
    for (const file of ["execution-coordinator.ts", "submit-service.ts"]) {
      const content = readFileSync(
        join(import.meta.dir, `../../apps/cli/src/services/${file}`),
        "utf8",
      );
      expect(content).not.toMatch(/as\s+never/);
    }
  });

  test("no shell: true in local runner", () => {
    const content = readFileSync(
      join(import.meta.dir, "../../packages/runners/src/local.ts"),
      "utf8",
    );
    expect(content).not.toMatch(/shell:\s*true/);
  });

  test("no ensureAttempt or latest-attempt inference in coordinator", () => {
    const content = readFileSync(
      join(import.meta.dir, "../../apps/cli/src/services/execution-coordinator.ts"),
      "utf8",
    );
    expect(content).not.toMatch(/ensureAttempt/);
  });
});

// ────────────────────────────────────────────────────────────
// Architectural guard — WU-08 dashboard boundaries
// ────────────────────────────────────────────────────────────

const DASHBOARD_TUI_FILES = [
  "apps/cli/src/tui/App.tsx",
  "apps/cli/src/tui/components/JobList.tsx",
  "apps/cli/src/tui/components/NodeList.tsx",
  "apps/cli/src/tui/components/LogViewer.tsx",
  "apps/cli/src/tui/components/DashboardStatusBar.tsx",
  "apps/cli/src/tui/dashboard/dashboard-controller.ts",
];

const DASHBOARD_FORBIDDEN_PATTERNS = [
  // Concrete DB adapter/constructor identifiers
  /\bSqliteDatabase\b/,
  /\bPostgresDatabase\b/,
  /\bcreateDatabase\b/,
  /\bensureDb\b/,
  // Provider selection
  /\b_provider\b/,
  // Raw SQL statements
  /\bINSERT\s+INTO\b/i,
  /\bUPDATE\s+\w+/i,
  /\bDELETE\s+FROM\b/i,
  /\bSELECT\s+\*\s+FROM\b/i,
  // Composition root / config must not leak into the TUI
  /\bcreateApplicationContext\b/,
  /\bloadConfig\b/,
];

const DASHBOARD_DB_VALUE_IMPORT = /import\s+(?!type\s)[\s\S]*?from\s+["']@eigengrid\/db["']/;

describe("architectural guard — WU-08 dashboard boundaries", () => {
  test("TUI dashboard files never touch concrete DB, raw SQL, or providers", () => {
    for (const rel of DASHBOARD_TUI_FILES) {
      const content = readFileSync(join(import.meta.dir, `../../${rel}`), "utf8");
      for (const pattern of DASHBOARD_FORBIDDEN_PATTERNS) {
        expect(content.match(pattern), `${rel} must not contain ${pattern}`).toBeNull();
      }
      expect(
        content.match(DASHBOARD_DB_VALUE_IMPORT),
        `${rel} must not value-import @eigengrid/db`,
      ).toBeNull();
    }
  });

  test("dashboard command owns context lifecycle and never reads the DB directly", () => {
    const content = readFileSync(
      join(import.meta.dir, "../../apps/cli/src/commands/dashboard.ts"),
      "utf8",
    );
    expect(content).not.toMatch(/createDatabase/);
    expect(content).not.toMatch(/SqliteDatabase|PostgresDatabase/);
    expect(content).not.toMatch(/INSERT\s+INTO/i);
    // Context creation/close is delegated to runWithContext.
    expect(content).toMatch(/runWithContext/);
  });

  test("dashboard data source boundary is the only fetch path from the TUI", () => {
    const typesContent = readFileSync(
      join(import.meta.dir, "../../apps/cli/src/composition/types.ts"),
      "utf8",
    );
    expect(typesContent).toMatch(/interface DashboardDataSource/);
    expect(typesContent).toMatch(/fetch\(options\??:/);
    // The boundary must not declare any mutation operations.
    expect(typesContent).not.toMatch(
      /interface DashboardDataSource[\s\S]*?(create|update|delete|save|append)/,
    );
  });
});

describe("architectural guard — no createDatabase in migrated commands", () => {
  for (const file of MIGRATED_FILES) {
    test(`${file} does not import or call createDatabase`, () => {
      const content = readFileSync(join(COMMANDS_DIR, file), "utf8");

      for (const pattern of FORBIDDEN_PATTERNS) {
        const match = content.match(pattern);
        if (match) {
          expect(match, `${file} contains forbidden pattern: ${pattern}`).toBeNull();
        }
      }

      // Check no raw SQLite SQL
      const sqlMatch = content.match(SQLITE_SQL);
      expect(
        sqlMatch,
        `${file} contains raw SQLite SQL: ${sqlMatch ? sqlMatch[0] : "none"}`,
      ).toBeNull();
    });
  }

  test("status.ts imports DatabaseLike type (not value)", () => {
    const content = readFileSync(join(COMMANDS_DIR, "status.ts"), "utf8");
    expect(content).toMatch(
      /import\s+type\s*\{[^}]*\bDatabaseLike\b[^}]*\}\s*from\s+["']@eigengrid\/db["']/,
    );
  });

  test("collect.ts imports DatabaseLike type (not value)", () => {
    const content = readFileSync(join(COMMANDS_DIR, "collect.ts"), "utf8");
    expect(content).toMatch(
      /import\s+type\s*\{[^}]*\bDatabaseLike\b[^}]*\}\s*from\s+["']@eigengrid\/db["']/,
    );
  });
});
