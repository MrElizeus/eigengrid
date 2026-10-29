import { existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import {
  installedScientificSkillRoot,
  loadScientificSkillCorpus,
  ScientificSkillRegistry,
  searchScientificSkills,
  type LoadedScientificSkill,
} from "@eigengrid/scientific-skills";
import { AgentAuthorityLevel, type AgentContextBlock } from "./authority";

// Use dynamic import for bun:sqlite to avoid type issues
interface SqliteStatement {
  run(...values: unknown[]): unknown;
  all<T = unknown>(...values: unknown[]): T[];
  get<T = unknown>(...values: unknown[]): T | undefined;
}

interface Database {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export interface Observation {
  id: number;
  title: string;
  content: string;
  type?: string;
  createdAt: number;
  sessionId?: string;
  toolName?: string;
  inputSummary?: string;
}

export interface StoreOpts {
  type?: "decision" | "discovery" | "bugfix" | "resolution" | "architecture";
  sessionId?: string;
  toolName?: string;
  inputSummary?: string;
}

export interface Skill {
  name: string;
  trigger: string;
  path: string;
  content: string;
  source: "canonical" | "legacy";
}

export interface AgentMemoryOptions {
  dbPath?: string;
  /** Canonical scientific skill corpus. Defaults to the repository corpus. */
  skillRoot?: string;
  /** Legacy operator skills are opt-in and never part of the scientific corpus. */
  allowLegacySkills?: boolean;
  /** Optional legacy context directory; read only when allowLegacySkills is true. */
  legacySkillRoot?: string;
}

const MAX_MEMORY_TITLE_BYTES = 512;
const MAX_MEMORY_CONTENT_BYTES = 4_096;
const MAX_MEMORY_FIELD_BYTES = 512;

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/giu,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|credential)\s*[:=]\s*[^\s,;]+/giu,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/giu,
];

/** Redacts credentials and bounds persisted memory before it becomes durable. */
export function sanitizeMemoryText(value: string, maximumBytes: number): string {
  let sanitized = value;
  for (const pattern of SECRET_PATTERNS) sanitized = sanitized.replace(pattern, "[REDACTED]");
  if (Buffer.byteLength(sanitized, "utf8") <= maximumBytes) return sanitized;
  let result = sanitized;
  while (Buffer.byteLength(result, "utf8") > maximumBytes - 32) {
    result = result.slice(0, Math.max(0, result.length - 64));
  }
  return `${result}…[TRUNCATED]`;
}

// ────────────────────────────────────────────────────────────
// AgentMemory — Project-local tri-layer cognitive memory
// ────────────────────────────────────────────────────────────
//
// L3 (Episodic): SQLite database at .eigengrid/memory.db
//                Portable with the project directory.
// L2 (Procedural): Skill registry on filesystem
// L1 (Enforcement): Tool registry (provided by consumer)

export class AgentMemory {
  private db: Database | null = null;
  private dbPath: string;
  private readonly skillRoot: string;
  private readonly allowLegacySkills: boolean;
  private readonly legacySkillRoot: string;
  private canonicalSkills?: ScientificSkillRegistry;

  constructor(opts?: AgentMemoryOptions) {
    this.dbPath = opts?.dbPath ?? findMemoryDbPath();
    this.skillRoot = opts?.skillRoot ?? installedScientificSkillRoot();
    this.allowLegacySkills = opts?.allowLegacySkills ?? false;
    this.legacySkillRoot =
      opts?.legacySkillRoot ?? join(process.env.HOME ?? "/root", ".config", "opencode", "skills");
  }

