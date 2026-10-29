import { afterEach, describe, expect, it } from "bun:test";
import { createDatabase } from "@eigengrid/db";
import { createBackup, inspectBackup, verifyBackup } from "@eigengrid/backup";
import { Database } from "bun:sqlite";
import { readVerifiedSqliteSnapshot } from "../../packages/backup/src/sqlite-snapshot";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as tar from "tar";

describe("SQLite WAL backup snapshots", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("archives WAL-only committed rows in a verified standalone snapshot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "backup-wal-"));
    directories.push(directory);
    const dbPath = join(directory, "head.sqlite");
    const rawCopy = join(directory, "raw.sqlite");
    const archivePath = join(directory, "backup.tar.gz");
    const extracted = join(directory, "extracted");
    const db = createDatabase(dbPath);
    await db.init();
    const source = new Database(dbPath);

    try {
      source.exec("PRAGMA journal_mode=WAL");
      source.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      source.exec("PRAGMA wal_autocheckpoint=0");
      source.exec("CREATE TABLE wal_backup_probe (value TEXT NOT NULL)");
      source.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      source.query("INSERT INTO wal_backup_probe VALUES (?)").run("committed-wal-probe");

      copyFileSync(dbPath, rawCopy);
      const raw = new Database(rawCopy, { readonly: true });
      try {
        expect(raw.query("SELECT COUNT(*) AS count FROM wal_backup_probe").get()).toEqual({
          count: 0,
        });
      } finally {
        raw.close();
      }

      await createBackup(db, { dbPath, outputPath: archivePath, version: "test" });
      mkdirSync(extracted);
      await tar.extract({ file: archivePath, cwd: extracted, portable: true });

      const archived = new Database(join(extracted, "head.sqlite"), { readonly: true });
      try {
        expect(archived.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(archived.query("SELECT value FROM wal_backup_probe").get()).toEqual({
          value: "committed-wal-probe",
        });
      } finally {
        archived.close();
      }
      expect(existsSync(join(extracted, "head.sqlite-wal"))).toBe(false);
      expect(existsSync(join(extracted, "head.sqlite-shm"))).toBe(false);
      expect((await inspectBackup(archivePath)).manifest.formatVersion).toBe(1);
      expect((await verifyBackup(archivePath)).checksumValid).toBe(true);
      expect(
        readdirSync(directory).some((name) => name.startsWith(".eigengrid-backup-snapshot-")),
      ).toBe(false);
    } finally {
      source.close();
    }
  });

  it("fails closed after a corrupt source creates staging", async () => {
    const directory = mkdtempSync(join(tmpdir(), "backup-wal-failure-"));
    directories.push(directory);
    const db = createDatabase(join(directory, "live.sqlite"));
    await db.init();
    const archivePath = join(directory, "partial.tar.gz");

    const corruptPath = join(directory, "corrupt.sqlite");
    writeFileSync(corruptPath, "not a SQLite database");

    await expect(
      createBackup(db, { dbPath: corruptPath, outputPath: archivePath, version: "test" }),
    ).rejects.toThrow();
    expect(existsSync(archivePath)).toBe(false);
    expect(
      readdirSync(directory).some((name) => name.startsWith(".eigengrid-backup-snapshot-")),
    ).toBe(false);
  });

  it("rejects a physically valid snapshot with foreign-key violations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "backup-foreign-key-failure-"));
    directories.push(directory);
    const dbPath = join(directory, "foreign-key-gap.sqlite");
    const database = new Database(dbPath);
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE parent (id TEXT PRIMARY KEY);
        CREATE TABLE child (
          id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL REFERENCES parent(id) ON DELETE RESTRICT
        );
        INSERT INTO child (id, parent_id) VALUES ('child-1', 'missing-parent');
      `);
      expect(database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(database.query("PRAGMA foreign_key_check").all()).toHaveLength(1);
    } finally {
      database.close();
    }
    await expect(readVerifiedSqliteSnapshot(dbPath)).rejects.toThrow("foreign_key_check");
    expect(
      readdirSync(directory).some((name) => name.startsWith(".eigengrid-backup-snapshot-")),
    ).toBe(false);
  });

  it("retries independent cleanup after a close failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "backup-wal-close-"));
    directories.push(directory);
    const dbPath = join(directory, "source.sqlite");
    const database = new Database(dbPath);
    database.exec("CREATE TABLE probe (value TEXT)");
    database.close();
    const originalClose = Database.prototype.close;
    let closeCalls = 0;
    Database.prototype.close = function (this: Database): void {
      closeCalls += 1;
      originalClose.call(this);
      if (closeCalls === 2) throw new Error("deterministic snapshot close failure");
    };

    try {
      await expect(readVerifiedSqliteSnapshot(dbPath)).rejects.toThrow(
        "deterministic snapshot close failure",
      );
    } finally {
      Database.prototype.close = originalClose;
    }
    expect(closeCalls).toBe(3);
    expect(
      readdirSync(directory).some((name) => name.startsWith(".eigengrid-backup-snapshot-")),
    ).toBe(false);
  });
});
