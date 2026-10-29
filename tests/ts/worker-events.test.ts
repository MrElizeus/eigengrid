import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { appendWorkerEvent, readWorkerEvents } from "@eigengrid/worker";
import type { WorkerEventType } from "@eigengrid/worker";

// ────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────

describe("appendWorkerEvent", () => {
  test("appends event to events.jsonl in bundle dir", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-events-"));
    try {
      appendWorkerEvent(tmpDir, "worker.daemon.started", {
        message: "daemon up",
      });

      const eventsPath = join(tmpDir, "events.jsonl");
      expect(existsSync(eventsPath)).toBe(true);

      const content = readFileSync(eventsPath, "utf-8").trim();
      const lines = content.split("\n");
      expect(lines.length).toBe(1);

      const parsed = JSON.parse(lines[0]);
      expect(parsed.type).toBe("worker.daemon.started");
      expect(parsed.message).toBe("daemon up");
      expect(typeof parsed.at).toBe("number");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("appends multiple event types", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-events-"));
    try {
      appendWorkerEvent(tmpDir, "worker.daemon.started", {
        message: "started",
      });
      appendWorkerEvent(tmpDir, "worker.job.claimed", {
        jobId: "job-001",
        attemptId: "attempt-001",
      });
      appendWorkerEvent(tmpDir, "worker.job.completed", {
        jobId: "job-001",
        attemptId: "attempt-001",
        exitCode: 0,
      });

      const content = readFileSync(join(tmpDir, "events.jsonl"), "utf-8").trim();
      const lines = content.split("\n");
      expect(lines.length).toBe(3);

      const events = lines.map((l) => JSON.parse(l));
      expect(events[0].type).toBe("worker.daemon.started");
      expect(events[1].type).toBe("worker.job.claimed");
      expect(events[2].type).toBe("worker.job.completed");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("creates directory if it does not exist", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "worker-events-"));
    const nestedDir = join(baseDir, "deep", "bundle");
    try {
      appendWorkerEvent(nestedDir, "worker.daemon.started");

      expect(existsSync(nestedDir)).toBe(true);
      expect(existsSync(join(nestedDir, "events.jsonl"))).toBe(true);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

describe("readWorkerEvents", () => {
  test("reads back events in order", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-events-"));
    try {
      appendWorkerEvent(tmpDir, "worker.daemon.started", {
        message: "daemon started",
      });
      appendWorkerEvent(tmpDir, "worker.process.started", {
        jobId: "job-001",
        pid: 12345,
      });

      const events = readWorkerEvents(tmpDir);
      expect(events.length).toBe(2);
      expect(events[0].type).toBe("worker.daemon.started");
      expect(events[0].message).toBe("daemon started");
      expect(events[1].type).toBe("worker.process.started");
      expect(events[1].pid).toBe(12345);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns empty array for non-existent events.jsonl", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-events-"));
    try {
      const events = readWorkerEvents(tmpDir);
      expect(events).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns empty array for empty events.jsonl", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-events-"));
    try {
      // Create empty file
      writeFileSync(join(tmpDir, "events.jsonl"), "", "utf-8");

      const events = readWorkerEvents(tmpDir);
      expect(events).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("multiple events are preserved in order", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "worker-events-"));
    try {
      const types: WorkerEventType[] = [
        "worker.daemon.started",
        "worker.job.claimed",
        "worker.process.started",
        "worker.process.completed",
        "worker.artifact.available",
        "worker.job.completed",
        "worker.daemon.stopped",
      ];

      for (const type of types) {
        appendWorkerEvent(tmpDir, type, { message: type });
      }

      const events = readWorkerEvents(tmpDir);
      expect(events.length).toBe(7);

      for (let i = 0; i < types.length; i++) {
        expect(events[i].type).toBe(types[i]);
        expect(events[i].message).toBe(types[i]);
      }

      // Verify timestamps are in ascending order
      for (let i = 1; i < events.length; i++) {
        expect(events[i].at).toBeGreaterThanOrEqual(events[i - 1].at);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
