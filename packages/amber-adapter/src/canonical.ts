import { createHash } from "node:crypto";

type CanonicalJson =
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
      if (item !== undefined) result[key] = normalize(item, `${path}.${key}`);
    }
    return result;
  }
  throw new TypeError(`Cannot canonicalize ${typeof value} at ${path}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, "$"));
}

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Canonical(value: unknown): string {
  return sha256Bytes(canonicalJson(value));
}
