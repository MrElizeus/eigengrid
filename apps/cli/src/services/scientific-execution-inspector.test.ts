import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "@eigengrid/db";
import { CanonicalScientificExecutionInspector } from "./scientific-execution-inspector";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CanonicalScientificExecutionInspector result provenance", () => {
  it("never attributes an older attempt result to the requested attempt", async () => {
    const root = mkdtempSync(join(tmpdir(), "eigengrid-inspector-provenance-"));
    roots.push(root);
    const db = createDatabase(join(root, "eigengrid.sqlite"));
    await db.init();
    const jobId = "job-inspector-provenance";
    const oldAttemptId = "attempt-inspector-old";
    const currentAttemptId = "attempt-inspector-current";
    const jobDir = join(root, jobId);
    const outputPath = join(jobDir, "current.out");
    mkdirSync(jobDir);
    writeFileSync(outputPath, "current output\n");

    await db.createJob({
      id: jobId,
      name: "inspector provenance",
      software: "orca",
      inputPath: join(root, "input.inp"),
      workdir: root,
    });
    for (const attemptId of [oldAttemptId, currentAttemptId]) {
      await db.createJobAttempt({
        id: attemptId,
        jobId,
        runner: "local",
        command: "orca input.inp",
        cwd: jobDir,
      });
    }
    await db.createArtifact({
      id: "artifact-inspector-current",
      jobId,
      attemptId: currentAttemptId,
      kind: "output",
      path: outputPath,
      sizeBytes: Buffer.byteLength("current output\n"),
    });
    await db.saveResult({
      jobId,
      attemptId: oldAttemptId,
      parser: "orca",
      status: "completed",
      energyHartree: -1,
    });

    const inspector = new CanonicalScientificExecutionInspector(db);
    await expect(
      inspector.inspect({
        jobId,
        attemptId: currentAttemptId,
        requireOutputArtifact: true,
        requireResult: true,
      }),
    ).rejects.toThrow("no durable parsed result");

    await db.saveResult({
      jobId,
      attemptId: currentAttemptId,
      parser: "orca",
      status: "completed",
      energyHartree: -2,
    });
    const snapshot = await inspector.inspect({
      jobId,
      attemptId: currentAttemptId,
      requireOutputArtifact: true,
      requireResult: true,
    });
    expect(snapshot.result?.record.attemptId).toBe(currentAttemptId);
    expect(snapshot.result?.record.energyHartree).toBe(-2);
  });
});
