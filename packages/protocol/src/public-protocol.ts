import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import {
  appendFileSync,
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
import { dirname, resolve } from "node:path";
import { z } from "zod";

/** Public, optional control-plane protocol exposed to external profiles such as Myrmex. */
export const PublicProtocolVersion = "eigengrid.public.v1" as const;
export const PublicRequestSchemaVersion = "eigengrid.myrmex-operation-request.v1" as const;
export const PublicReceiptSchemaVersion = "eigengrid.myrmex-operation-receipt.v1" as const;

export const PublicDigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u, "Expected a sha256:<64 lower-case hex> digest");
export type PublicDigest = z.infer<typeof PublicDigestSchema>;

const StrictRfc3339DateTimePattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u;

/**
 * Strict RFC 3339 profile shared by runtime envelopes and JSON-Schema validators.
 * It rejects calendar rollover, 24:00, leap-second syntax, and out-of-range offsets.
 */
export function isStrictRfc3339DateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = StrictRfc3339DateTimePattern.exec(value);
  if (!match) return false;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month - 1]!) return false;
  if (offsetHourText !== undefined && Number(offsetHourText) > 23) return false;
  if (offsetMinuteText !== undefined && Number(offsetMinuteText) > 59) return false;
  return true;
}

export const PublicDateTimeSchema = z
  .string()
  .refine(isStrictRfc3339DateTime, "Expected a strict RFC 3339 date-time with a valid offset");

export const PublicCompatibilitySchema = z
  .object({
    eigengridVersion: z.string().min(1),
    publicProtocol: z.literal(PublicProtocolVersion),
    missionProtocol: z.string().min(1),
    colonySchema: z.string().min(1),
    skillSchema: z.string().min(1),
    evidenceSchema: z.string().min(1),
    databaseSchemaInformational: z.number().int().positive().optional(),
    profileVersion: z.string().min(1),
    codexSubstrateRange: z.string().min(1),
    featureFlags: z.array(z.string().min(1)),
  })
  .strict();
export type PublicCompatibility = z.infer<typeof PublicCompatibilitySchema>;

export const PublicSubjectSchema = z
  .object({
    type: z.string().min(1),
    id: z.string().min(1),
    revision: z.union([z.number().int().positive(), z.string().min(1)]),
    digest: PublicDigestSchema,
  })
  .strict();
export type PublicSubject = z.infer<typeof PublicSubjectSchema>;

const PublicAuthorityEvidenceSchema = z
  .object({
    kind: z.string().min(1),
    id: z.string().min(1).optional(),
    digest: PublicDigestSchema.optional(),
    detail: z.record(z.unknown()).optional(),
  })
  .strict();

export const MyrmexOperationRequestSchema = z
  .object({
    schema: z.literal(PublicRequestSchemaVersion),
    requestId: z.string().min(1),
    idempotencyKey: z.string().min(1).max(256),
    installationId: z.string().min(1),
    runId: z.string().min(1),
    principalId: z.string().min(1),
    operation: z.string().min(1).max(160),
    compatibility: PublicCompatibilitySchema,
    subject: PublicSubjectSchema,
    payload: z.record(z.unknown()),
    authorityEvidence: z.array(PublicAuthorityEvidenceSchema),
    expiresAt: PublicDateTimeSchema,
    requestDigest: PublicDigestSchema,
  })
  .strict();
export type MyrmexOperationRequest = z.infer<typeof MyrmexOperationRequestSchema>;

export const MyrmexOperationReceiptSchema = z
  .object({
    schema: z.literal(PublicReceiptSchemaVersion),
    requestId: z.string().min(1),
    operationId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    state: z.enum(["accepted", "pending", "confirmed", "failed", "ambiguous", "denied"]),
    subject: PublicSubjectSchema,
    correlationId: z.string().min(1),
    causationId: z.string().min(1),
    compatibility: PublicCompatibilitySchema,
    confirmedAt: PublicDateTimeSchema,
    result: z.record(z.unknown()).nullable(),
    failure: z.record(z.unknown()).nullable(),
    receiptDigest: PublicDigestSchema,
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.state === "confirmed") {
      if (receipt.result === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["result"],
          message: "A confirmed public operation requires a result payload",
        });
      }
      if (receipt.failure !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["failure"],
          message: "A confirmed public operation cannot carry failure detail",
        });
      }
    } else if (receipt.result !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result"],
        message: "Only a confirmed public operation can carry a result payload",
      });
    }
  });
export type MyrmexOperationReceipt = z.infer<typeof MyrmexOperationReceiptSchema>;

export type PublicOperationResult =
  | { state: "confirmed"; result: Record<string, unknown> }
  | { state: "pending"; detail?: Record<string, unknown> }
  | { state: "ambiguous"; detail?: Record<string, unknown> }
  | { state: "failed"; detail?: Record<string, unknown> };

export interface PublicOperationContext {
  readonly request: MyrmexOperationRequest;
  readonly signal: AbortSignal;
}

