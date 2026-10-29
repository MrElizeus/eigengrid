import { describe, expect, test } from "bun:test";
import { spawn as nodeSpawn } from "child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { executeBundle, readStatusFile, readWorkerEvents } from "@eigengrid/worker";
import type { SpawnAdapter, WorkerJobManifest } from "@eigengrid/worker";

const manifest = (inputName = "input.inp"): WorkerJobManifest => ({
  schemaVersion: 2,
  jobId: "job-input",
  attemptId: "attempt-input",
  nodeName: "worker",
  software: "orca",
  recipeId: "orca-opt",
  runner: "worker-daemon",
  inputName,
  outputName: inputName.replace(/\.inp$/, ".out"),
  resources: { cores: 1, memoryGb: 1 },
  createdAt: 1,
});

function adapter(observe?: () => void): { spawn: SpawnAdapter; calls: () => number } {
  let count = 0;
  return {
    spawn: (() => {
      count++;
      observe?.();
      return nodeSpawn(process.execPath, ["-e", ""], { stdio: ["ignore", "pipe", "pipe"] });
    }) as SpawnAdapter,
    calls: () => count,
  };
}

function bundle(root: string, job: WorkerJobManifest): string {
  const path = join(root, "bundle");
  mkdirSync(path);
  writeFileSync(join(path, "manifest.json"), JSON.stringify(job));
  mkdirSync(join(path, "input"));
  return path;
}

describe("worker input materialization", () => {
  test("copies source before spawn and replaces stale working input independently", async () => {
    const root = mkdtempSync(join(tmpdir(), "worker-input-"));
    try {
      const job = manifest("naïve space;$(data).inp");
      const path = bundle(root, job);
      const source = join(path, "input", job.inputName);
      writeFileSync(source, "source bytes");
      mkdirSync(join(path, "work"));
      writeFileSync(join(path, "work", job.inputName), "stale bytes");
      const fake = adapter(() =>
        expect(readFileSync(join(path, "work", job.inputName), "utf8")).toBe("source bytes"),
      );

      expect((await executeBundle(path, undefined, fake.spawn)).ok).toBe(true);
      const work = join(path, "work", job.inputName);
      expect(readFileSync(work, "utf8")).toBe(readFileSync(source, "utf8"));
      expect(lstatSync(work).ino).not.toBe(lstatSync(source).ino);
      writeFileSync(work, "stale again");
      await executeBundle(path, undefined, fake.spawn);
      expect(readFileSync(work, "utf8")).toBe("source bytes");
      expect(readFileSync(source, "utf8")).toBe("source bytes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails unsafe sources and work symlinks before spawn without PID or process-start", async () => {
    for (const kind of [
      "missing",
      "wrong-name",
      "directory",
      "symlink",
      "hardlink",
      "work-symlink",
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), "worker-input-"));
      try {
        const job = manifest();
        const path = bundle(root, job);
        const source = join(path, "input", job.inputName);
        if (kind === "wrong-name") writeFileSync(join(path, "input", "other.inp"), "input");
        if (kind === "directory") mkdirSync(source);
        if (kind === "symlink") {
          const outside = join(root, "outside");
          writeFileSync(outside, "input");
          symlinkSync(outside, source);
        }
        if (kind === "hardlink") {
          const other = join(path, "input", "other.inp");
          writeFileSync(other, "input");
          linkSync(other, source);
        }
        if (kind === "work-symlink") {
          writeFileSync(source, "input");
          const outside = join(root, "outside-work");
          mkdirSync(outside);
          symlinkSync(outside, join(path, "work"));
        }
        const fake = adapter();
        const result = await executeBundle(path, undefined, fake.spawn);
        expect(result.ok).toBe(false);
        expect(result.error).toContain("unsafe worker layout");
        expect(fake.calls()).toBe(0);
        expect(readStatusFile(path)?.state).toBe("failed");
        expect(existsSync(join(path, "pid"))).toBe(false);
        expect(
          readWorkerEvents(path).some((event) => event.type === "worker.process.started"),
        ).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("anchors directory and source operations across deterministic path substitutions", async () => {
    const root = mkdtempSync(join(tmpdir(), "worker-input-race-"));
    try {
      const job = manifest();
      const path = bundle(root, job);
      const source = join(path, "input", job.inputName);
      writeFileSync(source, "original bytes");
      const inputRace = adapter();
      const inputResult = await executeBundle(path, undefined, inputRace.spawn, (phase) => {
        if (phase === "directories-opened") {
          renameSync(join(path, "input"), join(path, "input-held"));
          mkdirSync(join(path, "input"));
          writeFileSync(join(path, "input", job.inputName), "replacement bytes");
        }
      });
      expect(inputResult.ok).toBe(false);
      expect(inputRace.calls()).toBe(0);

      rmSync(path, { recursive: true, force: true });
      mkdirSync(path);
      writeFileSync(join(path, "manifest.json"), JSON.stringify(job));
      mkdirSync(join(path, "input"));
      writeFileSync(source, "original bytes");
      const workRace = adapter();
      const workResult = await executeBundle(path, undefined, workRace.spawn, (phase) => {
        if (phase === "directories-opened") {
          renameSync(join(path, "work"), join(path, "work-held"));
          mkdirSync(join(path, "work"));
        }
      });
      expect(workResult.ok).toBe(false);
      expect(workRace.calls()).toBe(0);
      expect(existsSync(join(path, "work", job.inputName))).toBe(false);

      rmSync(path, { recursive: true, force: true });
      mkdirSync(path);
      writeFileSync(join(path, "manifest.json"), JSON.stringify(job));
      mkdirSync(join(path, "input"));
      writeFileSync(source, "original bytes");
      const sourceRace = adapter(() =>
        expect(readFileSync(join(path, "work", job.inputName), "utf8")).toBe("original bytes"),
      );
      expect(
        (
          await executeBundle(path, undefined, sourceRace.spawn, (phase) => {
            if (phase === "source-opened") {
              rmSync(source);
              writeFileSync(join(root, "replacement"), "replacement bytes");
              symlinkSync(join(root, "replacement"), source);
            }
          })
        ).ok,
      ).toBe(true);
      expect(readFileSync(join(path, "work", job.inputName), "utf8")).toBe("original bytes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
