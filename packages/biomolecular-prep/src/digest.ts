import { createHash } from "node:crypto";

export type Sha256Digest = string & { readonly __sha256Digest: unique symbol };

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function sha256Digest(bytes: Uint8Array): Sha256Digest {
  return createHash("sha256").update(bytes).digest("hex") as Sha256Digest;
}

export function parseSha256Digest(value: string): Sha256Digest {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError("SHA-256 digest must contain exactly 64 lower-case hexadecimal characters");
  }
  return value as Sha256Digest;
}

export function cloneBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}
