import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  TimestampSchema,
  canonicalJson,
  digestCanonical,
  type Digest,
} from "@eigengrid/colony-contracts";
import {
  CHECKPOINT_GENESIS_DIGEST,
  CHECKPOINT_SCHEMA_ID,
  CheckpointRecordSchema,
  ColonyEventSchema,
  type CheckpointRecord,
  type ColonyEvent,
} from "./state";

export interface CheckpointCursor {
  readonly sequence: number;
  readonly digest: Digest;
}

export interface LoadedCheckpoint {
  readonly records: readonly CheckpointRecord[];
  readonly cursor: CheckpointCursor;
  readonly tornTail: boolean;
}

export interface JsonlCheckpointStoreOptions {
  readonly maximumBytes?: number;
  readonly maximumRecords?: number;
}

export type CheckpointIntegrityCode =
  | "SIZE_LIMIT"
  | "RECORD_LIMIT"
  | "INVALID_UTF8"
  | "INVALID_JSON"
  | "INVALID_RECORD"
  | "SEQUENCE_MISMATCH"
  | "CHAIN_MISMATCH"
  | "DIGEST_MISMATCH"
  | "DUPLICATE_EVENT"
  | "CAMPAIGN_MISMATCH"
  | "CLOCK_REGRESSION";

export class CheckpointIntegrityError extends Error {
  constructor(
    readonly code: CheckpointIntegrityCode,
    message: string,
  ) {
    super(message);
    this.name = "CheckpointIntegrityError";
  }
}

export class CheckpointCursorConflictError extends Error {
  constructor(
    readonly expected: CheckpointCursor,
    readonly actual: CheckpointCursor,
  ) {
    super(
      `Checkpoint cursor changed: expected ${expected.sequence}/${expected.digest}, got ${actual.sequence}/${actual.digest}`,
    );
    this.name = "CheckpointCursorConflictError";
  }
}

export const EMPTY_CHECKPOINT_CURSOR: Readonly<CheckpointCursor> = Object.freeze({
  sequence: 0,
  digest: CHECKPOINT_GENESIS_DIGEST,
});

function unsignedRecord(record: CheckpointRecord): Record<string, unknown> {
  const unsigned = { ...record } as Record<string, unknown>;
  delete unsigned.recordDigest;
  return unsigned;
}

function sameCursor(left: CheckpointCursor, right: CheckpointCursor): boolean {
  return left.sequence === right.sequence && left.digest === right.digest;
}

function checkpointCursor(records: readonly CheckpointRecord[]): CheckpointCursor {
  const last = records.at(-1);
  return last
    ? { sequence: last.sequence, digest: last.recordDigest }
    : { ...EMPTY_CHECKPOINT_CURSOR };
}

/**
 * Single-supervisor durable event store. Every complete JSONL record is
 * self-digested and chained to its predecessor. A final unterminated fragment
 * is classified as a torn append and is never replayed.
 */
export class JsonlCheckpointStore {
  readonly #maximumBytes: number;
  readonly #maximumRecords: number;

