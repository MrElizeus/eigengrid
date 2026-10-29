import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CheckpointCursorConflictError,
  CheckpointIntegrityError,
  EMPTY_CHECKPOINT_CURSOR,
  JsonlCheckpointStore,
} from "./checkpoint-store";
import { T0 } from "./runtime-test-fixtures";

const temporaryDirectories: string[] = [];

function checkpoint(): { directory: string; path: string; store: JsonlCheckpointStore } {
  const directory = mkdtempSync(join(tmpdir(), "eigengrid-colony-checkpoint-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "campaign.jsonl");
  return { directory, path, store: new JsonlCheckpointStore(path) };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("durable JSONL checkpoint store", () => {
  test("appends a canonical digest chain and rejects stale cursors", () => {
    const { store } = checkpoint();
    const first = store.append(
      "campaign-1",
      T0,
      { type: "campaign_started" },
      EMPTY_CHECKPOINT_CURSOR,
    );
    const loaded = store.load("campaign-1");
    expect(loaded.records).toEqual([first]);
    expect(loaded.cursor).toEqual({ sequence: 1, digest: first.recordDigest });
    expect(() =>
      store.append(
        "campaign-1",
        "2026-08-30T00:00:01.000Z",
        { type: "campaign_started" },
        EMPTY_CHECKPOINT_CURSOR,
      ),
    ).toThrow(CheckpointCursorConflictError);
  });

  test("ignores and repairs only an unterminated torn tail", () => {
    const { path, store } = checkpoint();
    const first = store.append(
      "campaign-1",
      T0,
      { type: "campaign_started" },
      EMPTY_CHECKPOINT_CURSOR,
    );
    appendFileSync(path, '{"partial":', "utf8");
    expect(store.load("campaign-1")).toMatchObject({
      records: [first],
      cursor: { sequence: 1, digest: first.recordDigest },
      tornTail: true,
    });
    expect(store.repairTornTail()).toBe(true);
    expect(store.load("campaign-1").tornTail).toBe(false);
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
  });

  test("fails closed on a valid-shape record whose chained digest was tampered", () => {
    const { path, store } = checkpoint();
    store.append("campaign-1", T0, { type: "campaign_started" }, EMPTY_CHECKPOINT_CURSOR);
    const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    record.event = { type: "campaign_cancelled", reason: "tampered" };
    writeFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
    expect(() => store.load("campaign-1")).toThrow(CheckpointIntegrityError);
  });

  test("enforces finite byte and record bounds", () => {
    const { path } = checkpoint();
    const store = new JsonlCheckpointStore(path, { maximumBytes: 8_192, maximumRecords: 1 });
    const first = store.append(
      "campaign-1",
      T0,
      { type: "campaign_started" },
      EMPTY_CHECKPOINT_CURSOR,
    );
    expect(() =>
      store.append(
        "campaign-1",
        "2026-08-30T00:00:01.000Z",
        { type: "campaign_started" },
        { sequence: 1, digest: first.recordDigest },
      ),
    ).toThrow(/record limit/i);
  });
});
