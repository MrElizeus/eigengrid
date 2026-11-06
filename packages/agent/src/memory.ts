import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import {
  installedScientificSkillRoot,
  type LoadedScientificSkill,
} from "@eigengrid/scientific-skills";
import {
  createInstalledScientificRetrieval,
  installedRetrievalConfigurationDigest,
  type ScientificRetrievalService,
} from "@eigengrid/scientific-retrieval";
import { AgentAuthorityLevel, type AgentContextBlock } from "./authority";
import {
  ExperienceMemory,
  memoryDigest,
  type MemoryBoundary,
  type RetrievalContext,
} from "@eigengrid/experience-memory";

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
  /** Trusted host identity only; never populated from a model tool argument. */
  experienceBoundary?: MemoryBoundary;
  experienceContext?: RetrievalContext;
  /** Host-bound retrieval view; required for multi-user or project-restricted catalogs. */
  scientificRetrieval?: ScientificRetrievalService;
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
  private retrieval?: ScientificRetrievalService;
  private retrievalConfigurationDigest?: string;
  private readonly suppliedRetrieval?: ScientificRetrievalService;
  experience?: ExperienceMemory;
  readonly experienceContext: RetrievalContext;
  private readonly experienceBoundary: MemoryBoundary;

  constructor(opts?: AgentMemoryOptions) {
    this.dbPath = opts?.dbPath ?? findMemoryDbPath();
    let projectDirectory = resolve(dirname(this.dbPath));
    const missing: string[] = [];
    while (!existsSync(projectDirectory)) {
      missing.unshift(basename(projectDirectory));
      projectDirectory = dirname(projectDirectory);
    }
    const projectIdentity = join(realpathSync(projectDirectory), ...missing);
    this.experienceBoundary = opts?.experienceBoundary ?? {
      projectId: "project:" + memoryDigest(projectIdentity),
      ownerId: "os-user:" + (process.getuid?.() ?? process.env.USER ?? "local"),
    };
    this.experienceContext = structuredClone(
      opts?.experienceContext ?? {
        facts: { platform: process.platform, architecture: process.arch },
      },
    );
    this.skillRoot = opts?.skillRoot ?? installedScientificSkillRoot();
    this.suppliedRetrieval = opts?.scientificRetrieval;
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
      this.experience = new ExperienceMemory(
        join(dir, "experience", "memory.sqlite"),
        this.experienceBoundary,
      );
      this.db = database;
    } catch (error) {
      database?.close();
      this.db = null;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.retrieval?.close();
    this.retrieval = undefined;
    this.experience?.close();
    this.experience = undefined;
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
    const retrieval = this.scientificRetrieval();
    const result = trigger.trim()
      ? await retrieval.search({ query: trigger.slice(0, 2000), limit: 5 })
      : undefined;
    const snapshot = retrieval.snapshot();
    if (
      result &&
      (result.corpusDigest !== snapshot.registry.corpusDigest ||
        result.scopeDigest !== snapshot.scopeDigest)
    )
      throw new Error("Scientific retrieval view changed");
    const registry = snapshot.registry;
    const hit = result?.hits.find((candidate) => candidate.applicability !== "incompatible");
    if (hit && !result?.ambiguous) {
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
    const canonical = this.scientificRetrieval()
      .snapshot()
      .registry.all()
      .filter(
        (skill) => !scope || skill.manifest.id === scope || skill.manifest.domains.includes(scope),
      )
      .map(canonicalMemorySkill);
    if (!this.allowLegacySkills) return canonical;
    return [...canonical, ...this.legacySkills(scope)];
  }

  private scientificRetrieval(): ScientificRetrievalService {
    if (this.suppliedRetrieval) return this.suppliedRetrieval;
    const key = installedRetrievalConfigurationDigest(this.skillRoot);
    if (!this.retrieval || this.retrievalConfigurationDigest !== key) {
      this.retrieval?.close();
      this.retrieval = createInstalledScientificRetrieval(this.skillRoot);
      this.retrievalConfigurationDigest = key;
    }
    return this.retrieval;
  }

  private legacySkills(scope?: string): Skill[] {
    return readSkillsFromRoot(this.legacySkillRoot, scope, "legacy");
  }

  /** Returns context blocks with provenance; callers must keep them out of system policy. */
  async retrieveContext(prompt: string): Promise<AgentContextBlock[]> {
    if (!this.isConnected()) return [];
    const blocks: AgentContextBlock[] = [];
    const retrieval = this.scientificRetrieval();
    const request = { query: prompt.slice(0, 2000), limit: 5 };
    const result = prompt.trim() ? await retrieval.search(request) : undefined;
    const snapshot = retrieval.snapshot();
    if (
      result &&
      (result.corpusDigest !== snapshot.registry.corpusDigest ||
        result.scopeDigest !== snapshot.scopeDigest)
    )
      throw new Error("Scientific retrieval view changed");
    const hit =
      result && !result.ambiguous
        ? result.hits.find((candidate) => candidate.applicability !== "incompatible")
        : undefined;
    const canonical = hit
      ? snapshot.registry.exact(hit.skill.skillId, hit.skill.version)
      : undefined;
    const skill = canonical
      ? canonicalMemorySkill(canonical)
      : this.allowLegacySkills
        ? this.legacySkills().find(
            (entry) =>
              prompt.toLowerCase().includes(entry.trigger.toLowerCase()) ||
              prompt.toLowerCase().includes(entry.name.toLowerCase()),
          )
        : undefined;
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
      if (skill.source === "canonical" && result) {
        const context = retrieval.context(result, request, {
          maxFragments: 10,
          maxCharacters: 12000,
        });
        blocks.push({
          authority: AgentAuthorityLevel.CANONICAL_SKILL,
          source: "canonical-skill",
          name: `${skill.name}:procedures`,
          content: `Corpus: ${context.corpusDigest}\nRetrieval: ${result.retrievalDigest}\nSelection: ${context.selectionDigest}\nContext status: ${context.status}\nResolved knowledge: ${JSON.stringify(context.resolved)}\nMissing required fragments: ${JSON.stringify(context.missingRequiredFragmentIds)}\nRetrieval does not establish scientific applicability, live installation state or execution permission. This is a bounded selection. Use inspect-protocol with includeDependencies=true and follow nextCursor with the returned corpusDigest before finalizing a specialized plan. Optional recommendations require explicit system context.\n\n${context.fragments.map((fragment) => `${fragment.reference.fragmentId}\nSHA256: ${fragment.reference.fragmentDigest}\n${fragment.content}`).join("\n\n")}`,
        });
      }
    }
    if (!canonical && result?.hits.length) {
      blocks.push({
        authority: AgentAuthorityLevel.CANONICAL_SKILL,
        source: "canonical-skill",
        name: "scientific-protocol-candidates",
        content: `Candidate guidance only; inspect exact versions and required dependencies before selecting a procedure. Ranking scores are not scientific confidence or execution authority.\n${JSON.stringify({ corpusDigest: result.corpusDigest, retrievalDigest: result.retrievalDigest, ambiguous: result.ambiguous, candidates: result.hits.slice(0, 3).map((candidate) => ({ reference: candidate.skill, title: candidate.title, applicability: candidate.applicability, reasons: candidate.reasons })) })}`,
      });
    }
    const recent = await this.search(prompt, { limit: 3 });
    for (const observation of recent) {
      blocks.push({
        authority: AgentAuthorityLevel.RETRIEVED_MEMORY,
        source: "retrieved-memory",
        name: observation.title,
        content:
          "Legacy unverified observation; it may be stale or contradicted. Verify current evidence.\n" +
          sanitizeMemoryText(observation.content, 512),
      });
    }
    for (const hit of this.experience?.search(prompt, this.experienceContext, { limit: 3 }) ?? []) {
      const { candidate, current } = hit.lesson;
      blocks.push({
        authority: AgentAuthorityLevel.RETRIEVED_MEMORY,
        source: "retrieved-memory",
        name: "experience:" + candidate.id,
        content: JSON.stringify({
          kind: "reviewed_experience_not_execution_authority",
          id: candidate.id,
          digest: candidate.digest,
          revisionDigest: current.digest,
          state: current.state,
          claim: candidate.claim.slice(0, 1500),
          claimComplete: candidate.claim.length <= 1500,
          applicability:
            "All stored conditions matched host facts; inspect the full lesson before applying it",
          confidence: current.confidence.level,
          confidenceMeaning: "reviewer_assessment_not_calibrated_probability",
          expiresAt: candidate.expiresAt,
          evidence: candidate.evidence.slice(0, 4),
          evidenceCount: candidate.evidence.length,
        }),
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
    content: `Scientific skill ${skill.manifest.id}@${skill.manifest.version}\nContent digest: ${skill.contentDigest}\nKnowledge level: ${skill.manifest.knowledge_level}; review: ${skill.manifest.review.status}\n\n${skill.markdownBody}`,
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
