import { Database } from "bun:sqlite";
import { chmodSync, lstatSync, mkdirSync, openSync, closeSync, constants } from "node:fs";
import { dirname } from "node:path";
import type { ModelMessage } from "ai";

export interface ToolActivity {
  name: string;
  args?: unknown;
  result?: unknown;
  ok?: boolean;
}
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  tools?: ToolActivity[];
  error?: boolean;
  status?: "complete" | "stopped" | "redirected" | "error";
  durationMs?: number;
}
export interface Conversation {
  id: string;
  owner: string;
  title: string;
  updatedAt: string;
  messages: ChatMessage[];
  history: ModelMessage[];
  pendingPrompt?: string;
}
export interface WebUser {
  id: string;
  username: string;
  passwordHash: string;
  role: "admin" | "operator";
}
export type ChatSummary = Pick<Conversation, "id" | "title" | "updatedAt">;
type MaybeAsync<T> = T | Promise<T>;
export interface WebStore {
  hasUsers(): MaybeAsync<boolean>;
  user(username: string): MaybeAsync<WebUser | null>;
  createUser(username: string, hash: string, invitation?: string): MaybeAsync<WebUser>;
  invite(hash: string, expires: number): MaybeAsync<void>;
  list(owner: string): MaybeAsync<ChatSummary[]>;
  get(id: string, owner: string): MaybeAsync<Conversation | undefined>;
  create(owner: string): MaybeAsync<Conversation>;
  save(chat: Conversation): MaybeAsync<void>;
  delete(id: string, owner: string): MaybeAsync<void>;
  close(): MaybeAsync<void>;
}
export function newChat(owner: string): Conversation {
  return {
    id: crypto.randomUUID(),
    owner,
    title: "Nueva conversación",
    updatedAt: new Date().toISOString(),
    messages: [],
    history: [],
  };
}

/** Local development store. Network serving requires the PostgreSQL store. */
export class ChatStore implements WebStore {
  private db: Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const dir = lstatSync(dirname(path));
    if (
      dir.isSymbolicLink() ||
      !dir.isDirectory() ||
      dir.mode & 0o022 ||
      (process.getuid && dir.uid !== process.getuid())
    )
      throw new Error("Unsafe web state directory");
    const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
    const file = lstatSync(path);
    if (!file.isFile() || file.nlink !== 1 || (process.getuid && file.uid !== process.getuid()))
      throw new Error("Unsafe web state file");
    chmodSync(path, 0o600);
    this.db = new Database(path);
    this.db.run(
      "CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated TEXT NOT NULL, data TEXT NOT NULL, owner TEXT)",
    );
    if (
      !(this.db.query("PRAGMA table_info(chats)").all() as { name: string }[]).some(
        (c) => c.name === "owner",
      )
    )
      this.db.run("ALTER TABLE chats ADD COLUMN owner TEXT");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS web_users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL)",
    );
    this.db.run(
      "CREATE TABLE IF NOT EXISTS web_invitations (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL)",
    );
  }
  hasUsers() {
    return !!this.db.query("SELECT 1 FROM web_users LIMIT 1").get();
  }
  user(username: string) {
    return this.db
      .query(
        "SELECT id, username, password_hash AS passwordHash, role FROM web_users WHERE username = ?",
      )
      .get(username) as WebUser | null;
  }
  createUser(username: string, passwordHash: string, invitation?: string) {
    return this.db.transaction(() => {
      if (invitation) {
        const used = this.db
          .query("DELETE FROM web_invitations WHERE hash = ? AND expires > ? RETURNING hash")
          .get(invitation, Date.now());
        if (!used) throw new Error("La invitación no es válida o ha caducado.");
      } else if (this.hasUsers()) throw new Error("La cuenta inicial ya existe.");
      const user: WebUser = {
        id: crypto.randomUUID(),
        username,
        passwordHash,
        role: invitation ? "operator" : "admin",
      };
      this.db
        .query("INSERT INTO web_users VALUES (?, ?, ?, ?)")
        .run(user.id, username, passwordHash, user.role);
      if (!invitation) this.db.query("UPDATE chats SET owner = ? WHERE owner IS NULL").run(user.id);
      return user;
    })();
  }
  invite(hash: string, expires: number) {
    this.db.query("DELETE FROM web_invitations WHERE expires <= ?").run(Date.now());
    this.db.query("INSERT INTO web_invitations VALUES (?, ?)").run(hash, expires);
  }
  list(owner: string): ChatSummary[] {
    return this.db
      .query(
        "SELECT id, title, updated AS updatedAt FROM chats WHERE owner = ? ORDER BY updated DESC",
      )
      .all(owner) as ChatSummary[];
  }
  get(id: string, owner: string): Conversation | undefined {
    const row = this.db
      .query("SELECT data FROM chats WHERE id = ? AND owner = ?")
      .get(id, owner) as { data: string } | null;
    return row ? { ...JSON.parse(row.data), owner } : undefined;
  }
  create(owner: string) {
    const chat = newChat(owner);
    this.save(chat);
    return chat;
  }
  save(chat: Conversation) {
    chat.updatedAt = new Date().toISOString();
    this.db
      .query(
        "INSERT INTO chats (id, title, updated, data, owner) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated=excluded.updated, data=excluded.data WHERE chats.owner=excluded.owner",
      )
      .run(chat.id, chat.title, chat.updatedAt, JSON.stringify(chat), chat.owner);
  }
  delete(id: string, owner: string) {
    this.db.query("DELETE FROM chats WHERE id = ? AND owner = ?").run(id, owner);
  }
  close() {
    this.db.close();
  }
}
