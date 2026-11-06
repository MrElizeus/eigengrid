import { Database } from "bun:sqlite";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Private local storage. The owning OS account is the trust boundary, not a hostile-file sandbox. */
export function openExperienceDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const directory = lstatSync(dirname(path));
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (process.getuid && directory.uid !== process.getuid())
  )
    throw new Error(
      "Experience directory must be owned by the current user and cannot be a symlink",
    );
  chmodSync(dirname(path), 0o700);
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid()))
      throw new Error("Experience database must be a regular file owned by the current user");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const db = new Database(path, { create: true, strict: true });
  try {
    chmodSync(path, 0o600);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS experience_evidence_v1 (
        boundary TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(boundary, id)
      );
      CREATE TABLE IF NOT EXISTS experience_lessons_v1 (
        boundary TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(boundary, id)
      );
      CREATE TABLE IF NOT EXISTS experience_events_v1 (
        boundary TEXT NOT NULL, id TEXT NOT NULL, sequence INTEGER NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(boundary, id, sequence)
      );
    `);
    for (const table of ["evidence", "lessons", "events"])
      for (const action of ["UPDATE", "DELETE"])
        db.exec(`CREATE TRIGGER IF NOT EXISTS immutable_experience_${table}_${action}
          BEFORE ${action} ON experience_${table}_v1
          BEGIN SELECT RAISE(ABORT, 'experience history is append-only'); END;`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
