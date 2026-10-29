import { createHash } from "node:crypto";
import {
  EffectJournalFrameSchema,
  EffectOperationIdentitySchema,
  JsonValueSchema,
  RequestDigestSchema,
  type EffectJournalFrame,
  type EffectOperationIdentity,
  type JsonValue,
  type RequestDigest,
} from "./schemas";

function normalize(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError(`Cannot canonicalize a non-finite number at ${path}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    const expectedKeys = new Set([
      ...Array.from({ length: value.length }, (_, index) => String(index)),
      "length",
    ]);
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string" || !expectedKeys.has(key)) ||
      keys.length !== expectedKeys.size
    ) {
      throw new TypeError(`Cannot canonicalize a sparse or decorated array at ${path}`);
    }
    return value.map((item, index) => normalize(item, `${path}[${index}]`));
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Cannot canonicalize a non-plain object at ${path}`);
    }
    const input = value as Record<string, unknown>;
    const entries: Array<readonly [string, string]> = [];
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string") {
        throw new TypeError(`Cannot canonicalize a symbol property at ${path}`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError(`Cannot canonicalize an accessor or hidden property at ${path}.${key}`);
      }
      entries.push([key, key.normalize("NFC")]);
    }
    if (new Set(entries.map(([, normalized]) => normalized)).size !== entries.length) {
      throw new TypeError(`Unicode-normalized key collision at ${path}`);
    }
    const result: Record<string, JsonValue> = {};
    for (const [original, normalized] of entries.sort((left, right) =>
      left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0,
    )) {
      result[normalized] = normalize(input[original], `${path}.${normalized}`);
    }
    return result;
  }
  throw new TypeError(`Cannot canonicalize ${typeof value} at ${path}`);
}

/** Canonical JSON for authority-bound values: NFC strings, sorted keys, finite JSON values only. */
export function canonicalEffectJson(value: unknown): string {
  const normalized = normalize(value, "$");
  JsonValueSchema.parse(normalized);
  return JSON.stringify(normalized);
}

export function digestEffectValue(value: unknown): RequestDigest {
  return RequestDigestSchema.parse(
    `sha256:${createHash("sha256").update(canonicalEffectJson(value), "utf8").digest("hex")}`,
  );
}

/** Bind the exact canonical request bytes without retaining possibly sensitive request content. */
export function digestEffectRequest(request: unknown): RequestDigest {
  return digestEffectValue(request);
}

export type UnboundEffectOperationIdentity = Omit<
  EffectOperationIdentity,
  "schema" | "requestDigest"
>;

export function bindEffectOperationIdentity(
  identity: UnboundEffectOperationIdentity,
  request: unknown,
): EffectOperationIdentity {
  return EffectOperationIdentitySchema.parse({
    schema: "eigengrid.effect-operation-identity.v1",
    ...identity,
    requestDigest: digestEffectRequest(request),
  });
}

export class EffectJournalDigestError extends Error {
  readonly code = "EFFECT_JOURNAL_DIGEST_MISMATCH";

  constructor(readonly sequence: number) {
    super(`Effect journal frame ${sequence} has a canonical digest mismatch`);
    this.name = "EffectJournalDigestError";
  }
}

export function computeEffectJournalFrameDigest(
  frame: Omit<EffectJournalFrame, "frameDigest"> | EffectJournalFrame,
): RequestDigest {
  const { frameDigest: _digest, ...unsigned } = frame as EffectJournalFrame;
  return digestEffectValue(unsigned);
}

export function sealEffectJournalFrame<T extends Omit<EffectJournalFrame, "frameDigest">>(
  frame: T,
): EffectJournalFrame {
  return EffectJournalFrameSchema.parse({
    ...frame,
    frameDigest: computeEffectJournalFrameDigest(frame),
  });
}

export function parseVerifiedEffectJournalFrame(value: unknown): EffectJournalFrame {
  const frame = EffectJournalFrameSchema.parse(value);
  if (computeEffectJournalFrameDigest(frame) !== frame.frameDigest) {
    throw new EffectJournalDigestError(frame.sequence);
  }
  return frame;
}
