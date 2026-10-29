import { describe, expect, test } from "bun:test";
import {
  MAX_WORKER_CORES,
  MAX_WORKER_MEMORY_GB,
  parseManifest,
  type WorkerJobManifest,
} from "@eigengrid/worker";

const fixture: WorkerJobManifest = {
  schemaVersion: 2,
  jobId: "job-001",
  attemptId: "attempt-001",
  nodeName: "worker-01",
  software: "orca",
  recipeId: "orca-sp",
  runner: "worker-daemon",
  inputName: "input.inp",
  outputName: "output.out",
  resources: { cores: 4, memoryGb: 8 },
  createdAt: 1,
};

function validManifest(): Record<string, unknown> {
  return structuredClone(fixture);
}

function expectInvalid(raw: unknown, path: string): void {
  const result = parseManifest(raw);

  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.errors.some((error) => error.path === path)).toBe(true);
}

describe("parseManifest", () => {
  test("rejects null, undefined, primitives, and a missing schema version", () => {
    for (const raw of [null, undefined, true, 42, "not-a-manifest", []]) {
      expectInvalid(raw, "manifest");
    }

    const manifest = validManifest();
    delete manifest.schemaVersion;

    expectInvalid(manifest, "schemaVersion");
  });

  test("rejects v1 and other unsupported schema versions explicitly", () => {
    for (const schemaVersion of [1, 3]) {
      const manifest = validManifest();
      manifest.schemaVersion = schemaVersion;

      expect(parseManifest(manifest)).toEqual({
        ok: false,
        errors: [
          {
            path: "schemaVersion",
            message: `unsupported manifest schemaVersion ${schemaVersion}; expected 2`,
          },
        ],
      });
    }
  });

  test("accepts a complete v2 manifest", () => {
    const result = parseManifest(validManifest());

    expect(result).toEqual({ ok: true, manifest: fixture, errors: [] });
  });

  test("rejects MD engines on the legacy single-command worker path", () => {
    for (const software of ["amber", "gromacs"]) {
      const manifest = validManifest();
      manifest.software = software;
      expectInvalid(manifest, "software");
    }
  });

  test("rejects command fields and unknown top-level or nested fields", () => {
    const commandManifest = validManifest();
    commandManifest.command = { program: "orca", args: [], shell: false };
    expectInvalid(commandManifest, "manifest");

    const extraManifest = validManifest();
    extraManifest.extra = true;
    expectInvalid(extraManifest, "manifest");

    const nestedExtraManifest = validManifest();
    nestedExtraManifest.resources = { cores: 1, memoryGb: 1, extra: true };
    expectInvalid(nestedExtraManifest, "resources");
  });

  test("rejects invalid runner and software", () => {
    const runnerManifest = validManifest();
    runnerManifest.runner = "ssh";
    expectInvalid(runnerManifest, "runner");

    const softwareManifest = validManifest();
    softwareManifest.software = "shell";
    expectInvalid(softwareManifest, "software");
  });

  test("validates every identifier's empty, path, and length boundaries", () => {
    for (const field of ["jobId", "attemptId", "nodeName", "recipeId"]) {
      for (const value of ["", "invalid/id", "a".repeat(129)]) {
        const manifest = validManifest();
        manifest[field] = value;

        expectInvalid(manifest, field);
      }
    }
  });

  test("reserves .tmp only for job IDs", () => {
    const stagingJob = validManifest();
    stagingJob.jobId = "job.tmp";
    expectInvalid(stagingJob, "jobId");

    const manifest = validManifest();
    manifest.attemptId = "attempt.tmp";
    manifest.nodeName = "node.tmp";
    manifest.recipeId = "recipe.tmp";

    expect(parseManifest(manifest).ok).toBe(true);
  });

  test("rejects non-string, dot, separator, and Unicode control file names", () => {
    const unsafeNames = [
      42,
      ".",
      "..",
      "input/file",
      "input\\file",
      "input\0file",
      "input\rfile",
      "input\nfile",
      "input\tfile",
      "input\u0007file",
      "input\u007ffile",
    ];
    for (const field of ["inputName", "outputName"]) {
      for (const value of unsafeNames) {
        const manifest = validManifest();
        manifest[field] = value;

        expectInvalid(manifest, field);
      }
    }
  });

  test("accepts spaces, Unicode, emoji, and metacharacters as file-name data", () => {
    const manifest = validManifest();
    manifest.inputName = "naïve 😀 ; $(input) data.inp";
    manifest.outputName = "résultat & [data] output.out";

    expect(parseManifest(manifest).ok).toBe(true);
  });

  test("rejects a missing resources object", () => {
    const manifest = validManifest();
    delete manifest.resources;

    expectInvalid(manifest, "resources");
  });

  test("enforces core resource boundaries", () => {
    for (const cores of [0, 1.5, NaN, Infinity, "four", MAX_WORKER_CORES + 1]) {
      const manifest = validManifest();
      manifest.resources = { cores, memoryGb: 1 };

      expectInvalid(manifest, "resources.cores");
    }

    const missingCores = validManifest();
    missingCores.resources = { memoryGb: 1 };
    expectInvalid(missingCores, "resources.cores");

    const maximum = validManifest();
    maximum.resources = { cores: MAX_WORKER_CORES, memoryGb: 1 };
    expect(parseManifest(maximum).ok).toBe(true);
  });

  test("enforces memory resource boundaries", () => {
    for (const memoryGb of [0.05, NaN, Infinity, "one", MAX_WORKER_MEMORY_GB + 1]) {
      const manifest = validManifest();
      manifest.resources = { cores: 1, memoryGb };

      expectInvalid(manifest, "resources.memoryGb");
    }

    const missingMemory = validManifest();
    missingMemory.resources = { cores: 1 };
    expectInvalid(missingMemory, "resources.memoryGb");

    const maximum = validManifest();
    maximum.resources = { cores: 1, memoryGb: MAX_WORKER_MEMORY_GB };
    expect(parseManifest(maximum).ok).toBe(true);
  });

  test("accepts the minimum resources", () => {
    const manifest = validManifest();
    manifest.resources = { cores: 1, memoryGb: 0.1 };

    expect(parseManifest(manifest).ok).toBe(true);
  });

  test("enforces positive integer finite creation timestamps", () => {
    for (const createdAt of [-1, 0, 1.5, NaN, Infinity]) {
      const manifest = validManifest();
      manifest.createdAt = createdAt;

      expectInvalid(manifest, "createdAt");
    }
  });
});
