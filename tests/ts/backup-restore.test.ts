import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
  linkSync,
  lstatSync,
  statSync,
  writeFileSync,
  readdirSync,
  renameSync,
  chmodSync,
} from "fs";
import { createHash } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { createDatabase } from "@eigengrid/db";
import { createBackup, restoreBackup, verifyBackup } from "@eigengrid/backup";
import { materializeRestore } from "../../packages/backup/src/restore-materialization";

const entry = (path: string, stagedPath: string) => ({
  path,
  stagedPath,
  size: statSync(stagedPath).size,
  expectedDigest: createHash("sha256").update(readFileSync(stagedPath)).digest("hex"),
});

describe("backup restore", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: ReturnType<typeof createDatabase>;
  let backupPath: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "backup-restore-"));
    dbPath = join(tmpDir, "test.sqlite");
    db = createDatabase(dbPath);
    await db.init();

    // Create test data
    await db.createJob({
      id: "job_rtest1",
      name: "Restore Test",
      software: "gaussian",
      inputPath: "/tmp/input.inp",
      workdir: "/tmp/work",
    });

    await db.createJob({
      id: "job_rtest2",
      name: "Second Test",
      software: "orca",
      inputPath: "/tmp/input2.inp",
      workdir: "/tmp/work2",
    });

    backupPath = join(tmpDir, "backup.eigengrid-backup.tar.gz");
    await createBackup(db, {
      outputPath: backupPath,
      dbPath,
      version: "0.1.0",
    });
  });

  afterAll(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("restore dry-run validates without writing", async () => {
    const targetDir = join(tmpDir, "restore-dry-run-target");
    const result = await restoreBackup(backupPath, {
      targetDir,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.checksumValid).toBe(true);
    expect(result.archiveSafe).toBe(true);
    expect(result.schemaCompatible).toBe(true);

    // Dry run must not write files
    expect(existsSync(targetDir)).toBe(false);
  });

  it("restore with --force bypasses active DB check", async () => {
    const targetDir = join(tmpDir, "restore-force-target");
    const active = join(tmpDir, "active-db.sqlite");
    writeFileSync(active, "active");
    expect((await restoreBackup(backupPath, { targetDir, dbPath: active })).ok).toBe(false);
    expect(existsSync(targetDir)).toBe(false);
    const result = await restoreBackup(backupPath, {
      targetDir,
      force: true,
      dbPath: active,
    });

    expect(result.ok).toBe(true);
  });

  it("restore into target directory writes files", async () => {
    const targetDir = join(tmpDir, "restore-actual-target");

    const result = await restoreBackup(backupPath, {
      targetDir,
    });

    expect(result.ok).toBe(true);

    // Must have written files
    expect(existsSync(join(targetDir, "manifest.json"))).toBe(true);
    expect(existsSync(join(targetDir, "jobs.ndjson"))).toBe(true);
    expect(existsSync(join(targetDir, "head.sqlite"))).toBe(true);
    expect(existsSync(join(targetDir, "checksums.sha256"))).toBe(true);
  });

  it("restore writes correct manifest content", async () => {
    const targetDir = join(tmpDir, "restore-manifest-check");

    await restoreBackup(backupPath, {
      targetDir,
    });

    const manifestContent = readFileSync(join(targetDir, "manifest.json"), "utf-8");
    const manifest = JSON.parse(manifestContent);

    expect(manifest.format).toBe("eigengrid-backup");
    expect(manifest.counts.jobs).toBe(2);
  });

  it("verify still passes after successful restore of backup file", async () => {
    const result = await verifyBackup(backupPath);
    expect(result.ok).toBe(true);
  });

  it("atomically replaces unsafe existing leaves without following them", async () => {
    const target = join(tmpDir, "restore-replace-leaves");
    const outside = join(tmpDir, "outside");
    mkdirSync(target);
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(target, "manifest.json"));
    linkSync(outside, join(target, "jobs.ndjson"));
    const linked = lstatSync(join(target, "jobs.ndjson")).ino;
    const restored = await restoreBackup(backupPath, { targetDir: target });
    expect(restored.ok).toBe(true);
    expect(restored.warnings.join(" ")).toContain("rollback is not guaranteed");
    expect(readFileSync(outside, "utf8")).toBe("outside");
    expect(lstatSync(join(target, "manifest.json")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(target, "jobs.ndjson")).ino).not.toBe(linked);
    expect(statSync(join(target, "manifest.json")).mode & 0o777).toBe(0o600);
  });

  it("rejects target parent symlinks without writing through them", async () => {
    const outside = join(tmpDir, "restore-symlink-outside");
    mkdirSync(outside);
    const target = join(tmpDir, "restore-symlink");
    symlinkSync(outside, target);
    const result = await restoreBackup(backupPath, { targetDir: join(target, "child") });
    expect(result.ok).toBe(false);
    expect(existsSync(join(outside, "child"))).toBe(false);
  });

  it("reports copied bytes and target state for malformed archives", async () => {
    const archive = join(tmpDir, "malformed.tar.gz"),
      target = join(tmpDir, "existing-target"),
      active = join(tmpDir, "malformed-active.sqlite");
    writeFileSync(archive, "not an archive");
    mkdirSync(target);
    writeFileSync(active, "active");
    const result = await restoreBackup(archive, { targetDir: target, dbPath: active });
    expect(result.ok).toBe(false);
    expect(result.targetExists).toBe(true);
    expect(result.targetHasActiveDb).toBe(true);
    expect(result.totalSizeBytes).toBe(statSync(archive).size);
  });

  it("uses fixed temp names, exact modes, and cleans failed private copies", () => {
    const root = join(tmpDir, "private-materializer");
    mkdirSync(root);
    const source = join(root, "source");
    writeFileSync(source, "original");
    const oldUmask = process.umask(0o777);
    try {
      const long = "x".repeat(255);
      materializeRestore(join(root, "target"), [entry(`nested/${long}`, source)]);
      expect(readFileSync(join(root, "target", "nested", long), "utf8")).toBe("original");
      expect(statSync(join(root, "target")).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, "target", "nested")).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, "target", "nested", long)).mode & 0o777).toBe(0o600);
      writeFileSync(source, "changed");
      expect(() =>
        materializeRestore(join(root, "target"), [
          entry("changed", source),
          { ...entry("bad", source), expectedDigest: "0".repeat(64) },
        ]),
      ).toThrow();
      expect(existsSync(join(root, "target", "bad"))).toBe(false);
      mkdirSync(join(root, "target", "directory"));
      chmodSync(join(root, "target", "directory"), 0o700);
      expect(() =>
        materializeRestore(join(root, "target"), [entry("directory", source)]),
      ).toThrow();
      expect(statSync(join(root, "target", "directory")).isDirectory()).toBe(true);
      expect(
        readdirSync(join(root, "target")).every((name) => !name.startsWith(".eigengrid-")),
      ).toBe(true);
    } finally {
      process.umask(oldUmask);
    }
  });

  it("preserves concurrent data after a late failure and publishes CAS objects read-only", () => {
    const root = join(tmpDir, "restore-late-failure");
    mkdirSync(root);
    const source = join(root, "source");
    writeFileSync(source, "verified-source");
    const failedTarget = join(root, "failed-target");
    expect(() =>
      materializeRestore(
        failedTarget,
        [entry("first", source), { ...entry("second", source), expectedDigest: "0".repeat(64) }],
        {
          beforePublish: () => {
            const concurrent = join(failedTarget, "concurrent-user-file");
            if (!existsSync(concurrent)) writeFileSync(concurrent, "must-survive");
          },
        },
      ),
    ).toThrow("Staged restore file changed: second");
    expect(readFileSync(join(failedTarget, "concurrent-user-file"), "utf8")).toBe("must-survive");
    expect(readFileSync(join(failedTarget, "first"), "utf8")).toBe("verified-source");

    const casTarget = join(root, "cas-target");
    const contentDigest = createHash("sha256").update(readFileSync(source)).digest("hex");
    const casPath = `cas/sha256/${contentDigest.slice(0, 2)}/${contentDigest}`;
    materializeRestore(casTarget, [entry(casPath, source)]);
    expect(statSync(join(casTarget, casPath)).mode & 0o777).toBe(0o444);
  });

  it("rejects moved held parents and cleans chmod failures", () => {
    const root = join(tmpDir, "materializer-gaps"),
      target = join(root, "target"),
      source = join(root, "source");
    mkdirSync(root);
    mkdirSync(join(target, "nested"), { recursive: true });
    writeFileSync(source, "source");
    const count = () => readdirSync("/proc/self/fd").length,
      moved = join(root, "moved");
    expect(() =>
      materializeRestore(target, [entry("nested/file", source)], {
        beforePublish: (parent) => {
          renameSync(parent, moved);
          mkdirSync(parent);
        },
      }),
    ).toThrow();
    expect(existsSync(join(moved, "file"))).toBe(false);
    expect(existsSync(join(target, "nested", "file"))).toBe(false);
    expect(readdirSync(moved).every((name) => !name.startsWith(".eigengrid-"))).toBe(true);
    expect(
      readdirSync(join(target, "nested")).every((name) => !name.startsWith(".eigengrid-")),
    ).toBe(true);
    const missing = join(root, "missing"),
      missingMoved = join(root, "missing-moved");
    mkdirSync(missing);
    expect(() =>
      materializeRestore(missing, [entry("file", source)], {
        beforePublish: (parent) => renameSync(parent, missingMoved),
      }),
    ).toThrow("Restore directory changed: file");
    expect(existsSync(join(missingMoved, "file"))).toBe(false);
    expect(readdirSync(missingMoved).every((name) => !name.startsWith(".eigengrid-"))).toBe(true);
    expect(existsSync(missing)).toBe(false);
    const beforeDirectory = count();
    expect(() =>
      materializeRestore(join(root, "new-target"), [entry("file", source)], {
        fchmod: () => {
          throw new Error("chmod");
        },
      }),
    ).toThrow("chmod");
    expect(count()).toBe(beforeDirectory);
    const before = count();
    expect(() =>
      materializeRestore(target, [entry("chmod", source)], {
        fchmod: () => {
          throw new Error("chmod");
        },
      }),
    ).toThrow("chmod");
    expect(count()).toBe(before);
    expect(existsSync(join(target, "chmod"))).toBe(false);
    expect(readdirSync(target).every((name) => !name.startsWith(".eigengrid-"))).toBe(true);
  });
});
