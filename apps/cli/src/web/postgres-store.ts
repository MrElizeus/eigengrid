import { Pool } from "pg";
import { newChat, type WebStore, type WebUser, type Conversation, type ChatSummary } from "./store";

/** Dedicated schema: scientific job tables and their migrations are never modified. */
export class PostgresChatStore implements WebStore {
  private constructor(private pool: Pool) {}
  static async open(url: string) {
    const pool = new Pool({ connectionString: url, max: 6, connectionTimeoutMillis: 5000 });
    pool.on("error", () => {
      /* Individual requests report availability without logging a DSN. */
    });
    try {
      await pool.query(`CREATE SCHEMA IF NOT EXISTS eigengrid_web;
        CREATE TABLE IF NOT EXISTS eigengrid_web.users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('admin','operator')));
        CREATE TABLE IF NOT EXISTS eigengrid_web.invitations (hash TEXT PRIMARY KEY, expires BIGINT NOT NULL);
        CREATE TABLE IF NOT EXISTS eigengrid_web.chats (id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES eigengrid_web.users(id), title TEXT NOT NULL, updated TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS chats_owner_updated ON eigengrid_web.chats(owner, updated DESC);`);
      return new PostgresChatStore(pool);
    } catch {
      await pool.end();
      throw new Error(
        "Unable to prepare PostgreSQL for the workspace. Check EIGENGRID_WEB_DATABASE_URL and permissions for the eigengrid_web schema.",
      );
    }
  }
  async hasUsers() {
    return !!(await this.pool.query("SELECT 1 FROM eigengrid_web.users LIMIT 1")).rowCount;
  }
  async user(username: string): Promise<WebUser | null> {
    return (
      (
        await this.pool.query(
          'SELECT id, username, password_hash AS "passwordHash", role FROM eigengrid_web.users WHERE username=$1',
          [username],
        )
      ).rows[0] ?? null
    );
  }
  async createUser(username: string, passwordHash: string, invitation?: string): Promise<WebUser> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(18743011)");
      if (invitation) {
        const used = await client.query(
          "DELETE FROM eigengrid_web.invitations WHERE hash=$1 AND expires>$2 RETURNING hash",
          [invitation, Date.now()],
        );
        if (!used.rowCount) throw new Error("The invitation is invalid or has expired.");
      } else if ((await client.query("SELECT 1 FROM eigengrid_web.users LIMIT 1")).rowCount)
        throw new Error("The initial account already exists.");
      const user: WebUser = {
        id: crypto.randomUUID(),
        username,
        passwordHash,
        role: invitation ? "operator" : "admin",
      };
      await client.query("INSERT INTO eigengrid_web.users VALUES ($1,$2,$3,$4)", [
        user.id,
        username,
        passwordHash,
        user.role,
      ]);
      await client.query("COMMIT");
      return user;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async invite(hash: string, expires: number) {
    await this.pool.query("DELETE FROM eigengrid_web.invitations WHERE expires<=$1", [Date.now()]);
    await this.pool.query("INSERT INTO eigengrid_web.invitations VALUES ($1,$2)", [hash, expires]);
  }
  async list(owner: string): Promise<ChatSummary[]> {
    return (
      await this.pool.query(
        'SELECT id,title,updated AS "updatedAt" FROM eigengrid_web.chats WHERE owner=$1 ORDER BY updated DESC',
        [owner],
      )
    ).rows;
  }
  async get(id: string, owner: string): Promise<Conversation | undefined> {
    const row = (
      await this.pool.query("SELECT data FROM eigengrid_web.chats WHERE id=$1 AND owner=$2", [
        id,
        owner,
      ])
    ).rows[0];
    return row ? JSON.parse(row.data) : undefined;
  }
  async create(owner: string) {
    const chat = newChat(owner);
    await this.save(chat);
    return chat;
  }
  async save(chat: Conversation) {
    chat.updatedAt = new Date().toISOString();
    await this.pool.query(
      "INSERT INTO eigengrid_web.chats VALUES ($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET title=excluded.title,updated=excluded.updated,data=excluded.data WHERE chats.owner=excluded.owner",
      [chat.id, chat.owner, chat.title, chat.updatedAt, JSON.stringify(chat)],
    );
  }
  async delete(id: string, owner: string) {
    await this.pool.query("DELETE FROM eigengrid_web.chats WHERE id=$1 AND owner=$2", [id, owner]);
  }
  async close() {
    await this.pool.end();
  }
}
