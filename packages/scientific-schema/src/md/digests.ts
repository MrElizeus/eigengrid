import { ScientificSchemaDigestMismatchError } from "../biomolecular";
import { digestCanonical } from "../canonical";

export function canonicalSelfDigest(value: object, selfDigestField: string): string {
  return canonicalDigestOmitting(value, [selfDigestField]);
}

export function canonicalDigestOmitting(value: object, omittedFields: readonly string[]): string {
  const omitted = new Set(omittedFields);
  const payload: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!omitted.has(key)) payload[key] = item;
  }
  return digestCanonical(payload);
}

export function assertSelfDigest<T extends { id: string }>(
  recordType: string,
  record: T,
  expectedDigest: string,
  selfDigestField: string,
): T {
  const observedDigest = canonicalSelfDigest(record, selfDigestField);
  if (observedDigest !== expectedDigest) {
    throw new ScientificSchemaDigestMismatchError(
      recordType,
      record.id,
      expectedDigest,
      observedDigest,
    );
  }
  return record;
}
