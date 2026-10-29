import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

export type PersistenceFaultPhase = "before-temp-fsync" | "before-rename" | "after-rename";
export type PersistenceFaultObserver = (phase: PersistenceFaultPhase) => void;

/** A JSONL integrity failure identifies the physical record that cannot be trusted. */
export class JsonLinesIntegrityError extends Error {
  constructor(
    readonly path: string,
    readonly line: number,
    cause: unknown,
  ) {
    super(`Malformed JSONL record at ${path}:${line}: ${(cause as Error).message}`);
    this.name = "JsonLinesIntegrityError";
  }
}

export interface TornJsonLine {
  line: number;
  raw: string;
}

function writeAll(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset);
    if (written <= 0) throw new Error("write made no progress");
    offset += written;
  }
}

function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0));
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!(["EINVAL", "ENOTSUP", "EOPNOTSUPP"] as string[]).includes(code ?? "")) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Replace a file only by rename after its complete temporary contents are durable. */
export function atomicWriteFileSync(
  path: string,
  data: string | Buffer,
  observe?: PersistenceFaultObserver,
): void {
  const dir = dirname(path);
  const temp = join(dir, `.${randomUUID()}.tmp`);
  let fd: number | undefined;
  let renamed = false;
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeAll(fd, Buffer.isBuffer(data) ? data : Buffer.from(data));
    observe?.("before-temp-fsync");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    observe?.("before-rename");
    renameSync(temp, path);
    renamed = true;
    observe?.("after-rename");
    syncDirectory(dir);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!renamed) rmSync(temp, { force: true });
  }
}

/** Append exactly one durable JSONL record; short writes are failures, never retries. */
export function appendJsonLineSync(path: string, record: unknown): void {
  const data = Buffer.from(`${JSON.stringify(record)}\n`);
  const existed = existsSync(path);
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < data.length) {
      const written = writeSync(fd, data, offset, data.length - offset);
      if (written <= 0) throw new Error(`Partial JSONL append to ${path}`);
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // A newly-created event/receipt spool is not durable until its directory
  // entry is synced as well as the file contents.
  if (!existed) syncDirectory(dirname(path));
}

/** Read JSONL, accepting only an unparseable final unterminated fragment as a torn tail. */
export function readJsonLinesWithIntegrity<T>(path: string): {
  records: T[];
  tornTail?: TornJsonLine;
} {
  if (!existsSync(path)) return { records: [] };
  const content = readFileSync(path, "utf-8");
  const terminated = content.endsWith("\n");
  const lines = content.split("\n");
  if (terminated) lines.pop();
  const records: T[] = [];
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    if (!raw.trim()) continue; // compatibility with legacy blank lines
    try {
      records.push(JSON.parse(raw) as T);
    } catch (error) {
      if (!terminated && index === lines.length - 1)
        return { records, tornTail: { line: index + 1, raw } };
      throw new JsonLinesIntegrityError(path, index + 1, error);
    }
  }
  return { records };
}
