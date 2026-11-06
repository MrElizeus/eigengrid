import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { SqliteContext } from "./context";
import { SqliteTransaction, type SqliteConnection, type SqliteStatement } from "./transaction";

test("a failed deferred constraint commit can roll back and release queued transactions", async () => {
  const db = new Database(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE parent(id INTEGER PRIMARY KEY);
    CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER
      REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);`);
  const context = new SqliteContext(":memory:");
  context.db = db as SqliteConnection;
  try {
    const transaction = await context.beginTransaction();
    await transaction.query("INSERT INTO child VALUES(1, 99)");
    const queued = context.beginTransaction();
    await expect(transaction.commit()).rejects.toThrow("FOREIGN KEY constraint failed");
    expect(db.inTransaction).toBe(true);
    await transaction.rollback();
    await transaction.rollback();
    const next = await queued;
    expect(await next.queryRows!("SELECT * FROM child")).toEqual([]);
    await next.query("INSERT INTO parent VALUES(99)");
    await next.query("INSERT INTO child VALUES(2, 99)");
    await next.commit();
    await next.commit();
    expect(db.inTransaction).toBe(false);
    expect(db.query("SELECT id FROM child").all()).toEqual([{ id: 2 }]);
  } finally {
    db.close();
  }
}, 2000);

test("an automatic SQLite rollback still releases the transaction exactly once", async () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE items(id INTEGER PRIMARY KEY); INSERT INTO items VALUES(1)");
  let released = 0;
  const transaction = new SqliteTransaction(db as SqliteConnection, () => released++);
  try {
    await expect(transaction.query("INSERT OR ROLLBACK INTO items VALUES(1)")).rejects.toThrow();
    expect(db.inTransaction).toBe(false);
    await transaction.rollback();
    await transaction.rollback();
    expect(released).toBe(1);
  } finally {
    db.close();
  }
});

test("a failed rollback discards the connection and rejects queued work without hanging", async () => {
  const db = new Database(":memory:");
  const context = new SqliteContext(":memory:");
  let closed = 0;
  context.db = {
    query(sql) {
      if (sql === "ROLLBACK") throw new Error("rollback I/O failure");
      return db.query(sql) as SqliteStatement;
    },
    close() {
      closed++;
      db.close();
    },
  };
  const transaction = await context.beginTransaction();
  const queued = context.beginTransaction().catch((error: unknown) => error);
  await expect(transaction.rollback()).rejects.toThrow("rollback I/O failure");
  expect(await queued).toMatchObject({ message: "Database not initialized. Call init() first." });
  await transaction.rollback();
  expect(closed).toBe(1);
  expect(() => context.ensureDb()).toThrow("Database not initialized");
  await expect(context.beginTransaction()).rejects.toThrow("Database not initialized");
}, 2000);
