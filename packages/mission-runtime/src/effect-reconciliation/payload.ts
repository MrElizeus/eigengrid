import { ScientificIntegrityError } from "../errors";

export type PayloadRow = { payload_json: unknown } & Record<string, unknown>;

export function parsePayload<T>(
  schema: { parse(value: unknown): T },
  row: PayloadRow,
  label: string,
): T {
  try {
    const payload =
      typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json;
    return schema.parse(payload);
  } catch (error) {
    throw new ScientificIntegrityError(`${label} contains an invalid authoritative payload`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
