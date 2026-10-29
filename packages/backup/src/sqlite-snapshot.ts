import { mkdtempSync, readFileSync, rmSync } from "fs";
import { dirname, join, resolve } from "path";

/** Create and validate a self-contained SQLite snapshot for a backup archive. */
export async function readVerifiedSqliteSnapshot(dbPath: string): Promise<Buffer> {
  const sourcePath = resolve(dbPath);
  const snapshotDir = mkdtempSync(join(dirname(sourcePath), ".eigengrid-backup-snapshot-"));
  const snapshotPath = join(snapshotDir, "head.sqlite");
  let source: InstanceType<(typeof import("bun:sqlite"))["Database"]> | undefined;
  let snapshot: InstanceType<(typeof import("bun:sqlite"))["Database"]> | undefined;
  let result: Buffer | undefined;
  let operationError: unknown;
  const cleanupErrors: unknown[] = [];

  try {
    const { Database } = await import("bun:sqlite");
    source = new Database(sourcePath, { readonly: true });
    source.query("VACUUM INTO ?").run(snapshotPath);
    source.close();
    source = undefined;

    snapshot = new Database(snapshotPath, { readonly: true });
    const integrity = snapshot.query("PRAGMA integrity_check").all() as Array<
      Record<string, unknown>
    >;
    if (
      integrity.length !== 1 ||
      Object.keys(integrity[0]).length !== 1 ||
      integrity[0].integrity_check !== "ok"
    ) {
      throw new Error("SQLite snapshot integrity_check did not report exactly ok");
    }
    const foreignKeyViolations = snapshot.query("PRAGMA foreign_key_check").all();
    if (foreignKeyViolations.length !== 0) {
      throw new Error(
        `SQLite snapshot foreign_key_check reported ${foreignKeyViolations.length} violation(s)`,
      );
    }
    result = readFileSync(snapshotPath);
    snapshot.close();
    snapshot = undefined;
  } catch (error) {
    operationError = error;
  } finally {
    for (const cleanup of [
      () => snapshot?.close(),
      () => source?.close(),
      () => rmSync(snapshotDir, { recursive: true, force: true }),
    ]) {
      try {
        cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (operationError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      "SQLite snapshot and cleanup failed",
    );
  }
  if (operationError) throw operationError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1)
    throw new AggregateError(cleanupErrors, "SQLite snapshot cleanup failed");
  return result!;
}
