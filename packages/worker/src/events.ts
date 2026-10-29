import { chmodSync, existsSync, lstatSync, mkdirSync } from "fs";
import { join } from "path";
import type { WorkerEvent, WorkerEventType } from "./types";
import { appendJsonLineSync, atomicWriteFileSync, readJsonLinesWithIntegrity } from "./persistence";

// ────────────────────────────────────────────────────────────
// Worker Event Log (events.jsonl)
// ────────────────────────────────────────────────────────────

export function appendWorkerEvent(
  bundleDir: string,
  type: WorkerEventType,
  fields?: Partial<WorkerEvent>,
): void {
  const event: WorkerEvent = {
    type,
    at: Date.now(),
    ...fields,
  };

  const eventsPath = join(bundleDir, "events.jsonl");
  const dir = bundleDir;

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const info = lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Worker event bundle is not a real directory: ${dir}`);
  }
  chmodSync(dir, 0o700);

  appendJsonLineSync(eventsPath, event);
}

export function readWorkerEvents(bundleDir: string): WorkerEvent[] {
  return readWorkerEventsWithIntegrity(bundleDir).records;
}

export function readWorkerEventsWithIntegrity(bundleDir: string) {
  return readJsonLinesWithIntegrity<WorkerEvent>(join(bundleDir, "events.jsonl"));
}

export function writeWorkerEvents(bundleDir: string, events: WorkerEvent[]): void {
  const eventsPath = join(bundleDir, "events.jsonl");
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  atomicWriteFileSync(eventsPath, lines);
}
