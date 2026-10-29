import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  collectArtifactDigests,
  createWorkerReceipt,
  manifestDigest,
  readWorkerReceipt,
  verifyWorkerReceipt,
  writeWorkerReceipt,
} from "./receipt";
import type { WorkerJobManifest } from "./types";

const manifest: WorkerJobManifest = {
  schemaVersion: 2,
  jobId: "job-receipt",
  attemptId: "attempt-receipt",
  nodeName: "node-1",
  software: "xtb",
  recipeId: "xtb-opt",
  runner: "worker-daemon",
  inputName: "input.xyz",
  outputName: "output.xyz",
  resources: { cores: 1, memoryGb: 1 },
  createdAt: 1_700_000_000_000,
};

describe("worker receipts", () => {
  test("bind terminal observation to manifest, command, and artifact digests", () => {
    const dir = mkdtempSync(join(tmpdir(), "eigengrid-worker-receipt-"));
    mkdirSync(join(dir, "artifacts"));
    mkdirSync(join(dir, "logs"));
    mkdirSync(join(dir, "work"));
    writeFileSync(join(dir, "artifacts", "result.dat"), "result");
    writeFileSync(join(dir, "logs", "stdout.log"), "ok");
    const receipt = createWorkerReceipt({
      jobId: manifest.jobId,
      attemptId: manifest.attemptId,
      manifestDigest: manifestDigest(manifest),
      state: "completed",
      commandDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      finishedAt: 1_700_000_000_100,
      artifactDigests: collectArtifactDigests(dir),
    });
    writeWorkerReceipt(dir, receipt);
    expect(verifyWorkerReceipt(receipt).ok).toBe(true);
    expect(readWorkerReceipt(dir)?.artifactDigests["artifacts/result.dat"]).toMatch(/^sha256:/);
    const tampered = { ...receipt, state: "failed" as const };
    expect(verifyWorkerReceipt(tampered).ok).toBe(false);
  });
});