  constructor(
    readonly path: string,
    options: JsonlCheckpointStoreOptions = {},
  ) {
    this.#maximumBytes = options.maximumBytes ?? 64 * 1024 * 1024;
    this.#maximumRecords = options.maximumRecords ?? 100_000;
    if (!Number.isSafeInteger(this.#maximumBytes) || this.#maximumBytes <= 0) {
      throw new TypeError("maximumBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#maximumRecords) || this.#maximumRecords <= 0) {
      throw new TypeError("maximumRecords must be a positive safe integer");
    }
  }

  load(expectedCampaignId?: string): LoadedCheckpoint {
    if (!existsSync(this.path)) {
      return { records: [], cursor: { ...EMPTY_CHECKPOINT_CURSOR }, tornTail: false };
    }
    const bytes = readFileSync(this.path);
    if (bytes.byteLength > this.#maximumBytes) {
      throw new CheckpointIntegrityError(
        "SIZE_LIMIT",
        `Checkpoint is ${bytes.byteLength} bytes; limit is ${this.#maximumBytes}`,
      );
    }

    const finalNewline = bytes.lastIndexOf(0x0a);
    const completeLength = finalNewline + 1;
    const tornTail = completeLength !== bytes.byteLength;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, completeLength));
    } catch (error) {
      throw new CheckpointIntegrityError(
        "INVALID_UTF8",
        `Checkpoint is not valid UTF-8: ${String(error)}`,
      );
    }
    const lines = completeLength === 0 ? [] : text.slice(0, -1).split("\n");
    if (lines.length > this.#maximumRecords) {
      throw new CheckpointIntegrityError(
        "RECORD_LIMIT",
        `Checkpoint has ${lines.length} records; limit is ${this.#maximumRecords}`,
      );
    }

    const records: CheckpointRecord[] = [];
    const eventIds = new Set<string>();
    let prior: Digest = CHECKPOINT_GENESIS_DIGEST;
    let campaignId = expectedCampaignId;
    let previousAt: string | undefined;

    for (const [index, line] of lines.entries()) {
      const lineNumber = index + 1;
      if (line.length === 0) {
        throw new CheckpointIntegrityError(
          "INVALID_JSON",
          `Blank JSONL record at line ${lineNumber}`,
        );
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new CheckpointIntegrityError(
          "INVALID_JSON",
          `Invalid JSON at checkpoint line ${lineNumber}: ${String(error)}`,
        );
      }
      const parsed = CheckpointRecordSchema.safeParse(value);
      if (!parsed.success) {
        throw new CheckpointIntegrityError(
          "INVALID_RECORD",
          `Invalid checkpoint record at line ${lineNumber}: ${parsed.error.message}`,
        );
      }
      const record = parsed.data;
      if (record.sequence !== lineNumber) {
        throw new CheckpointIntegrityError(
          "SEQUENCE_MISMATCH",
          `Checkpoint line ${lineNumber} declares sequence ${record.sequence}`,
        );
      }
      if (record.previousDigest !== prior) {
        throw new CheckpointIntegrityError(
          "CHAIN_MISMATCH",
          `Checkpoint chain mismatch at sequence ${record.sequence}`,
        );
      }
      if (record.recordDigest !== digestCanonical(unsignedRecord(record))) {
        throw new CheckpointIntegrityError(
          "DIGEST_MISMATCH",
          `Checkpoint digest mismatch at sequence ${record.sequence}`,
        );
      }
      if (eventIds.has(record.eventId)) {
        throw new CheckpointIntegrityError(
          "DUPLICATE_EVENT",
          `Duplicate event ID ${record.eventId} at sequence ${record.sequence}`,
        );
      }
      if (campaignId !== undefined && record.campaignId !== campaignId) {
        throw new CheckpointIntegrityError(
          "CAMPAIGN_MISMATCH",
          `Checkpoint record ${record.sequence} belongs to ${record.campaignId}, expected ${campaignId}`,
        );
      }
      if (previousAt !== undefined && Date.parse(record.at) < Date.parse(previousAt)) {
        throw new CheckpointIntegrityError(
          "CLOCK_REGRESSION",
          `Checkpoint time regressed at sequence ${record.sequence}`,
        );
      }
      campaignId ??= record.campaignId;
      previousAt = record.at;
      eventIds.add(record.eventId);
      prior = record.recordDigest;
      records.push(record);
    }