export interface PublicOperationReconciliationContext extends PublicOperationContext {
  /**
   * Last durable (or locally uncertain) receipt. Reconciliation handlers are
   * observation-only: they must query an external operation by its stable
   * identity and must never redispatch the operation's effect.
   */
  readonly receipt: MyrmexOperationReceipt;
}

export interface PublicAuthorityDecision {
  readonly authorized: boolean;
  readonly code?: string;
  readonly message?: string;
}

export interface PublicOperationPolicy {
  /** Public operations are explicitly allow-listed; absence denies by default. */
  readonly allowedOperations: ReadonlySet<string>;
  /** Operations that are explicitly classified as non-mutating by the Head. */
  readonly readOnlyOperations: ReadonlySet<string>;
  readonly allowedPrincipals?: ReadonlySet<string>;
  readonly revokedPrincipals?: ReadonlySet<string>;
  /** Required for every allowed operation not present in `readOnlyOperations`. */
  readonly validateAuthority?: (
    context: PublicOperationContext,
  ) => PublicAuthorityDecision | Promise<PublicAuthorityDecision>;
}

export interface PublicOperationBrokerOptions {
  readonly compatibility: PublicCompatibility;
  readonly policy: PublicOperationPolicy;
  readonly execute: (context: PublicOperationContext) => Promise<PublicOperationResult>;
  /**
   * Observation-only recovery hook for pending or ambiguous operations. It is
   * never called by `handle`, and must not redispatch the original effect.
   */
  readonly reconcile?: (
    context: PublicOperationReconciliationContext,
  ) => Promise<PublicOperationResult>;
  readonly now?: () => Date;
  readonly journal?: PublicOperationJournal;
}

export interface PublicOperationJournalEntry {
  key: string;
  requestDigest: PublicDigest;
  /** The exact verified request is retained so restart recovery can rebind the key/digest. */
  request: MyrmexOperationRequest;
  receipt: MyrmexOperationReceipt;
}

export interface PublicOperationJournal {
  get(key: string): Promise<PublicOperationJournalEntry | undefined>;
  put(entry: PublicOperationJournalEntry): Promise<void>;
  /**
   * Reserve an operation before invoking its external effect.  The returned
   * `acquired` bit identifies the process that owns execution; an existing
   * pending/terminal entry is replayed without redispatching the effect.
   */
  reserve(entry: PublicOperationJournalEntry): Promise<PublicJournalReservation>;
  /** Advance an existing unresolved entry through an explicit observation path. */
  reconcile(entry: PublicOperationJournalEntry): Promise<void>;
}

export interface PublicJournalReservation {
  readonly entry: PublicOperationJournalEntry;
  readonly acquired: boolean;
}

/** Process-local journal useful for standalone mode and deterministic tests. */
export class MemoryPublicOperationJournal implements PublicOperationJournal {
  private readonly entries = new Map<string, PublicOperationJournalEntry>();
  async get(key: string): Promise<PublicOperationJournalEntry | undefined> {
    const entry = this.entries.get(key);
    return entry ? immutablePublicJournalEntry(entry) : undefined;
  }
  async put(entry: PublicOperationJournalEntry): Promise<void> {
    const stored = immutablePublicJournalEntry(entry);
    const existing = this.entries.get(stored.key);
    if (existing && existing.requestDigest !== stored.requestDigest)
      throw new Error("public operation journal key conflict");
    if (existing && existing.receipt.receiptDigest !== stored.receipt.receiptDigest) {
      if (!canAdvancePublicReceipt(existing.receipt, stored.receipt))
        throw new Error("public operation journal receipt conflict");
    }
    this.entries.set(stored.key, stored);
  }

  async reserve(entry: PublicOperationJournalEntry): Promise<PublicJournalReservation> {
    const stored = immutablePublicJournalEntry(entry);
    if (stored.receipt.state !== "accepted" && stored.receipt.state !== "pending") {
      throw new Error("public operation reservation must be pending or accepted");
    }
    const existing = this.entries.get(stored.key);
    if (existing) {
      if (existing.requestDigest !== stored.requestDigest)
        throw new Error("public operation journal key conflict");
      return { entry: immutablePublicJournalEntry(existing), acquired: false };
    }
    this.entries.set(stored.key, stored);
    return { entry: immutablePublicJournalEntry(stored), acquired: true };
  }

  async reconcile(entry: PublicOperationJournalEntry): Promise<void> {
    const stored = immutablePublicJournalEntry(entry);
    const existing = this.entries.get(stored.key);
    if (!existing) throw new Error("public operation reconciliation requires a reservation");
    if (existing.requestDigest !== stored.requestDigest)
      throw new Error("public operation journal key conflict");
    if (existing.receipt.receiptDigest === stored.receipt.receiptDigest) return;
    if (!canReconcilePublicReceipt(existing.receipt, stored.receipt))
      throw new Error("public operation journal reconciliation conflict");
    this.entries.set(stored.key, stored);
  }

