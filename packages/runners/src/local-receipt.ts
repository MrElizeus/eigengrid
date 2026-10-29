// ────────────────────────────────────────────────────────────
// Local Completion Receipt — versioned, durable, atomic
// ────────────────────────────────────────────────────────────
// Written <jobDir>/.eigengrid/receipt-<attemptId>.json using
// atomic write (temp + rename) so a new ApplicationContext /
// process can safely reconstruct the terminal outcome of an
// attempt without relying on in-memory tracking or raw PID.
//
// Schema versioning enables forward-compatible validation.
// ────────────────────────────────────────────────────────────

import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "fs";
import { join, resolve, sep } from "path";
import { ensurePrivateRunnerDirectory } from "./safe-path";

// ── Schema ──────────────────────────────────────────────────

export const LOCAL_RECEIPT_SCHEMA_VERSION = 1;

export type LocalReceiptStatus = "completed" | "failed" | "cancelled";

export interface LocalReceiptV1 {
  schemaVersion: typeof LOCAL_RECEIPT_SCHEMA_VERSION;
  jobId: string;
  attemptId: string;
  pid: number;
  command: string;
  args: readonly string[];
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  finishedAt: number;
  status: LocalReceiptStatus;
}

export type LocalReceipt = LocalReceiptV1;

function receiptFingerprint(receipt: LocalReceipt): string {
  return JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    jobId: receipt.jobId,
    attemptId: receipt.attemptId,
    pid: receipt.pid,
    command: receipt.command,
    args: [...receipt.args],
    cwd: receipt.cwd,
    exitCode: receipt.exitCode,
    signal: receipt.signal,
    finishedAt: receipt.finishedAt,
    status: receipt.status,
  });
}

// ── Error ───────────────────────────────────────────────────

export class LocalReceiptError extends Error {
  readonly kind: "version" | "validation" | "io" | "containment" | "mismatch";
  constructor(kind: LocalReceiptError["kind"], message: string) {
    super(message);
    this.name = "LocalReceiptError";
    this.kind = kind;
  }
}

// ── Safe-path helpers ────────────────────────────────────────

// Check for unsafe characters in filenames/IDs
function hasUnsafeChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch <= 0x1f || ch === 0x7f) return true; // control chars
    if ("\n\r\t/\\:&|`$><*?[]()#;'\"".includes(s[i])) return true;
  }
  return false;
}
const TRAVERSAL = /(^|[\\/])\.\.([\\/]|$)/;

function isSafeIdComponent(s: string): boolean {
  if (!s || s.length === 0) return false;
  if (hasUnsafeChars(s)) return false;
  if (TRAVERSAL.test(s)) return false;
  if (s === "." || s === "..") return false;
  return true;
}

function assertSafePath(jobDir: string, attemptId: string): string {
  if (!isSafeIdComponent(attemptId)) {
    throw new LocalReceiptError("validation", `Unsafe attempt ID: ${attemptId}`);
  }
  const resolved = resolve(join(jobDir, ".eigengrid", `receipt-${attemptId}.json`));
  const base = resolve(join(jobDir, ".eigengrid"));
  if (resolved !== base && !resolved.startsWith(`${base}${sep}`)) {
    throw new LocalReceiptError("containment", "Receipt path escapes job directory");
  }
  return resolved;
}

// ── Validation ──────────────────────────────────────────────

const VALID_STATUSES: readonly LocalReceiptStatus[] = ["completed", "failed", "cancelled"];

export function validateReceipt(raw: unknown): raw is LocalReceipt {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;

  if (r.schemaVersion !== LOCAL_RECEIPT_SCHEMA_VERSION) return false;
  if (typeof r.jobId !== "string" || r.jobId.length === 0) return false;
  if (typeof r.attemptId !== "string" || r.attemptId.length === 0) return false;
  if (typeof r.pid !== "number" || !Number.isFinite(r.pid) || r.pid <= 0) return false;
  if (typeof r.command !== "string") return false;
  if (!Array.isArray(r.args)) return false;
  if (r.args.some((a: unknown) => typeof a !== "string")) return false;
  if (typeof r.cwd !== "string" || r.cwd.length === 0) return false;
  if (r.exitCode !== null && (typeof r.exitCode !== "number" || !Number.isFinite(r.exitCode)))
    return false;
  if (r.signal !== null && typeof r.signal !== "string") return false;
  if (typeof r.finishedAt !== "number" || !Number.isFinite(r.finishedAt)) return false;
  if (!VALID_STATUSES.includes(r.status as LocalReceiptStatus)) return false;

  return true;
}

