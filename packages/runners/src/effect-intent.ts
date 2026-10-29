import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ensurePrivateRunnerDirectory } from "./safe-path";

export type DurableEffectIntentState =
  | "intent_persisted"
  | "submitted"
  | "ambiguous"
  | "failed"
  | "confirmed"
  | "cancel_requested"
  | "cancelled";

export interface DurableEffectIntent {
  schema: "eigengrid.effect-intent.v1";
  operationId: string;
  jobId: string;
  attemptId: string;
  backend: "ssh" | "worker" | "slurm" | "pbs" | "local";
  state: DurableEffectIntentState;
  requestDigest: `sha256:${string}`;
  externalId?: string;
  createdAt: string;
  updatedAt: string;
}

export function effectRequestDigest(material: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(stableJson(material), "utf8").digest("hex")}`;
}

/**
 * Atomically writes a 0600 intent record before crossing a backend effect
 * boundary. The file and containing directory are synced before returning so
 * an acknowledgement cannot outrun the authority record. A unique O_EXCL
 * temporary prevents concurrent writers from corrupting each other's staging
 * file.
 */
export function persistEffectIntent(path: string, intent: DurableEffectIntent): void {
  validateIntent(intent);
  const parent = dirname(path);
  ensurePrivateRunnerDirectory(parent);
  const temporary = join(parent, `.${intent.operationId}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let lock: IntentLock | undefined;
  const lockPath = join(parent, `.${intent.operationId}.lock`);
  try {
    lock = acquireIntentLock(lockPath);
    const current = readEffectIntent(path);
    if (current) validateIntentUpdate(current, intent);
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const bytes = Buffer.from(`${JSON.stringify(intent)}\n`, "utf8");
    // writeSync is intentionally used in a loop: an interrupted write must
    // not produce a partial authority record that can later be mistaken for
    // a valid state.
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
      if (written <= 0) throw new Error("Effect intent write made no progress");
      offset += written;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    syncDirectory(parent);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original durability error.
      }
    }
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Preserve the original durability error.
    }
    if (lock !== undefined) {
      try {
        releaseIntentLock(lockPath, lock);
      } catch {
        // Preserve the original write/rename error.
      }
      lock = undefined;
    }
    throw error;
  } finally {
    if (lock !== undefined) {
      releaseIntentLock(lockPath, lock);
      lock = undefined;
    }
  }
}

