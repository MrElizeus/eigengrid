import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDatabase } from "./migrate";

test("SQLite initialization waits for another process before selecting journal mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "eigengrid-sqlite-init-"));
  const path = join(root, "database.sqlite");
  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { Database } from "bun:sqlite";
       const db = new Database(process.argv[1]);
       db.exec("CREATE TABLE fixture (value TEXT)");
       db.exec("BEGIN EXCLUSIVE");
       db.exec("INSERT INTO fixture VALUES ('preserved')");
       process.stdout.write("locked\\n");
       setTimeout(() => { db.exec("COMMIT"); db.close(); }, 500);`,
      path,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const reader = holder.stdout.getReader();
  try {
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("locked\n");
    const database = new SqliteDatabase(path);
    await database.init();
    expect(await holder.exited).toBe(0);
    const transaction = await database.beginTransaction();
    try {
      expect(await transaction.queryRows!("SELECT value FROM fixture")).toEqual([
        { value: "preserved" },
      ]);
      expect(await transaction.queryRows!("PRAGMA journal_mode")).toEqual([
        { journal_mode: "wal" },
      ]);
    } finally {
      await transaction.rollback();
      await database.close();
    }
    expect(await database.getMigrationVersion()).toBeGreaterThan(0);
  } finally {
    reader.releaseLock();
    holder.kill();
    await holder.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
