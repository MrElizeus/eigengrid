import type {
  MyrmexOperationReceipt,
  MyrmexOperationRequest,
  PublicDigest,
} from "@eigengrid/protocol";
import {
  PublicDigestSchema,
  canonicalPublicJson,
  verifyMyrmexOperationReceipt,
  verifyMyrmexOperationRequest,
} from "@eigengrid/protocol";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface MyrmexProfileLedgerEntry {
  readonly key: string;
  readonly intentDigest: PublicDigest;
  readonly request: MyrmexOperationRequest;
  readonly receipt?: MyrmexOperationReceipt;
}

export interface MyrmexProfileLedger {
  get(key: string): Promise<MyrmexProfileLedgerEntry | undefined>;
  /**
   * Atomically reserve a new request. Returns true only to the process that
   * created the record and rejects a different request at an existing key.
   */
  putRequest(entry: Omit<MyrmexProfileLedgerEntry, "receipt">): Promise<boolean>;
  /** Implementations atomically accept only legal same-operation receipt transitions. */
  putReceipt(key: string, receipt: MyrmexOperationReceipt): Promise<void>;
}

export class MyrmexProfileIdempotencyError extends Error {
  readonly name = "MyrmexProfileIdempotencyError";
  readonly code = "IDEMPOTENCY_CONFLICT";

  constructor(readonly key: string) {
    super(`Myrmex profile idempotency conflict at ${key}`);
  }
}

function receiptBindsRequest(
  receipt: MyrmexOperationReceipt,
  request: MyrmexOperationRequest,
): boolean {
  return (
    receipt.requestId === request.requestId &&
    receipt.idempotencyKey === request.idempotencyKey &&
    receipt.correlationId === request.runId &&
    receipt.causationId === request.requestId &&
    canonicalPublicJson(receipt.subject) === canonicalPublicJson(request.subject) &&
    (receipt.state === "denied" ||
      canonicalPublicJson(receipt.compatibility) === canonicalPublicJson(request.compatibility))
  );
}

function deepFreezeProfileValue<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeProfileValue(child);
  }
  return Object.freeze(value);
}

function immutableProfileReceipt(receipt: MyrmexOperationReceipt): MyrmexOperationReceipt {
  const cloned = JSON.parse(canonicalPublicJson(receipt)) as unknown;
  const verified = verifyMyrmexOperationReceipt(cloned);
  if (!verified.ok) throw new Error(`invalid Myrmex receipt: ${verified.error}`);
  return deepFreezeProfileValue(verified.value);
}

function immutableProfileLedgerEntry(entry: MyrmexProfileLedgerEntry): MyrmexProfileLedgerEntry {
  const cloned = JSON.parse(canonicalPublicJson(entry)) as Partial<MyrmexProfileLedgerEntry>;
  if (typeof cloned.key !== "string" || typeof cloned.intentDigest !== "string") {
    throw new Error("invalid Myrmex ledger key or intent digest");
  }
  const request = verifyMyrmexOperationRequest(cloned.request);
  if (!request.ok) throw new Error(`invalid Myrmex request: ${request.error}`);
  const intentDigest = PublicDigestSchema.parse(cloned.intentDigest);
  if (cloned.key !== `${request.value.installationId}:${request.value.idempotencyKey}`) {
    throw new MyrmexProfileIdempotencyError(cloned.key);
  }
  let receipt: MyrmexOperationReceipt | undefined;
  if (cloned.receipt !== undefined) {
    receipt = immutableProfileReceipt(cloned.receipt);
    if (!receiptBindsRequest(receipt, request.value)) {
      throw new MyrmexProfileIdempotencyError(cloned.key);
    }
  }
  return deepFreezeProfileValue({
    key: cloned.key,
    intentDigest,
    request: request.value,
    ...(receipt ? { receipt } : {}),
  });
}

function canAdvanceProfileReceipt(
  previous: MyrmexOperationReceipt,
  next: MyrmexOperationReceipt,
): boolean {
  if (previous.receiptDigest === next.receiptDigest) return true;
  if (previous.operationId !== next.operationId) return false;
  const allowed: Record<
    MyrmexOperationReceipt["state"],
    readonly MyrmexOperationReceipt["state"][]
  > = {
    accepted: ["accepted", "pending", "confirmed", "failed", "ambiguous", "denied"],
    pending: ["pending", "confirmed", "failed", "ambiguous", "denied"],
    ambiguous: ["ambiguous", "pending", "confirmed", "failed", "denied"],
    confirmed: [],
    failed: [],
    denied: [],
  };
  return allowed[previous.state].includes(next.state);
}

