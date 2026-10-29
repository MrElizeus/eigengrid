/** Internal SQL read primitives. Authority checks always receive the caller-owned transaction. */
import { ScientificEntityNotFoundError, ScientificIntegrityError } from "./errors";
import type { ScientificTransaction } from "./types";

export type JsonRow = { payload_json: string } & Record<string, unknown>;

export function parseJson(row: JsonRow, entity: string): unknown {
  try {
    return JSON.parse(String(row.payload_json));
  } catch {
    throw new ScientificIntegrityError(`${entity} contains malformed authoritative JSON`);
  }
}

export async function queryRows<T extends Record<string, unknown>>(
  tx: ScientificTransaction,
  sql: string,
  params: unknown[],
): Promise<T[]> {
  return tx.queryRows<T>(sql, params);
}

export async function one<T extends Record<string, unknown>>(
  tx: ScientificTransaction,
  sql: string,
  params: unknown[],
): Promise<T | null> {
  return (await queryRows<T>(tx, sql, params))[0] ?? null;
}

export function lockClause(provider: string, lock: boolean): string {
  return provider === "postgres" && lock ? " FOR UPDATE" : "";
}

export async function latestRevisionRow<T extends JsonRow>(
  tx: ScientificTransaction,
  provider: string,
  table: string,
  entity: string,
  id: string,
  lock = false,
): Promise<T> {
  const row = await one<T>(
    tx,
    `SELECT * FROM ${table} WHERE id = $1 ORDER BY revision DESC LIMIT 1${lockClause(provider, lock)}`,
    [id],
  );
  if (!row) throw new ScientificEntityNotFoundError(entity, id);
  return row;
}
