import { describe, expect, test } from "bun:test";
import { MAX_WORKER_CORES, MAX_WORKER_MEMORY_GB, parseManifest } from "@eigengrid/worker";

function validManifest(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    jobId: "job-001",
    attemptId: "attempt-001",
    nodeName: "worker-01",
    software: "orca",
    recipeId: "orca-opt",
    runner: "worker-daemon",
    inputName: "input ; naïve.inp",
    outputName: "input ; naïve.out",
    resources: { cores: 1, memoryGb: 1 },
    createdAt: Date.now(),
  };
}

function expectInvalid(raw: unknown, path?: string): void {
  const result = parseManifest(raw);
  expect(result.ok).toBe(false);
  if (!result.ok && path) {
    expect(
      result.errors.some((error) => error.path === path || error.path.startsWith(`${path}.`)),
    ).toBe(true);
  }
}

describe("WorkerJobManifest v2 security boundary", () => {
  test("accepts a command-free versioned manifest with data metacharacters", () => {
    const result = parseManifest(validManifest());

    expect(result.ok).toBe(true);
    if (result.ok) expect("command" in result.manifest).toBe(false);
  });

  test("rejects v1 and unsupported versions explicitly", () => {
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

  test("rejects serialized and injected commands", () => {
    const manifest = validManifest();
    manifest.command = { program: "touch", args: ["sentinel"], shell: true };

    expectInvalid(manifest, "manifest");
  });

  test("rejects unknown top-level and nested resource fields", () => {
    const topLevelExtra = validManifest();
    topLevelExtra.extra = true;
    const nestedExtra = validManifest();
    nestedExtra.resources = { cores: 1, memoryGb: 1, extra: true };

    expectInvalid(topLevelExtra, "manifest");
    expectInvalid(nestedExtra, "resources");
  });

  test("rejects unsafe path names and preserves data metacharacters", () => {
    for (const inputName of [
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
    ]) {
      const manifest = validManifest();
      manifest.inputName = inputName;
      expectInvalid(manifest, "inputName");
    }

    const manifest = validManifest();
    manifest.inputName = "naïve ; $(input) data.inp";
    manifest.outputName = "résultat & [data] output.out";
    expect(parseManifest(manifest).ok).toBe(true);
  });

  test("rejects invalid identifiers while allowing .tmp outside jobId", () => {
    for (const [field, value] of [
      ["jobId", "job.tmp"],
      ["attemptId", "attempt/id"],
      ["nodeName", "-node"],
      ["recipeId", "recipe id"],
    ]) {
      const manifest = validManifest();
      manifest[field] = value;
      expectInvalid(manifest, field);
    }

    const manifest = validManifest();
    manifest.attemptId = "attempt.tmp";
    manifest.nodeName = "node.tmp";
    manifest.recipeId = "recipe.tmp";
    expect(parseManifest(manifest).ok).toBe(true);
  });

  test("enforces software, resource, timestamp, and maximum boundaries", () => {
    const minimumMemory = validManifest();
    minimumMemory.resources = { cores: 1, memoryGb: 0.1 };
    expect(parseManifest(minimumMemory).ok).toBe(true);

    const maximum = validManifest();
    maximum.resources = { cores: MAX_WORKER_CORES, memoryGb: MAX_WORKER_MEMORY_GB };
    expect(parseManifest(maximum).ok).toBe(true);

    for (const [field, value] of [
      ["software", "shell"],
      ["software", "amber"],
      ["software", "gromacs"],
      ["createdAt", 0],
      ["createdAt", Infinity],
    ]) {
      const manifest = validManifest();
      manifest[field] = value;
      expectInvalid(manifest, field);
    }

    for (const resources of [
      { cores: 0, memoryGb: 1 },
      { cores: 1.5, memoryGb: 1 },
      { cores: Infinity, memoryGb: 1 },
      { cores: MAX_WORKER_CORES + 1, memoryGb: 1 },
      { cores: 1, memoryGb: 0.05 },
      { cores: 1, memoryGb: Infinity },
      { cores: 1, memoryGb: MAX_WORKER_MEMORY_GB + 1 },
    ]) {
      const manifest = validManifest();
      manifest.resources = resources;
      expectInvalid(manifest, "resources");
    }
  });
});
