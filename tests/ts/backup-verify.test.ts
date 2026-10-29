import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, symlinkSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { createDatabase } from "@eigengrid/db";
import { createBackup, verifyBackup } from "@eigengrid/backup";
import * as tar from "tar";

describe("backup verification", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: ReturnType<typeof createDatabase>;
  let goodBackupPath: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "backup-verify-"));
    dbPath = join(tmpDir, "test.sqlite");
    db = createDatabase(dbPath);
    await db.init();

    // Create test data
    await db.createJob({
      id: "job_vtest1",
      name: "Verify Test",
      software: "gaussian",
      inputPath: "/tmp/input.inp",
      workdir: "/tmp/work",
    });

    // Create a valid backup to use for tests
    goodBackupPath = join(tmpDir, "valid-backup.eigengrid-backup.tar.gz");
    await createBackup(db, {
      outputPath: goodBackupPath,
      dbPath,
      version: "0.1.0",
    });
  });

  afterAll(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports valid backup as OK", async () => {
    const result = await verifyBackup(goodBackupPath);
    expect(result.ok).toBe(true);
  });

  it("reports valid checksums", async () => {
    const result = await verifyBackup(goodBackupPath);
    expect(result.checksumValid).toBe(true);
  });

  it("reports archive safety", async () => {
    const result = await verifyBackup(goodBackupPath);
    expect(result.archiveSafe).toBe(true);
  });

  it("reports schema compatibility", async () => {
    const result = await verifyBackup(goodBackupPath);
    expect(result.schemaCompatible).toBe(true);
  });

  it("reports error for non-existent file", async () => {
    const result = await verifyBackup("/nonexistent/backup.tar.gz");
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("reports error for invalid file", async () => {
    const badFile = join(tmpDir, "not-a-backup.tar.gz");
    writeFileSync(badFile, "this is not a valid archive");
    const result = await verifyBackup(badFile);
    expect(result.ok).toBe(false);
  });

  it("rejects a prohibited link before extraction", async () => {
    writeFileSync(join(tmpDir, "link-target"), "x");
    symlinkSync("link-target", join(tmpDir, "prohibited-link"));
    const archive = join(tmpDir, "prohibited-link.tar.gz");
    await tar.create({ file: archive, cwd: tmpDir, gzip: true }, ["prohibited-link"]);
    const result = await verifyBackup(archive);
    expect(result.ok).toBe(false);
    expect(result.archiveSafe).toBe(false);
    expect(result.errors.join(" ")).toContain("link target");
  });

  it("returns file count and size", async () => {
    const result = await verifyBackup(goodBackupPath);
    expect(result.fileCount).toBeGreaterThan(0);
    expect(result.totalSizeBytes).toBeGreaterThan(0);
  });

  it("returns manifest content", async () => {
    const result = await verifyBackup(goodBackupPath);
    expect(result.manifest).toBeDefined();
    expect(result.manifest!.format).toBe("eigengrid-backup");
  });

  it("fails closed for mandatory checksum manifest violations", async () => {
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const make = async (name: string, checksums?: string | Buffer) => {
      const dir = join(tmpDir, name);
      mkdirSync(dir);
      const manifest = '{"formatVersion":1}';
      writeFileSync(join(dir, "manifest.json"), manifest);
      writeFileSync(join(dir, "payload"), "data");
      if (checksums !== undefined) writeFileSync(join(dir, "checksums.sha256"), checksums);
      const archive = `${dir}.tar.gz`;
      await tar.create(
        { file: archive, cwd: dir, gzip: true },
        checksums === undefined
          ? ["manifest.json", "payload"]
          : ["manifest.json", "payload", "checksums.sha256"],
      );
      return verifyBackup(archive);
    };
    const valid = `${hash('{"formatVersion":1}')}  manifest.json\n${hash("data")}  payload`;
    for (const [name, rows] of [
      ["missing", undefined],
      ["malformed", "not a row"],
      ["duplicate", `${valid}\n${hash("data")}  payload`],
      ["omitted", `${hash('{"formatVersion":1}')}  manifest.json`],
      ["extra", `${valid}\n${hash("x")}  absent`],
      ["mismatch", `${hash('{"formatVersion":1}')}  manifest.json\n${"0".repeat(64)}  payload`],
    ] as const) {
      const result = await make(name, rows);
      expect(result.ok).toBe(false);
      expect(result.checksumValid).toBe(false);
      expect(result.archiveSafe).toBe(true);
    }
  });

  it("fails fast on malformed, absent, and invalid UTF-8 checksum rows", async () => {
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const make = async (name: string, checksums: Buffer, replacement = false) => {
      const dir = join(tmpDir, name);
      mkdirSync(dir);
      writeFileSync(join(dir, "manifest.json"), '{"formatVersion":1}');
      if (replacement) writeFileSync(join(dir, "\uFFFD"), "data");
      else writeFileSync(join(dir, "payload"), "data");
      writeFileSync(join(dir, "checksums.sha256"), checksums);
      const archive = `${dir}.tar.gz`;
      await tar.create(
        { file: archive, cwd: dir, gzip: true },
        replacement
          ? ["manifest.json", "\uFFFD", "checksums.sha256"]
          : ["manifest.json", "payload", "checksums.sha256"],
      );
      return verifyBackup(archive);
    };
    const malformed = await make("many-malformed", Buffer.from(Array(64).fill("bad").join("\n")));
    const absent = await make(
      "many-absent",
      Buffer.from(
        Array(64)
          .fill(`${hash("x")}  absent`)
          .join("\n"),
      ),
    );
    const invalidUtf8 = await make(
      "invalid-utf8",
      Buffer.concat([Buffer.from(`${hash("data")}  `), Buffer.from([0xff])]),
      true,
    );
    for (const result of [malformed, absent, invalidUtf8]) {
      expect(result.ok).toBe(false);
      expect(result.checksumValid).toBe(false);
      expect(result.archiveSafe).toBe(true);
      expect(result.errors).toHaveLength(1);
    }
  });

  it("rejects oversized manifests and classifies newline-free checksum records", async () => {
    const make = async (name: string, manifest: string, checksums: string) => {
      const dir = join(tmpDir, name);
      mkdirSync(dir);
      writeFileSync(join(dir, "manifest.json"), manifest);
      writeFileSync(join(dir, "checksums.sha256"), checksums);
      const archive = `${dir}.tar.gz`;
      await tar.create({ file: archive, cwd: dir, gzip: true }, [
        "manifest.json",
        "checksums.sha256",
      ]);
      return verifyBackup(archive);
    };
    const oversizedManifest = await make("manifest", "x".repeat(1_048_577), "");
    expect(oversizedManifest.ok).toBe(false);
    expect(oversizedManifest.archiveSafe).toBe(false);
    for (const [name, checksums] of [
      ["checksum-exact-limit", "x".repeat(16_450)],
      ["checksum-over-limit", "x".repeat(16_451)],
    ] as const) {
      const result = await make(name, '{"formatVersion":1}', checksums);
      expect(result.ok).toBe(false);
      expect(result.checksumValid).toBe(false);
      expect(result.archiveSafe).toBe(true);
      expect(result.errors).toHaveLength(1);
    }
  });
});
