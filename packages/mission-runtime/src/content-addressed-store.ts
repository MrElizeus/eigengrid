import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, realpath, unlink, link } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CAS_URI_PATTERN = /^cas:\/\/sha256\/([a-f0-9]{64})$/u;
const STREAM_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_MAX_BUFFERED_READ_BYTES = 64 * 1024 * 1024;

export type ContentDigest = string;

export type ContentAddressedStoreErrorCode =
  | "INVALID_ROOT"
  | "NOT_INITIALIZED"
  | "INVALID_DIGEST"
  | "INVALID_URI"
  | "NOT_FOUND"
  | "UNSAFE_OBJECT"
  | "DIGEST_MISMATCH"
  | "OBJECT_TOO_LARGE"
  | "READ_ONLY"
  | "IO_ERROR";

export class ContentAddressedStoreError extends Error {
  constructor(
    readonly code: ContentAddressedStoreErrorCode,
    message: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ContentAddressedStoreError";
  }
}

export interface StoredContent {
  digest: ContentDigest;
  uri: string;
  sizeBytes: number;
  existed: boolean;
}

export interface VerifiedContent {
  digest: ContentDigest;
  uri: string;
  bytes: Uint8Array;
  sizeBytes: number;
}

export interface VerifiedContentMetadata {
  digest: ContentDigest;
  uri: string;
  sizeBytes: number;
}

export interface VerifiedContentStream {
  digest: ContentDigest;
  uri: string;
  sizeBytes: number;
  /** Single-consumer stream from the already verified, descriptor-bound object. */
  bytes: AsyncIterable<Uint8Array>;
}

export interface PutStreamOptions {
  /** Optional application-level capacity guard; omitted means no per-object limit. */
  maxBytes?: number;
}

export interface VerifiedReadOptions {
  /** Reject oversized descriptor metadata before hashing any object bytes. */
  maxBytes?: number;
}

export interface ContentAddressedArtifactStoreOptions {
  /** Open a pre-existing publication without mkdir/chmod/fsync/write authority.
   * This does not grant access: filesystem permissions and project authorization
   * must already allow this service to read the specific provisioned namespace.
   */
  access?: "read-write" | "read-only";
  /** Explicit publication writer in a site-provisioned namespace. Root, sha256
   * and all 256 shards must already be owned by this process/group with 2750;
   * .staging must be 2700. No mkdir/chmod in this mode. Readers get traversal/read,
   * never ownership. Site provisioning controls the reader group membership.
   * Do not use for the private Head CAS. Default remains private (0700).
   */
  publicationGroup?: number;
  /** Buffered reads fail above this threshold; use getStream for large trajectories. */
  maxBufferedReadBytes?: number;
}

interface OpenedVerifiedObject {
  handle: FileHandle;
  shardHandle: FileHandle;
  sizeBytes: number;
}

function validateDigest(value: string): ContentDigest {
  if (!SHA256_PATTERN.test(value)) {
    throw new ContentAddressedStoreError(
      "INVALID_DIGEST",
      "Content digest must be a lowercase SHA-256 value",
    );
  }
  return value;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function ioError(error: unknown, operation: string): ContentAddressedStoreError {
  if (error instanceof ContentAddressedStoreError) return error;
  return new ContentAddressedStoreError("IO_ERROR", `CAS ${operation} failed`, {
    causeCode: errorCode(error),
  });
}

function validateLimit(value: number | undefined, fallback?: number): number | undefined {
  const limit = value ?? fallback;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
    throw new ContentAddressedStoreError(
      "IO_ERROR",
      "CAS byte limits must be positive safe integers",
    );
  }
  return limit;
}

function validateReadLimit(value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new ContentAddressedStoreError(
      "IO_ERROR",
      "CAS verified-read byte limits must be nonnegative safe integers",
    );
  }
  return value;
}

