// ────────────────────────────────────────────────────────────
// Active Process Identity — versioned, durable, anti-PID-reuse
// ────────────────────────────────────────────────────────────
// Written <jobDir>/.eigengrid/active-<attemptId>.json before
// the process starts. Contains exact job/attempt/PID, argv,
// cwd, startTime, and an OS-level start-time token from
// /proc/<pid>/stat to detect PID reuse.
//
// A new context verifies this identity before reconcile/cancel;
// mismatched/malformed/dead/PID-only evidence returns
// safely-unknown and never signals.
// ────────────────────────────────────────────────────────────

import { existsSync, lstatSync, openSync, readFileSync, closeSync, constants } from "fs";
import { join, resolve, sep } from "path";
import {
  ensurePrivateRunnerDirectory,
  assertRegularRunnerFile,
  atomicWriteRunnerFile,
} from "./safe-path";

export const LOCAL_IDENTITY_SCHEMA_VERSION = 1;

export interface LocalActiveIdentityV1 {
  schemaVersion: typeof LOCAL_IDENTITY_SCHEMA_VERSION;
  jobId: string;
  attemptId: string;
  pid: number;
  command: string;
  args: readonly string[];
  cwd: string;
  startTime: number; // Date.now() at write time
  processStartToken: string; // e.g. /proc/<pid>/stat start-time field — anti-reuse
}

export type LocalActiveIdentity = LocalActiveIdentityV1;

export class LocalIdentityError extends Error {
  readonly kind: "version" | "validation" | "io" | "containment";
  constructor(kind: LocalIdentityError["kind"], message: string) {
    super(message);
    this.name = "LocalIdentityError";
    this.kind = kind;
  }
}

// ── Process start token abstraction (injectable) ─────────────
// On Linux reads /proc/<pid>/stat field 22 (start_time since boot
// in clock ticks). Any read/parse/missing-field/non-numeric failure
// throws LocalIdentityError so callers can safely terminate.

export interface ProcessStartTokenReader {
  readToken(pid: number): string;
}

/**
 * Linux /proc/<pid>/stat field 22 = start_time in clock ticks
 * since boot. This is monotonically increasing per boot and never
 * reused for a new process, making it a reliable anti-reuse token.
 *
 * Throws LocalIdentityError on any read/parse/unavailable failure.
 * Never synthesises a timestamp fallback.
 */
export class LinuxProcTokenReader implements ProcessStartTokenReader {
  readToken(pid: number): string {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new LocalIdentityError("io", `Cannot read /proc/${pid}/stat: ${msg}`);
    }
    // After the comm field (2) which is parenthesized, split on ') '
    const afterComm = stat.split(") ")[1];
    if (!afterComm) {
      throw new LocalIdentityError(
        "validation",
        `Cannot parse /proc/${pid}/stat: no fields after comm`,
      );
    }
    const fields = afterComm.split(" ");
    // Field index 19 (0-indexed) = start_time (after state, ppid, pgrp, session,
    // tty_nr, tpgid, flags, minflt, cminflt, majflt, cmajflt, utime, stime,
    // cutime, cstime, priority, nice, num_threads, itrealvalue)
    // Actually: field 22 (1-indexed) = starttime. After ') ' split, it's at index 19 (0-indexed)
    const starttime = fields[19];
    if (starttime && /^\d+$/.test(starttime)) return starttime;
    throw new LocalIdentityError(
      "validation",
      `Invalid or missing start_time in /proc/${pid}/stat`,
    );
  }
}

const DEFAULT_TOKEN_READER: ProcessStartTokenReader = new LinuxProcTokenReader();

// ── Safe path helpers ────────────────────────────────────────

const TRAVERSAL = /(^|[\\/])\.\.([\\/]|$)/;

function hasUnsafeChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch <= 0x1f || ch === 0x7f) return true;
    if ("\n\r\t/\\:&|`$><*?[]()#;'\"".includes(s[i])) return true;
  }
  return false;
}

function isSafeIdComponent(s: string): boolean {
  if (!s || s.length === 0) return false;
  if (hasUnsafeChars(s)) return false;
  if (TRAVERSAL.test(s)) return false;
  if (s === "." || s === "..") return false;
  return true;
}

