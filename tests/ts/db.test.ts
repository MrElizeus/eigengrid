import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDatabase } from "@eigengrid/db";
import { initCommand } from "../../apps/cli/src/commands/init";

function createWorkspace(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "eigengrid-db-"));
  return { root, dbPath: join(root, ".eigengrid", "eigengrid.sqlite") };
}

describe("sqlite runtime", () => {
  it("bootstraps the workspace and initializes sqlite on init", async () => {
    const { root, dbPath } = createWorkspace();
    const previousCwd = process.cwd();

    process.chdir(root);

    try {
      await initCommand.handler({} as never);

      expect(existsSync(join(root, ".eigengrid"))).toBe(true);
      expect(existsSync(join(root, ".eigengrid", "eigengrid.yaml"))).toBe(true);
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exposes an async CRUD surface", async () => {
    const { root, dbPath } = createWorkspace();

    try {
      const db = createDatabase(dbPath);

      const initPromise = db.init();
      expect(initPromise).toBeInstanceOf(Promise);
      await initPromise;

      const createPromise = db.createJob({
        id: "job-1",
        name: "water.in",
        software: "gaussian",
        inputPath: "water.in",
        workdir: root,
      });
      expect(createPromise).toBeInstanceOf(Promise);
      await createPromise;

      const listPromise = db.listJobs();
      expect(listPromise).toBeInstanceOf(Promise);
      const jobs = await listPromise;

      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe("job-1");
      expect(jobs[0].status).toBe("created");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps existing jobs on re-init and rejects invalid status writes", async () => {
    const { root, dbPath } = createWorkspace();

    try {
      const first = createDatabase(dbPath);
      await first.init();
      await first.createJob({
        id: "job-1",
        name: "water.in",
        software: "gaussian",
        inputPath: "water.in",
        workdir: root,
      });

      const reopened = createDatabase(dbPath);
      await reopened.init();

      const jobsBefore = await reopened.listJobs();
      expect(jobsBefore).toHaveLength(1);
      expect(jobsBefore[0].status).toBe("created");

      await expect(reopened.updateJobStatus("job-1", "finished" as never)).rejects.toThrow();

      const jobAfter = await reopened.getJob("job-1");
      expect(jobAfter?.status).toBe("created");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates the attempt and artifact tables on init", async () => {
    const { root, dbPath } = createWorkspace();

    try {
      const db = createDatabase(dbPath);
      await db.init();

      expect(await db.listJobAttempts()).toEqual([]);
      expect(await db.listArtifacts()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists attempts and artifacts in creation order", async () => {
    const { root, dbPath } = createWorkspace();

    try {
      const db = createDatabase(dbPath);
      await db.init();
      await db.createJob({
        id: "job-1",
        name: "water.in",
        software: "gaussian",
        inputPath: "water.in",
        workdir: root,
      });

      await db.createJobAttempt({
        id: "attempt-1",
        jobId: "job-1",
        runner: "local",
        command: "g16 water.in",
        cwd: root,
      });
      await db.createArtifact({
        id: "artifact-1",
        jobId: "job-1",
        attemptId: "attempt-1",
        kind: "input",
        path: "water.in",
      });
      await db.createArtifact({
        id: "artifact-2",
        jobId: "job-1",
        attemptId: "attempt-1",
        kind: "output",
        path: "water.log",
        label: "Gaussian output",
      });

      const attempts = await db.listJobAttempts("job-1");
      const artifacts = await db.listArtifacts("job-1");

      expect(attempts).toHaveLength(1);
      expect(attempts[0].id).toBe("attempt-1");
      expect(attempts[0].status).toBe("created");
      expect(attempts[0].command).toBe("g16 water.in");

      expect(artifacts.map((artifact) => artifact.id)).toEqual(["artifact-1", "artifact-2"]);
      expect(artifacts[1].label).toBe("Gaussian output");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists attempt status updates and execution metadata", async () => {
    const { root, dbPath } = createWorkspace();

    try {
      const db = createDatabase(dbPath);
      await db.init();
      await db.createJob({
        id: "job-1",
        name: "water.in",
        software: "gaussian",
        inputPath: "water.in",
        workdir: root,
      });
      await db.createJobAttempt({
        id: "attempt-1",
        jobId: "job-1",
        runner: "local",
        command: "g16 water.in",
        cwd: root,
      });

      await db.updateJobAttemptStatus("attempt-1", "queued");
      await db.updateJobAttemptStatus("attempt-1", "staged");
      await db.updateJobAttemptStatus("attempt-1", "running", {
        pid: 1234,
        startedAt: 111,
      });
      await db.updateJobAttemptStatus("attempt-1", "completed", {
        exitCode: 0,
        finishedAt: 222,
      });

      const [attempt] = await db.listJobAttempts("job-1");
      expect(attempt.status).toBe("completed");
      expect(attempt.pid).toBe(1234);
      expect(attempt.startedAt).toBe(111);
      expect(attempt.exitCode).toBe(0);
      expect(attempt.finishedAt).toBe(222);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