function isStaleProfileReceipt(
  authoritative: MyrmexOperationReceipt,
  observed: MyrmexOperationReceipt,
): boolean {
  if (authoritative.operationId !== observed.operationId) return false;
  const authoritativeTerminal =
    authoritative.state === "confirmed" ||
    authoritative.state === "failed" ||
    authoritative.state === "denied";
  const observedUnresolved =
    observed.state === "accepted" || observed.state === "pending" || observed.state === "ambiguous";
  return (
    (authoritativeTerminal && observedUnresolved) ||
    (authoritative.state !== "accepted" && observed.state === "accepted")
  );
}

/** Process-local request/receipt ledger; persistent profiles can inject an equivalent store. */
export class MemoryMyrmexProfileLedger implements MyrmexProfileLedger {
  private readonly entries = new Map<string, MyrmexProfileLedgerEntry>();

  async get(key: string): Promise<MyrmexProfileLedgerEntry | undefined> {
    const entry = this.entries.get(key);
    return entry ? immutableProfileLedgerEntry(entry) : undefined;
  }

  async putRequest(entry: Omit<MyrmexProfileLedgerEntry, "receipt">): Promise<boolean> {
    const stored = immutableProfileLedgerEntry(entry);
    const existing = this.entries.get(stored.key);
    if (
      existing &&
      (existing.intentDigest !== stored.intentDigest ||
        existing.request.requestDigest !== stored.request.requestDigest)
    ) {
      throw new MyrmexProfileIdempotencyError(stored.key);
    }
    if (existing) return false;
    this.entries.set(stored.key, stored);
    return true;
  }

  async putReceipt(key: string, receipt: MyrmexOperationReceipt): Promise<void> {
    const existing = this.entries.get(key);
    if (!existing) throw new Error(`Myrmex profile request is missing at ${key}`);
    const verified = immutableProfileReceipt(receipt);
    if (!receiptBindsRequest(verified, existing.request)) {
      throw new MyrmexProfileIdempotencyError(key);
    }
    if (existing.receipt && !canAdvanceProfileReceipt(existing.receipt, verified)) {
      if (isStaleProfileReceipt(existing.receipt, verified)) return;
      throw new MyrmexProfileIdempotencyError(key);
    }
    if (existing.receipt?.receiptDigest === verified.receiptDigest) return;
    this.entries.set(key, immutableProfileLedgerEntry({ ...existing, receipt: verified }));
  }
}

/**
 * Crash-survivable profile ledger for an optional external Myrmex process.
 *
 * The profile never receives EigenGrid credentials or state.  It persists only
 * the public request/receipt envelope needed to replay an idempotent call after
 * a process restart.  Every append is flushed before the operation is
 * acknowledged; malformed or tampered records fail closed during recovery.
 */
export class DurableMyrmexProfileLedger implements MyrmexProfileLedger {
  private readonly entries = new Map<string, MyrmexProfileLedgerEntry>();
  private loaded = false;
  private loading: Promise<void> | undefined;
  private loadFailure: Error | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private diskObserved = false;

  constructor(private readonly filePath: string) {}

  private async open(): Promise<void> {
    if (this.loaded) return;
    if (this.loadFailure) throw this.loadFailure;
    if (this.loading) return this.loading;
    this.loading = this.loadFromDisk();
    try {
      await this.loading;
    } finally {
      this.loading = undefined;
    }
  }

