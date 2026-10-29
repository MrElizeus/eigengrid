import { chmod, mkdtemp, open, rm } from "fs/promises";
import { constants, createReadStream, createWriteStream } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import * as tar from "tar";

export const ARCHIVE_PREFLIGHT_LIMITS = Object.freeze({
  maxCompressedBytes: 4_294_967_296,
  maxRegularFileBytes: 17_179_869_184,
  maxExpandedRegularFileBytes: 68_719_476_736,
  maxEntries: 100_000,
  maxExpansionRatio: 200,
  maxPathCharacters: 4096,
  maxPathLevels: 64,
});

export type ArchivePreflightLimits = typeof ARCHIVE_PREFLIGHT_LIMITS;
export type ArchiveEntry = Pick<tar.ReadEntry, "path" | "type" | "size" | "meta"> & {
  linkpath?: string;
  extended?: unknown;
};

export class ArchiveEntryPolicy {
  private readonly paths = new Set<string>();
  private readonly files = new Set<string>();
  private readonly parents = new Set<string>();
  private entries = 0;
  private total = 0;

  constructor(private readonly limits: ArchivePreflightLimits = ARCHIVE_PREFLIGHT_LIMITS) {}

  check(entry: ArchiveEntry): void {
    if (entry.meta) return this.checkMetadata();
    this.checkMetadata();
    if (entry.linkpath) throw new Error(`Archive entry has a link target: ${entry.path}`);
    if (entry.type !== "File" && entry.type !== "OldFile" && entry.type !== "Directory") {
      throw new Error(`Unsupported archive entry type: ${entry.type}`);
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0)
      throw new Error(`Invalid entry size: ${entry.path}`);
    const key = canonicalPath(entry.path, entry.type === "Directory", this.limits);
    if (this.paths.has(key)) throw new Error(`Duplicate archive path: ${entry.path}`);
    const segments = key.split("/");
    let parent = segments[0];
    for (let i = 1; i < segments.length; i++) {
      if (this.files.has(parent)) throw new Error(`File has descendant: ${entry.path}`);
      parent += `/${segments[i]}`;
    }
    if (entry.type === "Directory") {
      if (entry.size !== 0) throw new Error(`Directory has nonzero size: ${entry.path}`);
    } else {
      if (entry.path.endsWith("/"))
        throw new Error(`Regular file has trailing slash: ${entry.path}`);
      if (entry.size > this.limits.maxRegularFileBytes)
        throw new Error(`Archive entry exceeds regular-file limit: ${entry.path}`);
      if (this.total > this.limits.maxExpandedRegularFileBytes - entry.size)
        throw new Error("Archive exceeds expanded-size limit");
      this.total += entry.size;
      if (this.parents.has(key)) throw new Error(`File conflicts with descendant: ${entry.path}`);
      this.files.add(key);
    }
    this.paths.add(key);
    parent = segments[0];
    for (let i = 1; i < segments.length; i++) {
      this.parents.add(parent);
      parent += `/${segments[i]}`;
    }
  }

  checkMetadata(): void {
    if (++this.entries > this.limits.maxEntries) throw new Error("Archive has too many entries");
  }

  checkIgnored(entry: ArchiveEntry): void {
    this.checkMetadata();
    throw new Error(`Unsupported archive entry type: ${entry.type} (${entry.path})`);
  }

  checkRatio(compressedBytes: number): void {
    if (this.total > compressedBytes * this.limits.maxExpansionRatio)
      throw new Error("Archive exceeds declared expansion ratio");
  }
}

export function canonicalPath(
  path: string,
  directory: boolean,
  limits: ArchivePreflightLimits = ARCHIVE_PREFLIGHT_LIMITS,
): string {
  if (
    !path ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path)
  )
    throw new Error(`Invalid archive path: ${path}`);
  if (path !== path.normalize("NFC") || Array.from(path).length > limits.maxPathCharacters)
    throw new Error(`Invalid archive path: ${path}`);
  const normalized = directory && path.endsWith("/") ? path.slice(0, -1) : path;
  if (!normalized || normalized.includes("//")) throw new Error(`Invalid archive path: ${path}`);
  const segments = normalized.split("/");
  if (
    segments.length > limits.maxPathLevels ||
    segments.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part),
    )
  )
    throw new Error(`Invalid archive path: ${path}`);
  return segments.map((part) => part.toLowerCase()).join("/");
}