function descriptorPath(handle: FileHandle, child?: string): string {
  const root = `/proc/self/fd/${handle.fd}`;
  return child === undefined ? root : join(root, child);
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // Preserve the authoritative operation failure.
  }
}

async function writeChunk(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (result.bytesWritten <= 0) {
      throw new ContentAddressedStoreError("IO_ERROR", "CAS write made no progress");
    }
    offset += result.bytesWritten;
  }
}

/**
 * Filesystem-backed SHA-256 store for trusted application services.
 *
 * Namespace operations are anchored through open directory descriptors under
 * `/proc/self/fd`, so replacing a configured path or digest shard cannot redirect
 * a publish/read outside the initialized store. The Linux descriptor boundary is
 * deliberate: platforms without it fail initialization instead of silently losing
 * the replacement-race guarantee.
 */
export class ContentAddressedArtifactStore {
  private rootHandle: FileHandle | undefined;
  private shaRootHandle: FileHandle | undefined;
  private readonly maxBufferedReadBytes: number;
  private readonly readOnly: boolean;
  private readonly publicationGroup: number | undefined;

  constructor(
    private readonly configuredRoot: string,
    options: ContentAddressedArtifactStoreOptions = {},
  ) {
    if (!isAbsolute(configuredRoot)) {
      throw new ContentAddressedStoreError("INVALID_ROOT", "CAS root must be an absolute path");
    }
    if (options.access !== undefined && !["read-write", "read-only"].includes(options.access)) {
      throw new ContentAddressedStoreError("INVALID_ROOT", "Invalid CAS access mode");
    }
    this.readOnly = options.access === "read-only";
    this.publicationGroup = options.publicationGroup;
    if (
      this.publicationGroup !== undefined &&
      (this.readOnly ||
        !Number.isSafeInteger(this.publicationGroup) ||
        this.publicationGroup <= 0 ||
        this.publicationGroup >= 4_294_967_295 ||
        ![...(process.getgroups?.() ?? []), process.getgid?.()].includes(this.publicationGroup))
    ) {
      throw new ContentAddressedStoreError("INVALID_ROOT", "Invalid CAS publication group");
    }
    this.maxBufferedReadBytes = validateLimit(
      options.maxBufferedReadBytes,
      DEFAULT_MAX_BUFFERED_READ_BYTES,
    )!;
  }

