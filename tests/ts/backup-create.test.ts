import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { createDatabase } from "@eigengrid/db";
import { createBackup, inspectBackup, verifyBackup } from "@eigengrid/backup";
import * as tar from "tar";

describe("backup creation", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: ReturnType<typeof createDatabase>;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "backup-create-"));
    dbPath = join(tmpDir, "test.sqlite");
    db = createDatabase(dbPath);
    await db.init();

    // Create test data
    await db.createJob({
      id: "job_test1",
      name: "Test Job",
      software: "gaussian",
      inputPath: "/tmp/input.inp",
      workdir: "/tmp/work",
    });

    await db.createJob({
      id: "job_test2",
      name: "Second Job",
      software: "orca",
      inputPath: "/tmp/input2.inp",
      workdir: "/tmp/work2",
    });

    await db.createJobAttempt({
      id: "attempt_test1",
      jobId: "job_test1",
      runner: "local",
      command: "gaussian input.inp",
      cwd: "/tmp/work",
      status: "completed",
      startedAt: Date.now() - 5000,
      finishedAt: Date.now(),
    });

    await db.createArtifact({
      id: "art_test1",
      jobId: "job_test1",
      attemptId: "attempt_test1",
      kind: "output",
      path: "/tmp/work/output.log",
      label: "main output",
    });

    await db.createNode({
      id: "node_test1",
      name: "test-node",
      host: "localhost",
      user: "test",
      runner: "local",
    });
  });

  afterAll(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates a backup archive", async () => {
    const backupPath = join(tmpDir, "test-backup.eigengrid-backup.tar.gz");

    const result = await createBackup(db, {
      outputPath: backupPath,
      dbPath,
      version: "0.1.0",
    });

    expect(existsSync(backupPath)).toBe(true);
    expect(result.backupPath).toBe(backupPath);
    expect(result.fileCount).toBeGreaterThan(0);
    expect(result.totalSizeBytes).toBeGreaterThan(0);
  });

  it("creates a backup with correct file count", async () => {
    const backupPath = join(tmpDir, "test-backup2.eigengrid-backup.tar.gz");

    const result = await createBackup(db, {
      outputPath: backupPath,
      dbPath,
      version: "0.1.0",
    });

    // Should have: manifest.json, schema.json, config.json, head.sqlite,
    // events.ndjson, jobs.ndjson, attempts.ndjson, artifacts.ndjson,
    // results.ndjson, nodes.ndjson, permissions.ndjson, proposals.ndjson,
    // checksums.sha256, plus logs for each job
    expect(result.fileCount).toBeGreaterThan(12);
  });

  it("creates valid tar.gz format", async () => {
    const backupPath = join(tmpDir, "test-backup3.eigengrid-backup.tar.gz");

    await createBackup(db, {
      outputPath: backupPath,
      dbPath,
      version: "0.1.0",
    });

    const stat = statSync(backupPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(100);

    // Verify it's a gzip file
    const content = readFileSync(backupPath);
    // gzip magic bytes: 0x1F 0x8B
    expect(content[0]).toBe(0x1f);
    expect(content[1]).toBe(0x8b);
  });

  it("creates backup that can be inspected", async () => {
    const backupPath = join(tmpDir, "test-backup4.eigengrid-backup.tar.gz");

    await createBackup(db, {
      outputPath: backupPath,
      dbPath,
      version: "0.1.0",
    });

    const info = await inspectBackup(backupPath);

    expect(info.manifest.format).toBe("eigengrid-backup");
    expect(info.manifest.formatVersion).toBe(1);
    expect(info.manifest.counts.jobs).toBe(2);
    expect(info.manifest.counts.attempts).toBe(1);
    expect(info.manifest.counts.artifacts).toBe(1);
    expect(info.manifest.counts.nodes).toBe(1);
    expect(info.manifest.hashAlgorithm).toBe("sha256");
    expect(info.checksumValid).toBe(true);
    expect(info.files).toEqual([...info.files].sort());
    expect(info.fileCount).toBe(info.files.length);
    expect(info.totalSizeBytes).toBe(statSync(backupPath).size);
  });

  it("reports mandatory checksum manifest defects without rejecting otherwise valid archives", async () => {
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const make = async (name: string, checksums?: string) => {
      const dir = join(tmpDir, `inspect-${name}`);
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
      return inspectBackup(archive);
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
      const info = await make(name, rows);
      expect(info.checksumValid).toBe(false);
      expect(info.fileCount).toBe(info.files.length);
    }
  });

  it("rejects prohibited links before inspection extraction", async () => {
    writeFileSync(join(tmpDir, "inspect-link-target"), "x");
    symlinkSync("inspect-link-target", join(tmpDir, "inspect-prohibited-link"));
    const archive = join(tmpDir, "inspect-prohibited-link.tar.gz");
    await tar.create({ file: archive, cwd: tmpDir, gzip: true }, ["inspect-prohibited-link"]);
    await expect(inspectBackup(archive)).rejects.toThrow("link target");
  });

  it("creates backup that passes verification", async () => {
    const backupPath = join(tmpDir, "test-backup5.eigengrid-backup.tar.gz");

    await createBackup(db, {
      outputPath: backupPath,
      dbPath,
      version: "0.1.0",
    });

    const result = await verifyBackup(backupPath);

    expect(result.ok).toBe(true);
    expect(result.checksumValid).toBe(true);
    expect(result.archiveSafe).toBe(true);
    expect(result.schemaCompatible).toBe(true);
  });
});