async function copyArchive(source: string, target: string, limit: number): Promise<number> {
  let handle;
  try {
    handle = await open(
      source,
      constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      throw new Error("Backup input must be a regular file");
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Backup input must be a regular file");
    let size = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        callback(size > limit ? new Error("Archive exceeds compressed-size limit") : null, chunk);
      },
    });
    await pipeline(
      createReadStream(source, { fd: handle.fd, autoClose: false }),
      counter,
      createWriteStream(target, { flags: "wx", mode: 0o600 }),
    );
    await chmod(target, 0o600);
    return size;
  } finally {
    await handle.close().catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EBADF") throw error;
    });
  }
}

export async function preflightArchive(
  file: string,
  compressedBytes: number,
  limits: ArchivePreflightLimits = ARCHIVE_PREFLIGHT_LIMITS,
  observed?: (path: string) => void,
): Promise<void> {
  const policy = new ArchiveEntryPolicy(limits);
  await new Promise<void>((resolve, reject) => {
    const source = createReadStream(file);
    const parser = new tar.Parser({ strict: true, maxMetaEntrySize: 1_048_576 });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      source.destroy();
      error ? reject(error) : resolve();
    };
    const abort = (error: Error) => {
      if (settled) return;
      try {
        parser.abort(error);
      } catch {
        finish(error);
      }
    };
    parser.on("entry", (entry: tar.ReadEntry) => {
      observed?.(entry.path);
      try {
        policy.check(entry);
        entry.resume();
      } catch (error) {
        abort(error instanceof Error ? error : new Error(String(error)));
      }
    });
    parser.on("ignoredEntry", (entry: tar.ReadEntry) => {
      try {
        policy.checkIgnored(entry);
      } catch (error) {
        abort(error instanceof Error ? error : new Error(String(error)));
      }
    });
    parser.on("meta", (raw: string) => {
      try {
        policy.checkMetadata();
        if (/(?:^|\n)\d+ (?:GNU\.sparse[^=]*|SCHILY\.realsize)=/.test(raw))
          throw new Error("Sparse archive metadata");
      } catch (error) {
        abort(error instanceof Error ? error : new Error(String(error)));
      }
    });
    parser.on("abort", (error: Error) => finish(error));
    parser.on("error", (error: Error) => finish(error));
    parser.on("end", () => finish());
    parser.on("drain", () => source.resume());
    source.on("data", (chunk: Buffer) => {
      try {
        if (!parser.write(chunk)) source.pause();
      } catch (error) {
        abort(error instanceof Error ? error : new Error(String(error)));
      }
    });
    source.on("end", () => {
      try {
        parser.end();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    source.on("error", (error) => finish(error));
  });
  policy.checkRatio(compressedBytes);
}

export type PreflightedArchive = { stableArchive: string; root: string; compressedBytes: number };

export async function withPreflightedArchive<T>(
  source: string,
  action: (stableArchive: string, context: PreflightedArchive) => Promise<T>,
  limits: ArchivePreflightLimits = ARCHIVE_PREFLIGHT_LIMITS,
  copied?: (bytes: number) => void,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "eigengrid-verify-"));
  try {
    await chmod(root, 0o700);
    const stableArchive = join(root, "archive.tar.gz");
    const compressedBytes = await copyArchive(source, stableArchive, limits.maxCompressedBytes);
    copied?.(compressedBytes);
    await preflightArchive(stableArchive, compressedBytes, limits);
    return await action(stableArchive, { stableArchive, root, compressedBytes });
  } finally {
    await rm(root, { recursive: true, force: false });
  }
}