function validateAndResolvePath(jobDir: string, attemptId: string): string {
  if (!isSafeIdComponent(attemptId)) {
    throw new LocalIdentityError("validation", `Unsafe attemptId: ${attemptId}`);
  }
  const resolved = resolve(join(jobDir, ".eigengrid", `active-${attemptId}.json`));
  const base = resolve(join(jobDir, ".eigengrid"));
  if (resolved !== base && !resolved.startsWith(`${base}${sep}`)) {
    throw new LocalIdentityError("containment", "Identity path escapes job directory");
  }
  return resolved;
}

// ── File paths ───────────────────────────────────────────────

function identityDir(jobDir: string): string {
  return join(jobDir, ".eigengrid");
}

export function identityPath(jobDir: string, attemptId: string): string {
  return validateAndResolvePath(jobDir, attemptId);
}

// ── Validation ──────────────────────────────────────────────

export function validateIdentity(raw: unknown): raw is LocalActiveIdentity {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;

  if (r.schemaVersion !== LOCAL_IDENTITY_SCHEMA_VERSION) return false;
  if (typeof r.jobId !== "string" || r.jobId.length === 0) return false;
  if (typeof r.attemptId !== "string" || r.attemptId.length === 0) return false;
  if (typeof r.pid !== "number" || !Number.isFinite(r.pid) || r.pid <= 0) return false;
  if (typeof r.command !== "string") return false;
  if (!Array.isArray(r.args)) return false;
  if (r.args.some((a: unknown) => typeof a !== "string")) return false;
  if (typeof r.cwd !== "string" || r.cwd.length === 0) return false;
  if (typeof r.startTime !== "number" || !Number.isFinite(r.startTime)) return false;
  if (typeof r.processStartToken !== "string" || r.processStartToken.length === 0) return false;

  return true;
}

// ── Write ────────────────────────────────────────────────────

/**
 * Write an active identity file before starting the process.
 * Uses atomic write (temp + rename).
 */
export function writeActiveIdentity(
  jobDir: string,
  attemptId: string,
  identity: LocalActiveIdentityV1,
  _tokenReader?: ProcessStartTokenReader,
): void {
  if (!validateIdentity(identity) || identity.attemptId !== attemptId) {
    throw new LocalIdentityError("validation", "Active identity does not match its attempt");
  }
  const dir = identityDir(jobDir);
  ensurePrivateRunnerDirectory(dir);

  const finalPath = validateAndResolvePath(jobDir, attemptId);
  assertRegularRunnerFile(finalPath, "Active identity target");
  atomicWriteRunnerFile(finalPath, `${JSON.stringify(identity, null, 2)}\n`);
}

// ── Read ─────────────────────────────────────────────────────

export function readActiveIdentity(jobDir: string, attemptId: string): LocalActiveIdentity | null {
  const path = validateAndResolvePath(jobDir, attemptId);
  if (!existsSync(path)) return null;

  let descriptor: number | undefined;
  let content: string;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    content = readFileSync(descriptor, "utf-8");
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  if (!validateIdentity(parsed)) return null;
  return parsed;
}

export function identityExists(jobDir: string, attemptId: string): boolean {
  try {
    return existsSync(identityPath(jobDir, attemptId));
  } catch {
    return false;
  }
}

// ── Verify identity against live process ──────────────────────

/**
 * Verify that a persisted active identity matches the live process.
 * Returns:
 *   "valid" — identity matches live process (process verified)
 *   "dead" — PID no longer exists
 *   "reused" — PID exists but start token doesn't match
 *   "absent" — no identity file found
 */
export type IdentityVerification = "valid" | "dead" | "reused" | "absent" | "malformed";

export function verifyActiveIdentity(
  jobDir: string,
  attemptId: string,
  tokenReader?: ProcessStartTokenReader,
): IdentityVerification {
  const identity = readActiveIdentity(jobDir, attemptId);
  if (!identity) return "absent";

  const reader = tokenReader ?? DEFAULT_TOKEN_READER;

  // Check if PID exists
  try {
    process.kill(identity.pid, 0);
  } catch {
    return "dead";
  }

  // PID exists — verify start token
  // Token reader may throw if PID died between kill(0) and readToken
  let liveToken: string;
  try {
    liveToken = reader.readToken(identity.pid);
  } catch {
    return "dead";
  }
  if (liveToken !== identity.processStartToken) {
    return "reused";
  }

  return "valid";
}
