import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createDatabase,
  MIGRATIONS,
  POSTGRES_MIGRATIONS,
  PostgresDatabase,
  splitSqlStatements,
  type DatabaseLike,
} from "@eigengrid/db";
import { canRunPostgres, startEphemeralPostgres } from "./helpers/postgres";

const V12 = 12;

async function seedDuplicateV11Results(db: DatabaseLike): Promise<void> {
  for (const jobId of ["legacy-single", "legacy-multiple", "legacy-no-attempt"] as const) {
    await db.createJob({
      id: jobId,
      name: jobId,
      software: "orca",
      inputPath: `/tmp/${jobId}.inp`,
      workdir: "/tmp",
    });
  }
  for (const [id, jobId] of [
    ["attempt-single", "legacy-single"],
    ["attempt-multiple-a", "legacy-multiple"],
    ["attempt-multiple-b", "legacy-multiple"],
  ] as const) {
    await db.createJobAttempt({
      id,
      jobId,
      runner: "local",
      command: "orca input.inp",
      cwd: `/tmp/${jobId}`,
    });
  }

  const transaction = await db.beginTransaction();
  try {
    await transaction.query("DROP TABLE results");
    await transaction.query("ALTER TABLE results_legacy_v11 RENAME TO results");
    await transaction.query("DELETE FROM _migrations WHERE version = $1", [V12]);
    const insert = `INSERT INTO results
      (id, job_id, parser, status, energy_hartree, scf_converged,
       imaginary_frequencies, normal_termination, warnings_json, errors_json,
       raw_json, created_at)
      VALUES ($1, $2, $3, 'completed', $4, 1, 0, 1, '[]', '[]', $5, $6)`;
    for (const row of [
      ["result-single-old", "legacy-single", "orca", "-1", '{"rank":"old"}', 100],
      ["result-single-new-a", "legacy-single", "orca", "-2", '{"rank":"new-a"}', 200],
      ["result-single-new-z", "legacy-single", "orca", "-3", '{"rank":"new-z"}', 200],
      ["result-single-gaussian", "legacy-single", "gaussian", "-4", "{}", 150],
      ["result-multiple", "legacy-multiple", "orca", "-5", "{}", 300],
      ["result-no-attempt", "legacy-no-attempt", "orca", "-6", "{}", 400],
    ] as const) {
      await transaction.query(insert, [...row]);
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function rawRows<T extends Record<string, unknown>>(
  db: DatabaseLike,
  sql: string,
): Promise<T[]> {
  const transaction = await db.beginTransaction();
  try {
    if (!transaction.queryRows) throw new Error("Migration test requires queryRows");
    const rows = await transaction.queryRows<T>(sql);
    await transaction.commit();
    return rows;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function expectDeterministicV12Backfill(
  db: DatabaseLike,
  expectedVersion: number,
): Promise<void> {
  expect(await db.getMigrationVersion()).toBe(expectedVersion);
  const visible = await db.listResults("legacy-single", "attempt-single");
  expect(visible.map((result) => result.id)).toEqual([
    "result-single-gaussian",
    "result-single-new-z",
  ]);
  expect(visible.find((result) => result.parser === "orca")).toMatchObject({
    attemptId: "attempt-single",
    energyHartree: -3,
    raw: { rank: "new-z" },
  });

  expect(await db.listResults("legacy-multiple", "attempt-multiple-a")).toEqual([]);
  expect(await db.listResults("legacy-multiple", "attempt-multiple-b")).toEqual([]);
  expect(await db.listResults("legacy-no-attempt")).toEqual([]);

  const archived = await rawRows<{ id: string }>(
    db,
    "SELECT id FROM results_legacy_v11 ORDER BY id",
  );
  expect(archived.map((row) => String(row.id))).toEqual([
    "result-multiple",
    "result-no-attempt",
    "result-single-gaussian",
    "result-single-new-a",
    "result-single-new-z",
    "result-single-old",
  ]);
}

describe("SQLite migrations", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "db-migrate-sqlite-"));
    dbPath = join(tmpDir, "test.sqlite");
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs all migrations on init", async () => {
    const db = createDatabase(dbPath);
    await db.init();

    const version = await db.getMigrationVersion();
    expect(version).toBe(MIGRATIONS.at(-1)!.version);
  });

  it("is idempotent — running init again doesn't fail", async () => {
    const db = createDatabase(dbPath);
    await db.init(); // second init
    const version = await db.getMigrationVersion();
    expect(version).toBe(MIGRATIONS.at(-1)!.version);
  });

  it("creates all expected tables", async () => {
    const db = createDatabase(dbPath);
    await db.init();

    // Verify tables exist by checking they can be queried
    await expect(db.listJobs()).resolves.toEqual([]);
    await expect(db.listJobAttempts()).resolves.toEqual([]);
    await expect(db.listArtifacts()).resolves.toEqual([]);
    await expect(db.listNodes()).resolves.toEqual([]);
    await expect(db.listPermissions()).resolves.toEqual([]);
  });

  it("deduplicates v11 results deterministically without crossing attempt boundaries", async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "db-migrate-v11-sqlite-"));
    try {
      const db = createDatabase(join(legacyDir, "legacy.sqlite"));
      await db.init();
      await seedDuplicateV11Results(db);
      await db.runMigrations();
      await expectDeterministicV12Backfill(db, MIGRATIONS.at(-1)!.version);
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});