export function readEffectIntent(path: string): DurableEffectIntent | undefined {
  let parsed: unknown;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    parsed = JSON.parse(readFileSync(descriptor, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw new Error(
      `Effect intent is corrupt at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  try {
    validateIntent(parsed);
  } catch (error) {
    throw new Error(
      `Effect intent is invalid at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parsed as DurableEffectIntent;
}

function syncDirectory(path: string): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0),
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

type IntentLock = { fd: number; token: string };

function acquireIntentLock(path: string): IntentLock {
  const started = Date.now();
  for (;;) {
    try {
      const descriptor = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      const token = `${process.pid}:${randomUUID()}`;
      try {
        const owner = Buffer.from(`${token}\n`, "utf8");
        let offset = 0;
        while (offset < owner.byteLength) {
          const written = writeSync(descriptor, owner, offset, owner.byteLength - offset);
          if (written <= 0) throw new Error("Effect intent lock write made no progress");
          offset += written;
        }
        fsyncSync(descriptor);
        return { fd: descriptor, token };
      } catch (error) {
        closeSync(descriptor);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      let stale = false;
      try {
        stale = Date.now() - lstatSync(path).mtimeMs > 60_000;
        if (stale && !lockOwnerIsDead(path)) stale = false;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException)?.code !== "ENOENT") throw statError;
      }
      if (stale) {
        rmSync(path, { force: true });
        continue;
      }
      if (Date.now() - started >= 2_000) {
        throw new Error(`Effect intent is contended at ${path}`);
      }
      // This synchronous API is deliberately bounded. The lock is per
      // operation and prevents stale writers from regressing a durable state.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

/** Release only the lock instance that this process actually acquired. */
function releaseIntentLock(path: string, lock: IntentLock): void {
  try {
    if (readFileSync(path, "utf8").trim() === lock.token) {
      rmSync(path, { force: true });
      syncDirectory(dirname(path));
    }
  } finally {
    closeSync(lock.fd);
  }
}

function lockOwnerIsDead(path: string): boolean {
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

const VALID_INTENT_TRANSITIONS: Readonly<
  Record<DurableEffectIntentState, readonly DurableEffectIntentState[]>
> = {
  intent_persisted: ["submitted", "ambiguous", "failed", "cancel_requested"],
  submitted: ["ambiguous", "failed", "confirmed", "cancel_requested"],
  ambiguous: ["submitted", "confirmed", "failed", "cancel_requested", "cancelled"],
  failed: [],
  // `confirmed` records that the backend accepted/identified the effect; it
  // is not a terminal outcome.  A later timeout or cancellation therefore
  // must be able to move through the explicit uncertainty boundary instead
  // of throwing and leaving the caller with an unhandled transition error.
  confirmed: ["ambiguous", "cancel_requested"],
  cancel_requested: ["ambiguous", "confirmed", "failed", "cancelled"],
  cancelled: [],
};

function validateIntentUpdate(current: DurableEffectIntent, next: DurableEffectIntent): void {
  if (
    current.operationId !== next.operationId ||
    current.jobId !== next.jobId ||
    current.attemptId !== next.attemptId ||
    current.backend !== next.backend ||
    current.requestDigest !== next.requestDigest ||
    current.createdAt !== next.createdAt
  ) {
    throw new Error(`Effect intent identity conflict for operation ${next.operationId}`);
  }
  if (current.externalId !== undefined && next.externalId !== current.externalId) {
    throw new Error(`Effect intent external identity conflict for operation ${next.operationId}`);
  }
  if (
    current.state !== next.state &&
    !VALID_INTENT_TRANSITIONS[current.state].includes(next.state)
  ) {
    throw new Error(`Invalid effect intent transition ${current.state} -> ${next.state}`);
  }
  if (Date.parse(next.updatedAt) < Date.parse(current.updatedAt)) {
    throw new Error(`Effect intent updatedAt moved backwards for operation ${next.operationId}`);
  }
}

function validateIntent(value: unknown): asserts value is DurableEffectIntent {
  if (!value || typeof value !== "object") throw new Error("record must be an object");
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "schema",
    "operationId",
    "jobId",
    "attemptId",
    "backend",
    "state",
    "requestDigest",
    "externalId",
    "createdAt",
    "updatedAt",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`unknown field ${key}`);
  }
  if (record.schema !== "eigengrid.effect-intent.v1") throw new Error("unsupported schema");
  for (const field of ["operationId", "jobId", "attemptId", "createdAt", "updatedAt"] as const) {
    if (typeof record[field] !== "string" || record[field].length === 0)
      throw new Error(`${field} is required`);
  }
  if (!["ssh", "worker", "slurm", "pbs", "local"].includes(String(record.backend)))
    throw new Error("backend is invalid");
  if (
    ![
      "intent_persisted",
      "submitted",
      "ambiguous",
      "failed",
      "confirmed",
      "cancel_requested",
      "cancelled",
    ].includes(String(record.state))
  )
    throw new Error("state is invalid");
  if (
    typeof record.requestDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(record.requestDigest)
  )
    throw new Error("requestDigest is invalid");
  if (record.externalId !== undefined && typeof record.externalId !== "string")
    throw new Error("externalId is invalid");
  for (const field of ["operationId", "jobId", "attemptId"] as const) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(String(record[field])))
      throw new Error(`${field} contains unsafe characters`);
  }
  const createdAt = Date.parse(String(record.createdAt));
  const updatedAt = Date.parse(String(record.updatedAt));
  if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt))
    throw new Error("timestamps must be valid ISO dates");
  if (updatedAt < createdAt) throw new Error("updatedAt cannot precede createdAt");
}

function stableJson(value: unknown): string {
  // Undefined fields are common at optional backend boundaries (for example
  // a runner without an engine override). Encode them deterministically so a
  // digest can still be computed before an effect, while preserving the
  // distinction from an omitted object key through the surrounding JSON
  // structure.
  if (value === undefined) return "null";
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`unsupported effect intent value ${typeof value}`);
}