    return { records, cursor: checkpointCursor(records), tornTail };
  }

  /** Remove only the final unterminated append fragment, preserving all complete records. */
  repairTornTail(): boolean {
    if (!existsSync(this.path)) return false;
    const bytes = readFileSync(this.path);
    const finalNewline = bytes.lastIndexOf(0x0a);
    const completeLength = finalNewline + 1;
    if (completeLength === bytes.byteLength) return false;
    const descriptor = openSync(this.path, "r+");
    try {
      ftruncateSync(descriptor, completeLength);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    this.#fsyncDirectory();
    return true;
  }

  append(
    campaignId: string,
    atInput: string,
    eventInput: ColonyEvent,
    expectedCursor: CheckpointCursor,
  ): CheckpointRecord {
    const at = TimestampSchema.parse(atInput);
    const event = ColonyEventSchema.parse(eventInput);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = acquireCheckpointLock(`${this.path}.lock`);
    try {
      let loaded = this.load(campaignId);
      if (!sameCursor(expectedCursor, loaded.cursor)) {
        throw new CheckpointCursorConflictError(expectedCursor, loaded.cursor);
      }
      if (loaded.tornTail) {
        this.repairTornTail();
        loaded = this.load(campaignId);
        if (!sameCursor(expectedCursor, loaded.cursor)) {
          throw new CheckpointCursorConflictError(expectedCursor, loaded.cursor);
        }
      }
      const last = loaded.records.at(-1);
      if (last && Date.parse(at) < Date.parse(last.at)) {
        throw new CheckpointIntegrityError(
          "CLOCK_REGRESSION",
          "Append time precedes the last record",
        );
      }
      if (loaded.records.length >= this.#maximumRecords) {
        throw new CheckpointIntegrityError("RECORD_LIMIT", "Checkpoint record limit reached");
      }

      const unsigned = {
        schema: CHECKPOINT_SCHEMA_ID,
        eventId: randomUUID(),
        campaignId,
        sequence: loaded.cursor.sequence + 1,
        at,
        previousDigest: loaded.cursor.digest,
        event,
      };
      const record = CheckpointRecordSchema.parse({
        ...unsigned,
        recordDigest: digestCanonical(unsigned),
      });
      const encoded = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
      const existingBytes = existsSync(this.path) ? statSync(this.path).size : 0;
      if (existingBytes + encoded.byteLength > this.#maximumBytes) {
        throw new CheckpointIntegrityError("SIZE_LIMIT", "Checkpoint byte limit would be exceeded");
      }

      const descriptor = openSync(
        this.path,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        let offset = 0;
        while (offset < encoded.byteLength) {
          offset += writeSync(descriptor, encoded, offset, encoded.byteLength - offset);
        }
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      this.#fsyncDirectory();
      return record;
    } finally {
      releaseCheckpointLock(`${this.path}.lock`, lock);
    }
  }

  #fsyncDirectory(): void {
    const directory = dirname(this.path);
    const descriptor = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}

type CheckpointLock = { fd: number; token: string };

function acquireCheckpointLock(path: string): CheckpointLock {
  const token = `${process.pid}:${randomUUID()}`;
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      const bytes = Buffer.from(`${token}\n`, "utf8");
      let offset = 0;
      while (offset < bytes.byteLength)
        offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
      fsyncSync(fd);
      return { fd, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      let stale = false;
      try {
        stale = Date.now() - statSync(path).mtimeMs > 60_000;
        if (stale && !checkpointLockOwnerIsDead(path)) stale = false;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException)?.code !== "ENOENT") throw statError;
      }
      if (stale) {
        rmSync(path, { force: true });
        continue;
      }
      if (Date.now() - started >= 2_000) throw new Error(`Checkpoint is contended at ${path}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

function checkpointLockOwnerIsDead(path: string): boolean {
  let owner: string;
  try {
    owner = readFileSync(path, "utf8").trim();
  } catch {
    return false;
  }
  const pidText = owner.split(":", 1)[0] ?? "";
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function releaseCheckpointLock(path: string, lock: CheckpointLock): void {
  try {
    if (readFileSync(path, "utf8").trim() === lock.token) rmSync(path, { force: true });
  } finally {
    closeSync(lock.fd);
  }
}