describe("PostgreSQL migration definitions", () => {
  it("preserves the shared SQLite migration identities", () => {
    const identity = ({ version, name }: { version: number; name: string }) => ({
      version,
      name,
    });
    expect(POSTGRES_MIGRATIONS.slice(0, MIGRATIONS.length).map(identity)).toEqual(
      MIGRATIONS.map(identity),
    );
  });

  it("adds the production evidence authority migration only for PostgreSQL", () => {
    const name = "bind_evidence_uniqueness_to_exact_authority";
    expect(POSTGRES_MIGRATIONS.find((migration) => migration.name === name)).toMatchObject({
      version: 22,
      name,
    });
    expect(MIGRATIONS.some((migration) => migration.name === name)).toBe(false);
  });

  it("uses SERIAL for auto-increment columns instead of AUTOINCREMENT", () => {
    for (const m of POSTGRES_MIGRATIONS) {
      if (m.sql.includes("AUTOINCREMENT")) {
        throw new Error(
          `PostgreSQL migration v${m.version} contains AUTOINCREMENT (use SERIAL instead)`,
        );
      }
    }
  });

  it("uses IF NOT EXISTS for ALTER TABLE ADD COLUMN", () => {
    for (const m of POSTGRES_MIGRATIONS) {
      if (
        m.sql.includes("ALTER TABLE") &&
        m.sql.includes("ADD COLUMN") &&
        !m.sql.includes("IF NOT EXISTS")
      ) {
        throw new Error(
          `PostgreSQL migration v${m.version} ALTER TABLE ADD COLUMN without IF NOT EXISTS`,
        );
      }
    }
  });
});

describe.skipIf(!canRunPostgres)("PostgreSQL v12 result migration", () => {
  it("deduplicates v11 results deterministically without crossing attempt boundaries", async () => {
    const cluster = await startEphemeralPostgres();
    const db = new PostgresDatabase(cluster.url);
    try {
      await db.init();
      await seedDuplicateV11Results(db);
      await db.runMigrations();
      await expectDeterministicV12Backfill(db, POSTGRES_MIGRATIONS.at(-1)!.version);
    } finally {
      await db.close();
      cluster.cleanup();
    }
  });
});

describe("migration statement splitting", () => {
  it("does not split semicolons inside strings or comments", () => {
    const statements = splitSqlStatements(`
      INSERT INTO notes (value) VALUES ('alpha;beta');
      -- this comment contains a semicolon; it is not a statement boundary
      CREATE TABLE "semi;quoted" (value TEXT DEFAULT 'x;y');
      /* block comment; still one statement */
      UPDATE notes SET value = 'done';
    `);

    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain("'alpha;beta'");
    expect(statements[1]).toContain('"semi;quoted"');
    expect(statements[1]).toContain("'x;y'");
    expect(statements[2]).toContain("'done'");
  });
});
