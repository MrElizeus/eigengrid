import { createHash, sign, verify } from "node:crypto";
import {
  SecurityAuthorizationDecisionSchema,
  SecurityDigestSchema,
  SecurityPrincipalCredentialSchema,
  SecurityProfileSchema,
  SecurityRevocationSnapshotSchema,
  type SecurityAuthorizationDecision,
  type SecurityDigest,
  type SecurityPrincipalCredential,
  type SecurityProfile,
  type SecurityRevocationSnapshot,
} from "./schemas";

type CanonicalJson =
  | null
  | boolean
  | string
  | number
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

function normalize(value: unknown, path: string): CanonicalJson {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError(`Cannot canonicalize a non-finite number at ${path}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    const expected = new Set([
      ...Array.from({ length: value.length }, (_, index) => String(index)),
      "length",
    ]);
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string" || !expected.has(key)) ||
      keys.length !== expected.size
    ) {
      throw new TypeError(`Cannot canonicalize a sparse or decorated array at ${path}`);
    }
    return value.map((entry, index) => normalize(entry, `${path}[${index}]`));
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Cannot canonicalize a non-plain object at ${path}`);
    }
    const source = value as Record<string, unknown>;
    const entries: Array<readonly [string, string]> = [];
    for (const key of Reflect.ownKeys(source)) {
      if (typeof key !== "string") throw new TypeError(`Cannot canonicalize a symbol at ${path}`);
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError(`Cannot canonicalize an accessor or hidden property at ${path}.${key}`);
      }
      entries.push([key, key.normalize("NFC")]);
    }
    if (new Set(entries.map(([, normalized]) => normalized)).size !== entries.length) {
      throw new TypeError(`Unicode-normalized key collision at ${path}`);
    }
    const result: Record<string, CanonicalJson> = {};
    for (const [original, normalized] of entries.sort((left, right) =>
      left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0,
    )) {
      result[normalized] = normalize(source[original], `${path}.${normalized}`);
    }
    return result;
  }
  throw new TypeError(`Cannot canonicalize ${typeof value} at ${path}`);
}

export function canonicalSecurityJson(value: unknown): string {
  return JSON.stringify(normalize(value, "$"));
}

export function digestSecurityValue(value: unknown): SecurityDigest {
  return SecurityDigestSchema.parse(
    `sha256:${createHash("sha256").update(canonicalSecurityJson(value), "utf8").digest("hex")}`,
  );
}

function without<T extends object>(value: T, field: keyof T): Record<string, unknown> {
  const material = { ...value } as Record<string, unknown>;
  delete material[field as string];
  return material;
}

export function computeSecurityProfileDigest(
  profile: SecurityProfile | Omit<SecurityProfile, "profileDigest">,
): SecurityDigest {
  return digestSecurityValue(without(profile as SecurityProfile, "profileDigest"));
}

export function sealSecurityProfile(
  profile: Omit<SecurityProfile, "profileDigest">,
): SecurityProfile {
  return SecurityProfileSchema.parse({
    ...profile,
    profileDigest: computeSecurityProfileDigest(profile),
  });
}

export function verifySecurityProfile(value: unknown): SecurityProfile {
  const profile = SecurityProfileSchema.parse(value);
  if (computeSecurityProfileDigest(profile) !== profile.profileDigest) {
    throw new TypeError(`Security profile ${profile.profileId} digest mismatch`);
  }
  return profile;
}

export function computeSecurityCredentialDigest(
  credential:
    | SecurityPrincipalCredential
    | Omit<SecurityPrincipalCredential, "credentialDigest">
    | UnsignedSecurityCredential,
): SecurityDigest {
  const material = { ...credential } as Record<string, unknown>;
  delete material.credentialDigest;
  delete material.signature;
  return digestSecurityValue(material);
}

export type UnsignedSecurityCredential = Omit<
  SecurityPrincipalCredential,
  "credentialDigest" | "signature"
>;

export function sealSecurityCredential(
  credential: Omit<SecurityPrincipalCredential, "credentialDigest">,
): SecurityPrincipalCredential {
  return SecurityPrincipalCredentialSchema.parse({
    ...credential,
    credentialDigest: computeSecurityCredentialDigest(credential),
  });
}

/** Sign the canonical credential digest with an Ed25519 private key. */
export function signSecurityCredential(
  credential: UnsignedSecurityCredential,
  privateKeyPem: string,
): SecurityPrincipalCredential {
  const credentialDigest = computeSecurityCredentialDigest(credential);
  return SecurityPrincipalCredentialSchema.parse({
    ...credential,
    credentialDigest,
    signature: {
      algorithm: "ed25519",
      value: sign(null, Buffer.from(credentialDigest, "utf8"), privateKeyPem).toString("base64"),
    },
  });
}

/** Verify origin authentication after the canonical digest has been checked. */
export function verifySecurityCredentialSignature(
  credential: SecurityPrincipalCredential,
  publicKeyPem: string,
): boolean {
  try {
    const signature = Buffer.from(credential.signature.value, "base64");
    if (
      signature.byteLength !== 64 ||
      signature.toString("base64") !== credential.signature.value
    ) {
      return false;
    }
    return verify(null, Buffer.from(credential.credentialDigest, "utf8"), publicKeyPem, signature);
  } catch {
    return false;
  }
}

export function verifySecurityCredential(value: unknown): SecurityPrincipalCredential {
  const credential = SecurityPrincipalCredentialSchema.parse(value);
  if (computeSecurityCredentialDigest(credential) !== credential.credentialDigest) {
    throw new TypeError(`Security credential ${credential.credentialId} digest mismatch`);
  }
  return credential;
}

export function computeSecurityRevocationDigest(
  snapshot: SecurityRevocationSnapshot | Omit<SecurityRevocationSnapshot, "snapshotDigest">,
): SecurityDigest {
  return digestSecurityValue(without(snapshot as SecurityRevocationSnapshot, "snapshotDigest"));
}

export function sealSecurityRevocations(
  snapshot: Omit<SecurityRevocationSnapshot, "snapshotDigest">,
): SecurityRevocationSnapshot {
  return SecurityRevocationSnapshotSchema.parse({
    ...snapshot,
    snapshotDigest: computeSecurityRevocationDigest(snapshot),
  });
}

export function verifySecurityRevocations(value: unknown): SecurityRevocationSnapshot {
  const snapshot = SecurityRevocationSnapshotSchema.parse(value);
  if (computeSecurityRevocationDigest(snapshot) !== snapshot.snapshotDigest) {
    throw new TypeError("Security revocation snapshot digest mismatch");
  }
  return snapshot;
}

export function sealSecurityDecision(
  decision: Omit<SecurityAuthorizationDecision, "decisionDigest">,
): SecurityAuthorizationDecision {
  return SecurityAuthorizationDecisionSchema.parse({
    ...decision,
    decisionDigest: digestSecurityValue(decision),
  });
}

export function verifySecurityDecision(value: unknown): SecurityAuthorizationDecision {
  const decision = SecurityAuthorizationDecisionSchema.parse(value);
  if (digestSecurityValue(without(decision, "decisionDigest")) !== decision.decisionDigest) {
    throw new TypeError(`Security decision ${decision.requestId} digest mismatch`);
  }
  return decision;
}
