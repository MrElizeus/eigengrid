import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventEmitter } from "events";
import {
  claimJob,
  ensureWorkerLayout,
  executeBundle,
  getFailedDir,
  getInboxDir,
  listReadyJobs,
  readStatusFile,
} from "@eigengrid/worker";

const manifest = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  jobId: "job-v2",
  attemptId: "attempt-v2",
  nodeName: "worker",
  software: "orca",
  recipeId: "orca-opt",
  runner: "worker-daemon",
  inputName: "water.inp",
  outputName: "water.out",
  resources: { cores: 1, memoryGb: 1 },
  createdAt: 1,
  ...overrides,
});

function ready(root: string, name: string, content?: string) {
  const bundle = join(getInboxDir(root), name);
  mkdirSync(bundle, { recursive: true });
  if (content !== undefined) writeFileSync(join(bundle, "manifest.json"), content);
  writeFileSync(join(bundle, "READY"), "");
  return bundle;
}

describe("v2 runtime security", () => {
  test("uses only canonical shell:false recipe invocation", async () => {
    const root = mkdtempSync(join(tmpdir(), "v2-"));
    let call: unknown[] = [];
    try {
      const bundle = join(root, "bundle");
      mkdirSync(bundle);
      writeFileSync(join(bundle, "manifest.json"), JSON.stringify(manifest()));
      mkdirSync(join(bundle, "input"));
      writeFileSync(join(bundle, "input", "water.inp"), "staged input");
      const fake = ((program: string, args: string[], options: unknown) => {
        call = [program, args, options];
        const child = new EventEmitter() as EventEmitter & { pid: number };
        child.pid = 7;
        queueMicrotask(() => child.emit("close", 0));
        return child;
      }) as never;
      await executeBundle(bundle, undefined, fake);
      expect(call).toEqual([
        "sh",
        expect.arrayContaining(["water.inp", "water.out"]),
        expect.objectContaining({ cwd: expect.stringContaining("/fd/"), shell: false }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects v1, injected, malformed, and unknown manifests without spawn", async () => {
    const root = mkdtempSync(join(tmpdir(), "v2-"));
    let calls = 0;
    try {
      const fake = (() => {
        calls++;
        throw new Error("spawned");
      }) as never;
      const invalidManifests = [
        {
          ...manifest(),
          schemaVersion: 1,
          command: { display: "echo sentinel", program: "echo", args: ["sentinel"], shell: false },
        },
        manifest({ command: { shell: true } }),
        manifest({ outputName: "wrong.out" }),
        { schemaVersion: 2 },
        { schemaVersion: 9 },
      ];
      for (const [index, raw] of invalidManifests.entries()) {
        const bundle = join(root, `invalid-${index}`);
        mkdirSync(bundle);
        const result = await executeBundle(bundle, raw, fake);
        expect(result.ok).toBe(false);
      }
      expect(calls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("quarantines invalid bundles, collisions, and cleans locks", () => {
    const root = mkdtempSync(join(tmpdir(), "v2-"));
    try {
      ensureWorkerLayout(root);
      ready(root, "job-v2", "{");
      expect(claimJob(root, "job-v2").ok).toBe(false);
      ready(root, "job-v2", JSON.stringify(manifest({ jobId: "other" })));
      expect(claimJob(root, "job-v2").ok).toBe(false);
      expect(existsSync(join(getFailedDir(root), "job-v2.invalid-1"))).toBe(true);
      expect(existsSync(join(root, "locks", "job-v2.lock"))).toBe(false);
      expect(readStatusFile(join(getFailedDir(root), "job-v2"))?.state).toBe("failed");
      ready(root, "bad-schema", JSON.stringify({ schemaVersion: 9 }));
      expect(claimJob(root, "bad-schema").ok).toBe(false);
      expect(existsSync(join(getFailedDir(root), "bad-schema"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("quarantines v2 recipes and outputs that are not canonical", () => {
    const root = mkdtempSync(join(tmpdir(), "v2-"));
    try {
      ensureWorkerLayout(root);
      for (const [jobId, overrides] of [
        ["unknown", { recipeId: "not-registered" }],
        ["output", { outputName: "wrong.out" }],
      ] as const) {
        ready(root, jobId, JSON.stringify(manifest({ jobId, ...overrides })));
        expect(claimJob(root, jobId).ok).toBe(false);
        expect(readStatusFile(join(getFailedDir(root), jobId))?.state).toBe("failed");
        expect(existsSync(join(getInboxDir(root), jobId))).toBe(false);
        expect(existsSync(join(root, "running", jobId))).toBe(false);
        expect(existsSync(join(root, "locks", `${jobId}.lock`))).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects direct paths, ignores staging, and quarantines v1", () => {
    const root = mkdtempSync(join(tmpdir(), "v2-"));
    try {
      ensureWorkerLayout(root);
      ready(root, "stage.tmp", JSON.stringify(manifest()));
      expect(listReadyJobs(root)).toEqual([]);
      expect(claimJob(root, "stage.tmp").ok).toBe(false);
      expect(claimJob(root, "../stage").ok).toBe(false);
      ready(
        root,
        "legacy",
        JSON.stringify({
          ...manifest(),
          schemaVersion: 1,
          jobId: "legacy",
          command: { display: "echo ok", program: "echo", args: ["ok"], shell: false },
        }),
      );
      expect(claimJob(root, "legacy").ok).toBe(false);
      expect(existsSync(join(getFailedDir(root), "legacy"))).toBe(true);
      expect(existsSync(join(root, "running", "legacy"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