  /** Replace the in-memory projection after a durable journal refresh. */
  replace(entries: readonly PublicOperationJournalEntry[]): void {
    const replacements = entries.map((entry) => immutablePublicJournalEntry(entry));
    this.entries.clear();
    for (const entry of replacements) this.entries.set(entry.key, entry);
  }

  hasEntries(): boolean {
    return this.entries.size > 0;
  }

  snapshot(): readonly PublicOperationJournalEntry[] {
    return [...this.entries.values()].map((entry) => immutablePublicJournalEntry(entry));
  }
}

/** Append-only receipt journal for Head restart and optional Myrmex downtime. */
export class DurablePublicOperationJournal implements PublicOperationJournal {
  private readonly memory = new MemoryPublicOperationJournal();
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
      const entries = await this.readEntries();
      this.memory.replace(entries);
      this.diskObserved = true;
      this.loaded = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.diskObserved = false;
        this.memory.replace([]);
        this.loaded = true;
        return;
      }
      const failure = error instanceof Error ? error : new Error(String(error));
      this.loadFailure = failure;
      throw failure;
    }
  }

  async get(key: string): Promise<PublicOperationJournalEntry | undefined> {
    return this.withFileLock(async () => {
      await this.open();
      await this.refreshFromDisk();
      return this.memory.get(key);
    });
  }

  async put(entry: PublicOperationJournalEntry): Promise<void> {
    const candidate = immutablePublicJournalEntry(entry);
    return this.enqueue(async () => {
      return this.withFileLock(async () => {
        await this.open();
        await this.refreshFromDisk();
        const existing = await this.memory.get(candidate.key);
        if (existing) {
          if (existing.requestDigest !== candidate.requestDigest)
            throw new Error("public operation journal key conflict");
          if (existing.receipt.receiptDigest === candidate.receipt.receiptDigest) return;
          if (!canAdvancePublicReceipt(existing.receipt, candidate.receipt))
            throw new Error("public operation journal receipt conflict");
        }
        await this.append(candidate);
        await this.memory.put(candidate);
      });
    });
  }

  async reserve(entry: PublicOperationJournalEntry): Promise<PublicJournalReservation> {
    const candidate = immutablePublicJournalEntry(entry);
    return this.enqueue(async () =>
      this.withFileLock(async () => {
        await this.open();
        await this.refreshFromDisk();
        if (candidate.receipt.state !== "accepted" && candidate.receipt.state !== "pending") {
          throw new Error("public operation reservation must be pending or accepted");
        }
        const existing = await this.memory.get(candidate.key);
        if (existing) {
          if (existing.requestDigest !== candidate.requestDigest)
            throw new Error("public operation journal key conflict");
          return { entry: existing, acquired: false };
        }
        await this.append(candidate);
        await this.memory.put(candidate);
        const persisted = await this.memory.get(candidate.key);
        if (!persisted) throw new Error("public operation reservation was not retained");
        return { entry: persisted, acquired: true };
      }),
    );
  }

  async reconcile(entry: PublicOperationJournalEntry): Promise<void> {
    const candidate = immutablePublicJournalEntry(entry);
    return this.enqueue(async () =>
      this.withFileLock(async () => {
        await this.open();
        await this.refreshFromDisk();
        const existing = await this.memory.get(candidate.key);
        if (!existing) throw new Error("public operation reconciliation requires a reservation");
        if (existing.requestDigest !== candidate.requestDigest)
          throw new Error("public operation journal key conflict");
        if (existing.receipt.receiptDigest === candidate.receipt.receiptDigest) return;
        if (!canReconcilePublicReceipt(existing.receipt, candidate.receipt))
          throw new Error("public operation journal reconciliation conflict");
        await this.append(candidate);
        await this.memory.reconcile(candidate);
      }),
    );
  }

  private async refreshFromDisk(): Promise<void> {
    if (!this.loaded) return;
    try {
      const entries = await this.readEntries();
      this.memory.replace(entries);
      this.diskObserved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (this.diskObserved || this.memory.hasEntries()) {
          throw new Error("public operation journal disappeared");
        }
        this.memory.replace([]);
        return;
      }
      const failure = error instanceof Error ? error : new Error(String(error));
      this.loadFailure = failure;
      throw failure;
    }
  }

  private async readEntries(): Promise<PublicOperationJournalEntry[]> {
    assertNoSymlinkComponents(dirname(this.filePath));
    try {
      if (lstatSync(this.filePath).isSymbolicLink())
        throw new Error("public operation journal must not be a symbolic link");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const source = await readFile(this.filePath, "utf8");
    if (source.length > 0 && !source.endsWith("\n"))
      throw new Error("invalid public journal: unterminated final record");
    const entries = new MemoryPublicOperationJournal();
    for (const line of source.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch (error) {
        throw new Error(`invalid public journal JSON: ${String(error)}`);
      }
      if (!parsed || typeof parsed !== "object") throw new Error("invalid public journal record");
      const record = parsed as Partial<PublicOperationJournalEntry>;
      if (typeof record.key !== "string" || typeof record.requestDigest !== "string")
        throw new Error("invalid public journal key or request digest");
      const request = verifyMyrmexOperationRequest(record.request);
      if (!request.ok) throw new Error(`invalid public request in journal: ${request.error}`);
      const receipt = verifyMyrmexOperationReceipt(record.receipt);
      if (!receipt.ok) throw new Error(`invalid public receipt in journal: ${receipt.error}`);
      const entry: PublicOperationJournalEntry = {
        key: record.key,
        requestDigest: PublicDigestSchema.parse(record.requestDigest),
        request: request.value,
        receipt: receipt.value,
      };
      validatePublicJournalEntry(entry);
      const previous = await entries.get(entry.key);
      if (
        previous?.receipt.state === "ambiguous" &&
        previous.receipt.receiptDigest !== entry.receipt.receiptDigest
      ) {
        await entries.reconcile(entry);
      } else {
        await entries.put(entry);
      }
    }
    return [...entries.snapshot()];
  }

  private async append(entry: PublicOperationJournalEntry): Promise<void> {
    assertNoSymlinkComponents(dirname(this.filePath));
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const fd = openSync(
      this.filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      appendFileSync(fd, `${canonicalPublicJson(entry)}\n`, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
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
        // Publish a fully written inode atomically. A contender can therefore
        // never observe the empty-file interval produced by O_EXCL + write.
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
          owner = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number; token?: string };
        } catch (ownerError) {
          if ((ownerError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw new Error("public operation journal lock is malformed; refusing to bypass it");
        }
        if (!Number.isInteger(owner.pid) || !owner.token) {
          throw new Error("public operation journal lock has invalid ownership metadata");
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
        if (Date.now() >= deadline) throw new Error("public operation journal lock contention");
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
        // A missing lock after a completed operation is harmless. Any other
        // ownership anomaly is intentionally left visible for the next call.
      }
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(operation, operation);
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
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
        throw new Error(`public journal path contains a symlink: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cannot digest a non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) output[key] = canonicalize(entry);
    }
    return output;
  }
  throw new TypeError(`Unsupported digest value ${typeof value}`);
}

export function canonicalPublicJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function publicDigest(value: unknown): PublicDigest {
  return `sha256:${createHash("sha256").update(canonicalPublicJson(value), "utf8").digest("hex")}`;
}

function withoutDigest<T extends Record<string, unknown>>(
  value: T,
  key: keyof T,
): Omit<T, keyof T> {
  const copy = { ...value } as Record<string, unknown>;
  delete copy[String(key)];
  return copy as Omit<T, keyof T>;
}

export function computeMyrmexRequestDigest(
  request: Omit<MyrmexOperationRequest, "requestDigest"> | MyrmexOperationRequest,
): PublicDigest {
  return publicDigest(withoutDigest(request as Record<string, unknown>, "requestDigest"));
}

export function computeMyrmexReceiptDigest(
  receipt: Omit<MyrmexOperationReceipt, "receiptDigest"> | MyrmexOperationReceipt,
): PublicDigest {
  return publicDigest(withoutDigest(receipt as Record<string, unknown>, "receiptDigest"));
}

export function createMyrmexOperationRequest(
  input: Omit<MyrmexOperationRequest, "schema" | "requestDigest">,
): MyrmexOperationRequest {
  const request = { ...input, schema: PublicRequestSchemaVersion } as Omit<
    MyrmexOperationRequest,
    "requestDigest"
  >;
  return MyrmexOperationRequestSchema.parse({
    ...request,
    requestDigest: computeMyrmexRequestDigest(request),
  });
}

export function verifyMyrmexOperationRequest(
  request: unknown,
): { ok: true; value: MyrmexOperationRequest } | { ok: false; error: string } {
  const parsed = MyrmexOperationRequestSchema.safeParse(request);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  const expected = computeMyrmexRequestDigest(parsed.data);
  if (expected !== parsed.data.requestDigest) {
    return { ok: false, error: "requestDigest does not match the canonical request" };
  }
  return { ok: true, value: parsed.data };
}

export function verifyMyrmexOperationReceipt(
  receipt: unknown,
): { ok: true; value: MyrmexOperationReceipt } | { ok: false; error: string } {
  const parsed = MyrmexOperationReceiptSchema.safeParse(receipt);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  const expected = computeMyrmexReceiptDigest(parsed.data);
  if (expected !== parsed.data.receiptDigest) {
    return { ok: false, error: "receiptDigest does not match the canonical receipt" };
  }
  return { ok: true, value: parsed.data };
}

function deepFreezePublicValue<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezePublicValue(child);
  }
  return Object.freeze(value);
}

/** Clone away caller aliases, reverify every digest/binding, and freeze every replayed field. */
function immutablePublicJournalEntry(
  entry: PublicOperationJournalEntry,
): PublicOperationJournalEntry {
  const cloned = JSON.parse(canonicalPublicJson(entry)) as PublicOperationJournalEntry;
  validatePublicJournalEntry(cloned);
  return deepFreezePublicValue(cloned);
}

function validatePublicJournalEntry(entry: PublicOperationJournalEntry): void {
  const request = verifyMyrmexOperationRequest(entry.request);
  if (!request.ok) throw new Error(`invalid public journal request: ${request.error}`);
  const receipt = verifyMyrmexOperationReceipt(entry.receipt);
  if (!receipt.ok) throw new Error(`invalid public journal receipt: ${receipt.error}`);
  const expectedKey = `${request.value.installationId}:${request.value.idempotencyKey}`;
  if (entry.key !== expectedKey) throw new Error("public journal key does not bind request");
  if (entry.requestDigest !== request.value.requestDigest)
    throw new Error("public journal request digest does not bind request");
  if (
    receipt.value.requestId !== request.value.requestId ||
    receipt.value.idempotencyKey !== request.value.idempotencyKey ||
    receipt.value.correlationId !== request.value.runId ||
    receipt.value.causationId !== request.value.requestId ||
    canonicalPublicJson(receipt.value.subject) !== canonicalPublicJson(request.value.subject) ||
    (receipt.value.state !== "denied" &&
      canonicalPublicJson(receipt.value.compatibility) !==
        canonicalPublicJson(request.value.compatibility))
  ) {
    throw new Error("public journal receipt does not bind request");
  }
}

function canAdvancePublicReceipt(
  previous: MyrmexOperationReceipt,
  next: MyrmexOperationReceipt,
): boolean {
  if (previous.operationId !== next.operationId) return false;
  if (
    previous.state === "confirmed" ||
    previous.state === "failed" ||
    previous.state === "ambiguous" ||
    previous.state === "denied"
  ) {
    return false;
  }
  const allowed: Record<
    MyrmexOperationReceipt["state"],
    readonly MyrmexOperationReceipt["state"][]
  > = {
    accepted: ["accepted", "pending", "confirmed", "failed", "ambiguous", "denied"],
    pending: ["pending", "confirmed", "failed", "ambiguous", "denied"],
    confirmed: [],
    failed: [],
    ambiguous: [],
    denied: [],
  };
  return allowed[previous.state].includes(next.state);
}

function canReconcilePublicReceipt(
  previous: MyrmexOperationReceipt,
  next: MyrmexOperationReceipt,
): boolean {
  if (previous.operationId !== next.operationId) return false;
  if (
    previous.state === "confirmed" ||
    previous.state === "failed" ||
    previous.state === "denied"
  ) {
    return false;
  }
  const allowed: Record<
    MyrmexOperationReceipt["state"],
    readonly MyrmexOperationReceipt["state"][]
  > = {
    accepted: ["accepted", "pending", "confirmed", "failed", "ambiguous", "denied"],
    pending: ["pending", "confirmed", "failed", "ambiguous", "denied"],
    ambiguous: ["pending", "confirmed", "failed", "ambiguous", "denied"],
    confirmed: [],
    failed: [],
    denied: [],
  };
  return allowed[previous.state].includes(next.state);
}

/**
 * A deliberately small public control-plane broker. It owns no scientific or
 * execution state: callers provide an application use case and receive a
 * signed-by-digest receipt. Idempotency is retained for the lifetime of the
 * broker and can be backed by the durable operation table by an adapter.
 */
export class MyrmexOperationBroker {
  private readonly seen = new Map<
    string,
    { requestDigest: PublicDigest; receipt: MyrmexOperationReceipt }
  >();
  private readonly inFlight = new Map<
    string,
    { requestDigest: PublicDigest; promise: Promise<MyrmexOperationReceipt> }
  >();
  /** Effects whose receipt could not be durably journaled are never replayed blindly. */
  private readonly uncertain = new Map<
    string,
    { requestDigest: PublicDigest; receipt: MyrmexOperationReceipt }
  >();
  private readonly now: () => Date;
  private readonly journal: PublicOperationJournal;
  private readonly compatibility: PublicCompatibility;
  private readonly policy: PublicOperationPolicy;

  constructor(private readonly options: PublicOperationBrokerOptions) {
    this.now = options.now ?? (() => new Date());
    this.journal = options.journal ?? new MemoryPublicOperationJournal();
    this.compatibility = deepFreezePublicValue(
      PublicCompatibilitySchema.parse(options.compatibility),
    );
    this.policy = Object.freeze({
      allowedOperations: new Set(options.policy.allowedOperations),
      readOnlyOperations: new Set(options.policy.readOnlyOperations ?? []),
      ...(options.policy.allowedPrincipals
        ? { allowedPrincipals: new Set(options.policy.allowedPrincipals) }
        : {}),
      ...(options.policy.revokedPrincipals
        ? { revokedPrincipals: new Set(options.policy.revokedPrincipals) }
        : {}),
      ...(options.policy.validateAuthority
        ? { validateAuthority: options.policy.validateAuthority }
        : {}),
    });
    if (typeof this.journal.reserve !== "function") {
      throw new TypeError("A public operation journal must reserve intent before effect dispatch");
    }
    if (typeof this.journal.reconcile !== "function") {
      throw new TypeError("A public operation journal must support controlled reconciliation");
    }
    for (const operation of this.policy.readOnlyOperations) {
      if (!this.policy.allowedOperations.has(operation)) {
        throw new TypeError(`Read-only public operation is not allow-listed: ${operation}`);
      }
    }
  }

  async handle(
    raw: unknown,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<MyrmexOperationReceipt> {
    const verified = verifyMyrmexOperationRequest(raw);
    if (!verified.ok) return this.denied(raw, "INVALID_REQUEST", verified.error);
    const request = deepFreezePublicValue(verified.value);
    const key = `${request.installationId}:${request.idempotencyKey}`;
    const uncertain = this.uncertain.get(key);
    let durablePrior: PublicOperationJournalEntry | undefined;
    try {
      durablePrior = await this.journal.get(key);
    } catch (error) {
      if (!uncertain) throw error;
      if (uncertain.requestDigest !== request.requestDigest) {
        return this.receipt(request, "denied", {
          code: "IDEMPOTENCY_CONFLICT",
          message: "idempotency key is already associated with an uncertain request",
        });
      }
      return uncertain.receipt;
    }
    if (durablePrior && durablePrior.requestDigest !== request.requestDigest) {
      return this.receipt(request, "denied", {
        code: "IDEMPOTENCY_CONFLICT",
        message: "idempotency key was already used for a different request",
      });
    }
    if (
      durablePrior &&
      durablePrior.receipt.state !== "pending" &&
      durablePrior.receipt.state !== "accepted"
    ) {
      this.uncertain.delete(key);
      this.seen.set(key, durablePrior);
      return durablePrior.receipt;
    }
    if (uncertain) {
      if (uncertain.requestDigest !== request.requestDigest) {
        return this.receipt(request, "denied", {
          code: "IDEMPOTENCY_CONFLICT",
          message: "idempotency key is already associated with an uncertain request",
        });
      }
      return uncertain.receipt;
    }
    // A duplicate already executing in this process can await the exact same
    // promise. Other processes still observe the durable pending reservation.
    const inFlight = this.inFlight.get(key);
    if (inFlight) {
      if (inFlight.requestDigest !== request.requestDigest) {
        return this.receipt(request, "denied", {
          code: "IDEMPOTENCY_CONFLICT",
          message: "idempotency key is concurrently used for a different request",
        });
      }
      return inFlight.promise;
    }
    // Prefer the durable projection whenever one is configured.  A cached
    // `pending` receipt from another process must not mask the later terminal
    // update written by the owner after reconciliation.
    const prior = durablePrior ?? this.seen.get(key);
    if (prior) {
      if (prior.requestDigest !== request.requestDigest) {
        return this.receipt(request, "denied", {
          code: "IDEMPOTENCY_CONFLICT",
          message: "idempotency key was already used for a different request",
        });
      }
      this.seen.set(key, prior);
      return prior.receipt;
    }

    const now = this.now();
    if (Date.parse(request.expiresAt) <= now.getTime()) {
      return await this.remember(
        request,
        this.receipt(request, "denied", { code: "REQUEST_EXPIRED" }),
      );
    }
    if (request.compatibility.publicProtocol !== this.compatibility.publicProtocol) {
      return await this.remember(
        request,
        this.receipt(request, "denied", { code: "INCOMPATIBLE_PROTOCOL" }),
      );
    }
    if (!compatibilityEqual(request.compatibility, this.compatibility)) {
      return await this.remember(
        request,
        this.receipt(request, "denied", { code: "INCOMPATIBLE_PROFILE" }),
      );
    }
    const policy = this.policy;
    if (
      !policy.allowedOperations.has(request.operation) ||
      policy.revokedPrincipals?.has(request.principalId) ||
      (policy.allowedPrincipals && !policy.allowedPrincipals.has(request.principalId))
    ) {
      return await this.remember(
        request,
        this.receipt(request, "denied", { code: "UNAUTHORIZED_OPERATION" }),
      );
    }
    if (!policy.readOnlyOperations.has(request.operation)) {
      if (request.authorityEvidence.length === 0) {
        return await this.remember(
          request,
          this.receipt(request, "denied", { code: "AUTHORITY_EVIDENCE_REQUIRED" }),
        );
      }
      if (!policy.validateAuthority) {
        return await this.remember(
          request,
          this.receipt(request, "denied", { code: "HEAD_AUTHORITY_VALIDATOR_REQUIRED" }),
        );
      }
      let decision: PublicAuthorityDecision;
      try {
        decision = await policy.validateAuthority({ request, signal });
        if (!decision || typeof decision.authorized !== "boolean") {
          throw new TypeError("Head authority validator returned an invalid decision");
        }
      } catch (error) {
        return await this.remember(
          request,
          this.receipt(request, "denied", {
            code: "HEAD_AUTHORITY_VALIDATION_FAILED",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      if (!decision.authorized) {
        return await this.remember(
          request,
          this.receipt(request, "denied", {
            code: decision.code ?? "HEAD_AUTHORITY_DENIED",
            ...(decision.message ? { message: decision.message } : {}),
          }),
        );
      }
    }

    const pendingReceipt = this.receipt(request, "pending", {
      code: "OPERATION_RESERVED",
      message: "operation intent durably reserved before effect dispatch",
    });
    const journalEntry: PublicOperationJournalEntry = {
      key,
      requestDigest: request.requestDigest,
      request,
      receipt: pendingReceipt,
    };

    // A durable journal can reserve the idempotency key before invoking the
    // application effect.  If another process already owns the pending key,
    // return that durable state and require application-level reconciliation;
    // never redispatch blindly after a crash.
    const reservation = await this.journal.reserve(journalEntry);
    if (!reservation.acquired) {
      if (reservation.entry.requestDigest !== request.requestDigest) {
        return this.receipt(request, "denied", {
          code: "IDEMPOTENCY_CONFLICT",
          message: "idempotency key was already used for a different request",
        });
      }
      const ownerInFlight = this.inFlight.get(key);
      if (ownerInFlight) {
        if (ownerInFlight.requestDigest !== request.requestDigest) {
          return this.receipt(request, "denied", {
            code: "IDEMPOTENCY_CONFLICT",
            message: "idempotency key is concurrently used for a different request",
          });
        }
        return ownerInFlight.promise;
      }
      if (
        reservation.entry.receipt.state !== "pending" &&
        reservation.entry.receipt.state !== "accepted"
      ) {
        this.seen.set(key, reservation.entry);
      }
      return reservation.entry.receipt;
    }

    const promise = (async () => {
      let result: PublicOperationResult;
      try {
        result = await this.options.execute({ request, signal });
      } catch (error) {
        result = {
          state: "failed",
          detail: {
            code: "HANDLER_FAILURE",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
      return this.remember(
        request,
        this.receipt(
          request,
          result.state,
          result.state === "confirmed" ? result.result : (result.detail ?? null),
          pendingReceipt.operationId,
        ),
      );
    })();
    this.inFlight.set(key, { requestDigest: request.requestDigest, promise });
    try {
      return await promise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Observe and durably advance an already reserved operation. This path never
   * invokes `execute`, including when the durable state is pending after a
   * process restart or the local state is ambiguous after response loss.
   */
  async reconcile(
    raw: unknown,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<MyrmexOperationReceipt> {
    const verified = verifyMyrmexOperationRequest(raw);
    if (!verified.ok) return this.denied(raw, "INVALID_REQUEST", verified.error);
    const request = deepFreezePublicValue(verified.value);
    const key = `${request.installationId}:${request.idempotencyKey}`;
    const uncertain = this.uncertain.get(key);
    let current: PublicOperationJournalEntry | undefined;
    try {
      current = await this.journal.get(key);
    } catch (error) {
      if (uncertain?.requestDigest === request.requestDigest) return uncertain.receipt;
      throw error;
    }
    if (!current) {
      if (uncertain?.requestDigest === request.requestDigest) return uncertain.receipt;
      return this.receipt(request, "denied", { code: "RECONCILIATION_NOT_FOUND" });
    }
    if (current.requestDigest !== request.requestDigest) {
      return this.receipt(request, "denied", {
        code: "IDEMPOTENCY_CONFLICT",
        message: "idempotency key was already used for a different request",
      });
    }
    if (
      current.receipt.state === "confirmed" ||
      current.receipt.state === "failed" ||
      current.receipt.state === "denied"
    ) {
      this.uncertain.delete(key);
      this.seen.set(key, current);
      return current.receipt;
    }

    const basis =
      uncertain?.requestDigest === request.requestDigest ? uncertain.receipt : current.receipt;
    if (!this.options.reconcile) return basis;

    const observed = await this.options.reconcile({ request, receipt: basis, signal });
    if (!observed || !["confirmed", "pending", "ambiguous", "failed"].includes(observed.state)) {
      throw new TypeError("Public reconciliation returned an invalid operation result");
    }
    const nextReceipt = this.receipt(
      request,
      observed.state,
      observed.state === "confirmed" ? observed.result : (observed.detail ?? null),
      basis.operationId,
    );
    const nextEntry = {
      key,
      requestDigest: request.requestDigest,
      request,
      receipt: nextReceipt,
    } satisfies PublicOperationJournalEntry;
    try {
      await this.journal.reconcile(nextEntry);
    } catch (error) {
      // A concurrent observer may have published an equally or more recent
      // state. Replay only the exact request's durable winner.
      try {
        const winner = await this.journal.get(key);
        if (
          winner?.requestDigest === request.requestDigest &&
          winner.receipt.receiptDigest !== current.receipt.receiptDigest
        ) {
          this.seen.set(key, winner);
          if (
            winner.receipt.state === "confirmed" ||
            winner.receipt.state === "failed" ||
            winner.receipt.state === "denied"
          ) {
            this.uncertain.delete(key);
          }
          return winner.receipt;
        }
      } catch {
        // Preserve the reconciliation write failure when no durable winner can
        // be established.
      }
      throw error;
    }
    const persisted = await this.journal.get(key);
    if (!persisted || persisted.requestDigest !== request.requestDigest) {
      throw new Error("reconciled public operation receipt was not durably retained");
    }
    this.uncertain.delete(key);
    this.seen.set(key, persisted);
    return persisted.receipt;
  }

  entries(): readonly MyrmexOperationReceipt[] {
    return [...this.seen.values()].map((entry) => entry.receipt);
  }

  private async remember(
    request: MyrmexOperationRequest,
    receipt: MyrmexOperationReceipt,
  ): Promise<MyrmexOperationReceipt> {
    const entry = {
      key: `${request.installationId}:${request.idempotencyKey}`,
      requestDigest: request.requestDigest,
      request,
      receipt,
    } satisfies PublicOperationJournalEntry;
    try {
      // The durable journal is the acknowledgement barrier. Publishing to the
      // process-local cache first would let a later retry observe a receipt
      // that was lost when the journal failed.
      await this.journal.put(entry);
    } catch (error) {
      // A denial (or another terminal, non-effecting response) does not use
      // the pre-effect reservation path. Two independent processes can
      // therefore race to persist the same terminal receipt. If the journal
      // already contains the exact request, replay that authoritative receipt
      // instead of turning an idempotent duplicate into an uncaught error.
      // This is deliberately limited to an exact request digest; a different
      // request on the same key remains a hard conflict.
      try {
        const existing = await this.journal.get(entry.key);
        if (
          existing &&
          existing.requestDigest === entry.requestDigest &&
          existing.receipt.state !== "pending" &&
          existing.receipt.state !== "accepted"
        ) {
          this.seen.set(entry.key, existing);
          return existing.receipt;
        }
      } catch {
        // Preserve the original journal failure below; a failed read cannot
        // establish an authoritative replay result.
      }
      const uncertain = this.receipt(
        request,
        "ambiguous",
        {
          code: "JOURNAL_UNAVAILABLE",
          message: error instanceof Error ? error.message : String(error),
        },
        receipt.operationId,
      );
      this.uncertain.set(entry.key, {
        requestDigest: request.requestDigest,
        receipt: uncertain,
      });
      throw new Error("public operation receipt is not durably journaled; outcome is ambiguous");
    }
    const persisted = await this.journal.get(entry.key);
    if (
      !persisted ||
      persisted.requestDigest !== entry.requestDigest ||
      (persisted.receipt.receiptDigest !== receipt.receiptDigest &&
        !canReconcilePublicReceipt(receipt, persisted.receipt))
    ) {
      throw new Error("public operation receipt was not durably retained");
    }
    this.seen.set(entry.key, persisted);
    return persisted.receipt;
  }

  private receipt(
    request: MyrmexOperationRequest,
    state: MyrmexOperationReceipt["state"],
    detail: Record<string, unknown> | null,
    operationId: string = randomUUID(),
  ): MyrmexOperationReceipt {
    if (state === "confirmed" && detail === null) {
      throw new TypeError("A confirmed public operation requires an explicit result payload");
    }
    const base: Omit<MyrmexOperationReceipt, "receiptDigest"> = {
      schema: PublicReceiptSchemaVersion,
      requestId: request.requestId,
      operationId,
      idempotencyKey: request.idempotencyKey,
      state,
      subject: request.subject,
      correlationId: request.runId,
      causationId: request.requestId,
      compatibility: this.compatibility,
      confirmedAt: this.now().toISOString(),
      result: state === "confirmed" ? detail : null,
      failure: state === "confirmed" ? null : detail,
    };
    return deepFreezePublicValue(
      MyrmexOperationReceiptSchema.parse({
        ...base,
        receiptDigest: computeMyrmexReceiptDigest(base),
      }),
    );
  }

  private denied(raw: unknown, code: string, message: string): MyrmexOperationReceipt {
    const fallback = {
      schema: PublicRequestSchemaVersion,
      requestId: "invalid-request",
      idempotencyKey: `invalid:${publicDigest(raw)}`,
      installationId: "unknown",
      runId: "unknown",
      principalId: "unknown",
      operation: "unknown",
      compatibility: this.compatibility,
      subject: { type: "unknown", id: "unknown", revision: 1, digest: publicDigest(raw) },
      payload: {},
      authorityEvidence: [],
      expiresAt: new Date(0).toISOString(),
      requestDigest: publicDigest(raw),
    } satisfies MyrmexOperationRequest;
    return this.receipt(fallback, "denied", { code, message });
  }
}

function compatibilityEqual(a: PublicCompatibility, b: PublicCompatibility): boolean {
  return canonicalPublicJson(a) === canonicalPublicJson(b);
}
