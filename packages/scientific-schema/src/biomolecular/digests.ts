import { digestCanonical } from "../canonical";

/** Raised when a valid versioned record no longer matches its canonical self-digest. */
export class ScientificSchemaDigestMismatchError extends Error {
  readonly code = "SCIENTIFIC_SCHEMA_DIGEST_MISMATCH" as const;

  constructor(
    readonly recordType: string,
    readonly recordId: string,
    readonly expectedDigest: string,
    readonly observedDigest: string,
  ) {
    super(
      `${recordType} ${recordId} digest mismatch: expected ${expectedDigest}, observed ${observedDigest}`,
    );
    this.name = "ScientificSchemaDigestMismatchError";
  }
}

export function canonicalDigestOmitting(value: object, omittedFields: readonly string[]): string {
  const omitted = new Set(omittedFields);
  const payload: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!omitted.has(key)) payload[key] = item;
  }
  return digestCanonical(payload);
}

export function canonicalSelfDigest(value: object, selfDigestField: string): string {
  return canonicalDigestOmitting(value, [selfDigestField]);
}