  // ── Lifecycle ──────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.db) return;
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    let database: Database | null = null;
    try {
      const { Database } = await import("bun:sqlite");
      database = new Database(this.dbPath) as Database;
      database.exec("PRAGMA journal_mode=WAL");
      database.exec("PRAGMA synchronous=NORMAL");

      database.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        type TEXT DEFAULT 'discovery',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        session_id TEXT,
        tool_name TEXT,
        input_summary TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
    `);

      const migrations = [
        "ALTER TABLE memories ADD COLUMN session_id TEXT",
        "ALTER TABLE memories ADD COLUMN tool_name TEXT",
        "ALTER TABLE memories ADD COLUMN input_summary TEXT",
      ];
      for (const sql of migrations) {
        try {
          database.exec(sql);
        } catch (error) {
          // SQLite reports duplicate-column errors for already migrated stores.
          if (!String(error).toLowerCase().includes("duplicate column")) throw error;
        }
      }
      this.db = database;
    } catch (error) {
      database?.close();
      this.db = null;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  async close(): Promise<void> {
    await this.disconnect();
  }

  isConnected(): boolean {
    return this.db !== null;
  }

  // ── L3: Episodic (local SQLite) ───────────────────────

  async store(title: string, content: string, opts?: StoreOpts): Promise<void> {
    if (!this.db) throw new Error("AgentMemory not connected. Call connect() first.");
    const safeTitle = sanitizeMemoryText(title, MAX_MEMORY_TITLE_BYTES);
    const safeContent = sanitizeMemoryText(content, MAX_MEMORY_CONTENT_BYTES);
    const safeSessionId = opts?.sessionId
      ? sanitizeMemoryText(opts.sessionId, MAX_MEMORY_FIELD_BYTES)
      : null;
    const safeToolName = opts?.toolName
      ? sanitizeMemoryText(opts.toolName, MAX_MEMORY_FIELD_BYTES)
      : null;
    const safeInputSummary = opts?.inputSummary
      ? sanitizeMemoryText(opts.inputSummary, MAX_MEMORY_FIELD_BYTES)
      : null;

    const stmt = this.db.prepare(
      "INSERT INTO memories (title, content, type, session_id, tool_name, input_summary) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    );
    stmt.run(
      safeTitle,
      safeContent,
      opts?.type ?? "discovery",
      safeSessionId,
      safeToolName,
      safeInputSummary,
    );
  }

  async search(
    query: string,
    opts?: { type?: string; limit?: number; toolName?: string },
  ): Promise<Observation[]> {
    if (!this.db) return [];

    let sql =
      "SELECT id, title, content, type, created_at as createdAt, session_id as sessionId, tool_name as toolName, input_summary as inputSummary FROM memories WHERE 1=1";
    const params: unknown[] = [];

    if (opts?.type) {
      sql += " AND type = ?";
      params.push(opts.type);
    }

    if (opts?.toolName) {
      sql += " AND tool_name = ?";
      params.push(opts.toolName);
    }

    // Simple LIKE search on title and content
    sql += " AND (title LIKE ? OR content LIKE ?)";
    const like = `%${query}%`;
    params.push(like, like);

    sql += " ORDER BY created_at DESC";
    if (opts?.limit) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }

    return this.db.prepare(sql).all(...params) as Observation[];
  }

  async getRecent(limit: number = 5): Promise<Observation[]> {
    if (!this.db) return [];
    return this.db
      .prepare(
        "SELECT id, title, content, type, created_at as createdAt, session_id as sessionId, tool_name as toolName, input_summary as inputSummary FROM memories ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit) as Observation[];
  }

  async count(): Promise<number> {
    if (!this.db) return 0;
    const row = this.db.prepare("SELECT COUNT(*) as count FROM memories").get() as {
      count: number;
    };
    return row.count;
  }

  // ── L2: Procedural (Skill Registry) ──────────────────

  async findSkill(trigger: string): Promise<Skill | null> {
    const registry = this.canonicalRegistry();
    const hit = searchScientificSkills(registry, trigger, { limit: 1 }).hits[0];
    if (hit && hit.score > 0) {
      const skill = registry.exact(hit.skill.skillId, hit.skill.version);
      if (skill) return canonicalMemorySkill(skill);
    }
    if (!this.allowLegacySkills) return null;
    const skills = this.legacySkills();
    const lower = trigger.toLowerCase();
    return (
      skills.find(
        (s) => lower.includes(s.trigger.toLowerCase()) || lower.includes(s.name.toLowerCase()),
      ) ?? null
    );
  }

  async listSkills(scope?: string): Promise<Skill[]> {
    const canonical = this.canonicalRegistry()
      .all()
      .filter(
        (skill) => !scope || skill.manifest.id === scope || skill.manifest.domains.includes(scope),
      )
      .map(canonicalMemorySkill);
    if (!this.allowLegacySkills) return canonical;
    return [...canonical, ...this.legacySkills(scope)];
  }

  private canonicalRegistry(): ScientificSkillRegistry {
    return (this.canonicalSkills ??= new ScientificSkillRegistry(
      loadScientificSkillCorpus(this.skillRoot),
    ));
  }

  private legacySkills(scope?: string): Skill[] {
    return readSkillsFromRoot(this.legacySkillRoot, scope, "legacy");
  }

  /** Returns context blocks with provenance; callers must keep them out of system policy. */
  async retrieveContext(prompt: string): Promise<AgentContextBlock[]> {
    if (!this.isConnected()) return [];
    const blocks: AgentContextBlock[] = [];
    const skill = await this.findSkill(prompt);
    if (skill) {
      blocks.push({
        authority:
          skill.source === "canonical"
            ? AgentAuthorityLevel.CANONICAL_SKILL
            : AgentAuthorityLevel.RETRIEVED_MEMORY,
        source: skill.source === "canonical" ? "canonical-skill" : "retrieved-memory",
        name: skill.name,
        content: sanitizeMemoryText(skill.content, 2_000),
      });
    }
    const recent = await this.search(prompt, { limit: 3 });
    for (const observation of recent) {
      blocks.push({
        authority: AgentAuthorityLevel.RETRIEVED_MEMORY,
        source: "retrieved-memory",
        name: observation.title,
        content: sanitizeMemoryText(observation.content, 512),
      });
    }
    return blocks;
  }
}

function canonicalMemorySkill(skill: LoadedScientificSkill): Skill {
  return {
    name: skill.manifest.id,
    trigger: skill.manifest.id,
    path: join(skill.directory, "SKILL.md"),
    content: `Scientific skill ${skill.manifest.id}@${skill.manifest.version}\nKnowledge level: ${skill.manifest.knowledge_level}; review: ${skill.manifest.review.status}\n\n${skill.markdownBody}`,
    source: "canonical",
  };
}

function readSkillsFromRoot(
  skillsDir: string,
  scope: string | undefined,
  source: Skill["source"],
): Skill[] {
  if (!existsSync(skillsDir)) return [];
  const skills: Skill[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || (scope && entry.name !== scope)) continue;
    const skillFile = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    try {
      const content = readFileSync(skillFile, "utf8");
      const triggerMatch = content.match(/trigger:\s*"([^"]+)"/);
      skills.push({
        name: entry.name,
        trigger: triggerMatch?.[1] ?? entry.name,
        path: skillFile,
        content,
        source,
      });
    } catch {
      // Unreadable skill files are unavailable context, never executable policy.
    }
  }
  return skills;
}

// ── Helpers ────────────────────────────────────────────

function findMemoryDbPath(): string {
  const cwd = process.cwd();
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, ".eigengrid"))) {
      return join(dir, ".eigengrid", "memory.db");
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: create in current working directory
  const fallback = join(cwd, ".eigengrid");
  if (!existsSync(fallback)) mkdirSync(fallback, { recursive: true });
  return join(fallback, "memory.db");
}
