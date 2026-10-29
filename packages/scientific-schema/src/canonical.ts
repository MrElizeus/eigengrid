import { createHash } from "node:crypto";

/** JSON value accepted by the durable scientific contracts. */
export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

function normalize(value: unknown, path: string): CanonicalJson {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot canonicalize non-finite number at ${path}`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => normalize(item, `${path}[${index}]`));
  }
  if (typeof value === "object") {
    const result: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue;
      result[key] = normalize(item, `${path}.${key}`);
    }
    return result;
  }
  throw new TypeError(`Cannot canonicalize ${typeof value} at ${path}`);
}

/** Stable JSON representation used for all persisted content digests. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, "$"));
}

/** Lower-case SHA-256 digest of canonical JSON. */
export function digestCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** SHA-256 digest of exact bytes, used for immutable evidence and skill fragments. */
export function digestBytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
