import { createHash } from "node:crypto";
import type { ContractSchemaId, Digest } from "./primitives";

export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

export const DIGEST_FIELDS: Readonly<Partial<Record<ContractSchemaId, string>>> = {
  "eigengrid.context-pack.v1": "contextDigest",
  "eigengrid.agent-work-order.v1": "workOrderDigest",
  "eigengrid.agent-work-result.v1": "resultDigest",
  "eigengrid.verification-request.v1": "requestDigest",
  "eigengrid.verification-result.v1": "resultDigest",
  "eigengrid.correction-order.v1": "correctionDigest",
  "eigengrid.species-contract.v1": "contractDigest",
  "eigengrid.colony-compatibility-manifest.v1": "manifestDigest",
};

function normalize(value: unknown, path: string): CanonicalJson {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot canonicalize a non-finite number at ${path}`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    const expectedKeys = new Set([
      ...Array.from({ length: value.length }, (_, index) => String(index)),
      "length",
    ]);
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some((key) => typeof key !== "string" || !expectedKeys.has(key)) ||
      ownKeys.length !== expectedKeys.size
    ) {
      throw new TypeError(`Cannot canonicalize a sparse or decorated array at ${path}`);
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError(`Cannot canonicalize an accessor array element at ${path}[${index}]`);
      }
    }
    return value.map((item, index) => normalize(item, `${path}[${index}]`));
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Cannot canonicalize a non-plain object at ${path}`);
    }
    const input = value as Record<string, unknown>;
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string") {
        throw new TypeError(`Cannot canonicalize a symbol property at ${path}`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError(`Cannot canonicalize an accessor or hidden property at ${path}.${key}`);
      }
    }
    const normalizedEntries = Object.keys(input).map((key) => [key, key.normalize("NFC")] as const);
    const normalizedKeys = normalizedEntries.map(([, normalized]) => normalized);
    if (new Set(normalizedKeys).size !== normalizedKeys.length) {
      throw new TypeError(`Unicode-normalized key collision at ${path}`);
    }
    const result: Record<string, CanonicalJson> = {};
    for (const [originalKey, normalizedKey] of normalizedEntries.sort((left, right) =>
      left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0,
    )) {
      const item = input[originalKey];
      if (item === undefined) {
        throw new TypeError(`Cannot canonicalize undefined at ${path}.${originalKey}`);
      }
      result[normalizedKey] = normalize(item, `${path}.${normalizedKey}`);
    }
    return result;
  }
  throw new TypeError(`Cannot canonicalize ${typeof value} at ${path}`);
}

/** Stable JSON representation with NFC strings/keys and lexicographic object keys. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, "$"));
}

export function digestCanonical(value: unknown): Digest {
  const digest = createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
  return `sha256:${digest}`;
}

export function digestBytes(value: string | Uint8Array): Digest {
  const digest = createHash("sha256").update(value).digest("hex");
  return `sha256:${digest}`;
}

function schemaOf(value: unknown): ContractSchemaId {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("A colony contract must be a JSON object");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "schema");
  const schema = descriptor && "value" in descriptor ? descriptor.value : undefined;
  if (typeof schema !== "string" || !(schema in DIGEST_FIELDS)) {
    throw new TypeError(`Contract schema ${String(schema)} has no canonical digest rule`);
  }
  return schema as ContractSchemaId;
}

/** Compute a contract digest after excluding only that contract's top-level digest field. */
export function computeContractDigest(value: unknown): Digest {
  const schema = schemaOf(value);
  const digestField = DIGEST_FIELDS[schema];
  if (!digestField) throw new TypeError(`Contract schema ${schema} is not self-digested`);
  canonicalJson(value);
  const unsigned = { ...(value as Record<string, unknown>) };
  delete unsigned[digestField];
  return digestCanonical(unsigned);
}

export function sealContract<T extends Record<string, unknown>>(value: T): T {
  const schema = schemaOf(value);
  const digestField = DIGEST_FIELDS[schema];
  if (!digestField) throw new TypeError(`Contract schema ${schema} is not self-digested`);
  return { ...value, [digestField]: computeContractDigest(value) } as T;
}

export function verifyContractDigest(value: unknown): boolean {
  const schema = schemaOf(value);
  const digestField = DIGEST_FIELDS[schema];
  if (!digestField) return false;
  return Reflect.get(value as object, digestField) === computeContractDigest(value);
}