  private async loadFromDisk(): Promise<void> {
    try {
      this.replace(await this.readEntries());
      this.diskObserved = true;
      this.loaded = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.diskObserved = false;
        this.entries.clear();
        this.loaded = true;
        return;
      }
      this.entries.clear();
      const failure = error instanceof Error ? error : new Error(String(error));
      this.loadFailure = failure;
      throw failure;
    }
  }

  async get(key: string): Promise<MyrmexProfileLedgerEntry | undefined> {
    return this.withFileLock(async () => {
      await this.open();
      await this.refreshFromDisk();
      const entry = this.entries.get(key);
      return entry ? immutableProfileLedgerEntry(entry) : undefined;
    });
  }

  async putRequest(entry: Omit<MyrmexProfileLedgerEntry, "receipt">): Promise<boolean> {
    const candidate = immutableProfileLedgerEntry(entry);
    return this.enqueue(async () =>
      this.withFileLock(async () => {
        await this.open();
        await this.refreshFromDisk();
        const existing = this.entries.get(candidate.key);
        if (
          existing &&
          (existing.intentDigest !== candidate.intentDigest ||
            existing.request.requestDigest !== candidate.request.requestDigest)
        ) {
          throw new MyrmexProfileIdempotencyError(candidate.key);
        }
        if (existing) return false;
        await this.append(candidate);
        this.entries.set(candidate.key, candidate);
        return true;
      }),
    );
  }

  async putReceipt(key: string, receipt: MyrmexOperationReceipt): Promise<void> {
    const candidate = immutableProfileReceipt(receipt);
    return this.enqueue(async () =>
      this.withFileLock(async () => {
        await this.open();
        await this.refreshFromDisk();
        const existing = this.entries.get(key);
        if (!existing) throw new Error(`Myrmex profile request is missing at ${key}`);
        if (!receiptBindsRequest(candidate, existing.request)) {
          throw new MyrmexProfileIdempotencyError(key);
        }
        if (existing.receipt && !canAdvanceProfileReceipt(existing.receipt, candidate)) {
          if (isStaleProfileReceipt(existing.receipt, candidate)) return;
          throw new MyrmexProfileIdempotencyError(key);
        }
        if (existing.receipt?.receiptDigest === candidate.receiptDigest) return;
        const stored = immutableProfileLedgerEntry({ ...existing, receipt: candidate });
        await this.append(stored);
        this.entries.set(key, stored);
      }),
    );
  }

  private validateRequestBinding(key: string, request: MyrmexOperationRequest): void {
    if (key !== `${request.installationId}:${request.idempotencyKey}`)
      throw new MyrmexProfileIdempotencyError(key);
  }

  private async refreshFromDisk(): Promise<void> {
    if (!this.loaded) return;
    try {
      this.replace(await this.readEntries());
      this.diskObserved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (this.diskObserved || this.entries.size > 0) {
          throw new Error("Myrmex profile ledger disappeared");
        }
        this.entries.clear();
        return;
      }
      const failure = error instanceof Error ? error : new Error(String(error));
      this.loadFailure = failure;
      throw failure;
    }
  }

  private async readEntries(): Promise<Map<string, MyrmexProfileLedgerEntry>> {
    assertNoSymlinkComponents(dirname(this.filePath));
    try {
      if (lstatSync(this.filePath).isSymbolicLink()) {
        throw new Error("Myrmex profile ledger must not be a symbolic link");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const source = await readFile(this.filePath, "utf8");
    if (source.length > 0 && !source.endsWith("\n")) {
      throw new Error("invalid Myrmex ledger: unterminated final record");
    }
    const loaded = new Map<string, MyrmexProfileLedgerEntry>();
    for (const line of source.split("\n")) {
      if (!line.trim()) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line) as unknown;
      } catch (error) {
        throw new Error(`invalid Myrmex ledger JSON: ${String(error)}`);
      }
      if (!raw || typeof raw !== "object") throw new Error("invalid Myrmex ledger record");
      const record = raw as Partial<MyrmexProfileLedgerEntry>;
      if (typeof record.key !== "string" || typeof record.intentDigest !== "string") {
        throw new Error("invalid Myrmex ledger key or intent digest");
      }
      const request = verifyMyrmexOperationRequest(record.request);
      if (!request.ok) throw new Error(`invalid Myrmex request in ledger: ${request.error}`);
      const intentDigest = PublicDigestSchema.parse(record.intentDigest);
      this.validateRequestBinding(record.key, request.value);
      let receipt: MyrmexOperationReceipt | undefined;
      if (record.receipt !== undefined) {
        const verified = verifyMyrmexOperationReceipt(record.receipt);
        if (!verified.ok) throw new Error(`invalid Myrmex receipt in ledger: ${verified.error}`);
        if (!receiptBindsRequest(verified.value, request.value)) {
          throw new Error("Myrmex ledger receipt does not bind request");
        }
        receipt = verified.value;
      }
      const existing = loaded.get(record.key);
      if (
        existing &&
        (existing.intentDigest !== intentDigest ||
          existing.request.requestDigest !== request.value.requestDigest)
      ) {
        throw new Error(`Myrmex ledger contains conflicting request ${record.key}`);
      }
      if (existing?.receipt && receipt && !canAdvanceProfileReceipt(existing.receipt, receipt)) {
        throw new Error(`Myrmex ledger contains conflicting receipt ${record.key}`);
      }
      const latestReceipt = receipt ?? existing?.receipt;
      loaded.set(
        record.key,
        immutableProfileLedgerEntry({
          key: record.key,
          intentDigest,
          request: request.value,
          ...(latestReceipt ? { receipt: latestReceipt } : {}),
        }),
      );
    }
    return loaded;
  }

  private replace(entries: Map<string, MyrmexProfileLedgerEntry>): void {
    const replacements = [...entries].map(
      ([key, entry]) => [key, immutableProfileLedgerEntry(entry)] as const,
    );
    this.entries.clear();
    for (const [key, entry] of replacements) this.entries.set(key, entry);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(operation, operation);
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async append(entry: MyrmexProfileLedgerEntry): Promise<void> {
    assertNoSymlinkComponents(dirname(this.filePath));
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const descriptor = openSync(
      this.filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      appendFileSync(descriptor, `${canonicalPublicJson(entry)}\n`, "utf8");
      fsyncSync(descriptor);
      chmodSync(this.filePath, 0o600);
    } finally {
      closeSync(descriptor);
    }
    syncDirectory(dirname(this.filePath));
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    assertNoSymlinkComponents(dirname(this.filePath));
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const lockPath = `${this.filePath}.lock`;
    const token = randomUUID();
    const temporaryLockPath = `${lockPath}.${process.pid}.${token}.tmp`;
    const deadline = Date.now() + 10_000;
    let acquired = false;
    while (!acquired) {
      try {
        const descriptor = openSync(
          temporaryLockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        try {
          const body = Buffer.from(JSON.stringify({ pid: process.pid, token }), "utf8");
          writeAll(descriptor, body);
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        // The hard-link publication is atomic and exposes only a fully written
        // ownership record to contending profile processes.
        linkSync(temporaryLockPath, lockPath);
        unlinkSync(temporaryLockPath);
        syncDirectory(dirname(this.filePath));
        acquired = true;
      } catch (error) {
        try {
          unlinkSync(temporaryLockPath);
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let owner: { pid?: number; token?: string };
        try {
          owner = JSON.parse(readFileSync(lockPath, "utf8")) as {
            pid?: number;
            token?: string;
          };
        } catch (ownerError) {
          if ((ownerError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw new Error("Myrmex profile ledger lock is malformed; refusing to bypass it");
        }
        if (!Number.isInteger(owner.pid) || !owner.token) {
          throw new Error("Myrmex profile ledger lock has invalid ownership metadata");
        }
        let alive = true;
        try {
          process.kill(owner.pid!, 0);
        } catch (probeError) {
          alive = (probeError as NodeJS.ErrnoException).code !== "ESRCH";
        }
        if (!alive) {
          try {
            unlinkSync(lockPath);
          } catch (unlinkError) {
            if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
          }
          syncDirectory(dirname(this.filePath));
          continue;
        }
        if (Date.now() >= deadline) throw new Error("Myrmex profile ledger lock contention");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await operation();
    } finally {
      try {
        const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: string };
        if (owner.token === token) {
          unlinkSync(lockPath);
          syncDirectory(dirname(this.filePath));
        }
      } catch {
        // Leave ownership anomalies visible for the next operation.
      }
    }
  }
}

function writeAll(descriptor: number, body: Uint8Array): void {
  let offset = 0;
  while (offset < body.length) {
    const written = writeSync(descriptor, body, offset, body.length - offset);
    if (written <= 0) throw new Error("file lock ownership metadata write made no progress");
    offset += written;
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertNoSymlinkComponents(path: string): void {
  let current = resolve(path);
  for (;;) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Myrmex profile ledger path contains a symlink: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
