import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { canonicalEffectJson, parseVerifiedEffectJournalFrame } from "./digest";
import { EffectJournalIntegrityError, type EffectJournalStore } from "./journal";
import type { EffectJournalFrame } from "./schemas";

export type JsonlTestStoreFaultPhase = "before-temp-fsync" | "before-rename" | "after-rename";

export interface AtomicJsonlEffectJournalTestStoreOptions {
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  observeFault?: (phase: JsonlTestStoreFaultPhase) => void;
}

export class EffectJournalLockTimeoutError extends Error {
  readonly code = "EFFECT_JOURNAL_LOCK_TIMEOUT";

  constructor(
    readonly path: string,
    readonly timeoutMs: number,
  ) {
    super(`Timed out acquiring effect journal test lock ${path} after ${timeoutMs}ms`);
    this.name = "EffectJournalLockTimeoutError";
  }
}

export class EffectJournalJsonlIntegrityError extends EffectJournalIntegrityError {
  constructor(
    readonly path: string,
    readonly line: number,
    detail: string,
  ) {
    super(`Malformed effect journal JSONL at ${path}:${line}: ${detail}`);
    this.name = "EffectJournalJsonlIntegrityError";
  }
}

function writeAll(descriptor: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(descriptor, data, offset, data.length - offset);
    if (written <= 0) throw new Error("Effect journal test-store write made no progress");
    offset += written;
  }
}

function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!(code && ["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(code))) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readFrames(path: string): EffectJournalFrame[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8");
  if (content.length === 0) return [];
  if (!content.endsWith("\n")) {
    throw new EffectJournalJsonlIntegrityError(
      path,
      content.split("\n").length,
      "unterminated/torn final record",
    );
  }
  const lines = content.slice(0, -1).split("\n");
  return lines.map((line, index) => {
    if (line.length === 0) {
      throw new EffectJournalJsonlIntegrityError(path, index + 1, "blank records are not allowed");
    }
    try {
      return parseVerifiedEffectJournalFrame(JSON.parse(line));
    } catch (error) {
      throw new EffectJournalJsonlIntegrityError(
        path,
        index + 1,
        error instanceof Error ? error.message : String(error),
      );
    }
  });
}

function replaceFramesAtomically(
  path: string,
  frames: readonly EffectJournalFrame[],
  observeFault?: (phase: JsonlTestStoreFaultPhase) => void,
): void {
  const parent = dirname(path);
  const temporary = join(parent, `.${randomUUID()}.effect-journal.tmp`);
  const content = frames.map((frame) => canonicalEffectJson(frame)).join("\n") + "\n";
  let descriptor: number | undefined;
  let renamed = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    writeAll(descriptor, Buffer.from(content, "utf8"));
    observeFault?.("before-temp-fsync");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    observeFault?.("before-rename");
    renameSync(temporary, path);
    renamed = true;
    syncDirectory(parent);
    observeFault?.("after-rename");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!renamed) rmSync(temporary, { force: true });
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Atomic, replayable JSONL adapter for contract/fault tests only.
 *
 * It serializes independent instances with an exclusive lock file and replaces
 * the complete journal only after fsync. It deliberately has no stale-lock
 * recovery, fencing, backup, or multi-host guarantees and is not a production
 * persistence provider.
 */
export class AtomicJsonlEffectJournalTestStore implements EffectJournalStore {
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;

  constructor(
    private readonly path: string,
    private readonly options: AtomicJsonlEffectJournalTestStoreOptions = {},
  ) {
    if (!path) throw new TypeError("An effect journal test-store path is required");
    this.lockPath = `${path}.lock`;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 2_000;
    this.lockRetryMs = options.lockRetryMs ?? 2;
    if (!Number.isInteger(this.lockTimeoutMs) || this.lockTimeoutMs < 1) {
      throw new TypeError("lockTimeoutMs must be a positive integer");
    }
    if (!Number.isInteger(this.lockRetryMs) || this.lockRetryMs < 1) {
      throw new TypeError("lockRetryMs must be a positive integer");
    }
  }

  async read(): Promise<readonly EffectJournalFrame[]> {
    return structuredClone(readFrames(this.path));
  }

  async compareAndAppend(expectedSequence: number, frame: EffectJournalFrame): Promise<boolean> {
    const verified = parseVerifiedEffectJournalFrame(frame);
    if (!Number.isInteger(expectedSequence) || expectedSequence < 0) {
      throw new TypeError("expectedSequence must be a non-negative integer");
    }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = await this.acquireLock();
    try {
      const current = readFrames(this.path);
      if (current.length !== expectedSequence) return false;
      if (verified.sequence !== expectedSequence + 1) {
        throw new EffectJournalIntegrityError(
          `Frame sequence ${verified.sequence} does not follow ${expectedSequence}`,
        );
      }
      replaceFramesAtomically(this.path, [...current, verified], this.options.observeFault);
      return true;
    } finally {
      closeSync(lock);
      rmSync(this.lockPath, { force: true });
    }
  }

  private async acquireLock(): Promise<number> {
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        return openSync(
          this.lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) {
          throw new EffectJournalLockTimeoutError(this.lockPath, this.lockTimeoutMs);
        }
        await delay(this.lockRetryMs);
      }
    }
  }
}
