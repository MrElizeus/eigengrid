import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import {
  JsonLinesIntegrityError,
  appendJsonLineSync,
  appendWorkerEvent,
  atomicWriteFileSync,
  executeBundle,
  readJsonLinesWithIntegrity,
  readWorkerEventsWithIntegrity,
  writeStatusFile,
} from "@eigengrid/worker";
import { appendDecision, readDecisionsWithIntegrity } from "@eigengrid/worker-agent";

function temp(): string {
  return mkdtempSync(join(tmpdir(), "worker-persistence-"));
}

describe("worker persistence", () => {
  test("atomic replacement leaves old or complete new data and cleans pre-rename temps", () => {
    const dir = temp();
    const path = join(dir, "status.json");
    try {
      writeFileSync(path, '{"state":"old"}');
      expect(() =>
        atomicWriteFileSync(path, '{"state":"new"}', (phase) => {
          if (phase === "before-temp-fsync") throw new Error("fault");
        }),
      ).toThrow("fault");
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ state: "old" });
      expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect(() =>
        atomicWriteFileSync(path, '{"state":"new"}', (phase) => {
          if (phase === "before-rename") throw new Error("fault");
        }),
      ).toThrow("fault");
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ state: "old" });
      expect(() =>
        atomicWriteFileSync(path, '{"state":"new"}', (phase) => {
          if (phase === "after-rename") throw new Error("fault");
        }),
      ).toThrow("fault");
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ state: "new" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("JSONL distinguishes valid tails, torn tails, and corruption", () => {
    const dir = temp();
    const path = join(dir, "audit.jsonl");
    try {
      appendJsonLineSync(path, { n: 1 });
      appendJsonLineSync(path, { n: 2 });
      expect(readJsonLinesWithIntegrity<{ n: number }>(path).records.map(({ n }) => n)).toEqual([
        1, 2,
      ]);
      expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
      writeFileSync(path, '{"n":1}\n{"n":2}');
      expect(readJsonLinesWithIntegrity<{ n: number }>(path).records).toHaveLength(2);
      writeFileSync(path, '{"n":1}\n{"n":');
      expect(readJsonLinesWithIntegrity(path)).toMatchObject({
        records: [{ n: 1 }],
        tornTail: { line: 2, raw: '{"n":' },
      });
      writeFileSync(path, '{"n":\n{"n":2}\n');
      expect(() => readJsonLinesWithIntegrity(path)).toThrow(JsonLinesIntegrityError);
      writeFileSync(path, '{"n":\n');
      expect(() => readJsonLinesWithIntegrity(path)).toThrow(JsonLinesIntegrityError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("events and decisions share durable JSONL behavior; status emits after replacement", () => {
    const dir = temp();
    try {
      appendWorkerEvent(dir, "worker.daemon.started");
      expect(readWorkerEventsWithIntegrity(dir).records).toHaveLength(1);
      appendDecision(dir, {
        id: "d",
        nodeId: "n",
        decision: "none",
        reason: "r",
        confidence: "low",
        mode: "recover-only",
        policy: "p",
        createdAt: 1,
      });
      expect(readDecisionsWithIntegrity(dir).records).toHaveLength(1);
      writeStatusFile(dir, {
        schemaVersion: 1,
        jobId: "j",
        attemptId: "a",
        state: "running",
        command: "cmd",
      });
      expect(existsSync(join(dir, "status.json"))).toBe(true);
      expect(
        readWorkerEventsWithIntegrity(dir).records.filter(
          (event) => event.type === "worker.process.started",
        ),
      ).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("executor retains exactly one mapped process-start event", async () => {
    const dir = temp();
    try {
      const manifest = {
        schemaVersion: 2,
        jobId: "j",
        attemptId: "a",
        nodeName: "n",
        software: "orca",
        recipeId: "orca-opt",
        runner: "worker-daemon",
        inputName: "input.inp",
        outputName: "input.out",
        resources: { cores: 1, memoryGb: 1 },
        createdAt: 1,
      };
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
      mkdirSync(join(dir, "input"));
      writeFileSync(join(dir, "input", "input.inp"), "x");
      const child = new EventEmitter() as EventEmitter & { pid: number };
      child.pid = 7;
      queueMicrotask(() => child.emit("close", 0));
      await executeBundle(dir, manifest, (() => child) as never);
      expect(
        readWorkerEventsWithIntegrity(dir).records.filter(
          (event) => event.type === "worker.process.started",
        ),
      ).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("executor waits for delayed log flushing before its terminal status", async () => {
    const dir = temp();
    try {
      const manifest = {
        schemaVersion: 2,
        jobId: "j",
        attemptId: "a",
        nodeName: "n",
        software: "orca",
        recipeId: "orca-opt",
        runner: "worker-daemon",
        inputName: "input.inp",
        outputName: "input.out",
        resources: { cores: 1, memoryGb: 1 },
        createdAt: 1,
      };
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
      mkdirSync(join(dir, "input"));
      writeFileSync(join(dir, "input", "input.inp"), "x");
      const child = Object.assign(new EventEmitter(), {
        pid: 8,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      queueMicrotask(() => {
        child.stdout.write("out\n");
        child.stderr.write("recipe failed\n");
        child.emit("close", 1);
        child.emit("error", new Error("late"));
        child.stdout.end();
        child.stderr.end();
      });
      expect(await executeBundle(dir, manifest, (() => child) as never)).toMatchObject({
        ok: false,
        exitCode: 1,
      });
      expect(readFileSync(join(dir, "logs", "stdout.log"), "utf8")).toBe("out\n");
      expect(readFileSync(join(dir, "logs", "stderr.log"), "utf8")).toBe("recipe failed\n");
      expect(
        readWorkerEventsWithIntegrity(dir).records.filter(
          (event) => event.type === "worker.job.failed",
        ),
      ).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
