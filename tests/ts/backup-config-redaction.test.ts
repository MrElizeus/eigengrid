import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as tar from "tar";
import { createBackup } from "@eigengrid/backup";
import { loadConfig } from "@eigengrid/config";
import { createDatabase } from "@eigengrid/db";

const envKeys = ["DATABASE_URL", "EIGENGRID_DATABASE_URL"] as const;
const originalEnvironment = new Map(envKeys.map((key) => [key, process.env[key]]));
const originalCwd = process.cwd();
let tmpDir: string;
let db: ReturnType<typeof createDatabase>;
let dbPath: string;

function restoreEnvironment(): void {
  for (const key of envKeys) {
    const value = originalEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function collectFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? collectFiles(path) : [path];
  });
}

async function readTrustedArchiveEntries(archivePath: string): Promise<Map<string, Buffer>> {
  const extractionDir = mkdtempSync(join(tmpDir, "archive-inspection-"));
  try {
    await tar.extract({ file: archivePath, cwd: extractionDir, portable: true });
    return new Map(
      collectFiles(extractionDir).map((path) => [
        path.slice(extractionDir.length + 1),
        readFileSync(path),
      ]),
    );
  } finally {
    rmSync(extractionDir, { recursive: true, force: true });
  }
}

async function createAndAssertRedactedBackup(name: string, sentinels: string[]): Promise<void> {
  const activeConfig = await loadConfig();
  const configBeforeBackup = JSON.stringify(activeConfig);
  const backupPath = join(tmpDir, `${name}.eigengrid-backup.tar.gz`);

  await createBackup(db, { outputPath: backupPath, dbPath, version: "test" });

  expect(JSON.stringify(activeConfig)).toBe(configBeforeBackup);
  const entries = await readTrustedArchiveEntries(backupPath);
  const config = JSON.parse(entries.get("config.json")!.toString("utf-8"));
  expect(config.databaseUrl).toBe("***REDACTED***");
  for (const entry of entries.values()) {
    for (const sentinel of sentinels) {
      expect(entry.includes(Buffer.from(sentinel))).toBe(false);
    }
  }
}

describe("backup active-config redaction", () => {
  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "backup-config-redaction-"));
    dbPath = join(tmpDir, "test.sqlite");
    db = createDatabase(dbPath);
    await db.init();
    process.chdir(tmpDir);
    mkdirSync(join(tmpDir, ".eigengrid"));
    for (const key of envKeys) delete process.env[key];
  });

  afterAll(() => {
    restoreEnvironment();
    process.chdir(originalCwd);
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("redacts a databaseUrl loaded from YAML in the produced archive", async () => {
    const username = "yaml-user-sentinel";
    const password = "yaml-password-sentinel";
    const databaseUrl = `postgres://${username}:${password}@yaml-host-sentinel/eigengrid`;
    writeFileSync(join(tmpDir, ".eigengrid", "eigengrid.yaml"), `databaseUrl: ${databaseUrl}\n`);

    await createAndAssertRedactedBackup("yaml-config", [username, password, databaseUrl]);
  });

  it("redacts a databaseUrl loaded from the EIGENGRID_DATABASE_URL alias", async () => {
    const username = "env-user-sentinel";
    const password = "env-password-sentinel";
    const databaseUrl = `postgres://${username}:${password}@env-host-sentinel/eigengrid`;
    process.env.EIGENGRID_DATABASE_URL = databaseUrl;

    await createAndAssertRedactedBackup("env-config", [username, password, databaseUrl]);
    delete process.env.EIGENGRID_DATABASE_URL;
  });
});
