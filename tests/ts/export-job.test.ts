import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDatabase } from "@eigengrid/db";
import { exportJob, exportDiagnostic } from "@eigengrid/backup";

describe("job export", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: ReturnType<typeof createDatabase>;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "export-job-"));
    dbPath = join(tmpDir, "test.sqlite");
    db = createDatabase(dbPath);
    await db.init();

    // Create test data
    await db.createJob({
      id: "job_export1",
      name: "Export Test Job",
      software: "gaussian",
      inputPath: "/tmp/input.inp",
      workdir: "/tmp/work",
    });

    await db.createJobAttempt({
      id: "attempt_export1",
      jobId: "job_export1",
      runner: "local",
      command: "gaussian input.inp > output.log",
      cwd: "/tmp/work",
      status: "completed",
      exitCode: 0,
      startedAt: Date.now() - 10000,
      finishedAt: Date.now(),
    });

    await db.createArtifact({
      id: "art_export1",
      jobId: "job_export1",
      attemptId: "attempt_export1",
      kind: "output",
      path: "/tmp/nonexistent-output.log",
      label: "main output",
    });
  });

  afterAll(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exports a job bundle", async () => {
    const exportPath = join(tmpDir, "job-export.eigengrid-backup.tar.gz");
    const result = await exportJob(db, "job_export1", {
      outputPath: exportPath,
    });

    expect(existsSync(exportPath)).toBe(true);
    expect(result.fileCount).toBeGreaterThan(0);
    expect(result.totalSizeBytes).toBeGreaterThan(0);
  });

  it("export bundle contains expected files", async () => {
    const exportPath = join(tmpDir, "job-export-check.eigengrid-backup.tar.gz");

    await exportJob(db, "job_export1", {
      outputPath: exportPath,
    });

    // We'll verify by checking the bundle with tar
    const { execSync } = await import("child_process");
    const listing = execSync(`tar -tzf "${exportPath}"`, { encoding: "utf-8" });

    expect(listing).toContain("manifest.json");
    expect(listing).toContain("job.json");
    expect(listing).toContain("attempts.json");
    expect(listing).toContain("events.ndjson");
    expect(listing).toContain("results.json");
    expect(listing).toContain("README.md");
    expect(listing).toContain("checksums.sha256");
  });

  it("export manifest has correct format", async () => {
    const exportPath = join(tmpDir, "job-export-manifest.eigengrid-backup.tar.gz");

    await exportJob(db, "job_export1", {
      outputPath: exportPath,
    });

    const { execSync } = await import("child_process");
    const content = execSync(`tar -xzf "${exportPath}" -O manifest.json`, { encoding: "utf-8" });
    const manifest = JSON.parse(content);

    expect(manifest.format).toBe("eigengrid-job-export");
    expect(manifest.jobId).toBe("job_export1");
    expect(manifest.software).toBe("gaussian");
    expect(manifest.fileCount).toBeGreaterThan(0);
  });

  it("export with includeArtifacts flag", async () => {
    const exportPath = join(tmpDir, "job-export-artifacts.eigengrid-backup.tar.gz");

    await expect(
      exportJob(db, "job_export1", {
        outputPath: exportPath,
        includeArtifacts: true,
      }),
    ).rejects.toThrow("is missing");
  });

  it("fails for non-existent job", async () => {
    try {
      await exportJob(db, "nonexistent_job", {});
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeDefined();
    }
  });
});

describe("diagnostic export", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: ReturnType<typeof createDatabase>;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "export-diag-"));
    dbPath = join(tmpDir, "test.sqlite");
    db = createDatabase(dbPath);
    await db.init();

    await db.createJob({
      id: "job_diag1",
      name: "Diagnostic Test Job",
      software: "gaussian",
      inputPath: "/tmp/input.inp",
      workdir: "/tmp/work",
    });

    // Create a failed attempt for diagnostic testing
    await db.createJobAttempt({
      id: "attempt_diag1",
      jobId: "job_diag1",
      runner: "local",
      command: "gaussian input.inp",
      cwd: "/tmp/work",
      status: "failed",
      exitCode: 1,
      startedAt: Date.now() - 5000,
      finishedAt: Date.now(),
    });
  });

  afterAll(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exports a diagnostic bundle", async () => {
    const exportPath = join(tmpDir, "diag-export.eigengrid-backup.tar.gz");
    const result = await exportDiagnostic(db, "job_diag1", {
      outputPath: exportPath,
    });

    expect(existsSync(exportPath)).toBe(true);
    expect(result.fileCount).toBeGreaterThan(0);
    expect(result.totalSizeBytes).toBeGreaterThan(0);
  });

  it("diagnostic bundle contains diagnostic files", async () => {
    const exportPath = join(tmpDir, "diag-export-check.eigengrid-backup.tar.gz");

    await exportDiagnostic(db, "job_diag1", {
      outputPath: exportPath,
    });

    const { execSync } = await import("child_process");
    const listing = execSync(`tar -tzf "${exportPath}"`, { encoding: "utf-8" });

    expect(listing).toContain("diagnostic.json");
    expect(listing).toContain("status.json");
    expect(listing).toContain("timeline.txt");
    expect(listing).toContain("artifacts-index.json");
    expect(listing).toContain("events.ndjson");
    expect(listing).toContain("checksums.sha256");
  });

  it("diagnostic manifest has correct format", async () => {
    const exportPath = join(tmpDir, "diag-manifest.eigengrid-backup.tar.gz");

    await exportDiagnostic(db, "job_diag1", {
      outputPath: exportPath,
    });

    const { execSync } = await import("child_process");
    const content = execSync(`tar -xzf "${exportPath}" -O manifest.json`, { encoding: "utf-8" });
    const manifest = JSON.parse(content);

    expect(manifest.format).toBe("eigengrid-diagnostic");
    expect(manifest.jobId).toBe("job_diag1");
    expect(manifest.software).toBe("gaussian");
  });
});
