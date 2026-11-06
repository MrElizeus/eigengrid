// Keep existing imports stable while SQLite implementation lives with its adapter.
export { SqliteDatabase, createDatabase } from "./sqlite/client";
export { MIGRATIONS, type Migration } from "./sqlite/migrations";