/**
 * Parse and validate a receipt from a JSON string.
 */
export function parseReceipt(json: string): LocalReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new LocalReceiptError("validation", "Receipt is not valid JSON");
  }

  if (!validateReceipt(parsed)) {
    const raw = parsed as Record<string, unknown>;
    if (
      raw &&
      typeof raw.schemaVersion === "number" &&
      raw.schemaVersion !== LOCAL_RECEIPT_SCHEMA_VERSION
    ) {
      throw new LocalReceiptError(
        "version",
        `Receipt schema v${raw.schemaVersion} is not supported (current: v${LOCAL_RECEIPT_SCHEMA_VERSION})`,
      );
    }
    throw new LocalReceiptError("validation", "Receipt failed structural validation");
  }

  return parsed;
}

// ── File path ───────────────────────────────────────────────

function receiptDir(jobDir: string): string {
  return join(jobDir, ".eigengrid");
}

export function receiptPath(jobDir: string, attemptId: string): string {
  return join(receiptDir(jobDir), `receipt-${attemptId}.json`);
}

// ── Atomic write ────────────────────────────────────────────

export function writeReceipt(jobDir: string, attemptId: string, receipt: LocalReceiptV1): void {
  if (!isSafeIdComponent(attemptId)) {
    throw new LocalReceiptError("validation", `Unsafe attempt ID for receipt write: ${attemptId}`);
  }
  if (!validateReceipt(receipt) || receipt.attemptId !== attemptId) {
    throw new LocalReceiptError("validation", "Receipt does not match its attempt");
  }
  const dir = receiptDir(jobDir);
  ensurePrivateRunnerDirectory(dir);

  const finalPath = receiptPath(jobDir, attemptId);
  const tmpPath = join(
    dir,
    `receipt-${attemptId}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  const json = JSON.stringify(receipt, null, 2);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      tmpPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const bytes = Buffer.from(json, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
      if (written <= 0) throw new LocalReceiptError("io", "Receipt write made no progress");
      offset += written;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(tmpPath);
    } catch {
      // Preserve the primary write failure.
    }
    throw error;
  }
  try {
    // link(2) is an atomic create-if-absent on the same filesystem. Unlike
    // rename, it cannot overwrite evidence won by another process.
    linkSync(tmpPath, finalPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "EEXIST") throw error;
    const existing = readReceipt(jobDir, attemptId, {
      jobId: receipt.jobId,
      attemptId: receipt.attemptId,
      cwd: receipt.cwd,
    });
    if (!existing || receiptFingerprint(existing) !== receiptFingerprint(receipt)) {
      throw new LocalReceiptError(
        "mismatch",
        `Conflicting immutable terminal receipt for attempt ${attemptId}`,
      );
    }
    const parentDescriptor = openSync(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try {
      fsyncSync(parentDescriptor);
    } finally {
      closeSync(parentDescriptor);
    }
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort temporary-file cleanup */
    }
  }
}

// ── Read with identity match ─────────────────────────────────

/**
 * Read and validate a receipt from disk.
 * Returns null when no receipt exists.
 * Throws LocalReceiptError on version/validation/containment failure.
 *
 * When jobId/attemptId/cwd are provided, verifies they match the
 * receipt fields. Mismatch returns null (safely-unknown).
 */
export function readReceipt(
  jobDir: string,
  attemptId: string,
  match?: { jobId?: string; attemptId?: string; cwd?: string },
): LocalReceipt | null {
  const path = assertSafePath(jobDir, attemptId);
  if (!existsSync(path)) return null;

  let content: string;
  let descriptor: number | undefined;
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    content = readFileSync(descriptor, "utf-8");
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  let receipt: LocalReceipt;
  try {
    receipt = parseReceipt(content);
  } catch {
    return null;
  }

  // Verify identity match if requested
  if (match) {
    if (match.jobId !== undefined && receipt.jobId !== match.jobId) return null;
    if (match.attemptId !== undefined && receipt.attemptId !== match.attemptId) return null;
    if (match.cwd !== undefined && receipt.cwd !== match.cwd) return null;
  }

  return receipt;
}

export function receiptExists(jobDir: string, attemptId: string): boolean {
  try {
    return existsSync(receiptPath(jobDir, attemptId));
  } catch {
    return false;
  }
}