  async init(): Promise<void> {
    await this.close();
    let rootHandle: FileHandle | undefined;
    let shaRootHandle: FileHandle | undefined;
    try {
      if (!this.readOnly && this.publicationGroup === undefined)
        await mkdir(this.configuredRoot, { recursive: true, mode: 0o700 });
      const rootStat = await lstat(this.configuredRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new ContentAddressedStoreError(
          "INVALID_ROOT",
          "CAS root must be a real directory, not a symlink",
        );
      }
      rootHandle = await open(
        this.configuredRoot,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      if (!(await rootHandle.stat()).isDirectory()) {
        throw new ContentAddressedStoreError(
          "INVALID_ROOT",
          "CAS root descriptor is not a directory",
        );
      }
      if (!this.readOnly) await this.configureDirectory(rootHandle);

      // Resolving the descriptor proves that the Linux descriptor namespace exists.
      const boundRoot = await realpath(descriptorPath(rootHandle));
      const configuredRealRoot = await realpath(this.configuredRoot);
      if (boundRoot !== configuredRealRoot) {
        throw new ContentAddressedStoreError(
          "INVALID_ROOT",
          "CAS root changed while it was being initialized",
        );
      }

      if (!this.readOnly && this.publicationGroup === undefined) {
        try {
          await mkdir(descriptorPath(rootHandle, "sha256"), { mode: 0o700 });
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
        }
      }
      shaRootHandle = await this.openDirectory(rootHandle, "sha256", "INVALID_ROOT");
      if (!this.readOnly) {
        await this.configureDirectory(shaRootHandle);
        if (this.publicationGroup === undefined) {
          try {
            await mkdir(descriptorPath(shaRootHandle, ".staging"), { mode: 0o700 });
          } catch (error) {
            if (errorCode(error) !== "EEXIST") throw error;
          }
        }
        const stagingHandle = await this.openDirectory(shaRootHandle, ".staging", "INVALID_ROOT");
        try {
          await this.configureDirectory(stagingHandle, true);
        } finally {
          await stagingHandle.close();
        }
        await shaRootHandle.sync();
      }

      this.rootHandle = rootHandle;
      this.shaRootHandle = shaRootHandle;
    } catch (error) {
      await closeQuietly(shaRootHandle);
      await closeQuietly(rootHandle);
      throw ioError(error, "initialization");
    }
  }

  async close(): Promise<void> {
    const shaRootHandle = this.shaRootHandle;
    const rootHandle = this.rootHandle;
    this.shaRootHandle = undefined;
    this.rootHandle = undefined;
    await closeQuietly(shaRootHandle);
    await closeQuietly(rootHandle);
  }

  uriForDigest(digestInput: string): string {
    return `cas://sha256/${validateDigest(digestInput)}`;
  }

  digestFromUri(uri: string): ContentDigest {
    const match = CAS_URI_PATTERN.exec(uri);
    if (!match) {
      throw new ContentAddressedStoreError(
        "INVALID_URI",
        "Evidence URI must use cas://sha256/<lowercase-digest>",
      );
    }
    return validateDigest(match[1]!);
  }

  async put(bytes: Uint8Array): Promise<StoredContent> {
    return this.putStream(
      (async function* (): AsyncGenerator<Uint8Array> {
        yield bytes;
      })(),
    );
  }

  async putStream(
    source: AsyncIterable<Uint8Array>,
    options: PutStreamOptions = {},
  ): Promise<StoredContent> {
    if (this.readOnly) {
      throw new ContentAddressedStoreError("READ_ONLY", "CAS publication is read-only");
    }
    const shaRootHandle = this.requireShaRootHandle();
    const maxBytes = validateLimit(options.maxBytes);
    const stagingHandle = await this.openDirectory(shaRootHandle, ".staging", "UNSAFE_OBJECT");
    const temporaryName = `${randomUUID()}.tmp`;
    const temporaryPath = descriptorPath(stagingHandle, temporaryName);
    let temporaryHandle: FileHandle | undefined;
    let temporaryExists = false;
    try {
      temporaryHandle = await open(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      temporaryExists = true;
      const hash = createHash("sha256");
      let sizeBytes = 0;
      for await (const value of source) {
        const chunk = Uint8Array.from(value);
        sizeBytes += chunk.byteLength;
        if (!Number.isSafeInteger(sizeBytes) || (maxBytes !== undefined && sizeBytes > maxBytes)) {
          throw new ContentAddressedStoreError(
            "OBJECT_TOO_LARGE",
            "CAS stream exceeds the configured object limit",
            { maxBytes, observedBytes: sizeBytes },
          );
        }
        hash.update(chunk);
        await writeChunk(temporaryHandle, chunk);
      }
      const digest = hash.digest("hex");
      await temporaryHandle.sync();
      await temporaryHandle.chmod(0o444);
      await temporaryHandle.close();
      temporaryHandle = undefined;

      const existing = await this.openVerifiedIfPresent(digest);
      if (existing) {
        await existing.handle.close();
        await existing.shardHandle.close();
        await unlink(temporaryPath);
        temporaryExists = false;
        await stagingHandle.sync();
        return { digest, uri: this.uriForDigest(digest), sizeBytes, existed: true };
      }

      const shardHandle = await this.openShard(digest, true);
      let existed = false;
      try {
        try {
          await link(temporaryPath, descriptorPath(shardHandle, digest));
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
          existed = true;
        }
        // Immutable mode was set through the temp descriptor before publish;
        // never chmod an EEXIST target by path.
        await shardHandle.sync();
        await unlink(temporaryPath);
        temporaryExists = false;
        await stagingHandle.sync();
      } finally {
        await shardHandle.close();
      }

      const verified = await this.openVerifiedIfPresent(digest);
      if (!verified) {
        throw new ContentAddressedStoreError("NOT_FOUND", "Published CAS object disappeared", {
          digest,
        });
      }
      const verifiedSize = verified.sizeBytes;
      await verified.handle.close();
      await verified.shardHandle.close();
      return {
        digest,
        uri: this.uriForDigest(digest),
        sizeBytes: verifiedSize,
        existed,
      };
    } catch (error) {
      await closeQuietly(temporaryHandle);
      if (temporaryExists) {
        try {
          await unlink(temporaryPath);
          await stagingHandle.sync();
        } catch {
          // Preserve the authoritative stream, publish, or verification failure.
        }
      }
      throw ioError(error, "stream write");
    } finally {
      await closeQuietly(stagingHandle);
    }
  }

  async get(digestInput: string): Promise<VerifiedContent> {
    const digest = validateDigest(digestInput);
    const opened = await this.openVerifiedIfPresent(digest, this.maxBufferedReadBytes);
    if (!opened) {
      throw new ContentAddressedStoreError("NOT_FOUND", `CAS object ${digest} was not found`, {
        digest,
      });
    }
    try {
      if (opened.sizeBytes > this.maxBufferedReadBytes) {
        throw new ContentAddressedStoreError(
          "OBJECT_TOO_LARGE",
          "CAS object exceeds the buffered-read limit; use getStream",
          { digest, sizeBytes: opened.sizeBytes, maxBufferedReadBytes: this.maxBufferedReadBytes },
        );
      }
      const bytes = new Uint8Array(opened.sizeBytes);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await opened.handle.read(
          bytes,
          offset,
          Math.min(STREAM_CHUNK_BYTES, bytes.byteLength - offset),
          offset,
        );
        if (result.bytesRead <= 0) {
          throw new ContentAddressedStoreError(
            "UNSAFE_OBJECT",
            "CAS object truncated after verification",
            { digest },
          );
        }
        offset += result.bytesRead;
      }
      return { digest, uri: this.uriForDigest(digest), bytes, sizeBytes: bytes.byteLength };
    } finally {
      await closeQuietly(opened.handle);
      await closeQuietly(opened.shardHandle);
    }
  }

  async getStream(
    digestInput: string,
    options: VerifiedReadOptions = {},
  ): Promise<VerifiedContentStream> {
    const digest = validateDigest(digestInput);
    const opened = await this.openVerifiedIfPresent(digest, validateReadLimit(options.maxBytes));
    if (!opened) {
      throw new ContentAddressedStoreError("NOT_FOUND", `CAS object ${digest} was not found`, {
        digest,
      });
    }
    return {
      digest,
      uri: this.uriForDigest(digest),
      sizeBytes: opened.sizeBytes,
      bytes: this.streamOpenedObject(digest, opened),
    };
  }

  /** Verifies content incrementally and returns metadata without buffering its bytes. */
  async verify(
    digestInput: string,
    options: VerifiedReadOptions = {},
  ): Promise<VerifiedContentMetadata> {
    const digest = validateDigest(digestInput);
    const opened = await this.openVerifiedIfPresent(digest, validateReadLimit(options.maxBytes));
    if (!opened) {
      throw new ContentAddressedStoreError("NOT_FOUND", `CAS object ${digest} was not found`, {
        digest,
      });
    }
    const sizeBytes = opened.sizeBytes;
    await opened.handle.close();
    await opened.shardHandle.close();
    return { digest, uri: this.uriForDigest(digest), sizeBytes };
  }

  async verifyByUri(
    uri: string,
    options: VerifiedReadOptions = {},
  ): Promise<VerifiedContentMetadata> {
    return this.verify(this.digestFromUri(uri), options);
  }

  async getByUri(uri: string): Promise<VerifiedContent> {
    return this.get(this.digestFromUri(uri));
  }

  async has(digestInput: string): Promise<boolean> {
    const digest = validateDigest(digestInput);
    const opened = await this.openVerifiedIfPresent(digest);
    if (!opened) return false;
    await opened.handle.close();
    await opened.shardHandle.close();
    return true;
  }

  private requireShaRootHandle(): FileHandle {
    if (!this.rootHandle || !this.shaRootHandle) {
      throw new ContentAddressedStoreError("NOT_INITIALIZED", "CAS store has not been initialized");
    }
    return this.shaRootHandle;
  }

  private async configureDirectory(handle: FileHandle, staging = false): Promise<void> {
    if (this.publicationGroup === undefined) {
      await handle.chmod(0o700);
      return;
    }
    const before = await handle.stat();
    const mode = staging ? 0o2700 : 0o2750;
    if (
      before.uid !== process.getuid?.() ||
      before.gid !== this.publicationGroup ||
      (before.mode & 0o7777) !== mode
    ) {
      throw new ContentAddressedStoreError(
        "UNSAFE_OBJECT",
        "CAS publication directory lacks provisioned owner/group/setgid isolation",
      );
    }
    // Provisioned directories are never chmod'ed/repaired. In-flight bytes stay
    // private; only fully hashed objects enter the already provisioned shards.
  }

  private async openDirectory(
    parent: FileHandle,
    name: string,
    errorKind: "INVALID_ROOT" | "UNSAFE_OBJECT",
  ): Promise<FileHandle> {
    try {
      const handle = await open(
        descriptorPath(parent, name),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const stat = await handle.stat();
      if (!stat.isDirectory()) {
        await handle.close();
        throw new ContentAddressedStoreError(errorKind, `CAS directory ${name} is not real`);
      }
      return handle;
    } catch (error) {
      if (error instanceof ContentAddressedStoreError) throw error;
      throw new ContentAddressedStoreError(errorKind, `CAS directory ${name} is unsafe`, {
        causeCode: errorCode(error),
      });
    }
  }

  private async openShard(digest: ContentDigest, create: boolean): Promise<FileHandle> {
    if (this.readOnly && create) {
      throw new ContentAddressedStoreError("READ_ONLY", "CAS publication is read-only");
    }
    const shaRootHandle = this.requireShaRootHandle();
    const shard = digest.slice(0, 2);
    if (create && this.publicationGroup === undefined) {
      try {
        await mkdir(descriptorPath(shaRootHandle, shard), { mode: 0o700 });
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw ioError(error, "shard creation");
      }
    }
    const handle = await this.openDirectory(shaRootHandle, shard, "UNSAFE_OBJECT");
    if (!this.readOnly) {
      try {
        await this.configureDirectory(handle);
      } catch (error) {
        await handle.close();
        throw error;
      }
    }
    return handle;
  }

  private async openVerifiedIfPresent(
    digestInput: string,
    maxBytes?: number,
  ): Promise<OpenedVerifiedObject | undefined> {
    const digest = validateDigest(digestInput);
    for (let attempt = 0; attempt <= 8; attempt += 1) {
      let shardHandle: FileHandle | undefined;
      try {
        try {
          shardHandle = await this.openShard(digest, false);
        } catch (error) {
          if (
            errorCode(error) === "ENOENT" ||
            (error instanceof ContentAddressedStoreError && error.detail.causeCode === "ENOENT")
          ) {
            return undefined;
          }
          throw error;
        }
        let objectHandle: FileHandle;
        try {
          objectHandle = await open(
            descriptorPath(shardHandle, digest),
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
        } catch (error) {
          if (errorCode(error) === "ENOENT") {
            await shardHandle.close();
            return undefined;
          }
          if (errorCode(error) === "ELOOP") {
            throw new ContentAddressedStoreError(
              "UNSAFE_OBJECT",
              "CAS object may not be a symbolic link",
              { digest },
            );
          }
          throw error;
        }
        try {
          const statBefore = await objectHandle.stat();
          if (!statBefore.isFile() || statBefore.nlink !== 1) {
            throw new ContentAddressedStoreError(
              "UNSAFE_OBJECT",
              "CAS object must be a regular file with exactly one link",
              { digest, linkCount: statBefore.nlink },
            );
          }
          if (maxBytes !== undefined && statBefore.size > maxBytes) {
            throw new ContentAddressedStoreError(
              "OBJECT_TOO_LARGE",
              "CAS object exceeds the verified-read byte limit",
              { digest, sizeBytes: statBefore.size, maxBytes },
            );
          }
          const hash = createHash("sha256");
          const buffer = new Uint8Array(STREAM_CHUNK_BYTES);
          let offset = 0;
          while (offset < statBefore.size) {
            const result = await objectHandle.read(
              buffer,
              0,
              Math.min(buffer.byteLength, statBefore.size - offset),
              offset,
            );
            if (result.bytesRead <= 0) break;
            hash.update(buffer.subarray(0, result.bytesRead));
            offset += result.bytesRead;
          }
          const statAfter = await objectHandle.stat();
          if (
            offset !== statBefore.size ||
            statAfter.size !== statBefore.size ||
            statAfter.ino !== statBefore.ino ||
            statAfter.nlink !== 1
          ) {
            throw new ContentAddressedStoreError(
              "UNSAFE_OBJECT",
              "CAS object changed while it was being verified",
              { digest },
            );
          }
          const observedDigest = hash.digest("hex");
          if (observedDigest !== digest) {
            throw new ContentAddressedStoreError(
              "DIGEST_MISMATCH",
              "CAS object bytes do not match their address",
              { digest, observedDigest },
            );
          }
          return { handle: objectHandle, shardHandle, sizeBytes: statBefore.size };
        } catch (error) {
          await closeQuietly(objectHandle);
          const publishing =
            error instanceof ContentAddressedStoreError &&
            error.code === "UNSAFE_OBJECT" &&
            typeof error.detail.linkCount === "number" &&
            error.detail.linkCount > 1;
          if (publishing && attempt < 8) {
            await closeQuietly(shardHandle);
            await new Promise<void>((resolve) => setImmediate(resolve));
            continue;
          }
          throw error;
        }
      } catch (error) {
        await closeQuietly(shardHandle);
        throw ioError(error, "verified read");
      }
    }
    throw new ContentAddressedStoreError("IO_ERROR", "CAS stability check exhausted");
  }

  private async *streamOpenedObject(
    digest: ContentDigest,
    opened: OpenedVerifiedObject,
  ): AsyncGenerator<Uint8Array> {
    try {
      const buffer = new Uint8Array(STREAM_CHUNK_BYTES);
      let offset = 0;
      while (offset < opened.sizeBytes) {
        const result = await opened.handle.read(
          buffer,
          0,
          Math.min(buffer.byteLength, opened.sizeBytes - offset),
          offset,
        );
        if (result.bytesRead <= 0) {
          throw new ContentAddressedStoreError(
            "UNSAFE_OBJECT",
            "CAS object truncated while streaming",
            { digest },
          );
        }
        offset += result.bytesRead;
        yield Uint8Array.from(buffer.subarray(0, result.bytesRead));
      }
      const finalStat = await opened.handle.stat();
      if (finalStat.size !== opened.sizeBytes || finalStat.nlink !== 1) {
        throw new ContentAddressedStoreError(
          "UNSAFE_OBJECT",
          "CAS object changed while streaming",
          { digest },
        );
      }
    } finally {
      await closeQuietly(opened.handle);
      await closeQuietly(opened.shardHandle);
    }
  }
}
